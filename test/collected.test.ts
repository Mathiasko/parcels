import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { markCollected, undoCollected } from '../src/core/collected.js'
import { runPoll } from '../src/core/poll.js'
import { runPickupCodes } from '../src/core/pickup-code.js'
import { buildNotifications } from '../src/notify/rules.js'
import { ingestMessages } from '../src/ingest/ingest.js'
import { allAdapters } from '../src/carriers/registry.js'
import {
  appendEvents, listEvents, recomputeParcelStatus, userMark, userMarks,
} from '../src/db/events.js'
import {
  deleteParcel, getParcel, insertParcel, listActive, listDelivered, markAnnounced, setArchived, updateParcelState,
  type ParcelStateUpdate,
} from '../src/db/parcels.js'
import { describeActivity, listActivity } from '../src/db/activity-log.js'
import { buildSupportBundle } from '../src/core/support.js'
import { deliveryStats } from '../src/web/queries.js'
import { buildServer } from '../src/web/server.js'
import { STYLE } from '../src/web/views/style.js'
import type { Database } from '../src/db/index.js'
import type { CanonicalStatus, CarrierId, PickupPoint } from '../src/core/types.js'
import type { Notification } from '../src/notify/types.js'
import { fakeImap, type FakeMessage } from './imap-fake.js'
import { NOW, addParcel, bodyHttp, config, ev, memDb, okResult, stubAdapter } from './poll-helpers.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const PORT = 8787
const ZBOX: PickupPoint = { kind: 'zbox', name: 'Z-BOX', street: 'Bottova 6', city: 'Bratislava' }
const WEB = { actor: 'web' as const, at: NOW }

/** A parcel in `status`, with a carrier event, already announced as such (an earlier run told the user). */
function parcelIn(
  db: Database, status: CanonicalStatus,
  o: { carrier?: CarrierId; number?: string; label?: string; extra?: Partial<ParcelStateUpdate> } = {},
): number {
  const id = addParcel(db, o.carrier ?? 'packeta', o.number ?? 'Z0000000001')
  if (o.label) db.prepare('UPDATE parcels SET label = ? WHERE id = ?').run(o.label, id)
  appendEvents(db, id, [ev('first', 'in_transit', 30, 'On its way'), ev('ready', status, 5, 'Arrived at the box')])
  updateParcelState(db, id, { status, lastChangedAt: new Date(NOW.getTime() - 5 * HOUR), ...o.extra })
  markAnnounced(db, id, status, o.extra?.pickup !== undefined)
  return id
}

const build = (db: Database, now = NOW): Notification[] => buildNotifications(db, [], now, PORT)

// --- the mark itself ------------------------------------------------------------------------------

describe('marking a parcel collected', () => {
  test('appends one delivered event at the click, told apart from the carrier\'s, and the parcel is delivered', () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup', { extra: { pickup: ZBOX } })
    const r = markCollected(db, id, WEB)
    expect(r.ok).toBe(true)

    const p = getParcel(db, id)!
    expect(p.status).toBe('delivered')
    expect(p.deliveredAt).toEqual(NOW)
    const events = listEvents(db, id)
    expect(events).toHaveLength(3)
    const mine = events.filter(e => e.byUser)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ status: 'delivered', description: 'Collected — marked by you', occurredAt: NOW })
    expect(events.filter(e => !e.byUser).map(e => e.description)).toEqual(['On its way', 'Arrived at the box'])
    expect(userMark(db, id)).toMatchObject({ kind: 'collected', carrierStatus: 'ready_for_pickup', at: NOW })

    expect(listActive(db).map(x => x.id)).not.toContain(id)
    expect(listDelivered(db).map(x => x.id)).toContain(id)
  })

  test('a parcel that was not at a pickup point is "received", not "collected"', () => {
    const db = memDb()
    const id = parcelIn(db, 'in_transit')
    markCollected(db, id, WEB)
    expect(userMark(db, id)?.kind).toBe('received')
    expect(listEvents(db, id).find(e => e.byUser)?.description).toBe('Received — marked by you')
    expect(getParcel(db, id)!.status).toBe('delivered')
  })

  test('a carrier event spelled exactly like the mark is still a separate event: the dedup key cannot merge them', () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup')
    markCollected(db, id, WEB)
    const lookalike = {
      occurredAtRaw: NOW.toISOString(), occurredAtTz: 'UTC', occurredAt: NOW,
      status: 'delivered' as const, description: 'Collected — marked by you',
    }
    expect(appendEvents(db, id, [lookalike])).toHaveLength(1)
    const events = listEvents(db, id)
    expect(events.filter(e => e.description === 'Collected — marked by you')).toHaveLength(2)
    expect(events.filter(e => e.byUser)).toHaveLength(1)
  })

  test.each<[string, (db: Database, id: number) => void]>([
    ['already delivered by the carrier', (db, id) => updateParcelState(db, id, { status: 'delivered' })],
    ['returned', (db, id) => updateParcelState(db, id, { status: 'returned' })],
    ['archived', (db, id) => setArchived(db, id, NOW)],
  ])('is refused, with nothing changed, when the parcel is %s', (_, make) => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup')
    make(db, id)
    const before = { p: getParcel(db, id), events: listEvents(db, id).length }
    expect(markCollected(db, id, WEB)).toEqual({ ok: false, reason: 'not_in_flight' })
    expect(getParcel(db, id)).toEqual(before.p)
    expect(listEvents(db, id)).toHaveLength(before.events)
    expect(userMark(db, id)).toBeUndefined()
  })

  test('an unknown parcel is reported as such', () => {
    expect(markCollected(memDb(), 999, WEB)).toEqual({ ok: false, reason: 'no_parcel' })
  })

  test('a marked parcel can still be deleted (the mark names one of its events)', () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup')
    markCollected(db, id, WEB)
    deleteParcel(db, id, WEB)
    expect(getParcel(db, id)).toBeUndefined()
    expect(userMarks(db).size).toBe(0)
  })
})

