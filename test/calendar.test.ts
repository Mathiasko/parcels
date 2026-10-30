import { describe, expect, test } from 'vitest'
import { calendarFilename, EVENT_MINUTES, parcelCalendar, pickupEventContent, pickupEventSpec } from '../src/web/calendar.js'
import { slotStart } from '../src/web/calendar-slots.js'
import { calendarUrl, mapsUrl } from '../src/web/views/index.js'
import type { Parcel } from '../src/db/parcels.js'
import type { PickupPoint } from '../src/core/types.js'
import { NOW } from './poll-helpers.js'

const unfold = (s: string): string => s.replace(/\r\n[ \t]/g, '')
const lines = (ics: string): string[] => unfold(ics).split('\r\n')
const prop = (ics: string, name: string): string | undefined =>
  lines(ics).find(l => l.startsWith(`${name}:`) || l.startsWith(`${name};`))
const alarms = (ics: string): string[][] =>
  unfold(ics).split('BEGIN:VALARM\r\n').slice(1).map(a => a.split('END:VALARM')[0]!.split('\r\n'))

const ZBOX: PickupPoint = { kind: 'zbox', name: 'Z-BOX', street: 'Bottova 6', city: 'Bratislava', lat: 48.1452, lon: 17.1257 }
/** Thu 29 Oct 2026, 18:00 in Bratislava (CET, UTC+1). */
const AT_SIX = new Date('2026-10-29T17:00:00Z')
/** Thu 29 Oct 2026 as a bare date: the carriers store "all of that day" as its last instant, local time. */
const ALL_DAY = new Date('2026-10-29T22:59:59.999Z')
/** Wed 28 Oct 2026, 13:00 in Bratislava: 12:00 UTC. */
const WED_ONE = slotStart('2026-10-28', '13:00')!

const parcel = (o: Partial<Parcel> = {}): Parcel => ({
  id: 7, carrier: 'packeta', trackingNumber: 'Z1172430119', label: 'Bratiska',
  status: 'ready_for_pickup', lastAnnouncedStatus: 'ready_for_pickup', pickupAnnounced: true,
  pickup: ZBOX, retainedTill: AT_SIX, firstSeenAt: new Date('2026-10-20T08:00:00Z'), source: 'email',
  ...o,
})

describe('what a pickup event says', () => {
  test('title, place, Maps link, pin, and the description: carrier and number, code, the real deadline with its time', () => {
    expect(pickupEventContent(parcel(), '799874', NOW)).toEqual({
      summary: 'Pick up: Bratiska',
      location: 'Z-BOX, Bottova 6, Bratislava',
      url: mapsUrl(parcel()),
      geo: { lat: 48.1452, lon: 17.1257 },
      description: ['Packeta · Z1172430119', 'Open the box with 799874', 'Collect by Thu 29 Oct, 18:00'],
    })
  })

  test('the code line is worded for the kind of place, as on the card', () => {
    const line = (pickup: Parcel['pickup']): string | undefined =>
      pickupEventContent(parcel({ pickup }), '402211', NOW).description[1]
    expect(line({ ...ZBOX, kind: 'zbox' })).toBe('Open the box with 402211')
    expect(line({ ...ZBOX, kind: 'locker' })).toBe('Open the box with 402211')
    expect(line({ ...ZBOX, kind: 'parcelshop' })).toBe('Show this PIN at the counter: 402211')
    expect(line({ ...ZBOX, kind: 'post_office' })).toBe('Show this PIN at the counter: 402211')
    expect(line({ ...ZBOX, kind: 'unknown' })).toBe('PIN 402211')
    expect(line(undefined)).toBe('PIN 402211')
  })

  test('a whole-day deadline has no time; no code line without a code; no deadline says so', () => {
    expect(pickupEventContent(parcel({ retainedTill: ALL_DAY }), undefined, NOW).description)
      .toEqual(['Packeta · Z1172430119', 'Collect by Thu 29 Oct'])
    expect(pickupEventContent(parcel({ retainedTill: undefined }), undefined, NOW).description)
      .toEqual(['Packeta · Z1172430119', 'Packeta gave no pickup deadline'])
  })

  test('a deadline just after local midnight is that local day, not the UTC one', () => {
    // 23:30 UTC on Wed 28 Oct is 00:30 on Thu 29 Oct in Bratislava.
    expect(pickupEventContent(parcel({ retainedTill: new Date('2026-10-28T23:30:00Z') }), undefined, NOW).description.at(-1))
      .toBe('Collect by Thu 29 Oct, 00:30')
  })

  test('for Calendar.app: the same words, the description as lines, the wall-clock start, 30 minutes', () => {
    expect(pickupEventSpec(parcel(), '799874', WED_ONE, NOW)).toEqual({
      summary: 'Pick up: Bratiska',
      location: 'Z-BOX, Bottova 6, Bratislava',
      url: mapsUrl(parcel()),
      description: 'Packeta · Z1172430119\nOpen the box with 799874\nCollect by Thu 29 Oct, 18:00',
      start: { year: 2026, month: 10, day: 28, hour: 13, minute: 0 },
      minutes: 30,
    })
    expect(EVENT_MINUTES).toBe(30)
  })
})

