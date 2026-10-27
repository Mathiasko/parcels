import { describe, expect, test, vi } from 'vitest'
import { buildServer, refreshIdle, type WebDeps } from '../src/web/server.js'
import { failRun, finishRun, getRun, listRuns, RUN_STALE_MS, startRun } from '../src/db/poll-runs.js'
import { getParcel, insertParcel } from '../src/db/parcels.js'
import type { CarrierAdapter, CarrierId } from '../src/core/types.js'
import type { Database } from '../src/db/index.js'
import { STYLE } from '../src/web/views/style.js'
import { formatAgo, formatElapsed } from '../src/web/views/format.js'
import { bodyHttp, config, ev, memDb, NOW, okResult, stubAdapter } from './poll-helpers.js'

const CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'"

const form = (fields: Record<string, string>) => ({
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
})

const server = (db: Database, extra: Partial<WebDeps> = {}) =>
  buildServer({ db, config, now: () => NOW, notifier: { send: async () => {} }, ...extra })
const get = (db: Database, url: string, extra: Partial<WebDeps> = {}) =>
  server(db, extra).inject({ method: 'GET', url })

/** A promise a test opens and closes by hand, so a poll can be observed while it is still running. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>(resolve => { open = resolve })
  return { wait, open }
}

const slowAdapter = (wait: Promise<void>) =>
  stubAdapter('posta', async inputs => { await wait; return inputs.map(i => okResult(i.number, [ev('x', 'in_transit')])) }, 100)

/** An adapter whose very identity throws: a poll that fails in a way nothing inside `runPoll` catches. */
const explodingAdapter = (): CarrierAdapter => ({
  get id(): CarrierId { throw new Error('the carrier registry exploded') },
  batchSize: 1, needsPostalCode: false, matches: () => false, fetch: async () => [],
})

const parcel = (db: Database, number = 'RR1') =>
  insertParcel(db, { carrier: 'posta', trackingNumber: number, label: 'Boots', source: 'manual' })

