import { describe, expect, test } from 'vitest'
import {
  ALARM_STALE_MS, HEALTH_STALE_MS, pollerStatus, stalePollAlarm, windowMsBetween,
} from '../src/core/pollwatch.js'
import { recordPoll } from '../src/core/sleepgap.js'
import { runPoll } from '../src/core/poll.js'
import { buildServer } from '../src/web/server.js'
import { bodyHttp, config, memDb } from './poll-helpers.js'

const HOUR = 3_600_000
// Europe/Bratislava is UTC+1 on these dates (DST ended 2026-10-25).
const at = (iso: string) => Date.parse(`${iso}+01:00`)
const MORNING = new Date(at('2026-10-26T07:30:00'))     // inside the window, first poll of the day
const AFTERNOON = new Date(at('2026-10-26T16:00:00'))

describe('windowMsBetween', () => {
  test('only the 07:00-21:00 part of the span counts: 21:00 to 07:30 is 30 minutes, not 10.5 hours', () => {
    expect(windowMsBetween(at('2026-10-25T21:00:00'), at('2026-10-26T07:30:00'))).toBe(0.5 * HOUR)
  })
  test('counts across several days and ignores a span entirely inside the night', () => {
    expect(windowMsBetween(at('2026-10-26T12:00:00'), at('2026-10-28T12:00:00'))).toBe((9 + 14 + 5) * HOUR)
    expect(windowMsBetween(at('2026-10-25T22:00:00'), at('2026-10-26T05:00:00'))).toBe(0)
  })
  test('is zero for an empty or reversed span', () => {
    expect(windowMsBetween(at('2026-10-26T10:00:00'), at('2026-10-26T10:00:00'))).toBe(0)
    expect(windowMsBetween(at('2026-10-26T12:00:00'), at('2026-10-26T10:00:00'))).toBe(0)
  })
})

describe('pollerStatus (Health page)', () => {
  test('no poll ever recorded is "no data", not a fault', () => {
    expect(pollerStatus(memDb(), AFTERNOON)).toEqual({ overdue: false })
  })
  test('the normal overnight silence is not flagged on the first morning poll', () => {
    const db = memDb(); recordPoll(db, at('2026-10-25T21:00:00'))
    expect(pollerStatus(db, MORNING).overdue).toBe(false)
  })
  test('flagged once more than 2h of the day has passed with no completed run, and still flagged after 21:00', () => {
    const db = memDb(); recordPoll(db, at('2026-10-26T12:00:00'))
    expect(pollerStatus(db, new Date(at('2026-10-26T13:59:00'))).overdue).toBe(false)
    expect(pollerStatus(db, new Date(at('2026-10-26T14:01:00'))).overdue).toBe(true)
    expect(pollerStatus(db, new Date(at('2026-10-26T22:00:00'))).overdue).toBe(true)    // night does not hide an outage
    expect(HEALTH_STALE_MS).toBe(2 * HOUR)
  })
  test('a poller last seen at 08:00 is overdue when /health is viewed at 22:00, but not a 21:00 poll at 07:30', () => {
    const db = memDb(); recordPoll(db, at('2026-10-26T08:00:00'))
    expect(pollerStatus(db, new Date(at('2026-10-26T22:00:00'))).overdue).toBe(true)   // 13 window-hours
    const night = memDb(); recordPoll(night, at('2026-10-25T21:00:00'))
    expect(pollerStatus(night, MORNING).overdue).toBe(false)                           // 0.5 window-hours
  })
  test('a night-time run after a long outage still announces it', () => {
    const db = memDb(); recordPoll(db, at('2026-10-26T08:00:00'))
    expect(stalePollAlarm(db, new Date(at('2026-10-26T22:00:00')))).toBeDefined()
  })
  test('GET /health shows the last run and flags a stale poller', async () => {
    const db = memDb(); recordPoll(db, at('2026-10-26T09:00:00'))
    const get = async (now: Date) => (await buildServer({ db, config, now: () => now, notifier: { send: async () => {} } })
      .inject({ method: 'GET', url: '/health' })).body
    const fresh = await get(new Date(at('2026-10-26T09:30:00')))
    expect(fresh).toContain('id="poller-health"')
    expect(fresh).not.toContain('not running?')
    const stale = await get(new Date(at('2026-10-26T14:00:00')))
    expect(stale).toContain('not running?')
  })
})

describe('the poller announces that it was away', () => {
  test('after more than 6h of the day without a completed run, once per outage', () => {
    const db = memDb(); recordPoll(db, at('2026-10-26T08:00:00'))
    expect(stalePollAlarm(db, new Date(at('2026-10-26T13:00:00')))).toBeUndefined()      // 5h
    const alarm = stalePollAlarm(db, new Date(at('2026-10-26T15:00:00')))                // 7h
    expect(alarm).toMatchObject({ title: 'Parcel polling was interrupted' })
    expect(stalePollAlarm(db, new Date(at('2026-10-26T16:00:00')))).toBeUndefined()      // same outage: silent
    recordPoll(db, at('2026-10-26T16:30:00'))                                            // recovered
    expect(stalePollAlarm(db, new Date(at('2026-10-27T07:30:00')))).toBeUndefined()      // 4.5h + 0.5h of day: a normal night
  })

  test('a new outage after recovery is announced afresh', () => {
    const db = memDb(); recordPoll(db, at('2026-10-26T08:00:00'))
    expect(stalePollAlarm(db, new Date(at('2026-10-26T15:00:00')))).toBeDefined()
    recordPoll(db, at('2026-10-27T08:00:00'))
    expect(stalePollAlarm(db, new Date(at('2026-10-27T15:00:00')))).toBeDefined()
    expect(ALARM_STALE_MS).toBe(6 * HOUR)
  })

  test('never on the first run, nor on the first poll after a normal night', () => {
    const db = memDb()
    expect(stalePollAlarm(db, AFTERNOON)).toBeUndefined()
    recordPoll(db, at('2026-10-25T21:00:00'))
    expect(stalePollAlarm(db, MORNING)).toBeUndefined()
  })

  test('end to end: a run after a 7h daytime gap sends exactly one banner, and the next run none', async () => {
    const db = memDb(); recordPoll(db, at('2026-10-26T08:00:00'))
    const sent: Array<{ groupKey: string; title: string }> = []
    const notifier = { send: async (n: { groupKey: string; title: string }) => { sent.push(n) } }
    const run = (now: Date) => runPoll({ db, http: bodyHttp(), adapters: [], config, now, notifier })
    await run(new Date(at('2026-10-26T15:00:00')))
    await run(new Date(at('2026-10-26T15:05:00')))   // last_poll not re-recorded here: must still be silent
    expect(sent).toEqual([expect.objectContaining({ groupKey: 'poller', title: 'Parcel polling was interrupted' })])
  })
})
