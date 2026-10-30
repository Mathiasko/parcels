import { test, expect } from 'vitest'
import { buildNotifications } from '../src/notify/rules.js'
import { runPoll } from '../src/core/poll.js'
import { carrierHealth, recordHealth } from '../src/db/health.js'
import { markAnnounced, updateParcelState, getParcel, type ParcelStateUpdate } from '../src/db/parcels.js'
import { recordIngest } from '../src/db/ingest-status.js'
import { recordUpdateCheck } from '../src/db/update-state.js'
import { parseUpdateCheck } from '../src/core/update.js'
import { DEFAULT_NOTIFICATIONS, type NotificationPrefs } from '../src/core/config.js'
import { markCollected } from '../src/core/collected.js'
import type { Database } from '../src/db/index.js'
import type { CanonicalStatus, CarrierId, NewEvent, ParcelEvent } from '../src/core/types.js'
import type { Notification, Notifier } from '../src/notify/types.js'
import {
  NOW, config, memDb, addParcel, ev, okResult, stubAdapter, bodyHttp,
} from './poll-helpers.js'

const PORT = 8787
const HOUR = 3_600_000
const ZBOX = { kind: 'zbox' as const, name: 'Z-BOX', street: 'Hlavna 12', city: 'Zilina' }

/** A parcel already sitting in `status`, and already announced as such (as if an earlier run had told the user). */
function parcelIn(db: Database, status: CanonicalStatus, extra: Partial<ParcelStateUpdate> = {}, carrier: CarrierId = 'posta', n = 'RA000000001SK'): number {
  const id = addParcel(db, carrier, n)
  updateParcelState(db, id, { status, ...extra })
  markAnnounced(db, id, status, extra.pickup !== undefined)
  return id
}
const newEv = (parcelId: number, raw: string, status: CanonicalStatus): NewEvent => ({ ...ev(raw, status), parcelId })

const build = (db: Database, events: NewEvent[] = [], now = NOW, prefs: NotificationPrefs = DEFAULT_NOTIFICATIONS) =>
  buildNotifications(db, events, now, PORT, prefs)
/** The defaults with transit updates switched on, for the tests that are about a transit banner's shape. */
const PROGRESS: NotificationPrefs = { ...DEFAULT_NOTIFICATIONS, progress: true }

test('a status transition produces one notification', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  updateParcelState(db, id, { status: 'out_for_delivery' })
  const out = build(db, [newEv(id, 'a', 'out_for_delivery')])
  expect(out).toHaveLength(1)
  expect(out[0]!.title).toMatch(/Out for delivery/)
  expect(build(db)).toEqual([])   // announced: the same transition is never announced twice
})

test('a status transition with no new event at all still notifies (prose-only carriers)', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  updateParcelState(db, id, { status: 'returning' })
  expect(build(db, [])).toHaveLength(1)
})

test('new events that do not change the canonical status produce none', () => {
  // four depot scans overnight -> 0 notifications
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  const scans = ['a', 'b', 'c', 'd'].map(r => newEv(id, r, 'in_transit'))
  expect(build(db, scans)).toEqual([])
})

test('a transition to unknown is not announced', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  updateParcelState(db, id, { status: 'unknown' })
  expect(build(db)).toEqual([])
})

test('the first appearance of a pickup location notifies with the address in the message', () => {
  const db = memDb()
  const id = parcelIn(db, 'ready_for_pickup')
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup: ZBOX })
  const [n, ...rest] = build(db)
  expect(rest).toEqual([])
  // Name, street and city each separated by a comma, exactly as the dashboard writes the place.
  expect(n!.message).toContain('Z-BOX, Hlavna 12, Zilina')
  // Nothing new the next time round: the pickup point is no longer "first seen".
  expect(build(db)).toEqual([])
})

