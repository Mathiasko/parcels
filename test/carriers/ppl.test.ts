import { readFileSync } from 'node:fs'
import { describe, test, expect, vi, afterEach } from 'vitest'
import { pplAdapter, PPL_STATUS } from '../../src/carriers/ppl.js'
import { HttpTransportError } from '../../src/core/http.js'
import type { CanonicalStatus, FetchResult, HttpClient } from '../../src/core/types.js'

afterEach(() => { vi.restoreAllMocks() })

// Every body here is synthetic: no real PPL parcel has been seen yet. The shape is the one the
// open-source ha-ppl-cz integration parses, and the not-found body is the probe of 2026-10-30.
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/ppl/${name}`, import.meta.url), 'utf8')

const NUMBER = '40888888801'
const URL_FOR = (n: string) => `https://api.dhl.com/ecs/ppl/webapi/TrackAndTrace/${n}`
const KEY = '7HH634Q79Zpge4xEGeFAHXAnUMRxv0XQ'

interface Canned { status?: number; body: string }
interface Call { url: string; init?: RequestInit }

/** Stub HttpClient with one canned answer; records every request. Never touches the network. */
function stubHttp(canned: Canned | (() => never)) {
  const calls: Call[] = []
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init })
    if (typeof canned === 'function') canned()
    const c = canned as Canned
    return {
      status: c.status ?? 200,
      headers: {},
      text: async () => c.body,
      json: async <T>() => JSON.parse(c.body) as T,
    }
  }
  return { http, calls }
}

async function fetchOne(canned: Canned | (() => never), number = NUMBER) {
  const { http, calls } = stubHttp(canned)
  const [r] = await pplAdapter.fetch([{ number }], http)
  return { r: r as FetchResult, calls }
}

function ok(r: FetchResult) {
  if (!r.ok) throw new Error(`expected an ok result, got ${r.reason}`)
  return r
}

/** `in-transit.json` with `phase` and `lastEventCode` replaced. */
function withCodes(phase: string | null, lastEventCode: string | null = 'ShipmentInTransport'): string {
  const body = JSON.parse(fixture('in-transit.json')) as Record<string, unknown>
  return JSON.stringify({ ...body, phase, lastEventCode })
}

const answer = async (body: string) => ok((await fetchOne({ body })).r)

describe('the request', () => {
  test('one POST with the public key, a JSON content type and an empty JSON body', async () => {
    const { calls } = await fetchOne({ body: fixture('in-transit.json') })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(URL_FOR(NUMBER))
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.headers).toEqual({ 'dhl-api-key': KEY, 'Content-Type': 'application/json' })
    // Omitting the body gets a 415, so `{}` is sent rather than nothing.
    expect(calls[0]!.init?.body).toBe('{}')
  })

  test('the adapter declares one parcel per call, no postcode, and claims exactly 11 digits', () => {
    expect(pplAdapter.id).toBe('ppl')
    expect(pplAdapter.batchSize).toBe(1)
    expect(pplAdapter.needsPostalCode).toBe(false)
    expect(pplAdapter.matches('40888888801')).toBe(true)
    expect(pplAdapter.matches('4088888880')).toBe(false)
    expect(pplAdapter.matches('408888888011')).toBe(false)
    expect(pplAdapter.matches('Z4088888880')).toBe(false)
  })
})

