import { readFileSync } from 'node:fs'
import { test, expect } from 'vitest'
import { postaAdapter } from '../../src/carriers/posta.js'
import type { FetchResult, HttpClient } from '../../src/core/types.js'

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/posta/${name}`, import.meta.url), 'utf8')

/** Stub HttpClient serving one canned body; records every URL it was asked for. */
function stubHttp(body: string, status = 200) {
  const calls: string[] = []
  const http: HttpClient = async url => {
    calls.push(url)
    return {
      status,
      headers: {},
      text: async () => body,
      json: async <T>() => JSON.parse(body) as T,
    }
  }
  return { http, calls }
}

async function fetchOne(body: string, number = 'RA123456785SK') {
  const { http } = stubHttp(body)
  const [r] = await postaAdapter.fetch([{ number }], http)
  return r as FetchResult
}

function ok(r: FetchResult) {
  if (!r.ok) throw new Error(`expected an ok result, got ${r.reason}`)
  return r
}

test('batches all numbers into a single request with q comma-separated', async () => {
  const { http, calls } = stubHttp(fixture('batch-mixed.json'))
  await postaAdapter.fetch([{ number: 'RA123456785SK' }, { number: 'RA987654326SK' }], http)
  expect(calls).toHaveLength(1)
  const url = new URL(calls[0]!)
  expect(url.origin + url.pathname).toBe('https://api.posta.sk/tracking')
  expect(url.searchParams.get('q')).toBe('RA123456785SK,RA987654326SK')
  expect(url.searchParams.get('l')).toBe('sk')
  expect(url.searchParams.get('p')).toBe('1')
})

test('matches results by their own number field, not array position', async () => {
  // batch-mixed.json returns the invalid entry first and the ok entry second.
  const { http } = stubHttp(fixture('batch-mixed.json'))
  const results = await postaAdapter.fetch([{ number: 'RA987654326SK' }, { number: '12345' }], http)
  expect(results.map(r => r.number)).toEqual(['RA987654326SK', '12345'])
  const [first, second] = results as [FetchResult, FetchResult]
  expect(ok(first).status).toBe('in_transit')
  expect(second).toEqual({ ok: false, number: '12345', reason: 'not_found' })
})

test('status ok with empty events maps to pre_transit, not not_found', async () => {
  const r = ok(await fetchOne(fixture('ok-empty.json')))
  expect(r.status).toBe('pre_transit')
  expect(r.events).toEqual([])
})

test('invalid_format maps to a not_found result, not a gated one', async () => {
  const r = await fetchOne(fixture('invalid-format.json'), '12345')
  expect(r).toEqual({ ok: false, number: '12345', reason: 'not_found' })
})

test('delivered fixture maps stateCode delivered to delivered and parses three events', async () => {
  const r = ok(await fetchOne(fixture('delivered.json')))
  expect(r.status).toBe('delivered')
  expect(r.events).toHaveLength(3)
  // fixture lists newest first; the adapter must return oldest first
  expect(r.events.map(e => e.status)).toEqual(['pre_transit', 'in_transit', 'delivered'])
  const times = r.events.map(e => e.occurredAt.getTime())
  expect(times).toEqual([...times].sort((a, b) => a - b))
})

test('event timestamps are interpreted as Europe/Bratislava', async () => {
  const r = ok(await fetchOne(fixture('delivered.json')))
  const first = r.events[0]!
  expect(first.occurredAtRaw).toBe('2016-07-13T15:08:08')
  expect(first.occurredAtTz).toBe('Europe/Bratislava')
  expect(first.occurredAt.toISOString()).toBe('2016-07-13T13:08:08.000Z')
})

test('detailCode ANZ under stateCode transit maps to failed_attempt', async () => {
  const r = ok(await fetchOne(fixture('failed.json')))
  expect(r.status).toBe('failed_attempt')
  expect(r.statusRaw).toBe('transit')
  expect(r.statusDetail).toBe('ANZ')
  expect(r.events.map(e => e.status)).toEqual(['in_transit', 'failed_attempt'])
})

test('detailCode ZSTR maps to problem', async () => {
  const r = ok(await fetchOne(fixture('failed.json').replace('ANZ', 'ZSTR')))
  expect(r.status).toBe('problem')
})

test('an unmapped detailCode leaves the stateCode mapping intact and does not throw', async () => {
  const r = ok(await fetchOne(fixture('failed.json').replace('ANZ', 'NOPE-123')))
  expect(r.status).toBe('in_transit')
  expect(r.events.at(-1)?.code).toBe('NOPE-123')
})

test('held fixture extracts the post office as a pickup point and retainedTill as the deadline', async () => {
  const r = ok(await fetchOne(fixture('held.json')))
  expect(r.status).toBe('ready_for_pickup')
  expect(r.pickup?.kind).toBe('post_office')
  expect(r.pickup).toMatchObject({ name: 'Posta Bratislava 1', city: 'Bratislava', postalCode: '81000' })
  expect(r.retainedTill).toBeInstanceOf(Date)
  expect(r.retainedTill?.toISOString()).toBe('2016-07-21T22:00:00.000Z') // 2016-07-22 00:00 Bratislava (CEST)
})

test('a 200 with a truncated body yields a transport-or-parse failure, never a throw', async () => {
  const r = await fetchOne(fixture('truncated.txt'))
  expect(r).toEqual({ ok: false, number: 'RA123456785SK', reason: 'transport' })
})

test('matches() accepts RA123456785SK and rejects a bare 10-digit number', () => {
  expect(postaAdapter.matches('RA123456785SK')).toBe(true)
  expect(postaAdapter.matches('1234567890')).toBe(false)
  expect(postaAdapter.matches('RA123456786SK')).toBe(false) // wrong check digit (typo)
})

test('matches() rejects a valid S10 number with a non-SK suffix', () => {
  expect(postaAdapter.matches('RA123456785CZ')).toBe(false)
})
