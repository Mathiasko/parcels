import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildServer, type WebDeps } from '../src/web/server.js'
import {
  CalendarFailure, type CalendarAdded, type CalendarClient, type CalendarEventSpec, type CalendarReplace,
} from '../src/core/calendar-app.js'
import { getCalendarEvent, saveCalendarEvent } from '../src/db/calendar-events.js'
import { describeActivity, listActivity } from '../src/db/activity-log.js'
import { appendEvents } from '../src/db/events.js'
import { deleteParcel, getParcel, insertParcel, setArchived, updateParcelState } from '../src/db/parcels.js'
import { recordPickupCode } from '../src/db/pickup-codes.js'
import { slotStart } from '../src/web/calendar-slots.js'
import { STYLE } from '../src/web/views/style.js'
import { validateConfig } from '../src/core/config.js'
import type { Database } from '../src/db/index.js'
import type { CanonicalStatus, CarrierId, PickupPoint } from '../src/core/types.js'
import { config, ev, memDb, NOW } from './poll-helpers.js'

/**
 * "Add to Calendar" through the server. Calendar.app is always the fake below: nothing here runs osascript.
 * NOW is Mon 26 Oct 2026, 11:00 in Bratislava, so 9:00 today has passed and 13:00 has not.
 */

const ZBOX: PickupPoint = { kind: 'zbox', name: 'Z-BOX', street: 'Bottova 6', city: 'Bratislava', lat: 48.1452, lon: 17.1257 }
/** Thu 29 Oct 2026, 18:00 in Bratislava. */
const AT_SIX = new Date('2026-10-29T17:00:00Z')

interface AddCall { event: CalendarEventSpec; calendar: string | undefined; replace?: CalendarReplace }

function fakeCalendar(o: { names?: string[]; fail?: Error; listFail?: Error } = {}) {
  const adds: AddCall[] = []
  let lists = 0
  const client: CalendarClient = {
    listWritable: async () => {
      lists += 1
      if (o.listFail) throw o.listFail
      return o.names ?? ['Home', 'Work']
    },
    add: async (event, calendar, replace): Promise<CalendarAdded> => {
      adds.push({ event, calendar, ...(replace && { replace }) })
      if (o.fail) throw o.fail
      return { uid: `UID-${adds.length}`, calendar: calendar ?? (o.names ?? ['Home'])[0]! }
    },
  }
  return { client, adds, lists: () => lists }
}

function harness(o: { calendar?: ReturnType<typeof fakeCalendar>; config?: Partial<WebDeps['config']>; clock?: () => Date; configPath?: string } = {}) {
  const db = memDb()
  const cal = o.calendar ?? fakeCalendar()
  let at = NOW
  const app = buildServer({
    db, config: { ...config, ...o.config }, now: o.clock ?? (() => at), notifier: { send: async () => {} }, calendar: cal.client,
    ...(o.configPath && { configPath: o.configPath }),
  })
  return {
    db, cal, app,
    tick: (ms: number) => { at = new Date(at.getTime() + ms) },
    get: (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers }),
    post: (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) => app.inject({
      method: 'POST', url, payload: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    }),
  }
}

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

const cards = (body: string): string[] => body.split('<article class="card').slice(1).map(s => s.split('</article>')[0]!)
const blocks = (card: string): string[] => card.split('<li').slice(1).map(s => s.split('</li>')[0]!)
/** Each "Add to Calendar" disclosure on a page, whole. */
const forms = (body: string): string[] => body.split('<details class="calf"').slice(1).map(s => `<details class="calf"${s.split('</details>')[0]!}</details>`)
const radios = (form: string, name: 'day' | 'time') =>
  [...form.matchAll(new RegExp(`<label class="pick"><input type="radio" name="${name}" value="([^"]+)"( checked)?> ([^<]+)</label>`, 'g'))]
    .map(m => ({ value: m[1]!, checked: m[2] !== undefined, label: m[3]! }))
const checked = (form: string, name: 'day' | 'time') => radios(form, name).filter(r => r.checked).map(r => r.value)
const location = (res: { headers: Record<string, unknown> }) => String(res.headers.location)
const noticeOf = (body: string): string => /<div class="notice[^"]*"[^>]*role="status">[\s\S]*?<\/div><\/div>/.exec(body)?.[0] ?? ''

