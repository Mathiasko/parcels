import { describe, expect, test, vi } from 'vitest'
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
    expect(res.body).toContain('Nothing in flight')
    expect(res.body).not.toMatch(/0 in flight/)   // an empty page does not also print a lede
  })

  test('GET /parcel/:id renders the event timeline newest-first (the query is oldest-first; the template reverses it)', async () => {
    const db = memDb()
    const id = parcel(db)
    scan(db, id, [
      ev('c', 'delivered', 1, 'Delivered to recipient'),
      ev('a', 'pre_transit', 30, 'Shipment registered'),
      ev('b', 'in_transit', 10, 'Arrived at depot'),
    ], 'delivered')
    const body = (await get(db, `/parcel/${id}`)).body
    const order = ['Delivered to recipient', 'Arrived at depot', 'Shipment registered'].map(t => body.indexOf(t))
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

  test('without coordinates the maps link falls back to searching the address', async () => {
    const db = memDb()
    const id = parcel(db)
    // The shape of every real pickup point here: four of the five carriers never send coordinates.
    scan(db, id, [ev('x', 'ready_for_pickup')], 'ready_for_pickup',
      { kind: 'zbox', name: 'Z-BOX Bratislava, Hlavna 6' })
    const body = (await get(db, `/parcel/${id}`)).body
    expect(body).toContain('Z-BOX Bratislava, Hlavna 6')
    expect(body).toMatch(/href="https:\/\/maps\.apple\.com\/\?q=Z-BOX%20Bratislava%2C%20Hlavna%206"/)
    expect(body).not.toContain('maps.apple.com/?ll=')
  })

  test('the maps search is a postal address, not the place name', async () => {
    const db = memDb()
    const id = parcel(db)
    scan(db, id, [ev('x', 'ready_for_pickup')], 'ready_for_pickup',
      { kind: 'parcelshop', name: 'Výdajné miesto', street: 'Hlavna 6', city: 'Bratislava', postalCode: '81109' })
    const body = (await get(db, `/parcel/${id}`)).body
    const url = decodeURIComponent(/href="(https:\/\/maps\.apple\.com\/\?q=[^"]*)"/.exec(body)![1]!)
    // The name is deliberately absent: searching it sends the map to the wrong branch of a chain.
    expect(url).toBe('https://maps.apple.com/?q=Hlavna 6, 81109 Bratislava')
    expect(body).toContain('Výdajné miesto')   // still shown to the reader
  })

  test('a name that embeds its own city does not reach the maps search (the Senec regression)', async () => {
    const db = memDb()
    const id = parcel(db)
    // Exactly what Packeta's display line looks like: city inside the name, ahead of the street.
    scan(db, id, [ev('x', 'ready_for_pickup')], 'ready_for_pickup',
      { kind: 'zbox', name: 'Z-BOX Bratislava, Hlavna 6', street: 'Hlavna 6', city: 'Bratislava' })
    const body = (await get(db, `/parcel/${id}`)).body
    const url = decodeURIComponent(/href="(https:\/\/maps\.apple\.com\/\?q=[^"]*)"/.exec(body)![1]!)
    expect(url).toBe('https://maps.apple.com/?q=Hlavna 6, Bratislava')
  })

  test('a parcel with no pickup point at all has no maps link', async () => {
    const db = memDb()
    const id = parcel(db)
    scan(db, id, [ev('x', 'in_transit')], 'in_transit')
    expect((await get(db, `/parcel/${id}`)).body).not.toContain('maps.apple.com')
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
  test('prose-only unknown events show the carrier text and nothing that reads as an error', async () => {
    const db = memDb()
    const id = parcel(db, { carrier: 'sps', number: 'SPS1' })
    scan(db, id, [
      { ...ev('a', 'unknown', 20, 'Parcel handed to courier'), code: undefined },
      { ...ev('b', 'in_transit', 5, 'Out on route'), code: 'X1' },
      { ...ev('c', 'unknown', 3, 'Unmapped scan'), code: 'ZZ9' },
    ], 'in_transit')
    const body = (await get(db, `/parcel/${id}`)).body
    const timeline = body.slice(body.indexOf('id="timeline"'), body.indexOf('</ol>'))
    expect(timeline).toContain('Parcel handed to courier')
    expect(timeline).toContain('Unmapped scan')
    // Only the known status gets a word; an `unknown` row, coded or not, is a dot and the carrier's own sentence.
    expect(timeline.match(/class="w /g)).toHaveLength(1)
    expect(timeline).toContain('>In transit<')
    expect(timeline).not.toMatch(/unrecogni[sz]ed|status unknown|unknown status/i)
    // The carrier's code is for the `title`, not for the owner's eyes.
    expect(timeline).toContain('title="carrier code ZZ9"')
    expect(timeline).not.toContain('>ZZ9<')
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

  test('a 404 is a page of the app, with the nav and a way home, not a bare word or Fastify JSON', async () => {
    const db = memDb()
    const app = buildServer({ db, config })
    for (const [method, url] of [
      ['GET', '/parcel/999'], ['GET', '/parcel/abc'], ['GET', '/no/such/page'], ['POST', '/parcel/999/delete'],
    ] as const) {
      const res = await app.inject({ method, url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' })
      expect(res.statusCode, url).toBe(404)
      expect(res.headers['content-type'], url).toContain('text/html')
      expect(res.body, url).toContain('<nav aria-label="Main">')
      expect(res.body, url).toMatch(/<h1>[^<]*not found[^<]*<\/h1>/i)
      expect(res.body, url).toContain('<a href="/">Back to the parcels in flight</a>')
      expect(res.body, url).not.toContain('"statusCode"')
    }
    // A parcel that is gone says so in words a person can act on.
    expect((await app.inject({ method: 'GET', url: '/parcel/999' })).body).toMatch(/deleted/)
  })

  test('a missing map tile stays a small plain 404: an <img> asks for it, nobody reads it', async () => {
    const res = await buildServer({ db: memDb(), config }).inject({ method: 'GET', url: '/tile/16/1/1.png' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('<nav')
  })

  test('a 500 is a page of the app too, naming no internals, even when the database itself is what broke', async () => {
    const db = memDb()
    const app = buildServer({ db, config })
    db.close()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.inject({ method: 'GET', url: '/' })
      expect(res.statusCode).toBe(500)
      expect(res.headers['content-type']).toContain('text/html')
      expect(res.body).toMatch(/<h1>Something went wrong<\/h1>/)
      expect(res.body).toContain('<a href="/">Back to the parcels in flight</a>')
      expect(res.body).not.toMatch(/database|sqlite|connection is not open/i)
    } finally {
      spy.mockRestore()
    }
  })

  test('the cross-site refusal stays a bare plain-text 403: it is answered to hostile requests', async () => {
    const res = await buildServer({ db: memDb(), config }).inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })
    expect(res.statusCode).toBe(403)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toBe('forbidden')
  })

  test('the parcel page calls its own name a name, not a label (the Gmail label is something else)', async () => {
    const db = memDb()
    const id = parcel(db, { label: 'Shoes' })
    const body = (await get(db, `/parcel/${id}`)).body
    expect(body).toContain('<h3 class="sec">Name</h3>')
    expect(body).toMatch(/<input name="label" value="Shoes" placeholder="e\.g\. Shoes from Zalando" aria-label="Name">/)
    expect(body).toContain('<button>Save name</button>')
    expect(body).not.toContain('<h3 class="sec">Label</h3>')
    // ...and the same word where a parcel is first named, on /add and on each email in /attention.
    expect((await get(db, '/add')).body).toContain('<label>Name<input name="label"')
  })

  test('raw carrier responses are tucked under a closed "Technical details", and absent when there are none', async () => {
    const db = memDb()
    const id = parcel(db)
    scan(db, id, [ev('a', 'in_transit')], 'in_transit')
    expect((await get(db, `/parcel/${id}`)).body).not.toContain('Technical details')
    db.prepare('INSERT INTO raw_responses (parcel_id, carrier, fetched_at, body) VALUES (?, ?, ?, ?)').run(id, 'posta', NOW.toISOString(), '{"x":1}')
    const body = (await get(db, `/parcel/${id}`)).body
    const tech = body.indexOf('<details class="tech"><summary>Technical details</summary>')
    expect(tech).toBeGreaterThan(-1)
    expect(body.indexOf('&quot;x&quot;')).toBeGreaterThan(tech)
    expect(body).not.toContain('<h2>Raw carrier responses</h2>')
    expect(tech).toBeLessThan(body.indexOf('<details class="del">'))   // still above Delete, but closed
  })

  test('a parcel whose status line has nothing to say leaves no empty status box', async () => {
    const db = memDb()
    const id = parcel(db, { carrier: 'packeta', number: 'Z123456789' })
    scan(db, id, [ev('a', 'unknown', 1, 'Your parcel is on its way to you.')], 'unknown')
    expect((await get(db, `/parcel/${id}`)).body).not.toContain('<div class="status"></div>')
    const known = parcel(db, { number: 'RR000000002SK' })
    scan(db, known, [ev('a', 'in_transit')], 'in_transit')
    expect((await get(db, `/parcel/${known}`)).body).toMatch(/<div class="status"><span class="st/)
  })

  test('the pickup deadline is worded exactly as on the dashboard', async () => {
    for (const days of [5, 2, 1, 0, -1]) {
      const db = memDb()
      const id = parcel(db, { label: 'Shoes' })
      scan(db, id, [ev('x', 'ready_for_pickup')], 'ready_for_pickup',
        { kind: 'post_office', name: 'Pošta Bratislava 1', street: 'Nám. SNP 35', city: 'Bratislava' },
        new Date(NOW.getTime() + days * 86_400_000))
      const app = buildServer({ db, config, now: () => NOW })
      const clock = async (url: string) => /<p class="clock">[\s\S]*?<\/p>/.exec((await app.inject({ method: 'GET', url })).body)?.[0]
      const onDashboard = await clock('/')
      expect(onDashboard, String(days)).toBeDefined()
      expect(await clock(`/parcel/${id}`), String(days)).toBe(onDashboard)
    }
  })

  test('the add form is made for pasting a tracking number and knows the default postcode', async () => {
    const body = (await get(memDb(), '/add')).body
    const number = /<input name="number"[^>]*>/.exec(body)![0]
    for (const attr of ['autofocus', 'autocapitalize="characters"', 'spellcheck="false"', 'autocomplete="off"']) {
      expect(number, attr).toContain(attr)
    }
    const postcode = /<input name="postcode"[^>]*>/.exec(body)![0]
    expect(postcode).toContain('placeholder="81101 (default)"')     // the real default, not the word "default"
    expect(postcode).toContain('inputmode="numeric"')
  })

  test('the assign forms on /attention share the field rules, but only /add takes the focus', async () => {
    const db = memDb()
    db.prepare('INSERT INTO messages (message_id, subject, parsed_ok, parse_note) VALUES (?, ?, 0, ?)').run('<a@x>', 'Your parcel', 'no tracking number')
    const body = (await get(db, '/attention')).body
    const number = /<input name="number"[^>]*>/.exec(body)![0]
    expect(number).toContain('autocapitalize="characters"')
    expect(number).not.toContain('autofocus')
    expect(/<input name="postcode"[^>]*>/.exec(body)![0]).toContain('placeholder="81101 (default)"')
  })

  test('the parcel page postcode box brings up a number pad', async () => {
    const db = memDb()
    const id = parcel(db, { carrier: 'gls', number: '12345678901' })
    const body = (await get(db, `/parcel/${id}`)).body
    expect(/<input name="postcode"[^>]*>/.exec(body)![0]).toContain('inputmode="numeric"')
  })

  test('the arrow after "Open in Apple Maps" is not read aloud, on the dashboard and on the parcel page', async () => {
    const db = memDb()
    const id = parcel(db, { label: 'Shoes' })
    scan(db, id, [ev('x', 'ready_for_pickup')], 'ready_for_pickup',
      { kind: 'zbox', name: 'Z-BOX Hlavna 6', street: 'Hlavna 6', city: 'Bratislava', lat: 48.1, lon: 17.1 })
    for (const url of ['/', `/parcel/${id}`]) {
      const body = (await get(db, url)).body
      expect(body, url).toContain('Open in Apple Maps <span aria-hidden="true">↗</span></a>')
      expect(body, url).not.toContain('Open in Apple Maps ↗')
    }
  })

  test('requests with a foreign Host header are refused (DNS rebinding)', async () => {
    const app = buildServer({ db: memDb(), config })
    const bad = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })
    expect(bad.statusCode).toBe(403)
    for (const host of ['127.0.0.1:8787', 'localhost:8787', 'localhost', '[::1]:8787', 'LOCALHOST:8787', 'parcels.local', 'parcels.local:8787', 'PARCELS.LOCAL']) {
      expect((await app.inject({ method: 'GET', url: '/', headers: { host } })).statusCode, host).toBe(200)
    }
    for (const host of ['127.0.0.1.evil.example', 'localhost.evil.example:8787', '0.0.0.0:8787', '192.168.0.101:8787',
      'parcels.local.evil.example', 'evil.example:80', 'parcels.localhost', 'notparcels.local']) {
      expect((await app.inject({ method: 'GET', url: '/', headers: { host } })).statusCode, host).toBe(403)
    }
  })
})
