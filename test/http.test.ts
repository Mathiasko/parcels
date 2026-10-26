import { test, expect, vi, afterEach } from 'vitest'
import type { HttpClient } from '../src/core/types.js'
import { createHttpClient, captureBodies, HttpTransportError, MAX_CAPTURED_BODY_CHARS } from '../src/core/http.js'

afterEach(() => { vi.useRealTimers() })

const respond = (status: number, body = '', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers })

test('returns status and lowercased headers', async () => {
  const fetchImpl = vi.fn(async () => respond(200, '{"a":1}', { 'Content-Type': 'application/json', 'X-Custom-Thing': 'yes' }))
  const res = await createHttpClient({ fetchImpl })('https://example.test/x')
  expect(res.status).toBe(200)
  expect(res.headers).toEqual({ 'content-type': 'application/json', 'x-custom-thing': 'yes' })
  expect(await res.json<{ a: number }>()).toEqual({ a: 1 })
  expect(await res.text()).toBe('{"a":1}')   // body can be read more than once
})

test('retries once on 503 then succeeds', async () => {
  vi.useFakeTimers()
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(respond(503))
    .mockResolvedValueOnce(respond(200, 'ok'))
  const p = createHttpClient({ fetchImpl })('https://example.test/x')
  await vi.advanceTimersByTimeAsync(5_000)
  const res = await p
  expect(res.status).toBe(200)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

test('does not retry a 404', async () => {
  const fetchImpl = vi.fn(async () => respond(404, 'nope'))
  const res = await createHttpClient({ fetchImpl })('https://example.test/x')
  expect(res.status).toBe(404)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('honours Retry-After on 429 by waiting the stated seconds', async () => {
  vi.useFakeTimers()
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(respond(429, '', { 'Retry-After': '3' }))
    .mockResolvedValueOnce(respond(200, 'ok'))
  const p = createHttpClient({ fetchImpl })('https://example.test/x')
  await vi.advanceTimersByTimeAsync(2_999)
  expect(fetchImpl).toHaveBeenCalledTimes(1)   // still waiting
  await vi.advanceTimersByTimeAsync(1)
  expect((await p).status).toBe(200)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

test('rejects with a transport error after the timeout', async () => {
  // a fetch that never answers on its own, but honours the abort signal like the real one
  const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    }))
  const client = createHttpClient({ fetchImpl, timeoutMs: 20, retries: 0 })
  await expect(client('https://example.test/x')).rejects.toBeInstanceOf(HttpTransportError)
})

test('returns the last response when retries are exhausted on a 5xx', async () => {
  vi.useFakeTimers()
  const fetchImpl = vi.fn(async () => respond(502, 'bad gateway'))
  const p = createHttpClient({ fetchImpl, retries: 2 })('https://example.test/x')
  await vi.advanceTimersByTimeAsync(10_000)
  expect((await p).status).toBe(502)
  expect(fetchImpl).toHaveBeenCalledTimes(3)
})

test('retries a network error, and throws a transport error once retries run out', async () => {
  vi.useFakeTimers()
  const ok = vi.fn()
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockResolvedValueOnce(respond(200, 'ok'))
  const p1 = createHttpClient({ fetchImpl: ok })('https://example.test/x')
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await p1).status).toBe(200)

  const down = vi.fn(async () => { throw new TypeError('fetch failed') })
  const p2 = createHttpClient({ fetchImpl: down, retries: 1 })('https://example.test/x')
  const assertion = expect(p2).rejects.toBeInstanceOf(HttpTransportError)
  await vi.advanceTimersByTimeAsync(5_000)
  await assertion
  expect(down).toHaveBeenCalledTimes(2)
})

test('an empty or unparseable Retry-After falls back to normal backoff, not a zero wait', async () => {
  for (const header of ['', '   ', 'soon']) {
    vi.useFakeTimers()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(respond(429, '', { 'Retry-After': header }))
      .mockResolvedValueOnce(respond(200, 'ok'))
    const p = createHttpClient({ fetchImpl })('https://example.test/x')
    await vi.advanceTimersByTimeAsync(100)   // backoff is >= 250 ms, so a 0 ms wait would have retried by now
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await p).status).toBe(200)
    vi.useRealTimers()
  }
})

const brokenBody = () => new Response(new ReadableStream({
  start(controller) { controller.error(new TypeError('terminated')) },
}), { status: 200 })

test('a body that fails mid-read is retried like a network error', async () => {
  vi.useFakeTimers()
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(brokenBody())
    .mockResolvedValueOnce(respond(200, '{"ok":true}'))
  const p = createHttpClient({ fetchImpl })('https://example.test/x')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await (await p).json()).toEqual({ ok: true })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

test('a body that keeps failing surfaces as HttpTransportError, not a raw TypeError', async () => {
  vi.useFakeTimers()
  const fetchImpl = vi.fn(async () => brokenBody())
  const p = createHttpClient({ fetchImpl, retries: 1 })('https://example.test/x')
  const assertion = expect(p).rejects.toBeInstanceOf(HttpTransportError)
  await vi.advanceTimersByTimeAsync(5_000)
  await assertion
})

test('captureBodies records each body in call order and leaves the response readable', async () => {
  const fetchImpl = vi.fn(async (url: string | URL | Request) => respond(200, String(url).endsWith('/a') ? 'first' : 'second'))
  const capture = captureBodies(createHttpClient({ fetchImpl }))
  const res = await capture.http('https://example.test/a')
  await capture.http('https://example.test/b')
  expect(await res.text()).toBe('first')
  expect(capture.bodies).toEqual(['first', 'second'])
})

test('captureBodies truncates an oversized body in the record but not in the response', async () => {
  const big = 'x'.repeat(MAX_CAPTURED_BODY_CHARS + 500)
  const fetchImpl = vi.fn(async () => respond(200, big))
  const capture = captureBodies(createHttpClient({ fetchImpl }))
  const res = await capture.http('https://example.test/bundle.js')
  expect((await res.text()).length).toBe(big.length)
  expect(capture.bodies).toHaveLength(1)
  expect(capture.bodies[0]!.startsWith('x'.repeat(MAX_CAPTURED_BODY_CHARS))).toBe(true)
  expect(capture.bodies[0]!.length).toBeLessThan(MAX_CAPTURED_BODY_CHARS + 100)
  expect(capture.bodies[0]).toContain(`[truncated: ${big.length} characters]`)
})

test('captureBodies records [redacted] for credential-bearing URLs without reading them, and still returns the response', async () => {
  let read = false
  const http: HttpClient = async url => ({
    status: 200, headers: {},
    text: async () => { read = true; return `secret for ${url}` },
    json: async <T>() => ({}) as T,
  })
  const capture = captureBodies(http)
  for (const url of [
    'https://firebaseinstallations.googleapis.com/v1/x', 'https://firebaseremoteconfig.googleapis.com/v1/y',
    'https://www.dpdgroup.com/concept/webservice/oauth/token?grant_type=client_credentials',
  ]) {
    const res = await capture.http(url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(`secret for ${url}`)   // the adapter still reads it
  }
  expect(capture.bodies).toEqual(['[redacted]', '[redacted]', '[redacted]'])
  read = false
  await captureBodies(http).http('https://example.com/a')
  expect(read).toBe(true)
  // a custom list replaces the default
  const custom = captureBodies(http, ['example.com'])
  await custom.http('https://example.com/a')
  await custom.http('https://firebaseinstallations.googleapis.com/v1/x')
  expect(custom.bodies).toEqual(['[redacted]', 'secret for https://firebaseinstallations.googleapis.com/v1/x'])
})
