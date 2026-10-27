import { expect, test } from 'vitest'
import {
  ERROR_MAX_WAIT_MS, geocodeQuery, NOMINATIM_HOST, NOT_FOUND_RETRY_MS, lookupPoint, retryDue, USER_AGENT,
} from '../src/core/geocode.js'
import { getGeocode, recordGeocode } from '../src/db/geocode-cache.js'
import { memDb, NOW } from './poll-helpers.js'
import type { HttpClient } from '../src/core/types.js'

const HOUR = 3_600_000
const at = (ms: number) => new Date(NOW.getTime() + ms)

// --- the cache key ---------------------------------------------------------------------------------

test('geocodeQuery: street, postcode and city, lower-cased so one address is one cache entry', () => {
  expect(geocodeQuery({ kind: 'post_office', name: 'Pošta Bratislava 1', street: 'Nám. SNP 35', city: 'Bratislava', postalCode: '81101' }))
    .toBe('nám. snp 35, 81101 bratislava')
})

test('geocodeQuery: two spellings of the same address normalise to the same key', () => {
  const a = geocodeQuery({ kind: 'zbox', street: 'Hlavna  6', city: 'Bratislava', postalCode: '811 09' })
  const b = geocodeQuery({ kind: 'zbox', street: ' HLAVNA 6 ', city: ' bratislava', postalCode: '811 09 ' })
  expect(a).toBe(b)
  expect(a).toBe('hlavna 6, 811 09 bratislava')
})

test('geocodeQuery: a city on its own is usable; a street or a name on its own is not', () => {
  expect(geocodeQuery({ kind: 'post_office', city: 'Žilina' })).toBe('žilina')
  expect(geocodeQuery({ kind: 'post_office', street: 'Hlavna 6' })).toBeUndefined()
  // Every real Packeta Z-BOX looks like this: a name that embeds a town, and nothing else.
  expect(geocodeQuery({ kind: 'zbox', name: 'Z-BOX Bratislava, Hlavna 6' })).toBeUndefined()
  expect(geocodeQuery({ kind: 'zbox', name: 'Z-BOX', postalCode: '81109' })).toBeUndefined()
  expect(geocodeQuery(undefined)).toBeUndefined()
  expect(geocodeQuery({ kind: 'unknown', city: '   ' })).toBeUndefined()
})

// --- the cache table -------------------------------------------------------------------------------

test('recordGeocode stores a found point and getGeocode reads it back', () => {
  const db = memDb()
  recordGeocode(db, 'hlavna 6, bratislava', { outcome: 'found', lat: 48.1448, lon: 17.1192 }, NOW)
  expect(getGeocode(db, 'hlavna 6, bratislava')).toEqual({
    query: 'hlavna 6, bratislava', outcome: 'found', lat: 48.1448, lon: 17.1192, attempts: 0, attemptedAt: NOW,
  })
  expect(getGeocode(db, 'somewhere else')).toBeUndefined()
})

test('recordGeocode counts consecutive failures and clears the count once the address is found', () => {
  const db = memDb()
  const q = 'nowhere 1, nowhere'
  recordGeocode(db, q, { outcome: 'error', detail: 'timeout' }, NOW)
  expect(getGeocode(db, q)).toMatchObject({ outcome: 'error', attempts: 1, detail: 'timeout' })
  recordGeocode(db, q, { outcome: 'error', detail: 'timeout' }, at(HOUR))
  expect(getGeocode(db, q)).toMatchObject({ outcome: 'error', attempts: 2, attemptedAt: at(HOUR) })
  recordGeocode(db, q, { outcome: 'not_found' }, at(2 * HOUR))
  expect(getGeocode(db, q)).toMatchObject({ outcome: 'not_found', attempts: 3 })
  recordGeocode(db, q, { outcome: 'found', lat: 1, lon: 2 }, at(3 * HOUR))
  expect(getGeocode(db, q)).toMatchObject({ outcome: 'found', attempts: 0, lat: 1, lon: 2 })
  expect(getGeocode(db, q)!.detail).toBeUndefined()
})

// --- the back-off ----------------------------------------------------------------------------------

test('retryDue: a found address is never looked up again', () => {
  const db = memDb()
  recordGeocode(db, 'q', { outcome: 'found', lat: 1, lon: 2 }, NOW)
  const row = getGeocode(db, 'q')!
  expect(retryDue(row, NOW)).toBe(false)
  expect(retryDue(row, at(400 * 24 * HOUR))).toBe(false)
})

