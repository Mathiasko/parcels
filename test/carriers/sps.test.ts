import { readFileSync } from 'node:fs'
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { spsAdapter, resolveApiKey, clearApiKeyCache } from '../../src/carriers/sps.js'
import type { FetchResult, HttpClient } from '../../src/core/types.js'

// the key cache is module-level, so every test starts without one
beforeEach(() => { clearApiKeyCache() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/sps/${name}`, import.meta.url), 'utf8')

const NUMBER = '7031234567890123'
const FALLBACK_KEY = '6VS314WZ+YtFPrYqqV2EZAoxKJNIyr13JGKTWjlOy6jz5zWKr-C8ZnpCJ7ChvZfW'
const SCRAPED_KEY = 'SCRAPED-KEY+abc123-XYZ'
const TRACKING_URL = 'https://rest.mysps.sk/tracking/getShipmentTrackAndTrace'

interface Canned { status?: number; body: string }
interface Call { url: string; init?: RequestInit }
interface Site { index?: Canned; bundle?: Canned; tracking?: Canned }

const site = (tracking: Canned): Site => ({
  index: { body: fixture('index.html') },
  bundle: { body: fixture('bundle.js') },
  tracking,
})

/**
 * Stub HttpClient answering per URL, so a test states what each of the three hosts' resources says.
 * It records every request; a resource with no canned answer rejects like a dead connection.
 */
function stubHttp(answers: Site) {
  const calls: Call[] = []
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init })
    const canned =
      url === 'https://mysps.sk/' ? answers.index
      : url === 'https://mysps.sk/assets/index-ABC123.js' ? answers.bundle
      : url === TRACKING_URL ? answers.tracking
      : undefined
    if (!canned) throw new Error(`unexpected request to ${url}`)
    return {
      status: canned.status ?? 200,
      headers: {},
      text: async () => canned.body,
      json: async <T>() => JSON.parse(canned.body) as T,
    }
  }
  return { http, calls }
}

async function fetchOne(answers: Site, number = NUMBER) {
  const { http, calls } = stubHttp(answers)
  const [r] = await spsAdapter.fetch([{ number }], http)
  return { r: r as FetchResult, calls }
}

function ok(r: FetchResult) {
  if (!r.ok) throw new Error(`expected an ok result, got ${r.reason}`)
  return r
}

/** `in-transit.json` with `shipmentStatus` replaced. */
const withStatus = (shipmentStatus: string) => {
  const body = fixture('in-transit.json')
  if (!body.includes('"shipmentStatus":"inTransit"')) throw new Error('in-transit.json no longer has the status to replace')
  return body.replace('"shipmentStatus":"inTransit"', `"shipmentStatus":${JSON.stringify(shipmentStatus)}`)
}

const statusOf = async (shipmentStatus: string) =>
  ok((await fetchOne(site({ body: withStatus(shipmentStatus) }))).r).status

test('resolveApiKey scrapes the hashed bundle name from the index page then the key from the bundle', async () => {
  const { http, calls } = stubHttp(site({ body: '' }))
  expect(await resolveApiKey(http)).toBe(SCRAPED_KEY)
  // the hashed filename comes from the index page, never hardcoded; the css sibling is not mistaken for it
  expect(calls.map(c => c.url)).toEqual(['https://mysps.sk/', 'https://mysps.sk/assets/index-ABC123.js'])
})

test('resolveApiKey falls back to the known literal when scraping fails', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // index page unreachable
  expect(await resolveApiKey(stubHttp({}).http)).toBe(FALLBACK_KEY)
  // index page has no bundle reference
  expect(await resolveApiKey(stubHttp({ index: { body: '<html></html>' } }).http)).toBe(FALLBACK_KEY)
  // bundle unreachable
  expect(await resolveApiKey(stubHttp({ index: { body: fixture('index.html') } }).http)).toBe(FALLBACK_KEY)
  // bundle served as an error page
  expect(await resolveApiKey(stubHttp({
    index: { body: fixture('index.html') }, bundle: { status: 503, body: 'down' },
  }).http)).toBe(FALLBACK_KEY)
  // bundle no longer carries the header literal
  expect(await resolveApiKey(stubHttp({
    index: { body: fixture('index.html') }, bundle: { body: 'var a=1' },
  }).http)).toBe(FALLBACK_KEY)
})

test('strips dashes from the number before sending', async () => {
  const { r, calls } = await fetchOne(site({ body: fixture('in-transit.json') }), '7031-2345-6789-0123')
  expect(ok(r).number).toBe('7031-2345-6789-0123')   // the caller's own number is echoed back untouched
  const tracking = calls.filter(c => c.url === TRACKING_URL)
  expect(tracking).toHaveLength(1)
  const { init } = tracking[0]!
  expect(init?.method).toBe('POST')
  expect(JSON.parse(init?.body as string)).toEqual({ shipmentNr: NUMBER })
  const headers = init?.headers as Record<string, string>
  expect(headers['Api-Key']).toBe(SCRAPED_KEY)
  expect(headers['Content-Type']).toBe('application/json')
})

test('HTTP 200 with body code 404 maps to not_found', async () => {
  const { r } = await fetchOne(site({ status: 200, body: fixture('not-found.json') }))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'not_found' })
})

test('HTTP 401 maps to gated, signalling key rotation', async () => {
  const { r } = await fetchOne(site({ status: 401, body: fixture('unauthorized.json') }))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
})

test('HTTP 200 with body code 401 also maps to gated', async () => {
  const { r } = await fetchOne(site({ status: 200, body: fixture('unauthorized.json') }))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
})

test('maps shipmentStatus delivered, inTransit, delivering and undelivered correctly', async () => {
  expect(await statusOf('delivered')).toBe('delivered')
  expect(await statusOf('inTransit')).toBe('in_transit')
  expect(await statusOf('delivering')).toBe('out_for_delivery')
  expect(await statusOf('undelivered')).toBe('failed_attempt')
  expect(await statusOf('receivedInfo')).toBe('pre_transit')
  expect(await statusOf('takenByCarrier')).toBe('in_transit')
})

test('an unlisted shipmentStatus maps to unknown rather than being guessed', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await statusOf('somethingNew')).toBe('unknown')
})

test('placedInParcelShop maps to ready_for_pickup', async () => {
  const { r } = await fetchOne(site({ body: fixture('parcelshop.json') }))
  const res = ok(r)
  expect(res.status).toBe('ready_for_pickup')
  expect(res.statusRaw).toBe('placedInParcelShop')
  // the payload carries no address, so none is invented
  expect(res.pickup).toEqual({ kind: 'parcelshop' })
})

test('states entries are parsed as Europe/Bratislava and sorted oldest-first', async () => {
  const { r } = await fetchOne(site({ body: fixture('in-transit.json') }))
  const res = ok(r)
  expect(res.status).toBe('in_transit')
  expect(res.statusRaw).toBe('inTransit')
  expect(res.pickup).toBeUndefined()
  expect(res.events.map(e => e.occurredAtRaw)).toEqual([
    '2026-10-23 09:12:00', '2026-10-23 16:05:00', '2026-10-24 22:18:30', '2026-10-25 06:41:00',
  ])
  expect(res.events.map(e => e.occurredAt.toISOString())).toEqual([
    '2026-10-23T07:12:00.000Z', '2026-10-23T14:05:00.000Z', '2026-10-24T20:18:30.000Z', '2026-10-25T05:41:00.000Z',
  ])
  expect(res.events.every(e => e.occurredAtTz === 'Europe/Bratislava')).toBe(true)
  expect(res.events[0]!.description).toBe('Elektronické dáta o zásielke boli prijaté')
  // statusDescr is display text only: the parcel status comes from shipmentStatus, and the events
  // carry no code or location of their own
  expect(res.events.map(e => e.status)).toEqual(['unknown', 'unknown', 'unknown', 'in_transit'])
  expect(res.events.every(e => e.code === undefined && e.location === undefined)).toBe(true)
})

test('a missing states array yields a status with zero events rather than throwing', async () => {
  const body = JSON.stringify({
    status: true, code: 200, message: 'Success', data: { shipmentStatus: 'receivedInfo', actions: {} },
  })
  const { r } = await fetchOne(site({ body }))
  const res = ok(r)
  expect(res.status).toBe('pre_transit')
  expect(res.events).toEqual([])
})

test('matches() accepts 703-prefixed numbers and rejects a UPS 1Z number', () => {
  expect(spsAdapter.matches(NUMBER)).toBe(true)
  expect(spsAdapter.matches('7030000000000040')).toBe(true)
  expect(spsAdapter.matches('1Z999AA10123456784')).toBe(false)
  expect(spsAdapter.matches('JJD149900000000000')).toBe(false)
  expect(spsAdapter.matches('7031234567890153')).toBe(false)   // 15th digit outside 0-4
  expect(spsAdapter.matches('703123456789012')).toBe(false)    // too short
  expect(spsAdapter.matches('70312345678901234')).toBe(false)  // too long
})

test('matches() accepts the SK-prefixed form seen on real SPS mail', () => {
  expect(spsAdapter.matches('SK0TEST6000000000X')).toBe(true)
  expect(spsAdapter.matches('703' + '12345678901' + '23')).toBe(true)   // the numeric form still matches
  expect(spsAdapter.matches('1Z999AA10123456784')).toBe(false)         // UPS
  expect(spsAdapter.matches('JJD14902' + '1234567890123456')).toBe(false)   // DHL: JJD14902 + 16 digits
  expect(spsAdapter.matches('SK0TEST6000000000')).toBe(false)          // 17 characters
  expect(spsAdapter.matches('SK0TEST6000000000XX')).toBe(false)        // 19 characters
  expect(spsAdapter.matches('SK0TESTAB00000000X')).toBe(false)         // the two digits are letters
  expect(spsAdapter.matches('RA123456785SK')).toBe(false)              // Slovenska posta S10
})

test('adapter metadata', () => {
  expect(spsAdapter.id).toBe('sps')
  expect(spsAdapter.batchSize).toBe(1)
  expect(spsAdapter.needsPostalCode).toBe(false)
})

test('a non-JSON, truncated or unrecognised tracking body is transport, never a throw', async () => {
  expect((await fetchOne(site({ body: '<html>maintenance</html>' }))).r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  expect((await fetchOne(site({ body: '{"status":true,"code":200,"da' }))).r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  expect((await fetchOne(site({ status: 502, body: '' }))).r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  expect((await fetchOne(site({ body: '{"status":false,"code":500,"message":"boom"}' }))).r)
    .toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  expect((await fetchOne(site({ body: '{"status":true,"code":200,"data":{}}' }))).r)
    .toEqual({ ok: false, number: NUMBER, reason: 'transport' })
})

/** A fresh client object on every call, as the orchestrator's per-chunk `captureBodies` wrapper produces. */
function freshClients(state: { trackingStatus: number }) {
  const calls: string[] = []
  const answers = site({ body: fixture('in-transit.json') })
  const next = (): HttpClient => async url => {
    calls.push(url)
    const isTracking = url === TRACKING_URL
    const body = isTracking
      ? (state.trackingStatus === 401 ? fixture('unauthorized.json') : fixture('in-transit.json'))
      : url === 'https://mysps.sk/' ? answers.index!.body : answers.bundle!.body
    return {
      status: isTracking ? state.trackingStatus : 200, headers: {},
      text: async () => body, json: async <T>() => JSON.parse(body) as T,
    }
  }
  const scrapes = () => calls.filter(u => u === 'https://mysps.sk/').length
  return { next, scrapes, calls }
}

test('the key is scraped once across distinct HttpClient objects', async () => {
  const { next, scrapes, calls } = freshClients({ trackingStatus: 200 })
  for (let i = 0; i < 3; i++) await spsAdapter.fetch([{ number: NUMBER }], next())
  expect(scrapes()).toBe(1)
  expect(calls.filter(u => u === TRACKING_URL)).toHaveLength(3)
})

test('concurrent callers share one scrape', async () => {
  const { next, scrapes } = freshClients({ trackingStatus: 200 })
  await Promise.all([1, 2, 3].map(() => spsAdapter.fetch([{ number: NUMBER }], next())))
  expect(scrapes()).toBe(1)
})

test('the key is scraped again after a 401', async () => {
  const state = { trackingStatus: 200 }
  const { next, scrapes } = freshClients(state)
  await spsAdapter.fetch([{ number: NUMBER }], next())
  state.trackingStatus = 401
  expect((await spsAdapter.fetch([{ number: NUMBER }], next()))[0]).toMatchObject({ ok: false, reason: 'gated' })
  state.trackingStatus = 200
  await spsAdapter.fetch([{ number: NUMBER }], next())
  expect(scrapes()).toBe(2)
})

test('the key is scraped again once an hour has passed', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-26T08:00:00Z'))
  const { next, scrapes } = freshClients({ trackingStatus: 200 })
  await spsAdapter.fetch([{ number: NUMBER }], next())
  vi.setSystemTime(new Date('2026-10-26T08:59:00Z'))
  await spsAdapter.fetch([{ number: NUMBER }], next())
  expect(scrapes()).toBe(1)
  vi.setSystemTime(new Date('2026-10-26T09:00:01Z'))
  await spsAdapter.fetch([{ number: NUMBER }], next())
  expect(scrapes()).toBe(2)
})

test('a failed scrape is not cached, so the next call tries again', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const dead = stubHttp({ tracking: { body: fixture('in-transit.json') } })
  await spsAdapter.fetch([{ number: NUMBER }], dead.http)   // index unreachable: fallback key, nothing cached
  const { next, scrapes } = freshClients({ trackingStatus: 200 })
  await spsAdapter.fetch([{ number: NUMBER }], next())
  expect(scrapes()).toBe(1)
  expect(dead.calls.find(c => c.url === TRACKING_URL)?.init?.headers).toMatchObject({ 'Api-Key': FALLBACK_KEY })
})

test('an unparseable event time degrades to transport and the reason is logged', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const body = fixture('in-transit.json').replace('2026-10-25 06:41:00', '25.10.2026 06:41')
  const { r } = await fetchOne(site({ body }))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('25.10.2026 06:41'))
})
