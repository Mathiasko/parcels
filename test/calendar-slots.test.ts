import { describe, expect, test } from 'vitest'
import {
  formatSlot, NO_DEADLINE_DAYS, pickupSlots, slotAllowed, slotOf, slotStart, timeLabel, wallClock,
} from '../src/web/calendar-slots.js'

/** A moment in Bratislava in late October 2026 (CET, UTC+1, after the clocks went back on the 25th). */
const at = (day: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, day, h - 1, m))
/** Mon 26 Oct 2026, 11:00 in Bratislava: 9:00 has gone, 13:00 and 17:00 are still to come. */
const MON_11 = at(26, 11)
const labels = (s: ReturnType<typeof pickupSlots>) => s.days.map(d => d.label)

describe('a deadline in the future', () => {
  const s = pickupSlots(at(29, 18), MON_11)                // Thu 29 Oct, 18:00

  test('every day from today to the deadline, the deadline day marked "last day"', () => {
    expect(s.days.map(d => d.date)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'])
    expect(labels(s)).toEqual(['Today, from 13:00', 'Tomorrow', 'Wed 28 Oct', 'Thu 29 Oct — last day'])
    expect(s.days.map(d => d.last)).toEqual([false, false, false, true])
  })

  test('defaults to the last day at 9:00', () => {
    expect(s.day).toBe('2026-10-29')
    expect(s.time).toBe('09:00')
  })

  test('today offers only the times still to come; every other day offers all three', () => {
    expect(s.days[0]!.times).toEqual(['13:00', '17:00'])
    for (const d of s.days.slice(1)) expect(d.times).toEqual(['09:00', '13:00', '17:00'])
  })

  test('the deadline counts by its LOCAL date: 00:30 on Thursday is Thursday, though it is Wednesday in UTC', () => {
    expect(pickupSlots(new Date('2026-10-28T23:30:00Z'), MON_11).days.at(-1)!.date).toBe('2026-10-29')
  })

  test('a deadline in the next year prints its year', () => {
    const late = pickupSlots(new Date('2027-01-02T22:59:59.999Z'), new Date('2026-12-30T06:00:00Z'))
    expect(labels(late)).toEqual(['Today', 'Tomorrow', 'Fri 1 Jan 2027', 'Sat 2 Jan 2027 — last day'])
  })
})

describe('no deadline', () => {
  test('today and the six days after it, nothing marked "last day", defaulting to today at its next time', () => {
    const s = pickupSlots(undefined, MON_11)
    expect(s.days).toHaveLength(NO_DEADLINE_DAYS)
    expect(s.days.map(d => d.date)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'])
    expect(labels(s)).toEqual(['Today, from 13:00', 'Tomorrow', 'Wed 28 Oct', 'Thu 29 Oct', 'Fri 30 Oct', 'Sat 31 Oct', 'Sun 1 Nov'])
    expect(s.days.some(d => d.last)).toBe(false)
    expect([s.day, s.time]).toEqual(['2026-10-26', '13:00'])
  })

  test('early in the morning today is whole, and 9:00 is the default', () => {
    const s = pickupSlots(undefined, at(26, 7))
    expect(s.days[0]!.label).toBe('Today')
    expect([s.day, s.time]).toEqual(['2026-10-26', '09:00'])
  })

  test('once all of today\'s presets have passed, Today is still offered for "Other", defaulting to the next full hour', () => {
    const s = pickupSlots(undefined, at(26, 17, 30))
    expect(s.days[0]).toMatchObject({ date: '2026-10-26', label: 'Today, after 17:00', times: [], first: '18:00' })
    expect(s.days).toHaveLength(NO_DEADLINE_DAYS)
    expect([s.day, s.time]).toEqual(['2026-10-26', '18:00'])
  })

  test('from 23:00 Today is not offered, and the default is tomorrow at 9:00', () => {
    const s = pickupSlots(undefined, at(26, 23))
    expect(s.days[0]!.label).toBe('Tomorrow')
    expect(s.days).toHaveLength(NO_DEADLINE_DAYS - 1)
    expect([s.day, s.time]).toEqual(['2026-10-27', '09:00'])
  })

  test('a time exactly now has passed', () => {
    expect(pickupSlots(undefined, at(26, 13)).days[0]!.times).toEqual(['17:00'])
  })
})

describe('a deadline that is today or already past', () => {
  test('today: today only, its remaining times, the first of them by default, and it is the last day', () => {
    const s = pickupSlots(at(26, 18), MON_11)
    expect(s.days.map(d => [d.date, d.label, d.times])).toEqual([['2026-10-26', 'Today — last day', ['13:00', '17:00']]])
    expect([s.day, s.time]).toEqual(['2026-10-26', '13:00'])
  })

  test('past: today only, without claiming it is the last day', () => {
    const s = pickupSlots(at(24, 18), MON_11)
    expect(labels(s)).toEqual(['Today'])
    expect([s.day, s.time]).toEqual(['2026-10-26', '13:00'])
  })

  test('after 17:00 only "Other" is left, from the next full hour', () => {
    const s = pickupSlots(at(26, 18), at(26, 17, 1))
    expect(s.days.map(d => [d.label, d.times, d.first])).toEqual([['Today — last day', [], '18:00']])
    expect([s.day, s.time]).toEqual(['2026-10-26', '18:00'])
  })

  test('from 23:00 there is nothing left to offer', () => {
    const s = pickupSlots(at(26, 18), at(26, 23))
    expect(s.days).toEqual([])
    expect(s.day).toBeUndefined()
    expect(s.time).toBeUndefined()
  })
})

describe('what the server accepts', () => {
  const s = pickupSlots(at(29, 18), MON_11)

  test.each([
    ['2026-10-29', '09:00', true],
    ['2026-10-26', '13:00', true],
    ['2026-10-26', '09:00', false],          // passed today
    ['2026-10-30', '09:00', false],          // after the deadline
    ['2026-10-25', '13:00', false],          // yesterday
    ['2026-10-29', '10:00', true],           // "Other": any time
    ['2026-10-26', '11:30', true],           // ... still to come today
    ['2026-10-26', '10:59', false],
    ['2026-10-26', '11:00', false],          // exactly now has passed
    ['2026-10-29', '23:59', true],
    ['2026-10-29', '24:00', false],
    ['2026-10-29', '18:60', false],
    ['2026-10-29', '9:00', false],
    ['2026-10-29', '09:00:00', false],
    ['29.10.2026', '09:00', false],
    ['', '', false],
  ])('%s %s -> %s', (day, time, ok) => {
    expect(slotAllowed(s, day, time)).toBe(ok)
  })
})

describe('local time across the clock changes', () => {
  test.each([
    ['2026-10-24', '09:00', '2026-10-24T07:00:00.000Z'],      // Sat, CEST (UTC+2)
    ['2026-10-25', '09:00', '2026-10-25T08:00:00.000Z'],      // Sun, the clocks went back at 03:00: CET (UTC+1)
    ['2026-03-28', '17:00', '2026-03-28T16:00:00.000Z'],      // Sat, CET
    ['2026-03-29', '17:00', '2026-03-29T15:00:00.000Z'],      // Sun, the clocks went forward at 02:00: CEST
  ])('%s %s in Bratislava is %s', (day, time, iso) => {
    const start = slotStart(day, time)!
    expect(start.toISOString()).toBe(iso)
    // And back again: the wall clock Calendar.app is handed is the one that was chosen.
    const [y, mo, d] = day.split('-').map(Number)
    expect(wallClock(start)).toEqual({ year: y, month: mo, day: d, hour: Number(time.slice(0, 2)), minute: 0 })
    expect(slotOf(start)).toEqual({ day, time })
  })

  test('malformed input is no slot at all', () => {
    expect(slotStart('2026-02-30', '09:00')).toBeUndefined()
    expect(slotStart('2026-10-26', '25:00')).toBeUndefined()
    expect(slotStart('tomorrow', '09:00')).toBeUndefined()
  })
})

test('times are printed the Slovak way, and a stored slot as the radios name its day', () => {
  expect(['09:00', '13:00', '17:00'].map(timeLabel)).toEqual(['9:00', '13:00', '17:00'])
  expect(formatSlot(slotStart('2026-10-30', '09:00')!, MON_11)).toBe('Fri 30 Oct, 9:00')
  expect(formatSlot(slotStart('2027-01-02', '13:00')!, MON_11)).toBe('Sat 2 Jan 2027, 13:00')
})
