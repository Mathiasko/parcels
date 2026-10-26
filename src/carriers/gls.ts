import { parseNaive } from '../core/time.js'
import type {
  CanonicalStatus, CarrierAdapter, FetchInput, FetchResult, HttpClient, ParcelEvent, PickupPoint,
} from '../core/types.js'

const ZONE = 'Europe/Bratislava'
const BASE = 'https://gls-group.com/app/service/open/rest/SK/sk'
const CALLER = 'witt002'
// A bare 11-digit number is not distinctive (nothing else identifies GLS), so this only ever serves
// manual entry. `rstt001`, which every older guide cites, is dead: it 303-redirects to a sign-up page.
const NUMBER_SHAPE = /^\d{11,12}$/

/** Real parcels carry a handful of events; GLS's fabricated dummy parcel carries every event code. */
const MAX_PLAUSIBLE_EVENTS = 50

/**
 * `progressBar.statusInfo` is locale-independent, which is why it and nothing else (never the
 * localised `evtDscr` text) decides the status. Anything unlisted maps to `unknown` and is logged.
 */
const STATUS_INFO = new Map<string, CanonicalStatus>(Object.entries({
  PREADVICE: 'pre_transit',
  PROCESSING: 'in_transit',
  INTRANSIT: 'in_transit',
  MULTIPACK: 'in_transit',
  INWAREHOUSE: 'in_transit',
  INDELIVERY: 'out_for_delivery',
  INPICKUP: 'ready_for_pickup',
  DELIVERED: 'delivered',
  DELIVEREDPS: 'delivered',   // handed over to a ParcelShop
  NOTDELIVERED: 'failed_attempt',
  NOTPICKEDUP: 'problem',     // uncollected at the ParcelShop
  RETURNED: 'returned',
  CANCELLED: 'problem',
  UNAVAILABLE: 'unknown',
}))

const NOT_FOUND_CODES = new Set(['E000', 'E206', 'E800', 'E801'])   // expired/unknown, unknown, not in index
const POSTCODE_MISMATCH = 'E609'

interface RawHistory {
  date: string
  time: string
  address?: { city?: string }
  evtDscr?: string
}
interface RawShop { name?: string; street?: string; city?: string; zipCode?: string; latitude?: unknown; longitude?: unknown }
interface RawItem {
  tuNo?: string
  progressBar?: { statusInfo?: string }
  parcelShop?: RawShop
  addresses?: { latitude?: unknown; longitude?: unknown }[]
  history?: RawHistory[]
  exceptionCode?: string
}
interface RawBody { tuStatus?: RawItem[]; exceptionCode?: string }

/** What one endpoint call amounted to, before any status is derived. */
type Answer =
  | { kind: 'item'; item: RawItem }
  | { kind: 'code'; code: string }
  | { kind: 'failed'; reason: 'gated' | 'transport' }

function mapStatus(statusInfo: string): CanonicalStatus {
  const mapped = STATUS_INFO.get(statusInfo)
  if (mapped) return mapped
  console.warn(`gls: unmapped statusInfo ${JSON.stringify(statusInfo)}, treating as unknown`)
  return 'unknown'
}

