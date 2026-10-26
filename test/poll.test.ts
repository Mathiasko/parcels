import { test, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPoll } from '../src/core/poll.js'
import { carrierHealth } from '../src/db/health.js'
import { openDb } from '../src/db/index.js'
import { findParcel, updateParcelState } from '../src/db/parcels.js'
import { HttpTransportError } from '../src/core/http.js'
import type { CanonicalStatus } from '../src/core/types.js'
import {
  NOW, config, memDb, addParcel, ev, okResult, failResult, stubAdapter, bodyHttp,
} from './poll-helpers.js'

const DAY = 86_400_000

test('polls only due parcels and groups them per carrier into one batched call', async () => {
  const db = memDb()
  addParcel(db, 'posta', 'RA000000001SK')
  addParcel(db, 'posta', 'RA000000002SK')
  addParcel(db, 'packeta', 'Z0000000001')
  const delivered = addParcel(db, 'posta', 'RA000000003SK')
  updateParcelState(db, delivered, { status: 'delivered' })
  const dormant = addParcel(db, 'posta', 'RA000000004SK')
  db.prepare('UPDATE parcels SET first_seen_at = ? WHERE id = ?')
    .run(new Date(NOW.getTime() - 40 * DAY).toISOString(), dormant)

  const posta = stubAdapter('posta', ins => ins.map(i => failResult(i.number, 'not_found')), 100)
  const packeta = stubAdapter('packeta', ins => ins.map(i => failResult(i.number, 'not_found')))
  const report = await runPoll({ db, http: bodyHttp(), adapters: [posta, packeta], config, now: NOW })

  expect(posta.calls).toHaveLength(1)
  expect(posta.calls[0]!.map(i => i.number)).toEqual(['RA000000001SK', 'RA000000002SK'])
  expect(packeta.calls).toHaveLength(1)
  expect(packeta.calls[0]!.map(i => i.number)).toEqual(['Z0000000001'])
  expect(report.polled).toBe(3)
})

test('appends new events and leaves existing ones untouched on a second run', async () => {
  const db = memDb()
  const id = addParcel(db, 'posta', 'RA000000001SK')
  const events = [ev('2026-10-25 09:00:00', 'in_transit', 26), ev('2026-10-26 08:30:00', 'out_for_delivery', 2)]
  const posta = stubAdapter('posta', ins => ins.map(i => okResult(i.number, events)), 100)
  const deps = { db, http: bodyHttp(), adapters: [posta], config, now: NOW }

  const first = await runPoll(deps)
  expect(first.newEvents).toHaveLength(2)
  const before = db.prepare('SELECT id, first_seen_at FROM events ORDER BY id').all()
  expect(before).toHaveLength(2)
  expect(findParcel(db, 'posta', 'RA000000001SK')).toMatchObject({ id, status: 'out_for_delivery', lastPolledAt: NOW })

  const second = await runPoll(deps)
  expect(second.newEvents).toEqual([])
  expect(db.prepare('SELECT id, first_seen_at FROM events ORDER BY id').all()).toEqual(before)

  events.push(ev('2026-10-26 10:30:00', 'delivered', 0))
  const third = await runPoll(deps)
  expect(third.newEvents.map(e => e.status)).toEqual(['delivered'])
  expect(findParcel(db, 'posta', 'RA000000001SK')).toMatchObject({ status: 'delivered' })
})

test('a status change with no new event is kept, stays consistent with statusRaw and pickup, and survives repeat polls', async () => {
  const db = memDb()
  addParcel(db, 'packeta', 'Z1234567890')
  // Packeta events carry no code, so the stored newest event is stamped with the status at first sight.
  const events = [ev('2026-10-26 08:30:00', 'in_transit', 2)]
  let extra: Parameters<typeof okResult>[2] = { statusRaw: 'on the way' }
  let status: CanonicalStatus = 'in_transit'
  const packeta = stubAdapter('packeta', ins => ins.map(i => okResult(i.number, events, { status, ...extra })))
  const deps = { db, http: bodyHttp(), adapters: [packeta], config, now: NOW }

  await runPoll(deps)
  expect(findParcel(db, 'packeta', 'Z1234567890')).toMatchObject({ status: 'in_transit', statusRaw: 'on the way' })

  // packetStatusId moves 31 -> 2 and trackingDetails does not grow
  status = 'ready_for_pickup'
  extra = { statusRaw: 'ready for pickup', pickup: { kind: 'zbox', name: 'Z-BOX Example Street 1' } }
  for (let i = 0; i < 2; i++) {
    const report = await runPoll(deps)
    expect(report.newEvents).toEqual([])
    expect(findParcel(db, 'packeta', 'Z1234567890')).toMatchObject({
      status: 'ready_for_pickup', statusRaw: 'ready for pickup', pickup: { kind: 'zbox', name: 'Z-BOX Example Street 1' },
    })
  }
  expect(db.prepare('SELECT status FROM events').all()).toEqual([{ status: 'in_transit' }])   // never restamped
})

test('a gated result records carrier health as gated and does not alter the parcel status', async () => {
  const db = memDb()
  const id = addParcel(db, 'gls', '31217533227')
  updateParcelState(db, id, { status: 'in_transit', statusRaw: 'IT' })
  const gls = stubAdapter('gls', ins => ins.map(i => failResult(i.number, 'gated')))

  const report = await runPoll({ db, http: bodyHttp(), adapters: [gls], config, now: NOW })

  expect(carrierHealth(db)).toEqual([expect.objectContaining({
    carrier: 'gls', lastErrorKind: 'gated', consecutiveFailures: 1,
  })])
  expect(report.failures).toEqual([expect.objectContaining({ carrier: 'gls' })])
  expect(findParcel(db, 'gls', '31217533227')).toMatchObject({ status: 'in_transit', statusRaw: 'IT' })
})

