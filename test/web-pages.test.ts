import { describe, expect, test, vi } from 'vitest'
import { buildServer, type WebDeps } from '../src/web/server.js'
import { appendEvents } from '../src/db/events.js'
import { recordHealth } from '../src/db/health.js'
import { recordIngest } from '../src/db/ingest-status.js'
import type { Config } from '../src/core/config.js'
import { findParcel, getParcel, insertParcel, setArchived, setNeedsPostcode, updateParcelState } from '../src/db/parcels.js'
import type { Database } from '../src/db/index.js'
import type { CarrierId } from '../src/core/types.js'
import type { Notification } from '../src/notify/types.js'
import { getAdapter } from '../src/carriers/registry.js'
import { formatDuration } from '../src/web/views/format.js'
import { bodyHttp, config, ev, memDb, NOW, okResult, stubAdapter } from './poll-helpers.js'

const DAY = 24 * 3_600_000

/** A delivered parcel whose first carrier event was `spanHours` before it was delivered. */
function delivered(
  db: Database,
  o: { carrier?: CarrierId; number: string; label?: string; merchant?: string; deliveredDaysAgo?: number; spanHours?: number | null },
): number {
  const id = insertParcel(db, {
    carrier: o.carrier ?? 'posta', trackingNumber: o.number, label: o.label, merchant: o.merchant, source: 'email',
  })
  const deliveredAt = new Date(NOW.getTime() - (o.deliveredDaysAgo ?? 1) * DAY)
  if (o.spanHours !== null) {
    const first = new Date(deliveredAt.getTime() - (o.spanHours ?? 24) * 3_600_000)
    appendEvents(db, id, [
      { occurredAtRaw: 'a', occurredAtTz: 'Europe/Bratislava', occurredAt: first, status: 'pre_transit', description: 'Registered' },
      { occurredAtRaw: 'b', occurredAtTz: 'Europe/Bratislava', occurredAt: deliveredAt, status: 'delivered', description: 'Delivered' },
    ])
  }
  updateParcelState(db, id, { status: 'delivered', deliveredAt })
  return id
}

const form = (fields: Record<string, string>) => ({
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
})

/** The default notifier would launch a real banner, so every server here gets a silent one unless the test supplies its own. */
const server = (db: Database, extra: Partial<WebDeps> = {}) =>
  buildServer({ db, config, now: () => NOW, notifier: { send: async () => {} }, ...extra })
const get = (db: Database, url: string) => server(db).inject({ method: 'GET', url })
const post = (db: Database, url: string, fields: Record<string, string>, extra: Partial<WebDeps> = {}) =>
  server(db, extra).inject({ method: 'POST', url, ...form(fields) })

