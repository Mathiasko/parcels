import { readFileSync } from 'node:fs'
import type { Database } from '../db/index.js'
import type { Carrier, ParcelEvent } from '../core/types.js'
import { isEmailOnlyCarrier } from '../core/types.js'
import { findParcel, insertParcel, reviveArchived, setArchived } from '../db/parcels.js'
import { appendEvents } from '../db/events.js'
import { linkMessage, storeMessage } from '../db/messages.js'
import { accountKey, getImapState, saveImapState, type ImapState } from '../db/imap-state.js'
import { extract, type Extraction, type ParcelEvidence } from './extract.js'
import { fetchMessages, type FetchDeps, type ImapConfig, type RawMessage } from './imap.js'

/** Mail older than this creates its parcel already archived: in the database, never polled. */
export const ARCHIVE_AFTER_DAYS = 30
const DAY = 86_400_000

export interface ReprocessDeps {
  now: Date
  adapters: Carrier[]
  defaultPostalCode: string
}

export interface IngestDeps extends ReprocessDeps {
  imap: ImapConfig
  /** Where raw .eml files are written (`<id>.eml`). */
  mailDir: string
  client?: FetchDeps['client']
  maxBytes?: number
}

export interface IngestReport {
  /** Messages new to the database this run (only UIDs above the watermark are looked at; see `fetchMessages`). */
  read: number
  /** Parcels created. */
  created: number
  /** Messages attached to a parcel that already existed. */
  linked: number
  /** Of `created`, how many were archived on arrival because the mail was old. */
  archivedOld: number
  /** Messages that yielded no parcel and now wait in the web UI's needs-attention list. */
  needsAttention: number
  /**
   * Messages stored and then left alone, because nothing in them said they were about a parcel (see
   * `parcelEvidence`). Reported rather than silently swallowed: this is the count that says how much
   * of the Gmail label is not parcel mail at all.
   */
  ignored: number
  /** Messages that threw while being stored or placed; rolled back whole, so the next run fetches them again. */
  failed: number
  /** Set (with every count at zero) when the mailbox could not be read at all. */
  error?: string
}

const emptyReport = (): IngestReport => ({ read: 0, created: 0, linked: 0, archivedOld: 0, needsAttention: 0, ignored: 0, failed: 0 })

interface Item {
  /** `messages.id`; 0 until `place`'s `store` step has run for a message that is not stored yet. */
  id: number
  receivedAt: Date
  oversize?: boolean
  extraction: Extraction
}

const keyOf = (carrier: Extraction['carrier'], number: string) => `${carrier}:${number}`
/** Every parcel number the message names: its own, then the others it listed (see `moreNumbers`). */
const numbersOf = (e: Extraction): string[] => e.number ? [e.number, ...e.moreNumbers ?? []] : []

/**
 * Reads the mailbox label (read-only and incrementally: see `fetchMessages`), stores each new message
 * and its raw .eml, and turns the ones that name a parcel into parcels. Mail that does not yield a
 * tracking number is kept, unassigned: on the needs-attention page when something in it says it is
 * about a parcel, and silently otherwise (`ignored`, see `parcelEvidence`). Either way the row is
 * stored - nothing is dropped and nothing is guessed - because the row is the Message-ID dedupe key.
 *
 * A failure to reach the mailbox rejects; a failure on one message does not stop the others.
 *
 * The IMAP watermark is advanced here rather than in `fetchMessages`, and only by a run that stored
 * everything it read. A message that threw while being stored or placed was rolled back whole: it has
 * no row, so it is not `known`, and the next run has to be able to fetch it again. Leaving the
 * watermark where it was costs that run one envelope per already-stored message above it, which is
 * what every run cost before any state was kept - and is the price of never losing a message.
 */
export async function ingestMessages(db: Database, deps: IngestDeps): Promise<IngestReport> {
  const known = new Set((db.prepare('SELECT message_id FROM messages').all() as Array<{ message_id: string }>).map(r => r.message_id))
  const account = accountKey(deps.imap)
  let scanned: ImapState | undefined
  const raws = await fetchMessages({
    config: deps.imap, client: deps.client, maxBytes: deps.maxBytes, known: id => known.has(id),
    state: getImapState(db, account, deps.imap.mailbox),
    onScanned: state => { scanned = state },
  })

  const items: Array<Item & { raw: RawMessage }> = await Promise.all(raws.map(async raw => ({
    raw, id: 0, receivedAt: raw.receivedAt, oversize: raw.oversize,
    extraction: raw.oversize ? { confidence: 'none' as const } : await extract(raw.raw),
  })))

  const report = { ...emptyReport(), read: raws.length }
  place(db, items, deps, report, it => { it.id = storeMessage(db, it.raw, deps.mailDir) })
  if (scanned && report.failed === 0) saveImapState(db, account, deps.imap.mailbox, scanned, deps.now)
  return report
}

