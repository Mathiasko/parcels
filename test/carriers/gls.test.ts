import { readFileSync } from 'node:fs'
import { test, expect, vi, afterEach } from 'vitest'
import { glsAdapter } from '../../src/carriers/gls.js'
import type { FetchResult, HttpClient } from '../../src/core/types.js'

afterEach(() => { vi.restoreAllMocks() })

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/gls/${name}`, import.meta.url), 'utf8')

const NUMBER = '312175332275'
const BASE = 'https://gls-group.com/app/service/open/rest/SK/sk'

interface Canned { status?: number; body: string }
interface Call { url: URL; init?: RequestInit }

/**
 * Stub HttpClient answering per endpoint, so a test states what each GLS endpoint says. It records
 * every request; an endpoint with no canned answer fails the test, which is how "must not be called"
 * is asserted.
 */
function stubHttp(answers: { rstt028?: Canned; rstt029?: Canned }) {
  const calls: Call[] = []
  const http: HttpClient = async (rawUrl, init) => {
    const url = new URL(rawUrl)
    calls.push({ url, init })
    const endpoint = /\/(rstt\d+)/.exec(url.pathname)?.[1] as 'rstt028' | 'rstt029' | undefined
    const canned = endpoint && answers[endpoint]
    if (!canned) throw new Error(`unexpected request to ${rawUrl}`)
    return {
      status: canned.status ?? 200,
      headers: {},
      text: async () => canned.body,
      json: async <T>() => JSON.parse(canned.body) as T,
    }
  }
  return { http, calls }
}

async function fetchOne(answers: Parameters<typeof stubHttp>[0], postalCode: string | null = '81101') {
  const { http, calls } = stubHttp(answers)
  const [r] = await glsAdapter.fetch([{ number: NUMBER, ...(postalCode !== null && { postalCode }) }], http)
  return { r: r as FetchResult, calls }
}

function ok(r: FetchResult) {
  if (!r.ok) throw new Error(`expected an ok result, got ${r.reason}`)
  return r
}

/** `rstt028-detail.json` with `progressBar.statusInfo` replaced. */
const detailWithStatus = (statusInfo: string) =>
  fixture('rstt028-detail.json').replace('"statusInfo":"INPICKUP"', `"statusInfo":"${statusInfo}"`)

const detail = (body: string) => ({ rstt028: { body } })

test('calls rstt028 with the postal code when one is supplied', async () => {
  const { r, calls } = await fetchOne(detail(fixture('rstt028-detail.json')))
  expect(ok(r).events).toHaveLength(4)
  expect(calls).toHaveLength(1)
  const { url, init } = calls[0]!
  expect(url.origin + url.pathname).toBe(`${BASE}/rstt028/${NUMBER}`)
  expect(url.searchParams.get('postalCode')).toBe('81101')
  expect(url.searchParams.get('caller')).toBe('witt002')
  expect(url.searchParams.get('millis')).toMatch(/^\d{13}$/)
  expect(init?.method ?? 'GET').toBe('GET')
  // rstt001 is dead (303 to a registration page): no request may ever be made to it
  expect(calls.every(c => !c.url.pathname.includes('rstt001'))).toBe(true)
})

test('falls back to rstt029 for status only when E609 postcode mismatch is returned', async () => {
  const { r, calls } = await fetchOne({
    rstt028: { body: fixture('e609-postcode-mismatch.json') },
    rstt029: { body: fixture('rstt029-delivered.json') },
  }, '99999')
  const res = ok(r)
  expect(res.status).toBe('delivered')
  expect(res.statusRaw).toBe('DELIVERED')
  expect(res.events).toEqual([])   // rstt029 carries no history
  expect(calls.map(c => c.url.pathname)).toEqual([`/app/service/open/rest/SK/sk/rstt028/${NUMBER}`, '/app/service/open/rest/SK/sk/rstt029'])
  expect(calls[0]!.url.searchParams.get('postalCode')).toBe('99999')
  expect(calls[1]!.url.searchParams.get('match')).toBe(NUMBER)
  expect(calls[1]!.url.searchParams.has('postalCode')).toBe(false)
})

test('with no postal code it degrades to rstt029 status-only instead of returning needs_postcode', async () => {
  // needs_postcode would make the orchestrator stop polling a parcel that can in fact be tracked
  for (const postalCode of [null, '', '   ']) {
    const { r, calls } = await fetchOne({ rstt029: { body: fixture('rstt029-delivered.json') } }, postalCode)
    const res = ok(r)
    expect(res.status).toBe('delivered')
    expect(res.statusRaw).toBe('DELIVERED')
    expect(res.events).toEqual([])
    expect(calls).toHaveLength(1)   // rstt028 has no answer in the stub, so calling it would throw
    expect(calls[0]!.url.pathname).toBe('/app/service/open/rest/SK/sk/rstt029')
    expect(calls[0]!.url.searchParams.get('match')).toBe(NUMBER)
    expect(calls[0]!.url.searchParams.has('postalCode')).toBe(false)
  }
})

test('the adapter never returns needs_postcode, whatever GLS says', async () => {
  const answers = [
    { rstt029: { body: fixture('e000.json'), status: 404 } },
    { rstt029: { body: fixture('forbidden-403.json'), status: 403 } },
    { rstt029: { body: fixture('gated.html') } },
    { rstt029: { body: 'garbage' } },
  ]
  for (const a of answers) expect((await fetchOne(a, null)).r).toMatchObject({ ok: false })
  for (const a of answers) expect((await fetchOne(a, null)).r).not.toMatchObject({ reason: 'needs_postcode' })
})

test('maps progressBar.statusInfo DELIVERED to delivered', async () => {
  const r = ok((await fetchOne(detail(detailWithStatus('DELIVERED')))).r)
  expect(r.status).toBe('delivered')
  expect(r.statusRaw).toBe('DELIVERED')
})

test('maps INDELIVERY to out_for_delivery and DELIVEREDPS to delivered', async () => {
  expect(ok((await fetchOne(detail(detailWithStatus('INDELIVERY')))).r).status).toBe('out_for_delivery')
  expect(ok((await fetchOne(detail(detailWithStatus('DELIVEREDPS')))).r).status).toBe('delivered')
})

test('maps NOTDELIVERED to failed_attempt and NOTPICKEDUP to problem', async () => {
  expect(ok((await fetchOne(detail(detailWithStatus('NOTDELIVERED')))).r).status).toBe('failed_attempt')
  expect(ok((await fetchOne(detail(detailWithStatus('NOTPICKEDUP')))).r).status).toBe('problem')
})

test('the rest of the statusInfo vocabulary maps as documented', async () => {
  const expected: Record<string, string> = {
    PREADVICE: 'pre_transit', PROCESSING: 'in_transit', INTRANSIT: 'in_transit', MULTIPACK: 'in_transit',
    INWAREHOUSE: 'in_transit', INPICKUP: 'ready_for_pickup', RETURNED: 'returned', CANCELLED: 'problem',
    UNAVAILABLE: 'unknown',
  }
  for (const [statusInfo, status] of Object.entries(expected)) {
    expect(ok((await fetchOne(detail(detailWithStatus(statusInfo)))).r).status, statusInfo).toBe(status)
  }
})

test('an unrecognised statusInfo maps to unknown, keeps the raw code and warns', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const r = ok((await fetchOne(detail(detailWithStatus('TELEPORTED')))).r)
  expect(r.status).toBe('unknown')
  expect(r.statusRaw).toBe('TELEPORTED')
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('TELEPORTED'))
})

test('never derives status from the localised evtDscr text', async () => {
  // The newest event says (in Slovak) "delivered", but the machine status says in transit.
  const body = JSON.parse(detailWithStatus('INTRANSIT'))
  body.tuStatus[0].history[0].evtDscr = 'Zásielka bola úspešne doručená príjemcovi.'
  const r = ok((await fetchOne(detail(JSON.stringify(body)))).r)
  expect(r.status).toBe('in_transit')
  expect(r.events.at(-1)!.description).toBe('Zásielka bola úspešne doručená príjemcovi.')
  expect(r.events.at(-1)!.status).toBe('in_transit')
})

test('rejects a 200 carrying more than 50 events as a per-parcel not_found (never gated), with a warning', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const dummy = fixture('dummy-parcel.json')
  expect(JSON.parse(dummy).tuStatus[0].history.length).toBeGreaterThan(50)
  const { r } = await fetchOne(detail(dummy))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'not_found' })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('dummy'))
})

test('a dummy response is also rejected when it arrives from the rstt029 fallback', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { r } = await fetchOne({
    rstt028: { body: fixture('e609-postcode-mismatch.json') },
    rstt029: { body: fixture('dummy-parcel.json') },
  })
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'not_found' })
})

test('exactly 50 events is still trusted; 51 is not', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const withHistory = (n: number) => {
    const body = JSON.parse(fixture('rstt028-detail.json'))
    const template = body.tuStatus[0].history[0]
    body.tuStatus[0].history = Array.from({ length: n }, () => template)
    return JSON.stringify(body)
  }
  expect(ok((await fetchOne(detail(withHistory(50)))).r).events).toHaveLength(50)
  expect((await fetchOne(detail(withHistory(51)))).r).toMatchObject({ ok: false, reason: 'not_found' })
})

test('treats an HTML body with status 200 as gated, not as a parse failure', async () => {
  const { r } = await fetchOne(detail(fixture('gated.html')))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
})

test('an HTML body from the rstt029 fallback is gated too', async () => {
  const { r } = await fetchOne({
    rstt028: { body: fixture('e609-postcode-mismatch.json') },
    rstt029: { body: fixture('gated.html') },
  })
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
})

test('a 403 maps to gated, not not_found', async () => {
  // the live 403 body carries an exceptionText and NO lastError, so gating cannot depend on one
  const { r } = await fetchOne({ rstt028: { status: 403, body: fixture('forbidden-403.json') } })
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
})

test('E000, E206, E800 and E801 map to not_found', async () => {
  for (const code of ['E000', 'E206', 'E800', 'E801']) {
    const body = fixture('e000.json').replace('E000', code)
    const { r, calls } = await fetchOne({ rstt028: { status: 404, body } })
    expect(r, code).toEqual({ ok: false, number: NUMBER, reason: 'not_found' })
    expect(calls, code).toHaveLength(1)   // only E609 triggers the rstt029 fallback
  }
})

test('an unrecognised error code is a transport failure, not not_found', async () => {
  const { r } = await fetchOne({ rstt028: { status: 404, body: fixture('e000.json').replace('E000', 'E999') } })
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
})

const ZIP_400 = '{"fieldExceptions":[{"attribute":"zipcode","exceptionText":"Neplatné PSČ"}],"exceptionText":"Neplatný vstup"}'

test('a 400 on zipcode (malformed postcode) degrades to rstt029 status-only and rstt028 is not retried', async () => {
  const { r, calls } = await fetchOne({
    rstt028: { status: 400, body: ZIP_400 },
    rstt029: { body: fixture('rstt029-delivered.json') },
  }, '8210')
  const res = ok(r)
  expect(res.status).toBe('delivered')
  expect(res.events).toEqual([])
  expect(calls.map(c => c.url.pathname)).toEqual([
    `/app/service/open/rest/SK/sk/rstt028/${NUMBER}`, '/app/service/open/rest/SK/sk/rstt029',
  ])
  expect(calls[1]!.url.searchParams.has('postalCode')).toBe(false)
})

test('a 400 on any other attribute stays a transport failure and does not fall back', async () => {
  const body = '{"fieldExceptions":[{"attribute":"match","exceptionText":"Neplatné číslo"}],"exceptionText":"Neplatný vstup"}'
  const { r, calls } = await fetchOne({ rstt028: { status: 400, body } })
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  expect(calls).toHaveLength(1)
})

test('an empty tuStatus with no error code stays transport, not not_found (shape unverified)', async () => {
  const { r } = await fetchOne(detail('{"tuStatus":[]}'))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
})

test('a non-JSON or truncated body is a transport failure and never throws', async () => {
  for (const body of ['', 'not json at all', fixture('rstt028-detail.json').slice(0, 120)]) {
    const { r } = await fetchOne(detail(body))
    expect(r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
  }
})

test('a server error is a transport failure', async () => {
  const { r } = await fetchOne({ rstt028: { status: 502, body: '<html>Bad gateway</html>' } })
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'transport' })
})

test('history is reversed to oldest-first', async () => {
  const r = ok((await fetchOne(detail(fixture('rstt028-detail.json')))).r)
  expect(r.events.map(e => e.occurredAtRaw)).toEqual([
    '2026-10-20 15:30:00', '2026-10-21 22:47:10', '2026-10-22 06:02:41', '2026-10-22 09:14:03',
  ])
  expect(r.events.map(e => e.location)).toEqual(['Praha', 'Senec', 'Bratislava', 'Bratislava'])
  expect(r.events.map(e => e.code)).toEqual(['1.0', '2.0', '2.1', '3.0'])
})

test('event times are parsed as Europe/Bratislava', async () => {
  const r = ok((await fetchOne(detail(fixture('rstt028-detail.json')))).r)
  const first = r.events[0]!
  expect(first.occurredAtTz).toBe('Europe/Bratislava')
  expect(first.occurredAt.toISOString()).toBe('2026-10-20T13:30:00.000Z')   // CEST, UTC+2
  const last = r.events.at(-1)!
  expect(last.occurredAt.toISOString()).toBe('2026-10-22T07:14:03.000Z')
})

test('the authoritative status sits on the newest event and older events stay unknown', async () => {
  const r = ok((await fetchOne(detail(fixture('rstt028-detail.json')))).r)
  expect(r.status).toBe('ready_for_pickup')
  expect(r.events.map(e => e.status)).toEqual(['unknown', 'unknown', 'unknown', 'ready_for_pickup'])
})

test('extracts parcelShop with latitude and longitude as a parcelshop pickup point', async () => {
  const r = ok((await fetchOne(detail(fixture('rstt028-detail.json')))).r)
  expect(r.status).toBe('ready_for_pickup')
  expect(r.pickup).toEqual({
    kind: 'parcelshop',
    name: 'GLS ParcelShop Papiernictvo Ruzinov',
    street: 'Ruzinovska 12',   // addresses[].blockNo1
    city: 'Bratislava',
    postalCode: '81101',
    lat: 48.1486,
    lon: 17.1304,
  })
})

test('pickup is omitted once the parcel is no longer waiting at the shop', async () => {
  const r = ok((await fetchOne(detail(detailWithStatus('DELIVEREDPS')))).r)
  expect(r.pickup).toBeUndefined()
})

test('the rstt029 overview alone yields a status with no events', async () => {
  const r = ok((await fetchOne({
    rstt028: { body: fixture('e609-postcode-mismatch.json') },
    rstt029: { body: fixture('rstt029-delivered.json') },
  })).r)
  expect(r.number).toBe(NUMBER)
  expect(r.events).toEqual([])
})

test.each(['1234567890', '12345678901', '123456789012'])('matches() accepts %s (10, 11 and 12 digits)', n => {
  expect(glsAdapter.matches(n)).toBe(true)
})

test.each(['123456789', '1234567890123', '12345678901234', '123456789A', '12345 67890', ''])(
  'matches() rejects the near-miss %j', n => {
    expect(glsAdapter.matches(n)).toBe(false)
  })

test('adapter metadata: one parcel per call, postcode required', () => {
  expect(glsAdapter.id).toBe('gls')
  expect(glsAdapter.batchSize).toBe(1)
  expect(glsAdapter.needsPostalCode).toBe(true)
})

// ---- the live rstt028 capture (2026-10-27): a BARE object, not wrapped in tuStatus[] ----

const LIVE_NUMBER = '1234567890'
const liveOnly = async (body = fixture('rstt028-live-redacted.json')) => {
  const { http } = stubHttp(detail(body))
  const [r] = await glsAdapter.fetch([{ number: LIVE_NUMBER, postalCode: '00000' }], http)
  return r as FetchResult
}

test('live rstt028: the bare, unwrapped detail object parses (it used to come back as transport)', async () => {
  const body = JSON.parse(fixture('rstt028-live-redacted.json'))
  expect(body.tuStatus).toBeUndefined()   // the point of this fixture
  const r = ok(await liveOnly())
  expect(r.status).toBe('in_transit')
  expect(r.statusRaw).toBe('INTRANSIT')
  expect(r.number).toBe(LIVE_NUMBER)
})

test('live rstt028: both response shapes normalise to the same result', async () => {
  const bare = JSON.parse(fixture('rstt028-live-redacted.json'))
  const wrapped = JSON.stringify({ tuStatus: [bare] })
  const a = ok(await liveOnly())
  const b = ok(await liveOnly(wrapped))
  expect(b).toEqual(a)
})

test('live rstt028: date and time are separate fields, joined and read as Europe/Bratislava', async () => {
  const r = ok(await liveOnly())
  expect(r.events.map(e => e.occurredAtRaw)).toEqual(['2026-10-26 14:02:24', '2026-10-27 02:18:05'])
  expect(r.events[0]!.occurredAt.toISOString()).toBe('2026-10-26T13:02:24.000Z')   // CET, UTC+1 (DST ended 25 Oct)
  expect(r.events[1]!.occurredAt.toISOString()).toBe('2026-10-27T01:18:05.000Z')
  expect(r.events.map(e => e.code)).toEqual(['0.100', '0.0'])
  expect(r.events.map(e => e.status)).toEqual(['unknown', 'in_transit'])   // status sits on the newest
})

test('live rstt028: a country name in address.city is kept as the location', async () => {
  const r = ok(await liveOnly())
  expect(r.events.map(e => e.location)).toEqual(['Slovakia', 'Slovakia'])
})

test('live rstt028: HTML numeric entities in event text are decoded', async () => {
  const r = ok(await liveOnly())
  expect(r.events[1]!.description).toBe('Balík prijatý do systému GLS.')
  expect(r.events[0]!.description).toBe('Údaje o zásielke boli zadané do systému GLS, čakáme na odovzdanie balíka GLS.')
  expect(r.events.every(e => !/&#\d+;/.test(e.description))).toBe(true)
})

test('history is ordered by timestamp whichever way GLS sorts it (oldest-first input, shuffled input)', async () => {
  const live = JSON.parse(fixture('rstt028-live-redacted.json'))
  const [newest, oldest] = live.history
  for (const history of [[oldest, newest], [newest, oldest]]) {
    const r = ok(await liveOnly(JSON.stringify({ ...live, history })))
    expect(r.events.map(e => e.occurredAtRaw)).toEqual(['2026-10-26 14:02:24', '2026-10-27 02:18:05'])
    expect(r.events.map(e => e.status)).toEqual(['unknown', 'in_transit'])
  }
})

test('events sharing a timestamp keep the newest-first reading (the sort does not reshuffle ties)', async () => {
  const live = JSON.parse(fixture('rstt028-live-redacted.json'))
  const same = { ...live.history[0] }
  const history = [{ ...same, evtNo: 'B' }, { ...same, evtNo: 'A' }]   // newest-first: B happened after A
  const r = ok(await liveOnly(JSON.stringify({ ...live, history })))
  expect(r.events.map(e => e.code)).toEqual(['A', 'B'])
})

test('a bare object with neither a progress bar nor a parcel number is still transport, not a parcel', async () => {
  expect(await liveOnly('{"foo":1}')).toEqual({ ok: false, number: LIVE_NUMBER, reason: 'transport' })
})

test('a bare error body still maps by lastError (E000 stays not_found)', async () => {
  expect(await liveOnly(fixture('e000.json'))).toEqual({ ok: false, number: LIVE_NUMBER, reason: 'not_found' })
})
