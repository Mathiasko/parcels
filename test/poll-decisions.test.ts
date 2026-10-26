// Behaviours the orchestrator must have beyond the brief's listed tests: chunking, notified
// bookkeeping, raw-response pruning, and containment of a carrier whose result cannot be stored.
import { test, expect } from 'vitest'
import { runPoll } from '../src/core/poll.js'
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