test('a retainedTill within 48h notifies once and never again for the same parcel', () => {
  const db = memDb()
  const id = parcelIn(db, 'ready_for_pickup', { pickup: ZBOX, retainedTill: new Date(NOW.getTime() + 30 * HOUR) })
  const first = build(db)
  expect(first).toHaveLength(1)
  expect(first[0]!.message).toMatch(/collect by Tue 27 Oct/)
  // The poller is a short-lived process: a later run starts from nothing but the database.
  expect(build(db, [], new Date(NOW.getTime() + HOUR))).toEqual([])
  expect(build(db, [], new Date(NOW.getTime() + 20 * HOUR))).toEqual([])
  expect(db.prepare('SELECT COUNT(*) AS n FROM deadline_reminders WHERE parcel_id = ?').get(id)).toEqual({ n: 1 })
})

test('a deadline further than 48h away, or already past, produces no deadline reminder', () => {
  const db = memDb()
  parcelIn(db, 'ready_for_pickup', { retainedTill: new Date(NOW.getTime() + 49 * HOUR) }, 'posta', 'RA000000001SK')
  parcelIn(db, 'ready_for_pickup', { retainedTill: new Date(NOW.getTime() - HOUR) }, 'posta', 'RA000000002SK')
  // Both are waiting, so both get the twice-daily nudge; what must not appear is a deadline warning.
  expect(build(db).map(n => n.title)).toEqual([
    'Still waiting for you — RA000000001SK',
    'Still waiting for you — RA000000002SK',
  ])
  // ...and the far one fires as a deadline reminder once it comes inside the window.
  const later = build(db, [], new Date(NOW.getTime() + 2 * HOUR))
  expect(later).toHaveLength(1)
  expect(later[0]!.title).toMatch(/^Pickup deadline approaching/)
})

test('a deadline reminder that coincides with a transition is a single banner and counts as sent', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup: ZBOX, retainedTill: new Date(NOW.getTime() + 24 * HOUR) })
  const out = build(db)
  expect(out).toHaveLength(1)
  expect(out[0]!.message).toMatch(/collect by/)
  expect(build(db)).toEqual([])
})

test('a failed delivery attempt notifies', () => {
  const db = memDb()
  const id = parcelIn(db, 'out_for_delivery')
  updateParcelState(db, id, { status: 'failed_attempt' })
  const out = build(db, [newEv(id, 'x', 'failed_attempt')])
  expect(out).toHaveLength(1)
  expect(out[0]!.title).toMatch(/attempt failed/i)

  // A second failed attempt while the status is unchanged is a new event worth a banner.
  const again = build(db, [newEv(id, 'y', 'failed_attempt')])
  expect(again).toHaveLength(1)
})

test('an old failed attempt in a newly added parcel\'s history does not notify as one', () => {
  const db = memDb()
  const id = parcelIn(db, 'unknown')
  updateParcelState(db, id, { status: 'delivered' })
  const out = build(db, [newEv(id, 'old', 'failed_attempt'), newEv(id, 'new', 'delivered')])
  expect(out).toHaveLength(1)
  expect(out[0]!.title).toMatch(/Delivered/)
})

test('a carrier entering gated notifies once and not again until it recovers', () => {
  const db = memDb()
  recordHealth(db, 'gls', 'gated', 'gated for 123', NOW)
  const first = build(db)
  expect(first).toHaveLength(1)
  expect(first[0]!.title).toMatch(/GLS/)
  expect(carrierHealth(db)[0]!.notifiedAt).toEqual(NOW)

  recordHealth(db, 'gls', 'gated', 'gated for 123', new Date(NOW.getTime() + HOUR))   // still broken
  expect(build(db)).toEqual([])
  recordHealth(db, 'gls', 'transport', 'timeout', new Date(NOW.getTime() + 2 * HOUR)) // still no recovery
  recordHealth(db, 'gls', 'gated', 'gated again', new Date(NOW.getTime() + 3 * HOUR))
  expect(build(db)).toEqual([])

  recordHealth(db, 'gls', 'ok', undefined, new Date(NOW.getTime() + 4 * HOUR))        // recovered
  expect(build(db)).toEqual([])
  recordHealth(db, 'gls', 'gated', 'broken anew', new Date(NOW.getTime() + 5 * HOUR))
  expect(build(db)).toHaveLength(1)
})

