import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { dpdAdapter, getAccessToken, createTokenCache, clearDpdCaches, setDpdAuthStore, authStorePathFor } from '../../src/carriers/dpd.js'
import { captureBodies } from '../../src/core/http.js'
import type { FetchResult, HttpClient } from '../../src/core/types.js'

// the credential and token caches are module-level, so every test starts without them
beforeEach(() => { setDpdAuthStore(undefined); clearDpdCaches() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setDpdAuthStore(undefined) })

const fixtureText = (name: string) =>
  readFileSync(new URL(`../fixtures/dpd/${name}`, import.meta.url), 'utf8')
const fixtureJson = (name: string) => JSON.parse(fixtureText(name)) as Record<string, any>   // eslint-disable-line @typescript-eslint/no-explicit-any

const NUMBER = '01234567890123'
const INSTALLATIONS = 'https://firebaseinstallations.googleapis.com/v1/projects/consignee-portal/installations'
const REMOTE_CONFIG = 'https://firebaseremoteconfig.googleapis.com/v1/projects/959401347543/namespaces/firebase:fetch'
const OAUTH = 'https://www.dpdgroup.com/concept/webservice/oauth/token?grant_type=client_credentials'
const OAUTH_PATH = 'https://www.dpdgroup.com/concept/webservice/oauth/token'
const DETAILS_BASE = 'https://www.dpdgroup.com/concept/webservice/v10/parcels/details/'
const BASIC_TOKEN = fixtureJson('firebase-config.json').entries.basic_dpd_token as string

interface Canned { status?: number; body: string }
interface Call { url: string; init?: RequestInit }

/** Answers each of the four resources; `details` is a list consumed in order, the last entry repeating. */
interface Script {
  installations?: Canned
  config?: Canned | Canned[]
  oauth?: Canned | Canned[]
  details: Canned | Canned[]
}

const json = (body: unknown, status = 200): Canned => ({ status, body: JSON.stringify(body) })
const file = (name: string, status = 200): Canned => ({ status, body: fixtureText(name) })

const happy = (details: Canned | Canned[]): Script => ({
  installations: file('firebase-installations.json'),
  config: file('firebase-config.json'),
  oauth: file('oauth-token.json'),
  details,
})

function pick<T>(list: T | T[], index: number): T {
  return Array.isArray(list) ? list[Math.min(index, list.length - 1)]! : list
}

/**
 * Stub HttpClient answering per resource, recording every request in order. Each call to `client()`
 * returns a NEW function object over the shared script and call log, which is how the orchestrator
 * hands the adapter a freshly wrapped client for every chunk.
 */
function stub(script: Script) {
  const calls: Call[] = []
  const seen = { config: 0, oauth: 0, details: 0 }
  const client = (): HttpClient => async (url, init) => {
    calls.push({ url, init })
    let canned: Canned | undefined
    if (url === INSTALLATIONS) canned = script.installations
    else if (url === REMOTE_CONFIG) canned = script.config === undefined ? undefined : pick(script.config, seen.config++)
    else if (url === OAUTH) canned = script.oauth === undefined ? undefined : pick(script.oauth, seen.oauth++)
    else if (url.startsWith(DETAILS_BASE)) canned = pick(script.details, seen.details++)
    if (!canned) throw new Error(`unexpected request to ${url}`)
    return {
      status: canned.status ?? 200,
      headers: {},
      text: async () => canned.body,
      json: async <T>() => JSON.parse(canned.body) as T,
    }
  }
  const urls = () => calls.map(c => c.url.replace(DETAILS_BASE, 'details/').replace(/\?.*$/, ''))
  const detailsCalls = () => calls.filter(c => c.url.startsWith(DETAILS_BASE))
  return { client, calls, urls, detailsCalls }
}

async function lookup(script: Script, input: { number?: string; postalCode?: string } = {}) {
  const s = stub(script)
  const [r] = await dpdAdapter.fetch([{ number: NUMBER, ...input }], s.client())
  return { r: r as FetchResult, ...s }
}

function ok(r: FetchResult) {
  if (!r.ok) throw new Error(`expected an ok result, got ${r.reason}`)
  return r
}

const query = (c: Call) => new URL(c.url).searchParams
const headersOf = (c: Call) => c.init?.headers as Record<string, string>

