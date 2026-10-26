import { describe, expect, test } from 'vitest'
import { buildServer, BIND_HOST, startServer } from '../src/web/server.js'
import { appendEvents } from '../src/db/events.js'
import { insertParcel, updateParcelState } from '../src/db/parcels.js'
import type { Database } from '../src/db/index.js'
import type { CarrierId, ParcelEvent, PickupPoint } from '../src/core/types.js'
import { config, ev, memDb, NOW } from './poll-helpers.js'

function parcel(
  db: Database,
  o: { carrier?: CarrierId; number?: string; label?: string; merchant?: string } = {},
): number {
  return insertParcel(db, {
    carrier: o.carrier ?? 'posta', trackingNumber: o.number ?? 'RR123456789SK',
    label: o.label, merchant: o.merchant, source: 'manual',
  })
}

function scan(db: Database, id: number, events: ParcelEvent[], status: ParcelEvent['status'], pickup?: PickupPoint, retainedTill?: Date): void {
  appendEvents(db, id, events)
  updateParcelState(db, id, { status, pickup, retainedTill })
}

const get = async (db: Database, url: string) => buildServer({ db, config }).inject({ method: 'GET', url })

describe('web core', () => {
  test('GET / lists active parcels with label, carrier and status', async () => {
    const db = memDb()
    const id = parcel(db, { label: 'New headphones', carrier: 'packeta', number: 'Z123456789' })
    scan(db, id, [ev('2026-10-26 09:00', 'in_transit', 1, 'Departed sorting centre')], 'in_transit')
    const res = await get(db, '/')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('New headphones')
    expect(res.body).toContain('Packeta')
    expect(res.body).toContain('In transit')
    expect(res.body).toContain('Departed sorting centre')
    expect(res.body).toContain(`/parcel/${id}`)
  })

  test('GET / shows the pickup location and deadline when a parcel is ready for pickup', async () => {
    const db = memDb()
    const id = parcel(db, { label: 'Shoes' })
    scan(db, id, [ev('x', 'ready_for_pickup')], 'ready_for_pickup',
      { kind: 'post_office', name: 'Pošta Bratislava 1', street: 'Nám. SNP 35', city: 'Bratislava' },
      new Date('2026-11-02T10:00:00Z'))
    const body = (await get(db, '/')).body
    expect(body).toContain('Pošta Bratislava 1')
    expect(body).toContain('Bratislava')
    expect(body).toMatch(/Collect by[^<]*2 Nov/)
  })

  test('GET / renders an empty state when there are no active parcels', async () => {
    const res = await get(memDb(), '/')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('No parcels in flight')
  })

  test('GET /parcel/:id renders the event timeline oldest-first', async () => {
    const db = memDb()
    const id = parcel(db)
    scan(db, id, [
      ev('c', 'delivered', 1, 'Delivered to recipient'),
      ev('a', 'pre_transit', 30, 'Shipment registered'),
      ev('b', 'in_transit', 10, 'Arrived at depot'),
    ], 'delivered')
    const body = (await get(db, `/parcel/${id}`)).body
    const order = ['Shipment registered', 'Arrived at depot', 'Delivered to recipient'].map(t => body.indexOf(t))
    expect(order.every(i => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  test('GET /parcel/:id returns 404 for an unknown id', async () => {
    const db = memDb()
    expect((await get(db, '/parcel/999')).statusCode).toBe(404)
    expect((await get(db, '/parcel/abc')).statusCode).toBe(404)
  })

  test('GET /parcel/:id includes an Apple Maps link when the pickup point has coordinates', async () => {
    const db = memDb()
    const id = parcel(db)
    scan(db, id, [ev('x', 'ready_for_pickup')], 'ready_for_pickup',
      { kind: 'parcelshop', name: 'Výdajné miesto', lat: 48.1486, lon: 17.1077 })
    const body = (await get(db, `/parcel/${id}`)).body
    expect(body).toMatch(/href="https:\/\/maps\.apple\.com\/\?[^"]*ll=48\.1486(,|%2C)17\.1077/)
  })

  test('GET /parcel/:id omits the maps link when coordinates are absent', async () => {
    const db = memDb()
    const id = parcel(db)
    scan(db, id, [ev('x', 'ready_for_pickup')], 'ready_for_pickup', { kind: 'parcelshop', name: 'Výdajné miesto' })
    const body = (await get(db, `/parcel/${id}`)).body
    expect(body).toContain('Výdajné miesto')
    expect(body).not.toContain('maps.apple.com')
  })

  test('a parcel label containing HTML is escaped, not rendered as markup', async () => {
    const db = memDb()
    const id = parcel(db, { label: '<script>alert(1)</script>', merchant: '<img src=x onerror=alert(2)>' })
    scan(db, id, [ev('x', 'in_transit', 1, '<b onmouseover=alert(3)>desc</b>')], 'in_transit')
    for (const url of ['/', `/parcel/${id}`]) {
      const body = (await get(db, url)).body
      expect(body).not.toContain('<script>')
      expect(body).not.toContain('<img src=x')
      expect(body).not.toContain('<b onmouseover')
      expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    }
  })

  test('the server binds 127.0.0.1 only', async () => {
    expect(BIND_HOST).toBe('127.0.0.1')
    const app = buildServer({ db: memDb(), config })
    try {
      await startServer(app, 0)   // port 0: any free port; the host is not caller-supplied
      const addr = app.server.address()
      expect(addr).toMatchObject({ address: '127.0.0.1', family: 'IPv4' })
    } finally {
      await app.close()
    }
  })
})

describe('web core: faithful rendering', () => {
  test('an event with no code and status unknown shows the carrier text, not an unknown chip', async () => {
    const db = memDb()
    const id = parcel(db, { carrier: 'sps', number: 'SPS1' })
    scan(db, id, [
      { ...ev('a', 'unknown', 20, 'Parcel handed to courier'), code: undefined },
      { ...ev('b', 'in_transit', 5, 'Out on route'), code: 'X1' },
      { ...ev('c', 'unknown', 3, 'Unmapped scan'), code: 'ZZ9' },
    ], 'in_transit')
    const body = (await get(db, `/parcel/${id}`)).body
    const timeline = body.slice(body.indexOf('id="timeline"'))
    expect(timeline).toContain('Parcel handed to courier')
    // Only the unmapped-but-coded event may carry an unknown chip.
    expect(timeline.match(/chip-unknown/g)?.length).toBe(1)
  })

  test('a parcel whose postcode was rejected says so and offers a postcode form', async () => {
    const db = memDb()
    const id = parcel(db, { carrier: 'gls', number: '123456789012' })
    db.prepare("UPDATE parcels SET postal_code = '99999', needs_postcode = '99999' WHERE id = ?").run(id)
    const body = (await get(db, `/parcel/${id}`)).body
    expect(body).toContain('99999')
    expect(body).toMatch(/postcode[^<]*(rejected|not accepted)/i)
    expect(body).toContain(`action="/parcel/${id}/postcode"`)
    // Once the postcode differs from the rejected one, the page no longer claims it is rejected.
    db.prepare("UPDATE parcels SET postal_code = '81101' WHERE id = ?").run(id)
    expect((await get(db, `/parcel/${id}`)).body).not.toMatch(/was rejected/i)
  })

  test('raw responses: a NULL parcel_id row is shown as carrier-level, not as the parcel\'s own', async () => {
    const db = memDb()
    const id = parcel(db, { carrier: 'posta' })
    const raw = db.prepare('INSERT INTO raw_responses (parcel_id, carrier, fetched_at, body) VALUES (?, ?, ?, ?)')
    raw.run(id, 'posta', NOW.toISOString(), '{"own":"<i>mine</i>"}')
    raw.run(null, 'posta', NOW.toISOString(), '{"batch":"failed"}')
    const body = (await get(db, `/parcel/${id}`)).body
    expect(body).toContain('&lt;i&gt;mine&lt;/i&gt;')
    expect(body).not.toContain('<i>mine</i>')
    const blocks = body.split('<details>').slice(1)
    expect(blocks).toHaveLength(2)
    const own = blocks.find(b => b.includes('mine'))!
    const batch = blocks.find(b => b.includes('&quot;batch&quot;'))!
    expect(own).not.toMatch(/carrier-level/i)
    expect(batch).toMatch(/carrier-level/i)
  })

  test('requests with a foreign Host header are refused (DNS rebinding)', async () => {
    const app = buildServer({ db: memDb(), config })
    const bad = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })
    expect(bad.statusCode).toBe(403)
    for (const host of ['127.0.0.1:8787', 'localhost:8787', 'localhost', '[::1]:8787', 'LOCALHOST:8787']) {
      expect((await app.inject({ method: 'GET', url: '/', headers: { host } })).statusCode, host).toBe(200)
    }
    for (const host of ['127.0.0.1.evil.example', 'localhost.evil.example:8787', '0.0.0.0:8787', '192.168.0.101:8787']) {
      expect((await app.inject({ method: 'GET', url: '/', headers: { host } })).statusCode, host).toBe(403)
    }
  })
})
