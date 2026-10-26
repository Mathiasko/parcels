import { test, expect, vi, afterEach } from 'vitest'
import { createHttpClient, HttpTransportError } from '../src/core/http.js'

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
  const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
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
