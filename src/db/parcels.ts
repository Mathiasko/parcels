import type { Database } from './index.js'
import { TERMINAL_STATUSES, type CanonicalStatus, type CarrierId, type PickupPoint } from '../core/types.js'
import { canonicalNumber } from '../carriers/registry.js'
import { logAction, logStatusChange, UNATTRIBUTED, type Cause } from './activity-log.js'
import { orphanParcelMessages, discardRaw } from './messages.js'

export interface NewParcel {
  carrier: CarrierId
  trackingNumber: string
  label?: string
  merchant?: string
  postalCode?: string
  source: 'email' | 'manual'
  sourceMessageId?: string
  /** Defaults to now. A parcel created from old mail passes the mail's date so history sorts by it. */
  firstSeenAt?: Date
}

export interface Parcel {
  id: number
  carrier: CarrierId
  trackingNumber: string
  label?: string
  merchant?: string
  postalCode?: string
  status: CanonicalStatus
  /** The status the user was last told about ('unknown' until the first announcement). */
  lastAnnouncedStatus: CanonicalStatus
  /** Whether a pickup point has been announced yet. */
  pickupAnnounced: boolean
  statusRaw?: string
  statusDetail?: string
  pickup?: PickupPoint
  retainedTill?: Date
  firstSeenAt: Date
  lastPolledAt?: Date
  lastAttemptedAt?: Date
  /**
   * The postal code a carrier rejected with `needs_postcode` (`''` when the parcel had none),
   * or undefined when the parcel is not flagged. Storing the rejected value, not a boolean, is
   * what makes the skip deterministic: the rejection only stands while `postalCode` still
   * equals it, so changing the postcode (including none -> set) is what makes the parcel
   * askable again.
   */
  needsPostcode?: string
  lastChangedAt?: Date
  deliveredAt?: Date
  source: 'email' | 'manual'
  sourceMessageId?: string
  archivedAt?: Date
}

/** What a parcel is called wherever it is shown: the user's name for it, else the shop, else its number. */
export const parcelName = (p: Parcel): string => p.label ?? p.merchant ?? p.trackingNumber

/** `Z-BOX, Hlavna 12, Zilina`: commas throughout, the same in a banner as on the page. */
export function pickupSummary(p: Parcel): string | undefined {
  if (!p.pickup) return undefined
  const place = [p.pickup.name, p.pickup.street].filter(Boolean).join(', ')
  return [place, p.pickup.city].filter(Boolean).join(', ') || undefined
}

/**
 * `status`, `statusRaw` and `statusDetail` always overwrite (undefined clears the raw/detail
 * columns so a stale detail never outlives its status). `pickup`, when supplied, replaces the
 * stored pickup point entirely; when omitted it is left alone. The timestamp fields are only
 * written when supplied; omitted ones keep their stored value.
 */
export interface ParcelStateUpdate {
  status: CanonicalStatus
  statusRaw?: string
  statusDetail?: string
  pickup?: PickupPoint
  retainedTill?: Date
  lastPolledAt?: Date
  lastChangedAt?: Date
  deliveredAt?: Date
}

type Row = Record<string, string | number | null>

const iso = (d: Date | undefined) => d?.toISOString() ?? null
const date = (v: string | number | null) => (v === null ? undefined : new Date(v as string))
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v)

/** `TERMINAL_STATUSES` as an SQL list. Inlined, not bound: they are our own constants, never input. */
const TERMINAL_SQL = TERMINAL_STATUSES.map(s => `'${s}'`).join(', ')

