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

test('rejects a 200 carrying more than 50 events as a gated dummy response', async () => {
  const dummy = fixture('dummy-parcel.json')
  expect(JSON.parse(dummy).tuStatus[0].history.length).toBeGreaterThan(50)
  const { r } = await fetchOne(detail(dummy))
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
})

test('a dummy response is also rejected when it arrives from the rstt029 fallback', async () => {
  const { r } = await fetchOne({
    rstt028: { body: fixture('e609-postcode-mismatch.json') },
    rstt029: { body: fixture('dummy-parcel.json') },
  })
  expect(r).toEqual({ ok: false, number: NUMBER, reason: 'gated' })
})

test('exactly 50 events is still trusted; 51 is not', async () => {
  const withHistory = (n: number) => {
    const body = JSON.parse(fixture('rstt028-detail.json'))
    const template = body.tuStatus[0].history[0]
    body.tuStatus[0].history = Array.from({ length: n }, () => template)
    return JSON.stringify(body)
  }
  expect(ok((await fetchOne(detail(withHistory(50)))).r).events).toHaveLength(50)
  expect((await fetchOne(detail(withHistory(51)))).r).toMatchObject({ ok: false, reason: 'gated' })
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

test('matches() accepts 11 and 12 digit numbers', () => {
  expect(glsAdapter.matches('31217533227')).toBe(true)
  expect(glsAdapter.matches('312175332275')).toBe(true)
  expect(glsAdapter.matches('3121753322')).toBe(false)
  expect(glsAdapter.matches('3121753322755')).toBe(false)
  expect(glsAdapter.matches('3121753322AB')).toBe(false)
})

test('adapter metadata: one parcel per call, postcode required', () => {
  expect(glsAdapter.id).toBe('gls')
  expect(glsAdapter.batchSize).toBe(1)
  expect(glsAdapter.needsPostalCode).toBe(true)
})