test('performs the firebase then oauth then details chain on a cold cache', async () => {
  const { r, calls, urls } = await lookup(happy(file('prealert.json')))
  expect(ok(r).status).toBe('pre_transit')
  expect(urls()).toEqual([INSTALLATIONS, REMOTE_CONFIG, OAUTH_PATH, `details/${NUMBER}`])

  const [install, config, oauth, details] = calls as [Call, Call, Call, Call]
  const firebase = {
    'X-Goog-Api-Key': 'AIzaSyDHMkUNUyUwFrQzKJhdC_J-L7QEwNUzwrc',
    'X-Android-Package': 'com.dpdgroup.chatbot.lemny.prod',
    'X-Android-Cert': '3872ACD98DE975F69C68CAF5119A5A1B2024B873',
    'Content-Type': 'application/json',
  }
  expect(install.init?.method).toBe('POST')
  expect(headersOf(install)).toMatchObject(firebase)
  const installBody = JSON.parse(install.init?.body as string)
  expect(installBody.appId).toBe('1:959401347543:android:8d1a84133332291109e392')
  expect(installBody.fid).toMatch(/^[A-Za-z0-9_-]{22}$/)

  expect(config.init?.method).toBe('POST')
  expect(headersOf(config)).toMatchObject({
    ...firebase, 'X-Goog-Firebase-Installations-Auth': 'FIXTURE-installations-auth-token',
  })
  expect(JSON.parse(config.init?.body as string)).toEqual({
    appId: '1:959401347543:android:8d1a84133332291109e392',
    appInstanceId: 'cFIXTUREfidFIXTURE0',
    appInstanceIdToken: 'FIXTURE-installations-auth-token',
    languageCode: 'sk-SK', countryCode: 'SK', platformVersion: '36', appVersion: '3.79.14',
    packageName: 'com.dpdgroup.chatbot.lemny.prod', sdkVersion: '22.1.2', analyticsUserProperties: {},
  })

  // the Basic credential sent to OAuth is the one Remote Config returned, never a literal in the source
  expect(oauth.init?.method).toBe('POST')
  expect(headersOf(oauth)).toMatchObject({
    Authorization: `Basic ${BASIC_TOKEN}`, 'User-Agent': 'myDPD/3.79.14 (Android)',
    Accept: 'application/json', 'Content-Type': 'application/json',
  })

  expect(headersOf(details)).toMatchObject({
    Authorization: 'Bearer FIXTURE-access-token-1', 'User-Agent': 'myDPD/3.79.14 (Android)',
    Accept: 'application/json', 'Content-Type': 'application/json',
  })
  expect(query(details).get('parcelType')).toBe('INCOMING')
  expect(query(details).get('businessUnit')).toBe('DPD-SK')
  expect(query(details).get('lang')).toBe('sk')
})

test('reuses a cached token and skips firebase and oauth entirely', async () => {
  const s = stub(happy(file('prealert.json')))
  // a distinct wrapper per lookup, as the orchestrator produces per chunk
  await dpdAdapter.fetch([{ number: NUMBER }], s.client())
  s.calls.length = 0
  const [r] = await dpdAdapter.fetch([{ number: NUMBER }], s.client())
  expect(ok(r as FetchResult).status).toBe('pre_transit')
  expect(s.urls()).toEqual([`details/${NUMBER}`])
})

test('the chain runs once across many lookups through distinct client wrappers', async () => {
  const s = stub(happy(file('prealert.json')))
  for (let i = 0; i < 3; i++) await dpdAdapter.fetch([{ number: NUMBER }], s.client())
  expect(s.urls().filter(u => u === INSTALLATIONS)).toHaveLength(1)
  expect(s.urls().filter(u => u === OAUTH_PATH)).toHaveLength(1)
  expect(s.detailsCalls()).toHaveLength(3)
})

test('concurrent lookups share one chain', async () => {
  const s = stub(happy(file('prealert.json')))
  await Promise.all([1, 2, 3].map(() => dpdAdapter.fetch([{ number: NUMBER }], s.client())))
  expect(s.urls().filter(u => u === INSTALLATIONS)).toHaveLength(1)
  expect(s.detailsCalls()).toHaveLength(3)
})

test('refetches the chain when the cached token is expired', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-26T08:00:00Z'))
  const s = stub({ ...happy(file('prealert.json')), oauth: [file('oauth-token.json'), json({ ...fixtureJson('oauth-token.json'), access_token: 'FIXTURE-access-token-2' })] })
  await dpdAdapter.fetch([{ number: NUMBER }], s.client())

  // expires_in is 18986s (5h 16m): an hour before it is still cached
  vi.setSystemTime(new Date('2026-10-26T12:00:00Z'))
  await dpdAdapter.fetch([{ number: NUMBER }], s.client())
  expect(s.urls().filter(u => u === INSTALLATIONS)).toHaveLength(1)

  // past it, the token is fetched again; the Basic credential is still cached, so only OAuth reruns
  vi.setSystemTime(new Date('2026-10-26T13:20:00Z'))
  await dpdAdapter.fetch([{ number: NUMBER }], s.client())
  expect(s.urls().filter(u => u === OAUTH_PATH)).toHaveLength(2)
  expect(headersOf(s.detailsCalls().at(-1)!).Authorization).toBe('Bearer FIXTURE-access-token-2')
})

