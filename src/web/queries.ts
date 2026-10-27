import type { Database } from '../db/index.js'
import type { CarrierId } from '../core/types.js'
import { PENDING } from '../db/messages.js'

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

export interface CarrierDeliveryStats {
  carrier: CarrierId
  /** Delivered parcels for this carrier. */
  delivered: number
  /** How many of them could be measured (see `deliveryStats`); the median is over exactly these. */
  measured: number
  medianMs?: number
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/**
 * Per-carrier median of `delivered_at - earliest event's occurred_at`: the carrier's own span, which says
 * how long it took rather than when we happened to notice the parcel. A parcel that cannot yield a span
 * is left out instead of being measured some other way: one with no events at all (a carrier can flip a
 * parcel to delivered without emitting an event), or whose span is not positive (a single event, which
 * is the delivery itself). `measured` against `delivered` is what tells the reader how much to trust it.
 */
export function deliveryStats(db: Database): Map<CarrierId, CarrierDeliveryStats> {
  const rows = db.prepare(`
    SELECT p.carrier, p.delivered_at, MIN(e.occurred_at) AS first_event
    FROM parcels p LEFT JOIN events e ON e.parcel_id = p.id
    WHERE p.status = 'delivered'
    GROUP BY p.id
  `).all() as { carrier: CarrierId; delivered_at: string | null; first_event: string | null }[]

  const spans = new Map<CarrierId, number[]>()
  const totals = new Map<CarrierId, number>()
  for (const r of rows) {
    totals.set(r.carrier, (totals.get(r.carrier) ?? 0) + 1)
    if (r.delivered_at === null || r.first_event === null) continue
    const span = new Date(r.delivered_at).getTime() - new Date(r.first_event).getTime()
    if (span > 0) spans.set(r.carrier, [...(spans.get(r.carrier) ?? []), span])
  }
  const out = new Map<CarrierId, CarrierDeliveryStats>()
  for (const [carrier, delivered] of totals) {
    const s = spans.get(carrier) ?? []
    out.set(carrier, { carrier, delivered, measured: s.length, medianMs: median(s) })
  }
  return out
}

export interface UnparsedMessage {
  id: number
  receivedAt?: Date
  from?: string
  subject?: string
  note?: string
}

type MessageRow = {
  id: number; message_id: string | null; received_at: string | null; from_addr: string | null
  subject: string | null; parse_note: string | null; parsed_ok: number; parcel_id: number | null
}

const toMessage = (r: MessageRow): UnparsedMessage => ({
  id: r.id,
  receivedAt: r.received_at ? new Date(r.received_at) : undefined,
  from: r.from_addr ?? undefined,
  subject: r.subject ?? undefined,
  note: r.parse_note ?? undefined,
})

/**
 * Messages the ingest could not turn into a parcel and nobody has assigned yet, newest first - minus
 * the ones nothing in which said they were about a parcel at all. `PENDING` is the single definition
 * of that; see `src/db/messages.ts` for the three states and `parcelEvidence` for the rule.
 */
export function listUnparsedMessages(db: Database): UnparsedMessage[] {
  const rows = db.prepare(
    `SELECT * FROM messages WHERE ${PENDING} ORDER BY received_at DESC, id DESC`,
  ).all() as MessageRow[]
  return rows.map(toMessage)
}

/** The message plus its RFC message-id (stored on the parcel it becomes), when it is still unassigned. */
export function getUnparsedMessage(db: Database, id: number): (UnparsedMessage & { messageId?: string }) | undefined {
  const r = db.prepare(`SELECT * FROM messages WHERE id = ? AND ${PENDING}`).get(id) as MessageRow | undefined
  return r && { ...toMessage(r), messageId: r.message_id ?? undefined }
}
