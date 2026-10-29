import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { appStage, startAppHost, type AppHost, type AppHostDeps } from '../src/core/app-host.js'
import {
  appUpdateStatusPath, defaultDownload, readAppUpdateStatus, runCommand, writeAppUpdateStatus, type StageDeps,
} from '../src/core/app-update.js'
import { getUpdateCheck, recordUpdateCheck } from '../src/db/update-state.js'
import { nextSlot } from '../src/core/schedule.js'
import { recordPoll } from '../src/core/sleepgap.js'
import type { Config } from '../src/core/config.js'
import { setMainChannel, type ToMain } from '../src/core/app-ipc.js'
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
  setMainChannel(undefined)
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

describe('the poll schedule catches up and never polls a slot twice', () => {
  test('a start after a missed slot polls once before arming the timer', async () => {
    const h = harness(at(10, 20))
    const db = openDb(h.dbPath)
    recordPoll(db, at(7, 0).getTime())   // the app was quit after the 07:00 poll
    db.close()
    await started(h)
    await vi.waitFor(() => expect(h.polls).toHaveLength(1))
    await vi.waitFor(() => expect(h.live()).toHaveLength(1))
    expect(h.live()[0]!.ms).toBe(nextSlot(at(10, 20)).getTime() - at(10, 20).getTime())
  })

  test('a start with no slot missed since the last poll does not poll', async () => {
    const h = harness(at(10, 20))
    const db = openDb(h.dbPath)
    recordPoll(db, at(10, 0).getTime())
    db.close()
    await started(h)
    expect(h.polls).toHaveLength(0)
    expect(h.live()).toHaveLength(1)
  })

  test('a timer that fires a moment early still counts as its slot, so a later wake in that hour does not poll again', async () => {
    const h = harness(at(14, 50))
    const db = openDb(h.dbPath)
    recordPoll(db, at(14, 0).getTime())
    db.close()
    const host = await started(h)
    expect(h.polls).toHaveLength(0)
    // The 15:00 timer fires 100 ms before 15:00.
    h.clock.now = new Date(at(15, 0).getTime() - 100)
    h.live()[0]!.fn()
    await vi.waitFor(() => expect(h.polls).toHaveLength(1))
    await vi.waitFor(() => expect(h.live()).toHaveLength(1))
    h.clock.now = at(15, 20)
    await host.handle({ type: 'wake' })
    expect(h.polls).toHaveLength(1)
  })
})

