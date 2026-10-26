import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { carrierForAddress, extract, htmlToText } from '../src/ingest/extract.js'
import {
  ARCHIVE_AFTER_DAYS, ingestMessages, reprocessMessages, type IngestDeps,
} from '../src/ingest/ingest.js'
import { runPoll, summarize } from '../src/core/poll.js'
import { allAdapters } from '../src/carriers/registry.js'
import { findParcel, listActive } from '../src/db/parcels.js'
import { listUnparsedMessages } from '../src/web/queries.js'
import type { CarrierId } from '../src/core/types.js'
import { fakeImap, type FakeMessage } from './imap-fake.js'
import { NOW, bodyHttp, config, memDb, okResult, stubAdapter } from './poll-helpers.js'

const fx = (name: string) => readFileSync(new URL(`./fixtures/mail/${name}.eml`, import.meta.url))
const DAY = 86_400_000
const imap = { host: 'imap.example.com', port: 993, user: 'u@example.com', pass: 'pw', mailbox: 'parcels' }

/** An eml built inline, for cases a fixture would be overkill for. */
const eml = (from: string, subject: string, body: string) =>
  Buffer.from(`From: ${from}\r\nTo: recipient@example.com\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`)

describe('carrierForAddress (registrable domain of the sender)', () => {
  test.each<[string, CarrierId | undefined]>([
    ['noreply@packeta.sk', 'packeta'], ['noreply@packeta.com', 'packeta'], ['x@zasilkovna.cz', 'packeta'],
    ['no_reply@dpd.sk', 'dpd'], ['serv@sps-sro.sk', 'sps'], ['x@mysps.sk', 'sps'],
    ['info@posta.sk', 'posta'], ['x@gls-group.eu', 'gls'], ['x@gls-group.com', 'gls'],
    ['bounce@mg.packeta.sk', 'packeta'],        // any subdomain resolves
    ['NoReply@PACKETA.SK', 'packeta'],          // case-insensitive
    ['x@evilpacketa.sk', undefined],            // a suffix is not a subdomain
    ['x@packeta.sk.evil.example', undefined],
    ['orders@shop.example', undefined],
    ['', undefined],
  ])('%s -> %s', (addr, carrier) => {
    expect(carrierForAddress(addr)).toBe(carrier)
  })
})

describe('extract: real (redacted) mail', () => {
  test('Packeta accepted-for-transport: carrier from the sender, number from the body, spaces removed', async () => {
    expect(await extract(fx('packeta-accepted'))).toMatchObject({
      carrier: 'packeta', number: 'Z0000000001', confidence: 'sender',
    })
  })

  test('Packeta ready for pickup and the Z-BOX mails give the same number', async () => {
    expect((await extract(fx('packeta-ready-zbox'))).number).toBe('Z0000000001')
    expect((await extract(fx('packeta-zbox-next-day'))).number).toBe('Z0000000002')
  })

  test('the Packeta order number is never mistaken for the tracking number', async () => {
    // The body also says "objednávka č. 0000000002": ten digits, but no Z.
    expect((await extract(fx('packeta-zbox-next-day'))).number).toBe('Z0000000002')
  })

  test('DPD (html only, base64): the 14-digit parcel number, not the PIN or the order reference', async () => {
    expect(await extract(fx('dpd-pickup-station'))).toMatchObject({
      carrier: 'dpd', number: '00000000000001', confidence: 'sender',
    })
  })

  test('DPD pickup mail as the live mailbox sends it: multipart/mixed, html + PNG attachment, no text part', async () => {
    // mailparser derives no `text` for this structure; the number is only in the html.
    expect(await extract(fx('dpd-pickup-mixed-attachment'))).toMatchObject({
      carrier: 'dpd', number: '00000000000001', confidence: 'sender', merchant: 'Example Seller # ORDER-0003',
    })
  })

  test('SPS puts the number in the SUBJECT (windows-1250 body): found there', async () => {
    expect(await extract(fx('sps-number-in-subject'))).toMatchObject({
      carrier: 'sps', number: 'SK0TEST0000000000X', confidence: 'sender',
    })
  })

  test('SPS number found in the subject even when the body does not repeat it', async () => {
    const e = await extract(eml('serv@sps-sro.sk', 'Spracovanie zasielky: SK0TEST0000000000X', 'Vazeny zakaznik, vasa zasielka sa spracuva.'))
    expect(e).toMatchObject({ carrier: 'sps', number: 'SK0TEST0000000000X', confidence: 'sender' })
  })

  test('the 703... SPS form is recognised too', async () => {
    const e = await extract(eml('serv@sps-sro.sk', 'Spracovanie zasielky: 7030000000000010', 'x'))
    expect(e).toMatchObject({ carrier: 'sps', number: '7030000000000010' })
  })

  test('Packeta app-verification mail: carrier domain but NO parcel -> no number, confidence none', async () => {
    const e = await extract(fx('packeta-app-verification'))
    expect(e.number).toBeUndefined()
    expect(e.confidence).toBe('none')
    // its 6-digit code and the markup digits must not be read as anything
  })
})

