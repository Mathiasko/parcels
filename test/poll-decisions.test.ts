// Behaviours the orchestrator must have beyond the brief's listed tests: chunking, notified
// bookkeeping, raw-response pruning, and containment of a carrier whose result cannot be stored.
import { test, expect, describe } from 'vitest'
import { runPoll } from '../src/core/poll.js'
import { findParcel, setNeedsPostcode, updateParcelState } from '../src/db/parcels.js'
import type { HttpClient } from '../src/core/types.js'
import { carrierHealth } from '../src/db/health.js'
import {
  NOW, config, memDb, addParcel, ev, okResult, failResult, stubAdapter, bodyHttp,
} from './poll-helpers.js'

test('chunks a carrier\'s parcels by adapter.batchSize', async () => {
  const db = memDb()
  for (let i = 0; i < 250; i++) addParcel(db, 'posta', `RA${String(i).padStart(9, '0')}SK`)
  const posta = stubAdapter('posta', ins => ins.map(i => okResult(i.number, [])), 100)

  const report = await runPoll({ db, http: bodyHttp(), adapters: [posta], config, now: NOW })

  expect(posta.calls.map(c => c.length)).toEqual([100, 100, 50])
  expect(report.polled).toBe(250)
})

test('marks every appended event notified, including a new parcel\'s whole history, with no notifier', async () => {
  const db = memDb()
  addParcel(db, 'posta', 'RA000000001SK')
  const history = [
    ev('2026-09-01 09:00:00', 'pre_transit', 55 * 24), ev('2026-09-03 09:00:00', 'in_transit', 50 * 24),
    ev('2026-10-26 08:00:00', 'out_for_delivery', 3),
  ]
  const posta = stubAdapter('posta', ins => ins.map(i => okResult(i.number, history)), 100)

  const report = await runPoll({ db, http: bodyHttp(), adapters: [posta], config, now: NOW })

  expect(report.newEvents).toHaveLength(3)
  expect(db.prepare('SELECT COUNT(*) AS n FROM events WHERE notified_at IS NULL').get()).toEqual({ n: 0 })
})

test('a not_found answer stamps the poll and nothing else, so it cannot undo a change made meanwhile', async () => {
  const db = memDb()
  const id = addParcel(db, 'posta', 'RA000000001SK')
  updateParcelState(db, id, { status: 'in_transit', statusRaw: 'old' })
  // The other process marks it delivered while this poll's request is in flight.
  const posta = stubAdapter('posta', ins => {
    updateParcelState(db, id, { status: 'delivered', statusRaw: 'new', statusDetail: 'signed' })
    return ins.map(i => failResult(i.number, 'not_found'))
  }, 100)

  await runPoll({ db, http: bodyHttp(), adapters: [posta], config, now: NOW })

  const p = findParcel(db, 'posta', 'RA000000001SK')!
  expect(p).toMatchObject({ status: 'delivered', statusRaw: 'new', statusDetail: 'signed', lastPolledAt: NOW })
})

test('keeps only the last 5 raw responses per parcel', async () => {
  const db = memDb()
  addParcel(db, 'posta', 'RA000000001SK')
  const posta = stubAdapter('posta', ins => ins.map(i => okResult(i.number, [ev('2026-10-26 09:00:00', 'in_transit')])), 100)
  for (let i = 0; i < 8; i++) {
    await runPoll({ db, http: bodyHttp(), adapters: [posta], config, now: NOW })
  }
  expect(db.prepare('SELECT COUNT(*) AS n FROM raw_responses').get()).toEqual({ n: 5 })
})