describe('the app host fills in what the dashboard says about the app', () => {
  const appEnv = (h: ReturnType<typeof harness>, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PARCELS_HOST: 'app',
    PARCELS_CONFIG: h.configPath,
    PARCELS_APP_VERSION: '0.3.0',
    PARCELS_APP_BUNDLE: join(h.dir, 'Applications', 'Parcels.app'),
    PARCELS_LOG_DIR: join(h.dir, 'Logs'),
    PARCELS_RESTARTS: '2',
    ...over,
  })
  // No fixed `version` here: the app's own comes from PARCELS_APP_VERSION.
  const appWeb = { adapters: [], http: bodyHttp() }

  test('Health shows the app\'s version and restarts from the environment', async () => {
    const h = harness(at(8, 30))
    const host = await started(h, { env: appEnv(h), web: appWeb })
    const body = await (await fetch(`http://127.0.0.1:${host.port}/health`)).text()
    expect(body).toContain('Parcels 0.3.0, running for')
    expect(body).toContain('restarted 2 times')
    expect(body).not.toContain('launchd')
  })

  test('Show in Finder reveals the folder the config file is in', async () => {
    const h = harness(at(8, 30))
    // The routes reach the main process through the channel src/app-server.ts sets; here, the harness's.
    setMainChannel(h.deps.post)
    const host = await started(h, { env: appEnv(h), web: appWeb })
    const res = await fetch(`http://127.0.0.1:${host.port}/app/reveal-data`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '',
    })
    expect(res.status).toBe(303)
    expect(h.posted).toContainEqual({ type: 'reveal', path: dirname(h.configPath) })
  })

  test('a staged update of the version now running becomes installed, and Health says so', async () => {
    const h = harness(at(8, 30))
    const status = appUpdateStatusPath(dirname(h.configPath))
    writeAppUpdateStatus(status, { state: 'staged', version: '0.3.0', staged: '/Applications/.Parcels-update-0.3.0/Parcels.app', startedAt: at(8, 0) })
    // The check from before the update still says 0.3.0 is new; it is what is running now.
    const db = openDb(h.dbPath)
    recordUpdateCheck(db, { state: 'behind', behind: 1, changes: [], version: '0.3.0', upstream: 'GitHub Releases' }, at(7, 0))
    db.close()
    const host = await started(h, { env: appEnv(h), web: appWeb })
    expect(readAppUpdateStatus(status)).toMatchObject({ state: 'installed', version: '0.3.0' })
    const body = await (await fetch(`http://127.0.0.1:${host.port}/health`)).text()
    expect(body).toContain('Updated to 0.3.0.')
    expect(body).not.toContain('Update now</button>')
  })

  test('a staged update of another version is left staged', async () => {
    const h = harness(at(8, 30))
    const status = appUpdateStatusPath(dirname(h.configPath))
    writeAppUpdateStatus(status, { state: 'staged', version: '0.4.0', staged: '/Applications/.Parcels-update-0.4.0/Parcels.app', startedAt: at(8, 0) })
    await started(h, { env: appEnv(h), web: appWeb })
    expect(readAppUpdateStatus(status)).toMatchObject({ state: 'staged', version: '0.4.0' })
  })

  test('a download a previous run left unfinished is marked failed, so the button comes back', async () => {
    const h = harness(at(8, 30))
    const status = appUpdateStatusPath(dirname(h.configPath))
    writeAppUpdateStatus(status, { state: 'downloading', version: '0.4.0', startedAt: at(8, 25) })
    await started(h, { env: appEnv(h), web: appWeb })
    expect(readAppUpdateStatus(status)).toMatchObject({ state: 'failed', version: '0.4.0' })
  })

  test('the stage it hands the dashboard adds this Mac\'s architecture, the shipped certificate, and the real effects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parcels-app-res-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'signing-cert.sha256'), `${'ab'.repeat(32)}\n`)
    const seen: StageDeps[] = []
    const stage = appStage({ PARCELS_HOST: 'app', PARCELS_RESOURCES: dir }, async d => {
      seen.push(d)
      return { state: 'downloading', version: d.version, startedAt: at(9) }
    })
    await stage({ version: '0.4.0', appBundle: '/Applications/Parcels.app', supportDir: dir })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      version: '0.4.0', appBundle: '/Applications/Parcels.app', supportDir: dir,
      arch: process.arch, expectedCertSha: 'ab'.repeat(32),
    })
    expect(seen[0]!.download).toBe(defaultDownload)
    expect(seen[0]!.run).toBe(runCommand)
  })

  test('with no certificate file the stage gets an empty one, which it refuses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parcels-app-res-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'empty'))
    const seen: StageDeps[] = []
    const stage = appStage({ PARCELS_HOST: 'app', PARCELS_RESOURCES: join(dir, 'empty') }, async d => {
      seen.push(d)
      return { state: 'downloading', version: d.version, startedAt: at(9) }
    })
    await stage({ version: '0.4.0', appBundle: '/Applications/Parcels.app', supportDir: dir })
    expect(seen[0]!.expectedCertSha).toBe('')
  })

  test('the check before the update is replaced, so the page does not offer the running version again', async () => {
    const h = harness(at(8, 30))
    writeAppUpdateStatus(appUpdateStatusPath(dirname(h.configPath)), { state: 'staged', version: '0.3.0', staged: '/x/Parcels.app', startedAt: at(8, 0) })
    const db = openDb(h.dbPath)
    recordUpdateCheck(db, { state: 'behind', behind: 1, changes: ['x'], version: '0.3.0', upstream: 'GitHub Releases' }, at(7, 0))
    db.close()
    const host = await started(h, { env: appEnv(h), web: appWeb })
    await host.close()
    const check = openDb(h.dbPath)
    try { expect(getUpdateCheck(check)).toMatchObject({ state: 'current' }) } finally { check.close() }
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