describe('htmlToText', () => {
  test('drops style/script, keeps block boundaries, decodes entities', () => {
    const t = htmlToText('<style>p{color:red}</style><p>A&nbsp;B</p><td>Z&#269; &amp; &#x41;</td><script>x()</script>')
    expect(t.replace(/\s+/g, ' ').trim()).toBe('A B Zč & A')
  })
})

describe('extract: merchant', () => {
  test.each([
    ['packeta-accepted', 'Example Shop'],
    ['packeta-ready-zbox', 'Example Shop'],
    ['packeta-zbox-next-day', 'shop-one.example, shop-two.example'],
    ['sps-number-in-subject', 'example-seller'],
    ['dpd-pickup-station', 'Example Seller # ORDER-0003'],
  ])('%s -> %s', async (name, merchant) => {
    expect((await extract(fx(name))).merchant).toBe(merchant)
  })

  test('control characters are stripped and the length is capped', async () => {
    const e = await extract(eml('serv@sps-sro.sk', 'Spracovanie zasielky: SK0TEST0000000000X',
      `vaša zásielka cislo SK0TEST0000000000X od ${'x'.repeat(300)}\u0007\u001b[31m je pripravená`))
    expect(e.merchant).not.toMatch(/[\u0000-\u001f]/)
    expect(e.merchant!.length).toBeLessThanOrEqual(80)
  })
})

describe('extract: carriers without a fixture from the real mailbox', () => {
  test('Slovenská pošta', async () => {
    expect(await extract(fx('synthetic-posta-notification'))).toMatchObject({
      carrier: 'posta', number: 'RR000000001SK', confidence: 'sender',
    })
  })
  test('GLS (bare digits are only trusted because the sender says GLS)', async () => {
    expect(await extract(fx('synthetic-gls-notification'))).toMatchObject({
      carrier: 'gls', number: '000000000001', confidence: 'sender',
    })
  })
})

describe('extract: hand-forwarded mail (wrapper is the fallback)', () => {
  test('reads the original sender from the Gmail wrapper, not the envelope', async () => {
    const e = await extract(fx('synthetic-gmail-forwarded-dpd'))
    expect(e).toMatchObject({ carrier: 'dpd', number: '00000000000001', confidence: 'sender' })
  })

  test('the envelope sender wins when it is itself a carrier (no wrapper needed)', async () => {
    expect((await extract(fx('packeta-accepted'))).carrier).toBe('packeta')
  })
})