/**
 * Re-runs extraction over messages that are stored but still unassigned, from the .eml on disk: after
 * a parser fix the mail does not need to still exist upstream, and IMAP is not touched.
 *
 * `ignored` is deliberately NOT in the WHERE clause, which is the difference between an ignored
 * message and a dismissed one: a dismissed message is `parsed_ok = 1` and is gone from here for good
 * (the user said so), while an ignored one is still `parsed_ok = 0` and comes straight back the first
 * time a parser can read it. That is why ignoring is safe at all - it is a decision about what to
 * SHOW, taken with today's parser, not a decision about the message.
 */
export async function reprocessMessages(db: Database, deps: ReprocessDeps): Promise<IngestReport> {
  const rows = db.prepare(`
    SELECT id, received_at, raw_path FROM messages
    WHERE parsed_ok = 0 AND parcel_id IS NULL AND raw_path IS NOT NULL ORDER BY received_at, id
  `).all() as Array<{ id: number; received_at: string; raw_path: string }>

  const items: Item[] = []
  for (const r of rows) {
    let buf: Buffer
    try { buf = readFileSync(r.raw_path) } catch { continue }   // file gone: it stays in needs-attention as it was
    items.push({ id: r.id, receivedAt: new Date(r.received_at), extraction: await extract(buf) })
  }
  const report = { ...emptyReport(), read: items.length }
  place(db, items, deps, report)
  return report
}

/**
 * Turns each extracted item into a parcel, a link to an existing parcel, or a needs-attention note.
 *
 * Each message is ONE unit: `store` (if it is not stored yet) and the placement share a transaction, so
 * a throw in either (disk full, EACCES on the mail directory, SQLITE_BUSY) rolls that message back
 * whole. It then has no row, is not `known`, and the next run fetches and places it again, instead of
 * being stranded as stored-but-unplaced. The other messages in the batch are unaffected.
 */