describe('web pages', () => {
  test('GET /history lists delivered parcels newest-first', async () => {
    const db = memDb()
    delivered(db, { number: 'OLD', label: 'Oldest one', deliveredDaysAgo: 10 })
    delivered(db, { number: 'NEW', label: 'Newest one', deliveredDaysAgo: 1 })
    delivered(db, { number: 'MID', label: 'Middle one', deliveredDaysAgo: 5 })
    insertParcel(db, { carrier: 'posta', trackingNumber: 'ACTIVE', label: 'Still travelling', source: 'manual' })
    const body = (await get(db, '/history')).body
    const at = ['Newest one', 'Middle one', 'Oldest one'].map(t => body.indexOf(t))
    expect(at.every(i => i >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(body).not.toContain('Still travelling')
  })

  test('GET /history lists a returned parcel, labelled returned rather than archived, and keeps it out of the delivery stats', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RETURNED1', label: 'Sent back one', source: 'manual' })
    updateParcelState(db, id, { status: 'returned' })
    const body = (await get(db, '/history')).body
    expect(body).toContain('Sent back one')
    expect(body).toMatch(/returned · /)
    expect(body).not.toMatch(/archived · /)
    expect(body).toContain('no deliveries yet')
  })

  test('GET /history?carrier=posta filters by carrier', async () => {
    const db = memDb()
    delivered(db, { carrier: 'posta', number: 'P1', label: 'From the post' })
    delivered(db, { carrier: 'gls', number: 'G1', label: 'From GLS' })
    const body = (await get(db, '/history?carrier=posta')).body
    expect(body).toContain('From the post')
    expect(body).not.toContain('From GLS')
  })

  test('GET /history?q=alza matches the merchant and the label', async () => {
    const db = memDb()
    delivered(db, { number: 'A1', merchant: 'Alza.sk', label: 'Keyboard' })
    delivered(db, { number: 'A2', merchant: 'Datart', label: 'Alza return' })
    delivered(db, { number: 'A3', merchant: 'Datart', label: 'Toaster' })
    const body = (await get(db, '/history?q=alza')).body
    expect(body).toContain('Keyboard')
    expect(body).toContain('Alza return')
    expect(body).not.toContain('Toaster')
  })

  test('GET /history reports a median delivery time per carrier', async () => {
    const db = memDb()
    // posta: 6h, 12h, 100h -> median 12h. gls: 24h and 72h -> mean of the middle two, 48h = 2.0 days.
    for (const [i, h] of [6, 12, 100].entries()) delivered(db, { carrier: 'posta', number: `P${i}`, spanHours: h })
    for (const [i, h] of [24, 72].entries()) delivered(db, { carrier: 'gls', number: `G${i}`, spanHours: h })
    const body = (await get(db, '/history')).body
    const row = (name: string) => body.slice(body.indexOf(`data-carrier="${name}"`)).split('</tr>')[0]!
    expect(row('posta')).toContain('12 hours')
    expect(row('posta')).toContain('n = 3 of 3')
    expect(row('gls')).toContain('2.0 days')
  })

  test('median: a carrier with no deliveries shows a dash, parcels without events are excluded and counted', async () => {
    const db = memDb()
    delivered(db, { carrier: 'packeta', number: 'K1', spanHours: 30 })
    delivered(db, { carrier: 'packeta', number: 'K2', spanHours: null })   // flipped to delivered with no event
    const res = await get(db, '/history')
    expect(res.statusCode).toBe(200)
    const row = (name: string) => res.body.slice(res.body.indexOf(`data-carrier="${name}"`)).split('</tr>')[0]!
    expect(row('packeta')).toContain('30 hours')
    expect(row('packeta')).toContain('n = 1 of 2')
    expect(row('dpd')).toContain('—')
    expect(row('dpd')).toContain('no deliveries yet')
    expect(row('dpd')).not.toMatch(/\b0 hours\b/)
  })

  test('GET /history renders cleanly on an empty database', async () => {
    const res = await get(memDb(), '/history')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('No delivered, returned or archived parcels')
  })

  test('formatDuration: whole hours under 48h, one-decimal days beyond', () => {
    const h = 3_600_000
    expect(formatDuration(0.3 * h)).toBe('under 1 hour')
    expect(formatDuration(1 * h)).toBe('1 hour')
    expect(formatDuration(6.4 * h)).toBe('6 hours')
    expect(formatDuration(43 * h)).toBe('43 hours')
    expect(formatDuration(47.6 * h)).toBe('2.0 days')
    expect(formatDuration(43.2 * h * 1.0 + 24 * h)).toBe('2.8 days')
  })

  test('GET /health shows each carrier with last-ok and consecutive failures', async () => {
    const db = memDb()
    recordHealth(db, 'posta', 'ok', undefined, new Date('2026-10-26T09:00:00Z'))
    recordHealth(db, 'dpd', 'transport', 'timeout after 15000ms', new Date('2026-10-26T09:30:00Z'))
    recordHealth(db, 'dpd', 'transport', 'timeout after 15000ms', new Date('2026-10-26T09:45:00Z'))
    const body = (await get(db, '/health')).body
    for (const name of ['Slovenská pošta', 'Packeta', 'GLS', 'SPS', 'DPD']) expect(body).toContain(name)
    const row = (id: string) => body.slice(body.indexOf(`data-carrier="${id}"`)).split('</tr>')[0]!
    expect(row('posta')).toContain('Mon 26 Oct, 10:00')   // 09:00Z, shown in Bratislava
    expect(row('dpd')).toContain('timeout after 15000ms')
    expect(row('dpd')).toMatch(/>\s*2\s*</)
    expect(row('gls')).toContain('never')
  })

  test('GET /health marks a carrier with a gated error as needing attention', async () => {
    const db = memDb()
    recordHealth(db, 'gls', 'gated', 'endpoint closed')
    recordHealth(db, 'sps', 'transport', 'timeout')
    recordHealth(db, 'posta', 'ok')
    const body = (await get(db, '/health')).body
    const row = (id: string) => body.slice(body.indexOf(`data-carrier="${id}"`)).split('</tr>')[0]!
    expect(row('gls')).toContain('needs attention')
    expect(row('sps')).not.toContain('needs attention')
    expect(row('posta')).not.toContain('needs attention')
  })

  test('GET /attention lists unparsed messages with subject and sender', async () => {
    const db = memDb()
    const ins = db.prepare('INSERT INTO messages (message_id, received_at, from_addr, subject, parsed_ok, parse_note) VALUES (?, ?, ?, ?, ?, ?)')
    ins.run('<a@x>', '2026-10-25T08:00:00Z', 'shop@example.com', 'Your order <b>shipped</b>', 0, 'no tracking number found')
    ins.run('<b@x>', '2026-10-25T09:00:00Z', 'ok@example.com', 'Parsed fine', 1, null)
    const body = (await get(db, '/attention')).body
    expect(body).toContain('shop@example.com')
    expect(body).toContain('Your order &lt;b&gt;shipped&lt;/b&gt;')
    expect(body).toContain('no tracking number found')
    expect(body).not.toContain('Parsed fine')
  })

  test('GET /attention lists dormant parcels, recomputed from the parcel rather than a column', async () => {
    const db = memDb()
    const old = insertParcel(db, { carrier: 'posta', trackingNumber: 'DORMANT1', label: 'Never moved', source: 'manual' })
    const fresh = insertParcel(db, { carrier: 'posta', trackingNumber: 'FRESH1', label: 'Just added', source: 'manual' })
    db.prepare('UPDATE parcels SET first_seen_at = ? WHERE id = ?').run(new Date(NOW.getTime() - 40 * DAY).toISOString(), old)
    db.prepare('UPDATE parcels SET first_seen_at = ? WHERE id = ?').run(new Date(NOW.getTime() - 2 * DAY).toISOString(), fresh)
    const body = (await get(db, '/attention')).body
    expect(body).toContain('Never moved')
    expect(body).not.toContain('Just added')
  })

  test('POST /add creates a parcel and redirects to its detail page', async () => {
    const db = memDb()
    const res = await post(db, '/add', { number: 'ra 123 456 785 sk', label: 'Gift', postcode: '' })
    expect(res.statusCode).toBe(303)
    const p = findParcel(db, 'posta', 'RA123456785SK')!
    expect(res.headers.location).toBe(`/parcel/${p.id}`)
    expect(p.label).toBe('Gift')
    expect(p.source).toBe('manual')
    expect(p.postalCode).toBe(config.defaultPostalCode)
  })

  test('POST /add rejects a duplicate with a 409 and a readable message', async () => {
    const db = memDb()
    await post(db, '/add', { number: 'RA123456785SK' })
    const res = await post(db, '/add', { number: 'RA123456785SK' })
    expect(res.statusCode).toBe(409)
    expect(res.body).toMatch(/already tracking/i)
    expect(res.headers['content-type']).toContain('text/html')
  })

  test('POST /add reports an undetectable or unknown carrier, escaping what was typed', async () => {
    const db = memDb()
    const unknown = await post(db, '/add', { number: '<script>x</script>' })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.body).not.toContain('<script>x')
    expect((await post(db, '/add', { number: 'RA123456785SK', carrier: 'fedex' })).statusCode).toBe(400)
    expect((await post(db, '/add', { number: '' })).statusCode).toBe(400)
  })

  test('POST /parcel/:id/label updates the label', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', label: 'Old', source: 'manual' })
    const res = await post(db, `/parcel/${id}/label`, { label: '  New name ' })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`/parcel/${id}`)
    expect(getParcel(db, id)!.label).toBe('New name')
    expect((await post(db, '/parcel/999/label', { label: 'x' })).statusCode).toBe(404)
  })

  test('POST /parcel/:id/postcode changes the postcode and makes a rejected parcel askable again', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'gls', trackingNumber: '123456789012', postalCode: '99999', source: 'manual' })
    setNeedsPostcode(db, id, '99999')
    const res = await post(db, `/parcel/${id}/postcode`, { postcode: ' 811 01 ' })
    expect(res.statusCode).toBe(303)
    const p = getParcel(db, id)!
    expect(p.postalCode).toBe('81101')
    expect(p.needsPostcode).toBe('99999')   // cleared by the poller when it next sends the parcel, not here
  })

  test('POST /attention/:messageId/assign turns an unparsed message into a parcel', async () => {
    const db = memDb()
    const info = db.prepare('INSERT INTO messages (message_id, from_addr, subject, parsed_ok) VALUES (?, ?, ?, 0)')
      .run('<m1@x>', 'shop@example.com', 'Shipped')
    const messageId = Number(info.lastInsertRowid)
    const res = await post(db, `/attention/${messageId}/assign`, { number: 'RA123456785SK', label: 'From mail' })
    expect(res.statusCode).toBe(303)
    const p = findParcel(db, 'posta', 'RA123456785SK')!
    expect(res.headers.location).toBe(`/parcel/${p.id}`)
    expect(p.source).toBe('email')
    expect(p.sourceMessageId).toBe('<m1@x>')
    const msg = db.prepare('SELECT parsed_ok, parcel_id FROM messages WHERE id = ?').get(messageId)
    expect(msg).toEqual({ parsed_ok: 1, parcel_id: p.id })
    expect((await get(db, '/attention')).body).not.toContain('Shipped')
    expect((await post(db, '/attention/999/assign', { number: 'RA123456785SK' })).statusCode).toBe(404)
  })

  test('POST /refresh triggers a poll of the given parcel only', async () => {
    const db = memDb()
    const a = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', label: 'A', source: 'manual' })
    insertParcel(db, { carrier: 'posta', trackingNumber: 'RR2', label: 'B', source: 'manual' })
    const adapter = stubAdapter('posta', inputs => inputs.map(i => okResult(i.number, [ev('x', 'in_transit')])), 100)
    const res = await post(db, '/refresh', { parcel: String(a) }, { adapters: [adapter], http: bodyHttp() })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toMatch(new RegExp(`^/parcel/${a}\\?refreshed=1`))
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]!.map(i => i.number)).toEqual(['RR1'])
    expect(getParcel(db, a)!.status).toBe('in_transit')
  })

  test('POST /refresh without a parcel polls everything due, and an unknown parcel is a 404', async () => {
    const db = memDb()
    insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', source: 'manual' })
    insertParcel(db, { carrier: 'posta', trackingNumber: 'RR2', source: 'manual' })
    const adapter = stubAdapter('posta', inputs => inputs.map(i => okResult(i.number, [ev('x', 'in_transit')])), 100)
    const res = await post(db, '/refresh', {}, { adapters: [adapter], http: bodyHttp() })
    expect(res.headers.location).toMatch(/^\/\?refreshed=2/)
    expect(adapter.calls[0]!.map(i => i.number)).toEqual(['RR1', 'RR2'])
    expect((await post(db, '/refresh', { parcel: '999' }, { adapters: [adapter] })).statusCode).toBe(404)
  })

  test('POST /refresh keeps the throttles: a gated carrier inside its backoff window is not queried', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'gls', trackingNumber: '123456789012', source: 'manual' })
    recordHealth(db, 'gls', 'gated', 'endpoint closed', new Date(NOW.getTime() - 60_000))
    const adapter = stubAdapter('gls', inputs => inputs.map(i => okResult(i.number, [])))
    const res = await post(db, '/refresh', { parcel: String(id) }, { adapters: [adapter], http: bodyHttp() })
    expect(adapter.calls).toHaveLength(0)
    expect(res.headers.location).toMatch(/refreshed=0/)
    // ...and a parcel whose postcode was rejected is not asked again either.
    const db2 = memDb()
    const id2 = insertParcel(db2, { carrier: 'gls', trackingNumber: '123456789012', postalCode: '99999', source: 'manual' })
    setNeedsPostcode(db2, id2, '99999')
    const adapter2 = stubAdapter('gls', inputs => inputs.map(i => okResult(i.number, [])))
    await post(db2, '/refresh', { parcel: String(id2) }, { adapters: [adapter2], http: bodyHttp() })
    expect(adapter2.calls).toHaveLength(0)
  })

  test('POST /refresh announces the status transition it discovers', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', label: 'Boots', source: 'manual' })
    const sent: Notification[] = []
    const adapter = stubAdapter('posta', inputs => inputs.map(i => okResult(i.number, [ev('x', 'out_for_delivery')])))
    await post(db, '/refresh', { parcel: String(id) }, {
      adapters: [adapter], http: bodyHttp(), notifier: { send: async n => { sent.push(n) } },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.title).toContain('Boots')
  })

  test('cross-origin POSTs are refused', async () => {
    const db = memDb()
    const res = await server(db).inject({
      method: 'POST', url: '/add', ...form({ number: 'RA123456785SK' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
    })
    expect(res.statusCode).toBe(403)
    expect(findParcel(db, 'posta', 'RA123456785SK')).toBeUndefined()
  })
})