test('refetches the chain on a 401 and retries the details call once', async () => {
  const s = stub({
    ...happy([file('unauthorized.json', 401), file('prealert.json')]),
    oauth: [file('oauth-token.json'), json({ ...fixtureJson('oauth-token.json'), access_token: 'FIXTURE-access-token-2' })],
  })
  const [r] = await dpdAdapter.fetch([{ number: NUMBER }], s.client())
  expect(ok(r as FetchResult).status).toBe('pre_transit')
  expect(s.urls()).toEqual([
    INSTALLATIONS, REMOTE_CONFIG, OAUTH_PATH, `details/${NUMBER}`,   // cold chain, details rejected
    INSTALLATIONS, REMOTE_CONFIG, OAUTH_PATH, `details/${NUMBER}`,   // chain again, details retried
  ])
  expect(headersOf(s.detailsCalls()[0]!).Authorization).toBe('Bearer FIXTURE-access-token-1')
  expect(headersOf(s.detailsCalls()[1]!).Authorization).toBe('Bearer FIXTURE-access-token-2')
})

test('a 401 that survives the fresh chain is gated, and is retried only once', async () => {
  const { r, detailsCalls } = await lookup(happy(file('unauthorized.json', 401)))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
  expect(detailsCalls()).toHaveLength(2)
})

test('the details call is a POST with an empty body', async () => {
  const { detailsCalls } = await lookup(happy(file('prealert.json')))
  const init = detailsCalls()[0]!.init
  expect(init?.method).toBe('POST')
  expect(init?.body ?? '').toBe('')
})

test('sends dataForVerification when a postal code is available', async () => {
  const { r, detailsCalls } = await lookup(happy(file('delivered-verified.json')), { postalCode: '01001' })
  ok(r)
  expect(detailsCalls()).toHaveLength(1)
  const q = query(detailsCalls()[0]!)
  expect(q.get('dataForVerification')).toBe('01001')
  expect(q.get('continueWithoutVerification')).toBe('false')
})

test('without a postal code it degrades to continueWithoutVerification instead of needs_postcode', async () => {
  const { r, detailsCalls } = await lookup(happy(file('prealert.json')))
  expect(ok(r).status).toBe('pre_transit')   // never { reason: 'needs_postcode' }: that would stop polling the parcel
  const q = query(detailsCalls()[0]!)
  expect(q.get('continueWithoutVerification')).toBe('true')
  expect(q.has('dataForVerification')).toBe(false)
})

test('a 400 PROVIDE_ZIP_CODE retries once without the postcode', async () => {
  const { r, detailsCalls } = await lookup(
    happy([file('provide-zip.json', 400), file('prealert.json')]), { postalCode: '99999' },
  )
  expect(ok(r).status).toBe('pre_transit')   // degraded, not missing and not needs_postcode
  expect(detailsCalls()).toHaveLength(2)
  expect(query(detailsCalls()[0]!).get('dataForVerification')).toBe('99999')
  const retry = query(detailsCalls()[1]!)
  expect(retry.has('dataForVerification')).toBe(false)
  expect(retry.get('continueWithoutVerification')).toBe('true')
})

test('PROVIDE_ZIP_CODE on a call that already had no postcode is transport, never a loop or needs_postcode', async () => {
  const { r, detailsCalls } = await lookup(happy(file('provide-zip.json', 400)))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  expect(detailsCalls()).toHaveLength(1)
})

test('a 400 PARCEL_NOT_FOUND maps to not_found', async () => {
  const { r, detailsCalls } = await lookup(happy(file('not-found.json', 400)), { postalCode: '01001' })
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'not_found' })
  expect(detailsCalls()).toHaveLength(1)   // not retried without the postcode: that is only for PROVIDE_ZIP_CODE
})

test('a 404 carrying PARCEL_NOT_FOUND also maps to not_found', async () => {
  const { r } = await lookup(happy(file('not-found.json', 404)))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'not_found' })
})

test('a bare 404 is transport, not a missing parcel: a gateway or a moved path must not look like not_found', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const body of ['', '<html>404 Not Found</html>', '{"message":"no such route"}']) {
    expect((await lookup(happy({ status: 404, body }))).r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  }
})

