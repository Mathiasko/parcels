import type { HttpClient, HttpResponse } from './types.js'

export type { HttpClient, HttpResponse } from './types.js'

/** The request never produced a response: DNS/connection failure, or the timeout fired. */
export class HttpTransportError extends Error {
  constructor(url: string, cause: unknown) {
    super(`transport error for ${url}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'HttpTransportError'
  }
}

export interface HttpClientOptions {
  /** Per-attempt timeout. Default 15 000 ms. */
  timeoutMs?: number
  /** Retries after the first attempt, for 429 / 5xx / network failures only. Default 2. */
  retries?: number
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

const BASE_BACKOFF_MS = 500
/** A hostile or buggy Retry-After must not be able to hang a poll run. */
const MAX_RETRY_AFTER_MS = 60_000

const isRetryableStatus = (s: number) => s === 429 || s >= 500

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Milliseconds the server asked us to wait, or undefined when absent/empty/unparseable. */
function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after')?.trim()
  if (!h) return undefined
  const ms = /^\d+(\.\d+)?$/.test(h) ? Number(h) * 1000 : Date.parse(h) - Date.now()
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : undefined
}

/** Exponential backoff with jitter: 250-500 ms, 500-1000 ms, ... */
const backoffMs = (attempt: number) => BASE_BACKOFF_MS * 2 ** attempt * (0.5 + Math.random() * 0.5)

/** Body already read, so `text()`/`json()` can be called repeatedly and cannot fail on transport. */
function wrap(res: Response, body: string): HttpResponse {
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers),   // Headers keys are already lowercased
    text: async () => body,
    json: async <T>() => JSON.parse(body) as T,
  }
}

export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const { timeoutMs = 15_000, retries = 2, fetchImpl = fetch } = opts

  return async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      const lastAttempt = attempt >= retries
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout

      let wait: number
      try {
        const res = await fetchImpl(url, { ...init, signal })
        if (!isRetryableStatus(res.status) || lastAttempt) {
          // Read inside the try: a connection dropped mid-body is a transport failure too,
          // and is retried like one. The timeout signal stays armed while the body streams.
          return wrap(res, await res.text())
        }
        await res.body?.cancel().catch(() => {})
        wait = retryAfterMs(res) ?? backoffMs(attempt)
      } catch (err) {
        if (lastAttempt) throw new HttpTransportError(url, err)
        wait = backoffMs(attempt)
      }
      await sleep(wait)
    }
  }
}

/**
 * Longest body `captureBodies` keeps. Captured bodies end up in `raw_responses` as diagnostics for a
 * wrong status mapping; an adapter that has to fetch a page or script on the way (SPS reads its key
 * out of a JS bundle) must not be able to push megabytes of noise there.
 */
export const MAX_CAPTURED_BODY_CHARS = 64 * 1024

/**
 * Wraps a client so every response body it returns is also captured, in call order, each cut to
 * `MAX_CAPTURED_BODY_CHARS`. Lets the caller keep the raw text of a response an adapter then failed
 * to parse, or print it. The response handed back to the adapter is never truncated.
 */
export function captureBodies(http: HttpClient): { http: HttpClient; bodies: string[] } {
  const bodies: string[] = []
  return {
    bodies,
    http: async (url, init) => {
      const res = await http(url, init)
      const body = await res.text()
      bodies.push(body.length > MAX_CAPTURED_BODY_CHARS
        ? `${body.slice(0, MAX_CAPTURED_BODY_CHARS)}\n[truncated: ${body.length} characters]`
        : body)
      return res
    },
  }
}
