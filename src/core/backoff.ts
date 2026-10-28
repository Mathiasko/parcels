import { DateTime } from 'luxon'
import { isEmailOnlyCarrier, isTerminalStatus } from './types.js'
import type { Parcel } from '../db/parcels.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The mid tier is "every third slot" and the slow tier "once a day", measured as time since the last poll. */
const MID_TIER_MIN_GAP = 2.5 * HOUR
const SLOW_TIER_MIN_GAP = 20 * HOUR

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

const isTerminal = (p: Parcel): boolean => isTerminalStatus(p.status)

/** Parcels the carrier is about to hand over (or hold only briefly) are polled every slot, whatever their age. */
function isUrgent(p: Parcel, now: Date): boolean {
  if (p.status === 'out_for_delivery' || p.status === 'ready_for_pickup') return true
  if (p.retainedTill) {
    const untilDeadline = p.retainedTill.getTime() - now.getTime()
    if (untilDeadline >= 0 && untilDeadline <= 2 * DAY) return true
  }
  return false
}

/**
 * A parcel that has never produced a single event in 30 days: no longer polled, and worth surfacing to
 * the user. Derived here, not stored, so the poller and the UI cannot disagree about it.
 *
 * An email-only carrier's parcel is never dormant: dormancy means "we have stopped asking", and
 * nobody ever asked. Saying it on /attention ("no tracking event for over 30 days, so they are no
 * longer polled") would be two false claims about a parcel that is behaving exactly as designed.
 */
export function isDormant(p: Parcel, now: Date): boolean {
  if (isEmailOnlyCarrier(p.carrier)) return false
  return !isTerminal(p) && !isUrgent(p, now)
    && p.lastChangedAt === undefined && now.getTime() - p.firstSeenAt.getTime() > 30 * DAY
}

/**
 * Whether `p` should be polled now (spec section 9). The idle clock runs from the last carrier
 * movement; `lastChangedAt` is only ever set when an event is seen, so its absence means the parcel
 * has never had one and its age is counted from `firstSeenAt` instead.
 *
 * The slower tiers are expressed as time since `lastPolledAt`, not as a position in the slot grid:
 * this Mac sleeps through whole slots, and a rule keyed on "slot 0" or "slot % 3" would skip a
 * parcel for a day if the Mac happened not to be awake then. The gap runs from the later of
 * `lastPolledAt` (last real answer) and `lastAttemptedAt` (last try, answered or not), so a parcel
 * that keeps failing backs off exactly like a healthy one instead of retrying every slot. `slot`
 * stays in the signature as part of the contract; the every-slot tiers need no gap check.
 */
export function isDue(p: Parcel, now: Date, _slot: number): boolean {
  // Nothing is ever due for a carrier that is never polled, whatever the tiers would say. The poller
  // has its own guard (it holds under `forceAll` too, which skips this function); this keeps the
  // answer to "is this parcel due?" honest for every other caller.
  if (isEmailOnlyCarrier(p.carrier)) return false
  if (isTerminal(p)) return false
  if (isUrgent(p, now)) return true
  if (isDormant(p, now)) return false

  const idle = now.getTime() - (p.lastChangedAt ?? p.firstSeenAt).getTime()
  if (idle <= 2 * DAY) return true

  const lastTried = Math.max(p.lastPolledAt?.getTime() ?? -Infinity, p.lastAttemptedAt?.getTime() ?? -Infinity)
  return now.getTime() - lastTried >= (idle <= 7 * DAY ? MID_TIER_MIN_GAP : SLOW_TIER_MIN_GAP)
}