// --- no banner, no reminder -------------------------------------------------------------------------

describe('the user\'s own action is not announced back to them', () => {
  test('no "Delivered" banner on the next run', () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup', { extra: { pickup: ZBOX } })
    markCollected(db, id, WEB)
    expect(build(db, new Date(NOW.getTime() + HOUR))).toEqual([])
    expect(getParcel(db, id)!.lastAnnouncedStatus).toBe('delivered')
  })

  test('not even when its pickup point had never been announced', () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup')
    // The mail pass found the place after the last banner: unannounced, so the next run would say it.
    db.prepare("UPDATE parcels SET pickup_kind = 'zbox', pickup_name = 'Z-BOX', pickup_announced = 0 WHERE id = ?").run(id)
    markCollected(db, id, WEB)
    expect(build(db, new Date(NOW.getTime() + HOUR))).toEqual([])
  })

  test('no "Still waiting" reminder at the next reminder slot', () => {
    // NOW is 11:00 on Monday in Bratislava, the day it became ready; the next slot is 08:00 on Tuesday.
    const atSlot = new Date('2026-10-27T07:01:00Z')
    const control = memDb()
    parcelIn(control, 'ready_for_pickup', { extra: { pickup: ZBOX } })
    expect(build(control, atSlot).map(n => n.title)).toEqual([expect.stringMatching(/^Still waiting since Mon/)])

    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup', { extra: { pickup: ZBOX } })
    markCollected(db, id, WEB)
    expect(build(db, atSlot)).toEqual([])
  })
})

// --- nothing puts it back ---------------------------------------------------------------------------

