import { DateTime } from 'luxon'
import type { Database } from '../db/index.js'

/** The hours the machine is expected to be polling (local time); outside them it is asleep and silence is normal. */
const ZONE = 'Europe/Bratislava'
const WINDOW_START_HOUR = 7
const WINDOW_END_HOUR = 21

const HOUR = 3_600_000
/** /health flags the poller as not running once this much polling-window time has passed without a completed run. */
export const HEALTH_STALE_MS = 2 * HOUR
/** The poller announces (once) that it was away when it resumes after this much polling-window time. */
export const ALARM_STALE_MS = 6 * HOUR

/**
 * How much of [fromMs, toMs] falls inside the daily 07:00-21:00 window. Age is measured in this, not in
 * wall-clock time, because the Mac sleeps from about 21:00 to 07:00: the first poll of every morning
 * follows a ~10h wall-clock silence that is not an outage and must never be flagged.
 */
export function windowMsBetween(fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0
  let total = 0
  for (let day = DateTime.fromMillis(fromMs, { zone: ZONE }).startOf('day'); day.toMillis() < toMs; day = day.plus({ days: 1 }).startOf('day')) {
    const start = day.set({ hour: WINDOW_START_HOUR }).toMillis()
    const end = day.set({ hour: WINDOW_END_HOUR }).toMillis()
    total += Math.max(0, Math.min(end, toMs) - Math.max(start, fromMs))
  }
  return total
}

/** When the last completed poll was recorded (`last_poll`), or undefined if none ever was. */
export function lastPollMs(db: Database): number | undefined {
  const row = db.prepare('SELECT polled_at_ms FROM last_poll WHERE id = 1').get() as { polled_at_ms: number } | undefined
  return row?.polled_at_ms
}

/**
 * True when more than `thresholdMs` of window time has passed since `lastMs`. Deliberately not gated on
 * `now` being inside the window: window time already contributes nothing overnight, so a normal night
 * stays green by itself, while a dead poller is still flagged at 22:00 (when someone is likely to look)
 * and a night-time run after a long outage still announces it before `recordPoll` overwrites the evidence.
 */
export const pollerOverdue = (lastMs: number, now: Date, thresholdMs: number): boolean =>
  windowMsBetween(lastMs, now.getTime()) > thresholdMs

export interface PollerStatus { lastPollAt?: Date; overdue: boolean }

/** For the Health page. A database that cannot be read is "no data", never an error page. */
export function pollerStatus(db: Database, now: Date): PollerStatus {
  let last: number | undefined
  try { last = lastPollMs(db) } catch { /* no data */ }
  return last === undefined
    ? { overdue: false }
    : { lastPollAt: new Date(last), overdue: pollerOverdue(last, now, HEALTH_STALE_MS) }
}

/**
 * The once-per-outage banner for a poller that was away. Called while building a run's notifications,
 * i.e. BEFORE `recordPoll` stamps this run, so `last_poll` is still the previous run's time. The notice
 * remembers which previous poll it announced: the next run records a fresh time, so a later outage
 * starts from a different value and is announced afresh, while a re-run before that stays quiet.
 * (Its own table: a column on `last_poll` would break an existing database, which has no migrations.)
 */
export function stalePollAlarm(db: Database, now: Date): { title: string; message: string } | undefined {
  const last = lastPollMs(db)
  if (last === undefined || !pollerOverdue(last, now, ALARM_STALE_MS)) return undefined
  const seen = db.prepare('SELECT for_poll_ms FROM stale_poll_notice WHERE id = 1').get() as { for_poll_ms: number } | undefined
  if (seen?.for_poll_ms === last) return undefined
  db.prepare(`
    INSERT INTO stale_poll_notice (id, for_poll_ms, notified_at) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET for_poll_ms = excluded.for_poll_ms, notified_at = excluded.notified_at
  `).run(last, now.toISOString())
  const hours = Math.round(windowMsBetween(last, now.getTime()) / HOUR)
  return {
    title: 'Parcel polling was interrupted',
    message: `The poller had not run for about ${hours} hours of the 07:00-21:00 day before this run, so parcel updates were delayed. See Health.`,
  }
}