test('a carrier returning a result that cannot be stored is contained and leaves no partial writes', async () => {
  const db = memDb()
  addParcel(db, 'posta', 'RA000000001SK')
  addParcel(db, 'packeta', 'Z0000000001')
  const good = ev('2026-10-26 09:00:00', 'in_transit')
  const bad = { ...ev('x', 'in_transit'), occurredAt: new Date(NaN) }   // toISOString() throws
  const posta = stubAdapter('posta', ins => ins.map(i => okResult(i.number, [good, bad])), 100)
  const packeta = stubAdapter('packeta', ins => ins.map(i => okResult(i.number, [good])))

  const report = await runPoll({ db, http: bodyHttp(), adapters: [posta, packeta], config, now: NOW })

  expect(db.prepare('SELECT COUNT(*) AS n FROM events WHERE parcel_id = 1').get()).toEqual({ n: 0 })
  expect(report.newEvents).toHaveLength(1)
  expect(report.failures).toEqual([expect.objectContaining({ carrier: 'posta' })])
  const health = Object.fromEntries(carrierHealth(db).map(h => [h.carrier, h]))
  expect(health.posta).toMatchObject({ lastErrorKind: 'parse', consecutiveFailures: 1 })
  expect(health.packeta).toMatchObject({ consecutiveFailures: 0 })
})

test('gated alarms even when other parcels of the carrier got a real answer; a lone transport miss does not', async () => {
  const db = memDb()
  addParcel(db, 'posta', 'RA000000001SK')
  addParcel(db, 'posta', 'RA000000002SK')
  const mixed = (second: 'gated' | 'transport') => stubAdapter('posta', ins => [
    okResult(ins[0]!.number, [ev('2026-10-26 09:00:00', 'in_transit')]),
    failResult(ins[1]!.number, second),
  ], 100)
  const deps = { db, http: bodyHttp(), config, now: NOW }

  await runPoll({ ...deps, adapters: [mixed('transport')] })
  expect(carrierHealth(db)[0]).toMatchObject({ consecutiveFailures: 0 })

  await runPoll({ ...deps, adapters: [mixed('gated')] })
  expect(carrierHealth(db)[0]).toMatchObject({ lastErrorKind: 'gated', consecutiveFailures: 1 })
})

const truncated = '{"results":[{"number":"RA000000001SK","status":"o'
const readBody = async (_ins: unknown, http: HttpClient) => (await http('https://api.example/tracking')).text()

test('a parse failure in a multi-parcel batch keeps every status, records health and stores the body once', async () => {
  const db = memDb()
  const a = addParcel(db, 'posta', 'RA000000001SK')
  const b = addParcel(db, 'posta', 'RA000000002SK')
  updateParcelState(db, a, { status: 'ready_for_pickup', statusRaw: 'RP', statusDetail: 'D1' })
  updateParcelState(db, b, { status: 'in_transit', statusRaw: 'IT' })
  const posta = stubAdapter('posta', async (ins, http) => { JSON.parse(await readBody(ins, http)); return [] }, 100)

  const report = await runPoll({ db, http: bodyHttp(truncated), adapters: [posta], config, now: NOW })

  expect(findParcel(db, 'posta', 'RA000000001SK')).toMatchObject({ status: 'ready_for_pickup', statusRaw: 'RP', statusDetail: 'D1' })
  expect(findParcel(db, 'posta', 'RA000000002SK')).toMatchObject({ status: 'in_transit', statusRaw: 'IT' })
  expect(carrierHealth(db)[0]).toMatchObject({ carrier: 'posta', lastErrorKind: 'parse', consecutiveFailures: 1 })
  expect(report.failures).toHaveLength(1)
  expect(db.prepare('SELECT parcel_id, body FROM raw_responses').all()).toEqual([{ parcel_id: null, body: truncated }])
})

