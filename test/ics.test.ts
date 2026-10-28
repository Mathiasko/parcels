import { describe, expect, test } from 'vitest'
import {
  dateValue, escapeText, foldLine, hoursDuration, icsCalendar, nextDay, utcStamp, type IcsEvent,
} from '../src/core/ics.js'

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')
/** RFC 5545 §3.1 unfolding: a CRLF followed by one space or tab is removed. */
const unfold = (s: string): string => s.replace(/\r\n[ \t]/g, '')

const EVENT: IcsEvent = {
  uid: 'parcel-7-Z1172430119@parcels.local',
  sequence: 3,
  stamp: new Date('2026-10-26T10:00:00Z'),
  date: { year: 2026, month: 10, day: 29 },
  summary: 'Pick up: Bratiska',
  location: 'Z-BOX, Bottova 6, Bratislava',
  geo: { lat: 48.1452, lon: 17.1257 },
  url: 'https://maps.apple.com/?ll=48.1452,17.1257&q=Z-BOX',
  description: ['Packeta · Z1172430119', 'Collect by Thu 29 Oct'],
  alarms: [{ hours: -15, description: 'Collect tomorrow: Bratiska' }, { hours: 9, description: 'Collect today: Bratiska' }],
}

describe('TEXT escaping', () => {
  test('backslash, semicolon, comma and newline are escaped, backslash first', () => {
    expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne')
    // Escaping the backslash last would double the ones the other escapes just added.
    expect(escapeText(';')).toBe('\\;')
    expect(escapeText('\\n')).toBe('\\\\n')
  })

  test('CRLF and a lone CR become one escaped newline, and other control characters are dropped', () => {
    expect(escapeText('a\r\nb\rc')).toBe('a\\nb\\nc')
    expect(escapeText('a\u0000b\u0007c\td')).toBe('abc\td')
  })

  test('a colon and diacritics need no escaping', () => {
    expect(escapeText('Pošta: Nám. SNP 35')).toBe('Pošta: Nám. SNP 35')
  })
})

describe('line folding, by octets', () => {
  test('a line of 75 octets or fewer is left alone', () => {
    const line = `SUMMARY:${'a'.repeat(67)}`
    expect(bytes(line)).toBe(75)
    expect(foldLine(line)).toBe(line)
  })

  test('a long ASCII line folds at exactly 75 octets, continuation lines included', () => {
    const line = `DESCRIPTION:${'x'.repeat(200)}`
    const folded = foldLine(line)
    const lines = folded.split('\r\n')
    expect(lines.length).toBeGreaterThan(2)
    expect(bytes(lines[0]!)).toBe(75)
    for (const l of lines.slice(1, -1)) expect(bytes(l)).toBe(75)   // the leading space counts
    for (const l of lines.slice(1)) expect(l.startsWith(' ')).toBe(true)
    expect(unfold(folded)).toBe(line)
  })

  test('counts UTF-8 bytes, not characters: 50 Slovak letters are 100 octets and must fold', () => {
    const line = `LOCATION:${'ž'.repeat(50)}`
    expect(line.length).toBe(59)                          // would pass a character count
    const lines = foldLine(line).split('\r\n')
    expect(lines.length).toBe(2)
    for (const l of lines) expect(bytes(l)).toBeLessThanOrEqual(75)
  })

  test('never splits a multi-byte character, even when the 75th octet falls inside it', () => {
    // 8 + 66 = 74 octets, and "ž" is two: it cannot fit and must move whole to the next line.
    const line = `SUMMARY:${'a'.repeat(66)}žluťoučký kůň`
    const lines = foldLine(line).split('\r\n')
    expect(bytes(lines[0]!)).toBe(74)
    expect(lines[1]!.startsWith(' ž')).toBe(true)
    // Each physical line is valid UTF-8 on its own: no replacement characters after a byte round trip.
    for (const l of lines) expect(Buffer.from(l, 'utf8').toString('utf8')).not.toContain('�')
    expect(unfold(lines.join('\r\n'))).toBe(line)
  })

  test('a four-byte character (a surrogate pair in JS) is kept whole too', () => {
    const line = `SUMMARY:${'a'.repeat(65)}📦📦📦`
    const lines = foldLine(line).split('\r\n')
    expect(bytes(lines[0]!)).toBe(73)                     // 73 + 4 would be 77
    expect(lines[1]).toBe(' 📦📦📦')
    expect(lines.join('')).not.toContain('�')
  })

  test('folding a long run of diacritics keeps every line within 75 octets and unfolds to the original', () => {
    const line = `DESCRIPTION:${'Zásielka je pripravená na vyzdvihnutie, Žilina. '.repeat(8)}`
    const folded = foldLine(line)
    const lines = folded.split('\r\n')
    for (const l of lines) expect(bytes(l)).toBeLessThanOrEqual(75)
    // Every line but the last is full: short of 75 by at most the one 2-byte letter that did not fit.
    for (const l of lines.slice(0, -1)) expect(bytes(l)).toBeGreaterThanOrEqual(74)
    expect(unfold(folded)).toBe(line)
  })
})

