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
 * One parcel's pickup deadline as an all-day iCalendar event, for `GET /parcel/:id/calendar.ics`.
 * Only for a parcel `calendarUrl` offers it for; the deadline is required.
 *
 * - The day is the deadline's date in the display zone, so a deadline of 00:30 local is that day, not
 *   the UTC day before.
 * - The URL is the Apple Maps link the pages print: the event lives on a phone, where this server's own
 *   address (loopback) means nothing.
 * - The opening code goes in the DESCRIPTION, which is the point - it is read at the locker - and never in
 *   the title or an alarm: those are what a lock screen shows, which is also why notifications leave it out.
 * - The UID is stable per parcel, and SEQUENCE is the download time in minutes, so every later download is
 *   a newer version of the SAME event (new deadline, new place, a code that arrived since) rather than a
 *   second event, and an older file can never win over a newer one.
 */
export function parcelCalendar(p: Parcel, code: string | undefined, now: Date): string {
  if (!p.retainedTill) throw new Error(`parcel ${p.id} has no pickup deadline`)
  const till = DateTime.fromJSDate(p.retainedTill, { zone: DISPLAY_ZONE })
  const midnight = till.startOf('day')
  const name = parcelName(p)
  const time = isWholeDay(till) ? undefined : till.toFormat('HH:mm')

  // 09:00 local on a given day, as signed hours from the event's start (local midnight). Usually -15 and
  // 9, but on the day the clocks change 09:00 is 8 or 10 hours after midnight, and a fixed `PT9H` would
  // ring an hour off. A reminder that has already passed is left out: it would only fire as stale.
  const at9 = (dayOffset: number) => midnight.plus({ days: dayOffset }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
  const alarms: IcsAlarm[] = [
    { at: at9(-1), description: `Pick up tomorrow: ${name}` },
    { at: at9(0), description: `Pick up today${time ? ` by ${time}` : ''}: ${name}` },
  ].filter(a => a.at.toMillis() > now.getTime())
    .map(a => ({ hours: Math.round((a.at.toMillis() - midnight.toMillis()) / HOUR_MS), description: a.description }))

  const { lat, lon } = p.pickup ?? {}
  return icsCalendar(PRODID, [{
    uid: `parcel-${p.id}-${p.trackingNumber}@parcels.local`,
    sequence: Math.max(0, Math.floor((now.getTime() - SEQUENCE_EPOCH) / 60_000)),
    stamp: now,
    date: { year: midnight.year, month: midnight.month, day: midnight.day },
    summary: `Pick up: ${name}`,
    location: pickupSummary(p),
    geo: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
    url: mapsUrl(p),
    description: [
      `${CARRIER_NAME[p.carrier]} · ${p.trackingNumber}`,
      ...(code ? [`Open the box with ${code}`] : []),
      `Collect by ${formatDay(p.retainedTill, now)}${time ? `, ${time}` : ''}`,
    ],
    alarms,
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
