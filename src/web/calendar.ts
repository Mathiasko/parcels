import { DateTime } from 'luxon'
import { icsCalendar, type IcsAlarm } from '../core/ics.js'
import { parcelName, pickupSummary, type Parcel } from '../db/parcels.js'
import { CARRIER_NAME, DISPLAY_ZONE, formatDay } from './views/format.js'
import { mapsUrl } from './views/index.js'

const PRODID = '-//parcels//Add to Calendar//EN'
const HOUR_MS = 3_600_000
/** SEQUENCE counts minutes from here, so it stays a small integer for decades. */
const SEQUENCE_EPOCH = Date.UTC(2020, 0, 1)

/**
 * A carrier that gives a deadline as a bare date is stored as that day's last instant, local time
 * (`parseStoredUntil` in carriers/packeta.ts, `parseDeadline` in carriers/posta.ts). Anything else is a
 * time the carrier actually named, and is worth printing.
 */
const isWholeDay = (t: DateTime): boolean => t.toFormat('HH:mm:ss.SSS') === '23:59:59.999'

/**
 * The local hour by which a parcel with no deadline should be thought about today: an event downloaded
 * before it is for today, reminded at this hour; one downloaded at or after it is for tomorrow, reminded
 * at 09:00. Late enough to be on the way home, early enough that the pickup point is still open.
 */
const COLLECT_TODAY_BY = 17

/**
 * One parcel waiting for collection as an all-day iCalendar event, for `GET /parcel/:id/calendar.ics`.
 * Only for a parcel `calendarUrl` offers it for. Two shapes, one event:
 *
 * - **With a deadline**, the event is on the deadline day, reminded at 09:00 the day before and 09:00
 *   on the day (each left out once its moment has passed), and the description says "Collect by".
 * - **Without one** (most carriers never send it), the event is a nudge to go soon: today if it is
 *   downloaded before 17:00 local, reminded at 17:00; otherwise tomorrow, reminded at 09:00. The
 *   description says the carrier gave no deadline rather than inventing one.
 *
 * Common to both:
 * - The day is a date in the display zone, so 00:30 local is that day, not the UTC day before; and a
 *   reminder's offset from local midnight is worked out on that very day, so on the days the clocks
 *   change 09:00 (or 17:00) is still 09:00, not an hour off.
 * - The URL is the Apple Maps link the pages print: the event lives on a phone, where this server's own
 *   address (loopback) means nothing.
 * - The opening code goes in the DESCRIPTION, which is the point - it is read at the locker - and never in
 *   the title or an alarm: those are what a lock screen shows, which is also why notifications leave it out.
 * - The UID is stable per parcel, and SEQUENCE is the download time in minutes, so every later download is
 *   a newer version of the SAME event (a deadline that arrived since, a new place, a code) rather than a
 *   second event, and an older file can never win over a newer one.
 */
export function parcelCalendar(p: Parcel, code: string | undefined, now: Date): string {
  const name = parcelName(p)
  const when = p.retainedTill ? byDeadline(p.retainedTill, name, now) : soon(p, name, now)
  // A reminder, as signed whole hours from the event's start (local midnight of its day).
  const alarms: IcsAlarm[] = when.alarms
    .map(a => ({ hours: Math.round((a.at.toMillis() - when.day.toMillis()) / HOUR_MS), description: a.description }))

  const { lat, lon } = p.pickup ?? {}
  return icsCalendar(PRODID, [{
    uid: `parcel-${p.id}-${p.trackingNumber}@parcels.local`,
    sequence: Math.max(0, Math.floor((now.getTime() - SEQUENCE_EPOCH) / 60_000)),
    stamp: now,
    date: { year: when.day.year, month: when.day.month, day: when.day.day },
    summary: `Pick up: ${name}`,
    location: pickupSummary(p),
    geo: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
    url: mapsUrl(p),
    description: [
      `${CARRIER_NAME[p.carrier]} · ${p.trackingNumber}`,
      ...(code ? [`Open the box with ${code}`] : []),
      when.line,
    ],
    alarms,
  }])
}

interface Timing {
  /** Local midnight of the event's one day. */
  day: DateTime
  /** The description's last line: what the deadline is, or that there is none. */
  line: string
  alarms: Array<{ at: DateTime; description: string }>
}

/** The deadline day, reminded at 09:00 the day before and on the day; a reminder already past is left out. */
function byDeadline(retainedTill: Date, name: string, now: Date): Timing {
  const till = DateTime.fromJSDate(retainedTill, { zone: DISPLAY_ZONE })
  const day = till.startOf('day')
  const time = isWholeDay(till) ? undefined : till.toFormat('HH:mm')
  return {
    day,
    line: `Collect by ${formatDay(retainedTill, now)}${time ? `, ${time}` : ''}`,
    alarms: [
      { at: at(day.minus({ days: 1 }), 9), description: `Pick up tomorrow: ${name}` },
      { at: at(day, 9), description: `Pick up today${time ? ` by ${time}` : ''}: ${name}` },
    ].filter(a => a.at.toMillis() > now.getTime()),
  }
}

/**
 * No deadline: today, reminded at 17:00, or - once it is 17:00 or later - tomorrow, reminded at 09:00.
 * Both reminders are always still to come, so nothing is filtered.
 */
function soon(p: Parcel, name: string, now: Date): Timing {
  const local = DateTime.fromJSDate(now, { zone: DISPLAY_ZONE })
  const today = local.hour < COLLECT_TODAY_BY
  const day = (today ? local : local.plus({ days: 1 })).startOf('day')
  return {
    day,
    line: `${CARRIER_NAME[p.carrier]} gave no pickup deadline — collect it soon`,
    alarms: [{ at: at(day, today ? COLLECT_TODAY_BY : 9), description: `Pick up: ${name}` }],
  }
}

/** That local day at a whole hour: on a day the clocks change, its distance from midnight is not `hour`. */
const at = (day: DateTime, hour: number): DateTime => day.set({ hour, minute: 0, second: 0, millisecond: 0 })

/**
 * `pick-up-topanky-zalando.ics`: ASCII only, because a header value is bytes and a browser's guess at
 * their encoding is not worth depending on. Falls back to the id when the name has nothing usable in it.
 */
export function calendarFilename(p: Parcel): string {
  const slug = parcelName(p).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '')
  return `pick-up-${slug || `parcel-${p.id}`}.ics`
}