test('only gated is announced: a failing-but-not-gated carrier is not', () => {
  const db = memDb()
  recordHealth(db, 'dpd', 'transport', 'timeout', NOW)
  recordHealth(db, 'sps', 'parse', 'bad json', NOW)
  expect(build(db)).toEqual([])
})

test('groupKey is parcel-<id> so a later banner replaces the earlier one', () => {
  const db = memDb()
  const id = parcelIn(db, 'pre_transit')
  updateParcelState(db, id, { status: 'in_transit' })
  expect(build(db, [], NOW, PROGRESS)[0]!.groupKey).toBe(`parcel-${id}`)
})

test('url points at http://127.0.0.1:<port>/parcel/<id>', () => {
  const db = memDb()
  const id = parcelIn(db, 'pre_transit')
  updateParcelState(db, id, { status: 'in_transit' })
  expect(build(db, [], NOW, PROGRESS)[0]!.url).toBe(`http://127.0.0.1:${PORT}/parcel/${id}`)
})

function fiveTransitions(db: Database, count: number) {
  const ids = Array.from({ length: count }, (_, i) => parcelIn(db, 'in_transit', {}, 'posta', `RA00000000${i}SK`))
  for (const id of ids) updateParcelState(db, id, { status: 'out_for_delivery' })
}

test('more than four notifications in one run collapse into a single summary', () => {
  const db = memDb()
  fiveTransitions(db, 5)
  const out = build(db)
  expect(out).toHaveLength(1)
  expect(out[0]!.title).toMatch(/\d+ parcel updates/)
  expect(out[0]!.title).toMatch(/^5 /)
  expect(out[0]!.url).toBe(`http://127.0.0.1:${PORT}/`)
})

test('exactly four notifications are sent individually', () => {
  const db = memDb()
  fiveTransitions(db, 4)
  expect(build(db)).toHaveLength(4)
})

test('already-notified events are never notified again', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  // An event sitting in the table, never marked: the rules must NOT go looking for it. Anything
  // in newEvents was marked notified at append time; the table says nothing about what is new.
  db.prepare(`INSERT INTO events (parcel_id, occurred_at, occurred_at_raw, occurred_at_tz, status, description,
                                  dedup_hash, first_seen_at) VALUES (?, ?, 'raw', 'UTC', 'failed_attempt', 'd', 'h', ?)`)
    .run(id, NOW.toISOString(), NOW.toISOString())
  expect(build(db)).toEqual([])
})

test('ready_for_pickup without a deadline omits the collect-by clause entirely', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup: ZBOX })
  const n = build(db)[0]!
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
  expect(notifier.sent).toEqual([])   // unknown -> in_transit: quiet under the default switches
  status = 'ready_for_pickup'
  const report = await runPoll({ ...deps, now: new Date(NOW.getTime() + HOUR) })
  expect(report.newEvents).toEqual([])
  expect(notifier.sent).toHaveLength(1)
  expect(notifier.sent[0]!.message).toContain('Z-BOX')
})

