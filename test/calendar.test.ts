import { describe, expect, test } from 'vitest'
import { buildServer } from '../src/web/server.js'
import { calendarFilename, parcelCalendar } from '../src/web/calendar.js'
import { calendarUrl, mapsUrl } from '../src/web/views/index.js'
import { insertParcel, setArchived, updateParcelState, type Parcel } from '../src/db/parcels.js'
import { recordPickupCode } from '../src/db/pickup-codes.js'
import { appendEvents } from '../src/db/events.js'
import type { Database } from '../src/db/index.js'
import type { CanonicalStatus, CarrierId, PickupPoint } from '../src/core/types.js'
import { STYLE } from '../src/web/views/style.js'
import { config, ev, memDb, NOW } from './poll-helpers.js'

const unfold = (s: string): string => s.replace(/\r\n[ \t]/g, '')
const lines = (ics: string): string[] => unfold(ics).split('\r\n')
const prop = (ics: string, name: string): string | undefined =>
  lines(ics).find(l => l.startsWith(`${name}:`) || l.startsWith(`${name};`))
const alarms = (ics: string): string[][] =>
  unfold(ics).split('BEGIN:VALARM\r\n').slice(1).map(a => a.split('END:VALARM')[0]!.split('\r\n'))
const triggers = (ics: string): string[] => alarms(ics).map(a => a.find(l => l.startsWith('TRIGGER:'))!.slice(8))

const ZBOX: PickupPoint = { kind: 'zbox', name: 'Z-BOX', street: 'Bottova 6', city: 'Bratislava', lat: 48.1452, lon: 17.1257 }
/** Thu 29 Oct 2026, 18:00 in Bratislava (CET, UTC+1). */
const AT_SIX = new Date('2026-10-29T17:00:00Z')
/** Thu 29 Oct 2026 as a bare date: the carriers store "all of that day" as its last instant, local time. */
const ALL_DAY = new Date('2026-10-29T22:59:59.999Z')

const parcel = (o: Partial<Parcel> = {}): Parcel => ({
  id: 7, carrier: 'packeta', trackingNumber: 'Z1172430119', label: 'Bratiska',
  status: 'ready_for_pickup', lastAnnouncedStatus: 'ready_for_pickup', pickupAnnounced: true,
  pickup: ZBOX, retainedTill: AT_SIX, firstSeenAt: new Date('2026-10-20T08:00:00Z'), source: 'email',
  ...o,
})

