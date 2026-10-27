import { decodeEntities } from '../core/entities.js'
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
  address?: { city?: string } | string
  evtDscr?: string
  evtNo?: string
}
interface RawAddress {
  name?: string; blockNo1?: string; postalCode?: string; city?: string; latitude?: unknown; longitude?: unknown
}
interface RawItem {
  tuNo?: string
  referenceNo?: string
  progressBar?: { statusInfo?: string }
  parcelShop?: { parcelShopID?: string }
  addresses?: RawAddress[]
  history?: RawHistory[]
}
/** Errors carry their code in `lastError` (verified live); a 403 has none, and a 400 lists `fieldExceptions`. */
interface RawBody {
  tuStatus?: RawItem[]
  lastError?: string
  fieldExceptions?: { attribute?: string }[]
}

/** What one endpoint call amounted to, before any status is derived. */
type Answer =
  | { kind: 'item'; item: RawItem }
  | { kind: 'code'; code: string }
  | { kind: 'bad_postcode' }   // HTTP 400 naming `zipcode`: the postcode is malformed
  | { kind: 'failed'; reason: 'gated' | 'transport' }
  | { kind: 'dummy'; events: number }   // GLS's fabricated parcel for a number it does not know

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

/** GLS text fields carry HTML numeric entities (`&#268;`), which are decoded for display. */
const text = (s: string | undefined): string | undefined => (s === undefined ? undefined : decodeEntities(s))

/** `parcelShop` only says a shop is involved (`parcelShopID`); where it is lives in `addresses[]`. */
function toPickup(item: RawItem): PickupPoint | undefined {
  if (!item.parcelShop || typeof item.parcelShop !== 'object') return undefined
  // GUESS pending a captured INPICKUP record: the `type` values of addresses[] are undocumented, so
  // the first entry that carries coordinates is taken to be the shop.
  const where = (item.addresses ?? []).find(
    a => coordinate(a?.latitude) !== undefined && coordinate(a?.longitude) !== undefined,
  )
  if (!where) return { kind: 'parcelshop' }
  return {
    kind: 'parcelshop',
    name: text(where.name), street: text(where.blockNo1), city: text(where.city), postalCode: where.postalCode,
    lat: coordinate(where.latitude), lon: coordinate(where.longitude),
  }
}

function toResult(number: string, item: RawItem): FetchResult {
  const statusInfo = item.progressBar?.statusInfo
  if (typeof statusInfo !== 'string' || statusInfo === '') return { ok: false, number, reason: 'transport' }
  const status = mapStatus(statusInfo)

  // `history[]` arrived newest-first in the one live capture, but that is not relied on: events are
  // ordered by their own timestamp. The array is reversed first, so ties (same second) keep the
  // newest-first reading and the sort, being stable, does not reshuffle them. rstt029 carries none.
  const entries = (item.history ?? []).toReversed().map(h => {
    const raw = `${h.date} ${h.time}`
    const { at, tz } = parseNaive(raw, ZONE)
    return { raw, h, at, tz }
  }).sort((a, b) => a.at.getTime() - b.at.getTime())
  // GLS supplies no machine code per event, so no per-event status can be derived. The parcel's
  // status belongs to the newest event; older ones are unknown.
  const events = entries.map((e, i): ParcelEvent => ({
    occurredAtRaw: e.raw,
    occurredAtTz: e.tz,
    occurredAt: e.at,
    status: i === entries.length - 1 ? status : 'unknown',
    code: e.h.evtNo,
    description: decodeEntities(e.h.evtDscr ?? ''),
    location: text(typeof e.h.address === 'string' ? e.h.address : e.h.address?.city),
  }))

  const result: FetchResult = { ok: true, number, status, statusRaw: statusInfo, events, raw: item }
  if (status === 'ready_for_pickup') {
    const pickup = toPickup(item)
    if (pickup) result.pickup = pickup
  }
  return result   // no retainedTill: GLS supplies no deadline
}