test('runPoll: a gated carrier produces one alarm across consecutive runs', async () => {
  const db = memDb()
  addParcel(db, 'gls', '312175332275')
  const gls = stubAdapter('gls', ins => ins.map(i => ({ ok: false as const, number: i.number, reason: 'gated' as const })))
  const notifier = recordingNotifier()
  await runPoll({ db, http: bodyHttp(), adapters: [gls], config, now: NOW, notifier })
  expect(notifier.sent).toHaveLength(1)
  expect(notifier.sent[0]!.groupKey).toBe('carrier-gls')
  // Later runs (a canary that fails again, then a longer wait) are still the same outage: no repeat alarm.
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

// --- durable announcements ------------------------------------------------------------------

test('a transient unknown is not a transition: recovering to the announced status stays quiet', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  updateParcelState(db, id, { status: 'unknown' })   // e.g. a one-off parse failure
  expect(build(db)).toEqual([])
  updateParcelState(db, id, { status: 'in_transit' })
  expect(build(db)).toEqual([])
  updateParcelState(db, id, { status: 'out_for_delivery' })
  expect(build(db)).toHaveLength(1)
  expect(getParcel(db, id)!.lastAnnouncedStatus).toBe('out_for_delivery')
})

test('runPoll without a notifier loses nothing: the next run with one announces the stored change', async () => {
  const db = memDb()
  addParcel(db, 'posta', 'RA000000001SK')
  const posta = stubAdapter('posta', ins => ins.map(i => okResult(i.number, history())), 100)
  const first = await runPoll({ db, http: bodyHttp(), adapters: [posta], config, now: NOW })   // e.g. a future "refresh now"
  expect(first.newEvents).toHaveLength(3)

  const notifier = recordingNotifier()
  const second = await runPoll({ db, http: bodyHttp(), adapters: [posta], config, now: new Date(NOW.getTime() + HOUR), notifier })
  expect(second.newEvents).toEqual([])
  expect(notifier.sent).toHaveLength(1)
  expect(notifier.sent[0]!.title).toMatch(/Out for delivery/)
})

// --- carrier alarms -------------------------------------------------------------------------

test('a gated alarm is never folded into the summary, so it cannot be truncated away', () => {
  const db = memDb()
  fiveTransitions(db, 6)
  recordHealth(db, 'gls', 'gated', 'gated for 123', NOW)
  const out = build(db)
  expect(out).toHaveLength(2)
  expect(out[0]!.title).toMatch(/^6 parcel updates/)
  expect(out[1]).toMatchObject({ groupKey: 'carrier-gls', title: 'GLS tracking is broken' })
  expect(out[1]!.title).not.toMatch(/parcel updates/)
  expect(carrierHealth(db)[0]!.notifiedAt).toEqual(NOW)   // stamped only because it is in the returned list
})

test('a carrier failing on transport is announced at its third consecutive failed run, once', () => {
  const db = memDb()
  const t = (h: number) => new Date(NOW.getTime() + h * HOUR)
  recordHealth(db, 'dpd', 'transport', 'timeout', t(0))
  recordHealth(db, 'dpd', 'transport', 'timeout', t(1))
  expect(build(db, [], t(1))).toEqual([])
  recordHealth(db, 'dpd', 'transport', 'timeout', t(2))
  const out = build(db, [], t(2))
  expect(out).toHaveLength(1)
  expect(out[0]).toMatchObject({ groupKey: 'carrier-dpd', title: 'DPD tracking is stale' })
  expect(out[0]!.message).toMatch(/3 runs/)
  recordHealth(db, 'dpd', 'transport', 'timeout', t(3))
  expect(build(db, [], t(3))).toEqual([])
  recordHealth(db, 'dpd', 'ok', undefined, t(4))
  for (const h of [5, 6, 7]) recordHealth(db, 'dpd', 'transport', 'timeout', t(h))
  expect(build(db, [], t(7))).toHaveLength(1)   // a fresh outage is announced afresh
})

test('repeated unreadable responses are announced the same way', () => {
  const db = memDb()
  for (const h of [0, 1, 2]) recordHealth(db, 'sps', 'parse', 'bad json', new Date(NOW.getTime() + h * HOUR))
  const out = build(db, [], new Date(NOW.getTime() + 2 * HOUR))
  expect(out).toHaveLength(1)
  expect(out[0]!.message).toMatch(/could not be read/)
})

test('when every carrier polled in the run failed (Mac offline) the stale alarm is withheld, not spent', () => {
  const db = memDb()
  const t = (h: number) => new Date(NOW.getTime() + h * HOUR)
  for (const h of [0, 1, 2]) {
    recordHealth(db, 'gls', 'transport', 'offline', t(h))
    recordHealth(db, 'dpd', 'transport', 'offline', t(h))
  }
  expect(build(db, [], t(2))).toEqual([])
  expect(carrierHealth(db).map(h => h.notifiedAt)).toEqual([undefined, undefined])
  // The connection returns and DPD answers while GLS is still failing: now GLS alone is the problem.
  recordHealth(db, 'dpd', 'ok', undefined, t(3))
  recordHealth(db, 'gls', 'transport', 'timeout', t(3))
  const out = build(db, [], t(3))
  expect(out.map(n => n.groupKey)).toEqual(['carrier-gls'])
})

test('a lone failing carrier cannot be told apart from being offline, so it is announced', () => {
  const db = memDb()
  for (const h of [0, 1, 2]) recordHealth(db, 'packeta', 'transport', 'timeout', new Date(NOW.getTime() + h * HOUR))
  expect(build(db, [], new Date(NOW.getTime() + 2 * HOUR))).toHaveLength(1)
})

test('a gated alarm is not withheld even when every carrier failed in the run', () => {
  const db = memDb()
  recordHealth(db, 'gls', 'gated', 'g', NOW)
  recordHealth(db, 'dpd', 'transport', 'offline', NOW)
  expect(build(db).map(n => n.groupKey)).toEqual(['carrier-gls'])
})


// --- the twice-daily reminder ---------------------------------------------------------------------

test('a parcel left waiting is mentioned again at each slot, and only once per slot', () => {
  const db = memDb()
  const id = parcelIn(db, 'ready_for_pickup', { pickup: ZBOX })
  const at = (iso: string) => build(db, [], new Date(iso))

  // 06:00 local: before the morning slot, so nothing yet.
  expect(at('2026-10-27T05:00:00Z')).toEqual([])
  // 09:00 local: the 08:00 slot has passed.
  const morning = at('2026-10-27T08:00:00Z')
  expect(morning).toHaveLength(1)
  expect(morning[0]!.title).toMatch(/^Still waiting for you — /)
  expect(morning[0]!.message).toContain('Z-BOX')
  // Later the same morning: the slot is spent.
  expect(at('2026-10-27T09:30:00Z')).toEqual([])
  // 15:45 local: the afternoon slot has passed.
  expect(at('2026-10-27T14:45:00Z')).toHaveLength(1)
  expect(at('2026-10-27T17:00:00Z')).toEqual([])
  // The next day starts over: two a day, every day it is still there.
  expect(at('2026-10-28T08:00:00Z')).toHaveLength(1)
  expect(db.prepare('SELECT COUNT(*) AS n FROM pickup_nudges WHERE parcel_id = ?').get(id)).toEqual({ n: 3 })
})

test('a machine asleep all day wakes to one reminder, not the whole day at once', () => {
  const db = memDb()
  parcelIn(db, 'ready_for_pickup', { pickup: ZBOX })
  // First run of the day is at 20:00 local, with both slots long past.
  expect(build(db, [], new Date('2026-10-27T19:00:00Z'))).toHaveLength(1)
  // ...and the morning slot it skipped cannot fire retroactively.
  expect(build(db, [], new Date('2026-10-27T19:30:00Z'))).toEqual([])
})

test('a transition already said it, so the slot it falls in does not repeat it an hour later', () => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup: ZBOX })
  const out = build(db, [], new Date('2026-10-27T09:00:00Z'))   // 10:00 local, after the morning slot
  expect(out).toHaveLength(1)
  expect(out[0]!.title).toMatch(/^Ready for pickup — /)
  expect(build(db, [], new Date('2026-10-27T11:00:00Z'))).toEqual([])
  // The afternoon slot still arrives on schedule.
  expect(build(db, [], new Date('2026-10-27T14:45:00Z'))).toHaveLength(1)
})