test('the three 400s are told apart by exceptionType, so any other 400 is transport', async () => {
  const other = json({ error: 'x', message: 'boom', exceptionType: 'SOMETHING_ELSE' }, 400)
  expect((await lookup(happy(other))).r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  expect((await lookup(happy({ status: 400, body: '<html>bad gateway</html>' }))).r)
    .toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  expect((await lookup(happy(json({}, 400)))).r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
})

test('a 503 maps to transport, not not_found', async () => {
  const { r } = await lookup(happy({ status: 503, body: 'Service Unavailable' }))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
})

test('a 403 from the API path (Cloudflare challenge) is gated', async () => {
  const { r } = await lookup(happy({ status: 403, body: '<html>Just a moment...</html>' }))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
})

test('a non-JSON, truncated or unrecognised 200 body is transport, never a throw', async () => {
  const bodies = ['<html>maintenance</html>', '{"parcelNumber":"0123456789', '{}', '{"status":"ORDER_CREATED"}']
  for (const body of bodies) {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await lookup(happy({ body }))).r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  }
})

/** `prealert.json` with its top-level and only history milestone replaced. */
function withMilestone(description: string) {
  const body = fixtureJson('prealert.json')
  body.status.description = description
  body.parcelHistory[0].description = description
  return json(body)
}
const statusOf = async (description: string) => ok((await lookup(happy(withMilestone(description)))).r).status

test('UNSUCCESSFUL_DELIVERY_ATTEMPT maps to failed_attempt and keeps the parcel active', async () => {
  const r = ok((await lookup(happy(withMilestone('UNSUCCESSFUL_DELIVERY_ATTEMPT')))).r)
  expect(r.status).toBe('failed_attempt')   // never 'returned'
  expect(r.statusRaw).toBe('UNSUCCESSFUL_DELIVERY_ATTEMPT')
  expect(r.events.map(e => e.status)).toEqual(['failed_attempt'])
})

test('AVAILABLE_FOR_COLLECTION maps to ready_for_pickup', async () => {
  expect(await statusOf('AVAILABLE_FOR_COLLECTION')).toBe('ready_for_pickup')
})

test('the other milestones map to their canonical statuses', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await statusOf('ORDER_CREATED')).toBe('pre_transit')
  expect(await statusOf('PARCEL_HANDED')).toBe('pre_transit')   // genuine acceptance, nothing later yet
  expect(await statusOf('IN_TRANSIT')).toBe('in_transit')
  expect(await statusOf('AT_DELIVERY_CENTER')).toBe('in_transit')
  expect(await statusOf('PARCEL_OUT_FOR_DELIVERY')).toBe('out_for_delivery')
  expect(await statusOf('RETURN_TO_SENDER')).toBe('returning')
  expect(await statusOf('DELIVERED')).toBe('delivered')
  expect(await statusOf('OTHER')).toBe('unknown')
  expect(await statusOf('SOMETHING_NEW')).toBe('unknown')
})

test('PARCEL_HANDED appearing after later milestones is treated as in_transit, not acceptance', async () => {
  // another country's DPD unit takes over: PARCEL_HANDED is re-dated to after the parcel was already moving
  const body = fixtureJson('delivered-verified.json')
  delete body.parcelEvents
  body.parcelHistory = [
    { status: 1, description: 'PARCEL_HANDED', eventDateAndTime: '2026-10-22T08:00:00', eventDateAndTimeZoneId: 'Europe/Bratislava', city: null },
    { status: 2, description: 'IN_TRANSIT', eventDateAndTime: '2026-10-21T22:41:09', eventDateAndTimeZoneId: 'Europe/Bratislava', city: null },
    { status: 0, description: 'ORDER_CREATED', eventDateAndTime: '2026-10-19T09:00:00', eventDateAndTimeZoneId: 'Europe/Bratislava', city: null },
  ]
  body.status = { ...body.parcelHistory[0] }
  const res = ok((await lookup(happy(json(body)))).r)
  expect(res.status).toBe('in_transit')
  expect(res.events.map(e => [e.code, e.status])).toEqual([
    ['ORDER_CREATED', 'pre_transit'], ['IN_TRANSIT', 'in_transit'], ['PARCEL_HANDED', 'in_transit'],
  ])

  // and the same milestone dated before any movement is a genuine acceptance
  body.parcelHistory[0].eventDateAndTime = '2026-10-20T08:00:00'
  body.status = { ...body.parcelHistory[0] }
  const early = ok((await lookup(happy(json(body)))).r)
  expect(early.events.map(e => [e.code, e.status])).toEqual([
    ['ORDER_CREATED', 'pre_transit'], ['PARCEL_HANDED', 'pre_transit'], ['IN_TRANSIT', 'in_transit'],
  ])
})

test('notice-only codes SPE, MSDLO, MIDLI and ENA never set the parcel status', async () => {
  const notices = ['SPE', 'MSDLO', 'MSDLX', 'MIDLI', 'MIA', 'MII', 'ENA']
  const body = fixtureJson('delivered-verified.json')
  // newest scans are all notices, and the milestone summary is the catch-all OTHER, so the only
  // thing that could set the status is a notice code leaking through
  body.status.description = 'OTHER'
  body.parcelHistory = []
  body.parcelEvents = [
    ...notices.map((code, i) => ({
      time: `0${i}:00:00`, date: '2026-10-25', eventType: code, translation: `notice ${code}`,
      pudoId: null, city: null, podUrl: null,
    })),
    ...body.parcelEvents,
  ]
  const res = ok((await lookup(happy(json(body)), { postalCode: '01001' })).r)
  expect(res.status).toBe('delivered')   // from the newest real scan (DEYY), not from SPE/MSDLO/MIDLI/ENA
  const noticeEvents = res.events.filter(e => e.occurredAtRaw.startsWith('2026-10-25'))
  expect(noticeEvents.map(e => e.code)).toEqual(notices)
  // a notice carries the status already in force instead of claiming a stage of its own
  expect(noticeEvents.every(e => e.status === 'delivered')).toBe(true)
  // including the one already in the fixture, mid-journey: it carries 'in_transit', not a stage of its own
  expect(res.events.find(e => e.code === 'SPE' && e.occurredAtRaw.startsWith('2026-10-23'))?.status).toBe('in_transit')

  // a lone notice with nothing before it has no status to carry
  const lone = fixtureJson('prealert.json')
  lone.status.description = 'OTHER'
  lone.parcelHistory = []
  lone.parcelEvents = [{ time: '09:00:00', date: '2026-10-25', eventType: 'ENA', translation: 'n', pudoId: null, city: null }]
  const loneRes = ok((await lookup(happy(json(lone)), { postalCode: '01001' })).r)
  expect(loneRes.status).toBe('unknown')
  expect(loneRes.events[0]!.status).toBe('unknown')
})

