import { test, expect } from 'vitest'
import { buildNotifications, snapshot } from '../src/notify/rules.js'
import { runPoll } from '../src/core/poll.js'
import { markNotified } from '../src/db/events.js'
import { carrierHealth, recordHealth } from '../src/db/health.js'
import { updateParcelState, type ParcelStateUpdate } from '../src/db/parcels.js'
import type { Database } from '../src/db/index.js'
import type { CanonicalStatus, CarrierId, NewEvent, ParcelEvent } from '../src/core/types.js'
import type { Notification, Notifier } from '../src/notify/types.js'
import {
  NOW, config, memDb, addParcel, ev, okResult, stubAdapter, bodyHttp,
} from './poll-helpers.js'

const PORT = 8787
const HOUR = 3_600_000
const ZBOX = { kind: 'zbox' as const, name: 'Z-BOX', street: 'Hlavna 12', city: 'Zilina' }

/** A parcel already sitting in `status` (as if an earlier run had stored it). */
function parcelIn(db: Database, status: CanonicalStatus, extra: Partial<ParcelStateUpdate> = {}, carrier: CarrierId = 'posta', n = 'RA000000001SK'): number {
  const id = addParcel(db, carrier, n)
  updateParcelState(db, id, { status, ...extra })
  return id
}
const newEv = (parcelId: number, raw: string, status: CanonicalStatus): NewEvent => ({ ...ev(raw, status), parcelId })

const build = (db: Database, before: ReturnType<typeof snapshot>, events: NewEvent[] = [], now = NOW) =>
  buildNotifications(db, events, now, PORT, before)

test('a status transition produces one notification', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  const before = snapshot(db)
  updateParcelState(db, id, { status: 'out_for_delivery' })
  const out = build(db, before, [newEv(id, 'a', 'out_for_delivery')])
  expect(out).toHaveLength(1)
  expect(out[0]!.title).toMatch(/Out for delivery/)
})

test('a status transition with no new event at all still notifies (prose-only carriers)', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  const before = snapshot(db)
  updateParcelState(db, id, { status: 'returning' })
  expect(build(db, before, [])).toHaveLength(1)
})

test('new events that do not change the canonical status produce none', () => {
  // four depot scans overnight -> 0 notifications
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  const before = snapshot(db)
  const scans = ['a', 'b', 'c', 'd'].map(r => newEv(id, r, 'in_transit'))
  expect(build(db, before, scans)).toEqual([])
})

test('a transition to unknown is not announced', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  const before = snapshot(db)
  updateParcelState(db, id, { status: 'unknown' })
  expect(build(db, before)).toEqual([])
})

test('the first appearance of a pickup location notifies with the address in the message', () => {
  const db = memDb()
  const id = parcelIn(db, 'ready_for_pickup')
  const before = snapshot(db)
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup: ZBOX })
  const [n, ...rest] = build(db, before)
  expect(rest).toEqual([])
  expect(n!.message).toContain('Z-BOX')
  expect(n!.message).toContain('Hlavna 12, Zilina')
  // Nothing new the next time round: the pickup point is no longer "first seen".
  expect(build(db, snapshot(db))).toEqual([])
})

test('a retainedTill within 48h notifies once and never again for the same parcel', () => {
  const db = memDb()
  const id = parcelIn(db, 'ready_for_pickup', { pickup: ZBOX, retainedTill: new Date(NOW.getTime() + 30 * HOUR) })
  const first = build(db, snapshot(db))
  expect(first).toHaveLength(1)
  expect(first[0]!.message).toMatch(/collect by Tue 27 Oct/)
  // The poller is a short-lived process: a later run builds from a fresh snapshot and fresh state.
  expect(build(db, snapshot(db), [], new Date(NOW.getTime() + HOUR))).toEqual([])
  expect(build(db, snapshot(db), [], new Date(NOW.getTime() + 20 * HOUR))).toEqual([])
  expect(db.prepare('SELECT COUNT(*) AS n FROM deadline_reminders WHERE parcel_id = ?').get(id)).toEqual({ n: 1 })
})

test('a deadline further than 48h away, or already past, does not notify', () => {
  const db = memDb()
  parcelIn(db, 'ready_for_pickup', { retainedTill: new Date(NOW.getTime() + 49 * HOUR) }, 'posta', 'RA000000001SK')
  parcelIn(db, 'ready_for_pickup', { retainedTill: new Date(NOW.getTime() - HOUR) }, 'posta', 'RA000000002SK')
  expect(build(db, snapshot(db))).toEqual([])
  // ...and the far one fires once it comes inside the window.
  expect(build(db, snapshot(db), [], new Date(NOW.getTime() + 2 * HOUR))).toHaveLength(1)
})

