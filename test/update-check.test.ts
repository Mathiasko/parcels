import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  adoptUpdateOutcome, checkForUpdate, checkForUpdateAsync, maybeCheckForUpdate, updateScriptRunnerAsync, parseUpdateCheck, readUpdateRun,
  startUpdate, updateLogPath, updateOutcome, updateStatusPath, UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STALE_MS, writeRunningUpdate, type ScriptResult, type SpawnOptions,
} from '../src/core/update.js'
import {
  dueForUpdateCheck, getUpdateCheck, loggedUpdateStart, recordUpdateCheck,
} from '../src/db/update-state.js'
import { describeActivity, listActivity } from '../src/db/activity-log.js'
import { buildNotifications } from '../src/notify/rules.js'
import { runPoll } from '../src/core/poll.js'
import type { Database } from '../src/db/index.js'
import { bodyHttp, config, memDb, NOW } from './poll-helpers.js'

/** What `scripts/update.sh --check --porcelain` prints when the checkout is the newest commit there is. */
const CURRENT: ScriptResult = {
  status: 0,
  stdout: [
    'state current',
    'version 0.1.0',
    'branch main',
    'local ffa1f20aa11c0f2e2a0f8c3d4e5f60718293a4b5',
    'upstream origin/main',
    'remote ffa1f20aa11c0f2e2a0f8c3d4e5f60718293a4b5',
    '',
  ].join('\n'),
  stderr: '',
}

/** ...and when origin/main has three commits this checkout does not. */
const BEHIND: ScriptResult = {
  status: 0,
  stdout: [
    'state behind',
    'version 0.1.0',
    'branch main',
    'local ffa1f20aa11c0f2e2a0f8c3d4e5f60718293a4b5',
    'upstream origin/main',
    'remote 9f8e7d6c5b4a39281706f5e4d3c2b1a099887766',
    'behind 3',
    'log 9f8e7d6 show the pickup code on the dashboard',
    'log 1234567 fix the GLS DELIVEREDPS mapping',
    'log abcdef0 bump the poll interval',
    '',
  ].join('\n'),
  stderr: '',
}

/** A refusal: update.sh exits non-zero and says why. */
const blocked = (reason: string): ScriptResult =>
  ({ status: 1, stdout: `state blocked\nreason ${reason}\n`, stderr: `update: ${reason}\n` })