function coordinate(v: unknown): number | undefined {
  if (typeof v === 'string' && v.trim() === '') return undefined
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

function toPickup(item: RawItem): PickupPoint | undefined {
  const shop = item.parcelShop
  if (!shop || typeof shop !== 'object') return undefined
  // Coordinates live on `addresses[]`; the shop object itself is only a fallback.
  const located = (item.addresses ?? []).find(
    a => coordinate(a?.latitude) !== undefined && coordinate(a?.longitude) !== undefined,
  )
  const lat = coordinate(located?.latitude ?? shop.latitude)
  const lon = coordinate(located?.longitude ?? shop.longitude)
  return {
    kind: 'parcelshop',
    name: shop.name, street: shop.street, city: shop.city, postalCode: shop.zipCode,
    ...(lat !== undefined && lon !== undefined && { lat, lon }),
  }
}

function toResult(number: string, item: RawItem): FetchResult {
  const statusInfo = item.progressBar?.statusInfo
  if (typeof statusInfo !== 'string' || statusInfo === '') return { ok: false, number, reason: 'transport' }
  const status = mapStatus(statusInfo)

  // `history[]` is newest-first, so reversing it gives oldest-first without a re-sort (which could
  // reorder events sharing a timestamp). rstt029 carries no history at all.
  const entries = (item.history ?? []).toReversed().map(h => {
    const raw = `${h.date} ${h.time}`
    const { at, tz } = parseNaive(raw, ZONE)
    return { raw, h, at, tz }
  })
  // GLS supplies no machine code per event, so no per-event status can be derived. The parcel's
  // status belongs to the newest event; older ones are unknown.
  const events = entries.map((e, i): ParcelEvent => ({
    occurredAtRaw: e.raw,
    occurredAtTz: e.tz,
    occurredAt: e.at,
    status: i === entries.length - 1 ? status : 'unknown',
    description: e.h.evtDscr ?? '',
    location: e.h.address?.city,
  }))

  const result: FetchResult = { ok: true, number, status, statusRaw: statusInfo, events, raw: item }
  if (status === 'ready_for_pickup') {
    const pickup = toPickup(item)
    if (pickup) result.pickup = pickup
  }
  return result   // no retainedTill: GLS supplies no deadline
}

/** One GET, classified. Throws only on transport errors and unparseable JSON; the caller maps those. */
async function ask(url: string, http: HttpClient): Promise<Answer> {
  const res = await http(url)
  if (res.status === 403) return { kind: 'failed', reason: 'gated' }   // never "not found"
  const text = await res.text()
  // A 200 that is a web page means the endpoint was re-gated, not that the parcel is missing.
  if (res.status === 200 && /^\s*</.test(text)) return { kind: 'failed', reason: 'gated' }

  let body: RawBody
  try {
    body = JSON.parse(text) as RawBody
  } catch {
    return { kind: 'failed', reason: 'transport' }
  }
  const item = body?.tuStatus?.[0]
  const code = body?.exceptionCode ?? item?.exceptionCode
  if (typeof code === 'string') return { kind: 'code', code }
  if (res.status !== 200 || !item || typeof item !== 'object') return { kind: 'failed', reason: 'transport' }
  // The dummy-parcel trap: HTTP 200 and a fabricated parcel carrying every event code. It would
  // parse cleanly and report a nonsense status with full confidence, so it is refused.
  if (Array.isArray(item.history) && item.history.length > MAX_PLAUSIBLE_EVENTS) {
    return { kind: 'failed', reason: 'gated' }
  }
  return { kind: 'item', item }
}

const withCommon = () => `caller=${CALLER}&millis=${Date.now()}`

async function fetchOne({ number, postalCode }: FetchInput, http: HttpClient): Promise<FetchResult> {
  const transport: FetchResult = { ok: false, number, reason: 'transport' }
  const postcode = postalCode?.trim()
  // Deterministic: without a postcode rstt028 cannot be asked. No placeholder, no default; the
  // orchestrator remembers the rejection and does not ask again until the postcode changes.
  if (!postcode) return { ok: false, number, reason: 'needs_postcode' }

  const finish = (answer: Answer): FetchResult => {
    if (answer.kind === 'item') return toResult(number, answer.item)
    if (answer.kind === 'failed') return { ok: false, number, reason: answer.reason }
    return NOT_FOUND_CODES.has(answer.code) ? { ok: false, number, reason: 'not_found' } : transport
  }

  try {
    const detail = await ask(
      `${BASE}/rstt028/${encodeURIComponent(number)}?postalCode=${encodeURIComponent(postcode)}&${withCommon()}`, http,
    )
    if (detail.kind === 'code' && detail.code === POSTCODE_MISMATCH) {
      // The postcode is wrong but the parcel exists: rstt029 needs none and still gives the status.
      return finish(await ask(`${BASE}/rstt029?match=${encodeURIComponent(number)}&${withCommon()}`, http))
    }
    return finish(detail)
  } catch {
    // Transport errors and an unparseable event time land here; a bad body must never throw out.
    return transport
  }
}

export const glsAdapter: CarrierAdapter = {
  id: 'gls',
  needsPostalCode: true,
  batchSize: 1,
  matches: number => NUMBER_SHAPE.test(number),
  fetch: (inputs, http) => Promise.all(inputs.map(i => fetchOne(i, http))),
}
