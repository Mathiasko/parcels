import { execFileSync } from 'node:child_process'
import type { Database } from '../db/index.js'

/** More than this long between the last completed poll and the machine's last wake forces a full refresh (spec section 9). */
export const LONG_GAP_MS = 6 * 3_600_000

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

/** Runs `sysctl -n <name>`; undefined if it cannot be run. */
const runSysctl = (name: string): string | undefined => {
  try {
    return execFileSync('/usr/sbin/sysctl', ['-n', name], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

/**
 * Epoch ms of the machine's last wake, from `kern.waketime`; undefined when it cannot be read (not
 * macOS, sysctl missing or unparseable), which means "no gap detected".
 *
 * Deliberately only the wake time. `kern.sleeptime` tracks the latest sleep, and this Mac takes a
 * maintenance DarkWake every few minutes, so "last sleep to last wake" measures that cycle (seconds),
 * never the night's real sleep. A DarkWake after the poll does count as a wake: that can cost an
 * occasional extra refresh, which is bounded and harmless, where the alternative misses every real sleep.
 */
export function readLastWakeMs(sysctl: (name: string) => string | undefined = runSysctl): number | undefined {
  const out = sysctl('kern.waketime')
  return out === undefined ? undefined : parseSysctlTime(out)
}

/**
 * Time from the last completed poll to the machine's last wake: 0 if that wake is not later than the
 * poll (the machine has not slept since), otherwise last wake minus last poll. For the typical
 * 21:00 poll and 07:00 wake that is the ~10h the machine spent asleep.
 */
export function sleptSinceMs(lastPollMs: number, lastWakeMs: number | undefined): number {
  if (lastWakeMs === undefined || lastWakeMs <= lastPollMs) return 0
  return lastWakeMs - lastPollMs
}

export interface SleepGap { sleptMs: number; longGap: boolean }

/**
 * Whether the Mac slept longer than LONG_GAP_MS since the last poll that COMPLETED. Read-only: the
 * poll is recorded by `recordPoll` after the run, so a run that crashes mid-refresh leaves the gap in
 * place and the next run tries again. The first ever run has nothing to compare with and is not a
 * long gap. A database or reader error, or a reader that finds nothing, means "no gap": detection must never break a poll.
 */
export function checkSleepGap(db: Database, readLastWake: () => number | undefined = readLastWakeMs): SleepGap {
  let sleptMs = 0
  try {
    const row = db.prepare('SELECT polled_at_ms FROM last_poll WHERE id = 1').get() as { polled_at_ms: number } | undefined
    if (row) sleptMs = sleptSinceMs(row.polled_at_ms, readLastWake())
  } catch { /* no gap detected */ }
  return { sleptMs, longGap: sleptMs > LONG_GAP_MS }
}

/** Stores when a poll run completed. The poller is a fresh process each hour, so this lives in the DB. */
export function recordPoll(db: Database, atMs: number = Date.now()): void {
  db.prepare(`
    INSERT INTO last_poll (id, polled_at_ms) VALUES (1, ?)
    ON CONFLICT (id) DO UPDATE SET polled_at_ms = excluded.polled_at_ms
  `).run(atMs)
}