test('scan codes map to canonical statuses and an unlisted code is unknown', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const body = fixtureJson('prealert.json')
  body.status.description = 'OTHER'
  body.parcelHistory = []
  const codes = ['CNP', 'PKY', 'LHI', 'DLI', 'DLO', 'DEHD', 'DEX', 'DEY', 'ZZZ']
  body.parcelEvents = codes.map((eventType, i) => ({
    time: '10:00:00', date: `2026-10-${10 + i}`, eventType, translation: eventType, pudoId: null, city: null,
  }))
  const res = ok((await lookup(happy(json(body)), { postalCode: '01001' })).r)
  expect(res.events.map(e => e.status)).toEqual([
    'pre_transit', 'pre_transit', 'in_transit', 'in_transit', 'out_for_delivery',
    'ready_for_pickup', 'failed_attempt', 'delivered', 'unknown',
  ])
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('ZZZ'))
})

test('ORI and SPL name no stage: they carry the status in force, so one before acceptance is not in_transit', async () => {
  const body = fixtureJson('prealert.json')
  body.status.description = 'OTHER'
  body.parcelHistory = []
  const codes = ['ORI', 'CNP', 'SPL', 'LHI', 'ORI']
  body.parcelEvents = codes.map((eventType, i) => ({
    time: '10:00:00', date: `2026-10-${10 + i}`, eventType, translation: eventType, pudoId: null, city: null,
  }))
  const res = ok((await lookup(happy(json(body)), { postalCode: '01001' })).r)
  expect(res.events.map(e => [e.code, e.status])).toEqual([
    ['ORI', 'unknown'], ['CNP', 'pre_transit'], ['SPL', 'pre_transit'], ['LHI', 'in_transit'], ['ORI', 'in_transit'],
  ])
})

test('scans sharing a timestamp are ordered deterministically: DPD lists newest first, so a tie is flipped', async () => {
  const body = fixtureJson('prealert.json')
  body.status.description = 'OTHER'
  body.parcelHistory = []
  const scan = (eventType: string) => ({ time: '10:00:00', date: '2026-10-20', eventType, translation: eventType, pudoId: null, city: null })
  body.parcelEvents = [scan('SPE'), scan('DEHD')]   // newest first: the notice came after the pickup-point scan
  const res = ok((await lookup(happy(json(body)), { postalCode: '01001' })).r)
  expect(res.events.map(e => [e.code, e.status])).toEqual([['DEHD', 'ready_for_pickup'], ['SPE', 'ready_for_pickup']])
})

