import { DateTime } from 'luxon'
import { parseNaive } from '../core/time.js'
import type {
  CanonicalStatus, CarrierAdapter, FetchInput, FetchResult, HttpClient, ParcelEvent, PickupPoint,
} from '../core/types.js'

/**
 * PPL (Czech Republic), polled from the tracking API PPL's own public tracking site uses:
 *
 *   POST https://api.dhl.com/ecs/ppl/webapi/TrackAndTrace/<number>
 *   dhl-api-key: <the key PPL's public tracking site uses, as observed 2026-10-30>
 *   Content-Type: application/json
 *   body: {}            (omitting the body is answered 415)
 *
 * NOT YET CHECKED AGAINST A REAL PARCEL. No real PPL number or mail has been seen. Everything below
 * the request is written against two sources only:
 *   - the response shape the open-source Home Assistant integration parses
 *     (github.com/ha-parcel-integrations/ha-ppl-cz, `custom_components/ppl_cz/tracking/*.py`):
 *     top-level `phase` / `lastEventCode`, `events[]` of `{ code, eventDate, eventText }`, and
 *     `accessPoint.parcelshopName`;
 *   - the not-found probe of 2026-10-30: an unknown number is HTTP 400 with
 *     `{"detail":"service.TrackAndTrace.ShipmentNotFound", ...}`.
 * The first real parcel should be run through `probe ppl <number>` and this file corrected from it.
 */
const ZONE = 'Europe/Prague'
const ENDPOINT = 'https://api.dhl.com/ecs/ppl/webapi/TrackAndTrace/'
/** Published in PPL's tracking site, not an account key: every visitor's browser sends it. */
const API_KEY = '7HH634Q79Zpge4xEGeFAHXAnUMRxv0XQ'
const NOT_FOUND_DETAIL = 'service.TrackAndTrace.ShipmentNotFound'

/**
 * 11 bare digits, which is also a GLS shape (GLS takes 10-12). That is why PPL is registered but kept
 * out of the registry's DETECT_ORDER: by shape alone an 11-digit number stays GLS, and PPL is only
 * ever chosen by hand on Add or from mail that says it is PPL.
 */
const NUMBER_SHAPE = /^\d{11}$/

/**
 * The spec's table, exact codes only (Ruling R4). Deliberately no "base before the dot" fallback: it
 * would read `Delivered.BackToSender` as `delivered` and drop a parcel on its way back off the
 * dashboard. The codes decide; `lastEventText` and `eventText` are never consulted (they are prose in
 * whatever language PPL answers in). Anything unlisted maps to `unknown` and is logged.
 */
export const PPL_STATUS: ReadonlyMap<string, CanonicalStatus> = new Map<string, CanonicalStatus>(Object.entries({
  WaitingForShipment: 'pre_transit',
  PickedUpFromSender: 'in_transit',
  ShipmentInTransport: 'in_transit',
  PreparingForDelivery: 'in_transit',
  LoadingForDelivery: 'out_for_delivery',
  OutForDelivery: 'out_for_delivery',
  // Handed to a ParcelShop or a Parcelbox: the start of waiting, not the end of it (see gls.ts).
  DeliveredToPickupPoint: 'ready_for_pickup',
  'Delivered.Parcelshop': 'ready_for_pickup',
  Delivered: 'delivered',
  NotDelivered: 'failed_attempt',
  BackToSender: 'returning',
}))

