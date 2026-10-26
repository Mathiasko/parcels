import { execFileSync } from 'node:child_process'
import { uptime } from 'node:os'
import type { Database } from '../db/index.js'

/** More than this much sleep since the last completed poll forces a full refresh (spec section 9). */
export const LONG_GAP_MS = 6 * 3_600_000

/** When the machine last woke and (where known) when it last went to sleep, as epoch milliseconds. */
export interface SleepEvents { wakeMs: number; sleepMs?: number }
export type SleepEventReader = () => SleepEvents | undefined

/**
 * `sysctl -n kern.waketime` prints `{ sec = 1793036854, usec = 797269 } Mon Oct 26 18:47:34 2026`.
 * Returns epoch ms, or undefined for anything else, including the zero value macOS reports when the
 * event has not happened since boot.
 *
 * (Not `process.hrtime.bigint()`: on macOS it keeps counting through sleep, so a monotonic-clock
 * delta against wall time always measures about zero sleep. Measured: 434.5h = wall time since boot.)
 */
export function parseSysctlTime(output: string): number | undefined {
  const sec = /\bsec\s*=\s*(\d+)/.exec(output)?.[1]
  if (sec === undefined || Number(sec) === 0) return undefined
  const usec = /\busec\s*=\s*(\d+)/.exec(output)?.[1] ?? '0'
  return Number(sec) * 1000 + Math.floor(Number(usec) / 1000)
}

const sysctlTime = (name: string): number | undefined => {
  try {
    return parseSysctlTime(execFileSync('/usr/sbin/sysctl', ['-n', name], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return undefined
  }
}

/**
 * The last wake and sleep, from macOS. A boot after the last wake counts as a wake too: the machine
 * was off, so nothing was polling, and the pre-boot sleep time says nothing about it. Undefined when
 * no wake time can be read at all (not macOS, sysctl missing or unparseable): "no gap detected".
 */
export function readWakeEvents(): SleepEvents | undefined {
  const waked = sysctlTime('kern.waketime')
  const bootMs = Date.now() - uptime() * 1000   // os.uptime() counts sleep, so this is the true boot time
  if (waked === undefined) return undefined
  return bootMs > waked ? { wakeMs: bootMs } : { wakeMs: waked, sleepMs: sysctlTime('kern.sleeptime') }
}

/**
 * How long the machine was asleep (or off) since the last completed poll at `lastPollMs`. If the last
 * wake is not later than that poll the machine has not slept since, and the answer is 0. Otherwise it
 * slept at some point in between: from the later of its last sleep and the poll, until that wake.
 */
export function sleptSinceMs(lastPollMs: number, events: SleepEvents | undefined): number {
  if (!events || events.wakeMs <= lastPollMs) return 0
  const from = Math.max(events.sleepMs ?? lastPollMs, lastPollMs)
  return Math.max(events.wakeMs - from, 0)
}

export interface SleepGap { sleptMs: number; longGap: boolean }

/**
 * Whether the Mac slept longer than LONG_GAP_MS since the last poll that COMPLETED. Read-only: the
 * poll is recorded by `recordPoll` after the run, so a run that crashes mid-refresh leaves the gap in
 * place and the next run tries again. The first ever run has nothing to compare with and is not a
 * long gap. A reader that throws or finds nothing means "no gap": detection must never break a poll.
 */
export function checkSleepGap(db: Database, read: SleepEventReader = readWakeEvents): SleepGap {
  const row = db.prepare('SELECT polled_at_ms FROM last_poll WHERE id = 1').get() as { polled_at_ms: number } | undefined
  if (!row) return { sleptMs: 0, longGap: false }
  let sleptMs = 0
  try { sleptMs = sleptSinceMs(row.polled_at_ms, read()) } catch { /* no gap detected */ }
  return { sleptMs, longGap: sleptMs > LONG_GAP_MS }
}

/** Stores when a poll run completed. The poller is a fresh process each hour, so this lives in the DB. */
export function recordPoll(db: Database, atMs: number = Date.now()): void {
  db.prepare(`
    INSERT INTO last_poll (id, polled_at_ms) VALUES (1, ?)
    ON CONFLICT (id) DO UPDATE SET polled_at_ms = excluded.polled_at_ms
  `).run(atMs)
}