describe('the event for one parcel', () => {
  const ics = parcelCalendar(parcel(), '799874', NOW)

  test('an all-day event on the deadline day, named for the parcel, at the pickup address', () => {
    expect(prop(ics, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20261029')
    expect(prop(ics, 'DTEND')).toBe('DTEND;VALUE=DATE:20261030')
    expect(prop(ics, 'SUMMARY')).toBe('SUMMARY:Pick up: Bratiska')
    expect(prop(ics, 'LOCATION')).toBe('LOCATION:Z-BOX\\, Bottova 6\\, Bratislava')
    expect(prop(ics, 'GEO')).toBe('GEO:48.1452;17.1257')
  })

  test('the URL is the Apple Maps link, never this server', () => {
    expect(prop(ics, 'URL')).toBe(`URL:${mapsUrl(parcel())}`)
    expect(ics).not.toMatch(/127\.0\.0\.1|localhost|parcels\.local:/)
  })

  test('the description: carrier and number, the opening code, and the deadline with the time the carrier gave', () => {
    expect(prop(ics, 'DESCRIPTION')).toBe('DESCRIPTION:Packeta · Z1172430119\\nOpen the box with 799874\\nCollect by Thu 29 Oct\\, 18:00')
  })

  test('a deadline that is a whole day is printed without a time', () => {
    const d = prop(parcelCalendar(parcel({ retainedTill: ALL_DAY }), undefined, NOW), 'DESCRIPTION')
    expect(d).toBe('DESCRIPTION:Packeta · Z1172430119\\nCollect by Thu 29 Oct')
  })

  test('no code line when no code is stored (a staffed point never has one)', () => {
    expect(prop(parcelCalendar(parcel(), undefined, NOW), 'DESCRIPTION')).not.toContain('Open the box')
  })

  test('no GEO without coordinates, and the URL falls back to the address search mapsUrl builds', () => {
    const p = parcel({ pickup: { kind: 'zbox', name: 'Z-BOX', street: 'Bottova 6', city: 'Bratislava' } })
    const out = parcelCalendar(p, undefined, NOW)
    expect(prop(out, 'GEO')).toBeUndefined()
    expect(prop(out, 'URL')).toBe(`URL:${mapsUrl(p)}`)
  })

  test('two alarms: 09:00 the day before, 09:00 on the day', () => {
    expect(triggers(ics)).toEqual(['-PT15H', 'PT9H'])
    for (const a of alarms(ics)) expect(a).toContain('ACTION:DISPLAY')
  })

  test('the opening code is never in an alarm or the title: those are what a lock screen shows', () => {
    for (const a of alarms(ics)) expect(a.join('\n')).not.toContain('799874')
    expect(prop(ics, 'SUMMARY')).not.toContain('799874')
  })

  test('the UID is the same on every download, and SEQUENCE only grows, so a re-download updates the event', () => {
    const later = parcelCalendar(parcel({ retainedTill: new Date('2026-10-31T17:00:00Z') }), '799874', new Date(NOW.getTime() + 3_600_000))
    expect(prop(ics, 'UID')).toBe('UID:parcel-7-Z1172430119@parcels.local')
    expect(prop(later, 'UID')).toBe(prop(ics, 'UID'))
    const seq = (s: string) => Number(prop(s, 'SEQUENCE')!.slice('SEQUENCE:'.length))
    expect(seq(later)).toBeGreaterThan(seq(ics))
  })

  test('DTSTAMP is the download time in UTC', () => {
    expect(prop(ics, 'DTSTAMP')).toBe('DTSTAMP:20261026T100000Z')
  })
})

describe('dates and alarms in the display zone', () => {
  test('a deadline just after local midnight is that local day, not the UTC one', () => {
    // 23:30 UTC on Wed 28 Oct is 00:30 on Thu 29 Oct in Bratislava.
    const ics = parcelCalendar(parcel({ retainedTill: new Date('2026-10-28T23:30:00Z') }), undefined, NOW)
    expect(prop(ics, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20261029')
    expect(prop(ics, 'DESCRIPTION')).toContain('Collect by Thu 29 Oct\\, 00:30')
  })

  test('on the day the clocks go back (Sun 25 Oct 2026), 09:00 is ten hours after midnight', () => {
    const before = new Date('2026-10-20T10:00:00Z')
    const ics = parcelCalendar(parcel({ retainedTill: new Date('2026-10-25T22:59:59.999Z') }), undefined, before)
    expect(prop(ics, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20261025')
    expect(prop(ics, 'DTEND')).toBe('DTEND;VALUE=DATE:20261026')
    expect(triggers(ics)).toEqual(['-PT15H', 'PT10H'])
  })

  test('on the day the clocks go forward (Sun 29 Mar 2026), 09:00 is eight hours after midnight', () => {
    const before = new Date('2026-03-20T10:00:00Z')
    const ics = parcelCalendar(parcel({ retainedTill: new Date('2026-03-29T21:59:59.999Z') }), undefined, before)
    expect(prop(ics, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20260329')
    expect(prop(ics, 'DTEND')).toBe('DTEND;VALUE=DATE:20260330')
    expect(triggers(ics)).toEqual(['-PT15H', 'PT8H'])
  })

  test('the day after a change is ordinary again', () => {
    const ics = parcelCalendar(parcel({ retainedTill: new Date('2026-10-26T22:59:59.999Z') }), undefined, new Date('2026-10-20T10:00:00Z'))
    expect(triggers(ics)).toEqual(['-PT15H', 'PT9H'])
  })

  test('the day-before alarm is left out once 09:00 the day before has passed', () => {
    // Wed 28 Oct 09:00 in Bratislava is 08:00 UTC.
    const p = parcel({ retainedTill: ALL_DAY })
    expect(triggers(parcelCalendar(p, undefined, new Date('2026-10-28T07:59:59Z')))).toEqual(['-PT15H', 'PT9H'])
    expect(triggers(parcelCalendar(p, undefined, new Date('2026-10-28T08:00:00Z')))).toEqual(['PT9H'])
  })

  test('on the deadline day after 09:00 there is nothing left to remind about', () => {
    const ics = parcelCalendar(parcel({ retainedTill: ALL_DAY }), undefined, new Date('2026-10-29T08:30:00Z'))
    expect(alarms(ics)).toEqual([])
    expect(prop(ics, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20261029')
  })
})

describe('when the calendar is offered', () => {
  test('ready for pickup, not archived, with a deadline', () => {
    expect(calendarUrl(parcel())).toBe('/parcel/7/calendar.ics')
  })

  test.each<[string, Partial<Parcel>]>([
    ['not ready', { status: 'in_transit' }],
    ['delivered', { status: 'delivered' }],
    ['no deadline', { retainedTill: undefined }],
    ['archived', { archivedAt: new Date('2026-10-25T10:00:00Z') }],
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

// --- the route and the links ------------------------------------------------------------------------

const server = (db: Database) => buildServer({ db, config, now: () => NOW, notifier: { send: async () => {} } })
const get = (db: Database, url: string, headers: Record<string, string> = {}) => server(db).inject({ method: 'GET', url, headers })

function seed(db: Database, o: {
  name: string; number: string; carrier?: CarrierId; status?: CanonicalStatus; pickup?: PickupPoint; retainedTill?: Date
}): number {
  const id = insertParcel(db, { carrier: o.carrier ?? 'packeta', trackingNumber: o.number, label: o.name, source: 'manual' })
  appendEvents(db, id, [ev('x', o.status ?? 'ready_for_pickup', 5, 'Ready')])
  updateParcelState(db, id, {
    status: o.status ?? 'ready_for_pickup', pickup: o.pickup, retainedTill: o.retainedTill,
    lastChangedAt: new Date(NOW.getTime() - 5 * 3_600_000),
  })
  return id
}

const link = (id: number) => `<a class="cal" href="/parcel/${id}/calendar.ics">Add to Calendar</a>`
const cards = (body: string): string[] => body.split('<article class="card').slice(1).map(s => s.split('</article>')[0]!)
const blocks = (card: string): string[] => card.split('<li').slice(1).map(s => s.split('</li>')[0]!)

describe('GET /parcel/:id/calendar.ics', () => {
  test('a ready parcel with a deadline, a code and coordinates: 200, a calendar file, the event', async () => {
    const db = memDb()
    const id = seed(db, { name: 'Bratiska', number: 'Z1172430119', pickup: ZBOX, retainedTill: AT_SIX })
    recordPickupCode(db, id, '004467', 1, NOW)
    const res = await get(db, `/parcel/${id}/calendar.ics`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="pick-up-bratiska.ics"')
    const body = res.body
    expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(prop(body, 'UID')).toBe(`UID:parcel-${id}-Z1172430119@parcels.local`)
    expect(prop(body, 'SUMMARY')).toBe('SUMMARY:Pick up: Bratiska')
    expect(prop(body, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20261029')
    expect(prop(body, 'GEO')).toBe('GEO:48.1452;17.1257')
    expect(prop(body, 'URL')).toBe('URL:https://maps.apple.com/?ll=48.1452,17.1257&q=Z-BOX')
    expect(prop(body, 'DESCRIPTION')).toBe('DESCRIPTION:Packeta · Z1172430119\\nOpen the box with 004467\\nCollect by Thu 29 Oct\\, 18:00')
    expect(triggers(body)).toEqual(['-PT15H', 'PT9H'])
  })

  test('it goes through the same security hooks as every page', async () => {
    const db = memDb()
    const id = seed(db, { name: 'Bratiska', number: 'Z1172430119', pickup: ZBOX, retainedTill: AT_SIX })
    const ok = await get(db, `/parcel/${id}/calendar.ics`)
    expect(ok.headers['content-security-policy']).toContain("default-src 'none'")
    expect(ok.headers['x-content-type-options']).toBe('nosniff')
    const foreign = await get(db, `/parcel/${id}/calendar.ics`, { host: 'evil.example' })
    expect(foreign.statusCode).toBe(403)
    expect(foreign.body).not.toContain('VCALENDAR')
  })

  test.each<[string, (db: Database) => string]>([
    ['not ready for pickup', db => `/parcel/${seed(db, { name: 'Moving', number: 'Z1', status: 'in_transit', pickup: ZBOX, retainedTill: AT_SIX })}/calendar.ics`],
    ['ready, but no deadline', db => `/parcel/${seed(db, { name: 'Open-ended', number: 'Z2', pickup: ZBOX })}/calendar.ics`],
    ['archived', db => {
      const id = seed(db, { name: 'Old', number: 'Z3', pickup: ZBOX, retainedTill: AT_SIX })
      setArchived(db, id, NOW)
      return `/parcel/${id}/calendar.ics`
    }],
    ['an unknown id', () => '/parcel/999/calendar.ics'],
    ['a non-numeric id', () => '/parcel/abc/calendar.ics'],
  ])('404, as the app\'s own page, when %s', async (_, url) => {
    const db = memDb()
    const res = await get(db, url(db))
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('<h1>Not found</h1>')
    expect(res.body).not.toContain('VCALENDAR')
  })
})

describe('the Add to Calendar link', () => {
  test('on a one-parcel card, on its deadline line', async () => {
    const db = memDb()
    const id = seed(db, { name: 'Bratiska', number: 'Z1172430119', pickup: ZBOX, retainedTill: AT_SIX })
    const [only] = cards((await get(db, '/')).body)
    expect(only).toContain(link(id))
    expect(only).toMatch(new RegExp(`<p class="clock">.*Collect by.*${link(id).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}</p>`))
    expect(only).toContain('Open in Apple Maps')
  })

  test('on a card that groups parcels at one place, one link per parcel, each in its own block', async () => {
    const db = memDb()
    const a = seed(db, { name: 'Parcel A', number: 'Z100', pickup: ZBOX, retainedTill: AT_SIX })
    const b = seed(db, { name: 'Parcel B', number: 'Z200', pickup: ZBOX, retainedTill: ALL_DAY })
    const c = seed(db, { name: 'Parcel C', number: 'Z300', pickup: ZBOX })              // no deadline: no link
    const [shared] = cards((await get(db, '/')).body)
    const byName = (n: string) => blocks(shared!).find(x => x.includes(`>${n}</a></h3>`))!
    expect(byName('Parcel A')).toContain(link(a))
    expect(byName('Parcel A')).not.toContain(link(b))
    expect(byName('Parcel B')).toContain(link(b))
    expect(byName('Parcel C')).not.toContain('calendar.ics')
    expect(shared!.match(/>Add to Calendar<\/a>/g)).toHaveLength(2)
    expect(shared).not.toContain(`/parcel/${c}/calendar.ics`)
  })

  test('absent from the dashboard when no parcel qualifies', async () => {
    const db = memDb()
    seed(db, { name: 'Open-ended', number: 'Z2', pickup: ZBOX })                             // ready, no deadline
    seed(db, { name: 'Moving', number: 'Z1', status: 'in_transit', pickup: ZBOX, retainedTill: AT_SIX })
    const body = (await get(db, '/')).body
    expect(body).not.toContain('calendar.ics')
    expect(body).not.toContain('>Add to Calendar</a>')
  })

  test('on the parcel page of a ready parcel with a deadline', async () => {
    const db = memDb()
    const id = seed(db, { name: 'Bratiska', number: 'Z1172430119', pickup: ZBOX, retainedTill: AT_SIX })
    const body = (await get(db, `/parcel/${id}`)).body
    expect(body).toContain(link(id))
    expect(body.match(/>Add to Calendar<\/a>/g)).toHaveLength(1)
    expect(body).toContain('Open in Apple Maps')
  })

  test.each<[string, (db: Database) => number]>([
    ['no deadline', db => seed(db, { name: 'Open-ended', number: 'Z2', pickup: ZBOX })],
    ['not ready', db => seed(db, { name: 'Moving', number: 'Z1', status: 'in_transit', pickup: ZBOX, retainedTill: AT_SIX })],
    ['archived', db => {
      const id = seed(db, { name: 'Old', number: 'Z3', pickup: ZBOX, retainedTill: AT_SIX })
      setArchived(db, id, NOW)
      return id
    }],
  ])('absent from the parcel page when %s', async (_, make) => {
    const db = memDb()
    const body = (await get(db, `/parcel/${make(db)}`)).body
    expect(body).not.toContain('calendar.ics')
    expect(body).not.toContain('>Add to Calendar</a>')
  })

  test('the link sits above a card\'s stretched link, and keeps a visible focus ring', () => {
    expect(STYLE).toMatch(/\.cal\{[^}]*position:relative;z-index:1/)
    expect(STYLE).toMatch(/\.card-l a\.cal:focus-visible\{outline:2px solid var\(--ink\)/)
  })
})