function toParcel(r: Row): Parcel {
  const pickup: PickupPoint | undefined = r.pickup_kind === null
    ? undefined
    : {
        kind: r.pickup_kind as PickupPoint['kind'],
        ...(r.pickup_name !== null && { name: r.pickup_name as string }),
        ...(r.pickup_street !== null && { street: r.pickup_street as string }),
        ...(r.pickup_city !== null && { city: r.pickup_city as string }),
        ...(r.pickup_zip !== null && { postalCode: r.pickup_zip as string }),
        ...(r.pickup_lat !== null && { lat: r.pickup_lat as number }),
        ...(r.pickup_lon !== null && { lon: r.pickup_lon as number }),
      }
  return {
    id: r.id as number,
    carrier: r.carrier as CarrierId,
    trackingNumber: r.tracking_number as string,
    label: opt(r.label as string | null),
    merchant: opt(r.merchant as string | null),
    postalCode: opt(r.postal_code as string | null),
    status: r.status as CanonicalStatus,
    lastAnnouncedStatus: r.last_announced_status as CanonicalStatus,
    pickupAnnounced: r.pickup_announced === 1,
    statusRaw: opt(r.status_raw as string | null),
    statusDetail: opt(r.status_detail as string | null),
    pickup,
    retainedTill: date(r.retained_till),
    firstSeenAt: new Date(r.first_seen_at as string),
    lastPolledAt: date(r.last_polled_at),
    lastAttemptedAt: date(r.last_attempted_at),
    needsPostcode: opt(r.needs_postcode as string | null),
    lastChangedAt: date(r.last_changed_at),
    deliveredAt: date(r.delivered_at),
    source: r.source as 'email' | 'manual',
    sourceMessageId: opt(r.source_message_id as string | null),
    archivedAt: date(r.archived_at),
  }
}

/**
 * Creates a parcel, under the CANONICAL spelling of its number (see `canonicalNumber`): a GLS
 * shipment announced as `01928813352` by one email and `1928813352` by the next is one parcel, and
 * storing the number as typed is what let it become two. Applied here rather than in every caller
 * so the `UNIQUE (carrier, tracking_number)` index can actually do its job.
 */
export function insertParcel(db: Database, p: NewParcel): number {
  const info = db.prepare(`
    INSERT INTO parcels (carrier, tracking_number, label, merchant, postal_code, status,
                         first_seen_at, source, source_message_id)
    VALUES (@carrier, @trackingNumber, @label, @merchant, @postalCode, 'unknown',
            @firstSeenAt, @source, @sourceMessageId)
  `).run({
    carrier: p.carrier,
    trackingNumber: canonicalNumber(p.carrier, p.trackingNumber),
    label: p.label ?? null,
    merchant: p.merchant ?? null,
    postalCode: p.postalCode ?? null,
    firstSeenAt: (p.firstSeenAt ?? new Date()).toISOString(),
    source: p.source,
    sourceMessageId: p.sourceMessageId ?? null,
  })
  return Number(info.lastInsertRowid)
}

/** Looks a parcel up by the canonical spelling of its number, so either form of it finds the row. */
export function findParcel(db: Database, carrier: CarrierId, number: string): Parcel | undefined {
  const row = db.prepare('SELECT * FROM parcels WHERE carrier = ? AND tracking_number = ?')
    .get(carrier, canonicalNumber(carrier, number)) as Row | undefined
  return row && toParcel(row)
}

export function getParcel(db: Database, id: number): Parcel | undefined {
  const row = db.prepare('SELECT * FROM parcels WHERE id = ?').get(id) as Row | undefined
  return row && toParcel(row)
}

export function listActive(db: Database): Parcel[] {
  const rows = db.prepare(`
    SELECT * FROM parcels
    WHERE archived_at IS NULL AND status NOT IN (${TERMINAL_SQL})
    ORDER BY id
  `).all() as Row[]
  return rows.map(toParcel)
}

/**
 * How many parcels are waiting at a pickup point: the number the Mac app's menu-bar icon shows. The
 * same set as the dashboard's "ready for pickup": the home page lists `listActive` (not archived, not
 * delivered or returned) and counts those whose status is `ready_for_pickup`. A parcel marked collected
 * leaves the set because marking it moves its status on, so no separate column is consulted here.
 */
