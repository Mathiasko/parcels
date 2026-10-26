import { test, expect, describe } from 'vitest'
import { sleptSinceMs, checkSleepGap, readClocks, LONG_GAP_MS } from '../src/core/sleepgap.js'
import { runPoll } from '../src/core/poll.js'
import { updateParcelState } from '../src/db/parcels.js'
import { NOW, config, memDb, addParcel, ev, okResult, stubAdapter, bodyHttp } from './poll-helpers.js'

const HOUR = 3_600_000
const wall0 = Date.parse('2026-10-26T06:00:00Z')
const up0 = 5_000_000   // arbitrary: only differences between readings mean anything

test('reports roughly zero sleep when wall and uptime advance together', () => {
  // Real clocks, no injection: two readings taken back to back cannot differ by minutes of sleep.
  const before = readClocks()
  expect(sleptSinceMs(before.wallMs, before.awakeMs)).toBeCloseTo(0, -3)
  // And with injected readings that advance in step by an hour.
  expect(sleptSinceMs(wall0, up0, { wallMs: wall0 + HOUR, awakeMs: up0 + HOUR })).toBe(0)
})

test('reports the difference when wall advances more than uptime', () => {
  const now = { wallMs: wall0 + 3_600_000, awakeMs: up0 + 600_000 }
  expect(sleptSinceMs(wall0, up0, now)).toBeCloseTo(3_000_000, -4)
})

test('never reports negative sleep', () => {
  // Uptime ran ahead of the wall clock (the clock was stepped back): clamp, do not go negative.
  expect(sleptSinceMs(wall0, up0, { wallMs: wall0 + 60_000, awakeMs: up0 + 600_000 })).toBe(0)
})

test('after a reboot (awake time went backwards) the whole wall gap counts, since nothing was polling', () => {
  expect(sleptSinceMs(wall0, up0, { wallMs: wall0 + 8 * HOUR, awakeMs: 120_000 })).toBe(8 * HOUR)
})

describe('checkSleepGap', () => {
  const clocks = (hoursWall: number, hoursAwake: number) => ({ wallMs: wall0 + hoursWall * HOUR, awakeMs: up0 + hoursAwake * HOUR })

  test('the first ever run has nothing to compare with, so it is not a long gap', () => {
    expect(checkSleepGap(memDb(), clocks(0, 0))).toEqual({ sleptMs: 0, longGap: false })
  })

  test('persists the previous pair in the database, so a later process can compare against it', () => {
    const db = memDb()
    checkSleepGap(db, clocks(0, 0))
    expect(db.prepare('SELECT wall_ms, uptime_ms FROM poll_clock').all()).toEqual([{ wall_ms: wall0, uptime_ms: up0 }])
    // 10 wall hours, 1 awake hour: 9 hours slept.
    expect(checkSleepGap(db, clocks(10, 1))).toEqual({ sleptMs: 9 * HOUR, longGap: true })
    expect(db.prepare('SELECT COUNT(*) AS n FROM poll_clock').get()).toEqual({ n: 1 })   // overwritten, never appended
  })

  test('a gap of exactly 6 hours is not long; one millisecond more is', () => {
    expect(LONG_GAP_MS).toBe(6 * HOUR)
    const a = memDb(); checkSleepGap(a, clocks(0, 0))
    expect(checkSleepGap(a, { wallMs: wall0 + 7 * HOUR, awakeMs: up0 + HOUR }).longGap).toBe(false)   // slept exactly 6h
    const b = memDb(); checkSleepGap(b, clocks(0, 0))
    expect(checkSleepGap(b, { wallMs: wall0 + 7 * HOUR + 1, awakeMs: up0 + HOUR }).longGap).toBe(true)
  })

  test('a normal hourly cadence with the Mac awake never trips it, however many runs', () => {
    const db = memDb()
    for (let h = 0; h < 15; h++) expect(checkSleepGap(db, clocks(h, h)).longGap).toBe(false)
  })

  test('sleeping through a night of un-polled hours trips it, and the next run is back to normal', () => {
    const db = memDb()
    checkSleepGap(db, clocks(0, 0))                    // 21:00 poll
    expect(checkSleepGap(db, clocks(10, 0.1)).longGap).toBe(true)    // 07:00 poll, asleep in between
    expect(checkSleepGap(db, clocks(11, 1.1)).longGap).toBe(false)   // 08:00 poll
  })
})

describe('forced full refresh', () => {
  // A parcel that moved a month ago and was tried a minute ago: its backoff tier says "not due".
  function staleParcel() {
    const db = memDb()
    const id = addParcel(db, 'posta', 'RA000000001SK')
    updateParcelState(db, id, {
      status: 'in_transit', statusRaw: 'x', lastPolledAt: new Date(NOW.getTime() - 60_000),
      lastChangedAt: new Date(NOW.getTime() - 20 * 24 * HOUR),
    })
    return db
  }
  const adapter = () => stubAdapter('posta', ins => ins.map(i => okResult(i.number, [ev('2026-10-26 09:00:00', 'in_transit')])), 100)

  test('without the flag the backoff tier skips it', async () => {
    const posta = adapter()
    const report = await runPoll({ db: staleParcel(), http: bodyHttp(), adapters: [posta], config, now: NOW })
    expect(report.polled).toBe(0)
    expect(posta.calls).toEqual([])
  })

  test('with forceAll it is polled regardless of its tier', async () => {
    const posta = adapter()
    const report = await runPoll({ db: staleParcel(), http: bodyHttp(), adapters: [posta], config, now: NOW, forceAll: true })
    expect(report.polled).toBe(1)
  })

  test('forceAll still never polls a delivered parcel', async () => {
    const db = staleParcel()
    db.prepare("UPDATE parcels SET status = 'delivered'").run()
    const posta = adapter()
    const report = await runPoll({ db, http: bodyHttp(), adapters: [posta], config, now: NOW, forceAll: true })
    expect(report.polled).toBe(0)
  })
})
