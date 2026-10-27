import { parseNaive } from '../core/time.js'
import type {
  CanonicalStatus, CarrierAdapter, FetchInput, FetchResult, HttpClient, ParcelEvent, PickupPoint,
} from '../core/types.js'

const ZONE = 'Europe/Prague'
const ENDPOINT = 'https://tracking.packeta.com/api/getPacketById'
const NUMBER_SHAPE = /^Z\d{10}$/   // no check digit exists, so a typo is only caught by the 404

/**
 * Consumer-endpoint `packetStatusId` values only. Packeta's merchant API `statusCode` reuses the same
 * numbers with different meanings (3, 21, 31 all collide), so never consult a merchant status table.
 * This list is known to be incomplete; anything else maps to `unknown` and is logged.
 */
const STATUS_IDS = new Map<string, CanonicalStatus>(Object.entries({
  '997': 'pre_transit',    // to be processed
  '1': 'pre_transit',      // waiting
  '31': 'in_transit',      // on the way
  '2': 'ready_for_pickup',
  '3': 'delivered',
  '21': 'problem',         // lost
}))

interface RawDetail { text?: string; time: string }
interface RawItem {
  packetStatusId: string | number
  packetStatus?: string
  branchAddress?: string
  branchAddressFull?: string
  storedUntil?: string
  trackingDetails?: RawDetail[]
}

function mapStatus(id: string): CanonicalStatus {
  const mapped = STATUS_IDS.get(id)
  if (mapped) return mapped
  console.warn(`packeta: unmapped packetStatusId ${JSON.stringify(id)}, treating as unknown`)
  return 'unknown'
}

/** A SK/CZ postal code, written `81109` or `811 09`. */
const ZIP = /^\d{3} ?\d{2}$/

/**
 * Packeta sends the pickup point twice. `branchAddress` is one display line, and `branchAddressFull`
 * is the same place structured, newline separated:
 *
 *     branchAddress:     "Z-BOX Bratislava, Hlavna 6"
 *     branchAddressFull: "Z-BOX\nHlavna 6\nBratislava"
 *
 * The structured one wins, because the display line puts the city INSIDE the name and ahead of the
 * street, which a map reads as a place name rather than an address - "Hlavna 6" then resolves to
 * whichever town's Hlavna the geocoder prefers (Senec, not Bratislava, on the first real parcel).
 * The display line stays the fallback for a response that omits the structured form.
 */
function toPickup(item: RawItem): PickupPoint | undefined {
  const display = typeof item.branchAddress === 'string' ? item.branchAddress.trim() : ''
  const full = typeof item.branchAddressFull === 'string' ? item.branchAddressFull : ''
  const lines = full.split('\n').map(l => l.trim()).filter(Boolean)
  const kind: PickupPoint['kind'] = /z-?box/i.test(full || display) ? 'zbox' : 'unknown'

  if (lines.length < 2) return display ? { kind, name: display } : undefined
  const [name, street, ...rest] = lines as [string, string, ...string[]]
  const point: PickupPoint = { kind, name, street }
  // The tail is usually just the city, but a zip may arrive on its own line or glued to it.
  const tail = rest.join(' ').trim()
  const zip = ZIP.test(tail) ? tail : /^(\d{3} ?\d{2}) +(.+)$/.exec(tail)?.[1]
  if (zip !== undefined) point.postalCode = zip.replace(' ', '')
  const city = zip === undefined ? tail : tail.slice(zip.length).trim()
  if (city) point.city = city
  return point
}

/**
 * `storedUntil` is a bare `YYYY-MM-DD`, and the parcel can be collected throughout that day, so the
 * deadline is its last instant local time - not midnight, which would read as a day early.
 * A malformed value must not discard an otherwise good status.
 */
function parseStoredUntil(raw: string): Date | undefined {
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return parseNaive(`${raw} 23:59:59.999`, ZONE, 'yyyy-MM-dd HH:mm:ss.SSS').at
    return parseNaive(raw, ZONE).at
  } catch {
    return undefined
  }
}

function toResult(number: string, item: RawItem): FetchResult {
  const statusId = String(item.packetStatusId)
  const status = mapStatus(statusId)

  const entries = (item.trackingDetails ?? []).map(d => {
    const { at, tz } = parseNaive(d.time, ZONE)
    return { raw: d, at, tz }
  })
  entries.sort((a, b) => a.at.getTime() - b.at.getTime())

  // Entries carry only text and time, so no per-event status can be derived. The parcel's status
  // belongs to the newest event (the DB re-derives the parcel status from it); older ones are unknown.
  const events = entries.map((e, i): ParcelEvent => ({
    occurredAtRaw: e.raw.time,
    occurredAtTz: e.tz,
    occurredAt: e.at,
    status: i === entries.length - 1 ? status : 'unknown',
    description: e.raw.text ?? '',
  }))

  const result: FetchResult = {
    ok: true,
    number,
    status,
    statusRaw: item.packetStatus || statusId,   // the carrier's own sentence is what stays displayable
    statusDetail: statusId,
    events,
    raw: item,
  }
  if (status === 'ready_for_pickup') {
    const pickup = toPickup(item)
    if (pickup) result.pickup = pickup
    // Packeta DOES give a deadline, in `storedUntil`; an earlier reading of this API missed it and the
    // UI told the user there was none, on a parcel that had two days left.
    const till = typeof item.storedUntil === 'string' ? parseStoredUntil(item.storedUntil) : undefined
    if (till) result.retainedTill = till
  }
  return result
}

async function fetchOne({ number }: FetchInput, http: HttpClient): Promise<FetchResult> {
  const transport: FetchResult = { ok: false, number, reason: 'transport' }
  try {
    // Must be POST with no body: the same path answers GET with 405.
    const res = await http(`${ENDPOINT}/${encodeURIComponent(number)}/en`, { method: 'POST' })
    if (res.status === 404) return { ok: false, number, reason: 'not_found' }   // unknown or not yet scanned
    if (res.status !== 200) return transport
    const body = JSON.parse(await res.text()) as { item?: RawItem | null }
    const item = body?.item
    if (!item || typeof item !== 'object') return transport
    if (typeof item.packetStatusId !== 'string' && typeof item.packetStatusId !== 'number') return transport
    return toResult(number, item)
  } catch {
    // Non-JSON or truncated bodies, an unparseable event time and transport errors all land here.
    return transport
  }
}

export const packetaAdapter: CarrierAdapter = {
  id: 'packeta',
  needsPostalCode: false,
  batchSize: 1,
  matches: number => NUMBER_SHAPE.test(number),
  fetch: (inputs, http) => Promise.all(inputs.map(i => fetchOne(i, http))),
}
