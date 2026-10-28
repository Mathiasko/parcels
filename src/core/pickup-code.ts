import { readFileSync } from 'node:fs'
import { simpleParser } from 'mailparser'
import type { Database } from '../db/index.js'
import { listActive, setMailPickup, type Parcel } from '../db/parcels.js'
import { needsPickupCodeCheck, recordPickupCode } from '../db/pickup-codes.js'
import { extractPickupCode, htmlToText, pickupFromMail, type MailPickupPoint } from '../ingest/extract.js'
import type { PickupPoint } from './types.js'

export interface PickupCodeDeps {
  db: Database
  now: Date
  /** Injectable for tests; defaults to reading the stored .eml off disk. */
  readMail?: (path: string) => Buffer
}

export interface PickupCodeReport {
  scanned: number
  /** Z-BOX opening codes found. */
  found: number
  /** Parcels that gained a pickup point, or the detail of one, from their own mail. */
  points: number
}

const MAX_HTML = 1_000_000

/** How much of what the carrier should have said about the pickup point is still missing. */
type PickupGap = 'none' | 'missing' | 'thin' | 'postcode'

/**
 * What the parcel's own stored mail can still tell us: the Z-BOX opening code, and - for the parcels
 * the carrier never located - where the parcel actually is.
 *
 * This runs during a poll and touches no network: both facts are already on disk, in mail ingested
 * whenever the carrier sent it. Reading them here rather than at ingest time is what makes historical
 * mail work - a parcel whose pickup email arrived days before this feature existed gets its code on
 * the next poll, with no backfill command to remember to run.
 *
 * The pickup point is the second reader of the same bytes. A GLS parcel handed to a Balikomat answers
 * `DELIVEREDPS` with no `parcelShop` and no `addresses`, and SPS answers `{ kind: 'parcelshop' }` with
 * nothing in it at all, so the app could say "ready for pickup" and nothing else: no address, no map,
 * no card. The mail that announced it prints the address, and Packeta's prints the postcode its API
 * omits. Both facts come out of one read of one file, which is why they share this pass.
 */
export async function runPickupCodes(deps: PickupCodeDeps): Promise<PickupCodeReport> {
  const { db, now } = deps
  const read = deps.readMail ?? readFileSync
  const report: PickupCodeReport = { scanned: 0, found: 0, points: 0 }

  for (const parcel of listActive(db)) {
    if (parcel.status !== 'ready_for_pickup') continue
    const mails = db.prepare(
      'SELECT raw_path FROM messages WHERE parcel_id = ? AND raw_path IS NOT NULL ORDER BY received_at DESC, id DESC',
    ).all(parcel.id) as { raw_path: string }[]
    if (mails.length === 0) continue

    const gap = pickupGap(parcel)
    const wantsCode = needsPickupCodeCheck(db, parcel.id, mails.length)
    const wantsPoint = needsPickupScan(db, parcel.id, gap, mails.length)
    if (!wantsCode && !wantsPoint) continue

    report.scanned++
    let code: string | undefined
    let point: MailPickupPoint | undefined
    for (const m of mails) {
      let text: string
      try {
        const mail = await simpleParser(read(m.raw_path))
        text = mail.text || (typeof mail.html === 'string' ? htmlToText(mail.html.slice(0, MAX_HTML)) : '')
      } catch {
        continue   // an unreadable file must not stop the parcel's other mail being tried
      }
      // Newest mail first, and the first answer wins: a reminder that repeats the block must not
      // override the original, and neither fact is looked for once it has been found.
      if (wantsCode) code ??= extractPickupCode(text)
      if (wantsPoint) point ??= pickupFromMail(text)
      if ((code || !wantsCode) && (point || !wantsPoint)) break
    }
    if (wantsCode && code) report.found++
    // Always recorded, even when only the location was being looked for: `checked_messages` is this
    // pass's watermark for both facts, and a code already found is kept (COALESCE), never blanked.
    recordPickupCode(db, parcel.id, code, mails.length, now)

    const filled = point && fillPickup(parcel.pickup, point)
    // Only the pickup columns, and only if the parcel is still waiting: `parcel` was read before the
    // awaits above, and anything else written from it could undo what the other process did meanwhile.
    if (filled && setMailPickup(db, parcel.id, filled)) report.points++
  }
  return report
}

/**
 * Whether the mail is worth opening for a location.
 *
 * `none` - the carrier located the parcel itself and left nothing useful blank, so there is nothing to
 * look for; the carrier's own data wins and is never re-read, never second-guessed.
 *
 * Anything else - once, and again only when new mail arrives. A point written here persists: the
 * carrier's next answer about the same point is merged into it rather than replacing it (see
 * `mergeCarrierPickup`), so nothing wipes what this pass added, and `checked_messages` is what
 * remembers that the mail has already been looked at. A carrier that moves the parcel to another point
 * replaces it whole, and the mail already read describes the old one; it is not read again for that,
 * which is what keeps the old point's street off the new one. The move's own mail is new mail.
 */
function needsPickupScan(db: Database, parcelId: number, gap: PickupGap, messageCount: number): boolean {
  if (gap === 'none') return false
  return scannedMessages(db, parcelId) < messageCount
}

/** How many of the parcel's mails this pass has already read, or -1 when it has never run. */
function scannedMessages(db: Database, parcelId: number): number {
  const row = db.prepare('SELECT checked_messages FROM pickup_codes WHERE parcel_id = ?')
    .get(parcelId) as { checked_messages: number } | undefined
  return row?.checked_messages ?? -1
}