describe('web pages: fix round 1', () => {
  const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()
  /** A parcel the backoff tiers would NOT poll now: moved 5 days ago, last polled an hour ago. */
  function quiet(db: Database, number: string): number {
    const id = insertParcel(db, { carrier: 'posta', trackingNumber: number, source: 'manual' })
    db.prepare("UPDATE parcels SET status = 'in_transit', first_seen_at = ?, last_changed_at = ?, last_polled_at = ?, last_attempted_at = ? WHERE id = ?")
      .run(iso(6 * DAY), iso(5 * DAY), iso(3_600_000), iso(3_600_000), id)
    return id
  }
  const polled = (adapter: { calls: { number: string }[][] }) => adapter.calls.flat().map(i => i.number)
  const answer = () => stubAdapter('posta', inputs => inputs.map(i => okResult(i.number, [ev('x', 'in_transit')])), 100)

  test('the per-parcel refresh polls a parcel the backoff tiers would skip', async () => {
    const db = memDb()
    const id = quiet(db, 'RA1')
    const adapter = answer()
    const res = await post(db, '/refresh', { parcel: String(id) }, { adapters: [adapter], http: bodyHttp() })
    expect(polled(adapter)).toEqual(['RA1'])
    expect(res.headers.location).toMatch(/refreshed=1/)
  })

  test('the global refresh forces quiet parcels but leaves dormant and just-attempted ones alone', async () => {
    const db = memDb()
    quiet(db, 'QUIET')
    const dormant = insertParcel(db, { carrier: 'posta', trackingNumber: 'DORMANT', source: 'manual' })
    db.prepare('UPDATE parcels SET first_seen_at = ? WHERE id = ?').run(iso(40 * DAY), dormant)
    const justTried = quiet(db, 'JUSTTRIED')
    db.prepare('UPDATE parcels SET last_attempted_at = ? WHERE id = ?').run(iso(10_000), justTried)
    insertParcel(db, { carrier: 'posta', trackingNumber: 'FRESH', source: 'manual' })
    const adapter = answer()
    await post(db, '/refresh', {}, { adapters: [adapter], http: bodyHttp() })
    expect(polled(adapter).sort()).toEqual(['FRESH', 'QUIET'])
  })

  test('a forced per-parcel refresh still honours the needs_postcode skip', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'gls', trackingNumber: '123456789012', postalCode: '99999', source: 'manual' })
    setNeedsPostcode(db, id, '99999')
    const adapter = stubAdapter('gls', inputs => inputs.map(i => okResult(i.number, [])))
    const res = await post(db, '/refresh', { parcel: String(id) }, { adapters: [adapter], http: bodyHttp() })
    expect(adapter.calls).toHaveLength(0)
    expect(res.headers.location).toMatch(/refreshed=0/)
  })

  test('delivered, returned and archived parcels get no refresh button', async () => {
    const db = memDb()
    const live = insertParcel(db, { carrier: 'posta', trackingNumber: 'LIVE', source: 'manual' })
    const done = delivered(db, { number: 'DONE' })
    const archived = insertParcel(db, { carrier: 'posta', trackingNumber: 'ARCH', source: 'manual' })
    db.prepare('UPDATE parcels SET archived_at = ? WHERE id = ?').run(NOW.toISOString(), archived)
    expect((await get(db, `/parcel/${live}`)).body).toContain('Refresh this parcel')
    expect((await get(db, `/parcel/${done}`)).body).not.toContain('Refresh this parcel')
    expect((await get(db, `/parcel/${archived}`)).body).not.toContain('Refresh this parcel')
  })

  test('repeated or invalid query keys on /history are tolerated, not a 500', async () => {
    const db = memDb()
    delivered(db, { carrier: 'posta', number: 'P1', label: 'First' })
    delivered(db, { carrier: 'gls', number: 'G1', label: 'Second' })
    for (const url of ['/history?q=a&q=b', '/history?carrier=posta&carrier=gls', '/history?from=x&from=y&to=1&to=2', '/history?carrier=nope']) {
      expect((await get(db, url)).statusCode, url).toBe(200)
    }
    const body = (await get(db, '/history?carrier=posta&carrier=gls')).body   // the first value wins
    expect(body).toContain('First')
    expect(body).not.toContain('Second')
    expect((await get(db, '/?refreshed=1&refreshed=2&failures=3&failures=4')).statusCode).toBe(200)
  })

  test('POST /add validates auto-detection, and caps field lengths', async () => {
    const db = memDb()
    const undetected = await post(db, '/add', { number: 'garbage 123' })
    expect(undetected.statusCode).toBe(400)
    expect(undetected.body).toMatch(/Could not tell which carrier GARBAGE123 belongs to/)
    expect((await post(db, '/add', { number: 'RA123456785SK', carrier: 'nope' })).statusCode).toBe(400)
    expect((await post(db, '/add', { number: 'A'.repeat(500), carrier: 'packeta' })).statusCode).toBe(400)
    expect((await post(db, '/add', { number: 'A'.repeat(45) })).statusCode).toBe(400)
    const ok = await post(db, '/add', { number: 'RA123456785SK', carrier: 'posta', label: 'L'.repeat(500), postcode: '1'.repeat(50) })
    expect(ok.statusCode).toBe(303)
    const p = findParcel(db, 'posta', 'RA123456785SK')!
    expect(p.label).toHaveLength(200)
    expect(p.postalCode).toHaveLength(12)
  })

  test('an explicit carrier overrides the shape check, as in cli add --carrier', async () => {
    const db = memDb()
    expect(getAdapter('posta').matches('GARBAGE123')).toBe(false)   // precondition: it really fails the shape check
    const res = await post(db, '/add', { number: 'garbage 123', carrier: 'posta' })
    expect(res.statusCode).toBe(303)
    expect(findParcel(db, 'posta', 'GARBAGE123')).toBeDefined()
  })

  test('/assign applies the same rules: undetectable is rejected, an explicit carrier overrides', async () => {
    const db = memDb()
    const id = Number(db.prepare('INSERT INTO messages (message_id, subject, parsed_ok) VALUES (?, ?, 0)').run('<z@x>', 'Hi').lastInsertRowid)
    const res = await post(db, `/attention/${id}/assign`, { number: 'garbage 123' })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('Could not tell which carrier')
    expect(db.prepare('SELECT parcel_id FROM messages WHERE id = ?').get(id)).toEqual({ parcel_id: null })
    expect((await post(db, `/attention/${id}/assign`, { number: 'garbage 123', carrier: 'sps' })).statusCode).toBe(303)
    expect(findParcel(db, 'sps', 'GARBAGE123')).toBeDefined()
  })

  test('a 5xx is logged to stderr, not swallowed, and the page stays generic', async () => {
    const db = memDb()
    const app = server(db)
    db.close()   // every query now throws
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.inject({ method: 'GET', url: '/' })
      expect(res.statusCode).toBe(500)
      expect(res.body).toBe('internal error')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0]![0])).toContain('GET /')
      expect(spy.mock.calls[0]![1]).toBeInstanceOf(Error)
    } finally {
      spy.mockRestore()
    }
  })

  test('every response, including a refusal, carries the CSP and nosniff headers', async () => {
    const app = server(memDb())
    const ok = await app.inject({ method: 'GET', url: '/' })
    const refused = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })
    for (const res of [ok, refused]) {
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    }
  })

  test('a write must come from this very server: same host and port only', async () => {
    const db = memDb()
    const attempt = (headers: Record<string, string>) => server(db).inject({
      method: 'POST', url: '/add', payload: 'number=RA123456785SK',
      headers: { 'content-type': 'application/x-www-form-urlencoded', host: '127.0.0.1:8787', ...headers },
    })
    expect((await attempt({ origin: 'http://127.0.0.1:8787' })).statusCode).toBe(303)         // this server
    expect((await attempt({ origin: 'http://localhost:3000' })).statusCode).toBe(403)         // another dev server on localhost
    expect((await attempt({ origin: 'http://127.0.0.1:9999' })).statusCode).toBe(403)         // same host, other port
    expect((await attempt({ origin: 'null' })).statusCode).toBe(403)                          // sandboxed/opaque origin
    expect((await attempt({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403)
    expect((await attempt({ 'sec-fetch-site': 'same-site' })).statusCode).toBe(403)           // a sibling port on localhost
    expect((await attempt({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(409)         // allowed; the parcel now exists
  })
})

// --- archived-on-arrival parcels stay queryable; mail ingest health --------------------------------

describe('archived parcels from old mail', () => {
  /** What the ingest leaves behind for 3-year-old mail: never polled (status unknown), archived, first seen at the mail's date. */
  function archivedOnArrival(db: Database, number: string, merchant: string, daysOld: number): number {
    const id = insertParcel(db, {
      carrier: 'packeta', trackingNumber: number, merchant, source: 'email',
      firstSeenAt: new Date(NOW.getTime() - daysOld * DAY),
    })
    setArchived(db, id, NOW)
    return id
  }

  test('GET /history lists them, marked archived, newest first, mixed with delivered ones', async () => {
    const db = memDb()
    archivedOnArrival(db, 'Z0000000001', 'OldShopA', 400)
    archivedOnArrival(db, 'Z0000000002', 'OldShopB', 90)
    delivered(db, { number: 'DELIV', label: 'Delivered one', deliveredDaysAgo: 200 })
    const body = (await get(db, '/history')).body
    const at = ['OldShopB', 'Delivered one', 'OldShopA'].map(t => body.indexOf(t))
    expect(at.every(i => i >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))             // 90d, then 200d, then 400d
    expect(body).toMatch(/archived · /)
  })

  test('they are not "In flight", and the median delivery time is untouched', async () => {
    const db = memDb()
    archivedOnArrival(db, 'Z0000000001', 'OldShopA', 400)
    const home = (await get(db, '/')).body
    expect(home).not.toContain('OldShopA')
    const hist = (await get(db, '/history')).body
    const row = hist.slice(hist.indexOf('data-carrier="packeta"')).split('</tr>')[0]!
    expect(row).toContain('no deliveries yet')               // status stays unknown, so it is not a delivery
  })

  test('their status is never turned into "delivered"', async () => {
    const db = memDb()
    const id = archivedOnArrival(db, 'Z0000000001', 'OldShopA', 400)
    await get(db, '/history')
    expect(getParcel(db, id)!.status).toBe('unknown')
  })

  test('search and date filters apply to them (first-seen date stands in for the delivery date)', async () => {
    const db = memDb()
    archivedOnArrival(db, 'Z0000000001', 'OldShopA', 400)
    archivedOnArrival(db, 'Z0000000002', 'OldShopB', 90)
    expect((await get(db, '/history?q=oldshopa')).body).toContain('OldShopA')
    expect((await get(db, '/history?q=oldshopa')).body).not.toContain('OldShopB')
    const from = new Date(NOW.getTime() - 120 * DAY).toISOString().slice(0, 10)
    const body = (await get(db, `/history?from=${from}`)).body
    expect(body).toContain('OldShopB')
    expect(body).not.toContain('OldShopA')
  })

  test('the empty state names both kinds', async () => {
    expect((await get(memDb(), '/history')).body).toContain('No delivered, returned or archived parcels')
  })
})

describe('GET /health: mail ingest', () => {
  const webWith = (db: Database, imap?: Config['imap']) =>
    buildServer({ db, config: { ...config, imap }, now: () => NOW, notifier: { send: async () => {} } })
  const IMAP = { host: 'h', port: 993, user: 'u', pass: 'p', mailbox: 'parcels' }

  test('no mailbox configured and no history: the section is absent', async () => {
    const body = (await webWith(memDb()).inject({ method: 'GET', url: '/health' })).body
    expect(body).not.toContain('Mail ingest')
  })

  test('configured but never run: shows "no data"', async () => {
    const body = (await webWith(memDb(), IMAP).inject({ method: 'GET', url: '/health' })).body
    expect(body).toContain('Mail ingest')
    expect(body).toContain('no data')
  })

  test('shows failing, the last error and the streak', async () => {
    const db = memDb()
    recordIngest(db, { ok: true }, new Date('2026-10-26T09:00:00Z'))
    recordIngest(db, { ok: false, error: 'Invalid credentials (Failure)' }, new Date('2026-10-26T10:00:00Z'))
    recordIngest(db, { ok: false, error: 'Invalid credentials (Failure)' }, new Date('2026-10-26T11:00:00Z'))
    const body = (await webWith(db, IMAP).inject({ method: 'GET', url: '/health' })).body
    const section = body.slice(body.indexOf('id="ingest-health"')).split('</table>')[0]!
    expect(section).toContain('failing')
    expect(section).toContain('Invalid credentials (Failure)')
    expect(section).toContain('Mon 26 Oct, 10:00')                 // last ok, in Bratislava time
    expect(section).toMatch(/>\s*2\s*</)
  })

  test('a healthy ingest shows ok', async () => {
    const db = memDb()
    recordIngest(db, { ok: true }, NOW)
    const body = (await webWith(db, IMAP).inject({ method: 'GET', url: '/health' })).body
    expect(body.slice(body.indexOf('id="ingest-health"')).split('</table>')[0]).toContain('<span>ok</span>')
  })
})