describe('a marked parcel stays collected', () => {
  test('the poller never asks about it again, even on a forced refresh of that one parcel', async () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup')
    markCollected(db, id, WEB)
    const adapter = stubAdapter('packeta', inputs => inputs.map(i => okResult(i.number, [ev('ready', 'ready_for_pickup', 5)], { status: 'ready_for_pickup' })))
    await runPoll({ db, http: bodyHttp(), adapters: [adapter], config, now: new Date(NOW.getTime() + 2 * HOUR) })
    await runPoll({ db, http: bodyHttp(), adapters: [adapter], config, now: new Date(NOW.getTime() + 3 * HOUR), forceAll: true, parcelIds: [id] })
    expect(adapter.calls).toEqual([])
    expect(getParcel(db, id)!.status).toBe('delivered')
  })

  test('a poll already in flight when the user clicked cannot put it back to ready, nor announce anything', async () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup')
    const sent: Notification[] = []
    // The click lands while the carrier is being asked; the carrier then answers "ready", as it would.
    const adapter = stubAdapter('packeta', inputs => {
      markCollected(db, id, WEB)
      return inputs.map(i => okResult(i.number, [ev('first', 'in_transit', 30, 'On its way'), ev('ready', 'ready_for_pickup', 5, 'Arrived at the box'), ev('late', 'ready_for_pickup', 1, 'Still there')], { status: 'ready_for_pickup' }))
    })
    await runPoll({
      db, http: bodyHttp(), adapters: [adapter], config, now: new Date(NOW.getTime() + HOUR),
      notifier: { send: async n => { sent.push(n) } },
    })
    expect(adapter.calls).toHaveLength(1)
    const p = getParcel(db, id)!
    expect(p.status).toBe('delivered')
    expect(p.deliveredAt).toEqual(NOW)
    expect(sent).toEqual([])
    // The carrier's new event is kept, and nothing logs a move back to ready.
    expect(listEvents(db, id).map(e => e.description)).toContain('Still there')
    expect(listActivity(db, 50).filter(e => e.kind === 'status' && e.parcelId === id && e.from === 'delivered')).toEqual([])
  })

  test('a later carrier "delivered" is harmless: still delivered, still the user\'s mark', () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup')
    markCollected(db, id, WEB)
    appendEvents(db, id, [ev('picked', 'delivered', 0.5, 'You picked up your parcel')])
    recomputeParcelStatus(db, id, 'delivered', new Date(NOW.getTime() + HOUR))
    expect(getParcel(db, id)!.status).toBe('delivered')
    expect(userMark(db, id)).toBeDefined()
  })

  describe('a late "ready for pickup" email for it', () => {
    const fx = (name: string) => readFileSync(new URL(`./fixtures/mail/${name}.eml`, import.meta.url))
    const imap = { host: 'imap.example.com', port: 993, user: 'u@example.com', pass: 'pw', mailbox: 'parcels' }
    function mail(uid: number, name: string): FakeMessage {
      const source = fx(name)
      const text = source.toString('latin1')
      return {
        uid, source, messageId: /^Message-ID: <(.+)>$/m.exec(text)?.[1] ?? `<${name}@fixture>`,
        subject: /^Subject: (.*)$/m.exec(text)?.[1] ?? name, from: /^From: .*<(.+?)>/m.exec(text)?.[1] ?? 'x@example.com',
        date: new Date(NOW.getTime() + HOUR),
      }
    }
    const later = new Date(NOW.getTime() + 2 * HOUR)

    test('Packeta: the mail is linked to the parcel, which stays delivered through ingest, the code pass and a poll', async () => {
      const db = memDb()
      const id = parcelIn(db, 'ready_for_pickup', { number: 'Z0000000001' })
      markCollected(db, id, WEB)
      const report = await ingestMessages(db, {
        imap, client: fakeImap([mail(1, 'packeta-ready-zbox')]).client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-collected-')),
        now: later, adapters: allAdapters(), defaultPostalCode: '81101',
      })
      expect(report).toMatchObject({ linked: 1, created: 0 })
      await runPickupCodes({ db, now: later })
      const sent: Notification[] = []
      await runPoll({ db, http: bodyHttp(), adapters: [], config, now: later, notifier: { send: async n => { sent.push(n) } } })
      expect(getParcel(db, id)!.status).toBe('delivered')
      expect(listActive(db)).toEqual([])
      expect(sent).toEqual([])
    })

    test('DHL (email-only): the mail\'s words become an event, and the parcel stays delivered', async () => {
      const db = memDb()
      const id = insertParcel(db, { carrier: 'dhl', trackingNumber: 'JJD0099990758473189', source: 'email' })
      markCollected(db, id, WEB)
      expect(userMark(db, id)?.kind).toBe('received')
      await ingestMessages(db, {
        imap, client: fakeImap([mail(1, 'synthetic-dhl-ready-for-pickup')]).client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-collected-')),
        now: later, adapters: allAdapters(), defaultPostalCode: '81101',
      })
      expect(listEvents(db, id).filter(e => !e.byUser)).toHaveLength(1)
      expect(getParcel(db, id)!.status).toBe('delivered')
      expect(build(db, later)).toEqual([])
    })
  })
})

// --- undo ---------------------------------------------------------------------------------------------