test('retryDue: a not-found is treated as near-permanent, not retried for a month', () => {
  const db = memDb()
  recordGeocode(db, 'q', { outcome: 'not_found' }, NOW)
  const row = getGeocode(db, 'q')!
  expect(retryDue(row, NOW)).toBe(false)
  expect(retryDue(row, at(HOUR))).toBe(false)
  expect(retryDue(row, at(NOT_FOUND_RETRY_MS - 1))).toBe(false)
  expect(retryDue(row, at(NOT_FOUND_RETRY_MS))).toBe(true)
})

test('retryDue: a transport error doubles its wait with every failure, up to the cap', () => {
  const db = memDb()
  recordGeocode(db, 'q', { outcome: 'error', detail: 'boom' }, NOW)
  expect(retryDue(getGeocode(db, 'q')!, at(HOUR - 1))).toBe(false)
  expect(retryDue(getGeocode(db, 'q')!, at(HOUR))).toBe(true)

  recordGeocode(db, 'q', { outcome: 'error', detail: 'boom' }, NOW)   // second consecutive failure
  expect(retryDue(getGeocode(db, 'q')!, at(2 * HOUR - 1))).toBe(false)
  expect(retryDue(getGeocode(db, 'q')!, at(2 * HOUR))).toBe(true)

  for (let i = 0; i < 20; i++) recordGeocode(db, 'q', { outcome: 'error' }, NOW)
  expect(retryDue(getGeocode(db, 'q')!, at(ERROR_MAX_WAIT_MS - 1))).toBe(false)
  expect(retryDue(getGeocode(db, 'q')!, at(ERROR_MAX_WAIT_MS))).toBe(true)
})

// --- the Nominatim call ----------------------------------------------------------------------------

interface Recorded { url: string; init?: RequestInit }

function stubHttp(reply: (url: string) => { status: number; body: string } | Error): { http: HttpClient; calls: Recorded[] } {
  const calls: Recorded[] = []
  return {
    calls,
    http: async (url, init) => {
      calls.push({ url, init })
      const r = reply(url)
      if (r instanceof Error) throw r
      return { status: r.status, headers: {}, text: async () => r.body, json: async <T>() => JSON.parse(r.body) as T }
    },
  }
}

const found = JSON.stringify([{ lat: '48.1448231', lon: '17.1192070', display_name: 'Hlavna 6' }])

test('lookupPoint sends one search to Nominatim, identifying this application and asking for one result', async () => {
  const { http, calls } = stubHttp(() => ({ status: 200, body: found }))
  const r = await lookupPoint(http, 'hlavna 6, 811 09 bratislava')
  expect(r).toEqual({ outcome: 'found', lat: 48.1448231, lon: 17.119207 })
  expect(calls).toHaveLength(1)
  const url = new URL(calls[0]!.url)
  expect(url.host).toBe(NOMINATIM_HOST)
  expect(url.searchParams.get('q')).toBe('hlavna 6, 811 09 bratislava')
  expect(url.searchParams.get('limit')).toBe('1')
  expect(url.searchParams.get('format')).toBe('jsonv2')
  const headers = calls[0]!.init?.headers as Record<string, string>
  expect(headers['User-Agent']).toBe(USER_AGENT)
  expect(USER_AGENT).toMatch(/parcels/i)
})

test('lookupPoint reports an empty result list as not_found, never as an error', async () => {
  const { http } = stubHttp(() => ({ status: 200, body: '[]' }))
  expect(await lookupPoint(http, 'nowhere')).toEqual({ outcome: 'not_found' })
})

test('lookupPoint turns a bad status, unparseable body or thrown request into an error outcome', async () => {
  for (const reply of [
    () => ({ status: 429, body: 'slow down' }),
    () => ({ status: 500, body: '' }),
    () => ({ status: 200, body: 'not json at all' }),
    () => ({ status: 200, body: '{"not":"an array"}' }),
    () => ({ status: 200, body: '[{"lat":"abc","lon":"17.1"}]' }),
    () => ({ status: 200, body: '[{"lat":"91","lon":"17.1"}]' }),
    () => new Error('connection refused'),
  ]) {
    const { http } = stubHttp(reply)
    const r = await lookupPoint(http, 'q')
    expect(r.outcome).toBe('error')
    expect(r.detail).toBeTruthy()
  }
})
