import { readFileSync } from 'node:fs'
import { test, expect, vi, afterEach } from 'vitest'
import { packetaAdapter } from '../../src/carriers/packeta.js'
import type { FetchResult, HttpClient } from '../../src/core/types.js'

afterEach(() => { vi.restoreAllMocks() })

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/packeta/${name}`, import.meta.url), 'utf8')

interface Call { url: string; init?: RequestInit }

/**
 * Stub HttpClient serving one canned body; records every request it received.
 * Like the real endpoint, it answers 405 to anything but a POST.
 */
function stubHttp(body: string, status = 200) {
  const calls: Call[] = []
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init })
    const wrongMethod = init?.method !== 'POST'
    const text = wrongMethod ? '' : body
    return {
      status: wrongMethod ? 405 : status,
      headers: {},
      text: async () => text,
      json: async <T>() => JSON.parse(text) as T,
    }
  }
  return { http, calls }
}

async function fetchOne(body: string, status = 200, number = 'Z1234567890') {
  const { http } = stubHttp(body, status)
  const [r] = await packetaAdapter.fetch([{ number }], http)
  return r as FetchResult
}

function ok(r: FetchResult) {
  if (!r.ok) throw new Error(`expected an ok result, got ${r.reason}`)
  return r
}

/** `delivered.json` with a different packetStatusId. */
const withStatusId = (id: string) =>
  fixture('delivered.json').replace('"packetStatusId":"3"', `"packetStatusId":"${id}"`)

test('issues a POST with an empty body and no required headers', async () => {
  const { http, calls } = stubHttp(fixture('delivered.json'))
  await packetaAdapter.fetch([{ number: 'Z1234567890' }], http)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe('https://tracking.packeta.com/api/getPacketById/Z1234567890/en')
  expect(calls[0]!.init?.method).toBe('POST')
  expect(calls[0]!.init?.body ?? '').toBe('')
  // the endpoint needs no credentials, so none may be sent (a polite User-Agent would be fine)
  const headers = new Headers(calls[0]!.init?.headers)
  for (const name of ['authorization', 'cookie', 'x-api-key']) expect(headers.has(name)).toBe(false)
})

test('a GET is never issued', async () => {
  const { http, calls } = stubHttp(fixture('delivered.json'))
  const [r] = await packetaAdapter.fetch([{ number: 'Z1234567890' }], http)
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.map(c => c.init?.method)).not.toContain('GET')
  expect(calls.every(c => c.init?.method === 'POST')).toBe(true)
  // had a GET been sent the stub would have answered 405, which cannot yield an ok result
  expect(ok(r as FetchResult).status).toBe('delivered')
})

test('404 maps to not_found, not gated', async () => {
  const r = await fetchOne(fixture('not-found.json'), 404)
  expect(r).toEqual({ ok: false, number: 'Z1234567890', reason: 'not_found' })
})

test('packetStatusId 3 maps to delivered', async () => {
  const r = ok(await fetchOne(fixture('delivered.json')))
  expect(r.status).toBe('delivered')
  expect(r.statusRaw).toBe('Your parcel has been delivered.')
  expect(r.events).toHaveLength(3)
})

test('packetStatusId 2 maps to ready_for_pickup and extracts branchAddress as a zbox pickup point', async () => {
  const r = ok(await fetchOne(fixture('ready-for-pickup.json')))
  expect(r.status).toBe('ready_for_pickup')
  expect(r.pickup).toEqual({ kind: 'zbox', name: 'Z-BOX Bratislava, Obchodna 12, 811 06 Bratislava' })
})

test('packetStatusId 997 maps to pre_transit and 21 maps to problem', async () => {
  expect(ok(await fetchOne(withStatusId('997'))).status).toBe('pre_transit')
  expect(ok(await fetchOne(withStatusId('21'))).status).toBe('problem')
})

test('the other known ids map under the consumer vocabulary: 1 pre_transit, 31 in_transit', async () => {
  expect(ok(await fetchOne(withStatusId('1'))).status).toBe('pre_transit')
  expect(ok(await fetchOne(withStatusId('31'))).status).toBe('in_transit')
})

test('an unknown packetStatusId maps to unknown and preserves packetStatus text as statusRaw', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const r = ok(await fetchOne(fixture('unknown-status.json')))
  expect(r.status).toBe('unknown')
  expect(r.statusRaw).toBe('A status Packeta added after we wrote this.')
  expect(r.statusDetail).toBe('4242')
  expect(r.events).toHaveLength(1)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('4242'))
})

test('a numeric packetStatusId is tolerated and mapped like its string form', async () => {
  const r = ok(await fetchOne(fixture('delivered.json').replace('"packetStatusId":"3"', '"packetStatusId":3')))
  expect(r.status).toBe('delivered')
  expect(r.statusDetail).toBe('3')
})

test('pickup is omitted when the status is not ready_for_pickup, even if branchAddress is present', async () => {
  // delivered.json carries a branchAddress but the parcel is already delivered
  const r = ok(await fetchOne(fixture('delivered.json')))
  expect(r.pickup).toBeUndefined()
})

test('pickup is omitted when branchAddress is missing, without affecting the status', async () => {
  const r = ok(await fetchOne(fixture('ready-for-pickup.json').replace(/"branchAddress":"[^"]*",/, '')))
  expect(r.status).toBe('ready_for_pickup')
  expect(r.pickup).toBeUndefined()
})

test('a pickup address that does not mention Z-BOX is kept whole with kind unknown', async () => {
  const r = ok(await fetchOne(fixture('ready-for-pickup.json').replace('Z-BOX Bratislava, ', '')))
  expect(r.pickup).toEqual({ kind: 'unknown', name: 'Obchodna 12, 811 06 Bratislava' })
})

test('statusRaw falls back to the packetStatusId when packetStatus is absent', async () => {
  const r = ok(await fetchOne(fixture('delivered.json').replace(/"packetStatus":"[^"]*",/, '')))
  expect(r.status).toBe('delivered')
  expect(r.statusRaw).toBe('3')
})

test('event times are parsed as Europe/Prague', async () => {
  const r = ok(await fetchOne(fixture('delivered.json')))
  const first = r.events[0]!
  expect(first.occurredAtRaw).toBe('2026-10-17 16:20:00')
  expect(first.occurredAtTz).toBe('Europe/Prague')
  // CEST, UTC+2
  expect(first.occurredAt.toISOString()).toBe('2026-10-17T14:20:00.000Z')
})

test('events are sorted oldest-first regardless of response order', async () => {
  const r = ok(await fetchOne(fixture('unordered-events.json')))
  expect(r.events.map(e => e.description)).toEqual(['Oldest event.', 'Middle event.', 'Newest event.'])
  const times = r.events.map(e => e.occurredAt.getTime())
  expect(times).toEqual([...times].sort((a, b) => a - b))
})

test('the newest event carries the parcel status and older events are unknown, since entries have no code', async () => {
  const r = ok(await fetchOne(fixture('unordered-events.json')))
  expect(r.status).toBe('in_transit')
  expect(r.events.map(e => e.status)).toEqual(['unknown', 'unknown', 'in_transit'])
  expect(r.events.every(e => e.code === undefined && e.location === undefined)).toBe(true)
})

test('no retainedTill is produced, since Packeta supplies no deadline', async () => {
  const r = ok(await fetchOne(fixture('ready-for-pickup.json')))
  expect(r.status).toBe('ready_for_pickup')
  expect(r.retainedTill).toBeUndefined()
})

test('a parcel with a status but no events yet is ok with an empty timeline', async () => {
  const r = ok(await fetchOne('{"item":{"packetStatusId":"997","packetStatus":"To be processed"}}'))
  expect(r.status).toBe('pre_transit')
  expect(r.events).toEqual([])
})

test('non-JSON, truncated and item-less 200 bodies yield transport, never a throw', async () => {
  for (const body of ['<html>maintenance</html>', fixture('delivered.json').slice(0, 40), '{}', '{"item":null}']) {
    expect(await fetchOne(body)).toEqual({ ok: false, number: 'Z1234567890', reason: 'transport' })
  }
})

test('an unparseable event time yields transport rather than rejecting', async () => {
  const r = await fetchOne(fixture('delivered.json').replace('2026-10-17 16:20:00', 'yesterday'))
  expect(r).toEqual({ ok: false, number: 'Z1234567890', reason: 'transport' })
})

test('a 5xx is a transport failure', async () => {
  expect(await fetchOne('{}', 503)).toEqual({ ok: false, number: 'Z1234567890', reason: 'transport' })
})

test('matches() accepts Z1234567890 and rejects a bare 10-digit number', () => {
  expect(packetaAdapter.matches('Z1234567890')).toBe(true)
  expect(packetaAdapter.matches('1234567890')).toBe(false)
  expect(packetaAdapter.matches('Z123456789')).toBe(false)
  expect(packetaAdapter.matches('Z12345678901')).toBe(false)
})

test('declares batchSize 1 and no postal code requirement', () => {
  expect(packetaAdapter.id).toBe('packeta')
  expect(packetaAdapter.batchSize).toBe(1)
  expect(packetaAdapter.needsPostalCode).toBe(false)
})