describe('undo', () => {
  test('deletes exactly the mark\'s event and returns the parcel to what the carrier says, without a banner', () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup', { extra: { pickup: ZBOX } })
    const before = listEvents(db, id)
    markCollected(db, id, WEB)
    const r = undoCollected(db, id, { actor: 'web', at: new Date(NOW.getTime() + 10 * 60_000) })
    expect(r.ok).toBe(true)
    const p = getParcel(db, id)!
    expect(p.status).toBe('ready_for_pickup')
    expect(p.deliveredAt).toBeUndefined()
    expect(p.lastAnnouncedStatus).toBe('ready_for_pickup')
    expect(listEvents(db, id)).toEqual(before)
    expect(userMark(db, id)).toBeUndefined()
    expect(listActive(db).map(x => x.id)).toContain(id)
    expect(build(db, new Date(NOW.getTime() + HOUR))).toEqual([])
  })

  test('nor an immediate "still waiting" for a reminder slot that passed while it was marked', () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup', { extra: { pickup: ZBOX } })
    markCollected(db, id, WEB)
    // Undone on Tuesday at 09:00, after that day's 08:00 slot (not the ready day, so it would have fired).
    const tuesday = new Date('2026-10-27T08:00:00Z')
    undoCollected(db, id, { actor: 'web', at: tuesday })
    expect(build(db, new Date(tuesday.getTime() + HOUR))).toEqual([])
    // The next day's reminder comes round as usual.
    const wednesday = new Date('2026-10-28T07:30:00Z')            // 08:30
    expect(build(db, wednesday).map(n => n.title)).toEqual([expect.stringMatching(/^Still waiting since Mon/)])
  })

  test('restores what the carrier said meanwhile, when a poll in flight answered after the click', async () => {
    const db = memDb()
    const id = parcelIn(db, 'out_for_delivery', { carrier: 'gls', number: '12345678901' })
    const adapter = stubAdapter('gls', inputs => {
      markCollected(db, id, WEB)
      return inputs.map(i => okResult(i.number, [ev('d', 'delivered', 0.5)], { status: 'delivered' }))
    })
    await runPoll({ db, http: bodyHttp(), adapters: [adapter], config, now: new Date(NOW.getTime() + HOUR) })
    expect(userMark(db, id)?.carrierStatus).toBe('delivered')
    undoCollected(db, id, WEB)
    expect(getParcel(db, id)!.status).toBe('delivered')
    expect(userMark(db, id)).toBeUndefined()
  })

  test.each<[string, (db: Database) => number]>([
    ['delivered by the carrier', db => {
      const id = parcelIn(db, 'ready_for_pickup')
      updateParcelState(db, id, { status: 'delivered' })
      recomputeParcelStatus(db, id, 'delivered', NOW)
      return id
    }],
    ['still in flight', db => parcelIn(db, 'ready_for_pickup')],
  ])('is refused, with nothing changed, on a parcel %s', (_, make) => {
    const db = memDb()
    const id = make(db)
    const before = { p: getParcel(db, id), events: listEvents(db, id) }
    expect(undoCollected(db, id, WEB)).toEqual({ ok: false, reason: 'not_marked' })
    expect(getParcel(db, id)).toEqual(before.p)
    expect(listEvents(db, id)).toEqual(before.events)
  })
})

// --- history, medians, activity log ------------------------------------------------------------------

/** A carrier-delivered parcel with a 24h span from first scan to delivery. */
function carrierDelivered(db: Database, number: string, hours = 24): number {
  const id = addParcel(db, 'posta', number)
  const at = new Date(NOW.getTime() - DAY)
  appendEvents(db, id, [
    { occurredAtRaw: `${number}a`, occurredAtTz: 'UTC', occurredAt: new Date(at.getTime() - hours * HOUR), status: 'pre_transit', description: 'Registered' },
    { occurredAtRaw: `${number}b`, occurredAtTz: 'UTC', occurredAt: at, status: 'delivered', description: 'Delivered' },
  ])
  updateParcelState(db, id, { status: 'delivered', deliveredAt: at })
  return id
}