test('a parcel that is no longer waiting stops being nudged', () => {
  const db = memDb()
  const id = parcelIn(db, 'ready_for_pickup', { pickup: ZBOX })
  expect(build(db, [], new Date('2026-10-27T08:00:00Z'))).toHaveLength(1)
  updateParcelState(db, id, { status: 'delivered' })
  const out = build(db, [], new Date('2026-10-27T14:45:00Z'))
  expect(out).toHaveLength(1)
  expect(out[0]!.title).toMatch(/^Delivered — /)                 // the transition, not a nudge
  expect(build(db, [], new Date('2026-10-28T08:00:00Z'))).toEqual([])
})


test('a reminder says which day of waiting it is, counted in calendar days in Bratislava', () => {
  const db = memDb()
  // Ready on Sunday 25 Oct at 23:30 local (22:30Z): Sunday is day 1, however late in the day it was.
  parcelIn(db, 'ready_for_pickup', { pickup: ZBOX, lastChangedAt: new Date('2026-10-25T22:30:00Z') })
  const tuesday = build(db, [], new Date('2026-10-27T08:00:00Z'))   // 09:00 local on Tuesday
  expect(tuesday.map(n => n.title)).toEqual(['Still waiting for you · day 3 — RA000000001SK'])
})

test('a reminder for a parcel with no known arrival time says nothing about how long', () => {
  const db = memDb()
  parcelIn(db, 'ready_for_pickup', { pickup: ZBOX })
  expect(build(db, [], new Date('2026-10-27T08:00:00Z')).map(n => n.title)).toEqual(['Still waiting for you — RA000000001SK'])
})

