import { DateTime } from 'luxon'

/** Local times at which a parcel still waiting for collection is mentioned again. */
export const NUDGE_SLOTS = [{ hour: 8, minute: 0 }, { hour: 15, minute: 30 }] as const

const ZONE = 'Europe/Bratislava'

/**
 * Every reminder slot that has already come round today, oldest first, as stable keys.
 *
 * Slots are keyed by local date and time rather than counted, because the poller is a fresh process
 * each run and may be late: a run at 16:00 must still be able to tell that the 15:30 slot has passed
 * and was never sent. Keying by date also means yesterday's rows can never suppress today's.
 */
export function passedSlots(now: Date): string[] {
  const local = DateTime.fromJSDate(now, { zone: ZONE })
  return NUDGE_SLOTS
    .map(s => local.set({ hour: s.hour, minute: s.minute, second: 0, millisecond: 0 }))
    .filter(t => t <= local)
    .map(t => t.toFormat("yyyy-MM-dd'T'HH:mm"))
}
