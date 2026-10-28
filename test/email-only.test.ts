import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runCli } from '../src/cli.js'
import { runPoll } from '../src/core/poll.js'
import { isDormant, isDue } from '../src/core/backoff.js'
import { allAdapters } from '../src/carriers/registry.js'
import { dhlCarrier } from '../src/carriers/dhl.js'
import { extract } from '../src/ingest/extract.js'
import { ingestMessages, type IngestDeps } from '../src/ingest/ingest.js'
import { listEvents } from '../src/db/events.js'
import { carrierHealth, recordHealth } from '../src/db/health.js'
import { findParcel, getParcel, insertParcel } from '../src/db/parcels.js'
import { buildServer, refreshIdle, type WebDeps } from '../src/web/server.js'
import type { Database } from '../src/db/index.js'
import { fakeImap, type FakeMessage } from './imap-fake.js'
import { NOW, addParcel, bodyHttp, config, memDb, stubAdapter } from './poll-helpers.js'

const DAY = 86_400_000
const NUMBER = 'JJD0099990758473189'
const fx = (name: string) => readFileSync(new URL(`./fixtures/mail/${name}.eml`, import.meta.url))
const imap = { host: 'imap.example.com', port: 993, user: 'u@example.com', pass: 'pw', mailbox: 'parcels' }

function mail(uid: number, name: string, daysOld: number, over: Partial<FakeMessage> = {}): FakeMessage {
  const source = fx(name)
  const text = source.toString('latin1')
  return {
    uid, source, messageId: /^Message-ID: <(.+)>$/m.exec(text)?.[1] ?? `<${name}@fixture>`,
    subject: /^Subject: (.*)$/m.exec(text)?.[1] ?? name,
    from: /^From: .*<(.+?)>/m.exec(text)?.[1] ?? 'x@example.com',
    date: new Date(NOW.getTime() - daysOld * DAY), ...over,
  }
}

function ingest(messages: FakeMessage[], over: Partial<IngestDeps> = {}) {
  const db = memDb()
  const deps: IngestDeps = {
    imap, client: fakeImap(messages).client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-dhl-')),
    now: NOW, adapters: allAdapters(), defaultPostalCode: '81101', ...over,
  }
  return { db, deps }
}

const server = (db: Database, extra: Partial<WebDeps> = {}) =>
  buildServer({ db, config, now: () => NOW, notifier: { send: async () => {} }, ...extra })
const get = (db: Database, url: string) => server(db).inject({ method: 'GET', url })

