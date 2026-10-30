import { DateTime } from 'luxon'
import type { Database } from '../db/index.js'
import type { CanonicalStatus, CarrierId, NewEvent } from '../core/types.js'
import { DEFAULT_NOTIFICATIONS, type NotificationPrefs } from '../core/config.js'
import { getParcel, markAnnounced, parcelName, pickupSummary, type Parcel } from '../db/parcels.js'
import { carrierHealth, markCarrierNotified, type HealthRow } from '../db/health.js'
import { getIngestStatus, markIngestNotified } from '../db/ingest-status.js'
import { getUpdateCheck, markUpdateNotified } from '../db/update-state.js'
import { host } from '../core/host.js'
import { stalePollAlarm } from '../core/pollwatch.js'
import { passedSlots } from './nudge.js'
import type { Notification } from './types.js'

/** More notifications than this in one run (typically a catch-up after a long sleep) become one summary. */
const SUMMARY_ABOVE = 4
/** Consecutive transport (or parse) failures after which a carrier is announced as stale. */
const STALE_AFTER_FAILURES = 3
const DEADLINE_WINDOW_MS = 48 * 3_600_000
const DISPLAY_ZONE = 'Europe/Bratislava'

export const STATUS_TITLE: Record<CanonicalStatus, string> = {
  pre_transit: 'Registered',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  ready_for_pickup: 'Ready for pickup',
  delivered: 'Delivered',
  failed_attempt: 'Delivery attempt failed',
  returning: 'Returning to sender',
  returned: 'Returned to sender',
  problem: 'Delivery problem',
  unknown: 'Status unknown',
}

export const CARRIER_NAME: Record<CarrierId, string> = {
  posta: 'Slovenská pošta', packeta: 'Packeta', gls: 'GLS', sps: 'SPS', dpd: 'DPD', dhl: 'DHL',
}

const collectBy = (d: Date): string =>
  `collect by ${DateTime.fromJSDate(d, { zone: DISPLAY_ZONE }).setLocale('en').toFormat('ccc d LLL')}`

/** Appended to the daily reminder's message: the reminder is the one banner the reader can switch off by acting. */
const STOP_REMINDING = 'Collected it? Mark it in the app to stop these.'

/** Whole calendar days in Bratislava from `then` to `now`: 0 the same day, 1 the next, however late or early. */
const calendarDaysSince = (then: Date, now: Date): number => {
  const day = (d: Date) => DateTime.fromJSDate(d, { zone: DISPLAY_ZONE }).startOf('day')
  return Math.round(day(now).diff(day(then), 'days').days)
}

/**
 * The reminder's headline: `Still waiting since Tue` for an arrival one to six calendar days ago (in
 * Bratislava), `Still waiting since 3 Nov` from a week on, where a bare weekday would be ambiguous.
 * Counted from `lastChangedAt`, the newest carrier event - for a parcel sitting at a pickup point that
 * is its arrival there, and it is what the dashboard's "Since ..." shows. A day the reader can picture
 * replaced "· day 3", which made them count. Without a known arrival (or a nonsensical one, today or in
 * the future, which the ready-day rule keeps from reaching here anyway) it says no more than "for you".
 */
function waitingSince(p: Parcel, now: Date): string {
  if (!p.lastChangedAt) return 'Still waiting for you'
  const days = calendarDaysSince(p.lastChangedAt, now)
  if (days < 1) return 'Still waiting for you'
  const since = DateTime.fromJSDate(p.lastChangedAt, { zone: DISPLAY_ZONE }).setLocale('en')
  return `Still waiting since ${since.toFormat(days <= 6 ? 'ccc' : 'd LLL')}`
}

