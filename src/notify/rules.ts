import { DateTime } from 'luxon'
import type { Database } from '../db/index.js'
import type { CanonicalStatus, CarrierId, NewEvent } from '../core/types.js'
import { getParcel, markAnnounced, type Parcel } from '../db/parcels.js'
import { carrierHealth, markCarrierNotified, type HealthRow } from '../db/health.js'
import type { Notification } from './types.js'

/** More notifications than this in one run (typically a catch-up after a long sleep) become one summary. */
const SUMMARY_ABOVE = 4
/** Consecutive transport (or parse) failures after which a carrier is announced as stale. */
const STALE_AFTER_FAILURES = 3
const DEADLINE_WINDOW_MS = 48 * 3_600_000
const DISPLAY_ZONE = 'Europe/Bratislava'

const STATUS_TITLE: Record<CanonicalStatus, string> = {
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

const CARRIER_NAME: Record<CarrierId, string> = {
  posta: 'Slovenská pošta', packeta: 'Packeta', gls: 'GLS', sps: 'SPS', dpd: 'DPD',
}

const parcelName = (p: Parcel): string => p.label ?? p.merchant ?? p.trackingNumber

function pickupLine(p: Parcel): string | undefined {
  if (!p.pickup) return undefined
  const place = [p.pickup.name, p.pickup.street].filter(Boolean).join(' ')
  return [place, p.pickup.city].filter(Boolean).join(', ') || undefined
}

const collectBy = (d: Date): string =>
  `collect by ${DateTime.fromJSDate(d, { zone: DISPLAY_ZONE }).setLocale('en').toFormat('ccc d LLL')}`

/**
 * Decides what to announce now, as the notifications to send, and RECORDS that it did. Despite the
 * name this writes to the database: it stamps each parcel's announced status / pickup point, each
 * deadline reminder and each carrier alarm as sent, in one transaction, before anything is
 * delivered. Delivery is best-effort, so a lost banner is preferred to a repeated one.
 *
 * The facts come from durable state, not from this run alone:
 * - A status transition is `parcels.status` differing from `last_announced_status`. It therefore
 *   needs no new event (Packeta and SPS change status with prose-only events), survives a run that
 *   had no notifier, and a transient `unknown` is not a transition. Never from `unnotifiedEvents`:
 *   every appended event is marked notified at append time so a newly added parcel's backfilled
 *   history cannot fire a burst of stale banners.
 * - `newEvents` (this run's inserted events) is used only for a repeat failed attempt, where the
 *   status does not change but a new attempt happened.
 *
 * Parcel updates beyond four collapse into one summary. Carrier alarms are infrastructure failures,
 * not parcel updates: they are never folded into that summary, so they can never be truncated out of it.
 */
export function buildNotifications(db: Database, newEvents: NewEvent[], now: Date, port: number): Notification[] {
  const base = `http://127.0.0.1:${port}`
  const sent = db.prepare('INSERT INTO deadline_reminders (parcel_id, notified_at) VALUES (?, ?)')
  const reminded = db.prepare('SELECT 1 FROM deadline_reminders WHERE parcel_id = ?')

  const { parcelUpdates, alarms } = db.transaction(() => {
    const parcelUpdates: Notification[] = []

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
      // Only while the parcel is *currently* failed, so a long-ago attempt in a freshly added parcel's
      // backfilled history is not mistaken for a live one.
      const failedAttempt = p.status === 'failed_attempt' && (transitioned || mine.some(e => e.status === 'failed_attempt'))
      const newPickup = p.pickup !== undefined && !p.pickupAnnounced && p.status !== 'unknown'
      const deadlineDue = p.status === 'ready_for_pickup' && p.retainedTill !== undefined
        && p.retainedTill > now && p.retainedTill.getTime() - now.getTime() <= DEADLINE_WINDOW_MS
        && reminded.get(id) === undefined
      if (!transitioned && !failedAttempt && !newPickup && !deadlineDue) continue

      const showPickup = p.status === 'ready_for_pickup' || newPickup
      const parts = [
        showPickup ? pickupLine(p) : undefined,
        p.status === 'ready_for_pickup' && p.retainedTill && p.retainedTill > now ? collectBy(p.retainedTill) : undefined,
      ].filter((s): s is string => s !== undefined)
      if (parts.length === 0) {
        parts.push(mine.at(-1)?.description || p.statusRaw || p.trackingNumber)
      }

      const headline = !transitioned && !failedAttempt && !newPickup ? 'Pickup deadline approaching' : STATUS_TITLE[p.status]
      parcelUpdates.push({
        groupKey: `parcel-${id}`,
        title: `${headline} — ${parcelName(p)}`,
        message: parts.join(' · '),
        url: `${base}/parcel/${id}`,
      })
      markAnnounced(db, id, p.status, p.pickup !== undefined)
      if (deadlineDue) sent.run(id, now.toISOString())
    }

    const alarms = carrierAlarms(carrierHealth(db), now).map(({ health, title, message }) => {
      markCarrierNotified(db, health.carrier, now)
      return { groupKey: `carrier-${health.carrier}`, title, message, url: `${base}/health` }
    })
    return { parcelUpdates, alarms }
  })()

  if (parcelUpdates.length <= SUMMARY_ABOVE) return [...parcelUpdates, ...alarms]
  return [{
    groupKey: 'summary',
    title: `${parcelUpdates.length} parcel updates`,
    message: parcelUpdates.map(n => n.title).join('; '),
    url: `${base}/`,
  }, ...alarms]
}

/**
 * Carriers that need announcing, once per outage (`notified_at` is cleared by the next `ok`).
 * `gated` always counts: the adapter itself is broken. A carrier that keeps timing out or returning
 * unreadable responses counts from its third consecutive failed run, unless every carrier touched in
 * this very run failed (two or more of them): that is the Mac being offline, not carriers breaking,
 * and it is left unannounced so it can be judged again once any carrier answers.
 */
function carrierAlarms(rows: HealthRow[], now: Date): Array<{ health: HealthRow; title: string; message: string }> {
  const at = now.getTime()
  const failedNow = (h: HealthRow) => h.lastErrorAt?.getTime() === at
  const touched = rows.filter(h => failedNow(h) || h.lastOkAt?.getTime() === at)
  const everyoneFailed = touched.length >= 2 && touched.every(failedNow)

  const out: Array<{ health: HealthRow; title: string; message: string }> = []
  for (const h of rows) {
    if (h.consecutiveFailures <= 0 || h.notifiedAt) continue
    const name = CARRIER_NAME[h.carrier]
    if (h.lastErrorKind === 'gated') {
      out.push({ health: h, title: `${name} tracking is broken`, message: `${name} is refusing requests; its adapter needs attention.` })
    } else if (h.lastErrorKind && h.consecutiveFailures >= STALE_AFTER_FAILURES && !everyoneFailed) {
      out.push(h.lastErrorKind === 'transport'
        ? { health: h, title: `${name} tracking is stale`, message: `${name} has not answered for ${h.consecutiveFailures} runs in a row; its parcels are not updating.` }
        : { health: h, title: `${name} tracking is stale`, message: `${name} replies could not be read for ${h.consecutiveFailures} runs in a row; its parcels are not updating.` })
    }
  }
  return out
}