test('an adapter that swallows a bad body into transport results still gets the body stored, once', async () => {
  const db = memDb()
  const a = addParcel(db, 'posta', 'RA000000001SK')
  addParcel(db, 'posta', 'RA000000002SK')
  updateParcelState(db, a, { status: 'in_transit', statusRaw: 'IT' })
  // like postaAdapter: reads the body, cannot parse it, answers `transport` for every number
  const posta = stubAdapter('posta', async (ins, http) => {
    await readBody(ins, http)
    return ins.map(i => failResult(i.number, 'transport'))
  }, 100)

  await runPoll({ db, http: bodyHttp(truncated), adapters: [posta], config, now: NOW })

  expect(db.prepare('SELECT parcel_id, body FROM raw_responses').all()).toEqual([{ parcel_id: null, body: truncated }])
  expect(findParcel(db, 'posta', 'RA000000001SK')).toMatchObject({ status: 'in_transit' })
  expect(findParcel(db, 'posta', 'RA000000002SK')).toMatchObject({ status: 'unknown' })   // untouched, was never polled OK
  expect(carrierHealth(db)[0]).toMatchObject({ lastErrorKind: 'transport', consecutiveFailures: 1 })
})

test('parcel-less raw bodies are bounded to the last 5 per carrier', async () => {
  const db = memDb()
  addParcel(db, 'posta', 'RA000000001SK')
  addParcel(db, 'posta', 'RA000000002SK')
  const posta = stubAdapter('posta', async (ins, http) => { await readBody(ins, http); throw new Error('bad') }, 100)
  for (let i = 0; i < 8; i++) await runPoll({ db, http: bodyHttp(truncated), adapters: [posta], config, now: NOW })
  expect(db.prepare('SELECT COUNT(*) AS n FROM raw_responses').get()).toEqual({ n: 5 })
})

test('a chunk that throws still fails the carrier when a sibling chunk succeeded', async () => {
  const db = memDb()
  for (let i = 0; i < 250; i++) addParcel(db, 'posta', `RA${String(i).padStart(9, '0')}SK`)
  let call = 0
  const posta = stubAdapter('posta', ins => {
    if (++call === 2) throw new Error('boom')
    return ins.map(i => okResult(i.number, [ev('2026-10-26 09:00:00', 'in_transit')]))
  }, 100)

  const report = await runPoll({ db, http: bodyHttp(), adapters: [posta], config, now: NOW })

  expect(posta.calls.map(c => c.length)).toEqual([100, 100, 50])
  expect(report.newEvents).toHaveLength(150)   // chunks 1 and 3 were stored
  expect(report.failures).toEqual([expect.objectContaining({ carrier: 'posta' })])
  expect(carrierHealth(db)[0]).toMatchObject({ lastErrorKind: 'parse', consecutiveFailures: 1 })
})

test('a needs_postcode rejection records the postcode and stops the carrier being called at all', async () => {
  const db = memDb()
  // Every parcel gets config.defaultPostalCode at creation (cli `add`), so "has a postcode" can
  // never be what decides this: only a CHANGED postcode may make the carrier worth asking again.
  const id = addParcel(db, 'gls', '31217533227', '81101')
  updateParcelState(db, id, { status: 'in_transit', statusRaw: 'IT', statusDetail: 'D1' })
  let requests = 0
  const counting: HttpClient = (url, init) => { requests++; return bodyHttp()(url, init) }
  const gls = stubAdapter('gls', async (ins, http) => {
    await http('https://gls.example/track')
    return ins.map(i => failResult(i.number, 'needs_postcode'))
  })
  const deps = { db, http: counting, adapters: [gls], config }

  const first = await runPoll({ ...deps, now: NOW })
  expect(first.failures).toEqual([])
  expect(findParcel(db, 'gls', '31217533227')).toMatchObject({
    status: 'in_transit', statusRaw: 'IT', statusDetail: 'D1', needsPostcode: '81101',
  })
  expect(findParcel(db, 'gls', '31217533227')?.lastPolledAt).toBeUndefined()
  expect(carrierHealth(db)).toEqual([])   // neither a fresh lastOkAt nor a failure

  // The parcel stays in the every-slot tier, so only the rejection can keep it off the wire.
  for (const h of [1, 2, 3, 24]) await runPoll({ ...deps, now: new Date(NOW.getTime() + h * HOUR) })
  expect(gls.calls).toHaveLength(1)
  expect(requests).toBe(1)
})

