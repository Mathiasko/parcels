import { DateTime } from 'luxon'
import type { Database } from '../db/index.js'
import type { CanonicalStatus, CarrierId, NewEvent } from '../core/types.js'
import { getParcel, listActive, type Parcel } from '../db/parcels.js'
import { carrierHealth, markCarrierNotified } from '../db/health.js'
import type { Notification } from './types.js'

/** The parcels as they were before a run touched them, by id. */
export type ParcelSnapshot = ReadonlyMap<number, Parcel>

export const snapshot = (db: Database): ParcelSnapshot => new Map(listActive(db).map(p => [p.id, p]))

/** More notifications than this in one run (typically a catch-up after a long sleep) become one summary. */
const SUMMARY_ABOVE = 4
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
 * What this run's results warrant announcing, as the notifications to send (already coalesced).
 *
 * Works from `newEvents` (the events this run inserted) and `before` (the parcels as they stood when
 * the run began), never from `unnotifiedEvents`: every appended event was marked notified at append
 * time, so a newly added parcel's backfilled history cannot fire a burst of stale banners.
 *
 * A status transition is found by comparing each parcel's stored status before and after, not by
 * looking at event statuses: carriers with prose-only events (Packeta, SPS) change status with no
 * new event at all.
 *
 * Side effect: the one-shot facts it announces (a parcel's deadline reminder, a carrier's gated
 * alarm) are recorded as sent here, in one transaction, before anything is delivered. Delivery is
 * best-effort, so a lost banner is preferred to a repeated one.
 */
export function buildNotifications(
  db: Database, newEvents: NewEvent[], now: Date, port: number, before: ParcelSnapshot,
): Notification[] {
  const base = `http://127.0.0.1:${port}`
  const sent = db.prepare('INSERT INTO deadline_reminders (parcel_id, notified_at) VALUES (?, ?)')
  const reminded = db.prepare('SELECT 1 FROM deadline_reminders WHERE parcel_id = ?')

  const out = db.transaction((): Notification[] => {
    const list: Notification[] = []

    for (const [id, was] of before) {
      const p = getParcel(db, id)
      if (!p) continue
      const mine = newEvents.filter(e => e.parcelId === id)

      const transitioned = p.status !== was.status && p.status !== 'unknown'
      // Only while the parcel is *currently* failed, so a long-ago attempt in a freshly added parcel's
      // backfilled history is not mistaken for a live one.
      const failedAttempt = p.status === 'failed_attempt' && (transitioned || mine.some(e => e.status === 'failed_attempt'))
      const newPickup = was.pickup === undefined && p.pickup !== undefined
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
      list.push({
        groupKey: `parcel-${id}`,
        title: `${headline} — ${parcelName(p)}`,
        message: parts.join(' · '),
        url: `${base}/parcel/${id}`,
      })
      if (deadlineDue) sent.run(id, now.toISOString())
    }

    for (const h of carrierHealth(db)) {
      if (h.lastErrorKind !== 'gated' || h.consecutiveFailures <= 0 || h.notifiedAt) continue
      list.push({
        groupKey: `carrier-${h.carrier}`,
        title: `${CARRIER_NAME[h.carrier]} tracking is broken`,
        message: `${CARRIER_NAME[h.carrier]} is refusing requests; its adapter needs attention.`,
        url: `${base}/health`,
      })
      markCarrierNotified(db, h.carrier, now)
    }
    return list
  })()

  if (out.length <= SUMMARY_ABOVE) return out
  return [{
    groupKey: 'summary',
    title: `${out.length} parcel updates`,
    message: out.map(n => n.title).join('; '),
    url: `${base}/`,
  }]
}