// --- copy a non-technical reader can act on -------------------------------------------------------

test('a summary puts the parcels waiting for pickup first, so the length cap cannot cut them off', () => {
  const db = memDb()
  fiveTransitions(db, 5)   // ids 1..5 go out for delivery...
  const ready = parcelIn(db, 'in_transit', {}, 'posta', 'RA000000099SK')
  updateParcelState(db, ready, { status: 'ready_for_pickup', pickup: ZBOX })   // ...and the last one is ready
  const [summary] = build(db)
  expect(summary!.title).toBe('6 parcel updates')
  expect(summary!.message).toMatch(/^Ready for pickup — RA000000099SK; Out for delivery — /)
})

test('the update banner says what to do, not how many commits there are', () => {
  const db = memDb()
  recordUpdateCheck(db, parseUpdateCheck({
    status: 0,
    stdout: 'state behind\nversion 0.1.0\nbranch main\nlocal aaaaaaa\nupstream origin/main\nremote bbbbbbb\nbehind 3\n',
    stderr: '',
  }), NOW)
  const n = build(db).find(x => x.groupKey === 'update')!
  expect(n.message).toBe('A new version is ready — open Health and press Update now.')
  expect(n.message).not.toMatch(/commit|origin/)
})

test('a broken carrier is explained as tracking not working, likely needing an app update', () => {
  const db = memDb()
  recordHealth(db, 'gls', 'gated', 'gated for 123', NOW)
  const n = build(db).find(x => x.groupKey === 'carrier-gls')!
  expect(n.message).toBe("Tracking for GLS isn't working right now. It probably needs an app update.")
  expect(n.message).not.toMatch(/adapter/)
})

function failIngest(db: Database, error: string): void {
  for (const h of [0, 1, 2]) recordIngest(db, { ok: false, error }, new Date(NOW.getTime() + h * HOUR))
}

test.each([
  'Error: Invalid credentials (Failure)',
  'Error: [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
  'AuthenticationFailure: Authentication failed',
])('a mail failure that looks like a rejected password says to re-enter it in Settings (%s)', error => {
  const db = memDb()
  failIngest(db, error)
  const n = build(db, [], new Date(NOW.getTime() + 2 * HOUR)).find(x => x.groupKey === 'ingest')!
  expect(n.title).toBe('Mail ingest is failing')
  expect(n.message).toMatch(/App Password was probably revoked or changed/)
  expect(n.message).toMatch(/Settings/)
  expect(n.url).toBe(`http://127.0.0.1:${PORT}/settings`)
})

test('any other mail failure keeps the generic message and points at Health', () => {
  const db = memDb()
  failIngest(db, 'Error: getaddrinfo ENOTFOUND imap.gmail.com')
  const n = build(db, [], new Date(NOW.getTime() + 2 * HOUR)).find(x => x.groupKey === 'ingest')!
  expect(n.message).not.toMatch(/App Password/)
  expect(n.message).toMatch(/3 runs in a row/)
  expect(n.url).toBe(`http://127.0.0.1:${PORT}/health`)
})

