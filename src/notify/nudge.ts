import { DateTime } from 'luxon'

/**
 * Local times at which a parcel still waiting for collection is mentioned again: once a day, in the
 * morning, when the day's plans are made. There used to be a 15:30 slot as well; two banners a day for a
 * parcel the reader already knows about read as nagging, and the afternoon one rarely changed a plan.
 * Still a list, and still keyed per slot (below), so a second time of day stays a one-line change.
 */
export const NUDGE_SLOTS = [{ hour: 8, minute: 0 }] as const

const ZONE = 'Europe/Bratislava'

/**
 * Every reminder slot that has already come round today, oldest first, as stable keys.
 *
 * Slots are keyed by local date and time rather than counted, because the poller is a fresh process
 * each run and may be late: a run at 10:00 must still be able to tell that the 08:00 slot has passed
 * and was never sent. Keying by date also means yesterday's rows can never suppress today's.
 */
export function passedSlots(now: Date): string[] {
  const local = DateTime.fromJSDate(now, { zone: ZONE })
  return NUDGE_SLOTS
    .map(s => local.set({ hour: s.hour, minute: s.minute, second: 0, millisecond: 0 }))
    .filter(t => t <= local)
    .map(t => t.toFormat("yyyy-MM-dd'T'HH:mm"))
}