/**
 * Decides what to announce now, as the notifications to send, and RECORDS that it did. Despite the
 * name this writes to the database: it stamps each parcel's announced status / pickup point, each
 * deadline reminder and each carrier alarm as sent, in one transaction, before anything is
 * delivered. Delivery is best-effort, so a lost banner is preferred to a repeated one.
 *
 * The facts come from durable state, not from this run alone:
 * - A status transition is `parcels.status` differing from `last_announced_status`. It therefore
 *   needs no new event (Packeta and SPS change status with prose-only events), survives a run that
 *   had no notifier, and a transient `unknown` is not a transition. Never from individual events: a
 *   newly added parcel's backfilled history must not fire a burst of stale banners.
 * - `newEvents` (this run's inserted events) is used only for a repeat failed attempt, where the
 *   status does not change but a new attempt happened.
 *
 * `prefs` (the config's `notifications` switches) make some statuses QUIET: `pre_transit` and
 * `in_transit` while `progress` is off, and `delivered` while `delivered` is off or once the user has
 * marked the parcel themselves (a `user_marks` row: they already said they have it). A parcel in a quiet
 * status speaks neither for its transition nor for a new pickup point (DPD and Posta name one while the
 * parcel is still in transit; the ready-for-pickup banner carries it anyway), on that poll or a later
 * one. Both are still recorded with `markAnnounced`, so switching a switch on later releases no backlog.
 * Every other status is announced exactly as before.
 *
 * The daily reminder for a parcel waiting at a pickup point fires at the 08:00 slot, from the day AFTER
 * it arrived (the ready banner said it that day), and only while `prefs.dailyReminder` is on. Its slots
 * are marked spent whenever the parcel is waiting, reminded or not, so a reminder held back (the ready
 * day, the switch off) is never owed later: switching it on at 09:00 does not fire that morning's.
 *
 * Parcel updates beyond four collapse into one summary. Carrier alarms are infrastructure failures,
 * not parcel updates: they are never folded into that summary, so they can never be truncated out of it.
 */
