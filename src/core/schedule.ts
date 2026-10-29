import { DateTime } from 'luxon'

/**
 * The times of day the poller runs, in the Mac's local time: hourly 07:00 to 21:00, plus 15:30. The
 * 15:30 slot exists because the twice-daily "still waiting for you" reminder fires at 08:00 and 15:30,
 * and a reminder needs a run to fire from. Ordered, which nextSlot relies on.
 *
 * The launchd plist template carries the same list for the git install; a test parses the template and
 * checks it against this constant, so the two cannot drift apart unnoticed.
 */
export const POLL_SLOTS: readonly { hour: number; minute: number }[] = [
  { hour: 7, minute: 0 },
  { hour: 8, minute: 0 },
  { hour: 9, minute: 0 },
  { hour: 10, minute: 0 },
  { hour: 11, minute: 0 },
  { hour: 12, minute: 0 },
  { hour: 13, minute: 0 },
  { hour: 14, minute: 0 },
  { hour: 15, minute: 0 },
  { hour: 15, minute: 30 },
  { hour: 16, minute: 0 },
  { hour: 17, minute: 0 },
  { hour: 18, minute: 0 },
  { hour: 19, minute: 0 },
  { hour: 20, minute: 0 },
  { hour: 21, minute: 0 },
]

/**
 * The first slot strictly after `after`, so a time that is exactly a slot returns the next one (the
 * caller has just run that slot). Slots are wall-clock times in `zone` (default: the system zone), not
 * fixed UTC offsets, so a slot stays at 07:00 local across a daylight-saving change. No slot lies near
 * the 02:00-03:00 change window, so building each slot from its local date is unambiguous.
 */
export function nextSlot(after: Date, zone?: string): Date {
  const start = DateTime.fromJSDate(after, zone ? { zone } : {}).startOf('day')
  // Today's remaining slots, else tomorrow's first; a day offset of 1 always has a slot after `after`.
  for (let day = 0; day <= 1; day++) {
    for (const { hour, minute } of POLL_SLOTS) {
      const slot = start.plus({ days: day }).set({ hour, minute })
      if (slot.toMillis() > after.getTime()) return slot.toJSDate()
    }
  }
  // Unreachable: tomorrow's first slot is always after `after`.
  throw new Error('no poll slot found')
}

/**
 * True when a slot lies in (lastRunAt, now]: the poller was due at least once since it last ran. A
 * poller that has never run counts as having missed one. The interval is open at the start because a
 * slot exactly at the last run is the run itself.
 */
export function missedSlot(lastRunAt: Date | undefined, now: Date, zone?: string): boolean {
  if (lastRunAt === undefined) return true
  return nextSlot(lastRunAt, zone).getTime() <= now.getTime()
}