describe('history and the medians', () => {
  test('user-marked deliveries are left out of the carrier\'s median and its counts', () => {
    const db = memDb()
    for (const n of ['RA000000001SK', 'RA000000002SK', 'RA000000003SK']) carrierDelivered(db, n)
    const id = parcelIn(db, 'ready_for_pickup', { carrier: 'posta', number: 'RA000000004SK' })
    db.prepare('UPDATE events SET occurred_at = ? WHERE parcel_id = ?').run(new Date(NOW.getTime() - 30 * DAY).toISOString(), id)
    markCollected(db, id, WEB)
    expect(deliveryStats(db).get('posta')).toMatchObject({ delivered: 3, measured: 3, medianMs: DAY })
  })

  test('History shows "Collected" for a pickup marked by the user and "Delivered" for the carrier\'s', async () => {
    const db = memDb()
    carrierDelivered(db, 'RA000000001SK')
    const id = parcelIn(db, 'ready_for_pickup', { label: 'Topánky' })
    const home = parcelIn(db, 'in_transit', { carrier: 'gls', number: '12345678901', label: 'Shop van' })
    markCollected(db, id, WEB)
    markCollected(db, home, WEB)
    const body = (await server(db).inject({ method: 'GET', url: '/history' })).body
    const rowOf = (name: string) => body.split('<tr>').find(r => r.includes(`>${name}</a>`))!
    expect(rowOf('Topánky')).toMatch(/<span class="st t-ok" data-status="collected"><svg[^>]*>.*?<\/svg>Collected<\/span>/)
    expect(rowOf('Shop van')).toMatch(/<\/svg>Received<\/span>/)
    expect(rowOf('RA000000001SK')).toMatch(/<\/svg>Delivered<\/span>/)
    expect(body).toContain('3 finished parcels: 1 delivered, 1 collected, 1 received.')
    expect(body).toContain('and so are the ones you marked collected yourself')
  })
})

describe('the activity log', () => {
  test('records the mark and the undo, attributed to the web, with the status each moved from and to', () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup')
    markCollected(db, id, WEB)
    undoCollected(db, id, { actor: 'web', at: new Date(NOW.getTime() + 60_000) })
    const [undo, mark] = listActivity(db, 10).filter(e => e.kind !== 'status')
    expect(mark).toMatchObject({ kind: 'collected', actor: 'web', parcelId: id, carrier: 'packeta', from: 'ready_for_pickup', to: 'delivered', detail: 'collected' })
    expect(undo).toMatchObject({ kind: 'uncollected', actor: 'web', parcelId: id, from: 'delivered', to: 'ready_for_pickup' })
    expect(describeActivity(mark!)).toBe(`#${id} packeta marked collected by you, it was ready_for_pickup`)
    expect(describeActivity(undo!)).toBe(`#${id} packeta: "marked collected" undone, back to ready_for_pickup`)
  })

  test('the support bundle and /health print both kinds', async () => {
    const db = memDb()
    const id = parcelIn(db, 'in_transit')
    markCollected(db, id, WEB)
    undoCollected(db, id, WEB)
    const bundle = buildSupportBundle({
      db, config, version: 'test', now: NOW, env: { node: 'v24', os: 'macOS', arch: 'arm64' },
      launchd: { agents: [] }, dataDir: mkdtempSync(join(tmpdir(), 'parcels-collected-')),
    })
    expect(bundle).toContain(`#${id} packeta marked received by you, it was in_transit`)
    expect(bundle).toContain(`#${id} packeta: "marked received" undone, back to in_transit`)
    const health = (await server(db).inject({ method: 'GET', url: '/health' })).body
    expect(health).toContain('<td>marked collected</td>')
    expect(health).toContain('<td>mark undone</td>')
  })
})

// --- the web: routes, buttons, notice -----------------------------------------------------------------

const server = (db: Database) => buildServer({ db, config, now: () => NOW, notifier: { send: async () => {} } })
const post = (db: Database, url: string, payload = '', headers: Record<string, string> = {}) => server(db).inject({
  method: 'POST', url, payload, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
})
/** The page without its inlined stylesheet, whose comments would otherwise match words asserted absent. */
const get = async (db: Database, url: string) => (await server(db).inject({ method: 'GET', url })).body.replace(/<style>[\s\S]*?<\/style>/, '')

const cards = (body: string): string[] => body.split('<article class="card').slice(1).map(s => s.split('</article>')[0]!)
const blocks = (card: string): string[] => card.split('<li').slice(1).map(s => s.split('</li>')[0]!)
const markButton = (id: number, label: string, name: string, home = false) =>
  `<form class="got" method="post" action="/parcel/${id}/collected">${home ? '<input type="hidden" name="back" value="home">' : ''}<button>${label}<span class="vh">: ${name}</span></button></form>`
const undoButton = (id: number, home = false) =>
  `<form class="undo-f" method="post" action="/parcel/${id}/uncollected">${home ? '<input type="hidden" name="back" value="home">' : ''}<button class="link">Undo</button></form>`