/**
 * The two endpoints disagree on shape (both verified live): rstt029 wraps its item in `tuStatus[]`,
 * rstt028 answers with the bare item. `ask` normalises both to one `RawItem`, so nothing below it knows.
 * A bare answer is recognised by carrying the parcel itself (error bodies have none of these markers).
 */
function bareItem(body: RawBody | null): RawItem | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const b = body as RawBody & RawItem
  return b.progressBar || b.tuNo || b.referenceNo ? b : undefined
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
  const item = body?.tuStatus?.[0] ?? bareItem(body)
  // Only a `zipcode` complaint counts: a 400 about any other attribute (e.g. a malformed `match`)
  // is a different problem with no evidence behind it, so it stays `transport` below.
  if (res.status === 400 && Array.isArray(body?.fieldExceptions)
      && body.fieldExceptions.some(f => f?.attribute?.toLowerCase() === 'zipcode')) {
    return { kind: 'bad_postcode' }
  }
  if (typeof body?.lastError === 'string') return { kind: 'code', code: body.lastError }
  // An empty `tuStatus` with no error code is deliberately `transport`, NOT `not_found`: that shape
  // has never been observed, and "not found" is silent while "transport" surfaces. Do not change it
  // without a captured response showing GLS really answers that way for an unknown parcel.
  // (Contrast the postcode problems, which are known and handled as one policy: see fetchOne.)
  if (res.status !== 200 || !item || typeof item !== 'object') return { kind: 'failed', reason: 'transport' }
  // The dummy-parcel trap: HTTP 200 and a fabricated parcel carrying every event code. It would
  // parse cleanly and report a nonsense status with full confidence, so it is refused. This is a
  // property of the one number asked about, not evidence that the adapter is broken (`gated`), so it
  // is a per-parcel `not_found`: a single mistyped number must not throttle the carrier's other parcels.
  if (Array.isArray(item.history) && item.history.length > MAX_PLAUSIBLE_EVENTS) {
    return { kind: 'dummy', events: item.history.length }
  }
  return { kind: 'item', item }
}

const withCommon = () => `caller=${CALLER}&millis=${Date.now()}`

async function fetchOne({ number, postalCode }: FetchInput, http: HttpClient): Promise<FetchResult> {
  const transport: FetchResult = { ok: false, number, reason: 'transport' }
  const postcode = postalCode?.trim()

  const finish = (answer: Answer): FetchResult => {
    if (answer.kind === 'item') return toResult(number, answer.item)
    if (answer.kind === 'failed') return { ok: false, number, reason: answer.reason }
    if (answer.kind === 'dummy') {
      console.warn(`gls: ${number} came back as GLS's fabricated dummy parcel (${answer.events} events); treating it as not found`)
      return { ok: false, number, reason: 'not_found' }
    }
    if (answer.kind === 'bad_postcode') return transport   // only reachable if rstt029 itself complained
    return NOT_FOUND_CODES.has(answer.code) ? { ok: false, number, reason: 'not_found' } : transport
  }

  const overview = () => ask(`${BASE}/rstt029?match=${encodeURIComponent(number)}&${withCommon()}`, http)

  try {
    // One deliberate policy for every postcode problem: ABSENT, MISMATCHED (E609) and MALFORMED
    // (HTTP 400 on `zipcode`) all degrade to rstt029, which needs no postcode and still gives the
    // authoritative status; only history[] is lost. Never `needs_postcode` (the orchestrator would
    // stop polling a parcel we can track) and never `transport` for a deterministic failure (it would
    // be retried identically forever). No placeholder or default postcode is ever invented.
    if (!postcode) return finish(await overview())
    const detail = await ask(
      `${BASE}/rstt028/${encodeURIComponent(number)}?postalCode=${encodeURIComponent(postcode)}&${withCommon()}`, http,
    )
    if (detail.kind === 'bad_postcode' || (detail.kind === 'code' && detail.code === POSTCODE_MISMATCH)) {
      // rstt028 is not retried: the postcode is wrong, but the parcel itself can still be tracked.
      return finish(await overview())
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