describe('the form on the dashboard', () => {
  test('closed, on the parcel\'s deadline line, posting to its own route and back to the dashboard', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1172430119', pickup: ZBOX, retainedTill: AT_SIX })
    const [card] = cards((await h.get('/')).body)
    const line = /<div class="cline">[\s\S]*?<\/details><\/div>/.exec(card!)![0]
    expect(line).toMatch(/^<div class="cline"><p class="clock"><b class="due">Collect by Thu 29 Oct<\/b> · <span class="t-2">3 days left<\/span><\/p><span class="sep" aria-hidden="true">·<\/span><details class="calf"><summary><span class="calf-b"><svg class="g" width="14" height="14"[^>]*>.*?<\/svg>Add to Calendar<\/span><span class="vh">: Bratiska<\/span><\/summary>/)
    expect(line).toContain(`<form method="post" action="/parcel/${id}/calendar"><input type="hidden" name="back" value="home">`)
    expect(line).not.toContain('<details class="calf" open')
    expect(line).toContain('<button>Add to Calendar<span class="vh">: Bratiska</span></button>')
  })

  test('the days run from today to the deadline, the last day is marked and checked; the three times, 9:00 checked', async () => {
    const h = harness()
    seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    const [form] = forms((await h.get('/')).body)
    expect(radios(form!, 'day')).toEqual([
      { value: '2026-10-26', checked: false, label: 'Today, from 13:00' },
      { value: '2026-10-27', checked: false, label: 'Tomorrow' },
      { value: '2026-10-28', checked: false, label: 'Wed 28 Oct' },
      { value: '2026-10-29', checked: true, label: 'Thu 29 Oct — last day' },
    ])
    expect(radios(form!, 'time')).toEqual([
      { value: '09:00', checked: true, label: '9:00' },
      { value: '13:00', checked: false, label: '13:00' },
      { value: '17:00', checked: false, label: '17:00' },
      { value: 'other', checked: false, label: 'Other' },
    ])
    // "Other" has its own time field, empty until a custom time is stored or sent.
    expect(form).toContain('<input class="pick-t" type="time" name="at" aria-label="Other time">')
  })

  test('no deadline: a week from today, today checked at its next time, nothing called the last day', async () => {
    const h = harness()
    seed(h.db, { name: 'Open-ended', number: 'Z2', pickup: ZBOX })
    const [form] = forms((await h.get('/')).body)
    expect(radios(form!, 'day')).toHaveLength(7)
    expect(checked(form!, 'day')).toEqual(['2026-10-26'])
    expect(checked(form!, 'time')).toEqual(['13:00'])
    expect(form).not.toContain('last day')
  })

  test('a deadline today: today only, and only the times still to come', async () => {
    const h = harness()
    seed(h.db, { name: 'Last call', number: 'Z3', pickup: ZBOX, retainedTill: new Date('2026-10-26T17:00:00Z') })
    const [form] = forms((await h.get('/')).body)
    expect(radios(form!, 'day')).toEqual([{ value: '2026-10-26', checked: true, label: 'Today — last day' }])
    expect(radios(form!, 'time').map(r => [r.value, r.checked])).toEqual([['13:00', true], ['17:00', false], ['other', false]])
  })

  test('a deadline today, after 17:00: only "Other", checked and filled in with the next full hour', async () => {
    const h = harness({ clock: () => new Date('2026-10-26T16:20:00Z') })              // 17:20 in Bratislava
    seed(h.db, { name: 'Last call', number: 'Z3', pickup: ZBOX, retainedTill: new Date('2026-10-26T22:00:00Z') })
    const [form] = forms((await h.get('/')).body)
    expect(radios(form!, 'day')).toEqual([{ value: '2026-10-26', checked: true, label: 'Today — last day' }])
    expect(radios(form!, 'time')).toEqual([{ value: 'other', checked: true, label: 'Other' }])
    expect(form).toContain('<input class="pick-t" type="time" name="at" aria-label="Other time" value="18:00">')
  })

  test('without a deadline it rides on the "Since" line; the footer keeps only the place\'s facts', async () => {
    const h = harness()
    seed(h.db, { name: 'Open-ended', number: 'Z2', pickup: ZBOX })
    const [card] = cards((await h.get('/')).body)
    expect(card).toMatch(/<div class="cline"><p class="clock">Since Mon 26 Oct, 06:00<\/p><span class="sep" aria-hidden="true">·<\/span><details class="calf">/)
    const footer = card!.split('<p class="card-f meta">')[1]!.split('</p>')[0]!
    expect(footer).toMatch(/^Packeta did not give a pickup deadline\. <a href="https:\/\/maps\.apple\.com\/[^"]+">Open in Apple Maps/)
    expect(footer).not.toContain('calf')
  })

  test('a card grouping parcels at one place has one form per parcel, each in its own block', async () => {
    const h = harness()
    const a = seed(h.db, { name: 'Parcel A', number: 'Z100', pickup: ZBOX, retainedTill: AT_SIX })
    const b = seed(h.db, { name: 'Parcel B', number: 'Z200', pickup: ZBOX })
    const [shared] = cards((await h.get('/')).body)
    const byName = (n: string) => blocks(shared!).find(x => x.includes(`>${n}</a></h3>`))!
    expect(forms(byName('Parcel A')).map(f => /action="([^"]+)"/.exec(f)![1])).toEqual([`/parcel/${a}/calendar`])
    expect(forms(byName('Parcel B')).map(f => /action="([^"]+)"/.exec(f)![1])).toEqual([`/parcel/${b}/calendar`])
    expect(forms(shared!)).toHaveLength(2)
  })

  test.each<[string, (db: Database) => void]>([
    ['not ready', db => { seed(db, { name: 'Moving', number: 'Z1', status: 'in_transit', pickup: ZBOX, retainedTill: AT_SIX }) }],
    ['archived', db => { setArchived(db, seed(db, { name: 'Old', number: 'Z3', pickup: ZBOX, retainedTill: AT_SIX }), NOW) }],
  ])('absent when %s', async (_, make) => {
    const h = harness()
    make(h.db)
    const body = (await h.get('/')).body
    expect(body).not.toContain('<details class="calf"')
    expect(body).not.toContain('/calendar"')
  })

  test('once added, the summary says where it is, and the form starts from that slot', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    saveCalendarEvent(h.db, { parcelId: id, uid: 'U', calendar: 'Home', startsAt: slotStart('2026-10-28', '13:00')!, createdAt: NOW })
    const [form] = forms((await h.get('/')).body)
    expect(form).toContain('In Calendar: Wed 28 Oct, 13:00 · <span class="calf-c">Change</span></span><span class="vh">: Bratiska</span></summary>')
    expect(checked(form!, 'day')).toEqual(['2026-10-28'])
    expect(checked(form!, 'time')).toEqual(['13:00'])
  })

  test('it sits above the card\'s stretched link, never takes the signal colour, and opens onto a row of its own', () => {
    expect(STYLE).toMatch(/\.calf\{[^}]*position:relative;z-index:1/)
    expect(STYLE).toMatch(/\.calf\[open\]\{[^}]*flex-basis:100%/)
    expect(STYLE).toMatch(/\.cline \.sep:has\(\+ \.calf\)\{display:none\}/)
    // "Other" shows its time field only while it is checked.
    expect(STYLE).toMatch(/\.pick-t\{display:none/)
    expect(STYLE).toContain('.picks:has(input[value=other]:checked) .pick-t{display:block}')
    const rules = STYLE.split('}').filter(r => /\.calf|\.pick/.test(r))
    expect(rules.join('}')).not.toContain('--signal')
    // Radios in ink, not the browser's blue: the signal hue means "waiting on you" and nothing else.
    expect(STYLE).toMatch(/\.pick input\{[^}]*accent-color:var\(--ink\)/)
    // Only the parcel's NAME trades its outline for the card-wide overlay ring; everything else in a card
    // (this disclosure, "set one" for a postcode) keeps the site's own focus ring.
    expect(STYLE).not.toMatch(/\.card-l a:focus-visible\{outline:none/)
    expect(STYLE).not.toMatch(/\.calf[^{]*:focus-visible\{outline:none/)
    expect(STYLE).toMatch(/\.card-l \.who a:focus-visible\{outline:none/)
  })
})

describe('the form on the parcel page', () => {
  test('on the pickup panel\'s clock line, with no way back to the dashboard', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    const body = (await h.get(`/parcel/${id}`)).body
    expect(forms(body)).toHaveLength(1)
    expect(body).toMatch(/<div class="pk-b"><div class="cline"><p class="clock">/)
    expect(forms(body)[0]).toContain(`<form method="post" action="/parcel/${id}/calendar">`)
    expect(forms(body)[0]).not.toContain('name="back"')
  })

  test('a parcel with no place gets the clock line, with the form, under its details', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Somewhere', number: 'Z2', retainedTill: AT_SIX })
    const body = (await h.get(`/parcel/${id}`)).body
    expect(body).toMatch(/<div class="cline"><p class="clock"><b class="due">Collect by Thu 29 Oct<\/b>/)
    expect(forms(body)).toHaveLength(1)
  })
})

describe('POST /parcel/:id/calendar', () => {
  test('puts the event into Calendar at the chosen local time, stores its uid, and says so on the dashboard', async () => {
    const h = harness({ calendar: fakeCalendar({ names: ['Home', 'Work'] }) })
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1172430119', pickup: ZBOX, retainedTill: AT_SIX })
    recordPickupCode(h.db, id, '004467', 1, NOW)
    const res = await h.post(`/parcel/${id}/calendar`, { day: '2026-10-28', time: '13:00', back: 'home' })
    expect(res.statusCode).toBe(303)
    expect(location(res)).toMatch(/^\/\?calendar=[0-9a-f]{12}$/)

    expect(h.cal.adds).toHaveLength(1)
    const [call] = h.cal.adds
    expect(call!.calendar).toBeUndefined()                   // none chosen: the first writable one
    expect(call!.replace).toBeUndefined()
    expect(call!.event).toEqual({
      summary: 'Pick up: Bratiska', location: 'Z-BOX, Bottova 6, Bratislava',
      url: 'https://maps.apple.com/?ll=48.1452,17.1257&q=Z-BOX',
      description: 'Packeta · Z1172430119\nOpen the box with 004467\nCollect by Thu 29 Oct, 18:00',
      start: { year: 2026, month: 10, day: 28, hour: 13, minute: 0 }, minutes: 30,
    })

    expect(getCalendarEvent(h.db, id)).toMatchObject({ uid: 'UID-1', calendar: 'Home', startsAt: new Date('2026-10-28T12:00:00Z') })

    const page = (await h.get(location(res))).body
    const n = noticeOf(page)
    expect(n).toContain('<p>Added <strong>Bratiska</strong> to Calendar “Home”: Wed 28 Oct, 13:00.</p>')
    expect(n).not.toContain('class="notice warn"')
    // And the form now says where the event is.
    expect(forms(page)[0]).toContain('In Calendar: Wed 28 Oct, 13:00 · <span class="calf-c">Change</span>')
  })

  test('the chosen calendar is the one asked for, and the notice names the one Calendar used', async () => {
    const h = harness({ config: { pickupCalendar: 'Work' } })
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    const res = await h.post(`/parcel/${id}/calendar`, { day: '2026-10-29', time: '09:00' })
    expect(h.cal.adds[0]!.calendar).toBe('Work')
    expect(location(res)).toMatch(new RegExp(`^/parcel/${id}\\?calendar=[0-9a-f]{12}$`))
    expect(noticeOf((await h.get(location(res))).body)).toContain('to Calendar “Work”: Thu 29 Oct, 9:00.')
  })

  test('"Other" adds at the time typed beside it, and the form comes back with that time under "Other"', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    // The time field is sent whichever radio is checked; only "Other" reads it.
    await h.post(`/parcel/${id}/calendar`, { day: '2026-10-28', time: '13:00', at: '07:45' })
    expect(getCalendarEvent(h.db, id)!.startsAt).toEqual(slotStart('2026-10-28', '13:00'))
    const res = await h.post(`/parcel/${id}/calendar`, { day: '2026-10-29', time: 'other', at: '18:30' })
    expect(getCalendarEvent(h.db, id)!.startsAt).toEqual(slotStart('2026-10-29', '18:30'))
    const page = (await h.get(location(res))).body
    expect(noticeOf(page)).toContain('Thu 29 Oct, 18:30')
    const form = forms(page)[0]!
    expect(form).toContain('In Calendar: Thu 29 Oct, 18:30')
    expect(checked(form, 'time')).toEqual(['other'])
    expect(form).toContain('aria-label="Other time" value="18:30">')
  })

  test('adding again replaces the event added before: the old uid and its calendar go with the new one', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    await h.post(`/parcel/${id}/calendar`, { day: '2026-10-28', time: '13:00', back: 'home' })
    const res = await h.post(`/parcel/${id}/calendar`, { day: '2026-10-29', time: '17:00', back: 'home' })
    expect(h.cal.adds[1]!.replace).toEqual({ uid: 'UID-1', calendar: 'Home' })
    expect(getCalendarEvent(h.db, id)).toMatchObject({ uid: 'UID-2', startsAt: slotStart('2026-10-29', '17:00') })
    expect(noticeOf((await h.get(location(res))).body)).toContain('Thu 29 Oct, 17:00, in place of the one added before.')
  })

  test('the activity log records the day and time, and never the code', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    recordPickupCode(h.db, id, '004467', 1, NOW)
    await h.post(`/parcel/${id}/calendar`, { day: '2026-10-28', time: '13:00' })
    await h.post(`/parcel/${id}/calendar`, { day: '2026-10-29', time: '09:00' })
    const log = listActivity(h.db, 10).filter(e => e.kind === 'calendar_added')
    expect(log).toHaveLength(2)
    expect(log[1]).toMatchObject({ actor: 'web', parcelId: id, carrier: 'packeta', detail: '2026-10-28 13:00' })
    expect(log[0]).toMatchObject({ detail: '2026-10-29 09:00 replaced' })
    expect(describeActivity(log[0]!)).toBe(`#${id} packeta added to Calendar for 2026-10-29 09:00, replacing the event added before`)
    for (const e of log) expect(JSON.stringify(e)).not.toContain('004467')
    // Health renders the kind like any other.
    const health = (await h.get('/health')).body
    expect(health).toContain('<td>added to calendar</td>')
    expect(health).toContain(`#${id} packeta added to Calendar for 2026-10-28 13:00</td>`)
  })

  test.each<[string, Error, RegExp]>([
    ['denied', new CalendarFailure('denied', 'Not authorized to send Apple events to Calendar. (-1743)'),
      /<strong>Calendar did not let this app add Bratiska\.<\/strong>[\s\S]*System Settings → Privacy &amp; Security → Automation → node → Calendar/],
    ['timeout', new CalendarFailure('timeout'), /<strong>Calendar did not answer in time, so Bratiska was not added\.<\/strong>/],
    ['no_calendar', new CalendarFailure('no_calendar'), /<strong>There is no calendar to add Bratiska to\.<\/strong>/],
    ['not_found', new CalendarFailure('not_found', undefined, 'Pickups'), /<strong>There is no calendar named “Pickups”\.<\/strong>[\s\S]*<a href="\/settings#calendar">Settings<\/a>/],
    ['ambiguous', new CalendarFailure('ambiguous', undefined, 'Home'), /<strong>More than one calendar is named “Home”\.<\/strong>/],
    ['read_only', new CalendarFailure('read_only', undefined, 'Holidays'), /<strong>The calendar “Holidays” is read-only\.<\/strong>/],
    ['other', new CalendarFailure('other', 'Calendar got an error: Connection is invalid. (-609)'),
      /<strong>Bratiska could not be added to Calendar\.<\/strong><\/p><p class="meta">Calendar said: Calendar got an error: Connection is invalid\. \(-609\)<\/p>/],
    ['a plain error', new Error('boom'), /<strong>Bratiska could not be added to Calendar\.<\/strong><\/p><p class="meta">Calendar said: boom<\/p>/],
  ])('%s: its own notice, and the event as a file instead', async (_, err, says) => {
    const h = harness({ calendar: fakeCalendar({ fail: err }) })
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    const res = await h.post(`/parcel/${id}/calendar`, { day: '2026-10-28', time: '13:00', back: 'home' })
    expect(res.statusCode).toBe(303)
    const n = noticeOf((await h.get(location(res))).body)
    expect(n).toMatch(/^<div class="notice warn" role="status">/)
    expect(n).toMatch(says)
    expect(n).toContain(`<a href="/parcel/${id}/calendar.ics?day=2026-10-28&amp;time=13:00">Download the event instead</a>`)
    expect(getCalendarEvent(h.db, id)).toBeUndefined()
    expect(listActivity(h.db, 10).some(e => e.kind === 'calendar_added')).toBe(false)
  })

  test('a failed replace keeps the stored event, so the next try still replaces the right one', async () => {
    const h = harness({ calendar: fakeCalendar({ fail: new CalendarFailure('timeout') }) })
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    saveCalendarEvent(h.db, { parcelId: id, uid: 'KEEP', calendar: 'Home', startsAt: slotStart('2026-10-28', '13:00')!, createdAt: NOW })
    await h.post(`/parcel/${id}/calendar`, { day: '2026-10-29', time: '09:00' })
    expect(h.cal.adds[0]!.replace).toEqual({ uid: 'KEEP', calendar: 'Home' })
    expect(getCalendarEvent(h.db, id)).toMatchObject({ uid: 'KEEP' })
  })

  describe('what is refused, with the form open again and the reason in it', () => {
    test('a time today that has already passed: 400, nothing added, the choice kept', async () => {
      const h = harness()
      const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
      const res = await h.post(`/parcel/${id}/calendar`, { day: '2026-10-26', time: '09:00', back: 'home' })
      expect(res.statusCode).toBe(400)
      expect(h.cal.adds).toEqual([])
      const [form] = forms(res.body)
      expect(form).toMatch(/^<details class="calf" open>/)
      expect(form).toContain('<p class="calf-err" role="alert">')
      expect(form).toContain('<span>9:00 today has already passed. Choose a later time or another day.</span>')
      expect(checked(form!, 'day')).toEqual(['2026-10-26'])
      expect(checked(form!, 'time')).toEqual(['09:00'])
      // Only that parcel's form opens.
      expect(res.body.match(/<details class="calf" open>/g)).toHaveLength(1)
    })

    test('from the parcel page, the parcel page comes back', async () => {
      const h = harness()
      const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
      const res = await h.post(`/parcel/${id}/calendar`, { day: '2026-10-30', time: '09:00' })
      expect(res.statusCode).toBe(400)
      expect(res.body).toContain('<h1 class="big">Bratiska</h1>')
      expect(forms(res.body)[0]).toMatch(/^<details class="calf" open>/)
      expect(forms(res.body)[0]).toContain('That day cannot be chosen. Choose one of the days listed.')
    })

    test.each([
      [{}, 'Choose a day and a time.'],
      [{ day: '2026-10-29' }, 'Choose a time, or type one beside Other.'],
      [{ day: '2026-10-29', time: 'other', at: '' }, 'Choose a time, or type one beside Other.'],
      [{ day: '2026-10-29', time: 'other', at: '25:00' }, 'Type the time as hours and minutes, such as 18:30.'],
      [{ day: '2026-10-29', time: 'other', at: '6pm' }, 'Type the time as hours and minutes, such as 18:30.'],
      [{ day: '2026-10-26', time: 'other', at: '10:30' }, '10:30 today has already passed. Choose a later time or another day.'],
      [{ day: '29.10.2026', time: '09:00' }, 'That day cannot be chosen. Choose one of the days listed.'],
      [{ day: '2026-10-25', time: '13:00' }, 'That day cannot be chosen. Choose one of the days listed.'],
    ])('%j: %s', async (fields, says) => {
      const h = harness()
      const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
      const res = await h.post(`/parcel/${id}/calendar`, { ...fields, back: 'home' } as Record<string, string>)
      expect(res.statusCode).toBe(400)
      expect(h.cal.adds).toEqual([])
      expect(forms(res.body)[0]).toContain(`<span>${says}</span>`)
    })

    test.each<[string, (db: Database, id: number) => void]>([
      ['no longer waiting for collection', (db, id) => updateParcelState(db, id, { status: 'delivered' })],
      ['archived', (db, id) => setArchived(db, id, NOW)],
    ])('a parcel %s: 400 and a notice, since it has no form to show it in', async (_, change) => {
      const h = harness()
      const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
      change(h.db, id)
      const res = await h.post(`/parcel/${id}/calendar`, { day: '2026-10-29', time: '09:00', back: 'home' })
      expect(res.statusCode).toBe(400)
      expect(h.cal.adds).toEqual([])
      expect(res.body).toContain('<div class="notice warn" role="status">')
      expect(res.body).toContain('<p>Bratiska is no longer waiting for collection, so it was not added to Calendar.</p>')
    })
  })

  test('an unknown parcel is the 404 page', async () => {
    const h = harness()
    for (const url of ['/parcel/999/calendar', '/parcel/abc/calendar']) {
      const res = await h.post(url, { day: '2026-10-29', time: '09:00' })
      expect(res.statusCode).toBe(404)
      expect(res.body).toContain('<h1>Not found</h1>')
    }
    expect(h.cal.adds).toEqual([])
  })

  test.each<[string, Record<string, string>]>([
    ['a cross-site form', { 'sec-fetch-site': 'cross-site' }],
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['another local server', { origin: 'http://localhost:3000' }],
    ['a foreign Host', { host: 'evil.example' }],
  ])('refused with 403 for %s, and Calendar is never asked', async (_, headers) => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    const res = await h.post(`/parcel/${id}/calendar`, { day: '2026-10-29', time: '09:00' }, headers)
    expect(res.statusCode).toBe(403)
    expect(h.cal.adds).toEqual([])
    expect(getCalendarEvent(h.db, id)).toBeUndefined()
  })

  test('a same-origin form is let through', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    const res = await h.post(`/parcel/${id}/calendar`, { day: '2026-10-29', time: '09:00' }, { 'sec-fetch-site': 'same-origin', host: 'localhost:8787', origin: 'http://localhost:8787' })
    expect(res.statusCode).toBe(303)
  })
})