// --- the progress and delivered switches ----------------------------------------------------------

test('a transition to in transit is quiet by default, recorded, and switching progress on later releases no backlog', () => {
  const db = memDb()
  const id = parcelIn(db, 'pre_transit')
  updateParcelState(db, id, { status: 'in_transit' })
  expect(build(db)).toEqual([])
  expect(getParcel(db, id)!.lastAnnouncedStatus).toBe('in_transit')
  // Turned on afterwards: the transition already happened and was recorded, so nothing is owed.
  expect(build(db, [], NOW, PROGRESS)).toEqual([])
  // What comes next is announced as usual.
  updateParcelState(db, id, { status: 'out_for_delivery' })
  expect(build(db).map(n => n.title)).toEqual(['Out for delivery — RA000000001SK'])
})

test('with progress on, registered and in transit are announced', () => {
  const db = memDb()
  const id = parcelIn(db, 'unknown')
  updateParcelState(db, id, { status: 'pre_transit' })
  expect(build(db, [], NOW, PROGRESS).map(n => n.title)).toEqual(['Registered — RA000000001SK'])
  updateParcelState(db, id, { status: 'in_transit' })
  expect(build(db, [], NOW, PROGRESS).map(n => n.title)).toEqual(['In transit — RA000000001SK'])
})

test('a pickup point seen while in transit does not speak for a quiet transition, and is recorded as said', () => {
  // DPD (`pudoId` on any scan) and Posta (`withOffice` events) name the pickup point long before it is
  // ready: under the quiet default that must not turn the in-transit poll into an "In transit" banner.
  const db = memDb()
  const id = parcelIn(db, 'pre_transit')
  updateParcelState(db, id, { status: 'in_transit', pickup: ZBOX })
  expect(build(db)).toEqual([])
  expect(getParcel(db, id)).toMatchObject({ lastAnnouncedStatus: 'in_transit', pickupAnnounced: true })

  // With progress on, the same parcel is announced, the pickup point in the message.
  const on = memDb()
  const id2 = parcelIn(on, 'pre_transit')
  updateParcelState(on, id2, { status: 'in_transit', pickup: ZBOX })
  const out = build(on, [], NOW, PROGRESS)
  expect(out.map(n => n.title)).toEqual(['In transit — RA000000001SK'])
  expect(out[0]!.message).toContain('Z-BOX, Hlavna 12, Zilina')
  expect(build(on, [], NOW, PROGRESS)).toEqual([])
})

test('a pickup point that appears a poll after a quiet transition stays quiet too, and leaves no backlog', () => {
  const db = memDb()
  const id = parcelIn(db, 'pre_transit', {}, 'dpd', '01234567890123')
  // Poll 1: in transit, no pickup point yet. Quiet, recorded.
  updateParcelState(db, id, { status: 'in_transit' })
  expect(build(db)).toEqual([])
  // Poll 2: still in transit, and a scan now names the pickup point (DPD's pudoId). No transition this
  // time, but the parcel is still in a quiet status: nothing pushed, the pickup point recorded as said.
  updateParcelState(db, id, { status: 'in_transit', pickup: ZBOX })
  expect(build(db, [], new Date(NOW.getTime() + HOUR))).toEqual([])
  expect(getParcel(db, id)).toMatchObject({ lastAnnouncedStatus: 'in_transit', pickupAnnounced: true })
  // Progress switched on in a later run: nothing owed.
  expect(build(db, [], new Date(NOW.getTime() + 2 * HOUR), PROGRESS)).toEqual([])
})

test.each([
  ['pre_transit', { progress: false }],
  ['delivered', { delivered: false }],
] as const)('a pickup point appearing while the parcel stays %s with its switch off does not speak', (status, off) => {
  const db = memDb()
  const id = parcelIn(db, status)
  updateParcelState(db, id, { status, pickup: ZBOX })
  expect(build(db, [], NOW, { ...DEFAULT_NOTIFICATIONS, ...off })).toEqual([])
  expect(getParcel(db, id)!.pickupAnnounced).toBe(true)
})

