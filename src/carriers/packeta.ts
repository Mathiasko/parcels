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
  trackingDetails?: RawDetail[]
}

function mapStatus(id: string): CanonicalStatus {
  const mapped = STATUS_IDS.get(id)
  if (mapped) return mapped
  console.warn(`packeta: unmapped packetStatusId ${JSON.stringify(id)}, treating as unknown`)
  return 'unknown'
}

/** `branchAddress` is a single display string, so it is kept whole rather than parsed into parts. */
function toPickup(branchAddress: string): PickupPoint {
  return { kind: /z-?box/i.test(branchAddress) ? 'zbox' : 'unknown', name: branchAddress }
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
  if (status === 'ready_for_pickup' && typeof item.branchAddress === 'string' && item.branchAddress) {
    result.pickup = toPickup(item.branchAddress)
  }
  return result   // no retainedTill: Packeta supplies no deadline
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