describe('the result notice comes from the server, not the URL', () => {
  test('a made-up or malformed id shows nothing', async () => {
    const h = harness()
    seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    for (const q of ['?calendar=0123456789ab', '?calendar=nope', '?calendar=']) {
      const body = (await h.get(`/${q}`)).body
      expect(body).not.toContain('to Calendar “')
      expect(body).not.toContain('Download the event instead')
    }
  })

  test('it is shown for an hour, then not', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    const url = location(await h.post(`/parcel/${id}/calendar`, { day: '2026-10-29', time: '09:00', back: 'home' }))
    h.tick(59 * 60_000)
    expect((await h.get(url)).body).toContain('to Calendar “Home”')
    h.tick(2 * 60_000)
    expect((await h.get(url)).body).not.toContain('to Calendar “Home”')
  })

  test('a result about another parcel is not shown on this parcel\'s page', async () => {
    const h = harness()
    const a = seed(h.db, { name: 'Parcel A', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    const b = seed(h.db, { name: 'Parcel B', number: 'Z2', pickup: ZBOX, retainedTill: AT_SIX })
    const url = location(await h.post(`/parcel/${a}/calendar`, { day: '2026-10-29', time: '09:00' }))
    const token = url.split('?')[1]
    expect((await h.get(`/parcel/${b}?${token}`)).body).not.toContain('to Calendar “')
  })
})

describe('Calendar is never touched by deleting or collecting', () => {
  test('deleting a parcel drops its row with it, and asks Calendar nothing', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    await h.post(`/parcel/${id}/calendar`, { day: '2026-10-29', time: '09:00' })
    deleteParcel(h.db, id)
    expect(getParcel(h.db, id)).toBeUndefined()
    expect(getCalendarEvent(h.db, id)).toBeUndefined()
    expect(h.cal.adds).toHaveLength(1)
  })

  test('marking it collected keeps the row and asks Calendar nothing', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    await h.post(`/parcel/${id}/calendar`, { day: '2026-10-29', time: '09:00' })
    expect((await h.post(`/parcel/${id}/collected`, { back: 'home' })).statusCode).toBe(303)
    expect(getCalendarEvent(h.db, id)).toMatchObject({ uid: 'UID-1' })
    expect(h.cal.adds).toHaveLength(1)
  })
})