const runner = (result: ScriptResult) => {
  const calls: string[][] = []
  return { calls, run: (args: readonly string[]): ScriptResult => { calls.push([...args]); return result } }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parcels-update-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('reading what scripts/update.sh --check reports', () => {
  test('an up-to-date checkout reports "up to date" and nothing to install', () => {
    const c = parseUpdateCheck(CURRENT)
    expect(c.state).toBe('current')
    expect(c.behind).toBe(0)
    expect(c.changes).toEqual([])
    expect(c.version).toBe('0.1.0')
    expect(c.upstream).toBe('origin/main')
    expect(c.localSha).toBe('ffa1f20aa11c0f2e2a0f8c3d4e5f60718293a4b5')
    expect(c.remoteSha).toBe(c.localSha)
    expect(c.reason).toBeUndefined()
  })

  test('a checkout behind its upstream reports how many commits, and what changed', () => {
    const c = parseUpdateCheck(BEHIND)
    expect(c.state).toBe('behind')
    expect(c.behind).toBe(3)
    expect(c.changes).toEqual([
      '9f8e7d6 show the pickup code on the dashboard',
      '1234567 fix the GLS DELIVEREDPS mapping',
      'abcdef0 bump the poll interval',
    ])
    expect(c.remoteSha).not.toBe(c.localSha)
  })

  test('a refusal is reported as blocked, carrying the reason update.sh gave', () => {
    const c = parseUpdateCheck(blocked('/opt/parcels is not a git checkout, so there is nothing to pull.'))
    expect(c.state).toBe('blocked')
    expect(c.reason).toContain('not a git checkout')
    expect(c.behind).toBe(0)
  })

  test('a non-zero exit is blocked even when the output looks fine, so a crash is never read as "up to date"', () => {
    const c = parseUpdateCheck({ ...CURRENT, status: 2, stderr: 'update: usage\n' })
    expect(c.state).toBe('blocked')
    expect(c.reason).toContain('usage')
  })

  test('a branch ahead of its upstream is its own state, not an update and not a fault', () => {
    const c = parseUpdateCheck({ status: 0, stdout: 'state ahead\nversion 0.1.0\nbranch main\n', stderr: '' })
    expect(c.state).toBe('ahead')
    expect(c.behind).toBe(0)
  })

  test('output with no state line at all is blocked rather than guessed at', () => {
    expect(parseUpdateCheck({ status: 0, stdout: 'hello\n', stderr: '' }).state).toBe('blocked')
  })

  test('"behind" without a readable count is blocked: a number is what the page prints', () => {
    const c = parseUpdateCheck({ status: 0, stdout: 'state behind\nbehind lots\n', stderr: '' })
    expect(c.state).toBe('blocked')
  })

  test('a commit subject is carried verbatim but bounded, and the list is capped', () => {
    const many = ['state behind', 'behind 99', ...Array.from({ length: 50 }, (_, i) => `log 000000${i} subject ${'x'.repeat(400)}`)]
    const c = parseUpdateCheck({ status: 0, stdout: `${many.join('\n')}\n`, stderr: '' })
    expect(c.changes.length).toBeLessThanOrEqual(20)
    for (const line of c.changes) expect(line.length).toBeLessThanOrEqual(120)
  })

  test('a malformed sha is dropped rather than stored, so nothing downstream compares rubbish', () => {
    const c = parseUpdateCheck({ status: 0, stdout: 'state current\nlocal not-a-sha\nremote ../../etc\n', stderr: '' })
    expect(c.localSha).toBeUndefined()
    expect(c.remoteSha).toBeUndefined()
  })

  test('checkForUpdate never throws: a runner that blows up is a blocked check', () => {
    const c = checkForUpdate(() => { throw new Error('ENOENT scripts/update.sh') })
    expect(c.state).toBe('blocked')
    expect(c.reason).toContain('ENOENT')
  })

  test('checkForUpdateAsync never rejects either, whether the runner throws or its promise rejects', async () => {
    const thrown = await checkForUpdateAsync(() => { throw new Error('ENOENT scripts/update.sh') })
    expect(thrown.state).toBe('blocked')
    expect(thrown.reason).toContain('ENOENT')
    const rejected = await checkForUpdateAsync(async () => { throw new Error('spawn EACCES') })
    expect(rejected.state).toBe('blocked')
    expect(rejected.reason).toContain('EACCES')
    expect((await checkForUpdateAsync(async () => BEHIND)).state).toBe('behind')
  })

  test('the asynchronous runner really runs scripts/update.sh, and leaves the event loop free while it does', async () => {
    const root = mkdtempSync(join(tmpdir(), 'parcels-update-async-'))
    try {
      mkdirSync(join(root, 'scripts'))
      const script = join(root, 'scripts/update.sh')
      writeFileSync(script, '#!/bin/sh\nsleep 0.3\necho "state current"\necho "args $*"\n', { mode: 0o755 })
      let ticks = 0
      const timer = setInterval(() => { ticks += 1 }, 10)
      const r = await updateScriptRunnerAsync(root)(['--check', '--porcelain'])
      clearInterval(timer)
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('state current')
      expect(r.stdout).toContain('args --check --porcelain')
      expect(ticks).toBeGreaterThan(5)                     // the loop kept turning while git "fetched"
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the asynchronous runner gives up after its timeout, as a result rather than a hang', async () => {
    const root = mkdtempSync(join(tmpdir(), 'parcels-update-async-'))
    try {
      mkdirSync(join(root, 'scripts'))
      writeFileSync(join(root, 'scripts/update.sh'), '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 })
      const r = await updateScriptRunnerAsync(root, 200)(['--check', '--porcelain'])
      expect(r.status).toBeNull()
      expect(parseUpdateCheck(r).state).toBe('blocked')
      // A script that is not there is a result too, not a rejection.
      const missing = await updateScriptRunnerAsync(join(root, 'nowhere'))(['--check'])
      expect(missing.status).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the check asks for --check and --porcelain, so it can never install anything', () => {
    const r = runner(CURRENT)
    checkForUpdate(r.run)
    expect(r.calls).toEqual([['--check', '--porcelain']])
  })
})

describe('the daily check is rate-limited', () => {
  test('the first poll of a fresh database checks', () => {
    const db = memDb()
    const r = runner(CURRENT)
    expect(maybeCheckForUpdate(db, NOW, { run: r.run })?.state).toBe('current')
    expect(r.calls).toHaveLength(1)
  })

  test('it runs at most once a day, however many polls happen in between', () => {
    const db = memDb()
    const r = runner(BEHIND)
    maybeCheckForUpdate(db, NOW, { run: r.run })
    for (const hours of [1, 2, 6, 12, 23]) {
      expect(maybeCheckForUpdate(db, new Date(NOW.getTime() + hours * 3_600_000), { run: r.run })).toBeUndefined()
    }
    expect(r.calls).toHaveLength(1)
    // ...and it does check again once a day has passed.
    expect(maybeCheckForUpdate(db, new Date(NOW.getTime() + UPDATE_CHECK_INTERVAL_MS), { run: r.run })).toBeDefined()
    expect(r.calls).toHaveLength(2)
  })

  test('a check that was refused still counts as a check, so a broken checkout is not fetched hourly', () => {
    const db = memDb()
    const r = runner(blocked('the working tree has uncommitted changes, so nothing was updated.'))
    maybeCheckForUpdate(db, NOW, { run: r.run })
    maybeCheckForUpdate(db, new Date(NOW.getTime() + 3_600_000), { run: r.run })
    expect(r.calls).toHaveLength(1)
    expect(getUpdateCheck(db)!.state).toBe('blocked')
  })

  test('what was found is stored for the page to read, check and all', () => {
    const db = memDb()
    maybeCheckForUpdate(db, NOW, { run: runner(BEHIND).run })
    const stored = getUpdateCheck(db)!
    expect(stored.checkedAt).toEqual(NOW)
    expect(stored.state).toBe('behind')
    expect(stored.behind).toBe(3)
    expect(stored.changes).toHaveLength(3)
    expect(stored.changes[0]).toContain('pickup code')
    expect(stored.upstream).toBe('origin/main')
  })

  test('dueForUpdateCheck is what the gap is measured with, and it keys on the last attempt', () => {
    const db = memDb()
    expect(dueForUpdateCheck(db, NOW)).toBe(true)
    recordUpdateCheck(db, parseUpdateCheck(CURRENT), NOW)
    expect(dueForUpdateCheck(db, NOW)).toBe(false)
    expect(dueForUpdateCheck(db, new Date(NOW.getTime() + UPDATE_CHECK_INTERVAL_MS - 1))).toBe(false)
    expect(dueForUpdateCheck(db, new Date(NOW.getTime() + UPDATE_CHECK_INTERVAL_MS))).toBe(true)
  })

  test('a poll with no updateCheck dependency never goes near git', async () => {
    const db = memDb()
    await runPoll({ db, config, http: bodyHttp(), adapters: [], now: NOW })
    expect(getUpdateCheck(db)).toBeUndefined()
  })

  test('a poll that has one does the check, once, and reports it', async () => {
    const db = memDb()
    const r = runner(BEHIND)
    const report = await runPoll({
      db, config, http: bodyHttp(), adapters: [], now: NOW, updateCheck: { run: r.run },
    })
    expect(report.update?.state).toBe('behind')
    await runPoll({ db, config, http: bodyHttp(), adapters: [], now: NOW, updateCheck: { run: r.run } })
    expect(r.calls).toHaveLength(1)
  })

  test('a check that throws does not turn a good poll into a failed one', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const db = memDb()
      const report = await runPoll({
        db,
        config,
        http: bodyHttp(),
        adapters: [],
        now: NOW,
        updateCheck: { run: () => { throw new Error('git went away') } },
      })
      expect(report.failures).toEqual([])
      expect(report.update?.state).toBe('blocked')
    } finally { errors.mockRestore() }
  })
})

describe('the notification is raised once per new version', () => {
  const notify = (db: Database, now = NOW) => buildNotifications(db, [], now, 8787).map(n => n.title)

  test('an available update is announced', () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    expect(notify(db).some(t => /update is available/i.test(t))).toBe(true)
  })

  test('and not again on the next poll, nor the one after', () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    expect(notify(db).some(t => /update is available/i.test(t))).toBe(true)
    for (const hours of [1, 2, 48]) {
      recordUpdateCheck(db, parseUpdateCheck(BEHIND), new Date(NOW.getTime() + hours * 3_600_000))
      expect(notify(db, new Date(NOW.getTime() + hours * 3_600_000)).some(t => /update is available/i.test(t))).toBe(false)
    }
  })

  test('a newer version than the one already announced is announced afresh', () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    notify(db)
    const newer: ScriptResult = {
      ...BEHIND,
      stdout: BEHIND.stdout.replace('remote 9f8e7d6c5b4a39281706f5e4d3c2b1a099887766', 'remote 1111111111111111111111111111111111111111'),
    }
    recordUpdateCheck(db, parseUpdateCheck(newer), new Date(NOW.getTime() + 86_400_000))
    expect(notify(db, new Date(NOW.getTime() + 86_400_000)).some(t => /update is available/i.test(t))).toBe(true)
  })

  test('an up-to-date checkout is never announced', () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(CURRENT), NOW)
    expect(notify(db).some(t => /update/i.test(t))).toBe(false)
  })

  test('a checkout that cannot be updated at all is not announced either: nothing can be done about it', () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(blocked('this is not a git checkout.')), NOW)
    expect(notify(db).some(t => /update/i.test(t))).toBe(false)
  })

  test('the banner points at /health, which is where the button is', () => {
    const db = memDb()
    recordUpdateCheck(db, parseUpdateCheck(BEHIND), NOW)
    const n = buildNotifications(db, [], NOW, 8787).find(x => /update is available/i.test(x.title))!
    expect(n.url).toBe('http://127.0.0.1:8787/health')
    expect(n.message).toContain('3')
  })
})

