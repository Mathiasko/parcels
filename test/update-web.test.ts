import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildServer, CSP, type WebDeps } from '../src/web/server.js'
import {
  parseUpdateCheck, updateStatusPath, UPDATE_STALE_MS, type ScriptResult, type SpawnOptions,
} from '../src/core/update.js'
import { getUpdateCheck, recordUpdateCheck } from '../src/db/update-state.js'
import { listActivity } from '../src/db/activity-log.js'
import { buildSupportBundle } from '../src/core/support.js'
import type { Database } from '../src/db/index.js'
import { config, memDb, NOW } from './poll-helpers.js'

const CURRENT: ScriptResult = {
  status: 0,
  stdout: [
    'state current', 'version 0.1.0', 'branch main', 'upstream origin/main',
    'local ffa1f20aa11c0f2e2a0f8c3d4e5f60718293a4b5',
    'remote ffa1f20aa11c0f2e2a0f8c3d4e5f60718293a4b5', '',
  ].join('\n'),
  stderr: '',
}

const BEHIND: ScriptResult = {
  status: 0,
  stdout: [
    'state behind', 'version 0.1.0', 'branch main', 'upstream origin/main',
    'local ffa1f20aa11c0f2e2a0f8c3d4e5f60718293a4b5',
    'remote 9f8e7d6c5b4a39281706f5e4d3c2b1a099887766',
    'behind 2',
    'log 9f8e7d6 show the pickup code on the dashboard',
    'log 1234567 fix the GLS DELIVEREDPS mapping', '',
  ].join('\n'),
  stderr: '',
}

const NOT_A_REPO: ScriptResult = {
  status: 1,
  stdout: 'state blocked\nreason /opt/parcels is not a git checkout, so there is nothing to pull.\n',
  stderr: 'update: /opt/parcels is not a git checkout, so there is nothing to pull.\n',
}

const form = (fields: Record<string, string> = {}) => ({
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
})

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parcels-update-web-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** Records every spawn instead of making one; no update ever actually runs in these tests. */
function spawnRecorder() {
  const calls: Array<{ command: string; options: SpawnOptions }> = []
  return {
    calls,
    spawn: (command: string, _args: readonly string[], options: SpawnOptions) => {
      calls.push({ command, options })
      return { pid: 9191, unref: () => {} }
    },
  }
}

const server = (db: Database, extra: Partial<WebDeps> = {}, result: ScriptResult = CURRENT) => {
  const rec = spawnRecorder()
  const app = buildServer({
    db,
    config,
    now: () => NOW,
    version: '0.1.0 (ffa1f20)',
    update: { root: '/opt/parcels', dataDir: dir, spawn: rec.spawn, run: () => result },
    ...extra,
  })
  return { app, rec }
}

const health = async (db: Database, extra: Partial<WebDeps> = {}) => {
  const { app } = server(db, extra)
  return (await app.inject({ method: 'GET', url: '/health' })).body
}

const statusFile = (o: Record<string, unknown>) => writeFileSync(updateStatusPath(dir), JSON.stringify(o))

describe('the Update section on /health', () => {
  test('says what is running, by version and commit', async () => {
    expect(await health(memDb())).toContain('0.1.0 (ffa1f20)')
  })

  test('with nothing checked yet it says so, rather than implying all is well', async () => {
    const body = await health(memDb())
    expect(body).toContain('Update')
    expect(body).toMatch(/not been checked|never been checked/i)
    expect(body).toContain('action="/update/check#update"')
  })

  test('an up-to-date checkout is reported as up to date, with no Update button', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(CURRENT), NOW)
    const body = await health(db)
    expect(body).toMatch(/up to date/i)
    expect(body).not.toContain('action="/update#update"')
  })

  test('a checkout behind its upstream says how far behind, and lists what changed', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    const body = await health(db)
    expect(body).toMatch(/2 commits behind/i)
    expect(body).toContain('show the pickup code on the dashboard')
    expect(body).toContain('fix the GLS DELIVEREDPS mapping')
    expect(body).toContain('action="/update#update"')
  })

  test('the button is absent when the checkout is not a git repo, and the reason is printed', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(NOT_A_REPO), NOW)
    const body = await health(db)
    expect(body).not.toContain('action="/update#update"')
    expect(body).toContain('not a git checkout')
  })

  test('the section adds no script and does not loosen the policy', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    const { app } = server(db)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.headers['content-security-policy'])
      .toBe(CSP)
    expect(res.body).not.toMatch(/<script/i)
    expect(res.body).not.toMatch(/\son[a-z]+="/i)
  })

  test('a commit subject is escaped, not injected: it comes from a remote repository', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck({
      status: 0,
      stdout: 'state behind\nbehind 1\nlog 1234567 <img src=x onerror=alert(1)>\n',
      stderr: '',
    }), NOW)
    const body = await health(db)
    expect(body).not.toContain('<img src=x')
    expect(body).toContain('&lt;img')
  })
})

