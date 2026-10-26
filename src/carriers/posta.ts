import { parseNaive } from '../core/time.js'
import type {
  CarrierAdapter, FetchInput, FetchResult, HttpClient, ParcelEvent, PickupPoint,
} from '../core/types.js'
import { mapPostaStatus } from './posta-codes.js'

const ZONE = 'Europe/Bratislava'
const ENDPOINT = 'https://api.posta.sk/tracking'
const NUMBER_SHAPE = /^[A-Z]{2}\d{9}SK$/
const CHECK_WEIGHTS = [8, 6, 4, 2, 3, 5, 9, 7]

interface RawPostOffice {
  name?: string; street?: string; city?: string; zip?: string; lat?: number; lon?: number
}
interface RawEvent {
  localDate: string
  stateCode?: string
  detailCode?: string
  description?: string
  retainedTill?: string
  postOffice?: RawPostOffice
}
interface RawResult { number: string; status: string; events?: RawEvent[] }
interface RawEnvelope { results: RawResult[] }

/** UPU S10 check digit (mod 11 over the 8 serial digits). Catches typos only; the API does not enforce it. */
function checkDigitOk(number: string): boolean {
  const sum = CHECK_WEIGHTS.reduce((acc, w, i) => acc + w * Number(number[2 + i]), 0)
  const raw = 11 - (sum % 11)
  const expected = raw === 10 ? 0 : raw === 11 ? 5 : raw
  return expected === Number(number[10])
}

function toPickup(po: RawPostOffice): PickupPoint {
  return {
    kind: 'post_office',
    name: po.name, street: po.street, city: po.city, postalCode: po.zip,
    lat: po.lat, lon: po.lon,
  }
}

function toResult(raw: RawResult): FetchResult {
  if (raw.status === 'invalid_format') return { ok: false, number: raw.number, reason: 'not_found' }
  if (raw.status !== 'ok') return { ok: false, number: raw.number, reason: 'transport' }

  const entries = (raw.events ?? []).map(e => {
    const { at, tz } = parseNaive(e.localDate, ZONE)
    const event: ParcelEvent = {
      occurredAtRaw: e.localDate,
      occurredAtTz: tz,
      occurredAt: at,
      status: mapPostaStatus(e.stateCode, e.detailCode),
      code: e.detailCode ?? e.stateCode,
      description: e.description ?? e.detailCode ?? e.stateCode ?? '',
      location: e.postOffice?.name,
    }
    return { event, raw: e }
  })
  entries.sort((a, b) => a.event.occurredAt.getTime() - b.event.occurredAt.getTime())

  const events = entries.map(x => x.event)
  const latest = entries.at(-1)
  if (!latest) {
    // A valid parcel nothing has scanned yet. Not the same as invalid_format.
    return { ok: true, number: raw.number, status: 'pre_transit', statusRaw: raw.status, events, raw }
  }

  const result: FetchResult = {
    ok: true,
    number: raw.number,
    status: latest.event.status,
    statusRaw: latest.raw.stateCode ?? '',
    statusDetail: latest.raw.detailCode,
    events,
    raw,
  }
  if (latest.event.status === 'ready_for_pickup') {
    if (latest.raw.postOffice) result.pickup = toPickup(latest.raw.postOffice)
    if (latest.raw.retainedTill) result.retainedTill = parseNaive(latest.raw.retainedTill, ZONE).at
  }
  return result
}

async function fetchBatch(inputs: FetchInput[], http: HttpClient): Promise<FetchResult[]> {
  const transport = (): FetchResult[] => inputs.map(i => ({ ok: false, number: i.number, reason: 'transport' }))
  const q = inputs.map(i => encodeURIComponent(i.number)).join(',')
  let envelope: RawEnvelope
  try {
    const res = await http(`${ENDPOINT}?q=${q}&l=sk&p=1`)
    if (res.status !== 200) return transport()
    envelope = JSON.parse(await res.text()) as RawEnvelope
    if (!Array.isArray(envelope.results)) return transport()
  } catch {
    // Non-JSON bodies (e.g. an Erlang tuple), truncated bodies and transport errors all land here.
    return transport()
  }

  // The API does not promise request order, so index by each result's own number.
  const byNumber = new Map<string, RawResult>()
  for (const r of envelope.results) byNumber.set(r.number, r)

  return inputs.map(({ number }): FetchResult => {
    const raw = byNumber.get(number)
    if (!raw) return { ok: false, number, reason: 'transport' }
    try {
      return toResult(raw)
    } catch {
      return { ok: false, number, reason: 'transport' }   // e.g. an unparseable localDate
    }
  })
}

export const postaAdapter: CarrierAdapter = {
  id: 'posta',
  needsPostalCode: false,
  batchSize: 100,
  matches: number => NUMBER_SHAPE.test(number) && checkDigitOk(number),
  fetch: (inputs, http) => (inputs.length === 0 ? Promise.resolve([]) : fetchBatch(inputs, http)),
}
