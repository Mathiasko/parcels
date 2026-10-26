import { cpus } from 'node:os'
import type { Database } from '../db/index.js'

/** A gap of sleep longer than this forces a full refresh of every active parcel (spec section 9). */
export const LONG_GAP_MS = 6 * 3_600_000

export interface Clocks {
  /** Wall clock, `Date.now()`. Keeps running while the Mac sleeps. */
  wallMs: number
  /** Time the Mac has been awake since boot. Stands still while it sleeps. */
  awakeMs: number
}

/**
 * Milliseconds the machine has been awake since boot.
 *
 * Deliberately NOT `process.hrtime.bigint()`: on macOS that is a continuous clock that keeps
 * counting through sleep (measured on this machine: 434.5h, equal to wall time since boot, against
 * 255.5h for CLOCK_UPTIME_RAW), so wall-minus-hrtime would read zero sleep forever. Node exposes no
 * CLOCK_UPTIME_RAW, but the per-core CPU tick counters do not advance while asleep, so their mean
 * is an awake-time clock (254.8h on the same machine, within 0.3% of CLOCK_UPTIME_RAW). Only
 * differences between two readings are ever used, so the constant offset is irrelevant.
 */
export function awakeMs(): number {
  const cores = cpus()
  if (cores.length === 0) return 0
  let ticks = 0
  for (const { times: t } of cores) ticks += t.user + t.nice + t.sys + t.idle + t.irq
  return Math.round(ticks / cores.length)
}

export const readClocks = (): Clocks => ({ wallMs: Date.now(), awakeMs: awakeMs() })

/**
 * How long the machine slept since the earlier reading `(prevWallMs, prevUptimeMs)`: wall time that
 * passed minus awake time that passed. `now` is injectable for tests; it defaults to the real clocks.
 *
 * Never negative. If awake time went BACKWARDS the machine rebooted (the counters restart at boot),
 * so the difference is meaningless; the whole wall gap is returned instead, because nothing was
 * polling during it either way.
 */
export function sleptSinceMs(prevWallMs: number, prevUptimeMs: number, now: Clocks = readClocks()): number {
  const wall = now.wallMs - prevWallMs
  if (now.awakeMs < prevUptimeMs) return Math.max(wall, 0)
  return Math.max(wall - (now.awakeMs - prevUptimeMs), 0)
}

export interface SleepGap { sleptMs: number; longGap: boolean }

/**
 * Compares the clocks with the pair the previous run stored, then stores the current pair. The
 * poller is a fresh process every hour, so the pair has to live in the database. The first ever run
 * has nothing to compare with and is not a long gap (every parcel it knows of is already due).
 */
export function checkSleepGap(db: Database, now: Clocks = readClocks()): SleepGap {
  const prev = db.prepare('SELECT wall_ms, uptime_ms FROM poll_clock WHERE id = 1').get() as
    { wall_ms: number; uptime_ms: number } | undefined
  db.prepare(`
    INSERT INTO poll_clock (id, wall_ms, uptime_ms) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET wall_ms = excluded.wall_ms, uptime_ms = excluded.uptime_ms
  `).run(now.wallMs, now.awakeMs)
  if (!prev) return { sleptMs: 0, longGap: false }
  const sleptMs = sleptSinceMs(prev.wall_ms, prev.uptime_ms, now)
  return { sleptMs, longGap: sleptMs > LONG_GAP_MS }
}