test('only a changed postcode clears the rejection: none -> set, then set -> different', async () => {
  const db = memDb()
  const id = addParcel(db, 'gls', '31217533227')   // no postcode stored at all
  let answer: 'needs_postcode' | 'ok' = 'needs_postcode'
  const gls = stubAdapter('gls', ins => ins.map(i =>
    answer === 'ok' ? okResult(i.number, [ev('2026-10-26 09:00:00', 'in_transit')]) : failResult(i.number, 'needs_postcode')))
  const run = (h: number) => runPoll({
    db, http: bodyHttp(), adapters: [gls], config, now: new Date(NOW.getTime() + h * HOUR),
  })
  const parcel = () => findParcel(db, 'gls', '31217533227')!
  const setPostcode = (zip: string) => db.prepare('UPDATE parcels SET postal_code = ? WHERE id = ?').run(zip, id)

  await run(0)
  expect(parcel().needsPostcode).toBe('')   // rejected with nothing stored

  setPostcode('81101')
  await run(1)
  expect(gls.calls).toHaveLength(2)
  expect(gls.calls[1]).toEqual([{ number: '31217533227', postalCode: '81101' }])
  expect(parcel().needsPostcode).toBe('81101')   // re-flagged with the postcode just rejected

  await run(2)
  expect(gls.calls).toHaveLength(2)   // same postcode, same deterministic answer: not asked

  setPostcode('04001')
  answer = 'ok'
  await run(3)
  expect(gls.calls).toHaveLength(3)
  expect(gls.calls[2]).toEqual([{ number: '31217533227', postalCode: '04001' }])
  expect(parcel().status).toBe('in_transit')
  expect(parcel().needsPostcode).toBeUndefined()   // answered: the flag is gone
})

test('a flagged parcel is not unflagged by a carrier that never actually polls it', async () => {
  const db = memDb()
  // Both rejections name an OLDER postcode than the parcel now has, so neither parcel is skipped
  // at selection: each one reaches its carrier, where nothing is sent for a different reason.
  const noAdapter = addParcel(db, 'dpd', '09876543210', '82000')
  const throttled = addParcel(db, 'gls', '31217533227', '82000')
  setNeedsPostcode(db, noAdapter, '81101')
  setNeedsPostcode(db, throttled, '81101')
  db.prepare(`INSERT INTO carrier_health (carrier, last_error_at, last_error_kind, consecutive_failures)
              VALUES ('gls', ?, 'gated', 1)`).run(new Date(NOW.getTime() - 0.5 * HOUR).toISOString())
  const gls = stubAdapter('gls', ins => ins.map(i => okResult(i.number, [])))

  const report = await runPoll({ db, http: bodyHttp(), adapters: [gls], config, now: NOW })

  expect(gls.calls).toEqual([])   // gated window still open: not even a canary
  expect(report.failures).toEqual([{ carrier: 'dpd', reason: 'no adapter registered' }])
  expect(findParcel(db, 'dpd', '09876543210')?.needsPostcode).toBe('81101')
  expect(findParcel(db, 'gls', '31217533227')?.needsPostcode).toBe('81101')
  expect(db.prepare('SELECT COUNT(*) AS n FROM parcels WHERE last_attempted_at IS NOT NULL').get()).toEqual({ n: 0 })
})

const HOUR = 3_600_000
const hoursAfter = (h: number) => new Date(NOW.getTime() + h * HOUR)

test('a failing parcel in the slow tier backs off like a healthy one instead of retrying every slot', async () => {
  const db = memDb()
  const id = addParcel(db, 'packeta', 'Z0000000001')
  db.prepare('UPDATE parcels SET last_changed_at = ? WHERE id = ?')
    .run(new Date(NOW.getTime() - 10 * 24 * HOUR).toISOString(), id)
  const packeta = stubAdapter('packeta', ins => ins.map(i => failResult(i.number, 'transport')))
  const run = (now: Date) => runPoll({ db, http: bodyHttp(), adapters: [packeta], config, now })

  await run(NOW)
  expect(packeta.calls).toHaveLength(1)
  expect(findParcel(db, 'packeta', 'Z0000000001')).toMatchObject({ lastAttemptedAt: NOW })
  expect(findParcel(db, 'packeta', 'Z0000000001')?.lastPolledAt).toBeUndefined()   // still "last real answer"

  await run(hoursAfter(1))
  await run(hoursAfter(19))
  expect(packeta.calls).toHaveLength(1)
  await run(hoursAfter(20))
  expect(packeta.calls).toHaveLength(2)
})