describe('the refresh is asynchronous', () => {
  test('POST /refresh redirects to the run it started, before that run has finished', async () => {
    const db = memDb()
    const id = parcel(db)
    const g = gate()
    const adapter = slowAdapter(g.wait)
    const app = server(db, { adapters: [adapter], http: bodyHttp() })

    const res = await app.inject({ method: 'POST', url: '/refresh', ...form({}) })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toMatch(/^\/\?run=\d+$/)
    expect(getParcel(db, id)!.status).toBe('unknown')      // the poll is still waiting on the carrier

    g.open()
    await refreshIdle(app)
    expect(getParcel(db, id)!.status).toBe('in_transit')    // ...and it did run, in the background
  })

  test('the page it lands on carries a meta refresh while the run goes, and none once it is done', async () => {
    const db = memDb()
    parcel(db)
    const g = gate()
    const app = server(db, { adapters: [slowAdapter(g.wait)], http: bodyHttp() })
    const url = (await app.inject({ method: 'POST', url: '/refresh', ...form({}) })).headers.location as string

    const running = await app.inject({ method: 'GET', url })
    expect(running.body).toContain('<meta http-equiv="refresh" content="3">')
    expect(running.body).toContain('Refreshing')
    expect(running.body).toContain('class="spin"')
    expect(running.body).toContain('Checking for new mail and asking the carriers')   // what it is doing

    g.open()
    await refreshIdle(app)
    const done = await app.inject({ method: 'GET', url })
    expect(done.body).not.toContain('http-equiv="refresh"')
    expect(done.body).not.toContain('class="spin"')
    expect(done.body).toContain('Polled 1 parcel.')
  })

  test('a second refresh while one is running starts no second run, and shows the one in progress', async () => {
    const db = memDb()
    parcel(db)
    const g = gate()
    const adapter = slowAdapter(g.wait)
    const app = server(db, { adapters: [adapter], http: bodyHttp() })

    const first = await app.inject({ method: 'POST', url: '/refresh', ...form({}) })
    const second = await app.inject({ method: 'POST', url: '/refresh', ...form({}) })
    expect(second.statusCode).toBe(303)
    expect(second.headers.location).toBe(first.headers.location)   // the same run, not a new one
    expect(listRuns(db, 10)).toHaveLength(1)

    g.open()
    await refreshIdle(app)
    expect(adapter.calls).toHaveLength(1)
  })

  test('the guard is released when a run ends, so the next click starts a new run', async () => {
    const db = memDb()
    parcel(db)
    const g = gate()
    const app = server(db, { adapters: [slowAdapter(g.wait)], http: bodyHttp() })
    const first = await app.inject({ method: 'POST', url: '/refresh', ...form({}) })
    g.open()
    await refreshIdle(app)

    const second = await app.inject({ method: 'POST', url: '/refresh', ...form({}) })
    expect(second.headers.location).toMatch(/^\/\?run=\d+$/)      // not `?busy=1`, and not the old run
    expect(second.headers.location).not.toBe(first.headers.location)
    await refreshIdle(app)
    expect(listRuns(db, 10)).toHaveLength(2)
  })

  test('a single-parcel refresh still lands back on that parcel, which shows the run in progress', async () => {
    const db = memDb()
    const id = parcel(db)
    const g = gate()
    const app = server(db, { adapters: [slowAdapter(g.wait)], http: bodyHttp() })
    const res = await app.inject({ method: 'POST', url: '/refresh', ...form({ parcel: String(id) }) })
    expect(res.headers.location).toMatch(new RegExp(`^/parcel/${id}\\?run=\\d+$`))
    const body = (await app.inject({ method: 'GET', url: res.headers.location as string })).body
    expect(body).toContain('<meta http-equiv="refresh" content="3">')
    // ...and says what THIS button does: one parcel, no mailbox.
    expect(body).toContain('Asking the carrier about this parcel.')
    expect(body).not.toContain('new mail')
    g.open()
    await refreshIdle(app)
  })

  test('the in-progress page says how long the run has been going', async () => {
    const db = memDb()
    const id = startRun(db, 'web', new Date(NOW.getTime() - 42_000))
    const body = (await get(db, `/?run=${id}`)).body
    expect(body).toContain('42 seconds ago')
  })

  test('a run that started implausibly long ago is not reported as still running', async () => {
    const db = memDb()
    const id = startRun(db, 'web', new Date(NOW.getTime() - RUN_STALE_MS - 1000))
    const res = await get(db, `/?run=${id}`)
    expect(res.body).not.toContain('http-equiv="refresh"')     // the reload loop ends by itself
    expect(res.body).not.toContain('Refreshing')
    expect(res.body).toContain('did not finish')               // and it is reported as failed
    expect(getRun(db, id)!.finishedAt).toEqual(NOW)            // the row recovered without a restart
  })

  test('a background run that rejects is recorded as failed, and the server still answers', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const db = memDb()
      parcel(db)
      const app = server(db, { adapters: [explodingAdapter()], http: bodyHttp() })
      const res = await app.inject({ method: 'POST', url: '/refresh', ...form({}) })
      expect(res.statusCode).toBe(303)
      await refreshIdle(app)

      expect(listRuns(db, 10)[0]!.error).toMatch(/the carrier registry exploded/)
      expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200)
      const landed = await app.inject({ method: 'GET', url: res.headers.location as string })
      expect(landed.body).toContain('the carrier registry exploded')
      expect(landed.body).not.toContain('http-equiv="refresh"')
      // ...and a further click starts a NEW run: the guard was released even though the run threw
      const again = await app.inject({ method: 'POST', url: '/refresh', ...form({}) })
      expect(again.headers.location).toMatch(/^\/\?run=\d+$/)
      expect(again.headers.location).not.toBe(res.headers.location)
      await refreshIdle(app)
      expect(listRuns(db, 10)).toHaveLength(2)
    } finally { errors.mockRestore() }
  })

  test('a double click whose run row has already been closed still gets an answer', async () => {
    const db = memDb()
    parcel(db)
    const g = gate()
    const app = server(db, { adapters: [slowAdapter(g.wait)], http: bodyHttp() })
    const first = await app.inject({ method: 'POST', url: '/refresh', ...form({}) })
    // The row was closed (reaped, or trimmed away) while this process is still working on it, so there
    // is no run to point the second click at. It must still be told something it can act on.
    failRun(db, Number(/run=(\d+)/.exec(String(first.headers.location))![1]), 'closed from outside', NOW)
    const second = await app.inject({ method: 'POST', url: '/refresh', ...form({}) })
    expect(second.headers.location).toBe('/?busy=1')
    expect((await app.inject({ method: 'GET', url: '/?busy=1' })).body).toContain('already running')
    g.open()
    await refreshIdle(app)
  })

  test('an unknown or malformed run in the query is not an error page', async () => {
    const db = memDb()
    for (const url of ['/?run=99999', '/?run=abc', '/?run=', '/?run=1&run=2']) {
      expect((await get(db, url)).statusCode, url).toBe(200)
    }
  })
})