export function buildNotifications(
  db: Database, newEvents: NewEvent[], now: Date, port: number, prefs: NotificationPrefs = DEFAULT_NOTIFICATIONS,
): Notification[] {
  const base = `http://127.0.0.1:${port}`
  const marked = db.prepare('SELECT 1 FROM user_marks WHERE parcel_id = ?')
  const sent = db.prepare('INSERT INTO deadline_reminders (parcel_id, notified_at) VALUES (?, ?)')
  const reminded = db.prepare('SELECT 1 FROM deadline_reminders WHERE parcel_id = ?')
  const nudged = db.prepare('SELECT 1 FROM pickup_nudges WHERE parcel_id = ? AND slot_key = ?')
  const nudge = db.prepare('INSERT OR IGNORE INTO pickup_nudges (parcel_id, slot_key, sent_at) VALUES (?, ?, ?)')
  const slots = passedSlots(now)
  const dueSlot = slots.at(-1)

  const { parcelUpdates, alarms } = db.transaction(() => {
    // `waiting` marks a parcel ready for pickup: those lead a summary (see below).
    const parcelUpdates: Array<Notification & { waiting: boolean }> = []

    const candidates = new Set((db.prepare(`
      SELECT id FROM parcels WHERE archived_at IS NULL AND (
        status <> last_announced_status OR status = 'ready_for_pickup'
        OR (pickup_kind IS NOT NULL AND pickup_announced = 0))
    `).all() as { id: number }[]).map(r => r.id))
    for (const e of newEvents) candidates.add(e.parcelId)

    for (const id of [...candidates].sort((a, b) => a - b)) {
      const p = getParcel(db, id)
      if (!p) continue
      const mine = newEvents.filter(e => e.parcelId === id)

      const transitioned = p.status !== p.lastAnnouncedStatus && p.status !== 'unknown'
      // A status the switches keep quiet (see above). The user_marks lookup only for a delivered parcel.
      const quiet = (p.status === 'pre_transit' || p.status === 'in_transit') ? !prefs.progress
        : p.status === 'delivered' ? !prefs.delivered || marked.get(id) !== undefined
          : false
      const speaks = transitioned && !quiet
      const pickupPending = p.pickup !== undefined && !p.pickupAnnounced && p.status !== 'unknown'
      // Only while the parcel is *currently* failed, so a long-ago attempt in a freshly added parcel's
      // backfilled history is not mistaken for a live one.
      const failedAttempt = p.status === 'failed_attempt' && (transitioned || mine.some(e => e.status === 'failed_attempt'))
      // Not in a quiet status: the pickup point is recorded as said (below), and the ready banner names it.
      const newPickup = pickupPending && !quiet
      const deadlineDue = p.status === 'ready_for_pickup' && p.retainedTill !== undefined
        && p.retainedTill > now && p.retainedTill.getTime() - now.getTime() <= DEADLINE_WINDOW_MS
        && reminded.get(id) === undefined
      // A parcel left waiting is mentioned again once a day, but not on the day it arrived: the ready
      // banner said it then (a parcel ready at 06:30 would otherwise be "still waiting" at 08:00). Only the
      // newest passed slot can fire, so a machine that was asleep all morning produces one reminder on
      // waking, not a burst of missed ones.
      const waiting = p.status === 'ready_for_pickup'
      const readyDay = p.lastChangedAt !== undefined && calendarDaysSince(p.lastChangedAt, now) === 0
      const nudgeDue = waiting && prefs.dailyReminder && !readyDay && dueSlot !== undefined
        && nudged.get(id, dueSlot) === undefined
      // Every slot already passed today is marked, not just the one that fired, and whether or not one
      // fired: an earlier slot that was missed (asleep, or the parcel only became ready this afternoon)
      // must not fire retroactively, a transition sent at 10:00 already told the reader what the 08:00 slot
      // would have, and a reminder held back (the ready day, the switch off) is not owed once that changes.
      if (waiting) for (const key of slots) nudge.run(id, key, now.toISOString())
      if (!speaks && !failedAttempt && !newPickup && !deadlineDue && !nudgeDue) {
        // What the quiet status kept back is recorded, so it is neither re-evaluated every run nor owed later.
        if (quiet && (transitioned || pickupPending)) markAnnounced(db, id, p.status, p.pickup !== undefined)
        continue
      }

      const showPickup = p.status === 'ready_for_pickup' || newPickup
      const parts = [
        showPickup ? pickupSummary(p) : undefined,
        p.status === 'ready_for_pickup' && p.retainedTill && p.retainedTill > now ? collectBy(p.retainedTill) : undefined,
      ].filter((s): s is string => s !== undefined)
      if (parts.length === 0) {
        parts.push(mine.at(-1)?.description || p.statusRaw || p.trackingNumber)
      }

      const reminder = !speaks && !failedAttempt && !newPickup && !deadlineDue
      const headline = speaks || failedAttempt || newPickup
        ? STATUS_TITLE[p.status]
        : deadlineDue ? 'Pickup deadline approaching' : waitingSince(p, now)
      // Only the reminder says how to stop it: it is the one banner that repeats until the reader acts.
      if (reminder) parts.push(STOP_REMINDING)
      parcelUpdates.push({
        groupKey: `parcel-${id}`,
        title: `${headline} — ${parcelName(p)}`,
        message: parts.join(' · '),
        url: `${base}/parcel/${id}`,
        waiting,
      })
      markAnnounced(db, id, p.status, p.pickup !== undefined)
      if (deadlineDue) sent.run(id, now.toISOString())
    }

    const health = carrierHealth(db)
    const alarms = carrierAlarms(health, now).map(({ health, title, message }) => {
      markCarrierNotified(db, health.carrier, now)
      return { groupKey: `carrier-${health.carrier}`, title, message, url: `${base}/health` }
    })
    const ingest = ingestAlarm(db, health, now)
    if (ingest) alarms.push({ groupKey: 'ingest', title: ingest.title, message: ingest.message, url: `${base}${ingest.page}` })
    const away = stalePollAlarm(db, now)
    if (away) alarms.push({ groupKey: 'poller', ...away, url: `${base}/health` })
    const update = updateAlarm(db)
    if (update) alarms.push({ groupKey: 'update', ...update, url: `${base}/health` })
    return { parcelUpdates, alarms }
  })()

  const updates = parcelUpdates.map(({ waiting: _, ...n }) => n)
  if (updates.length <= SUMMARY_ABOVE) return [...updates, ...alarms]
  // The banner text is capped (see send.ts), so what leads is what survives: parcels waiting to be
  // collected go first, because they are the ones that ask the reader to do something.
  const waitingFirst = [...parcelUpdates.filter(n => n.waiting), ...parcelUpdates.filter(n => !n.waiting)]
  return [{
    groupKey: 'summary',
    title: `${updates.length} parcel updates`,
    message: waitingFirst.map(n => n.title).join('; '),
    url: `${base}/`,
  }, ...alarms]
}

/** Two or more carriers touched in this run and all of them failed: the Mac is offline, not the services broken. */
function everyoneFailedThisRun(rows: HealthRow[], now: Date): boolean {
  const at = now.getTime()
  const failedNow = (h: HealthRow) => h.lastErrorAt?.getTime() === at
  const touched = rows.filter(h => failedNow(h) || h.lastOkAt?.getTime() === at)
  return touched.length >= 2 && touched.every(failedNow)
}

/**
 * The mail ingest, announced once per outage after `STALE_AFTER_FAILURES` consecutive failed runs (a
 * revoked App Password otherwise stops parcels appearing without a word). Like a stale carrier, it is held
 * back when every carrier failed in this same run, which is the Mac being offline.
 */