describe('status, from the codes only', () => {
  const table: [string, CanonicalStatus][] = [
    ['WaitingForShipment', 'pre_transit'],
    ['PickedUpFromSender', 'in_transit'],
    ['ShipmentInTransport', 'in_transit'],
    ['PreparingForDelivery', 'in_transit'],
    ['LoadingForDelivery', 'out_for_delivery'],
    ['OutForDelivery', 'out_for_delivery'],
    ['DeliveredToPickupPoint', 'ready_for_pickup'],
    ['Delivered.Parcelshop', 'ready_for_pickup'],
    ['Delivered', 'delivered'],
    ['NotDelivered', 'failed_attempt'],
    ['BackToSender', 'returning'],
  ]

  for (const [code, status] of table) {
    test(`phase ${code} is ${status}`, async () => {
      const r = await answer(withCodes(code))
      expect(r.status).toBe(status)
      expect(r.statusRaw).toBe(code)
    })
  }

  test('the exported table is exactly the spec table', () => {
    expect(new Map(table)).toEqual(PPL_STATUS)
  })

  test('a missing phase falls back to lastEventCode', async () => {
    const r = await answer(withCodes(null, 'OutForDelivery'))
    expect(r.status).toBe('out_for_delivery')
    expect(r.statusRaw).toBe('OutForDelivery')
    expect((await answer(withCodes('', 'NotDelivered'))).status).toBe('failed_attempt')
  })

  test('an unlisted code is unknown, with no "base before the dot" guess', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // `Delivered.BackToSender` read as `Delivered` would drop a returning parcel off the dashboard.
    const back = await answer(withCodes('Delivered.BackToSender'))
    expect(back.status).toBe('unknown')
    expect(back.statusRaw).toBe('Delivered.BackToSender')
    const foo = await answer(withCodes('Foo'))
    expect(foo.status).toBe('unknown')
    expect(foo.statusRaw).toBe('Foo')
  })

  test('the status text is never read: a text that says delivered does not make it so', async () => {
    const body = JSON.parse(withCodes('ShipmentInTransport')) as Record<string, unknown>
    const r = await answer(JSON.stringify({ ...body, lastEventText: 'Delivered' }))
    expect(r.status).toBe('in_transit')
  })

  test('a body with no code at all is a transport failure, not a guess', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { r } = await fetchOne({ body: withCodes(null, null) })
    expect(r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  })

  test('the parsed body is kept as raw', async () => {
    const r = await answer(fixture('in-transit.json'))
    expect(r.raw).toEqual(JSON.parse(fixture('in-transit.json')))
  })
})

describe('events', () => {
  test('each event takes its status from its own code and its description from its text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await answer(fixture('events.json'))
    // Oldest first; the entry without an eventDate is skipped.
    expect(r.events.map(e => [e.occurredAt.toISOString(), e.status, e.code, e.description])).toEqual([
      ['2026-11-05T08:00:00.000Z', 'pre_transit', 'WaitingForShipment', 'WaitingForShipment'],
      ['2026-11-05T20:00:00.000Z', 'in_transit', 'ShipmentInTransport', 'Zásilka je na cestě'],
      ['2026-11-06T05:00:00.000Z', 'unknown', undefined, 'Přijato v depu'],
      ['2026-11-06T08:15:00.000Z', 'out_for_delivery', 'OutForDelivery', 'Zásilka je na cestě k příjemci'],
    ])
  })

  test('dates: ms epoch, ISO with Z or an offset taken as is, naive ISO as Prague wall clock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await answer(fixture('events.json'))
    const at = (code: string | undefined) => r.events.find(e => e.code === code)!
    expect(at('WaitingForShipment')).toMatchObject({ occurredAtRaw: '1793865600000', occurredAtTz: 'UTC' })
    expect(at('ShipmentInTransport')).toMatchObject({ occurredAtRaw: '2026-11-05T20:00:00Z', occurredAtTz: 'UTC' })
    expect(at(undefined).occurredAtRaw).toBe('2026-11-06T06:00:00+01:00')
    // 09:15 in Prague in November is CET, UTC+1.
    expect(at('OutForDelivery')).toMatchObject({ occurredAtRaw: '2026-11-06T09:15:00', occurredAtTz: 'Europe/Prague' })
    expect(at('OutForDelivery').occurredAt.toISOString()).toBe('2026-11-06T08:15:00.000Z')
  })

  test('an instant in the autumn fold given with Z is not moved an hour by the fold rule', async () => {
    // 01:30Z on 25 Oct 2026 is 02:30 CET, the SECOND 02:30 in Prague that night.
    const body = JSON.parse(fixture('in-transit.json')) as Record<string, unknown>
    const r = await answer(JSON.stringify({ ...body, events: [{ code: 'ShipmentInTransport', eventDate: '2026-10-25T01:30:00Z', eventText: null }] }))
    expect(r.events[0]!.occurredAt.toISOString()).toBe('2026-10-25T01:30:00.000Z')
  })

  test('events: null is no events', async () => {
    const body = JSON.parse(fixture('in-transit.json')) as Record<string, unknown>
    const r = await answer(JSON.stringify({ ...body, events: null }))
    expect(r.events).toEqual([])
    expect(r.status).toBe('in_transit')
  })

  test('an event date that cannot be read is a transport failure, as for the other carriers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = JSON.parse(fixture('in-transit.json')) as Record<string, unknown>
    const { r } = await fetchOne({ body: JSON.stringify({ ...body, events: [{ code: 'Delivered', eventDate: 'yesterday', eventText: null }] }) })
    expect(r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  })
})

