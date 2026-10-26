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

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after')
  if (h === null) return undefined
  const seconds = Number(h)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(h) - Date.now()
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : undefined
}

/** Exponential backoff with jitter: 250-500 ms, 500-1000 ms, ... */
const backoffMs = (attempt: number) => BASE_BACKOFF_MS * 2 ** attempt * (0.5 + Math.random() * 0.5)

function wrap(res: Response): HttpResponse {
  let body: Promise<string> | undefined
  const text = () => (body ??= res.text())
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers),   // Headers keys are already lowercased
    text,
    json: async <T>() => JSON.parse(await text()) as T,
  }
}

export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const { timeoutMs = 15_000, retries = 2, fetchImpl = fetch } = opts

  return async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      const lastAttempt = attempt >= retries
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout

      let res: Response
      try {
        res = await fetchImpl(url, { ...init, signal })
      } catch (err) {
        if (lastAttempt) throw new HttpTransportError(url, err)
        await sleep(backoffMs(attempt))
        continue
      }

      if (!isRetryableStatus(res.status) || lastAttempt) return wrap(res)

      await res.body?.cancel().catch(() => {})
      await sleep(retryAfterMs(res) ?? backoffMs(attempt))
    }
  }
}
