import { DateTime } from 'luxon'
import type { CalendarEventSpec } from '../core/calendar-app.js'
import { icsCalendar } from '../core/ics.js'
import { parcelName, pickupSummary, type Parcel } from '../db/parcels.js'
import { wallClock } from './calendar-slots.js'
import { CARRIER_NAME, DISPLAY_ZONE, formatDay } from './views/format.js'
import { mapsUrl } from './views/index.js'

const PRODID = '-//parcels//Add to Calendar//EN'
/** SEQUENCE counts minutes from here, so it stays a small integer for decades. */
const SEQUENCE_EPOCH = Date.UTC(2020, 0, 1)

/** How long the planned trip is in the calendar: long enough to see, short enough not to block an afternoon. */
export const EVENT_MINUTES = 30

/**
 * A carrier that gives a deadline as a bare date is stored as that day's last instant, local time
 * (`parseStoredUntil` in carriers/packeta.ts, `parseDeadline` in carriers/posta.ts). Anything else is a
 * time the carrier actually named, and is worth printing.
 */
const isWholeDay = (t: DateTime): boolean => t.toFormat('HH:mm:ss.SSS') === '23:59:59.999'

/**
 * What a pickup event SAYS, whichever way it reaches the calendar: Calendar.app through osascript
 * (`pickupEventSpec`) or the downloadable .ics (`parcelCalendar`). One function, so the two cannot say
 * different things.
 *
 * - Title `Pick up: <name>`. Location the pickup address; the URL the Apple Maps link the pages print
 *   (the event lives on a phone, where this server's own loopback address means nothing).
 * - Description: carrier and tracking number, the locker code when one is stored, and the REAL deadline
 *   ("Collect by Sat 31 Oct, 18:00"), or that the carrier gave none - the event's own time is the plan,
 *   and the deadline is what the plan has to beat.
 * - The opening code goes in the description, which is the point - it is read at the locker - and never
 *   in the title or the alert: those are what a lock screen shows, which is also why notifications leave
 *   it out.
 */
export interface PickupEventContent {
  summary: string
  location?: string
  url?: string
  geo?: { lat: number; lon: number }
  description: string[]
}

export function pickupEventContent(p: Parcel, code: string | undefined, now: Date): PickupEventContent {
  const { lat, lon } = p.pickup ?? {}
  return {
    summary: `Pick up: ${parcelName(p)}`,
    location: pickupSummary(p),
    url: mapsUrl(p),
    geo: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
    description: [
      `${CARRIER_NAME[p.carrier]} · ${p.trackingNumber}`,
      ...(code ? [`Open the box with ${code}`] : []),
      deadlineLine(p, now),
    ],
  }
}

/** `Collect by Sat 31 Oct, 18:00`, `Collect by Sat 31 Oct` for a whole-day deadline, or that there is none. */
function deadlineLine(p: Parcel, now: Date): string {
  if (!p.retainedTill) return `${CARRIER_NAME[p.carrier]} gave no pickup deadline`
  const till = DateTime.fromJSDate(p.retainedTill, { zone: DISPLAY_ZONE })
  return `Collect by ${formatDay(p.retainedTill, now)}${isWholeDay(till) ? '' : `, ${till.toFormat('HH:mm')}`}`
}

/** The event for Calendar.app: the same content, a wall-clock start in the display zone, 30 minutes. */
export function pickupEventSpec(p: Parcel, code: string | undefined, start: Date, now: Date): CalendarEventSpec {
  const c = pickupEventContent(p, code, now)
  return {
    summary: c.summary, location: c.location, url: c.url, description: c.description.join('\n'),
    start: wallClock(start), minutes: EVENT_MINUTES,
  }
}

/**
 * The same event as an .ics file, for `GET /parcel/:id/calendar.ics` - the fallback when Calendar.app
 * could not be driven. A 30-minute event at the chosen time with one alert at its start, exactly what
 * the osascript path makes. Times are written in UTC (see core/ics.ts), so the file means the same
 * moment on any device.
 *
 * The UID is stable per parcel, and SEQUENCE is the download time in minutes, so a later download is a
 * newer version of the SAME event (another time, a deadline that arrived since, a code) rather than a
 * second event, and an older file can never win over a newer one.
 */
export function parcelCalendar(p: Parcel, code: string | undefined, start: Date, now: Date): string {
  const c = pickupEventContent(p, code, now)
  return icsCalendar(PRODID, [{
    uid: `parcel-${p.id}-${p.trackingNumber}@parcels.local`,
    sequence: Math.max(0, Math.floor((now.getTime() - SEQUENCE_EPOCH) / 60_000)),
    stamp: now,
    start,
    end: new Date(start.getTime() + EVENT_MINUTES * 60_000),
    ...c,
    alarms: [{ hours: 0, description: c.summary }],
  }])
}

/**
 * `pick-up-topanky-zalando.ics`: ASCII only, because a header value is bytes and a browser's guess at
 * their encoding is not worth depending on. Falls back to the id when the name has nothing usable in it.
 */
export function calendarFilename(p: Parcel): string {
  const slug = parcelName(p).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '')
  return `pick-up-${slug || `parcel-${p.id}`}.ics`
}