describe('POST /update is a deliberate click and nothing else', () => {
  test('it refuses a cross-site POST, like every other write on this server', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    const { app, rec } = server(db)
    for (const headers of [
      { ...form().headers, 'sec-fetch-site': 'cross-site' },
      { ...form().headers, 'sec-fetch-site': 'same-site' },
      { ...form().headers, origin: 'http://evil.example' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/update', payload: '', headers })
      expect(res.statusCode, JSON.stringify(headers)).toBe(403)
    }
    expect(rec.calls).toHaveLength(0)
  })

  test('it refuses a foreign Host header too, which is the DNS-rebinding case', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    const { app, rec } = server(db)
    const res = await app.inject({
      method: 'POST', url: '/update', ...form(), headers: { ...form().headers, host: 'parcels.evil.example' },
    })
    expect(res.statusCode).toBe(403)
    expect(rec.calls).toHaveLength(0)
  })

  test('a same-origin POST starts the update and lands on the page that follows it', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    const { app, rec } = server(db)
    const res = await app.inject({ method: 'POST', url: '/update', ...form() })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/health')
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]!.command).toBe('/opt/parcels/scripts/update-run.sh')
    expect(rec.calls[0]!.options.detached).toBe(true)
  })

  test('there is no GET that could update: a prefetch or a reload must never install anything', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    const { app, rec } = server(db)
    expect((await app.inject({ method: 'GET', url: '/update' })).statusCode).toBe(404)
    expect(rec.calls).toHaveLength(0)
  })

  test('with nothing to install it refuses rather than spawning anything', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(CURRENT), NOW)
    const { app, rec } = server(db)
    const res = await app.inject({ method: 'POST', url: '/update', ...form() })
    expect(res.statusCode).toBe(409)
    expect(rec.calls).toHaveLength(0)
  })

  test('with no check ever made it refuses too: the page has to have said so first', async () => {
    const { app, rec } = server(memDb())
    expect((await app.inject({ method: 'POST', url: '/update', ...form() })).statusCode).toBe(409)
    expect(rec.calls).toHaveLength(0)
  })

  test('a checkout that cannot be updated at all is refused, whatever is POSTed', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(NOT_A_REPO), NOW)
    const { app, rec } = server(db)
    expect((await app.inject({ method: 'POST', url: '/update', ...form() })).statusCode).toBe(409)
    expect(rec.calls).toHaveLength(0)
  })

  /**
   * The claim is not "these two routes are guarded" but "every write on this server is", and the
   * Update routes are no exception. Read out of the source rather than listed by hand: a route added
   * tomorrow is covered by this test the moment it is written, which is the only version of this
   * check that stays true.
   */
  test('every POST route on this server refuses a cross-site POST, the new ones included', async () => {
    const source = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf8')
    const paths = [...source.matchAll(/app\.post(?:<[^>]*>)?\('([^']+)'/g)]
      .map(m => m[1]!.replace(/:[A-Za-z]+/g, '1'))
    expect(paths).toContain('/update')
    expect(paths).toContain('/update/check')
    expect(paths.length).toBeGreaterThan(5)
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    const { app, rec } = server(db)
    for (const path of paths) {
      const res = await app.inject({
        method: 'POST', url: path, payload: '',
        headers: { ...form().headers, 'sec-fetch-site': 'cross-site' },
      })
      expect(res.statusCode, path).toBe(403)
    }
    expect(rec.calls).toHaveLength(0)
  })

  test('a second click while one is running starts no second update', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    const { app, rec } = server(db)
    await app.inject({ method: 'POST', url: '/update', ...form() })
    const second = await app.inject({ method: 'POST', url: '/update', ...form() })
    expect(second.statusCode).toBe(303)
    expect(rec.calls).toHaveLength(1)
  })
})