test('a malformed parcelHistory entry does not discard a verified answer that has scans', async () => {
  const body = fixtureJson('delivered-verified.json')
  body.parcelHistory[1].eventDateAndTime = null
  const res = ok((await lookup(happy(json(body)), { postalCode: '01001' })).r)
  expect(res.status).toBe('delivered')
  expect(res.events.map(e => e.code)).toEqual(['CNP', 'PKY', 'LHI', 'SPE', 'DEHD', 'DEYY'])
  // without scans the same malformed entry is still transport
  delete body.parcelEvents
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect((await lookup(happy(json(body)))).r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
})

test('uses eventDateAndTimeZoneId for event timestamps', async () => {
  // the live-captured pre-alert: a fixed offset zone id
  const live = ok((await lookup(happy(file('prealert.json')))).r)
  expect(live.events).toHaveLength(1)
  expect(live.events[0]!.occurredAtRaw).toBe('2026-08-14T12:20:17')
  expect(live.events[0]!.occurredAt.toISOString()).toBe('2026-08-14T11:20:17.000Z')   // 12:20:17 at +01:00
  expect(live.events[0]!.occurredAtTz).toBe('Etc/GMT-1')                                // the same offset as an IANA name

  // an IANA zone id is honoured whatever it is: nothing is hardcoded to Bratislava
  const body = fixtureJson('prealert.json')
  body.parcelHistory[0].eventDateAndTimeZoneId = 'Europe/London'
  const london = ok((await lookup(happy(json(body)))).r)
  expect(london.events[0]!.occurredAtTz).toBe('Europe/London')
  expect(london.events[0]!.occurredAt.toISOString()).toBe('2026-08-14T11:20:17.000Z')   // BST is +01:00 in August

  // and an autumn date shows the zone is applied per event: CET (+01:00) after the clocks change
  body.parcelHistory[0].eventDateAndTime = '2026-10-26T12:00:00'
  body.parcelHistory[0].eventDateAndTimeZoneId = 'Europe/Bratislava'
  const cet = ok((await lookup(happy(json(body)))).r)
  expect(cet.events[0]!.occurredAt.toISOString()).toBe('2026-10-26T11:00:00.000Z')
})

test('a zone-less scan from parcelEvents is read in the zone of the top-level status', async () => {
  const res = ok((await lookup(happy(file('delivered-verified.json')), { postalCode: '01001' })).r)
  const newest = res.events.at(-1)!
  expect(newest.code).toBe('DEYY')
  expect(newest.occurredAtRaw).toBe('2026-10-24 15:32:05')
  expect(newest.occurredAt.toISOString()).toBe('2026-10-24T13:32:05.000Z')   // CEST
  expect(newest.occurredAtTz).toBe('Europe/Bratislava')
})

test('a verified response yields scan-level events oldest-first with codes and cities', async () => {
  const res = ok((await lookup(happy(file('delivered-verified.json')), { postalCode: '01001' })).r)
  expect(res.status).toBe('delivered')
  expect(res.statusRaw).toBe('DELIVERED')
  expect(res.events.map(e => e.code)).toEqual(['CNP', 'PKY', 'LHI', 'SPE', 'DEHD', 'DEYY'])
  expect(res.events.map(e => e.status)).toEqual([
    'pre_transit', 'pre_transit', 'in_transit', 'in_transit', 'ready_for_pickup', 'delivered',
  ])
  expect(res.events.map(e => e.location)).toEqual([undefined, 'Praha', 'Bratislava', undefined, 'Žilina', 'Žilina'])
  const times = res.events.map(e => e.occurredAt.getTime())
  expect(times).toEqual([...times].sort((a, b) => a - b))
  expect(res.events[0]!.description).toBe('Zásielka bola ohlásená')
})

test('a history-only response is sorted oldest-first whatever order DPD sent it in', async () => {
  const body = fixtureJson('delivered-verified.json')
  delete body.parcelEvents   // what a postcode-less lookup returns
  const res = ok((await lookup(happy(json(body)))).r)
  expect(res.events.map(e => e.code)).toEqual(['ORDER_CREATED', 'PARCEL_HANDED', 'IN_TRANSIT', 'AVAILABLE_FOR_COLLECTION', 'DELIVERED'])
  // history entries bring their own zone id: +00:00 on the last one, IANA on the rest
  expect(res.events.at(-1)!.occurredAt.toISOString()).toBe('2026-10-24T13:32:05.000Z')
  expect(res.events.at(-1)!.occurredAtTz).toBe('UTC')
  expect(res.events[0]!.occurredAt.toISOString()).toBe('2026-10-19T07:00:00.000Z')
  expect(res.events.at(-2)!.location).toBe('Žilina')
})

test('extracts the pickup pass and PUDO details as a pickup point', async () => {
  const res = ok((await lookup(happy(file('delivered-verified.json')), { postalCode: '01001' })).r)
  expect(res.pickup).toEqual({
    kind: 'parcelshop', name: 'Papiernictvo Centrum', street: 'Hlavná 12', city: 'Žilina',
    postalCode: '01001', lat: 49.2244, lon: 18.7402,
  })
  expect(res.statusDetail).toBe('SK-4F7K2Q')   // the pass the shop scans
  expect(res.retainedTill).toBeUndefined()
})

test('a pre-alert has no pickup point and no pass', async () => {
  const res = ok((await lookup(happy(file('prealert.json')))).r)
  expect(res.pickup).toBeUndefined()
  expect(res.statusDetail).toBeUndefined()
  expect(res.statusRaw).toBe('ORDER_CREATED')
  expect(res.raw).toMatchObject({ parcelNumber: NUMBER })
})

test('only the 14 digits are sent when the number carries its check character', async () => {
  const { r, detailsCalls } = await lookup(happy(file('prealert.json')), { number: `${NUMBER}K` })
  expect(ok(r).number).toBe(`${NUMBER}K`)   // the caller's own number is echoed back untouched
  expect(new URL(detailsCalls()[0]!.url).pathname.endsWith(`/details/${NUMBER}`)).toBe(true)
})

test('a rotated Basic credential is picked up: OAuth refusing the cached one refetches firebase once', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-26T08:00:00Z'))
  const s = stub({
    installations: file('firebase-installations.json'),
    config: [file('firebase-config.json'), json({ entries: { basic_dpd_token: 'ROTATED-TOKEN' } })],
    oauth: [file('oauth-token.json'), file('unauthorized.json', 401), file('oauth-token.json')],
    details: file('prealert.json'),
  })
  await dpdAdapter.fetch([{ number: NUMBER }], s.client())
  // the token has expired but the credential (cached for a day) has not: OAuth reruns with the old one,
  // is refused, and only then is Remote Config asked again
  vi.setSystemTime(new Date('2026-10-26T14:00:00Z'))
  const [r] = await dpdAdapter.fetch([{ number: NUMBER }], s.client())
  expect(ok(r as FetchResult).status).toBe('pre_transit')
  expect(s.calls.filter(c => c.url === OAUTH_PATH || c.url === OAUTH).map(c => headersOf(c).Authorization))
    .toEqual([`Basic ${BASIC_TOKEN}`, `Basic ${BASIC_TOKEN}`, 'Basic ROTATED-TOKEN'])
  expect(s.urls().filter(u => u === REMOTE_CONFIG)).toHaveLength(2)
})