describe('the update is spawned detached', () => {
  const recorder = () => {
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions; unrefd: boolean }> = []
    const spawn = (command: string, args: readonly string[], options: SpawnOptions) => {
      const call = { command, args, options, unrefd: false }
      calls.push(call)
      return { pid: 4242, unref: () => { call.unrefd = true } }
    }
    return { calls, spawn }
  }

  test('its own session and process group, so launchctl booting the web agent out cannot kill it', () => {
    const r = recorder()
    startUpdate({ root: '/opt/parcels', dataDir: dir, startedAt: NOW, spawn: r.spawn })
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]!.options.detached).toBe(true)
  })

  test('it runs the wrapper script, with no arguments and no shell', () => {
    const r = recorder()
    startUpdate({ root: '/opt/parcels', dataDir: dir, startedAt: NOW, spawn: r.spawn })
    expect(r.calls[0]!.command).toBe('/opt/parcels/scripts/update-run.sh')
    expect(r.calls[0]!.args).toEqual([])
    expect(r.calls[0]!.options.cwd).toBe('/opt/parcels')
  })

  test('its output goes to a log under data/, not to a pipe nobody will ever read', () => {
    const r = recorder()
    startUpdate({ root: '/opt/parcels', dataDir: dir, startedAt: NOW, spawn: r.spawn })
    const { stdio } = r.calls[0]!.options
    expect(stdio[0]).toBe('ignore')
    expect(typeof stdio[1]).toBe('number')
    expect(typeof stdio[2]).toBe('number')
    expect(updateLogPath(dir)).toBe(join(dir, 'update.log'))
  })

  test('the parent unrefs it, so the web process is not held open by it', () => {
    const r = recorder()
    startUpdate({ root: '/opt/parcels', dataDir: dir, startedAt: NOW, spawn: r.spawn })
    expect(r.calls[0]!.unrefd).toBe(true)
  })

  test('the status file and the start time reach the child, so both halves agree on one run', () => {
    const r = recorder()
    startUpdate({ root: '/opt/parcels', dataDir: dir, startedAt: NOW, spawn: r.spawn })
    const env = r.calls[0]!.options.env!
    expect(env.PARCELS_UPDATE_STATUS).toBe(updateStatusPath(dir))
    expect(env.PARCELS_UPDATE_STARTED).toBe(NOW.toISOString())
  })

  test('the run is marked running before the child starts, so the page never shows a blank moment', () => {
    const r = recorder()
    startUpdate({ root: '/opt/parcels', dataDir: dir, startedAt: NOW, spawn: r.spawn })
    const run = readUpdateRun(updateStatusPath(dir))!
    expect(run.state).toBe('running')
    expect(run.startedAt).toEqual(NOW)
  })

  test('a script that cannot be started is recorded as failed, and does not take the server down', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // What a real ChildProcess does when the script is missing or not executable: an `error` event.
      // Unlistened, that is an uncaught exception; the point of this test is that it is listened for.
      const spawn = () => ({
        pid: undefined,
        unref: () => {},
        once: (_e: 'error', listener: (err: Error) => void) => listener(new Error('spawn ENOENT')),
      })
      expect(() => startUpdate({ root: '/opt/parcels', dataDir: dir, startedAt: NOW, spawn })).not.toThrow()
      const run = readUpdateRun(updateStatusPath(dir))!
      expect(run.state).toBe('failed')
      expect(run.rollback).toBe('none')
      expect(updateOutcome(run, NOW)).toBe('failed')
    } finally { errors.mockRestore() }
  })

  // The claim the whole hazard rests on, checked against the real spawn rather than a recorder: the
  // child must be in a different process group from this process, because `launchctl bootout` signals
  // the group. No network, no repository, and the child is a `sh` that prints its own group and exits.
  test('a really spawned child is in a process group of its own', async () => {
    const out = join(dir, 'pgid')
    const { spawn } = await import('node:child_process')
    const child = spawn('/bin/sh', ['-c', `ps -o pgid= -p $$ > ${JSON.stringify(out)}`], {
      detached: true, stdio: 'ignore',
    })
    child.unref()
    await new Promise<void>(resolve => child.once('close', () => resolve()))
    const childGroup = readFileSync(out, 'utf8').trim()
    expect(childGroup).not.toBe('')
    expect(Number(childGroup)).toBe(child.pid)         // setsid: it leads its own group
    expect(Number(childGroup)).not.toBe(process.pid)
  })
})

