import { DateTime } from 'luxon'
import type { Parcel } from '../db/parcels.js'

const DAY = 24 * 3_600_000

const WINDOW_ZONE = 'Europe/Bratislava'
const FIRST_HOUR = 7
const SLOT_COUNT = 15   // 07:00 .. 21:00 inclusive

/**
 * Position of `now`'s hour in the 07:00-21:00 Europe/Bratislava polling window: 07:00 is slot 0,
 * 21:00 is slot 14. A run outside the window (manual, or a late catch-up after sleep) clamps to
 * the nearest end rather than inventing a slot.
 */
export function slotFor(now: Date): number {
  const hour = DateTime.fromJSDate(now, { zone: WINDOW_ZONE }).hour
  return Math.min(Math.max(hour - FIRST_HOUR, 0), SLOT_COUNT - 1)
}

/**
 * Whether `p` should be polled in this slot (spec section 9). The idle clock runs from the last
 * carrier movement; `lastChangedAt` is only ever set when an event is seen, so its absence means
 * the parcel has never had one and its age is counted from `firstSeenAt` instead.
 */
export function isDue(p: Parcel, now: Date, slot: number): boolean {
  if (p.status === 'delivered' || p.status === 'returned') return false
  if (p.status === 'out_for_delivery' || p.status === 'ready_for_pickup') return true
  if (p.retainedTill) {
    const untilDeadline = p.retainedTill.getTime() - now.getTime()
    if (untilDeadline >= 0 && untilDeadline <= 2 * DAY) return true
  }

  const idle = now.getTime() - (p.lastChangedAt ?? p.firstSeenAt).getTime()
  if (p.lastChangedAt === undefined && idle > 30 * DAY) return false   // dormant: never had an event
  if (idle <= 2 * DAY) return true
  if (idle <= 7 * DAY) return slot % 3 === 0
  return slot === 0
}