interface RawEvent { code?: string | null; eventDate?: number | string | null; eventText?: string | null }
interface RawAccessPoint { parcelshopName?: string | null; name?: string | null }
interface RawBody {
  phase?: string | null
  lastEventCode?: string | null
  events?: RawEvent[] | null
  accessPoint?: RawAccessPoint | null
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function mapCode(code: string | undefined): CanonicalStatus {
  if (code === undefined) return 'unknown'
  const mapped = PPL_STATUS.get(code)
  if (mapped) return mapped
  console.warn(`ppl: unmapped code ${JSON.stringify(code)}, treating as unknown`)
  return 'unknown'
}

/** A trailing `Z` or `±hh:mm` / `±hhmm`: the string names its own instant. */
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i

/**
 * `eventDate` arrives as a ms epoch number or an ISO string (the integration accepts both). A number
 * and an ISO string with an offset are absolute and taken as they are (Ruling R5). They must NOT go
 * through `parseNaive`: its autumn-fold rule would move an instant in the fold's second hour (01:30Z
 * on the last Sunday of October is the second 02:30 in Prague) an hour early. Only a zone-less ISO
 * string is Prague wall clock. Throws on anything unreadable, which the caller turns into `transport`.
 */
function parseWhen(raw: number | string): { raw: string; at: Date; tz: string } {
  if (typeof raw === 'number') {
    const at = new Date(raw)
    if (!Number.isFinite(raw) || Number.isNaN(at.getTime())) throw new Error(`cannot read eventDate ${raw}`)
    return { raw: String(raw), at, tz: 'UTC' }
  }
  if (HAS_OFFSET.test(raw.trim())) {
    const dt = DateTime.fromISO(raw.trim(), { setZone: true })
    if (!dt.isValid) throw new Error(`cannot parse timestamp ${JSON.stringify(raw)}: ${dt.invalidExplanation}`)
    return { raw, at: dt.toJSDate(), tz: dt.zoneName ?? 'UTC' }   // 'UTC', or a fixed offset such as 'UTC+1'
  }
  return { raw, ...parseNaive(raw, ZONE) }
}

function toEvents(events: RawEvent[]): ParcelEvent[] {
  // An entry without a date cannot be placed in the timeline, so it is skipped (as the integration does).
  const entries = events
    .filter(e => e && typeof e === 'object' && (typeof e.eventDate === 'number' || nonEmpty(e.eventDate) !== undefined))
    .map(e => ({ e, when: parseWhen(e.eventDate as number | string) }))
  // Stable sort, so events sharing a timestamp keep the order PPL listed them in.
  entries.sort((a, b) => a.when.at.getTime() - b.when.at.getTime())
  return entries.map(({ e, when }): ParcelEvent => {
    const code = nonEmpty(e.code)
    return {
      occurredAtRaw: when.raw,
      occurredAtTz: when.tz,
      occurredAt: when.at,
      // Unlike GLS and SPS, every PPL event carries its own code, so each gets its own status.
      status: mapCode(code),
      code,
      description: nonEmpty(e.eventText) ?? code ?? '',
    }
  })
}

/** The name is the shop's own (`parcelshopName`), else the point's; a Parcelbox is a locker. */
function toPickup(point: RawAccessPoint | null | undefined): PickupPoint | undefined {
  if (!point || typeof point !== 'object') return undefined
  const name = nonEmpty(point.parcelshopName) ?? nonEmpty(point.name)
  if (!name) return undefined
  return { kind: /parcel\s*box/i.test(name) ? 'locker' : 'parcelshop', name }
}

function toResult(number: string, body: RawBody): FetchResult {
  // `phase` is the primary code; the integration falls back to `lastEventCode` when it is empty.
  const code = nonEmpty(body.phase) ?? nonEmpty(body.lastEventCode)
  if (code === undefined) {
    // Never observed. Not guessed from the text, and not `unknown` either: `transport` surfaces in
    // Health with the raw body kept, which is how the shape gets corrected.
    console.warn(`ppl: the answer for ${number} has neither phase nor lastEventCode`)
    return { ok: false, number, reason: 'transport' }
  }
  const status = mapCode(code)
  const result: FetchResult = {
    ok: true, number, status, statusRaw: code,
    events: toEvents(Array.isArray(body.events) ? body.events : []),
    raw: body,
  }
  // As for the other carriers, the point is reported while the parcel waits there, not while it is
  // still on its way to it.
  if (status === 'ready_for_pickup') {
    const pickup = toPickup(body.accessPoint)
    if (pickup) result.pickup = pickup
  }
  return result   // no retainedTill: the API gives no deadline; it comes from mail, as for others
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

async function fetchOne({ number }: FetchInput, http: HttpClient): Promise<FetchResult> {
  const transport: FetchResult = { ok: false, number, reason: 'transport' }
  try {
    const res = await http(`${ENDPOINT}${encodeURIComponent(number)}`, {
      method: 'POST',
      headers: { 'dhl-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: '{}',
    })
    // The key or the endpoint changed: the adapter needs an update, which is not "parcel not found".
    if (res.status === 401 || res.status === 403) return { ok: false, number, reason: 'gated' }
    const text = await res.text()
    if (res.status === 400) {
      // Only the probed not-found detail is `not_found`; any other 400 is a request we got wrong.
      let detail: unknown
      try { detail = (JSON.parse(text) as { detail?: unknown } | null)?.detail } catch { /* not JSON */ }
      return detail === NOT_FOUND_DETAIL ? { ok: false, number, reason: 'not_found' } : transport
    }
    if (res.status !== 200) return transport
    // A 200 that is not a JSON object (a web page, a challenge, garbage) means the endpoint was put
    // behind something, as GLS treats HTML: `gated`, never a parcel that is missing.
    let body: unknown
    try { body = JSON.parse(text) } catch { body = undefined }
    if (!isObject(body)) return { ok: false, number, reason: 'gated' }
    return toResult(number, body as RawBody)
  } catch (err) {
    // Transport errors and an unreadable event date land here; a bad body must never throw out.
    console.warn(`ppl: could not read the answer for ${number}: ${message(err)}`)
    return transport
  }
}

export const pplAdapter: CarrierAdapter = {
  id: 'ppl',
  needsPostalCode: false,
  batchSize: 1,
  matches: number => NUMBER_SHAPE.test(number),
  fetch: (inputs, http) => Promise.all(inputs.map(i => fetchOne(i, http))),
}
