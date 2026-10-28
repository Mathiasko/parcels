import { describe, expect, test } from 'vitest'
import {
  ADD_SCRIPT, ADD_TIMEOUT_MS, addArgs, CalendarFailure, classifyFailure, defaultRunner, LIST_SCRIPT, LIST_TIMEOUT_MS,
  osascriptCalendar, parseAddOutput, stderrMessage, type CalendarEventSpec, type OsascriptRunner, type RunResult,
} from '../src/core/calendar-app.js'
import { pickupEventSpec } from '../src/web/calendar.js'
import { slotStart } from '../src/web/calendar-slots.js'
import type { Parcel } from '../src/db/parcels.js'
import { NOW } from './poll-helpers.js'

/**
 * The pure parts of the osascript client. Nothing here runs osascript: the runner is always a fake,
 * and the real one refuses to start under the test runner (the last test pins that).
 */

const EVENT: CalendarEventSpec = {
  summary: 'Pick up: Bratiska',
  location: 'Z-BOX, Bottova 6, Bratislava',
  description: 'Packeta · Z1172430119\nOpen the box with 799874\nCollect by Thu 29 Oct, 18:00',
  url: 'https://maps.apple.com/?ll=48.1452,17.1257&q=Z-BOX',
  start: { year: 2026, month: 10, day: 25, hour: 9, minute: 0 },
  minutes: 30,
}

/** The values after `--`, i.e. what `on run argv` receives. */
const argv = (args: string[]) => args.slice(args.indexOf('--') + 1)
/** The script lines, i.e. every value of an `-e`. */
const script = (args: string[]) => args.slice(0, args.indexOf('--')).filter((_, i) => i % 2 === 1)

describe('the argv for adding an event', () => {
  test('the script, then --, then the values in the order the script reads them', () => {
    const args = addArgs(EVENT, 'Home', { uid: 'OLD-UID', calendar: 'Work' })
    expect(args.slice(0, args.indexOf('--')).filter((_, i) => i % 2 === 0).every(a => a === '-e')).toBe(true)
    expect(script(args)).toEqual([...ADD_SCRIPT])
    expect(argv(args)).toEqual([
      'Home', '2026', '10', '25', '9', '0', '30',
      'Pick up: Bratiska', 'Z-BOX, Bottova 6, Bratislava',
      'Packeta · Z1172430119\nOpen the box with 799874\nCollect by Thu 29 Oct, 18:00',
      'https://maps.apple.com/?ll=48.1452,17.1257&q=Z-BOX',
      'Work', 'OLD-UID',
    ])
  })

  test('no calendar chosen and nothing to replace are empty strings, so the item numbers never shift', () => {
    const v = argv(addArgs({ ...EVENT, location: undefined, url: undefined }, undefined))
    expect(v).toHaveLength(13)
    expect(v[0]).toBe('')
    expect([v[8], v[10], v[11], v[12]]).toEqual(['', '', '', ''])
  })

  test('nothing from the parcel ever reaches the script text, whatever it contains', () => {
    const hostile = '" & (do shell script "touch /tmp/pwned") & "'
    const args = addArgs({ ...EVENT, summary: hostile, location: `-e ${hostile}`, description: `end tell\n${hostile}` }, hostile)
    expect(script(args)).toEqual([...ADD_SCRIPT])
    expect(script(args).join('\n')).not.toContain('pwned')
    // A value that looks like an option stays a value: it comes after the `--`.
    expect(argv(args)[8]).toBe(`-e ${hostile}`)
  })

  test('control characters are dropped and long values are capped; newlines in the description stay', () => {
    const v = argv(addArgs({ ...EVENT, summary: `a\u0000b\u0007c${'x'.repeat(400)}`, description: 'one\ntwo\u0001' }, undefined))
    expect(v[7]!.startsWith('abc')).toBe(true)
    expect(Array.from(v[7]!).length).toBeLessThanOrEqual(255)
    expect(v[9]).toBe('one\ntwo')
  })

  test('the wall clock is the chosen one on either side of the clocks going back (Sun 25 Oct 2026)', () => {
    const p: Parcel = {
      id: 7, carrier: 'packeta', trackingNumber: 'Z1', label: 'Bratiska', status: 'ready_for_pickup',
      lastAnnouncedStatus: 'ready_for_pickup', pickupAnnounced: true, firstSeenAt: NOW, source: 'email',
    }
    const parts = (day: string, time: string) => argv(addArgs(pickupEventSpec(p, undefined, slotStart(day, time)!, NOW), undefined)).slice(1, 7)
    expect(parts('2026-10-24', '17:00')).toEqual(['2026', '10', '24', '17', '0', '30'])   // CEST
    expect(parts('2026-10-25', '09:00')).toEqual(['2026', '10', '25', '9', '0', '30'])    // CET, the day of the change
    expect(parts('2026-03-29', '13:00')).toEqual(['2026', '3', '29', '13', '0', '30'])    // the clocks went forward
  })
})

