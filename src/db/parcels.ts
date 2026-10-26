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
  statusRaw?: string
  statusDetail?: string
  pickup?: PickupPoint
  retainedTill?: Date
  firstSeenAt: Date
  lastPolledAt?: Date
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
    statusRaw: opt(r.status_raw as string | null),
    statusDetail: opt(r.status_detail as string | null),
    pickup,
    retainedTill: date(r.retained_till),
    firstSeenAt: new Date(r.first_seen_at as string),
    lastPolledAt: date(r.last_polled_at),
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

export function setArchived(db: Database, id: number, at: Date): void {
  db.prepare('UPDATE parcels SET archived_at = ? WHERE id = ?').run(at.toISOString(), id)
}