describe('the .ics: the same event, timed', () => {
  const ics = parcelCalendar(parcel(), '799874', WED_ONE, NOW)

  test('a 30-minute event at the chosen time, written in UTC', () => {
    expect(prop(ics, 'DTSTART')).toBe('DTSTART:20261028T120000Z')
    expect(prop(ics, 'DTEND')).toBe('DTEND:20261028T123000Z')
    // A planned trip, not an all-day note: the event keeps the default (busy), as Calendar.app makes it.
    expect(prop(ics, 'TRANSP')).toBeUndefined()
  })

  test('the same title, place, pin, URL and description as the Calendar.app event', () => {
    expect(prop(ics, 'SUMMARY')).toBe('SUMMARY:Pick up: Bratiska')
    expect(prop(ics, 'LOCATION')).toBe('LOCATION:Z-BOX\\, Bottova 6\\, Bratislava')
    expect(prop(ics, 'GEO')).toBe('GEO:48.1452;17.1257')
    expect(prop(ics, 'URL')).toBe(`URL:${mapsUrl(parcel())}`)
    expect(prop(ics, 'DESCRIPTION')).toBe('DESCRIPTION:Packeta · Z1172430119\\nOpen the box with 799874\\nCollect by Thu 29 Oct\\, 18:00')
    expect(ics).not.toMatch(/127\.0\.0\.1|localhost|parcels\.local:/)
  })

  test('one alert, at the start: the time chosen IS the reminder', () => {
    expect(alarms(ics)).toHaveLength(1)
    expect(alarms(ics)[0]).toEqual(expect.arrayContaining(['ACTION:DISPLAY', 'TRIGGER:PT0S', 'DESCRIPTION:Pick up: Bratiska']))
  })

  test('the opening code is never in the alert or the title: those are what a lock screen shows', () => {
    for (const a of alarms(ics)) expect(a.join('\n')).not.toContain('799874')
    expect(prop(ics, 'SUMMARY')).not.toContain('799874')
  })

  test('the UID is the same on every download, and SEQUENCE only grows, so a re-download updates the event', () => {
    const later = parcelCalendar(parcel(), '799874', slotStart('2026-10-29', '09:00')!, new Date(NOW.getTime() + 3_600_000))
    expect(prop(ics, 'UID')).toBe('UID:parcel-7-Z1172430119@parcels.local')
    expect(prop(later, 'UID')).toBe(prop(ics, 'UID'))
    const seq = (s: string) => Number(prop(s, 'SEQUENCE')!.slice('SEQUENCE:'.length))
    expect(seq(later)).toBeGreaterThan(seq(ics))
  })

  test('DTSTAMP is the download time in UTC', () => {
    expect(prop(ics, 'DTSTAMP')).toBe('DTSTAMP:20261026T100000Z')
  })

  test('on the day the clocks go back (Sun 25 Oct 2026), 9:00 is 08:00 UTC; the day before it is 07:00 UTC', () => {
    expect(prop(parcelCalendar(parcel(), undefined, slotStart('2026-10-25', '09:00')!, NOW), 'DTSTART')).toBe('DTSTART:20261025T080000Z')
    expect(prop(parcelCalendar(parcel(), undefined, slotStart('2026-10-24', '09:00')!, NOW), 'DTSTART')).toBe('DTSTART:20261024T070000Z')
  })

  test('no GEO without coordinates, and the URL falls back to the address search mapsUrl builds', () => {
    const p = parcel({ pickup: { kind: 'zbox', name: 'Z-BOX', street: 'Bottova 6', city: 'Bratislava' } })
    const out = parcelCalendar(p, undefined, WED_ONE, NOW)
    expect(prop(out, 'GEO')).toBeUndefined()
    expect(prop(out, 'URL')).toBe(`URL:${mapsUrl(p)}`)
  })
})

describe('when the calendar is offered', () => {
  test('ready for pickup and not archived, with a deadline or without one', () => {
    expect(calendarUrl(parcel())).toBe('/parcel/7/calendar.ics')
    expect(calendarUrl(parcel({ retainedTill: undefined }))).toBe('/parcel/7/calendar.ics')
  })

  test.each<[string, Partial<Parcel>]>([
    ['not ready', { status: 'in_transit' }],
    ['delivered', { status: 'delivered' }],
    ['archived', { archivedAt: new Date('2026-10-25T10:00:00Z') }],
    ['archived, without a deadline', { archivedAt: new Date('2026-10-25T10:00:00Z'), retainedTill: undefined }],
  ])('not when %s', (_, o) => {
    expect(calendarUrl(parcel(o))).toBeUndefined()
  })
})

describe('the download filename', () => {
  test('plain ASCII from the parcel name, diacritics folded and punctuation dropped', () => {
    expect(calendarFilename(parcel({ label: 'Topánky "Zalando"; 50%\r\nx' }))).toBe('pick-up-topanky-zalando-50-x.ics')
    expect(calendarFilename(parcel())).toBe('pick-up-bratiska.ics')
  })

  test('a name with nothing usable in it falls back to the parcel id', () => {
    expect(calendarFilename(parcel({ label: '品物 ✓' }))).toBe('pick-up-parcel-7.ics')
  })

  test('a very long name is cut short', () => {
    expect(calendarFilename(parcel({ label: 'a'.repeat(200) })).length).toBeLessThanOrEqual(80)
  })
})
