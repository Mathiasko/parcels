import { parseNaive } from '../core/time.js'
import type {
  CanonicalStatus, CarrierAdapter, FetchInput, FetchResult, HttpClient, ParcelEvent,
} from '../core/types.js'

const ZONE = 'Europe/Bratislava'
const SITE = 'https://mysps.sk/'
const ENDPOINT = 'https://rest.mysps.sk/tracking/getShipmentTrackAndTrace'
/** The key as published in the bundle on 2026-10-26; only used when scraping the current one fails. */
const FALLBACK_API_KEY = '6VS314WZ+YtFPrYqqV2EZAoxKJNIyr13JGKTWjlOy6jz5zWKr-C8ZnpCJ7ChvZfW'

// Deliberately narrower than SPS's own published regex list, which also admits UPS (`1Z...`) and DHL
// (`JJD14902...`) numbers because SPS carries inbound partner parcels. Using that list would misroute
// those numbers here. No check digit is known, so a typo is only caught by the not-found answer.
const NUMBER_SHAPE = /^703\d{11}[0-4]\d$/

/** The content-hashed bundle changes name on every deploy, hence it is found rather than hardcoded. */
const BUNDLE_PATH = /assets\/index-[\w-]+\.js/
/** The bundle builds its request headers as `{"Api-Key":"<literal>", ...}`. */
const API_KEY_LITERAL = /["']?Api-Key["']?\s*[:=]\s*["']([^"']+)["']/

/**
 * `data.shipmentStatus` is the only machine status field. Never consult `states[].statusDescr`: it is
 * free-text Slovak from SPS's upstream system and is not enumerated anywhere. Anything unlisted maps to
 * `unknown` and is logged.
 */
const SHIPMENT_STATUS = new Map<string, CanonicalStatus>(Object.entries({
  receivedInfo: 'pre_transit',
  takenByCarrier: 'in_transit',
  inTransit: 'in_transit',
  delivering: 'out_for_delivery',
  placedInParcelShop: 'ready_for_pickup',
  delivered: 'delivered',
  undelivered: 'failed_attempt',
}))

interface RawState { time: string; statusDescr?: string }
interface RawBody {
  status?: boolean
  code?: number
  data?: { shipmentStatus?: unknown; states?: RawState[] }
}

/**
 * Reads the current `Api-Key` out of SPS's own public JS bundle: the index page names the hashed
 * bundle, the bundle carries the key. It is a build-time constant, so no account is involved.
 * Never throws: any failure along the way yields the known literal, and a wrong key surfaces
 * later as a 401, which is `gated`.
 */
export async function resolveApiKey(http: HttpClient): Promise<string> {
  try {
    const index = await http(SITE)
    if (index.status !== 200) throw new Error(`index page answered ${index.status}`)
    const bundlePath = BUNDLE_PATH.exec(await index.text())?.[0]
    if (!bundlePath) throw new Error('no index-*.js reference on the index page')
    const bundle = await http(`${SITE}${bundlePath}`)
    if (bundle.status !== 200) throw new Error(`bundle answered ${bundle.status}`)
    const key = API_KEY_LITERAL.exec(await bundle.text())?.[1]
    if (!key) throw new Error('no Api-Key literal in the bundle')
    return key
  } catch (err) {
    console.warn(`sps: could not scrape the Api-Key (${err instanceof Error ? err.message : String(err)}), using the known literal`)
    return FALLBACK_API_KEY
  }
}

/** One scrape per client rather than per parcel; dropped on a 401 so a rotated key is re-read. */
const keys = new WeakMap<HttpClient, Promise<string>>()
function apiKey(http: HttpClient): Promise<string> {
  let key = keys.get(http)
  if (!key) {
    key = resolveApiKey(http)
    keys.set(http, key)
  }
  return key
}

function mapStatus(shipmentStatus: string): CanonicalStatus {
  const mapped = SHIPMENT_STATUS.get(shipmentStatus)
  if (mapped) return mapped
  console.warn(`sps: unmapped shipmentStatus ${JSON.stringify(shipmentStatus)}, treating as unknown`)
  return 'unknown'
}

function toResult(number: string, shipmentStatus: string, states: RawState[], raw: unknown): FetchResult {
  const status = mapStatus(shipmentStatus)

  const entries = states.map(s => {
    const { at, tz } = parseNaive(s.time, ZONE)
    return { s, at, tz }
  })
  entries.sort((a, b) => a.at.getTime() - b.at.getTime())

  // Entries carry only `time` and `statusDescr` (no code, no location), so no per-event status can be
  // derived. The parcel's status belongs to the newest event; older ones are unknown.
  const events = entries.map((e, i): ParcelEvent => ({
    occurredAtRaw: e.s.time,
    occurredAtTz: e.tz,
    occurredAt: e.at,
    status: i === entries.length - 1 ? status : 'unknown',
    description: e.s.statusDescr ?? '',
  }))

  const result: FetchResult = { ok: true, number, status, statusRaw: shipmentStatus, events, raw }
  // The payload says a parcel shop holds it but never which one, so no address is invented.
  if (status === 'ready_for_pickup') result.pickup = { kind: 'parcelshop' }
  return result   // no retainedTill: SPS supplies no deadline
}

async function fetchOne({ number }: FetchInput, http: HttpClient): Promise<FetchResult> {
  const transport: FetchResult = { ok: false, number, reason: 'transport' }
  try {
    const key = await apiKey(http)
    const res = await http(ENDPOINT, {
      method: 'POST',
      headers: { 'Api-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipmentNr: number.replaceAll('-', '') }),
    })
    // A genuine 401 means the key rotated: the adapter is broken, which is not "parcel not found".
    if (res.status === 401) {
      keys.delete(http)
      return { ok: false, number, reason: 'gated' }
    }
    if (res.status !== 200) return transport
    // Every answer is HTTP 200: the real outcome is `code` in the body, so branch on that.
    const body = JSON.parse(await res.text()) as RawBody
    if (body?.code === 404) return { ok: false, number, reason: 'not_found' }   // unknown or not yet announced
    if (body?.code === 401) {
      keys.delete(http)
      return { ok: false, number, reason: 'gated' }
    }
    const data = body?.data
    if (body?.code !== 200 || !data || typeof data.shipmentStatus !== 'string') return transport
    return toResult(number, data.shipmentStatus, Array.isArray(data.states) ? data.states : [], body)
  } catch {
    // Non-JSON or truncated bodies, an unparseable event time and transport errors all land here.
    return transport
  }
}

export const spsAdapter: CarrierAdapter = {
  id: 'sps',
  needsPostalCode: false,
  batchSize: 1,
  matches: number => NUMBER_SHAPE.test(number),
  fetch: (inputs, http) => Promise.all(inputs.map(i => fetchOne(i, http))),
}