describe('values', () => {
  test('DATE values and the day after, across month and year ends', () => {
    expect(dateValue({ year: 2026, month: 3, day: 9 })).toBe('20260309')
    expect(nextDay({ year: 2026, month: 10, day: 31 })).toEqual({ year: 2026, month: 11, day: 1 })
    expect(nextDay({ year: 2026, month: 12, day: 31 })).toEqual({ year: 2027, month: 1, day: 1 })
    expect(nextDay({ year: 2028, month: 2, day: 28 })).toEqual({ year: 2028, month: 2, day: 29 })
  })

  test('DTSTAMP is UTC with a Z, whatever the process zone', () => {
    expect(utcStamp(new Date('2026-10-26T10:04:05.678Z'))).toBe('20261026T100405Z')
  })

  test('durations in whole hours, signed', () => {
    expect(hoursDuration(9)).toBe('PT9H')
    expect(hoursDuration(-15)).toBe('-PT15H')
    expect(hoursDuration(0)).toBe('PT0S')
  })
})

describe('the calendar', () => {
  const ics = icsCalendar('-//parcels//Add to Calendar//EN', [EVENT])
  const lines = unfold(ics).split('\r\n')

  test('every line ends in CRLF, including the last, and there is no bare LF anywhere', () => {
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })

  test('the frame: VERSION, PRODID, one VEVENT', () => {
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines).toContain('VERSION:2.0')
    expect(lines).toContain('PRODID:-//parcels//Add to Calendar//EN')
    expect(lines.filter(l => l === 'BEGIN:VEVENT')).toHaveLength(1)
    expect(lines.filter(l => l === 'END:VEVENT')).toHaveLength(1)
  })

  test('an all-day event: DATE start, and an exclusive DATE end on the next day', () => {
    expect(lines).toContain('DTSTART;VALUE=DATE:20261029')
    expect(lines).toContain('DTEND;VALUE=DATE:20261030')
    expect(lines).toContain('DTSTAMP:20261026T100000Z')
    expect(lines).toContain('UID:parcel-7-Z1172430119@parcels.local')
    expect(lines).toContain('SEQUENCE:3')
  })

  test('TEXT properties are escaped, the URL (a URI, not TEXT) is not', () => {
    expect(lines).toContain('SUMMARY:Pick up: Bratiska')
    expect(lines).toContain('LOCATION:Z-BOX\\, Bottova 6\\, Bratislava')
    expect(lines).toContain('URL:https://maps.apple.com/?ll=48.1452,17.1257&q=Z-BOX')
    expect(lines).toContain('GEO:48.1452;17.1257')
    expect(lines).toContain('DESCRIPTION:Packeta · Z1172430119\\nCollect by Thu 29 Oct')
  })

  test('two DISPLAY alarms with relative triggers, each with its own description', () => {
    const alarms = unfold(ics).split('BEGIN:VALARM\r\n').slice(1).map(a => a.split('END:VALARM')[0]!.split('\r\n'))
    expect(alarms).toHaveLength(2)
    expect(alarms[0]).toEqual(expect.arrayContaining(['ACTION:DISPLAY', 'TRIGGER:-PT15H', 'DESCRIPTION:Collect tomorrow: Bratiska']))
    expect(alarms[1]).toEqual(expect.arrayContaining(['ACTION:DISPLAY', 'TRIGGER:PT9H', 'DESCRIPTION:Collect today: Bratiska']))
  })

  test('optional properties are left out rather than printed empty', () => {
    const bare = unfold(icsCalendar('-//x//EN', [{ ...EVENT, location: undefined, geo: undefined, url: undefined, description: undefined, alarms: [] }]))
    for (const name of ['LOCATION', 'GEO', 'URL', 'DESCRIPTION', 'BEGIN:VALARM']) expect(bare).not.toContain(name)
  })
})