test('a deadline reminder that coincides with a transition is a single banner and counts as sent', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  const before = snapshot(db)
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup: ZBOX, retainedTill: new Date(NOW.getTime() + 24 * HOUR) })
  const out = build(db, before)
  expect(out).toHaveLength(1)
  expect(out[0]!.message).toMatch(/collect by/)
  expect(build(db, snapshot(db))).toEqual([])
})

test('a failed delivery attempt notifies', () => {
  const db = memDb()
  const id = parcelIn(db, 'out_for_delivery')
  const before = snapshot(db)
  updateParcelState(db, id, { status: 'failed_attempt' })
  const out = build(db, before, [newEv(id, 'x', 'failed_attempt')])
  expect(out).toHaveLength(1)
  expect(out[0]!.title).toMatch(/attempt failed/i)

  // A second failed attempt while the status is unchanged is a new event worth a banner.
  const again = build(db, snapshot(db), [newEv(id, 'y', 'failed_attempt')])
  expect(again).toHaveLength(1)
})

test('an old failed attempt in a newly added parcel\'s history does not notify as one', () => {
  const db = memDb()
  const id = parcelIn(db, 'unknown')
  const before = snapshot(db)
  updateParcelState(db, id, { status: 'delivered' })
  const out = build(db, before, [newEv(id, 'old', 'failed_attempt'), newEv(id, 'new', 'delivered')])
  expect(out).toHaveLength(1)
  expect(out[0]!.title).toMatch(/Delivered/)
})

test('a carrier entering gated notifies once and not again until it recovers', () => {
  const db = memDb()
  recordHealth(db, 'gls', 'gated', 'gated for 123', NOW)
  const first = build(db, snapshot(db))
  expect(first).toHaveLength(1)
  expect(first[0]!.title).toMatch(/GLS/)
  expect(carrierHealth(db)[0]!.notifiedAt).toEqual(NOW)

  recordHealth(db, 'gls', 'gated', 'gated for 123', new Date(NOW.getTime() + HOUR))   // still broken
  expect(build(db, snapshot(db))).toEqual([])
  recordHealth(db, 'gls', 'transport', 'timeout', new Date(NOW.getTime() + 2 * HOUR)) // still no recovery
  recordHealth(db, 'gls', 'gated', 'gated again', new Date(NOW.getTime() + 3 * HOUR))
  expect(build(db, snapshot(db))).toEqual([])

  recordHealth(db, 'gls', 'ok', undefined, new Date(NOW.getTime() + 4 * HOUR))        // recovered
  expect(build(db, snapshot(db))).toEqual([])
  recordHealth(db, 'gls', 'gated', 'broken anew', new Date(NOW.getTime() + 5 * HOUR))
  expect(build(db, snapshot(db))).toHaveLength(1)
})

test('only gated is announced: a failing-but-not-gated carrier is not', () => {
  const db = memDb()
  recordHealth(db, 'dpd', 'transport', 'timeout', NOW)
  recordHealth(db, 'sps', 'parse', 'bad json', NOW)
  expect(build(db, snapshot(db))).toEqual([])
})

test('groupKey is parcel-<id> so a later banner replaces the earlier one', () => {
  const db = memDb()
  const id = parcelIn(db, 'pre_transit')
  const before = snapshot(db)
  updateParcelState(db, id, { status: 'in_transit' })
  expect(build(db, before)[0]!.groupKey).toBe(`parcel-${id}`)
})

test('url points at http://127.0.0.1:<port>/parcel/<id>', () => {
  const db = memDb()
  const id = parcelIn(db, 'pre_transit')
  const before = snapshot(db)
  updateParcelState(db, id, { status: 'in_transit' })
  expect(build(db, before)[0]!.url).toBe(`http://127.0.0.1:${PORT}/parcel/${id}`)
})

function fiveTransitions(db: Database, count: number) {
  const ids = Array.from({ length: count }, (_, i) => parcelIn(db, 'in_transit', {}, 'posta', `RA00000000${i}SK`))
  const before = snapshot(db)
  for (const id of ids) updateParcelState(db, id, { status: 'out_for_delivery' })
  return before
}

test('more than four notifications in one run collapse into a single summary', () => {
  const db = memDb()
  const out = build(db, fiveTransitions(db, 5))
  expect(out).toHaveLength(1)
  expect(out[0]!.title).toMatch(/\d+ parcel updates/)
  expect(out[0]!.title).toMatch(/^5 /)
  expect(out[0]!.url).toBe(`http://127.0.0.1:${PORT}/`)
})

test('exactly four notifications are sent individually', () => {
  const db = memDb()
  expect(build(db, fiveTransitions(db, 4))).toHaveLength(4)
})

test('already-notified events are never notified again', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  // An event sitting in the table, never marked: the rules must NOT go looking for it. Anything
  // in newEvents was marked notified at append time; the table says nothing about what is new.
  db.prepare(`INSERT INTO events (parcel_id, occurred_at, occurred_at_raw, occurred_at_tz, status, description,
                                  dedup_hash, first_seen_at) VALUES (?, ?, 'raw', 'UTC', 'failed_attempt', 'd', 'h', ?)`)
    .run(id, NOW.toISOString(), NOW.toISOString())
  expect(build(db, snapshot(db))).toEqual([])
  markNotified(db, [1], NOW)
  expect(build(db, snapshot(db))).toEqual([])
})