describe('the status file the detached update writes', () => {
  const write = (o: unknown) => {
    writeFileSync(updateStatusPath(dir), JSON.stringify(o))
    return updateStatusPath(dir)
  }

  test('a running update is read back as running', () => {
    const run = readUpdateRun(write({ state: 'running', startedAt: NOW.toISOString(), from: 'ffa1f20' }))!
    expect(run.state).toBe('running')
    expect(run.from).toBe('ffa1f20')
    expect(updateOutcome(run, new Date(NOW.getTime() + 60_000))).toBe('running')
  })

  test('a finished update carries where it went, and what it did on the way', () => {
    const run = readUpdateRun(write({
      state: 'failed', startedAt: NOW.toISOString(), finishedAt: new Date(NOW.getTime() + 90_000).toISOString(),
      from: 'ffa1f20', to: 'ffa1f20', rollback: 'ok', exit: 1,
    }))!
    expect(updateOutcome(run, new Date(NOW.getTime() + 120_000))).toBe('failed')
    expect(run.rollback).toBe('ok')
    expect(run.exit).toBe(1)
  })

  test('a running update that stopped answering is abandoned, so the page stops waiting for it', () => {
    const run = readUpdateRun(write({ state: 'running', startedAt: NOW.toISOString() }))!
    expect(updateOutcome(run, new Date(NOW.getTime() + UPDATE_STALE_MS - 1))).toBe('running')
    expect(updateOutcome(run, new Date(NOW.getTime() + UPDATE_STALE_MS + 1))).toBe('abandoned')
  })

  test('a missing, empty or malformed file is nothing, never a crash', () => {
    expect(readUpdateRun(join(dir, 'nope.json'))).toBeUndefined()
    expect(readUpdateRun(write({}))).toBeUndefined()
    expect(readUpdateRun(write({ state: 'running' }))).toBeUndefined()            // no start time
    expect(readUpdateRun(write({ state: 'wat', startedAt: NOW.toISOString() }))).toBeUndefined()
    writeFileSync(updateStatusPath(dir), 'not json at all')
    expect(readUpdateRun(updateStatusPath(dir))).toBeUndefined()
  })

  test('the fields it does not trust are dropped, not carried into the page', () => {
    const run = readUpdateRun(write({
      state: 'ok', startedAt: NOW.toISOString(), from: '../../etc/passwd', to: 'ZZZZ',
      rollback: 'maybe', exit: 'lots',
    }))!
    expect(run.from).toBeUndefined()
    expect(run.to).toBeUndefined()
    expect(run.rollback).toBeUndefined()
    expect(run.exit).toBeUndefined()
  })

  test('writeRunningUpdate creates data/ if it has to, and writes something readable back', () => {
    const nested = join(dir, 'fresh', 'data')
    writeRunningUpdate(updateStatusPath(nested), NOW)
    expect(readUpdateRun(updateStatusPath(nested))!.state).toBe('running')
  })
})

