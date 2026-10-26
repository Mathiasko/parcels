import type { Database } from '../db/index.js'
import type { CarrierId } from '../core/types.js'

export interface RawResponse {
  fetchedAt: Date
  body: string
  /** True for a body from a failed multi-parcel batch: it belongs to the carrier, not to this parcel. */
  carrierLevel: boolean
}

/**
 * The parcel's own stored bodies plus the carrier's parcel-less ones (parcel_id IS NULL, from a failed
 * batch that could not be pinned on one parcel). The two are told apart so a carrier-wide body is
 * never read as this parcel's answer.
 */
export function rawResponsesFor(db: Database, parcelId: number, carrier: CarrierId): RawResponse[] {
  const rows = db.prepare(`
    SELECT fetched_at, body, parcel_id FROM raw_responses
    WHERE parcel_id = ? OR (parcel_id IS NULL AND carrier = ?)
    ORDER BY parcel_id IS NULL, id DESC
  `).all(parcelId, carrier) as { fetched_at: string; body: string; parcel_id: number | null }[]
  return rows.map(r => ({ fetchedAt: new Date(r.fetched_at), body: r.body, carrierLevel: r.parcel_id === null }))
}