export function readyCount(db: Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM parcels WHERE archived_at IS NULL AND status = 'ready_for_pickup'
  `).get() as { n: number }
  return row.n
}

/**
 * `cause` is what the activity log records against the transition this write may be: who acted, in
 * which run, on which clock (see db/activity-log.ts). It is optional because this is the chokepoint
 * every status write goes through and a missing attribution must degrade to an honest "nobody said"
 * rather than block the write; every real call site in the app passes one.
 */
export function updateParcelState(
  db: Database, id: number, s: ParcelStateUpdate, cause: Cause = UNATTRIBUTED,
): void {
  // Read BEFORE the write, because the whole value of the log is the status that is about to be
  // overwritten: `delivered` replacing `ready_for_pickup` is the line the GLS incident needed, and a
  // moment later the row no longer knows it. One indexed lookup per update, which is the price.
  const before = db.prepare('SELECT status, carrier FROM parcels WHERE id = ?').get(id) as
    { status: CanonicalStatus; carrier: CarrierId } | undefined
  // A supplied pickup point REPLACES the stored one wholesale (unspecified fields become NULL): the
  // caller decides what the whole point is. The poller merges a carrier's answer about the SAME point
  // into the stored one first (`mergeCarrierPickup`), and passes a different point as it came, so a
  // parcel moved to another point never keeps the old one's lat/lon. An omitted pickup leaves every
  // pickup_* column untouched.
  const replacePickup = s.pickup !== undefined
  db.prepare(`
    UPDATE parcels SET
      status          = @status,
      status_raw      = @statusRaw,
      status_detail   = @statusDetail,
      pickup_kind     = CASE WHEN @replacePickup THEN @pickupKind   ELSE pickup_kind   END,
      pickup_name     = CASE WHEN @replacePickup THEN @pickupName   ELSE pickup_name   END,
      pickup_street   = CASE WHEN @replacePickup THEN @pickupStreet ELSE pickup_street END,
      pickup_city     = CASE WHEN @replacePickup THEN @pickupCity   ELSE pickup_city   END,
      pickup_zip      = CASE WHEN @replacePickup THEN @pickupZip    ELSE pickup_zip    END,
      pickup_lat      = CASE WHEN @replacePickup THEN @pickupLat    ELSE pickup_lat    END,
      pickup_lon      = CASE WHEN @replacePickup THEN @pickupLon    ELSE pickup_lon    END,
      retained_till   = COALESCE(@retainedTill,  retained_till),
      last_polled_at  = COALESCE(@lastPolledAt,  last_polled_at),
      last_changed_at = COALESCE(@lastChangedAt, last_changed_at),
      delivered_at    = COALESCE(@deliveredAt,   delivered_at)
    WHERE id = @id
  `).run({
    id,
    status: s.status,
    statusRaw: s.statusRaw ?? null,
    statusDetail: s.statusDetail ?? null,
    replacePickup: replacePickup ? 1 : 0,
    pickupKind: s.pickup?.kind ?? null,
    pickupName: s.pickup?.name ?? null,
    pickupStreet: s.pickup?.street ?? null,
    pickupCity: s.pickup?.city ?? null,
    pickupZip: s.pickup?.postalCode ?? null,
    pickupLat: s.pickup?.lat ?? null,
    pickupLon: s.pickup?.lon ?? null,
    retainedTill: iso(s.retainedTill),
    lastPolledAt: iso(s.lastPolledAt),
    lastChangedAt: iso(s.lastChangedAt),
    deliveredAt: iso(s.deliveredAt),
  })
  // Only a real move is an entry. The poller writes this row for every parcel it polls, every hour,
  // and logging the unchanged ones would bury the handful of transitions that matter under them.
  if (before !== undefined && before.status !== s.status) {
    logStatusChange(db, {
      parcelId: id, carrier: before.carrier, from: before.status, to: s.status, raw: s.statusRaw,
    }, cause)
  }
}

/**
 * Writes coordinates onto an existing pickup point and touches nothing else. Deliberately not part of
 * `ParcelStateUpdate`: that one replaces the pickup point wholesale, which is right once a caller has
 * decided the whole point and wrong here, where the geocoder has learned one extra fact about the
 * place the carrier named. The row is left alone when it has no pickup point at all, so a lookup can never invent one.
 */
export function setPickupCoords(db: Database, id: number, lat: number, lon: number): void {
  db.prepare('UPDATE parcels SET pickup_lat = ?, pickup_lon = ? WHERE id = ? AND pickup_kind IS NOT NULL')
    .run(lat, lon, id)
}

/**
 * Writes a pickup point learned from the parcel's own mail, touching only the `pickup_*` columns and
 * only while the parcel is still waiting for collection. The mail pass reads the parcel, then awaits a
 * parse, and the other process may have marked it delivered in between: writing back the status it
 * read (as `updateParcelState` would) is what put a collected parcel back to "ready" and re-notified.
 * Returns whether the row was written.
 */
export function setMailPickup(db: Database, id: number, p: PickupPoint): boolean {
  return db.prepare(`
    UPDATE parcels SET pickup_kind = ?, pickup_name = ?, pickup_street = ?, pickup_city = ?,
                       pickup_zip = ?, pickup_lat = ?, pickup_lon = ?
    WHERE id = ? AND status = 'ready_for_pickup'
  `).run(p.kind, p.name ?? null, p.street ?? null, p.city ?? null, p.postalCode ?? null, p.lat ?? null, p.lon ?? null, id)
    .changes > 0
}

/**
 * Stamps a real answer that carried no tracking information (`not_found`). Only `last_polled_at`: the
 * rest of the row was read before the request went out, and the other process may have moved it since.
 */
export function markPolled(db: Database, id: number, at: Date): void {
  db.prepare('UPDATE parcels SET last_polled_at = ? WHERE id = ?').run(at.toISOString(), id)
}

/** Stamps every attempt, answered or not. `lastPolledAt` stays "last real answer". */
export function markAttempted(db: Database, ids: number[], at: Date): void {
  const mark = db.prepare('UPDATE parcels SET last_attempted_at = ? WHERE id = ?')
  const iso = at.toISOString()
  db.transaction(() => { for (const id of ids) mark.run(iso, id) })()
}

/**
 * Flags the parcel with the postal code the carrier rejected (`''` when it had none), or clears the
 * flag with `null`. The stored value is compared against the parcel's current `postal_code`, so a
 * rejection cannot be undone by anything other than a real postcode change.
 */
export function setNeedsPostcode(db: Database, id: number, rejected: string | null): void {
  db.prepare('UPDATE parcels SET needs_postcode = ? WHERE id = ?').run(rejected, id)
}

export function setArchived(db: Database, id: number, at: Date): void {
  db.prepare('UPDATE parcels SET archived_at = ? WHERE id = ?').run(at.toISOString(), id)
}

/**
 * Un-archives a parcel that was archived on arrival from old mail, now that fresh mail says it is live.
 * `first_seen_at` restarts at `at` as well: it was back-dated to the old mail for history's sake, and
 * left there it would make the revived parcel dormant (no event in 30 days) the moment it came back.
 */
export function reviveArchived(db: Database, id: number, at: Date): void {
  db.prepare('UPDATE parcels SET archived_at = NULL, first_seen_at = ? WHERE id = ? AND archived_at IS NOT NULL')
    .run(at.toISOString(), id)
}

/** Records what the user has now been told, so the same status or pickup point is never announced twice. */
export function markAnnounced(db: Database, id: number, status: CanonicalStatus, pickupAnnounced: boolean): void {
  db.prepare('UPDATE parcels SET last_announced_status = ?, pickup_announced = pickup_announced OR ? WHERE id = ?')
    .run(status, pickupAnnounced ? 1 : 0, id)
}

/**
 * Whether a recorded `needs_postcode` rejection still applies: it does while the parcel's postcode is the
 * very one that was rejected (a parcel with no postcode is recorded as `''`). Anything else - a different
 * postcode, or one finally supplied - is a genuine change worth asking about. The poller skips a parcel
 * while this holds; the UI says why.
 */
export const postcodeRejected = (p: Parcel): boolean =>
  p.needsPostcode !== undefined && p.needsPostcode === (p.postalCode ?? '')

/** An empty label clears it, so the parcel falls back to its merchant or tracking number. */
export function setLabel(db: Database, id: number, label: string): void {
  db.prepare('UPDATE parcels SET label = ? WHERE id = ?').run(label === '' ? null : label, id)
}

/**
 * Changes the postal code used for GLS/DPD lookups. A parcel flagged `needs_postcode` is NOT unflagged
 * here: the poller compares the flag against this value, so any change (including none -> set) makes
 * the parcel askable again, and the next poll that sends it clears the flag.
 */
export function setPostalCode(db: Database, id: number, postalCode: string): void {
  db.prepare('UPDATE parcels SET postal_code = ? WHERE id = ?').run(postalCode === '' ? null : postalCode, id)
}

/**
 * Deletes a parcel for good, in one transaction (`foreign_keys = ON`, so the order is the point: every
 * child row goes before the parcel itself).
 *
 * The parcel's own `events`, `raw_responses` and `deadline_reminders` rows are deleted; a carrier-level
 * raw body (`parcel_id IS NULL`, from a failed batch) belongs to the carrier and is left alone.
 *
 * The `messages` ROWS are not deleted, they are unlinked, while their stored `.eml` files are thrown
 * away: a dismissal and a deletion leave mail in the same never-read-again state, so they must leave
 * the same amount of it on disk. `orphanParcelMessages` owns both halves and explains them.
 *
 * The files go AFTER the transaction has committed, so a row can never hold a path to a file that is
 * not there, and a failed unlink leaks an unreferenced file rather than undoing the deletion.
 *
 * Its `calendar_events` row goes by itself (ON DELETE CASCADE). The EVENT that row points at, in the
 * person's Calendar, is deliberately left alone: deleting a parcel never reaches into their calendar,
 * because removing things from it unasked is worse than a stale entry they can delete themselves.
 *
 * The `activity_log` row is the one thing deliberately NOT deleted with the parcel, and is written
 * inside the same transaction with the status the parcel was in when it went: "where did my parcel
 * go" has to be answerable with "you deleted it on Tuesday", which is only possible if the evidence
 * outlives the row. That is why the log holds no foreign key to `parcels` (see schema.sql).
 */
export function deleteParcel(db: Database, id: number, cause: Cause = UNATTRIBUTED): void {
  const parcel = getParcel(db, id)
  const orphaned = db.transaction((): string[] => {
    // Before `events`: a user mark names one of the parcel's events.
    db.prepare('DELETE FROM user_marks WHERE parcel_id = ?').run(id)
    db.prepare('DELETE FROM events WHERE parcel_id = ?').run(id)
    db.prepare('DELETE FROM raw_responses WHERE parcel_id = ?').run(id)
    db.prepare('DELETE FROM deadline_reminders WHERE parcel_id = ?').run(id)
    db.prepare('DELETE FROM pickup_codes WHERE parcel_id = ?').run(id)
    db.prepare('DELETE FROM pickup_nudges WHERE parcel_id = ?').run(id)
    const paths = orphanParcelMessages(db, id)
    db.prepare('DELETE FROM parcels WHERE id = ?').run(id)
    if (parcel) {
      logAction(db, {
        kind: 'parcel_deleted', parcelId: id, carrier: parcel.carrier, status: parcel.status,
      }, cause)
    }
    return paths
  })()
  discardRaw(orphaned)
}

export interface DeliveredFilter {
  carrier?: CarrierId
  /** Matches the label, merchant or tracking number, case-insensitively for ASCII. */
  q?: string
  /** Inclusive bounds on `delivered_at` (UTC instants). */
  from?: Date
  to?: Date
}

/**
 * Finished parcels: delivered, returned to sender (a real outcome nothing else archives, so without
 * this it would be on no page), plus archived ones that were never delivered (parcels created already archived
 * from old mail: they were never polled, so their status is still 'unknown' and must stay so). Newest
 * first by delivery, or by first-seen for those. Date bounds apply to the same instant.
 */
export function listDelivered(db: Database, f: DeliveredFilter = {}): Parcel[] {
  const where = [`(status IN (${TERMINAL_SQL}) OR archived_at IS NOT NULL)`]
  const args: (string | number)[] = []
  if (f.carrier) { where.push('carrier = ?'); args.push(f.carrier) }
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`
    where.push("(label LIKE ? ESCAPE '\\' OR merchant LIKE ? ESCAPE '\\' OR tracking_number LIKE ? ESCAPE '\\')")
    args.push(like, like, like)
  }
  if (f.from) { where.push('COALESCE(delivered_at, first_seen_at) >= ?'); args.push(f.from.toISOString()) }
  if (f.to) { where.push('COALESCE(delivered_at, first_seen_at) <= ?'); args.push(f.to.toISOString()) }
  const rows = db.prepare(
    `SELECT * FROM parcels WHERE ${where.join(' AND ')} ORDER BY COALESCE(delivered_at, first_seen_at) DESC, id DESC`,
  ).all(...args) as Row[]
  return rows.map(toParcel)
}