describe('extract: no sender hint', () => {
  test('falls back to shape detection for a distinctive number, and reports that confidence', async () => {
    const e = await extract(fx('synthetic-eshop-dispatch-packeta'))
    expect(e).toMatchObject({ carrier: 'packeta', number: 'Z0000000003', confidence: 'shape' })
    expect(e.merchant).toBe('Example Shop')   // the e-shop, from the sender display name
  })

  test('an e-shop mail naming GLS with a bare 12-digit number is ambiguous: needs attention, not a guess', async () => {
    const e = await extract(fx('synthetic-eshop-dispatch-gls'))
    expect(e.confidence).toBe('none')
    expect(e.number).toBeUndefined()
  })

  test('a newsletter with number-like strings but no carrier yields confidence none', async () => {
    const e = await extract(fx('synthetic-newsletter-number-like'))
    expect(e).toMatchObject({ confidence: 'none' })
    expect(e.number).toBeUndefined()
  })

  test('a mail with no number at all yields confidence none', async () => {
    expect((await extract(fx('synthetic-no-number'))).confidence).toBe('none')
  })

  test('two different distinctive numbers from different carriers are ambiguous, not a guess', async () => {
    const e = await extract(eml('orders@shop.example', 'Shipped', 'Packeta Z 000 0000 003 and Posta RR000000001SK'))
    expect(e.confidence).toBe('none')
  })

  test('garbage that is not a mail never throws', async () => {
    expect((await extract(Buffer.from([0, 255, 1, 2, 3]))).confidence).toBe('none')
    expect((await extract(Buffer.alloc(0))).confidence).toBe('none')
  })
})

// ---------------------------------------------------------------------------------------------

const NOISE_SUBJECT = 'Verification of your e-mail in the Packeta app'

/** A FakeMessage from an eml, dated `daysOld` before NOW. */
function mail(uid: number, name: string, daysOld: number, over: Partial<FakeMessage> = {}): FakeMessage {
  const source = fx(name)
  return {
    uid, source, messageId: `<${name}-${uid}@fixture>`,
    subject: /^Subject: (.*)$/m.exec(source.toString('latin1'))?.[1] ?? name,
    from: /^From: .*<(.+?)>/m.exec(source.toString('latin1'))?.[1] ?? 'x@example.com',
    date: new Date(NOW.getTime() - daysOld * DAY), ...over,
  }
}

