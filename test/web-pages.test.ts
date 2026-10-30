import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeImap } from './imap-fake.js'
import { listActive } from '../src/db/parcels.js'
import { describe, expect, test, vi } from 'vitest'
import { buildServer, refreshIdle, type WebDeps } from '../src/web/server.js'
import { finishRun, getRun, startRun, type RunCounts } from '../src/db/poll-runs.js'
import { appendEvents } from '../src/db/events.js'
import { recordHealth } from '../src/db/health.js'
import { recordIngest } from '../src/db/ingest-status.js'
import { recordPickupCode } from '../src/db/pickup-codes.js'
import type { Config } from '../src/core/config.js'
import { findParcel, getParcel, insertParcel, setArchived, setNeedsPostcode, updateParcelState } from '../src/db/parcels.js'
import type { Database } from '../src/db/index.js'
import type { CanonicalStatus, CarrierId, PickupPoint } from '../src/core/types.js'
import type { Notification } from '../src/notify/types.js'
import { getAdapter } from '../src/carriers/registry.js'
import { appVersion } from '../src/core/version.js'
import { formatDateTime, formatDuration } from '../src/web/views/format.js'
import { STYLE } from '../src/web/views/style.js'
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

const JUNK_SUBJECT = 'Verification of your e-mail in the Packeta app'

/** A stored message the ingest could not turn into a parcel: the needs-attention case. */
const junkMail = (db: Database, messageId = '<junk@x>', subject = JUNK_SUBJECT): number =>
  Number(db.prepare(`
    INSERT INTO messages (message_id, received_at, from_addr, subject, raw_path, parsed_ok, parse_note)
    VALUES (?, ?, 'noreply@packeta.com', ?, '/tmp/junk.eml', 0, 'no tracking number found in this message')
  `).run(messageId, new Date(NOW.getTime() - 3_600_000).toISOString(), subject).lastInsertRowid)

const form = (fields: Record<string, string>) => ({
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
})

/** The default notifier would launch a real banner, so every server here gets a silent one unless the test supplies its own. */
const server = (db: Database, extra: Partial<WebDeps> = {}) =>
  buildServer({ db, config, now: () => NOW, notifier: { send: async () => {} }, ...extra })
const get = (db: Database, url: string) => server(db).inject({ method: 'GET', url })
/**
 * A POST, and then the background work it started. `POST /refresh` returns a redirect before its poll
 * has finished, so a test that asserts on what the poll DID has to wait for it; `refreshIdle` is the
 * same hook the server's own `onClose` uses.
 */
const post = async (db: Database, url: string, fields: Record<string, string>, extra: Partial<WebDeps> = {}) => {
  const app = server(db, extra)
  const res = await app.inject({ method: 'POST', url, ...form(fields) })
  await refreshIdle(app)
  return res
}

