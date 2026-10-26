import type { Database } from './index.js'
import type { CanonicalStatus, CarrierId, PickupPoint } from '../core/types.js'

export interface NewParcel {
  carrier: CarrierId
  trackingNumber: string
  label?: string
  merchant?: string
  postalCode?: string
  source: 'email' | 'manual'
  sourceMessageId?: string
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

export function insertParcel(db: Database, p: NewParcel): number {
  const info = db.prepare(`
    INSERT INTO parcels (carrier, tracking_number, label, merchant, postal_code, status,
                         first_seen_at, source, source_message_id)
    VALUES (@carrier, @trackingNumber, @label, @merchant, @postalCode, 'unknown',
            @firstSeenAt, @source, @sourceMessageId)
  `).run({
    carrier: p.carrier,
    trackingNumber: p.trackingNumber,
    label: p.label ?? null,
    merchant: p.merchant ?? null,
    postalCode: p.postalCode ?? null,
    firstSeenAt: new Date().toISOString(),
    source: p.source,
    sourceMessageId: p.sourceMessageId ?? null,
  })
  return Number(info.lastInsertRowid)
}

export function findParcel(db: Database, carrier: CarrierId, number: string): Parcel | undefined {
  const row = db.prepare('SELECT * FROM parcels WHERE carrier = ? AND tracking_number = ?')
    .get(carrier, number) as Row | undefined
  return row && toParcel(row)
}

export function getParcel(db: Database, id: number): Parcel | undefined {
  const row = db.prepare('SELECT * FROM parcels WHERE id = ?').get(id) as Row | undefined
  return row && toParcel(row)
}

export function listActive(db: Database): Parcel[] {
  const rows = db.prepare(`
    SELECT * FROM parcels
    WHERE archived_at IS NULL AND status NOT IN ('delivered', 'returned')
    ORDER BY id
  `).all() as Row[]
  return rows.map(toParcel)
}

export function updateParcelState(db: Database, id: number, s: ParcelStateUpdate): void {
  // A supplied pickup point REPLACES the stored one wholesale (unspecified fields become NULL),
  // so a parcel that moves to a point without coordinates never keeps the old point's lat/lon.
  // An omitted pickup leaves every pickup_* column untouched.
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

/** Records what the user has now been told, so the same status or pickup point is never announced twice. */
export function markAnnounced(db: Database, id: number, status: CanonicalStatus, pickupAnnounced: boolean): void {
  db.prepare('UPDATE parcels SET last_announced_status = ?, pickup_announced = pickup_announced OR ? WHERE id = ?')
    .run(status, pickupAnnounced ? 1 : 0, id)
}

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