const cli = async (db: Database, ...argv: string[]) => {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, { db, config, out: s => out.push(s), err: s => err.push(s) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('a DHL mail is what tracks a DHL parcel', () => {
  test('extract reads the carrier from the sender domain, the number from the body, and keeps the mail\'s own words', async () => {
    const e = await extract(fx('synthetic-dhl-dispatch'))
    expect(e).toMatchObject({ carrier: 'dhl', number: NUMBER, confidence: 'sender' })
    expect(e.eventText).toBe('Your DHL shipment JJD0099990758473189 is on its way')
  })

  // The number here is the bare-digit `000…` form and the text never says "DHL", so nothing but the
  // sender's domain can name the carrier: each domain in the list is load-bearing on its own.
  test.each([
    'dhl.com', 'dhl.de', 'dhl.sk', 'dhl.cz',
    'dhlparcel.com', 'dhlparcel.sk', 'dhlparcel.cz', 'dhlparcel.nl', 'dhlexpress.com',
    'news.dhl.com',   // any subdomain resolves, as for every other carrier
  ])('%s identifies DHL when nothing else in the mail does', async host => {
    const raw = Buffer.from(`From: Parcel <noreply@${host}>\r\nSubject: Zasielka 0001234567890123 je na ceste\r\n\r\nCislo zasielky: 0001234567890123.\r\n`)
    expect(await extract(raw)).toMatchObject({ carrier: 'dhl', number: '0001234567890123', confidence: 'sender' })
  })

  test.each(['evildhl.com', 'dhl.com.evil.example', 'dhl.evil.example'])(
    '%s is not DHL: a look-alike domain never gets a parcel', async host => {
      const raw = Buffer.from(`From: Parcel <noreply@${host}>\r\nSubject: Zasielka 0001234567890123 je na ceste\r\n\r\nCislo zasielky: 0001234567890123.\r\n`)
      // No parcel, but still a QUESTION: the mail prints a labelled parcel-shaped number, so it waits
      // on /attention rather than being ignored. A look-alike domain must not hand out a parcel; it
      // also must not be able to make a real parcel invisible.
      expect(await extract(raw)).toEqual({ confidence: 'none', evidence: 'tracking-shape' })
    },
  )

  test('a polled carrier\'s mail yields no event text: only an email-only carrier turns prose into an event', async () => {
    expect((await extract(fx('synthetic-gls-notification'))).eventText).toBeUndefined()
    expect((await extract(fx('synthetic-eshop-dispatch-gls'))).eventText).toBeUndefined()
    expect((await extract(fx('packeta-accepted'))).eventText).toBeUndefined()
  })

  test('a DHL mail creates a parcel whose only event is the mail\'s own text', async () => {
    const { db, deps } = ingest([mail(1, 'synthetic-dhl-dispatch', 2)])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 1, created: 1, needsAttention: 0 })

    const p = findParcel(db, 'dhl', NUMBER)!
    expect(p).toMatchObject({ carrier: 'dhl', source: 'email', status: 'unknown' })
    const events = listEvents(db, p.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      description: 'Your DHL shipment JJD0099990758473189 is on its way',
      status: 'unknown',
      occurredAt: new Date(NOW.getTime() - 2 * DAY),
    })
  })

  test('a second DHL mail links to the same parcel and appends its own words', async () => {
    const { db, deps } = ingest([mail(1, 'synthetic-dhl-dispatch', 2), mail(2, 'synthetic-dhl-ready-for-pickup', 1)])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 2, created: 1, linked: 1, needsAttention: 0 })
    const events = listEvents(db, findParcel(db, 'dhl', NUMBER)!.id)
    expect(events.map(e => e.description)).toEqual([
      'Your DHL shipment JJD0099990758473189 is on its way',
      'Your DHL parcel JJD0099990758473189 is waiting at DHL ServicePoint Senec',
    ])
  })

  test('the same mail ingested twice does not duplicate its event', async () => {
    const { db, deps } = ingest([mail(1, 'synthetic-dhl-dispatch', 2)])
    await ingestMessages(db, deps)
    const resent = mail(7, 'synthetic-dhl-dispatch', 2, { messageId: '<resent-dhl@fixture>' })
    await ingestMessages(db, { ...deps, client: fakeImap([resent]).client })
    expect(listEvents(db, findParcel(db, 'dhl', NUMBER)!.id)).toHaveLength(1)
  })

  test('an e-shop mail that names DHL and prints a labelled number of its bare-digit shape creates the parcel', async () => {
    const e = await extract(fx('synthetic-eshop-dispatch-dhl'))
    expect(e).toMatchObject({ carrier: 'dhl', number: '0001234567890123', confidence: 'shape', merchant: 'Example Shop' })
    const { db, deps } = ingest([mail(1, 'synthetic-eshop-dispatch-dhl', 1)])
    expect(await ingestMessages(db, deps)).toMatchObject({ created: 1, needsAttention: 0 })
    expect(findParcel(db, 'dhl', '0001234567890123')).toBeDefined()
  })

  test('a DHL mail is never refused for want of an adapter', async () => {
    const { db, deps } = ingest([mail(1, 'synthetic-dhl-dispatch', 2)])
    await ingestMessages(db, deps)
    const note = db.prepare('SELECT parse_note FROM messages').get() as { parse_note: string | null }
    expect(note.parse_note).toBeNull()
  })
})

describe('an email-only carrier is never polled', () => {
  const dhlParcel = (db: Database) => addParcel(db, 'dhl', NUMBER)

  test('the poller does not fetch it, does not count it as polled, and records no carrier failure', async () => {
    const db = memDb()
    const id = dhlParcel(db)
    addParcel(db, 'posta', 'RA000000001SK')
    const posta = stubAdapter('posta', ins => ins.map(i => ({ ok: false as const, number: i.number, reason: 'not_found' as const })), 100)
    const report = await runPoll({ db, http: bodyHttp(), adapters: [posta, dhlCarrier], config, now: NOW })

    expect(report.failures).toEqual([])
    expect(report.polled).toBe(1)                 // the posta parcel, and only it
    expect(posta.calls.flat().map(i => i.number)).toEqual(['RA000000001SK'])
    expect(carrierHealth(db).map(h => h.carrier)).toEqual(['posta'])
    expect(getParcel(db, id)!.lastAttemptedAt).toBeUndefined()
  })

  test('a forced refresh of that one parcel does not pretend to have polled it', async () => {
    const db = memDb()
    const id = dhlParcel(db)
    const report = await runPoll({
      db, http: bodyHttp(), adapters: [dhlCarrier], config, now: NOW, parcelIds: [id], forceAll: true,
    })
    expect(report).toMatchObject({ polled: 0, failures: [] })
    expect(carrierHealth(db)).toEqual([])
    expect(getParcel(db, id)!.lastPolledAt).toBeUndefined()
    expect(getParcel(db, id)!.lastAttemptedAt).toBeUndefined()
  })

  test('it is not due, and never becomes dormant: dormancy is a fact about polling', () => {
    const db = memDb()
    const id = dhlParcel(db)
    db.prepare('UPDATE parcels SET first_seen_at = ? WHERE id = ?')
      .run(new Date(NOW.getTime() - 40 * DAY).toISOString(), id)
    const p = getParcel(db, id)!
    expect(isDormant(p, NOW)).toBe(false)
    expect(isDue(p, NOW)).toBe(false)
  })

  test('/attention does not list it as dormant and the index does not say it stopped being polled', async () => {
    const db = memDb()
    const id = dhlParcel(db)
    db.prepare('UPDATE parcels SET first_seen_at = ? WHERE id = ?')
      .run(new Date(NOW.getTime() - 40 * DAY).toISOString(), id)
    const attention = (await get(db, '/attention')).body
    expect(attention).not.toContain(NUMBER)
    const index = (await get(db, '/')).body
    expect(index).not.toMatch(/no longer polled/)
  })
})