/** Where a `/refresh` redirect points, with the run id it carries resolved to the finished run row. */
const refreshedRun = (db: Database, res: { headers: Record<string, unknown> }) => {
  const location = String(res.headers.location)
  const id = /[?&]run=(\d+)/.exec(location)?.[1]
  return { location, run: id === undefined ? undefined : getRun(db, Number(id)) }
}

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

  test('GET /history lists a returned parcel, marked Returned rather than archived, and keeps it out of the delivery stats', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RETURNED1', label: 'Sent back one', source: 'manual' })
    updateParcelState(db, id, { status: 'returned' })
    const body = (await get(db, '/history')).body
    expect(body).toContain('Sent back one')
    const row = body.slice(body.indexOf('Sent back one')).split('</tr>')[0]!
    expect(row).toContain('Returned')           // the Outcome column says so
    expect(body).toMatch(/1 returned/)          // and the lede counts it as returned
    expect(body).not.toMatch(/archived/i)       // never as archived
    expect(body).not.toContain('n = ')           // and it times nothing
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
    // posta: 6h, 12h, 100h -> median 12h. gls: 24h, 72h, 30h, 40h -> mean of the middle two, 35h.
    for (const [i, h] of [6, 12, 100].entries()) delivered(db, { carrier: 'posta', number: `P${i}`, spanHours: h })
    for (const [i, h] of [24, 72, 30, 40].entries()) delivered(db, { carrier: 'gls', number: `G${i}`, spanHours: h })
    const body = (await get(db, '/history')).body
    const row = (name: string) => body.slice(body.indexOf(`data-carrier="${name}"`)).split('</tr>')[0]!
    expect(row('posta')).toContain('12 hours')
    expect(row('posta')).toContain('n = 3 of 3')
    expect(row('gls')).toContain('35 hours')
  })

  test('median: a carrier timed on fewer than 3 parcels is left out of the table, and the page says why', async () => {
    // One or two deliveries say more about those parcels than about the carrier: "30 hours, n = 1" and
    // "no deliveries yet" beside a carrier with dozens of archived parcels both mislead.
    const db = memDb()
    delivered(db, { carrier: 'packeta', number: 'K1', spanHours: 30 })
    delivered(db, { carrier: 'packeta', number: 'K2', spanHours: null })   // flipped to delivered with no event
    for (const [i, h] of [6, 12, 100].entries()) delivered(db, { carrier: 'posta', number: `P${i}`, spanHours: h })
    const res = await get(db, '/history')
    expect(res.statusCode).toBe(200)
    const median = res.body.slice(res.body.indexOf('<h2>Median delivery time</h2>'))
    expect(median).toContain('data-carrier="posta"')
    expect(median).not.toContain('data-carrier="packeta"')
    expect(median).not.toContain('30 hours')
    expect(median).not.toContain('data-carrier="dpd"')
    expect(median).not.toContain('no deliveries yet')
    expect(median).toMatch(/Not enough deliveries yet to time [^<]*Packeta[^<]*: a median needs at least 3/)
  })

  test('median: with no carrier timed on 3 parcels there is no table at all, only the sentence', async () => {
    const db = memDb()
    delivered(db, { carrier: 'packeta', number: 'K1', spanHours: 30 })
    const median = (await get(db, '/history')).body.slice((await get(db, '/history')).body.indexOf('<h2>Median delivery time</h2>'))
    expect(median).not.toContain('<table')
    expect(median).toMatch(/Not enough deliveries yet/)
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

  test('Dismiss lands on the email that takes its place (or the one before the last), not back at the top', async () => {
    const db = memDb()
    for (const n of [1, 2, 3]) junkMail(db, `<junk${n}@x>`, `Junk ${n}`)
    const body = (await get(db, '/attention')).body
    const order = [...body.matchAll(/<div class="item" id="m-(\d+)">/g)].map(m => m[1]!)
    expect(order).toHaveLength(3)
    const lands = (id: string) => new RegExp(`action="/attention/${id}/dismiss([^"]*)"`).exec(body)![1]
    expect(order.map(lands)).toEqual([`#m-${order[1]}`, `#m-${order[2]}`, `#m-${order[1]}`])
    // The one email left: nothing to land on, so the top.
    const one = memDb()
    const only = junkMail(one)
    expect((await get(one, '/attention')).body).toContain(`action="/attention/${only}/dismiss">`)
  })

  test('GET /attention offers Dismiss in a form of its own, secondary to Assign', async () => {
    const db = memDb()
    const id = junkMail(db)
    const body = (await get(db, '/attention')).body
    const assign = body.indexOf(`action="/attention/${id}/assign#m-${id}"`)
    const dismiss = body.indexOf(`action="/attention/${id}/dismiss`)
    expect(assign).toBeGreaterThan(-1)
    expect(dismiss).toBeGreaterThan(-1)
    // A second button INSIDE the assign form would submit the assign fields, so the dismiss form
    // must open after the assign form has closed.
    expect(dismiss).toBeGreaterThan(body.indexOf('</form>', assign))
    const dismissForm = body.slice(body.lastIndexOf('<form', dismiss), body.indexOf('</form>', dismiss))
    expect(dismissForm).toContain('Dismiss')
    expect(dismissForm).toContain('method="post"')
    expect(dismissForm).not.toContain('class="pri"')   // never competes with Assign (design-language §6.7)
    expect(dismissForm).not.toContain('name="number"') // and carries no assign field
  })

  test('each email\'s assign form is folded away until asked for; Dismiss stays in sight', async () => {
    // 57 emails each with a four-field form was a wall of inputs (85 KB). One line each, until opened.
    const db = memDb()
    const a = junkMail(db, '<a@x>', 'First junk')
    const b = junkMail(db, '<b@x>', 'Second junk')
    const body = (await get(db, '/attention')).body
    for (const id of [a, b]) {
      const fold = body.lastIndexOf('<details class="asg"><summary>Assign to a parcel…</summary>', body.indexOf(`action="/attention/${id}/assign#m-${id}"`))
      expect(fold, String(id)).toBeGreaterThan(-1)
      const closes = body.indexOf('</details>', fold)
      expect(body.indexOf(`action="/attention/${id}/assign#m-${id}"`)).toBeLessThan(closes)       // the form is inside
      expect(body.indexOf(`action="/attention/${id}/dismiss`)).toBeGreaterThan(closes)   // Dismiss is not
    }
    expect(body).not.toContain('<details class="asg" open>')
  })

  test('an assign that was refused re-opens that email\'s form, with the error and what was typed', async () => {
    const db = memDb()
    const id = Number(db.prepare('INSERT INTO messages (message_id, subject, parsed_ok) VALUES (?, ?, 0)').run('<z@x>', 'Hi').lastInsertRowid)
    junkMail(db, '<other@x>', 'Another')
    const res = await post(db, `/attention/${id}/assign`, { number: 'garbage 123' })
    expect(res.statusCode).toBe(400)
    const open = res.body.indexOf('<details class="asg" open>')
    expect(open).toBeGreaterThan(-1)
    expect(res.body.indexOf(`action="/attention/${id}/assign#m-${id}"`)).toBeGreaterThan(open)
    expect(res.body.match(/<details class="asg" open>/g)).toHaveLength(1)
    expect(res.body).toContain('value="garbage 123"')
  })

  test('POST /attention/:messageId/dismiss clears the item from the list and prunes its stored copy', async () => {
    const db = memDb()
    const id = junkMail(db)
    const eml = join(mkdtempSync(join(tmpdir(), 'parcels-dismiss-')), 'junk.eml')
    writeFileSync(eml, 'From: noreply@packeta.com\r\n\r\nbody\r\n')
    db.prepare('UPDATE messages SET raw_path = ? WHERE id = ?').run(eml, id)

    const res = await post(db, `/attention/${id}/dismiss`, {})
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/attention')
    // parsed_ok = 1 with no parcel: out of /attention and out of every future reprocess run. Nothing
    // will ever read the .eml again, so it goes, and the path goes with it.
    expect(db.prepare('SELECT parsed_ok, parcel_id, parse_note, raw_path FROM messages WHERE id = ?').get(id))
      .toMatchObject({ parsed_ok: 1, parcel_id: null, parse_note: 'Dismissed', raw_path: null })
    expect(existsSync(eml)).toBe(false)
    expect((await get(db, '/attention')).body).not.toContain(JUNK_SUBJECT)
    expect(db.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 1 })   // the row is never deleted
  })

  test('dismissing twice, dismissing an assigned message, or an unknown id is a 404 rather than a surprise', async () => {
    const db = memDb()
    const id = junkMail(db)
    expect((await post(db, `/attention/${id}/dismiss`, {})).statusCode).toBe(303)
    expect((await post(db, `/attention/${id}/dismiss`, {})).statusCode).toBe(404)   // stale page / double submit
    expect((await post(db, '/attention/999/dismiss', {})).statusCode).toBe(404)
    expect((await post(db, '/attention/not-a-number/dismiss', {})).statusCode).toBe(404)

    const assigned = junkMail(db, '<m2@x>', 'Shipped')
    const parcel = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR9', source: 'email' })
    db.prepare('UPDATE messages SET parsed_ok = 1, parcel_id = ? WHERE id = ?').run(parcel, assigned)
    expect((await post(db, `/attention/${assigned}/dismiss`, {})).statusCode).toBe(404)
    expect(db.prepare('SELECT parcel_id FROM messages WHERE id = ?').get(assigned)).toEqual({ parcel_id: parcel })
  })

  test('GET /parcel/:id puts Delete behind a disclosure, below the content, with the consequence spelled out', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', label: 'Doomed', source: 'manual' })
    appendEvents(db, id, [ev('scan', 'in_transit')])
    const body = (await get(db, `/parcel/${id}`)).body
    const del = body.indexOf(`action="/parcel/${id}/delete"`)
    expect(del).toBeGreaterThan(-1)
    expect(body.lastIndexOf('<details', del)).toBeGreaterThan(-1)       // revealed, not sitting out in the open
    expect(del).toBeGreaterThan(body.indexOf('Timeline'))               // low on the page, not competing
    expect(body).toMatch(/tracking history are deleted for good/)       // what goes
    expect(body).toMatch(/emails it came from are kept/)                // and what stays
    expect(body).not.toMatch(/<script|onclick|confirm\(/i)              // the CSP ships zero JS
  })

  test('POST /parcel/:id/delete deletes the parcel and goes back to the in-flight list', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', label: 'Doomed', source: 'manual' })
    appendEvents(db, id, [ev('scan', 'in_transit')])
    const res = await post(db, `/parcel/${id}/delete`, {})
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/')
    expect(getParcel(db, id)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) n FROM events').get()).toEqual({ n: 0 })
    expect((await get(db, `/parcel/${id}`)).statusCode).toBe(404)
    expect((await post(db, `/parcel/${id}/delete`, {})).statusCode).toBe(404)
    expect((await post(db, '/parcel/999/delete', {})).statusCode).toBe(404)
  })

  test('an archived parcel, reachable from /history, can be deleted too', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', label: 'Old mail', source: 'email' })
    setArchived(db, id, new Date(NOW.getTime() - 5 * DAY))
    expect((await get(db, `/parcel/${id}`)).body).toContain(`action="/parcel/${id}/delete"`)
    expect((await post(db, `/parcel/${id}/delete`, {})).statusCode).toBe(303)
    expect(getParcel(db, id)).toBeUndefined()
  })

  test('POST /refresh triggers a poll of the given parcel only', async () => {
    const db = memDb()
    const a = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', label: 'A', source: 'manual' })
    insertParcel(db, { carrier: 'posta', trackingNumber: 'RR2', label: 'B', source: 'manual' })
    const adapter = stubAdapter('posta', inputs => inputs.map(i => okResult(i.number, [ev('x', 'in_transit')])), 100)
    const res = await post(db, '/refresh', { parcel: String(a) }, { adapters: [adapter], http: bodyHttp() })
    expect(res.statusCode).toBe(303)
    // The redirect names the run it started, not its result: the result is not known yet (see
    // test/refresh-async.test.ts). What it polled is read back off the recorded run.
    const { location, run } = refreshedRun(db, res)
    expect(location).toBe(`/parcel/${a}?run=${run!.id}`)
    expect(run!.polled).toBe(1)
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
    expect(res.headers.location).toMatch(/^\/\?run=\d+$/)
    expect(refreshedRun(db, res).run!.polled).toBe(2)
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
    expect(refreshedRun(db, res).run!.polled).toBe(0)
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
    expect(refreshedRun(db, res).run!.polled).toBe(1)
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
    expect(refreshedRun(db, res).run!.polled).toBe(0)
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

  test('a carrier filter naming an inherited object key is ignored like any other unknown carrier', async () => {
    const db = memDb()
    delivered(db, { carrier: 'posta', number: 'P1', label: 'First' })
    delivered(db, { carrier: 'gls', number: 'G1', label: 'Second' })
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const body = (await get(db, `/history?carrier=${key}`)).body
      expect(body, key).toContain('First')
      expect(body, key).toContain('Second')
      expect(body, key).not.toContain('match these filters')
    }
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
      expect(res.body).toContain('Something went wrong')
      expect(res.body).not.toMatch(/database connection|sqlite/i)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0]![0])).toContain('GET /')
      expect(spy.mock.calls[0]![1]).toBeInstanceOf(Error)
    } finally {
      spy.mockRestore()
    }
  })

  test('every response, including a refusal and a 404, carries the CSP, nosniff, framing and resource-policy headers', async () => {
    const app = server(memDb())
    const ok = await app.inject({ method: 'GET', url: '/' })
    const refused = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })
    const missing = await app.inject({ method: 'GET', url: '/no/such/page' })
    const tile = await app.inject({ method: 'GET', url: '/tile/16/1/1.png' })
    for (const res of [ok, refused, missing, tile]) {
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      // No other site may frame a page (clickjacking the Delete or Update buttons)...
      expect(res.headers['x-frame-options']).toBe('DENY')
      // ...or embed a response: an <img src=".../tile/..."> elsewhere would learn from onload which
      // tiles are cached, i.e. where this person collects their parcels.
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin')
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
    // Archived rows carry no mark (it is the default); the lede counts them and the delivered one is marked.
    expect(body).toMatch(/2 archived/)
    expect(body).toMatch(/1 delivered/)
    const row = (name: string) => body.slice(body.indexOf(name)).split('</tr>')[0]!
    expect(row('OldShopA')).not.toMatch(/Delivered|Returned/)
    // The Outcome cell is never blank: archived mail says so, in the quietest register there is.
    expect(row('OldShopA')).toMatch(/<span class="st t-3 quiet">[\s\S]*Archived<\/span>/)
    expect(row('Delivered one')).toContain('Delivered')
  })

  test('they are not "In flight", and the median delivery time is untouched', async () => {
    const db = memDb()
    archivedOnArrival(db, 'Z0000000001', 'OldShopA', 400)
    const home = (await get(db, '/')).body
    expect(home).not.toContain('OldShopA')
    const hist = (await get(db, '/history')).body
    const median = hist.slice(hist.indexOf('<h2>Median delivery time</h2>'))
    expect(median).not.toContain('data-carrier="packeta"')    // status stays unknown, so it is not a delivery
    expect(median).not.toContain('n = ')
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

  test('both date filters say what they are', async () => {
    const body = (await get(memDb(), '/history')).body
    expect(body).toContain('<label>Date from<input type="date" name="from"')
    expect(body).toContain('<label>Date to<input type="date" name="to"')
  })

  test('the empty state names both kinds', async () => {
    expect((await get(memDb(), '/history')).body).toContain('No delivered, returned or archived parcels')
  })
})

