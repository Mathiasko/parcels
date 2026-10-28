/**
 * Just enough iCalendar (RFC 5545) to hand one event to Calendar.app: no parser, no VTIMEZONE, no
 * recurrence. An event is either all-day (DATE values) or timed, and a timed one is written in UTC, which
 * the RFC allows without any time zone definition and every reader converts to its own local time. Pure string building, so every rule the format has is tested here and the
 * route only decides WHAT the event says.
 *
 * The rules that bite in practice, all handled below:
 *   - every line ends in CRLF, the last one included;
 *   - TEXT values escape `\` `;` `,` and newlines (and only TEXT values: a URL is a URI and is not escaped);
 *   - lines are folded at 75 OCTETS, not characters - a Slovak letter is two bytes in UTF-8 - and a fold
 *     never lands inside a character, or the reader gets a broken byte sequence on each side of it.
 */

export interface IcsDate { year: number; month: number; day: number }

export interface IcsAlarm {
  /**
   * When to fire, in signed whole hours from the start of the event; `0` is at the start. For an all-day event the start is
   * local midnight of its first day, so `-15` is 09:00 the day before and `9` is 09:00 on the day -
   * except on a day the clocks change, which is why the caller passes hours it has worked out rather
   * than this module assuming a 24-hour day.
   */
  hours: number
  description: string
}

interface IcsEventBase {
  uid: string
  sequence: number
  /** DTSTAMP: when this copy of the event was made. */
  stamp: Date
  summary: string
  location?: string
  geo?: { lat: number; lon: number }
  url?: string
  /** One entry per line of the description. */
  description?: string[]
  alarms?: IcsAlarm[]
}

/** The one day an all-day event covers, or the start and end of a timed one. */
export type IcsEvent = IcsEventBase & ({ date: IcsDate } | { start: Date; end: Date })

const CRLF = '\r\n'
const MAX_OCTETS = 75

/** RFC 5545 §3.3.11. The backslash goes first, or it would double the ones the other escapes add. */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    // Control characters other than tab are not allowed in TEXT at all; carrier strings can carry them.
    .replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, '')
}

/**
 * Folds one content line so that no physical line exceeds 75 octets (the CRLF not counted, the leading
 * space of a continuation line counted). Iterates by code point, so a character is never split, a
 * surrogate pair included.
 */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= MAX_OCTETS) return line
  const out: string[] = []
  let current = ''
  let size = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8')
    if (size + n > MAX_OCTETS) {
      out.push(current)
      current = ' '
      size = 1
    }
    current += ch
    size += n
  }
  out.push(current)
  return out.join(CRLF)
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

export const dateValue = (d: IcsDate): string => `${pad(d.year, 4)}${pad(d.month)}${pad(d.day)}`

/** The calendar day after `d`. Plain date arithmetic; UTC is used only as a calendar, never as a zone. */
export function nextDay(d: IcsDate): IcsDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + 1))
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() }
}

/** A DATE-TIME in UTC form (`20261026T100405Z`), as DTSTAMP requires and a timed DTSTART/DTEND may use. */
export const utcStamp = (d: Date): string =>
  `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`

/** A DURATION in whole hours: `PT9H`, `-PT15H`; zero is `PT0S`. */
export const hoursDuration = (h: number): string =>
  h === 0 ? 'PT0S' : `${h < 0 ? '-' : ''}PT${Math.abs(Math.trunc(h))}H`

/** Six decimals is ~10 cm, which is more than any carrier's coordinates carry. */
const coord = (n: number): string => String(Number(n.toFixed(6)))

function eventLines(e: IcsEvent): string[] {
  const text = (name: string, v: string | undefined) => (v === undefined || v === '' ? [] : [`${name}:${escapeText(v)}`])
  return [
    'BEGIN:VEVENT',
    `UID:${escapeText(e.uid)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(e.sequence))}`,
    `DTSTAMP:${utcStamp(e.stamp)}`,
    ...('date' in e
      // DTEND is exclusive: a one-day event ends at the start of the next day.
      ? [`DTSTART;VALUE=DATE:${dateValue(e.date)}`, `DTEND;VALUE=DATE:${dateValue(nextDay(e.date))}`]
      : [`DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(e.end)}`]),
    ...text('SUMMARY', e.summary),
    ...text('LOCATION', e.location),
    ...(e.geo ? [`GEO:${coord(e.geo.lat)};${coord(e.geo.lon)}`] : []),
    ...(e.url ? [`URL:${e.url}`] : []),
    // Each line escaped on its own, then joined by the escaped newline.
    ...(e.description?.length ? [`DESCRIPTION:${e.description.map(escapeText).join('\\n')}`] : []),
    // An all-day reminder is not an appointment and should not show the whole day as busy. A timed
    // event is a trip somebody planned, so it is left at the default (busy), as Calendar.app makes it.
    ...('date' in e ? ['TRANSP:TRANSPARENT'] : []),
    ...(e.alarms ?? []).flatMap(a => [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `TRIGGER:${hoursDuration(a.hours)}`,
      `DESCRIPTION:${escapeText(a.description)}`,
      'END:VALARM',
    ]),
    'END:VEVENT',
  ]
}

/** A complete VCALENDAR, folded, every line CRLF-terminated. */
export function icsCalendar(prodId: string, events: IcsEvent[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events.flatMap(eventLines),
    'END:VCALENDAR',
  ]
  return lines.map(foldLine).join(CRLF) + CRLF
}