const counts = (db: ReturnType<typeof memDb>) => ({
  parcels: (db.prepare('SELECT COUNT(*) n FROM parcels').get() as { n: number }).n,
  messages: (db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n,
})

function setup(messages: FakeMessage[], over: Partial<IngestDeps> = {}) {
  const db = memDb()
  const fake = fakeImap(messages)
  const deps: IngestDeps = {
    imap, client: fake.client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-ingest-')),
    now: NOW, adapters: allAdapters(), defaultPostalCode: '81101', ...over,
  }
  return { db, fake, deps }
}

describe('ingestMessages', () => {
  test('creates one parcel per new message, links it, and records where it came from', async () => {
    const { db, deps } = setup([mail(1, 'packeta-accepted', 2), mail(2, 'dpd-pickup-station', 3)])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 2, created: 2, needsAttention: 0 })

    const p = findParcel(db, 'packeta', 'Z0000000001')!
    expect(p).toMatchObject({
      source: 'email', merchant: 'Example Shop', postalCode: '81101', sourceMessageId: '<packeta-accepted-1@fixture>',
    })
    expect(p.archivedAt).toBeUndefined()
    const row = db.prepare('SELECT parsed_ok, parcel_id, raw_path FROM messages WHERE message_id = ?')
      .get('<packeta-accepted-1@fixture>') as { parsed_ok: number; parcel_id: number; raw_path: string }
    expect(row).toMatchObject({ parsed_ok: 1, parcel_id: p.id })
    expect(readFileSync(row.raw_path).equals(fx('packeta-accepted'))).toBe(true)
  })

  test('several mails about one parcel make one parcel, all linked to it', async () => {
    const { db, deps } = setup([
      mail(1, 'packeta-accepted', 5), mail(2, 'packeta-ready-zbox', 1),
    ])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 2, created: 1, linked: 1, needsAttention: 0 })
    expect(counts(db).parcels).toBe(1)
    const ids = db.prepare('SELECT DISTINCT parcel_id FROM messages').all()
    expect(ids).toHaveLength(1)
  })

  test('a re-forwarded duplicate does not create a second parcel (same Message-ID, then a new one for the same number)', async () => {
    const { db, deps } = setup([mail(1, 'packeta-accepted', 2)])
    await ingestMessages(db, deps)

    // The label is re-read in full every run; the stored Message-ID is skipped without a second download.
    const fake2 = fakeImap([mail(1, 'packeta-accepted', 2)])
    const r2 = await ingestMessages(db, { ...deps, client: fake2.client })
    expect(r2).toMatchObject({ read: 0, created: 0 })
    expect(fake2.downloaded).toEqual([])

    // The same parcel announced by a different message links to the existing parcel.
    const fake3 = fakeImap([mail(7, 'packeta-accepted', 1, { messageId: '<resent@fixture>' })])
    const r3 = await ingestMessages(db, { ...deps, client: fake3.client })
    expect(r3).toMatchObject({ read: 1, created: 0, linked: 1 })
    expect(counts(db)).toEqual({ parcels: 1, messages: 2 })
  })

  test('a later mail fills in the merchant when the first one did not name it', async () => {
    const bare = eml('noreply@packeta.sk', 'Zásielka bola prijatá do prepravy', 'Číslo zásielky Z 000 0000 005')
    const named = eml('noreply@packeta.sk', 'Zásielka je pripravená', 'Číslo zásielky Z 000 0000 005. vaša zásielka od odosielateľa Example Shop je pre vás pripravená')
    const mk = (uid: number, source: Buffer, daysOld: number): FakeMessage =>
      ({ uid, source, messageId: `<m${uid}@fixture>`, subject: 's', from: 'noreply@packeta.sk', date: new Date(NOW.getTime() - daysOld * DAY) })
    const { db, deps } = setup([mk(1, bare, 3), mk(2, named, 1)])
    await ingestMessages(db, deps)
    expect(findParcel(db, 'packeta', 'Z0000000005')!.merchant).toBe('Example Shop')
  })

  test('the Packeta app-verification mail lands in needs-attention and creates NO parcel', async () => {
    const { db, deps } = setup([mail(1, 'packeta-app-verification', 2)])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 1, created: 0, needsAttention: 1 })
    expect(counts(db).parcels).toBe(0)
    const waiting = listUnparsedMessages(db)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ subject: NOISE_SUBJECT, from: 'noreply@packeta.com' })
    expect(waiting[0]!.note).toMatch(/no tracking number/i)
  })

  test('unparsed mail is recorded with parsed_ok = 0 and never dropped', async () => {
    const { db, deps } = setup([
      mail(1, 'synthetic-newsletter-number-like', 1), mail(2, 'synthetic-no-number', 1), mail(3, 'synthetic-eshop-dispatch-gls', 1),
    ])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 3, created: 0, needsAttention: 3 })
    expect(db.prepare('SELECT COUNT(*) n FROM messages WHERE parsed_ok = 0 AND parcel_id IS NULL').get()).toEqual({ n: 3 })
    expect(counts(db).parcels).toBe(0)
  })

  test('a number for a carrier with no registered adapter is not tracked: needs-attention with a note', async () => {
    const { db, deps } = setup([mail(1, 'packeta-accepted', 1)], { adapters: allAdapters().filter(a => a.id !== 'packeta') })
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ created: 0, needsAttention: 1 })
    expect(listUnparsedMessages(db)[0]!.note).toMatch(/no adapter registered for packeta/i)
    expect(counts(db).parcels).toBe(0)
  })

  test('a message over the size cap lands in needs-attention without being downloaded', async () => {
    const { db, deps, fake } = setup([mail(1, 'packeta-accepted', 1, { size: 50_000_000 })])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 1, created: 0, needsAttention: 1 })
    expect(fake.downloaded).toEqual([])
    expect(listUnparsedMessages(db)[0]!.note).toMatch(/size cap/i)
  })

  test('the ingest never writes an IMAP flag, move or delete', async () => {
    const { db, deps, fake } = setup([
      mail(1, 'packeta-accepted', 2), mail(2, 'packeta-app-verification', 2), mail(3, 'sps-number-in-subject', 90),
    ])
    await ingestMessages(db, deps)
    expect(fake.forbidden).toEqual([])
    expect(fake.locks.every(l => l.readOnly)).toBe(true)
  })

  test('a malformed message is recorded for attention instead of aborting the batch', async () => {
    const { db, deps } = setup([
      mail(1, 'synthetic-no-number', 1, { source: Buffer.from([0, 255, 254, 1]) }), mail(2, 'packeta-accepted', 1),
    ])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 2, created: 1, needsAttention: 1 })
  })
})