describe('the page follows the update while it runs', () => {
  test('a run in progress shows the spinner and re-requests itself', async () => {
    const db = memDb()
    statusFile({ state: 'running', startedAt: new Date(NOW.getTime() - 30_000).toISOString(), from: 'ffa1f20' })
    const body = await health(db)
    expect(body).toContain('<meta http-equiv="refresh" content="3">')
    expect(body).toContain('class="spin"')
    expect(body).toMatch(/updating/i)
    expect(body).toContain('30 seconds ago')
  })

  test('and stops when it ends, reporting what happened', async () => {
    const db = memDb()
    statusFile({
      state: 'ok', startedAt: new Date(NOW.getTime() - 120_000).toISOString(),
      finishedAt: new Date(NOW.getTime() - 5_000).toISOString(), from: 'ffa1f20', to: '9f8e7d6',
    })
    const body = await health(db)
    expect(body).not.toContain('http-equiv="refresh"')
    expect(body).not.toContain('class="spin"')
    expect(body).toContain('9f8e7d6')
  })

  test('after a successful update the page no longer says "behind" or offers Update now', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), new Date(NOW.getTime() - 3_600_000))
    statusFile({
      state: 'ok', startedAt: new Date(NOW.getTime() - 120_000).toISOString(),
      finishedAt: new Date(NOW.getTime() - 5_000).toISOString(), from: 'ffa1f20', to: '9f8e7d6',
    })
    const body = await health(db)
    expect(body).not.toContain('action="/update#update"')
    expect(body).not.toMatch(/commits? behind/)
    expect(body).toMatch(/up to date/)
  })

  test('a run that stopped answering stops the loop too, and is not left looking busy for ever', async () => {
    const db = memDb()
    statusFile({
      state: 'running', startedAt: new Date(NOW.getTime() - UPDATE_STALE_MS - 1000).toISOString(), from: 'ffa1f20',
    })
    const body = await health(db)
    expect(body).not.toContain('http-equiv="refresh"')
    expect(body).toMatch(/stopped answering|did not finish/i)
  })

  test('a failed update that was rolled back says so, and says what it is running now', async () => {
    const db = memDb()
    statusFile({
      state: 'failed', startedAt: new Date(NOW.getTime() - 120_000).toISOString(),
      finishedAt: NOW.toISOString(), from: 'ffa1f20', to: 'ffa1f20', rollback: 'ok', exit: 1,
    })
    const body = await health(db)
    expect(body).toMatch(/did not finish|failed/i)
    expect(body).toMatch(/put back|rolled back/i)
    expect(body).toContain('ffa1f20')
  })

  test('the Update button is gone while an update is going: one at a time', async () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    statusFile({ state: 'running', startedAt: new Date(NOW.getTime() - 10_000).toISOString() })
    expect(await health(db)).not.toContain('action="/update#update"')
  })

  test('opening the page records the outcome in the activity log, once', async () => {
    const db = memDb()
    statusFile({
      state: 'failed', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(),
      from: 'ffa1f20', to: 'ffa1f20', rollback: 'ok', exit: 1,
    })
    const { app } = server(db)
    for (let i = 0; i < 3; i += 1) await app.inject({ method: 'GET', url: '/health' })
    const updates = listActivity(db, 20).filter(e => e.kind === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.detail).toContain('rolled_back')
    expect((await app.inject({ method: 'GET', url: '/health' })).body).toContain('rolled back')
  })
})

