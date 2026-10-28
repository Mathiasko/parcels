import { DateTime } from 'luxon'
import type { WallClock } from '../core/calendar-app.js'
import { DISPLAY_ZONE } from './views/format.js'

/**
 * When the "Add to Calendar" form lets you plan the pickup: a day, and one of three times or one of your
 * own ("Other", any `HH:MM`). Pure, so the
 * form, the POST that validates it and the .ics fallback all ask the same question and get the same
 * answer - a slot the form offers is exactly a slot the server accepts.
 *
 * Every date here is a calendar date in the display zone (Europe/Bratislava), written `YYYY-MM-DD`, and
 * every time is a local wall-clock time. The page has no script, so "the past" is decided here, on the
 * server's clock, and a slot the browser still offers after it has passed is refused by the POST.
 */

/** The preset times. 24-hour, Slovak convention. The value the form sends; `timeLabel` is what it shows. */
export const PICKUP_TIMES = ['09:00', '13:00', '17:00'] as const
export type PickupTime = typeof PICKUP_TIMES[number]

/** How many days, today included, the form offers for a parcel whose carrier gave no deadline. */
export const NO_DEADLINE_DAYS = 7

/**
 * Today is still offered with no preset left (after 17:00) while there is a whole hour to go: the form
 * then offers only "Other", filled in with the next full hour.
 */
export const LAST_OTHER_HOUR = 23

/** `09:00` as it is said and printed: `9:00`. */
export const timeLabel = (t: string): string => t.replace(/^0(\d)/, '$1')

export interface SlotDay {
  /** `2026-10-30`, the value the form sends. */
  date: string
  /** `Today`, `Tomorrow`, `Fri 30 Oct`, with `— last day` on the deadline's own day. */
  label: string
  /** The carrier's deadline falls on this day. */
  last: boolean
  /** The preset times still to come on this day: all three, except on today, where it can be none. */
  times: PickupTime[]
  /** The time to check by default on this day: its first preset still to come, else the next full hour. */
  first: string
}

export interface Slots {
  days: SlotDay[]
  /** What the form checks by default. Absent only when `days` is empty. */
  day?: string
  time?: string
  /** The moment these were worked out at: a time on today must come after it. */
  now: Date
}

const local = (d: Date): DateTime => DateTime.fromJSDate(d, { zone: DISPLAY_ZONE }).setLocale('en')
const isoDay = (t: DateTime): string => t.toFormat('yyyy-LL-dd')

/** A wall-clock time as the form sends it: `HH:MM`, 00:00 to 23:59. Any minute, not only the presets. */
export const isTime = (t: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)

/** The instant a day and time stand for, in the display zone; undefined for anything malformed. */
export function slotStart(day: string, time: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isTime(time)) return undefined
  const t = DateTime.fromISO(`${day}T${time}`, { zone: DISPLAY_ZONE })
  return t.isValid ? t.toJSDate() : undefined
}

/**
 * The days and times to offer.
 *
 * - **A deadline in the future:** every day from today to the deadline's local date, inclusive. The
 *   deadline's day is the default and says `— last day`.
 * - **A deadline that is today or already past:** today only. Planning a trip for after the carrier
 *   sends the parcel back is not something to offer.
 * - **No deadline:** today and the six days after it. The default is today, or tomorrow once today has
 *   nothing left.
 *
 * On today, a preset that has come is not offered. Once all three have gone (after 17:00), today is still
 * offered until 23:00, for "Other" only, which then defaults to the next full hour; after 23:00 it is not
 * offered at all. When today is one of several days and some of its presets have gone, its label says
 * from when it still works ("Today, from 13:00", "Today, after 17:00"), because the time radios are
 * shared by all the days and cannot say it themselves. The default time is the first preset still to
 * come on the default day, else the next full hour.
 *
 * The deadline's TIME is deliberately not a limit here: the event is a plan for the trip, and its
 * description prints the real deadline ("Collect by Sat 31 Oct, 18:00").
 */
export function pickupSlots(retainedTill: Date | undefined, now: Date): Slots {
  const today = local(now).startOf('day')
  const lastDay = retainedTill ? local(retainedTill).startOf('day') : undefined
  const count = lastDay === undefined ? NO_DEADLINE_DAYS
    : lastDay <= today ? 1
    : Math.round(lastDay.diff(today, 'days').days) + 1
  const days: SlotDay[] = []
  for (let i = 0; i < count; i++) {
    const day = today.plus({ days: i })
    const date = isoDay(day)
    const times = PICKUP_TIMES.filter(t => slotStart(date, t)!.getTime() > now.getTime())
    // Only today can have no preset left; it stays while a whole hour is still to come.
    const next = local(now).hour + 1
    if (times.length === 0 && next > LAST_OTHER_HOUR) continue
    const first = times[0] ?? `${String(next).padStart(2, '0')}:00`
    // The deadline's own day; a deadline already past has no day here to name.
    const last = lastDay !== undefined && day.hasSame(lastDay, 'day')
    const name = i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
      : day.year === today.year ? day.toFormat('ccc d LLL') : day.toFormat('ccc d LLL yyyy')
    const from = i === 0 && count > 1 && times.length < PICKUP_TIMES.length
      ? times.length > 0 ? `, from ${timeLabel(times[0]!)}` : `, after ${timeLabel(PICKUP_TIMES.at(-1)!)}`
      : ''
    days.push({ date, label: `${name}${from}${last ? ' — last day' : ''}`, last, times, first })
  }
  const pick = lastDay !== undefined ? days.at(-1) : days[0]
  return pick ? { days, day: pick.date, time: pick.first, now } : { days, now }
}

/** Whether a submitted day and time is one the form allows right now: a day it offers, at any time still to come. */
export function slotAllowed(slots: Slots, day: string, time: string): boolean {
  const start = slotStart(day, time)
  return start !== undefined && start.getTime() > slots.now.getTime() && slots.days.some(d => d.date === day)
}

/** An instant as the wall clock in the display zone reads it. */
export function wallClock(d: Date): WallClock {
  const t = local(d)
  return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute }
}

/** `2026-10-30` and `13:00` for an instant: the form's values for a stored event. */
export const slotOf = (d: Date): { day: string; time: string } => ({ day: isoDay(local(d)), time: local(d).toFormat('HH:mm') })

/** `Fri 30 Oct, 13:00` - the day as the radios name it (with the year only when it is not this one), and the time. */
export function formatSlot(d: Date, now: Date): string {
  const t = local(d)
  const day = t.year === local(now).year ? t.toFormat('ccc d LLL') : t.toFormat('ccc d LLL yyyy')
  return `${day}, ${timeLabel(t.toFormat('HH:mm'))}`
}