const unfold = (s: string): string => s.replace(/\r\n[ \t]/g, '')
const icsProp = (ics: string, name: string) => unfold(ics).split('\r\n').find(l => l.startsWith(`${name}:`))

describe('GET /parcel/:id/calendar.ics, the fallback', () => {
  test('the chosen slot as a timed event, inline so Safari hands it straight to Calendar', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1172430119', pickup: ZBOX, retainedTill: AT_SIX })
    recordPickupCode(h.db, id, '004467', 1, NOW)
    const res = await h.get(`/parcel/${id}/calendar.ics?day=2026-10-28&time=13:00`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('inline; filename="pick-up-bratiska.ics"')
    expect(icsProp(res.body, 'DTSTART')).toBe('DTSTART:20261028T120000Z')
    expect(icsProp(res.body, 'DTEND')).toBe('DTEND:20261028T123000Z')
    expect(icsProp(res.body, 'DESCRIPTION')).toBe('DESCRIPTION:Packeta · Z1172430119\\nOpen the box with 004467\\nCollect by Thu 29 Oct\\, 18:00')
    expect(unfold(res.body)).toContain('TRIGGER:PT0S')
    // The same security headers as every page.
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  test('with no parameters, an old link still works: the last day at 9:00', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    const res = await h.get(`/parcel/${id}/calendar.ics`)
    expect(res.statusCode).toBe(200)
    expect(icsProp(res.body, 'DTSTART')).toBe('DTSTART:20261029T080000Z')
  })

  test.each([
    '?day=2026-10-26&time=09:00',          // passed
    '?day=2026-10-30&time=09:00',          // after the deadline
    '?day=2026-10-29&time=25:00',
    '?day=2026-10-29',
    '?time=09:00',
    '?day=x&time=y',
  ])('a slot the form would not offer is 400, as a page: %s', async q => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    const res = await h.get(`/parcel/${id}/calendar.ics${q}`)
    expect(res.statusCode).toBe(400)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).not.toContain('VCALENDAR')
    expect(res.body).toContain(`<a href="/parcel/${id}">Bratiska</a>`)
  })

  test.each<[string, (db: Database) => string]>([
    ['not ready for pickup', db => `/parcel/${seed(db, { name: 'Moving', number: 'Z1', status: 'in_transit', pickup: ZBOX, retainedTill: AT_SIX })}/calendar.ics`],
    ['archived', db => {
      const id = seed(db, { name: 'Old', number: 'Z3', pickup: ZBOX, retainedTill: AT_SIX })
      setArchived(db, id, NOW)
      return `/parcel/${id}/calendar.ics?day=2026-10-29&time=09:00`
    }],
    ['an unknown id', () => '/parcel/999/calendar.ics'],
  ])('404 when %s', async (_, url) => {
    const h = harness()
    const res = await h.get(url(h.db))
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('VCALENDAR')
  })

  test('a foreign Host is refused', async () => {
    const h = harness()
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    expect((await h.get(`/parcel/${id}/calendar.ics`, { host: 'evil.example' })).statusCode).toBe(403)
  })
})