describe('GET /health: an error the carrier has recovered from', () => {
  test('is de-emphasised as past when a later run was ok, and stays loud while it is still failing', async () => {
    const db = memDb()
    recordHealth(db, 'posta', 'transport', 'socket hang up', new Date('2026-10-26T08:00:00Z'))
    recordHealth(db, 'posta', 'ok', undefined, new Date('2026-10-26T09:00:00Z'))
    recordHealth(db, 'gls', 'transport', 'ETIMEDOUT', new Date('2026-10-26T08:00:00Z'))
    const body = (await get(db, '/health')).body
    const row = (id: string) => body.slice(body.indexOf(`data-carrier="${id}"`)).split('</tr>')[0]!
    expect(row('posta')).toContain('<td class="recovered">')
    expect(row('posta')).toMatch(/recovered/)
    expect(row('posta')).toContain('socket hang up')                 // still readable, for whoever asks
    expect(row('gls')).not.toContain('recovered')
    expect(row('gls')).toContain('ETIMEDOUT')
  })
})

describe('GET /health: mail ingest', () => {
  const webWith = (db: Database, imap?: Config['imap']) =>
    buildServer({ db, config: { ...config, imap }, now: () => NOW, notifier: { send: async () => {} } })
  const IMAP = { host: 'h', port: 993, user: 'u', pass: 'p', mailbox: 'parcels' }

  test('no mailbox configured: the row is still there, says "not set up", and links to Settings', async () => {
    const body = (await webWith(memDb()).inject({ method: 'GET', url: '/health' })).body
    const row = body.slice(body.indexOf('id="ingest-health"')).split('</tr>')[0]!
    expect(body).toContain('id="ingest-health"')
    expect(row).toContain('Mail ingest')
    expect(row).toMatch(/not set up<\/span>/)
    expect(row).toContain('<a href="/settings">')
    expect(row).not.toContain('class="bad"')                 // not set up is a fact, not a fault
    // ...and the lede does not call the app all well while no mail can arrive.
    const lede = /<p class="lede">([\s\S]*?)<\/p>/.exec(body)![1]!
    expect(lede).toMatch(/Gmail is not connected yet/)
  })

  test('a mail error that has since recovered is shown as past, not as the current state', async () => {
    const db = memDb()
    recordIngest(db, { ok: false, error: 'Connection timed out' }, new Date('2026-10-26T09:00:00Z'))
    recordIngest(db, { ok: true }, new Date('2026-10-26T10:00:00Z'))
    const body = (await webWith(db, IMAP).inject({ method: 'GET', url: '/health' })).body
    const row = body.slice(body.indexOf('id="ingest-health"')).split('</tr>')[0]!
    expect(row).toContain('<td class="recovered">')
    expect(row).toMatch(/recovered/)
    expect(row).toContain('Connection timed out')
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
    const section = body.slice(body.indexOf('id="ingest-health"')).split('</table>')[0]!
    expect(section).toMatch(/ok<\/span>/)
    expect(section).not.toContain('failing')
  })
})