function place<T extends Item>(
  db: Database, items: T[], deps: ReprocessDeps, report: IngestReport, store?: (it: T) => void,
): void {
  items.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id - b.id)

  // A parcel is "old" by its NEWEST mail in this batch, not its first: a parcel announced 45 days ago
  // that was updated 2 days ago is still live.
  const newest = new Map<string, number>()
  for (const it of items) {
    for (const n of numbersOf(it.extraction)) {
      const key = keyOf(it.extraction.carrier, n)
      newest.set(key, Math.max(newest.get(key) ?? 0, it.receivedAt.getTime()))
    }
  }

  for (const it of items) {
    const counts = emptyReport()
    try {
      db.transaction(() => {
        store?.(it)
        placeOne(db, it, deps, counts, newest)
      })()
    } catch (err) {
      report.failed++
      console.error(`ingest: message ${it.id || '(unstored)'} failed and will be retried: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    // Counted only once the message's transaction has committed.
    report.created += counts.created
    report.linked += counts.linked
    report.archivedOld += counts.archivedOld
    report.needsAttention += counts.needsAttention
    report.ignored += counts.ignored
  }
}

/**
 * The event an email-only carrier's mail leaves behind (§6.7), or nothing when the mail had no words
 * worth keeping. Mail is all such a parcel ever gets, so the carrier's own sentence - its subject,
 * verbatim - becomes the event the UI shows, exactly as a prose-only carrier's events read.
 *
 * `status` stays `unknown` and the parcel's status is never touched: §5 rule 4 and §8 both forbid
 * reading a status out of localised human text, and that holds whether the text came from an API or
 * from a mailbox. A mail's timestamp is a real instant rather than a carrier's naive local string, so
 * there is no zone to guess; it is recorded in the zone it is stored in.
 */
function mailEvent(it: Item): ParcelEvent | undefined {
  const description = it.extraction.eventText
  if (!description) return undefined
  return {
    occurredAt: it.receivedAt,
    occurredAtRaw: it.receivedAt.toISOString(),
    occurredAtTz: 'UTC',
    status: 'unknown',
    description,
  }
}

/**
 * What `parse_note` says about a message that reached the attention page, one phrase per signal. The
 * page prints it and so does `sqlite3 data/parcels.db`, which is how "where did my email go" is
 * answered: a note that names the signal says the message was a real question, and `IGNORED_NOTE`
 * says it was never one.
 */
const SHOWN_BECAUSE: Record<ParcelEvidence, string> = {
  'carrier-sender': 'a carrier sent it',
  'carrier-named': 'it names a carrier',
  'tracking-shape': 'it contains something shaped like a tracking number',
  'shipping-subject': 'its subject is about a shipment',
  unreadable: 'it could not be read at all',
  'too-long': 'it is too long to read whole',
  'lookalike-sender': 'its sender is named like a carrier but does not write from that carrier\'s address',
}

/**
 * The note on a message that was stored and then left alone. Deliberately a sentence a person can
 * read, and deliberately distinct from the "no tracking number found" one: the two answer different
 * questions ("this was never parcel mail" against "this was, and the parser failed on it").
 */
const IGNORED_NOTE = 'ignored: no sign of a parcel in this message (stored, not shown on /attention)'

function placeOne(db: Database, it: Item, deps: ReprocessDeps, report: IngestReport, newest: Map<string, number>): void {
  const { carrier, number, merchant, evidence } = it.extraction
  // `ignored` is always written, never only set: a reprocess over a message that now DOES look like a
  // parcel has to be able to clear the flag again, not just raise it.
  const note = (text: string, ignored = false) =>
    db.prepare('UPDATE messages SET parse_note = ?, ignored = ? WHERE id = ?').run(text, ignored ? 1 : 0, it.id)
  const link = (parcelId: number, text: string | null) => linkMessage(db, it.id, parcelId, text)

  // Oversize mail has no body to judge, so it is shown; `storeMessage` already noted why.
  if (it.oversize) { report.needsAttention++; return }
  if (!carrier || !number) {
    // Nothing in the message says it is about a parcel: store it, say so, and ask nobody.
    if (!evidence) {
      note(IGNORED_NOTE, true)
      report.ignored++
      return
    }
    // A look-alike sender's number WAS found; it is the sender that was not trusted with it.
    note(evidence === 'lookalike-sender'
      ? `not tracked: ${SHOWN_BECAUSE[evidence]}`
      : `no tracking number found in this message (${SHOWN_BECAUSE[evidence]})`)
    report.needsAttention++
    return
  }
  // A registered carrier is the test, pollable or not: an email-only carrier (§6.7) has no adapter to
  // register and still has parcels, so this must not refuse them. An id nobody registered at all is a
  // different thing - the mail is kept and waits on /attention.
  if (!deps.adapters.some(a => a.id === carrier)) {
    note(`found ${carrier} number ${number} but no adapter registered for ${carrier}`)
    report.needsAttention++
    return
  }
  const event = isEmailOnlyCarrier(carrier) ? mailEvent(it) : undefined
  // The message's own number first: that is the parcel the message is linked to. The others it
  // listed (`moreNumbers`) are found or created the same way, but a message links to one parcel, so
  // they only record it as their source.
  numbersOf(it.extraction).forEach((n, i) => placeNumber(n, i === 0))

  function placeNumber(n: string, linked: boolean): void {
    const existing = findParcel(db, carrier!, n)
    if (existing) {
      // Archived on arrival because its first mail was old, and now a fresh one says it is moving after
      // all. Ingest is the only thing that archives, so it is the one that has to take it back; left
      // archived, the parcel is never polled and /add answers "already tracking" for it.
      if (existing.archivedAt && deps.now.getTime() - it.receivedAt.getTime() <= ARCHIVE_AFTER_DAYS * DAY) {
        reviveArchived(db, existing.id, deps.now)
      }
      // A later mail may name the sender when the first one did not.
      if (merchant && !existing.merchant) db.prepare('UPDATE parcels SET merchant = ? WHERE id = ?').run(merchant, existing.id)
      // This is how an email-only parcel moves: each later mail adds its own words. `appendEvents`
      // dedupes, so re-reading the same mail (a reprocess, a resent copy) adds nothing.
      if (event) appendEvents(db, existing.id, [event])
      if (linked) {
        link(existing.id, null)
        report.linked++
      }
      return
    }
    const row = db.prepare('SELECT message_id FROM messages WHERE id = ?').get(it.id) as { message_id: string }
    const old = deps.now.getTime() - newest.get(keyOf(carrier, n))! > ARCHIVE_AFTER_DAYS * DAY
    const id = insertParcel(db, {
      carrier: carrier!, trackingNumber: n, merchant, postalCode: deps.defaultPostalCode,
      source: 'email', sourceMessageId: row.message_id,
      // An archived-on-arrival parcel is first seen when its mail was, so history sorts by that.
      // Its status stays 'unknown': status never comes from mail.
      ...(old && { firstSeenAt: it.receivedAt }),
    })
    if (event) appendEvents(db, id, [event])
    if (old) {
      setArchived(db, id, deps.now)
      report.archivedOld++
    }
    if (linked) link(id, old ? `parcel archived on arrival: mail older than ${ARCHIVE_AFTER_DAYS} days` : null)
    report.created++
  }
}