describe('choosing the calendar on /settings', () => {
  function configFile(over: Record<string, unknown> = {}): string {
    const path = join(mkdtempSync(join(tmpdir(), 'parcels-cal-cfg-')), 'config.json')
    writeFileSync(path, JSON.stringify({ defaultPostalCode: '81101', notifier: 'auto', mapPreview: true, ...over }, null, 2), { mode: 0o600 })
    return path
  }
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const fields = (over: Record<string, string> = {}) => ({
    defaultPostalCode: '81101', notifier: 'auto', mapPreview: 'true', imapHost: '', imapPort: '', imapUser: '', imapMailbox: '', imapPass: '', ...over,
  })
  const select = (body: string) => /<select name="pickupCalendar">[\s\S]*?<\/select>/.exec(body)?.[0]
  const options = (body: string) => [...select(body)!.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map(m => [m[1], m[3], m[2] !== undefined])

  test('the writable calendars, with the first one named as the default', async () => {
    const h = harness({ calendar: fakeCalendar({ names: ['Home', 'Work'] }), configPath: configFile() })
    const body = (await h.get('/settings')).body
    expect(options(body)).toEqual([
      ['', 'The first one (now “Home”)', true],
      ['Home', 'Home', false],
      ['Work', 'Work', false],
    ])
    expect(h.cal.lists()).toBe(1)
  })

  test('the stored choice is selected; a name Calendar no longer has stays, and says so; a shared name says so', async () => {
    const h = harness({ calendar: fakeCalendar({ names: ['Home', 'Home', 'Work'] }), configPath: configFile({ pickupCalendar: 'Pickups' }) })
    expect(options((await h.get('/settings')).body)).toEqual([
      ['', 'The first one (now “Home”)', false],
      ['Home', 'Home (2 calendars have this name)', false],
      ['Work', 'Work', false],
      ['Pickups', 'Pickups (not found in Calendar)', true],
    ])
  })

  test('when the list cannot be read there is no choice, only why', async () => {
    const h = harness({
      calendar: fakeCalendar({ listFail: new CalendarFailure('denied', 'Not authorized (-1743)') }),
      configPath: configFile({ pickupCalendar: 'Work' }),
    })
    const body = (await h.get('/settings')).body
    expect(select(body)).toBeUndefined()
    expect(body).toContain('Now “Work”. The list of your calendars could not be read')
    expect(body).toContain('macOS has not allowed this app to control Calendar. Allow it in System Settings → Privacy &amp; Security → Automation → node → Calendar, then reload this page.')
  })

  test('saving a choice writes it; the first-one choice removes the key; leaving the field out keeps what is stored', async () => {
    const path = configFile()
    const h = harness({ configPath: path })
    expect((await h.post('/settings', fields({ pickupCalendar: 'Work' }))).statusCode).toBe(303)
    expect(read(path).pickupCalendar).toBe('Work')
    expect(listActivity(h.db, 5)[0]).toMatchObject({ kind: 'settings_saved', detail: 'pickupCalendar' })
    expect(JSON.stringify(listActivity(h.db, 5))).not.toContain('Work')

    await h.post('/settings', fields())                       // no pickupCalendar field: the page had no list
    expect(read(path).pickupCalendar).toBe('Work')

    await h.post('/settings', fields({ pickupCalendar: '' }))
    expect('pickupCalendar' in read(path)).toBe(false)
  })

  test('the saved choice is used for the next event at once, without a restart', async () => {
    const path = configFile()
    const h = harness({ configPath: path })
    await h.post('/settings', fields({ pickupCalendar: 'Work' }))
    const id = seed(h.db, { name: 'Bratiska', number: 'Z1', pickup: ZBOX, retainedTill: AT_SIX })
    await h.post(`/parcel/${id}/calendar`, { day: '2026-10-29', time: '09:00' })
    expect(h.cal.adds[0]!.calendar).toBe('Work')
  })

  test('in the config file: a name, or "" (or nothing) for the first writable calendar; anything else is refused', () => {
    expect(validateConfig({ defaultPostalCode: '81101', pickupCalendar: 'Home' }).pickupCalendar).toBe('Home')
    expect(validateConfig({ defaultPostalCode: '81101', pickupCalendar: '' }).pickupCalendar).toBeUndefined()
    expect(validateConfig({ defaultPostalCode: '81101' }).pickupCalendar).toBeUndefined()
    expect(() => validateConfig({ defaultPostalCode: '81101', pickupCalendar: 3 })).toThrow(/pickupCalendar/)
  })

  test('config.example.json carries the key, as the first writable calendar', () => {
    const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')) as Record<string, unknown>
    expect(example.pickupCalendar).toBe('')
  })
})