/**
 * What is still worth reading out of the mail for a parcel that already has a pickup point.
 *
 * Coordinates settle it: the point draws a pin, and anything the mail added would be a second opinion
 * about a place the carrier named. Without a street it is `thin` - a kind and perhaps a town, which is
 * a panel that says "somewhere in Bratislava" and a pin in the middle of a city. With a street but no
 * postcode there is exactly one blank left worth filling: Packeta's API sends a street and a town and
 * never a postcode, and the geocoder's query is street + postcode + town.
 */
function pickupGap(parcel: Parcel): PickupGap {
  const pickup = parcel.pickup
  if (!pickup) return 'missing'
  if (pickup.lat !== undefined && pickup.lon !== undefined) return 'none'
  if (!pickup.street) return 'thin'
  return pickup.postalCode ? 'none' : 'postcode'
}

/**
 * The pickup point to store, or undefined for "leave the parcel exactly as it is".
 *
 * The precedence rule, in one place:
 *   1. the carrier's own fields always win - every one of them, including its coordinates. Nothing
 *      here replaces a value the carrier supplied; it only fills a blank.
 *   2. a point with coordinates is not touched at all.
 *   3. a point whose town disagrees with the mail's is not filled either. The street of one town
 *      written under the name of another is the wrong-pin error, and refusing is the only safe answer.
 *   4. a point that already has a street gets, at most, the postcode - and only when the mail is
 *      talking about that same street. Two streets that do not match are two places, and the mail's
 *      postcode would then belong to the other one.
 */
function fillPickup(carrier: PickupPoint | undefined, mail: MailPickupPoint): PickupPoint | undefined {
  if (!carrier) {
    return {
      kind: mail.kind,
      ...(mail.name !== undefined && { name: mail.name }),
      street: mail.street,
      city: mail.city,
      postalCode: mail.postalCode,
    }
  }
  if (carrier.lat !== undefined && carrier.lon !== undefined) return undefined
  if (carrier.city && !sameTown(carrier.city, mail.city)) return undefined
  if (carrier.street) {
    if (carrier.postalCode || !sameStreet(carrier.street, mail.street)) return undefined
    return { ...carrier, postalCode: mail.postalCode }
  }
  return {
    kind: carrier.kind,                                 // the carrier knows what sort of place it is
    ...((carrier.name ?? mail.name) !== undefined && { name: carrier.name ?? mail.name }),
    street: mail.street,
    city: carrier.city ?? mail.city,
    postalCode: carrier.postalCode ?? mail.postalCode,
    // No lat/lon to carry: the guard above already refused every point that had any, which is how
    // "never overwrite coordinates with a guess" is kept - by never reaching a point that has them.
  }
}

/**
 * The pickup point to store when the carrier answers with `carrier` and the parcel already has `stored`.
 *
 * The same point: every field the carrier gave wins, and every field it left blank keeps its stored
 * value - the postcode and street the mail added, and the coordinates the map step found. Replacing it
 * wholesale (as this once did) wiped all three every poll, so the mail was re-read and the map
 * re-located the point every hour, and a reminder built in between went out with no address.
 *
 * Another point (a parcel redirected to a different box): the carrier's point, whole. Nothing of the
 * old one is kept, least of all its coordinates, which would put the pin at the wrong door.
 */
export function mergeCarrierPickup(stored: PickupPoint | undefined, carrier: PickupPoint): PickupPoint {
  if (!stored || !samePoint(stored, carrier)) return carrier
  const pick = <K extends keyof PickupPoint>(k: K) => carrier[k] ?? stored[k]
  const merged: PickupPoint = { kind: carrier.kind }
  for (const k of ['name', 'street', 'city', 'postalCode'] as const) {
    const v = pick(k)
    if (v !== undefined) merged[k] = v
  }
  // Coordinates move as a pair: one half from the carrier and the other from the geocoder is no place.
  const lat = carrier.lat !== undefined && carrier.lon !== undefined ? carrier.lat : stored.lat
  const lon = carrier.lat !== undefined && carrier.lon !== undefined ? carrier.lon : stored.lon
  if (lat !== undefined && lon !== undefined) { merged.lat = lat; merged.lon = lon }
  return merged
}

/**
 * Whether the carrier is still talking about the stored point. No carrier gives a point id, so this
 * is the identifying fields: any of name, street and town that BOTH sides have must agree (in the
 * spelling-tolerant sense of `sameStreet` and `sameTown`). A field only one side has says nothing
 * either way - which is what lets SPS's bare `{ kind: 'parcelshop' }` keep the address the mail gave.
 */
function samePoint(a: PickupPoint, b: PickupPoint): boolean {
  if (a.name && b.name && bare(a.name) !== bare(b.name)) return false
  if (a.street && b.street && !sameStreet(a.street, b.street)) return false
  if (a.city && b.city && !sameTown(a.city, b.city)) return false
  return true
}

/**
 * Whether two spellings name the same town. Diacritics and case are noise (a carrier writes
 * BRATISLAVA, a mail Bratislava), and so is a postal district number: "Bratislava 5" and "Bratislava"
 * are the same town, and refusing the fill over that digit would lose the street for no reason.
 */
function sameTown(a: string, b: string): boolean {
  const plain = (s: string) => bare(s).replace(/\s+\d{1,2}$/, '')
  return plain(a) === plain(b)
}

/**
 * Whether two spellings name the same street, for the one case where the mail is allowed to add to a
 * street the carrier already gave. Diacritics and case again (Packeta's API writes `Nevadzova 6`
 * where its own mail writes `Nevädzová 6`), and nothing more: `Hlavná 6` and `Hlavná 6/A` are not
 * declared the same address, because they may be two different doors.
 */
function sameStreet(a: string, b: string): boolean {
  return bare(a) === bare(b)
}

/** Case, diacritics and spacing are how the same place gets spelled twice; none of them carry meaning. */
const bare = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}+/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()