describe('what the user is told about an email-only carrier', () => {
  test('/health shows DHL as what it is, never as a broken or never-polled carrier', async () => {
    const db = memDb()
    for (const id of ['posta', 'packeta', 'gls', 'sps', 'dpd'] as const) recordHealth(db, id, 'ok', undefined, NOW)
    const body = (await get(db, '/health')).body
    const row = body.slice(body.indexOf('data-carrier="dhl"')).split('</tr>')[0]!
    expect(row).toContain('DHL')
    expect(row).toMatch(/by email/i)
    expect(row).not.toContain('class="bad"')
    expect(row).not.toMatch(/no data|failing|needs attention/)
    // The lede counts the carriers it can actually poll, and says what DHL is instead.
    expect(body).toContain('All 5 carriers reporting.')
    expect(body).not.toMatch(/DHL (has|have) never been polled/)
    expect(body).toMatch(/DHL is not polled/)
  })

  test('an in-flight DHL parcel with no mail yet says updates arrive by email, not "no updates yet"', async () => {
    const db = memDb()
    insertParcel(db, { carrier: 'dhl', trackingNumber: NUMBER, label: 'Camera lens', source: 'manual' })
    const index = (await get(db, '/')).body
    expect(index).toContain('Updates arrive by email')
    expect(index).not.toContain('No updates yet')
  })

  test('the parcel page shows the mail\'s words, says how updates arrive, and offers no refresh', async () => {
    const { db, deps } = ingest([mail(1, 'synthetic-dhl-dispatch', 2)])
    await ingestMessages(db, deps)
    const id = findParcel(db, 'dhl', NUMBER)!.id
    const body = (await get(db, `/parcel/${id}`)).body
    expect(body).toContain('Your DHL shipment JJD0099990758473189 is on its way')
    expect(body).toMatch(/updates arrive by email/i)
    expect(body).not.toContain('Refresh this parcel')
    expect(body).not.toContain('No updates yet')
  })

  test('the history delivery times do not promise DHL numbers that can never exist', async () => {
    const db = memDb()
    const body = (await get(db, '/history')).body
    const row = body.slice(body.indexOf('data-carrier="dhl"')).split('</tr>')[0]!
    expect(row).toMatch(/updates arrive by email/i)
    expect(row).not.toContain('no deliveries yet')
  })

  test('both carrier pickers offer DHL', async () => {
    const db = memDb()
    for (const url of ['/add', '/history']) {
      expect((await get(db, url)).body).toContain('<option value="dhl">DHL</option>')
    }
  })
})

describe('the command line', () => {
  test('add detects DHL from a prefixed number', async () => {
    const db = memDb()
    const r = await cli(db, 'add', 'jjd 0099 9907 5847 3189')
    expect(r.code).toBe(0)
    expect(r.out).toContain('dhl')
    expect(findParcel(db, 'dhl', NUMBER)).toMatchObject({ carrier: 'dhl', source: 'manual' })
  })

  test('add --carrier dhl adds a bare Express number the shapes deliberately refuse', async () => {
    const db = memDb()
    const r = await cli(db, 'add', '1234567890', '--carrier', 'dhl', '--label', 'Express envelope')
    expect(r.code).toBe(0)
    expect(findParcel(db, 'dhl', '1234567890')).toMatchObject({ carrier: 'dhl', label: 'Express envelope' })
    // ... and the same number with no carrier chosen is still GLS's, exactly as before.
    expect((await cli(db, 'add', '1234567890')).code).toBe(0)
    expect(findParcel(db, 'gls', '1234567890')).toBeDefined()
  })

  test('probe says DHL is email-only instead of pretending to ask it', async () => {
    const db = memDb()
    const r = await cli(db, 'probe', 'dhl', NUMBER)
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/email/i)
    expect(r.err).not.toMatch(/no adapter/)
  })

  test('the usage text lists dhl among the carriers', async () => {
    const db = memDb()
    const r = await cli(db, 'probe', 'nope', NUMBER)
    expect(r.err).toContain('dhl')
  })
})