test('ready_for_pickup without a deadline omits the collect-by clause entirely', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  const before = snapshot(db)
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup: ZBOX })
  const n = build(db, before)[0]!
  expect(n.message).toContain('Z-BOX')
  expect(n.message).not.toMatch(/collect by/i)
})

// --- wiring into runPoll -------------------------------------------------------------------

function recordingNotifier(fail = false): Notifier & { sent: Notification[] } {
  const sent: Notification[] = []
  return { sent, send: async n => { sent.push(n); if (fail) throw new Error('banner exploded') } }
}

const history = (): ParcelEvent[] => [
  ev('2026-09-01 09:00:00', 'pre_transit', 55 * 24), ev('2026-09-03 09:00:00', 'in_transit', 50 * 24),
  ev('2026-10-26 08:00:00', 'out_for_delivery', 3),
]

test('runPoll: a newly added parcel\'s whole backfilled history is one banner, and a rerun sends nothing', async () => {
  const db = memDb()
  addParcel(db, 'posta', 'RA000000001SK')
  const posta = stubAdapter('posta', ins => ins.map(i => okResult(i.number, history())), 100)
  const notifier = recordingNotifier()
  const deps = { db, http: bodyHttp(), adapters: [posta], config, now: NOW, notifier }

  const first = await runPoll(deps)
  expect(first.newEvents).toHaveLength(3)
  expect(notifier.sent).toHaveLength(1)
  expect(notifier.sent[0]!.title).toMatch(/Out for delivery/)

  await runPoll(deps)
  expect(notifier.sent).toHaveLength(1)
})

test('runPoll: a status change that arrives with no new event is announced', async () => {
  const db = memDb()
  addParcel(db, 'packeta', 'Z0000000001')
  let status: CanonicalStatus = 'in_transit'
  const events = [ev('2026-10-25 09:00:00', 'unknown', 20)]
  const packeta = stubAdapter('packeta', ins => ins.map(i =>
    okResult(i.number, events, { status, pickup: status === 'ready_for_pickup' ? ZBOX : undefined })))
  const notifier = recordingNotifier()
  const deps = { db, http: bodyHttp(), adapters: [packeta], config, now: NOW, notifier }

  await runPoll(deps)
  expect(notifier.sent).toHaveLength(1)   // unknown -> in_transit
  status = 'ready_for_pickup'
  const report = await runPoll({ ...deps, now: new Date(NOW.getTime() + HOUR) })
  expect(report.newEvents).toEqual([])
  expect(notifier.sent).toHaveLength(2)
  expect(notifier.sent[1]!.message).toContain('Z-BOX')
})

test('runPoll: a gated carrier produces one alarm across consecutive runs', async () => {
  const db = memDb()
  addParcel(db, 'gls', '312175332275')
  const gls = stubAdapter('gls', ins => ins.map(i => ({ ok: false as const, number: i.number, reason: 'gated' as const })))
  const notifier = recordingNotifier()
  await runPoll({ db, http: bodyHttp(), adapters: [gls], config, now: NOW, notifier })
  expect(notifier.sent).toHaveLength(1)
  expect(notifier.sent[0]!.groupKey).toBe('carrier-gls')
  // The next run falls inside the gated backoff window (nothing polled) and stays quiet.
  await runPoll({ db, http: bodyHttp(), adapters: [gls], config, now: new Date(NOW.getTime() + HOUR) })
  await runPoll({ db, http: bodyHttp(), adapters: [gls], config, now: new Date(NOW.getTime() + 3 * HOUR) })
  expect(notifier.sent).toHaveLength(1)
})

test('runPoll: a notifier that throws does not fail the run', async () => {
  const db = memDb()
  addParcel(db, 'posta', 'RA000000001SK')
  const posta = stubAdapter('posta', ins => ins.map(i => okResult(i.number, history())), 100)
  const notifier = recordingNotifier(true)
  const report = await runPoll({ db, http: bodyHttp(), adapters: [posta], config, now: NOW, notifier })
  expect(report.newEvents).toHaveLength(3)
  expect(notifier.sent).toHaveLength(1)
})

test('runPoll without a notifier builds nothing and spends no one-shot state', async () => {
  const db = memDb()
  addParcel(db, 'gls', '312175332275')
  const gls = stubAdapter('gls', ins => ins.map(i => ({ ok: false as const, number: i.number, reason: 'gated' as const })))
  await runPoll({ db, http: bodyHttp(), adapters: [gls], config, now: NOW })
  expect(carrierHealth(db)[0]!.notifiedAt).toBeUndefined()
})