test('a carrier whose transaction rolled back still has its attempt stamped', async () => {
  const db = memDb()
  const id = addParcel(db, 'packeta', 'Z0000000001')
  db.prepare('UPDATE parcels SET last_changed_at = ? WHERE id = ?')
    .run(new Date(NOW.getTime() - 10 * 24 * HOUR).toISOString(), id)   // slow tier: 20h between tries
  const unstorable = { ...ev('x', 'in_transit'), occurredAt: new Date(NaN) }   // toISOString() throws
  const packeta = stubAdapter('packeta', ins => ins.map(i => okResult(i.number, [unstorable])))
  const run = (h: number) => runPoll({
    db, http: bodyHttp(), adapters: [packeta], config, now: new Date(NOW.getTime() + h * HOUR),
  })

  const report = await run(0)

  expect(report.failures).toEqual([expect.objectContaining({ carrier: 'packeta' })])
  // The in-transaction stamp rolled back with the rest of the carrier's writes, so without the
  // re-stamp outside the transaction this parcel would be retried every single slot for ever.
  expect(findParcel(db, 'packeta', 'Z0000000001')).toMatchObject({ lastAttemptedAt: NOW })
  expect(findParcel(db, 'packeta', 'Z0000000001')?.lastPolledAt).toBeUndefined()
  expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 })

  await run(1)
  await run(19)
  expect(packeta.calls).toHaveLength(1)   // backed off on the strength of the stamp alone
  await run(20)
  expect(packeta.calls).toHaveLength(2)
})

test('a thrown chunk also stamps the attempt', async () => {
  const db = memDb()
  const id = addParcel(db, 'packeta', 'Z0000000001')
  const packeta = stubAdapter('packeta', () => { throw new Error('boom') })
  await runPoll({ db, http: bodyHttp(), adapters: [packeta], config, now: NOW })
  expect(findParcel(db, 'packeta', 'Z0000000001')).toMatchObject({ id, lastAttemptedAt: NOW })
})

