import { test, expect, describe } from 'vitest'
import { readFileSync } from 'node:fs'
import { DateTime } from 'luxon'
import { POLL_SLOTS, nextSlot, missedSlot } from '../src/core/schedule.js'

const ZONE = 'Europe/Bratislava'
/** A wall-clock time in Bratislava, as a Date. Explicit so no test depends on the machine's zone. */
const at = (iso: string): Date => DateTime.fromISO(iso, { zone: ZONE }).toJSDate()
const iso = (d: Date): string => DateTime.fromJSDate(d, { zone: ZONE }).toISO({ suppressMilliseconds: true })!

describe('POLL_SLOTS', () => {
  test('are the launchd template\'s hour and minute pairs, in order', () => {
    const plist = readFileSync(new URL('../launchd/local.parcels.poller.plist.template', import.meta.url), 'utf8')
    const pairs = [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/g)]
      .map((m) => ({ hour: Number(m[1]), minute: Number(m[2]) }))
    expect(pairs).toHaveLength(16)
    expect(POLL_SLOTS).toEqual(pairs)
  })
})

describe('nextSlot', () => {
  test('picks the first slot of the day before it opens', () => {
    expect(iso(nextSlot(at('2026-10-29T06:59'), ZONE))).toBe('2026-10-29T07:00:00+01:00')
  })

  test('is strictly after: a time exactly at a slot returns the next one', () => {
    expect(iso(nextSlot(at('2026-10-29T15:00:00'), ZONE))).toBe('2026-10-29T15:30:00+01:00')
  })

  test('rolls to 07:00 the next day after the last slot', () => {
    expect(iso(nextSlot(at('2026-10-29T21:00'), ZONE))).toBe('2026-10-30T07:00:00+01:00')
  })

  test('stays on wall-clock time across the autumn DST change (CEST to CET)', () => {
    expect(iso(nextSlot(at('2026-10-24T21:30'), ZONE))).toBe('2026-10-25T07:00:00+01:00')
  })

  test('stays on wall-clock time across the spring DST change (CET to CEST)', () => {
    expect(iso(nextSlot(at('2027-03-27T21:30'), ZONE))).toBe('2027-03-28T07:00:00+02:00')
  })
})

describe('missedSlot', () => {
  test('is true when a slot fell between the last run and now', () => {
    expect(missedSlot(at('2026-10-29T09:05'), at('2026-10-29T14:10'), ZONE)).toBe(true)
  })

  test('is false when no slot fell in between', () => {
    expect(missedSlot(at('2026-10-29T09:05'), at('2026-10-29T09:50'), ZONE)).toBe(false)
  })

  test('counts a slot exactly at now, but not one exactly at the last run', () => {
    expect(missedSlot(at('2026-10-29T09:05'), at('2026-10-29T10:00'), ZONE)).toBe(true)
    expect(missedSlot(at('2026-10-29T10:00'), at('2026-10-29T10:59'), ZONE)).toBe(false)
  })

  test('counts a never-run poller as missed', () => {
    expect(missedSlot(undefined, at('2026-10-29T09:50'), ZONE)).toBe(true)
  })
})