describe('the activity log on /health', () => {
  const log = (db: Database) => {
    const old = startRun(db, 'poller', new Date(NOW.getTime() - 2 * 3_600_000))
    finishRun(db, old, {
      counts: { polled: 3, newEvents: 2, failures: 0 }, summary: 'polled 3 parcel(s), 2 new event(s)',
    }, new Date(NOW.getTime() - 2 * 3_600_000 + 4000))
    const recent = startRun(db, 'web', new Date(NOW.getTime() - 300_000))
    failRun(db, recent, 'Error: the mailbox went away', new Date(NOW.getTime() - 299_000))
    return { old, recent }
  }

  test('recent runs are listed newest first, with the source and a relative time', async () => {
    const db = memDb()
    log(db)
    const body = (await get(db, '/health')).body
    expect(body).toContain('Recent runs')
    const failed = body.indexOf('the mailbox went away')
    const ok = body.indexOf('polled 3 parcel(s), 2 new event(s)')
    expect(failed).toBeGreaterThan(-1)
    expect(ok).toBeGreaterThan(-1)
    expect(failed).toBeLessThan(ok)                 // newest first
    expect(body).toContain('5 minutes ago')         // relative, beside the absolute time
    expect(body).toContain('Mon 26 Oct, 10:55')     // 11:00 local, five minutes back
    expect(body).toContain('Poller')
  })

  test('a failed run is as visible as a successful one', async () => {
    const db = memDb()
    const { recent } = log(db)
    const body = (await get(db, '/health')).body
    const row = body.slice(body.indexOf(`data-run="${recent}"`)).split('</tr>')[0]!
    expect(row).toContain('failed')
    expect(row).toContain('class="bad"')            // washed warn, like a failing carrier
    expect(row).toContain('the mailbox went away')
  })

  test('/health closes a run nothing will ever finish, so the log cannot read as busy for ever', async () => {
    const db = memDb()
    const id = startRun(db, 'poller', new Date(NOW.getTime() - RUN_STALE_MS - 1000))
    const body = (await get(db, '/health')).body
    expect(getRun(db, id)!.error).toMatch(/did not finish/)
    expect(body).toContain('did not finish')
  })

  test('with nothing recorded the panel says so rather than showing an empty table', async () => {
    const body = (await get(memDb(), '/health')).body
    expect(body).toContain('No runs recorded yet')
  })
})

describe('the spinner obeys the house rules', () => {
  test('it is CSS only, quiet rather than blue, and has a still fallback under prefers-reduced-motion', () => {
    const spin = /\.spin\{([^}]*)\}/.exec(STYLE)![1]!
    expect(spin).toContain('animation:spin')
    expect(spin).not.toContain('--signal')          // blue means "this needs you"; a spinner needs nothing
    expect(STYLE).toContain('@keyframes spin')
    const reduced = STYLE.slice(STYLE.indexOf('@media(prefers-reduced-motion:reduce)'))
    expect(reduced).toMatch(/\.spin\{[^}]*animation:none/)
  })

  test('the in-progress page adds no script and does not touch the policy', async () => {
    const db = memDb()
    const id = startRun(db, 'web', new Date(NOW.getTime() - 1000))
    const res = await get(db, `/?run=${id}`)
    expect(res.headers['content-security-policy']).toBe(CSP)
    expect(res.body).not.toMatch(/<script/i)
    expect(res.body).not.toMatch(/\son[a-z]+="/i)   // no inline handlers either
    expect((await get(db, '/health')).headers['content-security-policy']).toBe(CSP)
  })
})

describe('elapsed time in words', () => {
  test('seconds, then minutes, then hours and days', () => {
    expect(formatElapsed(0)).toBe('just now')
    expect(formatElapsed(999)).toBe('just now')
    expect(formatElapsed(1000)).toBe('1 second')
    expect(formatElapsed(42_000)).toBe('42 seconds')
    expect(formatElapsed(60_000)).toBe('1 minute')
    expect(formatElapsed(125_000)).toBe('2 minutes')
    expect(formatElapsed(3_600_000)).toBe('1 hour')
    expect(formatElapsed(2 * 3_600_000 + 60_000)).toBe('2 hours')
    expect(formatElapsed(3 * 86_400_000)).toBe('3 days')
  })

  test('formatAgo never reports the future as elapsed time', () => {
    expect(formatAgo(new Date(NOW.getTime() - 42_000), NOW)).toBe('42 seconds ago')
    expect(formatAgo(NOW, NOW)).toBe('just now')
    expect(formatAgo(new Date(NOW.getTime() + 60_000), NOW)).toBe('just now')
  })
})
