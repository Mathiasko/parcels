import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { startAppHost, type AppHost, type AppHostDeps } from '../src/core/app-host.js'
import { nextSlot } from '../src/core/schedule.js'
import { recordPoll } from '../src/core/sleepgap.js'
import type { Config } from '../src/core/config.js'
import type { ToMain } from '../src/core/app-ipc.js'
import { openDb, type Database } from '../src/db/index.js'
import { insertParcel, readyCount, setArchived, updateParcelState } from '../src/db/parcels.js'
import { listRuns } from '../src/db/poll-runs.js'
import { bodyHttp } from './poll-helpers.js'

/** Local wall-clock times, because the poll slots are local times (see core/schedule.ts). */
const at = (h: number, m = 0) => new Date(2026, 9, 29, h, m)

interface FakeTimer { fn: () => void; ms: number; cleared: boolean }

/**
 * Everything a host needs, faked: a temp config on port 0, a clock the test moves, a timer that only
 * records what it was asked for, a poll that counts calls, and a `post` that records every message.
 */
function harness(start: Date) {
  const dir = mkdtempSync(join(tmpdir(), 'parcels-app-host-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ defaultPostalCode: '81101', dbPath: 'data/parcels.db', port: 0 }))
  const clock = { now: start }
  const timers: FakeTimer[] = []
  const posted: ToMain[] = []
  const polls: { db: Database; config: Config }[] = []
  const deps: AppHostDeps = {
    configPath,
    post: m => { posted.push(m) },
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const t: FakeTimer = { fn, ms, cleared: false }
      timers.push(t)
      return { clear: () => { t.cleared = true } }
    },
    poll: async (db, config) => { polls.push({ db, config }); return { ran: true } },
    // A fixed version so building the server spawns no git; no carriers and a canned HTTP client so a
    // refresh polls nothing and cannot reach the network.
    web: { version: 'test', adapters: [], http: bodyHttp() },
  }
  const live = () => timers.filter(t => !t.cleared)
  return { dir, configPath, clock, timers, live, posted, polls, deps, dbPath: join(dir, 'data', 'parcels.db') }
}

const hosts: AppHost[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function started(h: ReturnType<typeof harness>, extra: Partial<AppHostDeps> = {}): Promise<AppHost> {
  dirs.push(h.dir)
  const host = await startAppHost({ ...h.deps, ...extra })
  hosts.push(host)
  return host
}

const readyCounts = (posted: ToMain[]) => posted.filter(m => m.type === 'ready-count')

describe('startAppHost', () => {
  test('listens on a real port, then posts listening and the ready count', async () => {
    const h = harness(at(8, 30))
    const host = await started(h, { port: 0 })
    expect(host.port).toBeGreaterThan(0)
    expect(h.posted.slice(0, 2)).toEqual([{ type: 'listening', port: host.port }, { type: 'ready-count', n: 0 }])
    // The port is really open: the dashboard answers on it.
    const res = await fetch(`http://127.0.0.1:${host.port}/`)
    expect(res.status).toBe(200)
  })

  test('arms the timer for the next slot; firing it polls once and arms the one after', async () => {
    const h = harness(at(8, 30))
    await started(h)
    expect(h.live()).toHaveLength(1)
    expect(h.live()[0]!.ms).toBe(nextSlot(at(8, 30)).getTime() - at(8, 30).getTime())
    h.clock.now = at(9, 0)
    h.live()[0]!.fn()
    await vi.waitFor(() => expect(h.timers).toHaveLength(2))
    expect(h.polls).toHaveLength(1)
    expect(h.live()).toHaveLength(1)
    expect(h.live()[0]!.ms).toBe(nextSlot(at(9, 0)).getTime() - at(9, 0).getTime())
    // A poll is followed by the count it may have changed.
    expect(readyCounts(h.posted)).toHaveLength(2)
  })

  test('a wake polls once when a slot was missed since the last recorded poll, and not again', async () => {
    const h = harness(at(14, 10))
    // The last poll the database knows about: this host starts from it rather than from nothing.
    const db = openDb(h.dbPath)
    recordPoll(db, at(9, 5).getTime())
    db.close()
    const host = await started(h)
    await host.handle({ type: 'wake' })
    expect(h.polls).toHaveLength(1)
    h.clock.now = at(14, 11)
    await host.handle({ type: 'wake' })
    expect(h.polls).toHaveLength(1)
    // Either way the wake re-plans: exactly one timer is live, aimed at the next slot.
    expect(h.live()).toHaveLength(1)
    expect(h.live()[0]!.ms).toBe(nextSlot(at(14, 11)).getTime() - at(14, 11).getTime())
  })

  test('a trigger while a poll is in flight is skipped, not queued', async () => {
    const h = harness(at(14, 10))
    let release!: () => void
    let calls = 0
    const host = await started(h, {
      poll: () => { calls++; return new Promise(r => { release = () => r({ ran: true }) }) },
    })
    const first = host.handle({ type: 'wake' })
    h.live()[0]!.fn()
    await host.handle({ type: 'wake' })
    expect(calls).toBe(1)
    release()
    await first
  })

  test('each poll reads the config file afresh, so a settings change reaches the next run', async () => {
    const h = harness(at(14, 10))
    const host = await started(h)
    writeFileSync(h.configPath, JSON.stringify({ defaultPostalCode: '01001', dbPath: 'data/parcels.db', port: 0 }))
    await host.handle({ type: 'wake' })
    expect(h.polls[0]!.config.defaultPostalCode).toBe('01001')
    expect(h.polls[0]!.config.dbPath).toBe(h.dbPath)
  })

  test('a POST that changes a parcel posts the ready count', async () => {
    const h = harness(at(8, 30))
    const db = openDb(h.dbPath)
    const id = insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z0000000001', source: 'manual' })
    updateParcelState(db, id, { status: 'ready_for_pickup' })
    db.close()
    const host = await started(h)
    expect(readyCounts(h.posted)).toEqual([{ type: 'ready-count', n: 1 }])
    const res = await fetch(`http://127.0.0.1:${host.port}/parcel/${id}/collected`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'back=home',
    })
    expect(res.status).toBe(303)
    await vi.waitFor(() => expect(readyCounts(h.posted)).toEqual([{ type: 'ready-count', n: 1 }, { type: 'ready-count', n: 0 }]))
    // A GET changes nothing and posts nothing.
    await fetch(`http://127.0.0.1:${host.port}/`)
    expect(readyCounts(h.posted)).toHaveLength(2)
  })

  test('refresh runs the dashboard refresh and posts the count once it has finished', async () => {
    const h = harness(at(8, 30))
    const host = await started(h)
    await host.handle({ type: 'refresh' })
    const db = openDb(h.dbPath)
    try {
      const [run] = listRuns(db, 1)
      expect(run).toMatchObject({ trigger: 'web' })
      expect(run!.finishedAt).toBeDefined()
    } finally { db.close() }
    // The scheduled poll is a different path: the menu's "Refresh now" is the dashboard's button.
    expect(h.polls).toHaveLength(0)
    expect(h.posted.at(-1)).toEqual({ type: 'ready-count', n: 0 })
  })

  test('shutdown clears the timer and closes the server and the database', async () => {
    const h = harness(at(14, 10))
    const host = await started(h)
    await host.handle({ type: 'wake' })   // the fake poll is handed the database the host opened
    const db = h.polls[0]!.db
    const timer = h.live()[0]!
    await host.handle({ type: 'shutdown' })
    expect(timer.cleared).toBe(true)
    expect(db.open).toBe(false)
    await expect(fetch(`http://127.0.0.1:${host.port}/`)).rejects.toThrow()
    // A second close, and a late message, are harmless.
    await expect(host.close()).resolves.toBeUndefined()
    await host.handle({ type: 'wake' })
    expect(h.polls).toHaveLength(1)
  })

  test('a port already in use fails the start with EADDRINUSE and leaves nothing open', async () => {
    const blocker = createServer()
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r))
    try {
      const h = harness(at(8, 30))
      dirs.push(h.dir)
      const port = (blocker.address() as AddressInfo).port
      await expect(startAppHost({ ...h.deps, port })).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(h.posted).toEqual([])
      expect(h.live()).toHaveLength(0)
    } finally {
      await new Promise(r => blocker.close(r))
    }
  })
})

describe('readyCount', () => {
  test('counts the parcels the dashboard shows as ready: not archived, status ready_for_pickup', () => {
    const db = openDb(':memory:')
    const add = (n: string) => insertParcel(db, { carrier: 'packeta', trackingNumber: n, source: 'manual' })
    updateParcelState(db, add('Z0000000001'), { status: 'ready_for_pickup' })
    updateParcelState(db, add('Z0000000002'), { status: 'in_transit' })
    const archived = add('Z0000000003')
    updateParcelState(db, archived, { status: 'ready_for_pickup' })
    setArchived(db, archived, at(9))
    expect(readyCount(db)).toBe(1)
    db.close()
  })
})
