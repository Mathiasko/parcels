import { test, expect, describe } from 'vitest'
import {
  sleptSinceMs, checkSleepGap, recordPoll, parseSysctlTime, readWakeEvents, LONG_GAP_MS, type SleepEvents,
} from '../src/core/sleepgap.js'
import { runPoll } from '../src/core/poll.js'
import { updateParcelState, setNeedsPostcode } from '../src/db/parcels.js'
import { recordHealth } from '../src/db/health.js'
import { NOW, config, memDb, addParcel, ev, okResult, stubAdapter, bodyHttp } from './poll-helpers.js'

const HOUR = 3_600_000
const T0 = Date.parse('2026-10-26T20:00:00Z')   // the last recorded poll
const wake = (hoursAfterPoll: number, sleepHoursAfterPoll?: number): SleepEvents => ({
  wakeMs: T0 + hoursAfterPoll * HOUR,
  sleepMs: sleepHoursAfterPoll === undefined ? undefined : T0 + sleepHoursAfterPoll * HOUR,
})

describe('sleptSinceMs', () => {
  test('reports zero when the last wake is not later than the last poll (the Mac has not slept since)', () => {
    expect(sleptSinceMs(T0, wake(-5, -6))).toBe(0)
    expect(sleptSinceMs(T0, wake(0))).toBe(0)
  })

  test('reports the time from the sleep to the wake when the Mac slept after the poll', () => {
    // Polled 20:00, stayed awake until 23:00, slept until 07:00: 8h asleep, not the 11h since the poll.
    expect(sleptSinceMs(T0, wake(11, 3))).toBe(8 * HOUR)
  })

  test('falls back to the time since the poll when the sleep time is unknown', () => {
    expect(sleptSinceMs(T0, wake(10))).toBe(10 * HOUR)
  })

  test('a sleep that began before the poll counts only from the poll', () => {
    expect(sleptSinceMs(T0, wake(2, -1))).toBe(2 * HOUR)
  })

  test('never reports negative sleep, and reports none when the wake time could not be read', () => {
    expect(sleptSinceMs(T0, wake(5, 9))).toBe(0)   // nonsense: slept after waking
    expect(sleptSinceMs(T0, undefined)).toBe(0)
  })
})

describe('parseSysctlTime', () => {
  test('reads the sec and usec fields of kern.waketime output', () => {
    expect(parseSysctlTime('{ sec = 1793036854, usec = 797269 } Mon Oct 26 18:47:34 2026\n')).toBe(1793036854797)
  })
  test('returns undefined for output it does not understand, and for the zero "never happened" value', () => {
    expect(parseSysctlTime('')).toBeUndefined()
    expect(parseSysctlTime('sysctl: unknown oid')).toBeUndefined()
    expect(parseSysctlTime('{ sec = 0, usec = 0 } Thu Jan  1 01:00:00 1970')).toBeUndefined()
  })
})

test('readWakeEvents on this machine returns plausible values or undefined, and never throws', () => {
  const e = readWakeEvents()
  if (e) {
    expect(e.wakeMs).toBeGreaterThan(Date.parse('2020-01-01'))
    expect(e.wakeMs).toBeLessThanOrEqual(Date.now() + 5000)
  }
})

describe('checkSleepGap', () => {
  test('the first ever run has no recorded poll to compare with, so it is not a long gap', () => {
    expect(checkSleepGap(memDb(), () => wake(10, 1))).toEqual({ sleptMs: 0, longGap: false })
  })

  test('compares against the poll recorded in the database, which a later process can read', () => {
    const db = memDb()
    recordPoll(db, T0)
    expect(db.prepare('SELECT polled_at_ms FROM last_poll').all()).toEqual([{ polled_at_ms: T0 }])
    expect(checkSleepGap(db, () => wake(10, 1))).toEqual({ sleptMs: 9 * HOUR, longGap: true })
    recordPoll(db, T0 + 11 * HOUR)
    expect(db.prepare('SELECT COUNT(*) AS n FROM last_poll').get()).toEqual({ n: 1 })   // overwritten, never appended
  })

  test('checking does not record anything: only recordPoll does, so a crashed run is retried', () => {
    const db = memDb()
    recordPoll(db, T0)
    expect(checkSleepGap(db, () => wake(10, 1)).longGap).toBe(true)
    expect(checkSleepGap(db, () => wake(10, 1)).longGap).toBe(true)   // nothing was recorded in between
  })

  test('a gap of exactly 6 hours is not long; one millisecond more is', () => {
    expect(LONG_GAP_MS).toBe(6 * HOUR)
    const db = memDb(); recordPoll(db, T0)
    expect(checkSleepGap(db, () => ({ wakeMs: T0 + 7 * HOUR, sleepMs: T0 + HOUR })).longGap).toBe(false)
    expect(checkSleepGap(db, () => ({ wakeMs: T0 + 7 * HOUR + 1, sleepMs: T0 + HOUR })).longGap).toBe(true)
  })

  test('hourly polls on a Mac that has not slept never trip it', () => {
    const db = memDb()
    for (let h = 0; h < 15; h++) {
      recordPoll(db, T0 + h * HOUR)
      expect(checkSleepGap(db, () => wake(-3, -4)).longGap).toBe(false)
    }
  })

  test('a reader that fails (undefined) is "no gap", never an error', () => {
    const db = memDb(); recordPoll(db, T0)
    expect(checkSleepGap(db, () => undefined)).toEqual({ sleptMs: 0, longGap: false })
  })

  test('a reader that throws is also "no gap": sleep detection must never break a poll', () => {
    const db = memDb(); recordPoll(db, T0)
    expect(checkSleepGap(db, () => { throw new Error('boom') })).toEqual({ sleptMs: 0, longGap: false })
  })
})