describe('the outcome reaches the activity log', () => {
  interface Written {
    state: string
    startedAt?: Date
    finishedAt?: Date
    from?: string
    to?: string
    rollback?: string
    exit?: number
  }
  const statusFile = (run: Written) => {
    writeFileSync(updateStatusPath(dir), JSON.stringify({
      state: run.state,
      startedAt: (run.startedAt ?? NOW).toISOString(),
      ...(run.finishedAt && { finishedAt: run.finishedAt.toISOString() }),
      ...(run.from !== undefined && { from: run.from }),
      ...(run.to !== undefined && { to: run.to }),
      ...(run.rollback !== undefined && { rollback: run.rollback }),
      ...(run.exit !== undefined && { exit: run.exit }),
    }))
  }
  const entries = (db: Database) => listActivity(db, 20).filter(e => e.kind === 'update')

  test('a successful update is recorded, saying where it came from and where it went', () => {
    const db = memDb()
    statusFile({ state: 'ok', from: 'ffa1f20', to: '9f8e7d6', finishedAt: new Date(NOW.getTime() + 60_000) })
    expect(adoptUpdateOutcome(db, dir, NOW, { actor: 'web' })).toBe('ok')
    expect(entries(db)).toHaveLength(1)
    expect(entries(db)[0]!.detail).toContain('ffa1f20')
    expect(entries(db)[0]!.detail).toContain('9f8e7d6')
  })

  test('a failed update that was rolled back is recorded as exactly that', () => {
    const db = memDb()
    statusFile({ state: 'failed', from: 'ffa1f20', to: 'ffa1f20', rollback: 'ok', exit: 1, finishedAt: NOW })
    expect(adoptUpdateOutcome(db, dir, NOW, { actor: 'web' })).toBe('failed')
    expect(entries(db)[0]!.detail).toContain('rolled_back')
  })

  test('a failed update that could NOT be rolled back is louder still, because a human is needed', () => {
    const db = memDb()
    statusFile({ state: 'failed', from: 'ffa1f20', to: '9f8e7d6', rollback: 'failed', exit: 1, finishedAt: NOW })
    adoptUpdateOutcome(db, dir, NOW, { actor: 'web' })
    expect(entries(db)[0]!.detail).toContain('rollback_failed')
  })

  test('an update that stopped answering is recorded too, rather than leaving no trace', () => {
    const db = memDb()
    statusFile({ state: 'running', from: 'ffa1f20' })
    const later = new Date(NOW.getTime() + UPDATE_STALE_MS + 1000)
    expect(adoptUpdateOutcome(db, dir, later, { actor: 'poller' })).toBe('abandoned')
    expect(entries(db)[0]!.detail).toContain('abandoned')
  })

  test('it lands in the log once, however many times the page is opened', () => {
    const db = memDb()
    statusFile({ state: 'ok', from: 'ffa1f20', to: '9f8e7d6', finishedAt: NOW })
    for (let i = 0; i < 5; i += 1) adoptUpdateOutcome(db, dir, NOW, { actor: 'web' })
    expect(entries(db)).toHaveLength(1)
    expect(loggedUpdateStart(db)).toBe(NOW.toISOString())
  })

  test('a later update is a second entry, not a repeat of the first', () => {
    const db = memDb()
    statusFile({ state: 'ok', from: 'ffa1f20', to: '9f8e7d6', finishedAt: NOW })
    adoptUpdateOutcome(db, dir, NOW, { actor: 'web' })
    const next = new Date(NOW.getTime() + 86_400_000)
    statusFile({ state: 'ok', startedAt: next, from: '9f8e7d6', to: 'abcdef0', finishedAt: next })
    adoptUpdateOutcome(db, dir, next, { actor: 'web' })
    expect(entries(db)).toHaveLength(2)
  })

  test('a run still going is not recorded: there is no outcome yet', () => {
    const db = memDb()
    statusFile({ state: 'running', from: 'ffa1f20' })
    expect(adoptUpdateOutcome(db, dir, new Date(NOW.getTime() + 1000), { actor: 'web' })).toBe('running')
    expect(entries(db)).toHaveLength(0)
  })

  test('no status file at all is no entry and no error', () => {
    const db = memDb()
    expect(adoptUpdateOutcome(db, dir, NOW, { actor: 'web' })).toBeUndefined()
    expect(entries(db)).toHaveLength(0)
  })

  test('the entry reads as English on the page, naming the commits', () => {
    const db = memDb()
    statusFile({ state: 'ok', from: 'ffa1f20', to: '9f8e7d6', finishedAt: NOW })
    adoptUpdateOutcome(db, dir, NOW, { actor: 'web' })
    expect(describeActivity(listActivity(db, 5)[0]!)).toMatch(/updated.*ffa1f20.*9f8e7d6/)
  })
})