describe('ingestMessages: mail from before the parcel is of any interest is created ARCHIVED', () => {
  test(`a message older than ${ARCHIVE_AFTER_DAYS} days creates an archived parcel`, async () => {
    const { db, deps } = setup([mail(1, 'packeta-accepted', ARCHIVE_AFTER_DAYS + 0.01)])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ created: 1, archivedOld: 1 })
    const p = findParcel(db, 'packeta', 'Z0000000001')!
    expect(p.archivedAt).toEqual(NOW)
    expect(listActive(db)).toEqual([])
  })

  test(`a message within ${ARCHIVE_AFTER_DAYS} days creates an active parcel`, async () => {
    const { db, deps } = setup([mail(1, 'packeta-accepted', ARCHIVE_AFTER_DAYS - 0.01)])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ created: 1, archivedOld: 0 })
    expect(findParcel(db, 'packeta', 'Z0000000001')!.archivedAt).toBeUndefined()
    expect(listActive(db)).toHaveLength(1)
  })

  test('the boundary is exact: precisely 30 days old is still active, a minute older is not', async () => {
    const a = setup([mail(1, 'packeta-accepted', ARCHIVE_AFTER_DAYS)])
    await ingestMessages(a.db, a.deps)
    expect(findParcel(a.db, 'packeta', 'Z0000000001')!.archivedAt).toBeUndefined()

    const b = setup([mail(1, 'packeta-accepted', ARCHIVE_AFTER_DAYS, { date: new Date(NOW.getTime() - ARCHIVE_AFTER_DAYS * DAY - 60_000) })])
    await ingestMessages(b.db, b.deps)
    expect(findParcel(b.db, 'packeta', 'Z0000000001')!.archivedAt).toEqual(NOW)
  })

  test('uses the message\'s own Date, not the time it was fetched', async () => {
    const { db, deps } = setup([mail(1, 'packeta-accepted', 400)])
    await ingestMessages(db, { ...deps, now: new Date(NOW.getTime() + 1) })
    expect(findParcel(db, 'packeta', 'Z0000000001')!.archivedAt).toBeDefined()
  })

  test('a parcel whose FIRST mail is old but whose latest mail is recent stays active', async () => {
    const { db, deps } = setup([mail(1, 'packeta-accepted', 45), mail(2, 'packeta-ready-zbox', 2)])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ created: 1, archivedOld: 0 })
    expect(findParcel(db, 'packeta', 'Z0000000001')!.archivedAt).toBeUndefined()
  })

  test('first-run stampede: three years of mail creates parcels but polls none of them', async () => {
    // 25 distinct old parcels, one message each.
    const msgs = Array.from({ length: 25 }, (_, i) => {
      const n = String(i + 1).padStart(10, '0')
      const source = eml('noreply@packeta.sk', 'Zásielka je pripravená na vyzdvihnutie', `Číslo zásielky Z ${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)}`)
      return { uid: i + 1, source, messageId: `<old-${i}@fixture>`, subject: 'Zásielka je pripravená na vyzdvihnutie',
        from: 'noreply@packeta.sk', date: new Date(NOW.getTime() - (100 + i * 30) * DAY) }
    })
    const { db, deps } = setup(msgs)
    const adapter = stubAdapter('packeta', inputs => inputs.map(i => okResult(i.number, [])))
    const report = await runPoll({
      db, http: bodyHttp(), adapters: [adapter], config, now: NOW, ingest: { imap, client: deps.client, mailDir: deps.mailDir },
    })
    expect(report.ingest).toMatchObject({ created: 25, archivedOld: 25 })
    expect(counts(db).parcels).toBe(25)
    expect(adapter.calls).toEqual([])        // nothing polled
    expect(report.polled).toBe(0)
  })
})