describe('forced full refresh', () => {
  // A parcel that moved 20 days ago and was tried a minute ago: its backoff tier says "not due".
  function staleParcel(db = memDb(), carrier: 'posta' | 'gls' = 'posta', number = 'RA000000001SK') {
    const id = addParcel(db, carrier, number)
    updateParcelState(db, id, {
      status: 'in_transit', statusRaw: 'x', lastPolledAt: new Date(NOW.getTime() - 60_000),
      lastChangedAt: new Date(NOW.getTime() - 20 * 24 * HOUR),
    })
    return { db, id }
  }
  const adapter = (carrier: 'posta' | 'gls' = 'posta') =>
    stubAdapter(carrier, ins => ins.map(i => okResult(i.number, [ev('2026-10-26 09:00:00', 'in_transit')])), 100)

  test('without the flag the backoff tier skips it', async () => {
    const posta = adapter()
    const report = await runPoll({ db: staleParcel().db, http: bodyHttp(), adapters: [posta], config, now: NOW })
    expect(report.polled).toBe(0)
    expect(posta.calls).toEqual([])
  })

  test('with forceAll it is polled regardless of its tier', async () => {
    const posta = adapter()
    const report = await runPoll({ db: staleParcel().db, http: bodyHttp(), adapters: [posta], config, now: NOW, forceAll: true })
    expect(report.polled).toBe(1)
  })

  test('forceAll still never polls a delivered parcel', async () => {
    const { db } = staleParcel()
    db.prepare("UPDATE parcels SET status = 'delivered'").run()
    const posta = adapter()
    const report = await runPoll({ db, http: bodyHttp(), adapters: [posta], config, now: NOW, forceAll: true })
    expect(report.polled).toBe(0)
  })

  test('forceAll sends NOTHING to a gated carrier inside its backoff window, but still refreshes the others', async () => {
    const { db } = staleParcel(undefined, 'posta', 'RA000000001SK')
    staleParcel(db, 'posta', 'RA000000002SK')
    staleParcel(db, 'gls', '12345678901')
    recordHealth(db, 'posta', 'gated', 'endpoint closed', new Date(NOW.getTime() - 10 * 60_000))   // 1h window, 10 min in
    const posta = adapter('posta'); const gls = adapter('gls')

    const report = await runPoll({ db, http: bodyHttp(), adapters: [posta, gls], config, now: NOW, forceAll: true })

    expect(posta.calls).toEqual([])
    expect(gls.calls).toHaveLength(1)
    expect(report.polled).toBe(1)
  })

  test('forceAll sends exactly one canary to a gated carrier whose window has elapsed', async () => {
    const { db } = staleParcel(undefined, 'posta', 'RA000000001SK')
    staleParcel(db, 'posta', 'RA000000002SK')
    staleParcel(db, 'posta', 'RA000000003SK')
    recordHealth(db, 'posta', 'gated', 'endpoint closed', new Date(NOW.getTime() - 2 * HOUR))   // 1h window, elapsed
    const posta = adapter('posta')

    const report = await runPoll({ db, http: bodyHttp(), adapters: [posta], config, now: NOW, forceAll: true })

    expect(posta.calls).toHaveLength(1)
    expect(posta.calls[0]).toHaveLength(1)
    expect(report.polled).toBe(1)
  })

  test('forceAll does not re-send a parcel whose postcode the carrier already rejected', async () => {
    const { db, id } = staleParcel(undefined, 'gls', '12345678901')
    staleParcel(db, 'gls', '12345678902')
    setNeedsPostcode(db, id, '')   // rejected with no postcode stored
    const gls = adapter('gls')

    const report = await runPoll({ db, http: bodyHttp(), adapters: [gls], config, now: NOW, forceAll: true })

    expect(gls.calls.flat().map(i => i.number)).toEqual(['12345678902'])
    expect(report.polled).toBe(1)
  })
})
