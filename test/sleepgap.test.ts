import { test, expect, describe } from 'vitest'
import {
  sleptSinceMs, checkSleepGap, recordPoll, parseSysctlTime, readLastWakeMs, LONG_GAP_MS,
} from '../src/core/sleepgap.js'
import { runPoll } from '../src/core/poll.js'
import { updateParcelState, setNeedsPostcode } from '../src/db/parcels.js'
import { recordHealth } from '../src/db/health.js'
import { NOW, config, memDb, addParcel, ev, okResult, stubAdapter, bodyHttp } from './poll-helpers.js'

const HOUR = 3_600_000
const T0 = Date.parse('2026-10-26T20:00:00Z')   // the last recorded poll
const wakeAt = (hoursAfterPoll: number) => T0 + hoursAfterPoll * HOUR

describe('sleptSinceMs', () => {
  test('reports zero when the last wake is not later than the last poll (the Mac has not slept since)', () => {
    expect(sleptSinceMs(T0, wakeAt(-5))).toBe(0)
    expect(sleptSinceMs(T0, wakeAt(0))).toBe(0)
  })

  test('reports last wake minus last poll when the Mac woke after the poll: 21:00 poll, 07:00 wake is 10h', () => {
    expect(sleptSinceMs(T0, wakeAt(10))).toBe(10 * HOUR)
    expect(sleptSinceMs(T0, wakeAt(0) + 1)).toBe(1)
  })

  test('never reports negative sleep, and reports none when the wake time could not be read', () => {
    expect(sleptSinceMs(T0, wakeAt(-0.001))).toBe(0)
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

describe('readLastWakeMs', () => {
  test('reads kern.waketime through the injected sysctl, and asks for nothing else', () => {
    const asked: string[] = []
    const wake = readLastWakeMs(name => { asked.push(name); return '{ sec = 1793036854, usec = 797269 } Mon Oct 26 18:47:34 2026\n' })
    expect(wake).toBe(1793036854797)
    expect(asked).toEqual(['kern.waketime'])
  })

  test('a DarkWake maintenance cycle just before the wake does not shrink the gap (kern.sleeptime is ignored)', () => {
    // 07:00 real wake, preceded 16 seconds earlier by a maintenance sleep, as on this Mac.
    const sysctl = (name: string) => name === 'kern.waketime'
      ? '{ sec = 1793008800, usec = 0 }' : '{ sec = 1793008784, usec = 0 }'
    const db = memDb(); recordPoll(db, 1793008800_000 - 10 * HOUR)
    expect(checkSleepGap(db, () => readLastWakeMs(sysctl))).toEqual({ sleptMs: 10 * HOUR, longGap: true })
  })

  test('is undefined when sysctl cannot be run or prints something unintelligible', () => {
    expect(readLastWakeMs(() => undefined)).toBeUndefined()
    expect(readLastWakeMs(() => 'sysctl: unknown oid')).toBeUndefined()
  })

  test('the real sysctl on this machine gives a plausible time or undefined, and never throws', () => {
    const wake = readLastWakeMs()
    if (wake !== undefined) {
      expect(wake).toBeGreaterThan(Date.parse('2020-01-01'))
      expect(wake).toBeLessThanOrEqual(Date.now() + 5000)
    }
  })
})

describe('checkSleepGap', () => {
  test('the first ever run has no recorded poll to compare with, so it is not a long gap', () => {
    expect(checkSleepGap(memDb(), () => wakeAt(10))).toEqual({ sleptMs: 0, longGap: false })
  })

  test('compares against the poll recorded in the database, which a later process can read', () => {
    const db = memDb()
    recordPoll(db, T0)
    expect(db.prepare('SELECT polled_at_ms FROM last_poll').all()).toEqual([{ polled_at_ms: T0 }])
    expect(checkSleepGap(db, () => wakeAt(10))).toEqual({ sleptMs: 10 * HOUR, longGap: true })
    recordPoll(db, wakeAt(11))
    expect(db.prepare('SELECT COUNT(*) AS n FROM last_poll').get()).toEqual({ n: 1 })   // overwritten, never appended
  })

  test('checking does not record anything: only recordPoll does, so a crashed run is retried', () => {
    const db = memDb()
    recordPoll(db, T0)
    expect(checkSleepGap(db, () => wakeAt(10)).longGap).toBe(true)
    expect(checkSleepGap(db, () => wakeAt(10)).longGap).toBe(true)   // nothing was recorded in between
  })

  test('a gap of exactly 6 hours is not long; one millisecond more is', () => {
    expect(LONG_GAP_MS).toBe(6 * HOUR)
    const db = memDb(); recordPoll(db, T0)
    expect(checkSleepGap(db, () => T0 + 6 * HOUR).longGap).toBe(false)
    expect(checkSleepGap(db, () => T0 + 6 * HOUR + 1).longGap).toBe(true)
  })

  test('hourly polls on a Mac that has not woken since the previous poll never trip it', () => {
    const db = memDb()
    for (let h = 0; h < 15; h++) {
      recordPoll(db, T0 + h * HOUR)
      expect(checkSleepGap(db, () => T0 + h * HOUR - 3 * HOUR).longGap).toBe(false)
    }
  })

  test('a reader that finds nothing (undefined) is "no gap", never an error', () => {
    const db = memDb(); recordPoll(db, T0)
    expect(checkSleepGap(db, () => undefined)).toEqual({ sleptMs: 0, longGap: false })
  })

  test('a reader that throws is also "no gap": sleep detection must never break a poll', () => {
    const db = memDb(); recordPoll(db, T0)
    expect(checkSleepGap(db, () => { throw new Error('boom') })).toEqual({ sleptMs: 0, longGap: false })
  })

  test('a database error while reading the last poll is "no gap" too', () => {
    const db = memDb()
    db.exec('DROP TABLE last_poll')
    expect(checkSleepGap(db, () => wakeAt(10))).toEqual({ sleptMs: 0, longGap: false })
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
