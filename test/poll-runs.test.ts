import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { openDb } from '../src/db/index.js'
import {
  POLL_RUNS_KEPT, RUN_STALE_MS, failRun, finishRun, getRun, listRuns, reapStaleRuns, runningRun, startRun,
} from '../src/db/poll-runs.js'
import { recordPollRun, runCounts, runPoll, summarize } from '../src/core/poll.js'
import { insertParcel } from '../src/db/parcels.js'
import { runCli } from '../src/cli.js'
import { bodyHttp, config, ev, memDb, NOW, okResult, stubAdapter } from './poll-helpers.js'

const at = (ms: number) => new Date(NOW.getTime() + ms)

test('startRun opens a run that is in progress, and finishRun records what it did', () => {
  const db = memDb()
  const id = startRun(db, 'web', NOW)
  expect(runningRun(db)?.id).toBe(id)
  expect(getRun(db, id)!.finishedAt).toBeUndefined()

  finishRun(db, id, { counts: { polled: 3, newEvents: 2, mailRead: 4, created: 1, failures: 0 }, summary: 'polled 3 parcel(s)' }, at(5000))
  const run = getRun(db, id)!
  expect(run.startedAt).toEqual(NOW)
  expect(run.finishedAt).toEqual(at(5000))
  expect(run).toMatchObject({
    trigger: 'web', polled: 3, newEvents: 2, mailRead: 4, created: 1, failures: 0, summary: 'polled 3 parcel(s)',
  })
  expect(run.error).toBeUndefined()
  expect(runningRun(db)).toBeUndefined()   // nothing is in progress any more
})

test('a run with no mailbox is distinguishable from one that read no mail', () => {
  const db = memDb()
  const none = startRun(db, 'poller', NOW)
  finishRun(db, none, { counts: { polled: 1, newEvents: 0, failures: 0 }, summary: 'x' }, NOW)
  expect(getRun(db, none)!.mailRead).toBeUndefined()
  expect(getRun(db, none)!.created).toBeUndefined()

  const empty = startRun(db, 'poller', NOW)
  finishRun(db, empty, { counts: { polled: 1, newEvents: 0, mailRead: 0, created: 0, failures: 0 }, summary: 'x' }, NOW)
  expect(getRun(db, empty)!.mailRead).toBe(0)
  expect(getRun(db, empty)!.created).toBe(0)
})

test('failRun ends the run and keeps the error', () => {
  const db = memDb()
  const id = startRun(db, 'poller', NOW)
  failRun(db, id, 'Error: the mailbox went away', at(1000))
  const run = getRun(db, id)!
  expect(run.finishedAt).toEqual(at(1000))
  expect(run.error).toBe('Error: the mailbox went away')
  expect(runningRun(db)).toBeUndefined()
})

test('reapStaleRuns closes a run too old to still be going, and leaves a young one alone', () => {
  const db = memDb()
  const killed = startRun(db, 'poller', at(-RUN_STALE_MS - 1000))
  const live = startRun(db, 'web', at(-1000))
  expect(reapStaleRuns(db, NOW)).toBe(1)

  const dead = getRun(db, killed)!
  expect(dead.finishedAt).toEqual(NOW)
  expect(dead.error).toMatch(/did not finish/)
  expect(getRun(db, live)!.finishedAt).toBeUndefined()
  expect(runningRun(db)!.id).toBe(live)
})

test('a reaped run that does finish after all has its verdict corrected', () => {
  const db = memDb()
  const id = startRun(db, 'poller', at(-RUN_STALE_MS - 1000))
  reapStaleRuns(db, NOW)
  expect(getRun(db, id)!.error).toBeDefined()
  finishRun(db, id, { counts: { polled: 2, newEvents: 0, failures: 0 }, summary: 'polled 2 parcel(s)' }, at(1000))
  expect(getRun(db, id)!.error).toBeUndefined()
  expect(getRun(db, id)!.polled).toBe(2)
})

test('the run log is bounded: only the newest POLL_RUNS_KEPT rows are kept, newest first', () => {
  const db = memDb()
  const ids: number[] = []
  for (let i = 0; i < POLL_RUNS_KEPT + 7; i++) {
    const id = startRun(db, 'poller', at(i * 1000))
    finishRun(db, id, { counts: { polled: i, newEvents: 0, failures: 0 }, summary: `run ${i}` }, at(i * 1000 + 10))
    ids.push(id)
  }
  const runs = listRuns(db, 1000)
  expect(runs).toHaveLength(POLL_RUNS_KEPT)
  expect(runs.map(r => r.id)).toEqual([...ids].reverse().slice(0, POLL_RUNS_KEPT))
  for (const gone of ids.slice(0, 7)) expect(getRun(db, gone)).toBeUndefined()
  expect(listRuns(db, 3)).toHaveLength(3)
})