test('a not_found result records health as ok and does not alarm', async () => {
  const db = memDb()
  const id = addParcel(db, 'posta', 'RA000000001SK')
  updateParcelState(db, id, { status: 'in_transit', statusRaw: 'IT', statusDetail: 'D1' })
  const posta = stubAdapter('posta', ins => ins.map(i => failResult(i.number, 'not_found')), 100)

  const report = await runPoll({ db, http: bodyHttp(), adapters: [posta], config, now: NOW })

  expect(report.failures).toEqual([])
  expect(carrierHealth(db)).toEqual([expect.objectContaining({
    carrier: 'posta', consecutiveFailures: 0, lastOkAt: NOW, lastErrorKind: undefined,
  })])
  expect(findParcel(db, 'posta', 'RA000000001SK')).toMatchObject({ status: 'in_transit', statusRaw: 'IT', statusDetail: 'D1', lastPolledAt: NOW })
})

test('one carrier throwing does not prevent the other carriers from being polled', async () => {
  // Review Focus 5: a truncated body / thrown parse error is contained
  const db = memDb()
  addParcel(db, 'posta', 'RA000000001SK')
  addParcel(db, 'packeta', 'Z0000000001')
  addParcel(db, 'gls', '31217533227')
  const posta = stubAdapter('posta', () => { JSON.parse('{"results":[{"number":"RA0') ; return [] }, 100)
  const packeta = stubAdapter('packeta', ins => ins.map(i => okResult(i.number, [ev('2026-10-26 09:00:00', 'in_transit')])))
  const gls = stubAdapter('gls', () => { throw new HttpTransportError('https://gls.example', new Error('timeout')) })

  const report = await runPoll({ db, http: bodyHttp(), adapters: [posta, packeta, gls], config, now: NOW })

  expect(packeta.calls).toHaveLength(1)
  expect(report.newEvents).toHaveLength(1)
  expect(findParcel(db, 'packeta', 'Z0000000001')).toMatchObject({ status: 'in_transit' })
  expect(report.failures.map(f => f.carrier).sort()).toEqual(['gls', 'posta'])
  const health = Object.fromEntries(carrierHealth(db).map(h => [h.carrier, h]))
  expect(health.posta).toMatchObject({ lastErrorKind: 'parse', consecutiveFailures: 1 })
  expect(health.gls).toMatchObject({ lastErrorKind: 'transport', consecutiveFailures: 1 })
  expect(health.packeta).toMatchObject({ consecutiveFailures: 0 })
})

test('a parse failure marks the parcel unknown and stores the raw response', async () => {
  const db = memDb()
  const id = addParcel(db, 'posta', 'RA000000001SK')
  updateParcelState(db, id, { status: 'in_transit' })
  const truncated = '{"results":[{"number":"RA000000001SK","status":"o'
  const posta = stubAdapter('posta', async (_ins, http) => {
    JSON.parse(await (await http('https://api.example/tracking')).text())
    return []
  }, 100)

  await runPoll({ db, http: bodyHttp(truncated), adapters: [posta], config, now: NOW })

  expect(findParcel(db, 'posta', 'RA000000001SK')).toMatchObject({ status: 'unknown' })
  expect(db.prepare('SELECT parcel_id, carrier, body FROM raw_responses').all())
    .toEqual([{ parcel_id: id, carrier: 'posta', body: truncated }])
})

test('consecutive_failures resets to zero after a successful poll', async () => {
  const db = memDb()
  addParcel(db, 'packeta', 'Z0000000001')
  let broken = true
  const packeta = stubAdapter('packeta', ins => ins.map(i =>
    broken ? failResult(i.number, 'gated') : okResult(i.number, [ev('2026-10-26 09:00:00', 'in_transit')])))
  const hoursAfter = (h: number) => new Date(NOW.getTime() + h * 3_600_000)
  const run = (now: Date) => runPoll({ db, http: bodyHttp(), adapters: [packeta], config, now })

  // spaced past the gated backoff window (1h after the first failure, 2h after the second)
  await run(NOW)
  await run(hoursAfter(1))
  expect(carrierHealth(db)[0]).toMatchObject({ consecutiveFailures: 2 })

  broken = false
  await run(hoursAfter(3))
  expect(carrierHealth(db)[0]).toMatchObject({ consecutiveFailures: 0, lastOkAt: hoursAfter(3) })
})

test('the run commits even when every carrier fails', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'parcels-')), 'p.db')
  const db = openDb(path)
  const observer = openDb(path)   // a second connection only sees what has really been committed
  try {
    addParcel(db, 'posta', 'RA000000001SK')
    addParcel(db, 'packeta', 'Z0000000001')
    const boom = (id: 'posta' | 'packeta') => stubAdapter(id, () => { throw new Error('boom') })

    const report = await runPoll({ db, http: bodyHttp(), adapters: [boom('posta'), boom('packeta')], config, now: NOW })

    expect(report.failures).toHaveLength(2)
    expect(carrierHealth(observer).map(h => [h.carrier, h.consecutiveFailures]).sort())
      .toEqual([['packeta', 1], ['posta', 1]])
    expect(db.inTransaction).toBe(false)   // nothing left open for a later close() to roll back
  } finally {
    observer.close()
    db.close()
  }
})