test('a Basic credential refused straight after a fresh scrape is gated', async () => {
  const { r, urls } = await lookup({
    ...happy(file('prealert.json')), oauth: file('unauthorized.json', 401),
  })
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
  expect(urls()).toEqual([INSTALLATIONS, REMOTE_CONFIG, OAUTH_PATH])   // no details call without a token
})

test('a Remote Config answer without basic_dpd_token is gated: the credential moved', async () => {
  const { r } = await lookup({ ...happy(file('prealert.json')), config: json({ entries: { other: 'x' } }) })
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
})

test('firebase being down is transport, not gated', async () => {
  expect((await lookup({ ...happy(file('prealert.json')), installations: { status: 503, body: '' } })).r)
    .toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  expect((await lookup({ ...happy(file('prealert.json')), oauth: { status: 502, body: '' } })).r)
    .toEqual({ ok: false, number: NUMBER, reason: 'transport' })
})

test('firebase refusing the app credentials is gated', async () => {
  expect((await lookup({ ...happy(file('prealert.json')), installations: { status: 403, body: '{"error":{"code":403}}' } })).r)
    .toEqual({ ok: false, number: NUMBER, reason: 'gated' })
  expect((await lookup({ ...happy(file('prealert.json')), config: { status: 400, body: '{"error":{"code":400}}' } })).r)
    .toEqual({ ok: false, number: NUMBER, reason: 'gated' })
})

test('a failed chain is not cached, so the next lookup tries again', async () => {
  const down = stub({ ...happy(file('prealert.json')), installations: { status: 503, body: '' } })
  await dpdAdapter.fetch([{ number: NUMBER }], down.client())
  const up = stub(happy(file('prealert.json')))
  const [r] = await dpdAdapter.fetch([{ number: NUMBER }], up.client())
  expect(ok(r as FetchResult).status).toBe('pre_transit')
  expect(up.urls()[0]).toBe(INSTALLATIONS)
})

test('getAccessToken returns the cached token while it is valid and fetches a new one after', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-26T08:00:00Z'))
  const cache = createTokenCache()
  const s = stub(happy({ body: '' }))
  expect(await getAccessToken(s.client(), cache)).toBe('FIXTURE-access-token-1')
  expect(cache.get()?.token).toBe('FIXTURE-access-token-1')
  expect(cache.get()?.expiresAt).toBe(Date.parse('2026-10-26T08:00:00Z') + 18986 * 1000)
  const before = s.calls.length
  expect(await getAccessToken(s.client(), cache)).toBe('FIXTURE-access-token-1')
  expect(s.calls.length).toBe(before)
})

test('matches() is a shape test: 14 digits with an optional check character', () => {
  expect(dpdAdapter.matches('01234567890123')).toBe(true)
  expect(dpdAdapter.matches('06215217497757')).toBe(true)
  expect(dpdAdapter.matches('01234567890123K')).toBe(true)
  expect(dpdAdapter.matches('0123456789012')).toBe(false)     // 13 digits
  expect(dpdAdapter.matches('012345678901234567')).toBe(false)
  expect(dpdAdapter.matches('0123456789012AB')).toBe(false)   // 13 digits then letters
  expect(dpdAdapter.matches('RA123456785SK')).toBe(false)
})

test('adapter metadata', () => {
  expect(dpdAdapter.id).toBe('dpd')
  expect(dpdAdapter.batchSize).toBe(1)
  expect(dpdAdapter.needsPostalCode).toBe(true)
})

// ---------------------------------------------------------------------------------------------------
// The auth store: the poller exits after every run, so the credential and token must outlive the process.

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dpd-auth-'))
  return { dir, path: join(dir, 'dpd-auth.json'), done: () => rmSync(dir, { recursive: true, force: true }) }
}
const isFirebase = (u: string) => u === INSTALLATIONS || u === REMOTE_CONFIG
/** Simulates a new process: memory forgotten, the file (if any) is all that is left. */
const restart = () => clearDpdCaches()

test('a cold chain is written to the auth store with mode 600', async () => {
  const store = tempStore()
  try {
    setDpdAuthStore(store.path)
    await lookup(happy(file('prealert.json')))
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
    const saved = JSON.parse(readFileSync(store.path, 'utf8'))
    expect(saved.credential.value).toBe(BASIC_TOKEN)
    expect(saved.token.token).toBe('FIXTURE-access-token-1')
  } finally { store.done() }
})

test('a cold start reads a valid persisted token and makes no firebase or oauth calls', async () => {
  const store = tempStore()
  try {
    setDpdAuthStore(store.path)
    await lookup(happy(file('prealert.json')))
    restart()   // the next poller run
    const { r, urls } = await lookup(happy(file('prealert.json')))
    expect(ok(r).status).toBe('pre_transit')
    expect(urls()).toEqual([`details/${NUMBER}`])
  } finally { store.done() }
})