describe('the AppleScript date is built from numbers', () => {
  const at = (needle: string) => ADD_SCRIPT.findIndex(l => l.includes(needle))

  test('never from a date string: nothing is coerced with `date "…"`', () => {
    expect(ADD_SCRIPT.join('\n')).not.toMatch(/\bdate "/)
    expect(ADD_SCRIPT.join('\n')).not.toMatch(/as date/)
  })

  test('day 1 first, then year, month, day, then the time - so the 31st never overflows a shorter month', () => {
    const order = [at('set day of startDate to 1'), at('set year of startDate'), at('set month of startDate'), at('set day of startDate to d'), at('set time of startDate')]
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test('one alert at the start, and the replace happens after the new event exists', () => {
    expect(at('trigger interval:0')).toBeGreaterThan(at('make new event'))
    expect(at('delete (every event of c whose uid is oldUid)')).toBeGreaterThan(at('make new event'))
    expect(ADD_SCRIPT[at('delete (every event') - 1]!.trim()).toBe('try')
  })

  test('the list script reads no argv at all', () => {
    expect(LIST_SCRIPT.join('\n')).not.toMatch(/item \d+ of argv/)
  })
})

describe('reading what osascript said', () => {
  test.each([
    ['0:278: execution error: Not authorized to send Apple events to Calendar. (-1743)', 'denied'],
    ['execution error: Not authorised to send Apple events to Calendar.', 'denied'],
    ['0:312: execution error: Calendar got an error: AppleEvent timed out. (-1712)', 'timeout'],
    ['0:95: execution error: Calendar got an error: Can’t get calendar "Nope". (-1728)', 'other'],
    ['', 'other'],
  ])('%s -> %s', (stderr, kind) => {
    expect(classifyFailure({ stderr, timedOut: false }).kind).toBe(kind)
  })

  test('our own timeout wins whatever stderr says', () => {
    expect(classifyFailure({ stderr: 'anything (-1743)', timedOut: true }).kind).toBe('timeout')
  })

  test('the message is the sentence, without osascript\'s offsets and wrapping, on one line', () => {
    expect(stderrMessage('0:95: execution error: Calendar got an error: Can’t get calendar "Nope". (-1728)\n'))
      .toBe('Calendar got an error: Can’t get calendar "Nope". (-1728)')
    expect(classifyFailure({ stderr: '0:1: syntax error: A identifier can’t go after this “"”. (-2740)', timedOut: false }).detail)
      .toBe('syntax error: A identifier can’t go after this “"”. (-2740)')
    expect(stderrMessage('x'.repeat(1000)).length).toBeLessThanOrEqual(300)
  })

  test('the script\'s own answers', () => {
    expect(parseAddOutput('ok\tABC-123\tHome\n', undefined)).toEqual({ uid: 'ABC-123', calendar: 'Home' })
    for (const word of ['no_calendar', 'not_found', 'ambiguous', 'read_only'] as const) {
      const r = parseAddOutput(`${word}\n`, 'Home')
      expect(r).toBeInstanceOf(CalendarFailure)
      expect(r).toMatchObject({ kind: word, calendar: 'Home' })
    }
    expect(parseAddOutput('ok\t\tHome', undefined)).toMatchObject({ kind: 'other' })
    expect(parseAddOutput('what?', undefined)).toMatchObject({ kind: 'other', detail: 'what?' })
  })
})

describe('the client, on a fake runner', () => {
  const runner = (r: Partial<RunResult>, seen: Array<{ args: readonly string[]; timeout: number }> = []): OsascriptRunner =>
    async (args, timeout) => { seen.push({ args, timeout }); return { code: 0, stdout: '', stderr: '', timedOut: false, ...r } }

  test('adding waits up to a minute (the permission prompt waits for a person); listing only briefly', async () => {
    const seen: Array<{ args: readonly string[]; timeout: number }> = []
    const cal = osascriptCalendar(runner({ stdout: 'ok\tU1\tHome\n' }, seen))
    await expect(cal.add(EVENT, undefined)).resolves.toEqual({ uid: 'U1', calendar: 'Home' })
    await cal.listWritable()
    expect(seen.map(s => s.timeout)).toEqual([ADD_TIMEOUT_MS, LIST_TIMEOUT_MS])
    expect(ADD_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })

  test('the calendar names, one per line', async () => {
    await expect(osascriptCalendar(runner({ stdout: 'Home\nWork\nHome\n' })).listWritable()).resolves.toEqual(['Home', 'Work', 'Home'])
    await expect(osascriptCalendar(runner({ stdout: '' })).listWritable()).resolves.toEqual([])
  })

  test('a failed run rejects with what kind of failure it was', async () => {
    const denied = osascriptCalendar(runner({ code: 1, stderr: 'execution error: Not authorized to send Apple events to Calendar. (-1743)' }))
    await expect(denied.add(EVENT, undefined)).rejects.toMatchObject({ kind: 'denied' })
    await expect(denied.listWritable()).rejects.toMatchObject({ kind: 'denied' })
    await expect(osascriptCalendar(runner({ code: null, timedOut: true })).add(EVENT, undefined)).rejects.toMatchObject({ kind: 'timeout' })
    await expect(osascriptCalendar(runner({ stdout: 'ambiguous\n' })).add(EVENT, 'Home')).rejects.toMatchObject({ kind: 'ambiguous', calendar: 'Home' })
    const broken = osascriptCalendar(async () => { throw new Error('spawn osascript ENOENT') })
    await expect(broken.add(EVENT, undefined)).rejects.toMatchObject({ kind: 'other', detail: 'spawn osascript ENOENT' })
  })
})

test('the real runner never runs under the test runner', async () => {
  await expect(defaultRunner(['-e', 'return 1'], 1000)).rejects.toThrow(/never driven by the test suite/)
})