describe('POST /update/check', () => {
  test('runs one check and stores it, then comes back to the page', async () => {
    const db = memDb()
    const { app } = server(db, {}, BEHIND)
    const res = await app.inject({ method: 'POST', url: '/update/check', ...form() })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/health')
    expect(getUpdateCheck(db)!.behind).toBe(2)
  })

  test('refuses a cross-site POST, because it spawns git', async () => {
    const db = memDb()
    const { app } = server(db, {}, BEHIND)
    const res = await app.inject({
      method: 'POST', url: '/update/check', payload: '',
      headers: { ...form().headers, 'sec-fetch-site': 'cross-site' },
    })
    expect(res.statusCode).toBe(403)
    expect(getUpdateCheck(db)).toBeUndefined()
  })

  test('is not a GET either, so no prefetch can fetch from the internet', async () => {
    const db = memDb()
    const { app } = server(db, {}, BEHIND)
    expect((await app.inject({ method: 'GET', url: '/update/check' })).statusCode).toBe(404)
    expect(getUpdateCheck(db)).toBeUndefined()
  })

  test('a refused check is shown on the page rather than being a 500', async () => {
    const db = memDb()
    const { app } = server(db, {}, NOT_A_REPO)
    expect((await app.inject({ method: 'POST', url: '/update/check', ...form() })).statusCode).toBe(303)
    expect((await app.inject({ method: 'GET', url: '/health' })).body).toContain('not a git checkout')
  })
  test('the server keeps answering while a check is waiting on the network', async () => {
    // A `git fetch` can take up to a minute. With a synchronous spawn the whole server stopped for
    // that minute; the check must wait on its own, and every other page must still load meanwhile.
    const db = memDb()
    let finish!: (r: ScriptResult) => void
    const pending = new Promise<ScriptResult>(resolve => { finish = resolve })
    const app = buildServer({
      db, config, now: () => NOW, version: '0.1.0 (ffa1f20)',
      update: { root: '/opt/parcels', dataDir: dir, run: () => pending },
    })
    const check = app.inject({ method: 'POST', url: '/update/check', ...form() })
    const meanwhile = await app.inject({ method: 'GET', url: '/' })
    expect(meanwhile.statusCode).toBe(200)
    expect(getUpdateCheck(db)).toBeUndefined()             // the check has not come back yet...
    finish(BEHIND)
    expect((await check).statusCode).toBe(303)
    expect(getUpdateCheck(db)!.behind).toBe(2)             // ...and when it does, it is stored
  })
})

describe('the support bundle shows the update', () => {
  const bundle = (db: Database) => buildSupportBundle({
    db,
    config,
    version: '0.1.0 (ffa1f20)',
    now: NOW,
    env: { node: 'v24.21.0', os: 'macOS', arch: 'arm64' },
    launchd: { agents: [] },
    dataDir: dir,
  })

  test('the last check: its state, how far behind, and when it was made', () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    const text = bundle(db)
    expect(text).toMatch(/-- update --/)
    expect(text).toContain('behind')
    expect(text).toContain('origin/main')
  })

  test('a checkout that cannot be updated says why, which is often the whole fault', () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(NOT_A_REPO), NOW)
    expect(bundle(db)).toContain('not a git checkout')
  })

  test('the last update attempt, including that it was rolled back', () => {
    const db = memDb()
    statusFile({
      state: 'failed', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(),
      from: 'ffa1f20', to: 'ffa1f20', rollback: 'ok', exit: 1,
    })
    const text = bundle(db)
    expect(text).toMatch(/Rollback:\s+ok/)
    expect(text).toContain('ffa1f20')
  })

  test('the end of data/update.log, which is where the real reason is', () => {
    const db = memDb()
    writeFileSync(join(dir, 'update.log'), 'npm ERR! code ELIFECYCLE\nbuild failed\n')
    expect(bundle(db)).toContain('build failed')
  })

  test('a log that is not there is stated as absent, as the others are', () => {
    expect(bundle(memDb())).toContain('data/update.log (not present)')
  })

  test('with nothing ever checked it says that, rather than leaving the section out', () => {
    expect(bundle(memDb())).toMatch(/-- update --/)
  })

  test('nothing in the section is a secret, so it survives the redaction pass intact', () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    const text = bundle(db)
    const section = text.slice(text.indexOf('-- update --')).split('\n-- ')[0]!
    expect(section).not.toContain('redacted')
  })
})