test('an expired persisted token triggers only the OAuth step, using the persisted credential', async () => {
  const store = tempStore()
  try {
    setDpdAuthStore(store.path)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-26T08:00:00Z'))
    await lookup(happy(file('prealert.json')))
    restart()
    vi.setSystemTime(new Date('2026-10-26T14:00:00Z'))   // token (5h16m) expired, credential (24h) not
    const { r, urls, calls } = await lookup(happy(file('prealert.json')))
    expect(ok(r).status).toBe('pre_transit')
    expect(urls()).toEqual([OAUTH_PATH, `details/${NUMBER}`])
    expect(headersOf(calls[0]!).Authorization).toBe(`Basic ${BASIC_TOKEN}`)
  } finally { store.done() }
})

test('an expired persisted credential is read from firebase again', async () => {
  const store = tempStore()
  try {
    setDpdAuthStore(store.path)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-26T08:00:00Z'))
    await lookup(happy(file('prealert.json')))
    restart()
    vi.setSystemTime(new Date('2026-10-27T09:00:00Z'))   // more than a day later
    const { urls } = await lookup(happy(file('prealert.json')))
    expect(urls().filter(isFirebase)).toHaveLength(2)
  } finally { store.done() }
})

test('a corrupt or unreadable store falls back to the full chain without throwing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = tempStore()
  try {
    for (const content of ['not json at all {{{', '[]', '{"credential":{"value":"x"},"token":{"token":"t","expiresAt":"soon"}}', '']) {
      writeFileSync(store.path, content)
      setDpdAuthStore(store.path)
      restart()
      const { r, urls } = await lookup(happy(file('prealert.json')))
      expect(ok(r).status).toBe('pre_transit')
      expect(urls().filter(isFirebase)).toHaveLength(2)
      // and the store is repaired by the successful chain
      expect(JSON.parse(readFileSync(store.path, 'utf8')).token.token).toBe('FIXTURE-access-token-1')
    }
    // the path is a directory: unreadable, and unwritable too, yet the lookup still succeeds
    const dirPath = join(store.dir, 'a-directory')
    mkdirSync(dirPath)
    setDpdAuthStore(dirPath)
    restart()
    const { r } = await lookup(happy(file('prealert.json')))
    expect(ok(r).status).toBe('pre_transit')
    expect(warn).toHaveBeenCalled()
  } finally { store.done() }
})

test('a missing store, and a store in a directory that does not exist yet, are just a cold start', async () => {
  const store = tempStore()
  try {
    setDpdAuthStore(join(store.dir, 'nested', 'deeper', 'dpd-auth.json'))
    const { r, urls } = await lookup(happy(file('prealert.json')))
    expect(ok(r).status).toBe('pre_transit')
    expect(urls().filter(isFirebase)).toHaveLength(2)
    expect(JSON.parse(readFileSync(join(store.dir, 'nested', 'deeper', 'dpd-auth.json'), 'utf8')).token.token)
      .toBe('FIXTURE-access-token-1')
  } finally { store.done() }
})

test('a token DPD rejects is not reloaded by the next run', async () => {
  const store = tempStore()
  try {
    setDpdAuthStore(store.path)
    const s = stub({
      ...happy([file('unauthorized.json', 401), file('prealert.json')]),
      oauth: [file('oauth-token.json'), json({ ...fixtureJson('oauth-token.json'), access_token: 'FIXTURE-access-token-2' })],
    })
    await dpdAdapter.fetch([{ number: NUMBER }], s.client())
    expect(JSON.parse(readFileSync(store.path, 'utf8')).token.token).toBe('FIXTURE-access-token-2')
    restart()
    s.calls.length = 0
    await dpdAdapter.fetch([{ number: NUMBER }], s.client())
    expect(headersOf(s.calls[0]!).Authorization).toBe('Bearer FIXTURE-access-token-2')
  } finally { store.done() }
})

test('the default store sits next to the database, and an in-memory database has none', () => {
  expect(authStorePathFor('/Users/me/parcels/data/parcels.db')).toBe('/Users/me/parcels/data/dpd-auth.json')
  expect(authStorePathFor(':memory:')).toBeUndefined()
})

test('the basic credential and access token never reach captured bodies', async () => {
  const s = stub(happy(file('prealert.json')))
  const capture = captureBodies(s.client())
  const [r] = await dpdAdapter.fetch([{ number: NUMBER }], capture.http)
  expect(ok(r as FetchResult).status).toBe('pre_transit')   // the adapter itself still saw every body
  expect(s.urls()).toHaveLength(4)
  expect(capture.bodies).toHaveLength(4)
  const recorded = capture.bodies.join('\n')
  for (const secret of [BASIC_TOKEN, 'FIXTURE-access-token-1', 'FIXTURE-installations-auth-token', '3_AS3qfwFIXTURErefresh']) {
    expect(recorded).not.toContain(secret)
  }
  expect(capture.bodies.slice(0, 3)).toEqual(['[redacted]', '[redacted]', '[redacted]'])
  expect(capture.bodies[3]).toContain('ORDER_CREATED')   // the parcel answer is still kept for diagnosis
})