// --- the running version, so a bug report can say which code it is about ----------------------------

describe('GET /health: version', () => {
  const health = (version?: string) =>
    server(memDb(), version === undefined ? {} : { version }).inject({ method: 'GET', url: '/health' })

  test('shows the version it was given', async () => {
    const r = await health('9.9.9 (deadbee)')
    expect(r.statusCode).toBe(200)
    expect(r.body.slice(r.body.indexOf('id="version"')).split('</p>')[0]).toContain('9.9.9 (deadbee)')
  })

  // The page that tells you what is broken must not break over its own footer.
  test('an unknown version renders the page anyway', async () => {
    const r = await health('unknown')
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('id="version"')
    expect(r.body.slice(r.body.indexOf('id="version"')).split('</p>')[0]).toContain('unknown')
    expect(r.body).toContain('Carriers')      // the rest of the page is still there
  })

  test('with nothing injected it is this checkout, resolved once at startup', async () => {
    const r = await health()
    expect(r.body).toContain(appVersion())
    expect(appVersion()).not.toBe('')
  })
})

// --- the index lede: it may only say "Nothing needs you." when the data can support it ----------------

describe('GET /: the lede', () => {
  /** The lede as read: its text, with any links reduced to their words. */
  const lede = async (db: Database) => {
    const body = (await get(db, '/')).body
    return body.match(/<p class="lede">([\s\S]*?)<\/p>/)?.[1]?.replace(/<[^>]+>/g, '')
  }
  const ledeMarkup = async (db: Database) => (await get(db, '/')).body.match(/<p class="lede">([\s\S]*?)<\/p>/)?.[1] ?? ''
  /** A parcel with a coded, known, unremarkable status: the quiet case the all-clear is for. */
  function moving(db: Database, number: string, carrier: CarrierId = 'posta'): number {
    const id = insertParcel(db, { carrier, trackingNumber: number, label: number, source: 'manual' })
    appendEvents(db, id, [ev('x', 'in_transit', 2, 'On the way')])
    updateParcelState(db, id, { status: 'in_transit', lastChangedAt: new Date(NOW.getTime() - 2 * 3_600_000) })
    return id
  }

  test('the all-clear is printed only for a quiet, classified, fully polled set', async () => {
    const db = memDb()
    moving(db, 'RR1')
    moving(db, 'RR2')
    expect(await lede(db)).toBe('2 in flight. Nothing needs you.')
  })

  test('a parcel waiting at a place is said first, and there is no all-clear', async () => {
    const db = memDb()
    const id = moving(db, 'RR1')
    updateParcelState(db, id, { status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    expect(await lede(db)).toBe('1 in flight, ready for pickup.')
  })

  test('the parcels that want something are counted INSIDE the in-flight total, never beside it', async () => {
    // "2 ready for pickup. 2 in flight." read as four parcels. The total comes first, once.
    const db = memDb()
    const a = moving(db, 'RR1')
    const b = moving(db, 'RR2')
    for (const id of [a, b]) updateParcelState(db, id, { status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    expect(await lede(db)).toBe('2 in flight, both ready for pickup.')
    const c = moving(db, 'RR3')
    expect(await lede(db)).toBe('3 in flight, 2 ready for pickup.')
    updateParcelState(db, c, { status: 'out_for_delivery' })
    expect(await lede(db)).toBe('3 in flight, 2 ready for pickup and 1 out for delivery.')
    updateParcelState(db, c, { status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    expect(await lede(db)).toBe('3 in flight, all ready for pickup.')
  })

  test('attention is counted the same way, with the verb agreeing', async () => {
    const db = memDb()
    const a = moving(db, 'RR1')
    updateParcelState(db, a, { status: 'failed_attempt' })
    expect(await lede(db)).toBe('1 in flight, and it needs attention.')
    moving(db, 'RR2')
    expect(await lede(db)).toBe('2 in flight, 1 needs attention.')
  })

  test('an uncoded prose status is "no status", never a calm all-clear', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z1', label: 'Prose', source: 'manual' })
    appendEvents(db, id, [{ ...ev('x', 'unknown', 3, 'Your parcel is on its way to you.'), code: undefined }])
    const text = await lede(db)
    expect(text).toBe('1 in flight. 1 has no status; read its latest message.')
    expect(text).not.toContain('Nothing needs you')
    // The carrier's own sentence is the status on the row: in the status slot, with no status word beside it.
    const body = (await get(db, '/')).body
    expect(body).toContain('class="ev prose">Your parcel is on its way to you.')
  })

  test('a parcel with no events is new, not unknown: it does not block the all-clear, and says so', async () => {
    const db = memDb()
    moving(db, 'RR1')
    insertParcel(db, { carrier: 'gls', trackingNumber: '123456789012', label: 'Brand new', source: 'manual' })
    expect(await lede(db)).toBe('2 in flight. Nothing needs you.')
    expect((await get(db, '/')).body).toContain('No updates yet')
  })

  test('a rejected postcode is said, and forfeits the all-clear (the poller never asks about it again)', async () => {
    const db = memDb()
    moving(db, 'RR1')
    const id = insertParcel(db, { carrier: 'gls', trackingNumber: '123456789012', postalCode: '99999', label: 'Stuck', source: 'manual' })
    setNeedsPostcode(db, id, '99999')
    const text = await lede(db)
    expect(text).toBe('2 in flight. 1 needs a postcode.')
    expect(text).not.toContain('Nothing needs you')
    expect((await get(db, '/')).body).toContain('Postcode needed')
  })

  test('a dormant parcel (no longer polled) is said, and forfeits the all-clear', async () => {
    const db = memDb()
    moving(db, 'RR1')
    const old = insertParcel(db, { carrier: 'posta', trackingNumber: 'OLD1', label: 'Silent for ages', source: 'manual' })
    db.prepare('UPDATE parcels SET first_seen_at = ? WHERE id = ?').run(new Date(NOW.getTime() - 40 * DAY).toISOString(), old)
    const text = await lede(db)
    expect(text).toBe('2 in flight. 1 is no longer polled (see Attention).')
  })

  test('a failing carrier it depends on is said, and forfeits the all-clear; an unrelated one is not', async () => {
    const db = memDb()
    moving(db, 'RR1', 'posta')
    recordHealth(db, 'dpd', 'transport', 'timeout')          // no DPD parcel in flight: irrelevant here
    expect(await lede(db)).toBe('1 in flight. Nothing needs you.')
    recordHealth(db, 'posta', 'transport', 'timeout')
    const text = await lede(db)
    expect(text).toBe('1 in flight. Slovenská pošta is failing, so this may be out of date.')
  })

  test('a poller that has stopped means every status may be stale: no all-clear', async () => {
    const db = memDb()
    moving(db, 'RR1')
    db.prepare('INSERT INTO last_poll (id, polled_at_ms) VALUES (1, ?)').run(NOW.getTime() - 30 * 3_600_000)
    const text = await lede(db)
    // Plain words and the time it last looked, not the name of a background process.
    const last = formatDateTime(new Date(NOW.getTime() - 30 * 3_600_000), NOW)
    expect(text).toBe(`1 in flight. Not checked since ${last}, so this may be out of date — see Health.`)
    expect(text).not.toMatch(/poller/i)
    expect(await ledeMarkup(db)).toContain('see <a href="/health">Health</a>.')
  })

  test('an empty page has no lede at all, not "0 in flight"', async () => {
    expect(await lede(memDb())).toBeUndefined()
  })

  // Persona finding A1: "3 in flight. Nothing needs you." while a pickup notice with a deadline sat on
  // /attention, unseen. Mail waiting there is something that needs you, so it is said, and it forfeits
  // the all-clear.
  test('mail waiting on Attention is said, links there, and forfeits the all-clear', async () => {
    const db = memDb()
    moving(db, 'RR1')
    moving(db, 'RR2')
    expect(await lede(db)).toBe('2 in flight. Nothing needs you.')
    junkMail(db)
    const text = await lede(db)
    expect(text).toBe('2 in flight. 1 email needs a look (see Attention).')
    expect(text).not.toContain('Nothing needs you')
    expect(await ledeMarkup(db)).toContain('(see <a href="/attention">Attention</a>)')
    junkMail(db, '<junk2@x>')
    expect(await lede(db)).toBe('2 in flight. 2 emails need a look (see Attention).')
  })

  test('dismissed or assigned mail is not counted: only what is still waiting', async () => {
    const db = memDb()
    moving(db, 'RR1')
    const id = junkMail(db)
    db.prepare('UPDATE messages SET parsed_ok = 1 WHERE id = ?').run(id)
    expect(await lede(db)).toBe('1 in flight. Nothing needs you.')
  })

  test('with nothing in flight, waiting mail still gets its line above the empty state', async () => {
    const db = memDb()
    junkMail(db)
    expect(await lede(db)).toBe('1 email needs a look (see Attention).')
    expect((await get(db, '/')).body).toContain('Nothing in flight.')
  })

  test('two parcels at one place share one card; what is bound to today comes before it', async () => {
    const db = memDb()
    for (const n of ['A1', 'A2']) {
      const id = insertParcel(db, { carrier: 'packeta', trackingNumber: n, label: `Parcel ${n}`, source: 'manual' })
      updateParcelState(db, id, { status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' }, lastChangedAt: new Date(NOW.getTime() - 3_600_000) })
    }
    const ofd = insertParcel(db, { carrier: 'gls', trackingNumber: '123456789012', label: 'On the van', source: 'manual' })
    updateParcelState(db, ofd, { status: 'out_for_delivery' })
    const body = (await get(db, '/')).body
    expect(body.match(/<article class="card"/g)).toHaveLength(2)        // the shared pickup, and the van
    expect(body.match(/Z-BOX Hlavna 6/g)).toHaveLength(1)
    expect(body).toContain('Packeta did not give a pickup deadline.')   // stated, not omitted: the reader would assume there is none
    expect(body.indexOf('On the van')).toBeLessThan(body.indexOf('Z-BOX Hlavna 6'))
  })
})

describe('the parcel page timeline and History, as built', () => {
  test('day headings are read aloud (they are the only date a row carries), and a code is on the text, not the list item', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'dpd', trackingNumber: '01505515835276', source: 'manual' })
    appendEvents(db, id, [
      { ...ev('a', 'in_transit', 30, 'Sorted'), code: 'HUS' },
      { ...ev('b', 'in_transit', 5, 'Sorted again'), code: 'HUS' },
      { ...ev('c', 'unknown', 2, 'Returned for expiry'), code: 'DODEX' },
    ])
    const body = (await get(db, `/parcel/${id}`)).body
    const tl = body.slice(body.indexOf('id="timeline"'), body.indexOf('</ol>'))
    expect(tl).toMatch(/<li class="day[^"]*"><span>[A-Z][a-z]{2} \d+ [A-Z][a-z]{2}<\/span><\/li>/)
    expect(tl).not.toMatch(/<li class="day[^>]*aria-hidden/)   // the glyphs are aria-hidden, the headings are not
    expect(tl).not.toMatch(/<li[^>]*title=/)
    expect(tl).toContain('<div class="tx" title="carrier code DODEX">')
    // The unknown row is outside the run below it: only the two `in_transit` rows are joined by a bar.
    const rows = tl.split('<li class="er').slice(1)
    expect(rows[0]).not.toContain(' bar')                         // newest: the unknown row
    expect(rows[1]).toMatch(/^[^>]*bar[^>]*top/)                  // head of the run
    expect(rows[2]).toMatch(/^[^>]*bar[^>]*end/)                  // its last member
  })

  test('History shows the tracking number beside a name that is not the number, and the date filter is not called "Delivered"', async () => {
    const db = memDb()
    delivered(db, { number: 'Z1748571211', label: 'Vinted' })
    delivered(db, { number: 'Z1999000111', label: 'Vinted' })
    delivered(db, { number: 'Z7777777777' })                     // named by its number: not repeated
    const body = (await get(db, '/history')).body
    expect(body).toContain('>Z1748571211</span>')
    expect(body).toContain('>Z1999000111</span>')
    expect(body.match(/Z7777777777/g)).toHaveLength(1)          // the link text only: no repeated trailing token
    expect(body).toContain('Date from')
    expect(body).not.toContain('Delivered from')
  })

  test('dates are never relative and the year appears once it is not this year', () => {
    // The Attention-page trap: an email from exactly a year ago has today\'s day and month.
    const now = new Date('2026-10-27T10:00:00Z')
    expect(formatDateTime(new Date('2025-10-27T14:57:00Z'), now)).toBe('27 Oct 2025, 15:57')
    expect(formatDateTime(new Date('2025-11-12T19:07:00Z'), now)).toBe('12 Nov 2025, 20:07')
    expect(formatDateTime(new Date('2026-10-26T16:19:00Z'), now)).toBe('Mon 26 Oct, 17:19')
    expect(formatDateTime(new Date('2026-03-12T10:00:00Z'), now)).toBe('12 Mar, 11:00')
    // 22:05 UTC on the 24th is 00:05 on the 25th in Bratislava: the day comes from the zone, not from UTC.
    expect(formatDateTime(new Date('2026-10-24T22:05:00Z'), now)).toBe('Sun 25 Oct, 00:05')
  })

  test('the nav reserves its bold width and marks the current page', async () => {
    const body = (await get(memDb(), '/history')).body
    expect(body).toContain('<a href="/history" data-t="History" aria-current="page">')
    expect(body).toContain('data-t="In flight"')
  })

  test('the Attention item carries the number of emails waiting there, on every page, and nothing at zero', async () => {
    const db = memDb()
    const attentionItem = async (url: string) =>
      (await get(db, url)).body.match(/<a href="\/attention"[^>]*>([\s\S]*?)<\/a>/)?.[1]
    expect(await attentionItem('/history')).toBe('Attention')
    junkMail(db)
    junkMail(db, '<junk2@x>')
    for (const url of ['/', '/history', '/attention', '/health', '/settings', '/add']) {
      const item = await attentionItem(url)
      expect(item, url).toContain('<span class="n">2</span>')
      // Read aloud as "Attention, 2 emails waiting", not as a bare number.
      expect(item!.replace(/<[^>]+>/g, ''), url).toBe('Attention2 emails waiting')
    }
    expect(STYLE).toMatch(/nav \.n\{[^}]*background:var\(--ink\)[^}]*color:var\(--paper\)/)
  })
})

describe('refresh reads the mailbox, not only the carriers', () => {
  const imap = { host: 'imap.example.com', port: 993, user: 'u@example.com', pass: 'pw', mailbox: 'parcels' }
  // A real captured pickup mail, so this tests the ingest the app actually has rather than a
  // hand-written body that happens to suit the extractor.
  const FIXTURE = readFileSync(new URL('./fixtures/mail/packeta-ready-zbox.eml', import.meta.url))
  const pickupMail = (uid: number) => ({
    uid, messageId: `<m${uid}@x>`, subject: 'Zásielka je pripravená na vyzdvihnutie',
    from: 'noreply@packeta.sk', date: new Date('2026-10-26T10:00:00Z'), source: FIXTURE,
  })

  test('a whole-dashboard refresh ingests mail, so a new install can do something', async () => {
    // The button is the only control on an empty dashboard. Without this it polled carriers for
    // parcels that did not exist yet and reported "nothing", which is what a new user saw.
    const db = memDb()
    const dir = mkdtempSync(join(tmpdir(), 'parcels-refresh-'))
    try {
      const fake = fakeImap([pickupMail(1)])
      const res = await post(db, '/refresh', {}, {
        config: { ...config, imap, dbPath: join(dir, 'parcels.db') },
        ingestClient: fake.client, http: bodyHttp(),
        adapters: [stubAdapter('packeta', inputs => inputs.map(i => okResult(i.number, [ev('x', 'ready_for_pickup')])), 100)],
      })
      expect(refreshedRun(db, res).run).toMatchObject({ mailRead: 1, created: 1 })
      expect(listActive(db)).toHaveLength(1)
      // And polled in that same run: the button chose its parcels when pressed, before the mail was
      // read, so a parcel the mail created was left at "unknown" until the hourly poll.
      expect(refreshedRun(db, res).run).toMatchObject({ polled: 1 })
      expect(listActive(db)[0]!.status).toBe('ready_for_pickup')
      expect(fake.forbidden).toEqual([])            // still read-only against the mailbox
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a single-parcel refresh never touches the mailbox', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', source: 'manual' })
    const adapter = stubAdapter('posta', inputs => inputs.map(i => okResult(i.number, [ev('x', 'in_transit')])), 100)
    const fake = fakeImap([pickupMail(1)])
    const res = await post(db, '/refresh', { parcel: String(id) }, {
      config: { ...config, imap }, ingestClient: fake.client, adapters: [adapter], http: bodyHttp(),
    })
    expect(refreshedRun(db, res).run!.mailRead).toBeUndefined()   // no mailbox was part of this run
    expect(fake.calls).toEqual([])                  // not connected to at all
  })

  test('with no mail configured the refresh says nothing about mail', async () => {
    const db = memDb()
    const res = await post(db, '/refresh', {}, { adapters: [], http: bodyHttp() })
    const { location, run } = refreshedRun(db, res)
    expect(run!.mailRead).toBeUndefined()
    expect(run!.created).toBeUndefined()
    // The dashboard counts what is in flight as it renders, so an empty one still says so.
    const body = (await server(db).inject({ method: 'GET', url: location })).body
    expect(body).toContain('Nothing is in flight yet.')
    expect(body).not.toContain('No new mail.')
  })
})

describe('the dashboard on a first run', () => {
  const IMAP = { host: 'imap.gmail.com', port: 993, user: 'you@gmail.com', pass: 'p', mailbox: 'parcels' }
  const dashboard = async (db: Database, imap?: Config['imap']) =>
    (await buildServer({ db, config: { ...config, imap }, now: () => NOW, notifier: { send: async () => {} } })
      .inject({ method: 'GET', url: '/' })).body
  const emptyLine = (body: string) => /<p class="empty">([\s\S]*?)<\/p>/.exec(body)?.[1] ?? ''

  test('the empty state links to adding a parcel', async () => {
    expect(emptyLine(await dashboard(memDb(), IMAP))).toContain('<a href="/add">')
    expect(emptyLine(await dashboard(memDb()))).toContain('<a href="/add">')
  })

  test('with Gmail not connected, the dashboard says so and links to Settings', async () => {
    for (const db of [memDb(), (() => { const d = memDb(); insertParcel(d, { carrier: 'posta', trackingNumber: 'RR1', source: 'manual' }); return d })()]) {
      const body = await dashboard(db)
      const notice = /<div class="notice" id="mail-setup">[\s\S]*?<\/div><\/div>/.exec(body)?.[0] ?? ''
      expect(notice).toMatch(/Gmail is not connected yet/)
      expect(notice).toContain('<a href="/settings">')
    }
    // ...and an empty state that does not promise mail that cannot arrive.
    expect(emptyLine(await dashboard(memDb()))).not.toMatch(/email arrives/)
  })

  test('with Gmail connected, there is no such notice', async () => {
    expect(await dashboard(memDb(), IMAP)).not.toContain('id="mail-setup"')
  })
})

describe('what the refresh banner claims', () => {
  /** A finished run with these counts, and the dashboard URL the refresh would have redirected to. */
  const finished = (db: Database, counts: Partial<RunCounts> = {}): string => {
    const id = startRun(db, 'web', NOW)
    finishRun(db, id, { counts: { polled: 0, newEvents: 0, failures: 0, ...counts }, summary: '' }, NOW)
    return `/?run=${id}`
  }

  test('an empty dashboard is not told its parcels are paused', async () => {
    const db = memDb()
    const body = (await server(db).inject({ method: 'GET', url: finished(db) })).body
    expect(body).toContain('Nothing is in flight yet.')
    expect(body).not.toContain('each parcel here is paused')
  })

  test('a dashboard that does have parcels still explains why none were polled', async () => {
    const db = memDb()
    insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', source: 'manual' })
    const body = (await server(db).inject({ method: 'GET', url: finished(db) })).body
    expect(body).toContain('each parcel here is paused')
  })

  test('mail that yielded nothing is reported as such, not as silence', async () => {
    const db = memDb()
    const body = (await server(db).inject({ method: 'GET', url: finished(db, { mailRead: 0, created: 0 }) })).body
    expect(body).toContain('No new mail.')
  })

  test('mail that became parcels is reported first', async () => {
    const db = memDb()
    insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', source: 'manual' })
    const body = (await server(db).inject({ method: 'GET', url: finished(db, { polled: 1, mailRead: 3, created: 2 }) })).body
    expect(body).toContain('Read 3 new emails and added 2 parcels.')
  })

  test('the old result-in-the-URL links show no banner: nothing produces them, and a bookmark would replay one for ever', async () => {
    const db = memDb()
    insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', source: 'manual' })
    for (const url of ['/?refreshed=1&failures=2', '/?refreshed=0&failures=0&active=0&read=3&created=2']) {
      const body = (await server(db).inject({ method: 'GET', url })).body
      expect(body, url).not.toContain('role="status"')
      expect(body, url).not.toContain('Polled')
      expect(body, url).not.toContain('carrier failure')
    }
  })
})

// --- the unified card: one frame for every parcel in flight (design-language §6.1) -------------------

describe('GET /: one card design, whatever the state or the carrier', () => {
  /** Every card on the page, in order, each as the markup between its own `<article>` tags. */
  const cards = (body: string): string[] =>
    body.split('<article class="card').slice(1).map(s => s.split('</article>')[0]!)
  /** The class list of every card frame, so that "one design" can be asserted rather than described. */
  const frames = (body: string): string[] => [...body.matchAll(/<article class="([^"]*)"/g)].map(m => m[1]!)

  /** A parcel in whatever state the test needs, with an optional carrier sentence behind it. */
  function inflight(db: Database, o: {
    name: string
    carrier?: CarrierId
    number?: string
    status?: CanonicalStatus
    says?: string
    pickup?: PickupPoint
    retainedTill?: Date
    hoursAgo?: number
  }): number {
    const id = insertParcel(db, {
      carrier: o.carrier ?? 'packeta', trackingNumber: o.number ?? o.name.replace(/\W/g, ''), label: o.name, source: 'manual',
    })
    if (o.says) appendEvents(db, id, [ev('x', o.status ?? 'in_transit', o.hoursAgo ?? 3, o.says)])
    updateParcelState(db, id, {
      status: o.status ?? 'in_transit', pickup: o.pickup, retainedTill: o.retainedTill,
      lastChangedAt: new Date(NOW.getTime() - (o.hoursAgo ?? 3) * 3_600_000),
    })
    return id
  }

  test('every parcel in flight is inside a card, and none is rendered as a bare row', async () => {
    const db = memDb()
    inflight(db, { name: 'Rolling along', says: 'Departed sorting centre' })
    inflight(db, { name: 'On the van', status: 'out_for_delivery', carrier: 'gls', number: '123456789012', says: 'Out for delivery' })
    inflight(db, { name: 'Waiting at the box', status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    inflight(db, { name: 'Brand new', carrier: 'dpd', number: '11WG17063', status: 'unknown' })
    const body = (await get(db, '/')).body
    expect(frames(body)).toHaveLength(4)
    for (const name of ['Rolling along', 'On the van', 'Waiting at the box', 'Brand new']) {
      expect(cards(body).filter(c => c.includes(name)), name).toHaveLength(1)
    }
    // The row list is gone: there is no quieter second species for a parcel to be demoted into.
    expect(body).not.toMatch(/class="row/)
    expect(body).not.toMatch(/class="list"/)
  })

  test('a ready parcel with no pickup place gets the same card, headed by its own name, and invents no location', async () => {
    const db = memDb()
    inflight(db, {
      name: 'No place given', status: 'ready_for_pickup', carrier: 'posta', number: 'RR123456789SK',
      says: 'Zásielka je pripravená na vyzdvihnutie',
    })
    const body = (await get(db, '/')).body
    const [only] = cards(body)
    expect(frames(body)).toEqual(['card'])
    expect(only).toContain('No place given')                   // headed by its own name
    expect(only).toContain('Zásielka je pripravená na vyzdvihnutie')   // the carrier's sentence is the body
    expect(only).toContain('Ready for pickup')                 // the chip still says what state it is in
    expect(body).not.toMatch(/Pickup point|pickup place|unknown location|Z-BOX/i)
  })

  test('parcels waiting at one place share one card, and it is the same frame as a single-parcel card', async () => {
    const db = memDb()
    for (const n of ['A1', 'A2']) {
      inflight(db, { name: `Parcel ${n}`, number: n, status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    }
    inflight(db, { name: 'Rolling along', says: 'Departed sorting centre' })
    const body = (await get(db, '/')).body
    const shared = cards(body).find(c => c.includes('Z-BOX Hlavna 6'))!
    const single = cards(body).find(c => c.includes('Rolling along'))!
    expect(frames(body)).toEqual(['card', 'card'])              // one design, not two
    expect(body.match(/Z-BOX Hlavna 6/g)).toHaveLength(1)       // the place is said once, in the header
    for (const n of ['Parcel A1', 'Parcel A2']) expect(shared).toContain(n)
    // Identical structure: the same header, the same entry list, in both.
    for (const c of [shared, single]) {
      expect(c).toMatch(/<div class="card-h">/)
      expect(c).toMatch(/<ul class="card-l">/)
    }
    expect(shared.match(/<li/g)).toHaveLength(2)                // one block per parcel
    expect(single.match(/<li/g)).toHaveLength(1)                // the same structure with one entry
  })

  test('the chip carries the state, so no card that needs nothing is painted with the signal colour', async () => {
    const db = memDb()
    inflight(db, { name: 'Rolling along', says: 'Departed sorting centre' })
    inflight(db, { name: 'Coming back', status: 'returning', says: 'Returning to sender' })
    inflight(db, { name: 'Waiting at the box', status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    const body = (await get(db, '/')).body
    const quiet = cards(body).filter(c => !c.includes('Z-BOX Hlavna 6'))
    expect(quiet).toHaveLength(2)
    for (const c of quiet) expect(c).not.toContain('t-signal')
    // And the one that does need you wears it on its chip, not as a wash over the whole header.
    const ready = cards(body).find(c => c.includes('Z-BOX Hlavna 6'))!
    expect(ready).toContain('t-signal')
    expect(ready).toMatch(/<div class="card-h">/)               // same header class as the quiet ones
  })

  test('the locker code and the collect-by deadline still render on the card', async () => {
    const db = memDb()
    const id = inflight(db, {
      name: 'Waiting at the box', status: 'ready_for_pickup', carrier: 'posta', number: 'RR123456789SK',
      pickup: { kind: 'post_office', name: 'Pošta Bratislava 1', street: 'Nám. SNP 35', city: 'Bratislava' },
      retainedTill: new Date('2026-11-02T10:00:00Z'),
    })
    recordPickupCode(db, id, '004467', 1, NOW)
    const [only] = cards((await get(db, '/')).body)
    expect(only).toMatch(/Collect by[^<]*2 Nov/)
    expect(only).toContain('Open the box with')
    expect(only).toContain('004467')
  })

  test('cards are ordered by urgency, whatever shape each one is', async () => {
    const db = memDb()
    inflight(db, { name: 'Rolling along', says: 'Departed sorting centre' })
    inflight(db, { name: 'Waiting at the box', status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    inflight(db, { name: 'On the van', status: 'out_for_delivery', carrier: 'gls', number: '123456789012', says: 'Out for delivery' })
    inflight(db, { name: 'Nobody home', status: 'failed_attempt', carrier: 'dpd', number: '11WG17063', says: 'Nepodarilo sa nám doručiť' })
    const body = (await get(db, '/')).body
    const order = cards(body).map(c => ['Nobody home', 'On the van', 'Waiting at the box', 'Rolling along'].find(n => c.includes(n)))
    expect(order).toEqual(['Nobody home', 'On the van', 'Waiting at the box', 'Rolling along'])
  })

  test('a parcel that is not waiting for collection is never filed under a place', async () => {
    const db = memDb()
    // A pickup point the carrier left on the parcel after it moved on. Filing this under the place would
    // head its card with somewhere it is not, and the card's chip would then claim it is ready.
    inflight(db, { name: 'Moved on', status: 'in_transit', says: 'Left the pickup point', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    inflight(db, { name: 'Really waiting', number: 'A2', status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    const body = (await get(db, '/')).body
    const moved = cards(body).find(c => c.includes('Moved on'))!
    expect(moved).toContain('In transit')
    expect(moved).not.toContain('Ready for pickup')
    expect(moved).not.toContain('Z-BOX Hlavna 6')         // its header is its own name, not a place
    expect(cards(body).filter(c => c.includes('Z-BOX Hlavna 6'))).toHaveLength(1)
  })

  test('a name is printed once: in the header, or in the block, never in both', async () => {
    const db = memDb()
    inflight(db, { name: 'Rolling along', says: 'Departed sorting centre' })
    for (const n of ['A1', 'A2']) {
      inflight(db, { name: `Parcel ${n}`, number: n, status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    }
    // Visually: the "Mark as collected" button carries its parcel's name for a screen reader only
    // (`.vh`), so two such buttons on one card are not announced identically. That is not a printed name.
    const body = (await get(db, '/')).body.replace(/<span class="vh">[^<]*<\/span>/g, '')
    for (const name of ['Rolling along', 'Parcel A1', 'Parcel A2', 'Z-BOX Hlavna 6']) {
      expect(body.match(new RegExp(name, 'g')), name).toHaveLength(1)
    }
    // The name that is in the header is the card's link; the names inside a shared card are the links.
    expect(cards(body).find(c => c.includes('Rolling along'))!).toMatch(/<h2><a href="\/parcel\/\d+">Rolling along<\/a><\/h2>/)
    expect(cards(body).find(c => c.includes('Z-BOX Hlavna 6'))!).toMatch(/<h2>Z-BOX Hlavna 6<\/h2>/)
  })

  test('the dashboard is still script-free under an unchanged policy', async () => {
    const db = memDb()
    inflight(db, { name: 'Waiting at the box', status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    const res = await get(db, '/')
    expect(res.headers['content-security-policy'])
      .toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
    expect(res.body).not.toContain('<script')
    expect(res.body).not.toContain('onclick')
  })
})

// A CSS guard, because this one cannot be seen in the markup: the card's header holds the stretched
// link of a one-parcel card (`inset: 0`), so the card itself has to be the positioning context. Without
// `position: relative` here the overlay resolves against the viewport and covers the whole page.
describe('the card frame', () => {
  test('the card is the positioning context for its own stretched link', () => {
    expect(STYLE).toMatch(/\.card\{[^}]*position:relative/)
    expect(STYLE).toMatch(/\.card-h a::after\{[^}]*position:absolute;inset:0/)
  })
})