test('a pickup point first seen on a delivered parcel the user marked does not leak a Delivered banner', () => {
  const db = memDb()
  const id = parcelIn(db, 'out_for_delivery')
  expect(markCollected(db, id).ok).toBe(true)
  // As if the delivered status was never stamped as said, and the carrier then names a pickup point.
  markAnnounced(db, id, 'out_for_delivery', false)
  updateParcelState(db, id, { status: 'delivered', pickup: ZBOX })
  expect(getParcel(db, id)!.pickupAnnounced).toBe(false)
  expect(build(db)).toEqual([])
  expect(getParcel(db, id)).toMatchObject({ lastAnnouncedStatus: 'delivered', pickupAnnounced: true })
})

test('a newly registered parcel is quiet by default', () => {
  const db = memDb()
  const id = parcelIn(db, 'unknown')
  updateParcelState(db, id, { status: 'pre_transit' })
  expect(build(db)).toEqual([])
  expect(getParcel(db, id)!.lastAnnouncedStatus).toBe('pre_transit')
})

test('delivered is announced by default and is quiet, but recorded, with delivered off', () => {
  const db = memDb()
  const on = parcelIn(db, 'out_for_delivery', {}, 'posta', 'RA000000001SK')
  const off = parcelIn(db, 'out_for_delivery', {}, 'posta', 'RA000000002SK')
  updateParcelState(db, on, { status: 'delivered' })
  expect(build(db).map(n => n.title)).toEqual(['Delivered — RA000000001SK'])

  updateParcelState(db, off, { status: 'delivered' })
  expect(build(db, [], NOW, { ...DEFAULT_NOTIFICATIONS, delivered: false })).toEqual([])
  expect(getParcel(db, off)!.lastAnnouncedStatus).toBe('delivered')
  expect(build(db)).toEqual([])   // switched back on: nothing owed
})

test('delivered is quiet, but recorded, for a parcel the user already said they have', () => {
  const db = memDb()
  const id = parcelIn(db, 'ready_for_pickup', { pickup: ZBOX })
  expect(markCollected(db, id).ok).toBe(true)
  // The mark records its own announcement; rewind it, as if the delivered status was never stamped
  // as said, so only the user_marks row stands between the transition and a banner.
  markAnnounced(db, id, 'ready_for_pickup', true)
  expect(getParcel(db, id)!.status).toBe('delivered')
  expect(build(db)).toEqual([])
  expect(getParcel(db, id)!.lastAnnouncedStatus).toBe('delivered')
})

test.each([
  ['ready_for_pickup', 'Ready for pickup'],
  ['failed_attempt', 'Delivery attempt failed'],
  ['returning', 'Returning to sender'],
] as const)('%s is still announced with progress off', (status, title) => {
  const db = memDb()
  const id = parcelIn(db, 'in_transit')
  updateParcelState(db, id, { status })
  expect(build(db, [], NOW, { ...DEFAULT_NOTIFICATIONS, progress: false }).map(n => n.title))
    .toEqual([`${title} — RA000000001SK`])
})

test('runPoll passes the config\'s switches: in transit is quiet under the defaults and announced with progress on', async () => {
  const run = async (notifications: NotificationPrefs) => {
    const db = memDb()
    addParcel(db, 'packeta', 'Z0000000001')
    const packeta = stubAdapter('packeta', ins => ins.map(i =>
      okResult(i.number, [ev('2026-10-25 09:00:00', 'in_transit', 20)], { status: 'in_transit' })))
    const notifier = recordingNotifier()
    await runPoll({ db, http: bodyHttp(), adapters: [packeta], config: { ...config, notifications }, now: NOW, notifier })
    return notifier.sent.map(n => n.title)
  }
  expect(await run(DEFAULT_NOTIFICATIONS)).toEqual([])
  expect(await run(PROGRESS)).toEqual(['In transit — Z0000000001'])
})