describe('gated carrier backoff', () => {
  const seed = (n: number, lastErrorAgoHours: number) => {
    const db = memDb()
    for (const num of ['Z0000000001', 'Z0000000002', 'Z0000000003']) addParcel(db, 'packeta', num)
    db.prepare(`INSERT INTO carrier_health (carrier, last_error_at, last_error_kind, consecutive_failures)
                VALUES ('packeta', ?, 'gated', ?)`).run(new Date(NOW.getTime() - lastErrorAgoHours * HOUR).toISOString(), n)
    return db
  }
  /** Each adapter fetch makes one HTTP request, so `requests` is what the carrier's host would see. */
  const poll = async (db: ReturnType<typeof memDb>, answer: 'gated' | 'ok' = 'gated') => {
    let requests = 0
    const counting: HttpClient = (url, init) => { requests++; return bodyHttp()(url, init) }
    const packeta = stubAdapter('packeta', async (ins, http) => {
      await http('https://carrier.example/track')
      return ins.map(i =>
        answer === 'gated' ? failResult(i.number, 'gated') : okResult(i.number, [ev('2026-10-26 09:00:00', 'in_transit')]))
    }, 100)
    const report = await runPoll({ db, http: counting, adapters: [packeta], config, now: NOW })
    return { report, packeta, requests: () => requests }
  }

  test('while the window is open nothing at all is sent to the carrier', async () => {
    const db = seed(2, 1)   // wait = 2h, last error 1h ago
    const { report, packeta, requests } = await poll(db)
    expect(requests()).toBe(0)
    expect(packeta.calls).toEqual([])
    expect(report.polled).toBe(0)
    expect(carrierHealth(db)[0]).toMatchObject({ lastErrorKind: 'gated', consecutiveFailures: 2 })   // untouched
    expect(db.prepare('SELECT COUNT(*) AS n FROM parcels WHERE last_attempted_at IS NOT NULL').get()).toEqual({ n: 0 })
  })

  test('once the window has elapsed exactly one canary parcel is sent, not the full fan-out', async () => {
    const db = seed(2, 2)   // wait = 2h, last error exactly 2h ago
    const { report, packeta, requests } = await poll(db)
    expect(requests()).toBe(1)
    expect(packeta.calls.map(c => c.length)).toEqual([1])
    expect(report.polled).toBe(1)
    expect(carrierHealth(db)[0]).toMatchObject({ lastErrorKind: 'gated', consecutiveFailures: 3 })   // failed canary widens the window
  })

  test('failed canaries space out: the next one is not due until the wider window has passed', async () => {
    const db = seed(2, 2)
    const packeta = stubAdapter('packeta', ins => ins.map(i => failResult(i.number, 'gated')), 100)
    const at = (h: number) => runPoll({
      db, http: bodyHttp(), adapters: [packeta], config, now: new Date(NOW.getTime() + h * HOUR),
    })
    await at(0)   // canary fails: n = 3, last error at NOW, window now 4h
    await at(3)
    expect(packeta.calls).toHaveLength(1)
    await at(4)
    expect(packeta.calls.map(c => c.length)).toEqual([1, 1])
  })

  test('the first failure waits one hour and the wait is capped at 24 hours', async () => {
    expect((await poll(seed(1, 0.5))).requests()).toBe(0)
    expect((await poll(seed(1, 1))).packeta.calls.map(c => c.length)).toEqual([1])
    expect((await poll(seed(30, 23))).requests()).toBe(0)
    expect((await poll(seed(30, 24))).packeta.calls.map(c => c.length)).toEqual([1])
  })

  test('a canary that succeeds clears the streak so the next run polls everyone', async () => {
    const db = seed(4, 8)   // wait = 8h, last error exactly 8h ago
    const { packeta: canary } = await poll(db, 'ok')
    expect(canary.calls.map(c => c.length)).toEqual([1])
    expect(carrierHealth(db)[0]).toMatchObject({ consecutiveFailures: 0 })
    const { packeta } = await poll(db)
    expect(packeta.calls.map(c => c.length)).toEqual([3])
  })

  test('a non-gated carrier is never throttled', async () => {
    const db = seed(5, 0.1)
    db.prepare("UPDATE carrier_health SET last_error_kind = 'transport'").run()
    expect((await poll(db)).packeta.calls.map(c => c.length)).toEqual([3])
  })
})

test('a not_found parcel (e.g. a mistyped GLS number) does not mark its carrier gated, and the healthy parcels are still polled', async () => {
  const db = memDb()
  addParcel(db, 'gls', '11111111111')   // the bad number: lowest id
  addParcel(db, 'gls', '22222222222')
  const gls = stubAdapter('gls', ins => ins.map(i =>
    i.number === '11111111111' ? failResult(i.number, 'not_found') : okResult(i.number, [ev('2026-10-26 09:00:00', 'in_transit')])), 1)

  const first = await runPoll({ db, http: bodyHttp(), adapters: [gls], config, now: NOW })
  const second = await runPoll({ db, http: bodyHttp(), adapters: [gls], config, now: new Date(NOW.getTime() + 60_000) })

  expect(first.failures).toEqual([])
  expect(carrierHealth(db).find(h => h.carrier === 'gls')).toMatchObject({ consecutiveFailures: 0 })
  expect(gls.calls.flat().map(i => i.number).sort()).toEqual(['11111111111', '11111111111', '22222222222', '22222222222'])
  expect(second.failures).toEqual([])
})