describe('POST /parcel/:id/collected and /uncollected', () => {
  test('from the dashboard: marked, back to the dashboard with a notice that offers Undo', async () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup', { label: 'engaro.sk' })
    const res = await post(db, `/parcel/${id}/collected`, 'back=home')
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`/?collected=${id}`)
    expect(getParcel(db, id)!.status).toBe('delivered')
    const body = await get(db, `/?collected=${id}`)
    expect(body).toContain('<p>Marked <strong>engaro.sk</strong> as collected. It is in <a href="/history">History</a>.</p>')
    expect(body).toContain(undoButton(id, true))
  })

  test('undo from the notice: the parcel is back on the dashboard, ready, with nothing announced', async () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup', { label: 'engaro.sk' })
    await post(db, `/parcel/${id}/collected`, 'back=home')
    const res = await post(db, `/parcel/${id}/uncollected`, 'back=home')
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/')
    expect(getParcel(db, id)!.status).toBe('ready_for_pickup')
    expect(cards(await get(db, '/'))).toHaveLength(1)
    expect(build(db, new Date(NOW.getTime() + HOUR))).toEqual([])
  })

  test('from the parcel page: back to the parcel page, which says it is the user\'s mark and offers Undo', async () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup', { label: 'engaro.sk' })
    const res = await post(db, `/parcel/${id}/collected`)
    expect(res.headers.location).toBe(`/parcel/${id}`)
    const body = await get(db, `/parcel/${id}`)
    expect(body).toContain(`<div class="status"><span class="st t-ok" data-status="collected">`)
    expect(body).toMatch(/<\/svg>Collected<\/span><span class="meta">— marked by you ·<\/span>/)
    expect(body).toContain(undoButton(id))
    // The timeline row is the mark's own sentence, with no "Delivered" word claiming the carrier said so.
    expect(body).toMatch(/<div class="tx">Collected — marked by you<\/div>/)
    expect(body).not.toContain('>Delivered</span>')
    const undo = await post(db, `/parcel/${id}/uncollected`)
    expect(undo.headers.location).toBe(`/parcel/${id}`)
    expect(getParcel(db, id)!.status).toBe('ready_for_pickup')
  })

  test('the notice is not shown for a parcel that is not marked, for a stale mark, or for nonsense', async () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup')
    const delivered = carrierDelivered(db, 'RA000000001SK')
    for (const q of [`${id}`, `${delivered}`, '999', 'abc', '']) {
      expect(await get(db, `/?collected=${q}`)).not.toContain('class="undo"')
    }
    // Marked two hours before the page is rendered: a bookmark, not a reload.
    markCollected(db, id, { actor: 'web', at: new Date(NOW.getTime() - 2 * HOUR) })
    expect(await get(db, `/?collected=${id}`)).not.toContain('class="undo"')
  })

  test('404 for an unknown parcel', async () => {
    const db = memDb()
    for (const url of ['/parcel/999/collected', '/parcel/abc/collected', '/parcel/999/uncollected']) {
      const res = await post(db, url, 'back=home')
      expect(res.statusCode).toBe(404)
      expect(res.body).toContain('<h1>Not found</h1>')
    }
  })

  test('marking an already delivered or archived parcel, or undoing an unmarked one, changes nothing', async () => {
    const db = memDb()
    const delivered = carrierDelivered(db, 'RA000000001SK')
    const archived = parcelIn(db, 'ready_for_pickup')
    setArchived(db, archived, NOW)
    const ready = parcelIn(db, 'ready_for_pickup', { number: 'Z0000000002' })
    const snapshot = () => [delivered, archived, ready].map(id => ({ p: getParcel(db, id), e: listEvents(db, id) }))
    const before = snapshot()
    for (const id of [delivered, archived]) {
      const res = await post(db, `/parcel/${id}/collected`)
      expect(res.statusCode).toBe(303)
      expect(res.headers.location).toBe(`/parcel/${id}`)
    }
    for (const id of [delivered, ready]) {
      expect((await post(db, `/parcel/${id}/uncollected`)).statusCode).toBe(303)
    }
    expect(snapshot()).toEqual(before)
    expect(listActivity(db, 50).filter(e => e.kind !== 'status')).toEqual([])
  })

  test('a cross-site or foreign-origin POST is refused and changes nothing', async () => {
    const db = memDb()
    const id = parcelIn(db, 'ready_for_pickup')
    const attempt = (headers: Record<string, string>) => post(db, `/parcel/${id}/collected`, '', { host: '127.0.0.1:8787', ...headers })
    expect((await attempt({ origin: 'https://evil.example' })).statusCode).toBe(403)
    expect((await attempt({ origin: 'http://localhost:3000' })).statusCode).toBe(403)
    expect((await attempt({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403)
    expect((await attempt({ host: 'evil.example' })).statusCode).toBe(403)
    expect(getParcel(db, id)!.status).toBe('ready_for_pickup')

    markCollected(db, id, WEB)
    expect((await post(db, `/parcel/${id}/uncollected`, '', { host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403)
    expect(getParcel(db, id)!.status).toBe('delivered')
    // ...and the same request from this very server goes through.
    expect((await post(db, `/parcel/${id}/uncollected`, '', { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' })).statusCode).toBe(303)
    expect(getParcel(db, id)!.status).toBe('ready_for_pickup')
  })
})

describe('where the button appears', () => {
  test('dashboard: on a ready parcel\'s card, and not on one in transit', async () => {
    const db = memDb()
    const ready = parcelIn(db, 'ready_for_pickup', { label: 'Topánky' })
    const moving = parcelIn(db, 'in_transit', { carrier: 'gls', number: '12345678901', label: 'Moving' })
    const body = await get(db, '/')
    const cardOf = (name: string) => cards(body).find(c => c.includes(`>${name}</a></h2>`))!
    expect(cardOf('Topánky')).toContain(markButton(ready, 'Mark as collected', 'Topánky', true))
    expect(cardOf('Moving')).not.toContain('<form class="got"')
    expect(body).not.toContain(`/parcel/${moving}/collected`)
    expect(body).not.toContain('Mark as received')
  })

  test('dashboard: a card that groups parcels at one place has one button per parcel, each in its own block', async () => {
    const db = memDb()
    const a = parcelIn(db, 'ready_for_pickup', { number: 'Z0000000001', label: 'Parcel A', extra: { pickup: ZBOX } })
    const b = parcelIn(db, 'ready_for_pickup', { number: 'Z0000000002', label: 'Parcel B', extra: { pickup: ZBOX } })
    const [shared] = cards(await get(db, '/'))
    const byName = (n: string) => blocks(shared!).find(x => x.includes(`>${n}</a></h3>`))!
    expect(byName('Parcel A')).toContain(markButton(a, 'Mark as collected', 'Parcel A', true))
    expect(byName('Parcel A')).not.toContain(`/parcel/${b}/collected`)
    expect(byName('Parcel B')).toContain(markButton(b, 'Mark as collected', 'Parcel B', true))
    expect(shared!.match(/<form class="got"/g)).toHaveLength(2)
  })

  test.each<[CanonicalStatus, string]>([
    ['ready_for_pickup', 'Mark as collected'],
    ['in_transit', 'Mark as received'],
    ['out_for_delivery', 'Mark as received'],
    ['failed_attempt', 'Mark as received'],
  ])('parcel page: a %s parcel offers "%s" in the side column', async (status, label) => {
    const db = memDb()
    const id = parcelIn(db, status, { label: 'Topánky' })
    const body = await get(db, `/parcel/${id}`)
    const side = body.split('<aside class="side">')[1]!.split('</aside>')[0]!
    expect(side).toContain(markButton(id, label, 'Topánky'))
    expect(body.match(/<form class="got"/g)).toHaveLength(1)
  })

  test.each<[string, (db: Database) => number]>([
    ['delivered by the carrier', db => carrierDelivered(db, 'RA000000001SK')],
    ['marked collected', db => {
      const id = parcelIn(db, 'ready_for_pickup')
      markCollected(db, id, WEB)
      return id
    }],
    ['archived', db => {
      const id = parcelIn(db, 'ready_for_pickup')
      setArchived(db, id, NOW)
      return id
    }],
  ])('parcel page: no button on a parcel %s', async (_, make) => {
    const db = memDb()
    const body = await get(db, `/parcel/${make(db)}`)
    expect(body).not.toContain('<form class="got"')
    expect(body).not.toMatch(/Mark as (collected|received)/)
  })

  test('the button sits above the card\'s stretched link, and is never the signal colour', () => {
    expect(STYLE).toMatch(/\.got\{position:relative;z-index:1/)
    const rules = STYLE.split('}').filter(r => /\.got\b/.test(r)).join('}')
    expect(rules).not.toContain('--signal')
  })
})
