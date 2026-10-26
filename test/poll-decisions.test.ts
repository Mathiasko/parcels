// Behaviours the orchestrator must have beyond the brief's listed tests: chunking, notified
// bookkeeping, raw-response pruning, and containment of a carrier whose result cannot be stored.
import { test, expect } from 'vitest'
import { runPoll, NEEDS_POSTCODE } from '../src/core/poll.js'
import { findParcel, updateParcelState } from '../src/db/parcels.js'
import type { HttpClient } from '../src/core/types.js'
import { carrierHealth } from '../src/db/health.js'
import { unnotifiedEvents } from '../src/db/events.js'
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
  expect(unnotifiedEvents(db)).toEqual([])
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

test('needs_postcode is flagged on the parcel row, is not polled-ok, and clears once it resolves', async () => {
  const db = memDb()
  const id = addParcel(db, 'gls', '31217533227')
  updateParcelState(db, id, { status: 'in_transit', statusRaw: 'IT' })
  let answer: 'needs_postcode' | 'ok' = 'needs_postcode'
  const gls = stubAdapter('gls', ins => ins.map(i =>
    answer === 'ok' ? okResult(i.number, [ev('2026-10-26 09:00:00', 'in_transit')]) : failResult(i.number, 'needs_postcode')))
  const deps = { db, http: bodyHttp(), adapters: [gls], config, now: NOW }

  const first = await runPoll(deps)
  expect(first.failures).toEqual([])
  expect(findParcel(db, 'gls', '31217533227')).toMatchObject({ status: 'in_transit', statusRaw: 'IT', statusDetail: NEEDS_POSTCODE })
  expect(findParcel(db, 'gls', '31217533227')?.lastPolledAt).toBeUndefined()

  answer = 'ok'
  await runPoll(deps)
  expect(findParcel(db, 'gls', '31217533227')?.statusDetail).toBeUndefined()
})