function ingestAlarm(db: Database, rows: HealthRow[], now: Date): { title: string; message: string; page: string } | undefined {
  const s = getIngestStatus(db)
  if (!s || s.consecutiveFailures < STALE_AFTER_FAILURES || s.notifiedAt) return undefined
  if (everyoneFailedThisRun(rows, now)) return undefined
  markIngestNotified(db, now)
  if (s.lastError !== undefined && AUTH_FAILURE.test(s.lastError)) {
    return {
      title: 'Mail ingest is failing',
      message: `Gmail has refused the login for ${s.consecutiveFailures} runs in a row: the App Password was probably revoked or changed. Make a new one and enter it in Settings.`,
      page: '/settings',
    }
  }
  return {
    title: 'Mail ingest is failing',
    message: `Mail ingest has failed for ${s.consecutiveFailures} runs in a row; new parcels may not appear. See Health.`,
    page: '/health',
  }
}

/**
 * What a rejected password looks like in the stored error text: Gmail's `[AUTHENTICATIONFAILED] Invalid
 * credentials`, imapflow's `AuthenticationFailure` (its class name, which the stored text starts with),
 * and the wording other servers use. Text, because text is all `ingest_status.last_error` keeps.
 */
const AUTH_FAILURE = /AUTHENTICATIONFAILED|AuthenticationFailure|invalid credentials|authentication failed|bad credentials|login failed/i

/**
 * A new version of the app, announced once per version.
 *
 * Keyed on the upstream commit rather than on a flag, which is what makes "once" mean once per
 * version and not once ever: the same `origin/main` commit is never announced twice, and the next
 * commit on it is a different sha and so is announced afresh. The same shape as
 * `stale_poll_notice.for_poll_ms`, for the same reason - the poller is a fresh process every hour, so
 * "already said" cannot live in memory.
 *
 * Only `behind` is announced. `current` is nothing to say; `ahead` is somebody's own commits, which
 * is not an update; and `blocked` is a checkout that cannot be updated at all, where a banner would
 * be a demand the reader can do nothing about (it is on /health, where it belongs).
 *
 * Never throws: it runs inside the transaction that records what every other notification announced.
 */
function updateAlarm(db: Database): { title: string; message: string } | undefined {
  try {
    const c = getUpdateCheck(db)
    if (!c || c.state !== 'behind') return undefined
    // The Mac app's check compares releases and has no commit, so there the release's version is the
    // key: one announcement per new version, exactly as one per upstream commit is in the git install.
    // Only in the app: under git a check without a commit stays unannounced, as it always was.
    const app = host() === 'app'
    const key = c.remoteSha ?? (app ? c.version : undefined)
    if (key === undefined || c.notifiedSha === key) return undefined
    markUpdateNotified(db, key)
    if (app) {
      return {
        title: 'A Parcels update is available',
        message: `Parcels ${c.version} is out — open Health and press Update now.`,
      }
    }
    return {
      title: 'A parcels update is available',
      message: 'A new version is ready — open Health and press Update now.',
    }
  } catch {
    return undefined
  }
}

/**
 * Carriers that need announcing, once per outage (`notified_at` is cleared by the next `ok`).
 * `gated` always counts: the adapter itself is broken. A carrier that keeps timing out or returning
 * unreadable responses counts from its third consecutive failed run, unless every carrier touched in
 * this very run failed (two or more of them): that is the Mac being offline, not carriers breaking,
 * and it is left unannounced so it can be judged again once any carrier answers.
 */
function carrierAlarms(rows: HealthRow[], now: Date): Array<{ health: HealthRow; title: string; message: string }> {
  const everyoneFailed = everyoneFailedThisRun(rows, now)

  const out: Array<{ health: HealthRow; title: string; message: string }> = []
  for (const h of rows) {
    if (h.consecutiveFailures <= 0 || h.notifiedAt) continue
    const name = CARRIER_NAME[h.carrier]
    if (h.lastErrorKind === 'gated') {
      out.push({ health: h, title: `${name} tracking is broken`, message: `Tracking for ${name} isn't working right now. It probably needs an app update.` })
    } else if (h.lastErrorKind && h.consecutiveFailures >= STALE_AFTER_FAILURES && !everyoneFailed) {
      out.push(h.lastErrorKind === 'transport'
        ? { health: h, title: `${name} tracking is stale`, message: `${name} has not answered for ${h.consecutiveFailures} runs in a row; its parcels are not updating.` }
        : { health: h, title: `${name} tracking is stale`, message: `${name} replies could not be read for ${h.consecutiveFailures} runs in a row; its parcels are not updating.` })
    }
  }
  return out
}