describe('reprocessing', () => {
  test('a stored message can be reprocessed from disk after a parser change, without IMAP', async () => {
    const db = memDb()
    const dir = mkdtempSync(join(tmpdir(), 'parcels-reproc-'))
    // The ingest of the day could not read it (as if the parser then did not know this shape).
    const first = setup([mail(1, 'packeta-accepted', 2)], { adapters: allAdapters().filter(a => a.id !== 'packeta'), mailDir: dir })
    await ingestMessages(db, first.deps)
    expect(counts(db)).toEqual({ parcels: 0, messages: 1 })

    // Parser fixed (adapter now registered): reprocess from the stored .eml, offline.
    const r = await reprocessMessages(db, { mailDir: dir, now: NOW, adapters: allAdapters(), defaultPostalCode: '81101' })
    expect(r).toMatchObject({ created: 1, needsAttention: 0 })
    expect(findParcel(db, 'packeta', 'Z0000000001')).toBeDefined()
    expect(listUnparsedMessages(db)).toEqual([])
  })

  test('a message already assigned by hand is left alone', async () => {
    const db = memDb()
    const dir = mkdtempSync(join(tmpdir(), 'parcels-reproc-'))
    const s = setup([mail(1, 'packeta-app-verification', 2)], { mailDir: dir })
    await ingestMessages(db, s.deps)
    const id = (db.prepare('SELECT id FROM messages').get() as { id: number }).id
    // Corrupt the file: reprocessing must not even read a row that is no longer unassigned.
    const path = (db.prepare('SELECT raw_path FROM messages').get() as { raw_path: string }).raw_path
    writeFileSync(path, 'garbage')
    db.prepare("INSERT INTO parcels (carrier, tracking_number, status, first_seen_at, source) VALUES ('gls','000000000009','unknown','x','manual')").run()
    db.prepare('UPDATE messages SET parsed_ok = 1, parcel_id = 1 WHERE id = ?').run(id)
    const r = await reprocessMessages(db, { mailDir: dir, now: NOW, adapters: allAdapters(), defaultPostalCode: '81101' })
    expect(r).toMatchObject({ created: 0, needsAttention: 0 })
  })
})

describe('runPoll wiring', () => {
  test('ingest runs first, so a parcel found in mail is polled in the very same run', async () => {
    const db = memDb()
    const fake = fakeImap([mail(1, 'packeta-accepted', 1)])
    const adapter = stubAdapter('packeta', inputs => inputs.map(i => okResult(i.number, [])))
    // first_seen_at is the wall clock inside insertParcel; the poll is due because it was never polled
    const report = await runPoll({
      db, http: bodyHttp(), adapters: [adapter], config, now: new Date(),
      ingest: { imap, client: fake.client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-wire-')) },
    })
    expect(report.ingest).toMatchObject({ created: 1 })
    expect(adapter.calls.flat().map(i => i.number)).toEqual(['Z0000000001'])
    expect(report.polled).toBe(1)
  })

  test('an IMAP failure is reported and does not stop carrier polling', async () => {
    const db = memDb()
    const down = fakeImap([], { connectError: new Error('getaddrinfo ENOTFOUND imap.example.com') })
    const existing = db.prepare("INSERT INTO parcels (carrier, tracking_number, status, first_seen_at, source) VALUES ('packeta','Z0000000009','unknown',?,'manual')")
    existing.run(new Date().toISOString())
    const adapter = stubAdapter('packeta', inputs => inputs.map(i => okResult(i.number, [])))
    const report = await runPoll({
      db, http: bodyHttp(), adapters: [adapter], config, now: new Date(),
      ingest: { imap, client: down.client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-wire-')) },
    })
    expect(report.ingest?.error).toMatch(/ENOTFOUND/)
    expect(report.polled).toBe(1)
    expect(summarize(report)).toMatch(/mail ingest failed: .*ENOTFOUND/)
  })

  test('without ingest configured nothing changes', async () => {
    const db = memDb()
    const report = await runPoll({ db, http: bodyHttp(), adapters: [], config, now: NOW })
    expect(report.ingest).toBeUndefined()
    expect(summarize(report)).toBe('polled 0 parcel(s), 0 new event(s)')
  })
})