describe('pickup point', () => {
  test('a ParcelShop answer becomes a parcelshop pickup point named by parcelshopName, with no deadline', async () => {
    const r = await answer(fixture('parcelshop.json'))
    expect(r.status).toBe('ready_for_pickup')
    expect(r.pickup).toEqual({ kind: 'parcelshop', name: 'PPL Parcelshop Testovice' })
    expect(r.retainedTill).toBeUndefined()
  })

  test('a Parcelbox is a locker', async () => {
    const body = JSON.parse(fixture('parcelshop.json')) as Record<string, unknown>
    const r = await answer(JSON.stringify({ ...body, accessPoint: { parcelshopName: 'PPL Parcelbox Testovice' } }))
    expect(r.pickup).toEqual({ kind: 'locker', name: 'PPL Parcelbox Testovice' })
  })

  test('without parcelshopName the access point name is used', async () => {
    const body = JSON.parse(fixture('parcelshop.json')) as Record<string, unknown>
    const r = await answer(JSON.stringify({ ...body, accessPoint: { parcelshopName: null, name: 'Testovice Trafika' } }))
    expect(r.pickup).toEqual({ kind: 'parcelshop', name: 'Testovice Trafika' })
  })

  test('accessPoint: null is no pickup point', async () => {
    const body = JSON.parse(fixture('parcelshop.json')) as Record<string, unknown>
    const r = await answer(JSON.stringify({ ...body, accessPoint: null }))
    expect(r.status).toBe('ready_for_pickup')
    expect(r.pickup).toBeUndefined()
  })

  test('the pickup point is only reported once the parcel waits there, as for the other carriers', async () => {
    const body = JSON.parse(fixture('parcelshop.json')) as Record<string, unknown>
    const r = await answer(JSON.stringify({ ...body, phase: 'ShipmentInTransport' }))
    expect(r.pickup).toBeUndefined()
  })
})

describe('failures', () => {
  const failed = async (canned: Canned | (() => never)) => (await fetchOne(canned)).r

  test('a 400 saying ShipmentNotFound is not_found', async () => {
    expect(await failed({ status: 400, body: fixture('not-found.json') }))
      .toEqual({ ok: false, number: NUMBER, reason: 'not_found' })
  })

  test('a 400 with any other detail is transport', async () => {
    expect(await failed({ status: 400, body: '{"detail":"service.TrackAndTrace.SomethingElse"}' }))
      .toEqual({ ok: false, number: NUMBER, reason: 'transport' })
    expect(await failed({ status: 400, body: 'Bad Request' }))
      .toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  })

  test('a 500 is transport', async () => {
    expect(await failed({ status: 500, body: fixture('not-found.json') }))
      .toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  })

  test('a 401 or 403 is gated: the key or the endpoint changed', async () => {
    expect(await failed({ status: 403, body: '{"detail":"Forbidden"}' })).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
    expect(await failed({ status: 401, body: '' })).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
  })

  test('a 200 that is not a JSON object is gated', async () => {
    for (const body of ['<html><body>Access denied</body></html>', 'garbage', '[]', 'null', '"text"']) {
      expect(await failed({ body })).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
    }
  })

  test('a thrown HttpTransportError is transport', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await failed(() => { throw new HttpTransportError(URL_FOR(NUMBER), new Error('timeout')) })
    expect(r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  })
})