test('recordPollRun writes what a real poll did, reusing the log line summarize() builds', async () => {
  const db = memDb()
  insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', source: 'manual' })
  const adapter = stubAdapter('posta', inputs => inputs.map(i => okResult(i.number, [ev('x', 'in_transit')])), 100)
  const id = startRun(db, 'poller', NOW)
  const report = await recordPollRun(
    db, id, runPoll({ db, config, http: bodyHttp(), adapters: [adapter], now: NOW }), () => at(2000),
  )
  const run = getRun(db, id)!
  expect(run.polled).toBe(1)
  expect(run.newEvents).toBe(1)
  expect(run.failures).toBe(0)
  expect(run.summary).toBe(summarize(report))
  expect(run.finishedAt).toEqual(at(2000))
  expect(run.error).toBeUndefined()
})

test('runCounts reads the numbers off the report rather than recounting them', () => {
  expect(runCounts({ polled: 2, newEvents: [], failures: [{ carrier: 'gls', reason: 'gated' }] }))
    .toEqual({ polled: 2, newEvents: 0, failures: 1, mailRead: undefined, created: undefined })
})

test('a poll that throws is recorded as a failed run, and the throw still reaches the caller', async () => {
  const db = memDb()
  const id = startRun(db, 'poller', NOW)
  await expect(recordPollRun(db, id, Promise.reject(new Error('boom')), () => at(1000))).rejects.toThrow('boom')
  const run = getRun(db, id)!
  expect(run.error).toMatch(/boom/)
  expect(run.finishedAt).toEqual(at(1000))
})

test('failing to write the log never turns a good poll into a failed one', async () => {
  const db = memDb()
  const id = startRun(db, 'poller', NOW)
  db.exec('DROP TABLE poll_runs')
  const report = { polled: 0, newEvents: [], failures: [] }
  await expect(recordPollRun(db, id, Promise.resolve(report), () => NOW)).resolves.toBe(report)
  // ...and a failing run still reports its own failure, not the logger's
  await expect(recordPollRun(db, id, Promise.reject(new Error('boom')), () => NOW)).rejects.toThrow('boom')
})

test('cli poll records the run, so the log covers the command line too', async () => {
  const db = memDb()
  insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', source: 'manual' })
  const adapter = stubAdapter('posta', inputs => inputs.map(i => okResult(i.number, [ev('x', 'in_transit')])), 100)
  const code = await runCli(['poll'], {
    db, config: { ...config, mapPreview: false }, out: () => {}, err: () => {},
    http: bodyHttp(), adapters: [adapter], notifier: { send: async () => {} },
  })
  expect(code).toBe(0)
  const runs = listRuns(db, 10)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ trigger: 'cli', polled: 1, newEvents: 1 })
  expect(runs[0]!.finishedAt).toBeDefined()
})

/**
 * The launchd poller, run as the real built process. Every other test here calls `recordPollRun`
 * directly, so none of them would notice the entry point forgetting to open a run at all - and the
 * whole point of the log is that it covers the hourly poller and not only the button.
 *
 * No network is touched: the temp database has no parcels, so there is nothing to poll, and no mailbox
 * is configured. Skipped when `npm run build` has not been run.
 */
const POLLER = fileURLToPath(new URL('../dist/poll.js', import.meta.url))

test.skipIf(!existsSync(POLLER))('the launchd poller records its run, not just the button presses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parcels-poller-'))
  try {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ defaultPostalCode: '81101', dbPath: 'parcels.db', mapPreview: false }))
    const r = spawnSync(process.execPath, [POLLER, configPath], { encoding: 'utf8', timeout: 30_000 })
    expect(r.status, r.stderr).toBe(0)

    const db = openDb(join(dir, 'parcels.db'))
    try {
      const runs = listRuns(db, 10)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.trigger).toBe('poller')
      expect(runs[0]!.finishedAt).toBeDefined()
      expect(runs[0]!.error).toBeUndefined()
      expect(runs[0]!.summary).toContain('polled 0 parcel(s)')
    } finally { db.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
