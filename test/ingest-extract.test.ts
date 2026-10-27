import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
import { healthPage } from '../src/web/views/health.js'
import { getIngestStatus } from '../src/db/ingest-status.js'
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
  test('hostile html stays linear: unclosed <style and a wall of "<" finish promptly', () => {
    const t0 = Date.now()
    htmlToText('<style '.repeat(150_000))
    htmlToText('<'.repeat(900_000))
    htmlToText('<p'.repeat(450_000))
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  test('an unclosed <style> block swallows the rest instead of rescanning for every opener', () => {
    expect(htmlToText('keep <style>a{} never closed Z0000000001').trim()).toBe('keep')
  })

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

  test('GLS: a phone number printed BEFORE the parcel number does not win (12 digits, like a +421 number)', async () => {
    expect(await extract(fx('synthetic-gls-phone-first'))).toMatchObject({ carrier: 'gls', number: '000000000001' })
  })

  test('GLS: with no label at all, a phone-shaped candidate loses to a non-phone one', async () => {
    const e = await extract(eml('noreply@gls-group.eu', 'Your parcel', 'Tel: 421900123456\r\nYour reference 000000000007 is on its way'))
    expect(e.number).toBe('000000000007')
  })

  test('GLS: a 10-digit number (the length of the first real parcel) is found when the sender is GLS', async () => {
    const e = await extract(eml('noreply@gls-group.eu', 'Your parcel', 'Parcel number: 1234567890. Expected tomorrow.'))
    expect(e).toMatchObject({ carrier: 'gls', number: '1234567890', confidence: 'sender' })
  })

  test('GLS: a 10-digit national-format phone number printed first does not win over the parcel number', async () => {
    const e = await extract(eml('noreply@gls-group.eu', 'Your parcel', 'Questions? 0900123456\r\nParcel 1234567890'))
    expect(e.number).toBe('1234567890')
  })

  test('GLS: 9 and 13 digit runs are not read as a parcel number', async () => {
    expect((await extract(eml('noreply@gls-group.eu', 'Your parcel', 'ref 123456789 and 1234567890123'))).confidence).toBe('none')
  })

  test('GLS: if the phone-shaped number is all there is, it is still returned (needs-attention is for NO candidate)', async () => {
    expect((await extract(eml('noreply@gls-group.eu', 'Your parcel', 'ref 421900123456'))).number).toBe('421900123456')
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

  // THE REAL PAIR. MTBIKER sent two mails for one order, from the same sender, both naming GLS:
  //   - the dispatch mail ("... odoslaná") prints "Číslo zásielky je <number>"  -> must extract
  //   - the order confirmation (this one)  has NO tracking number              -> must NOT extract
  // The negative case is deliberate and as important as the positive one: it carries a 12-digit phone number
  // and a 10-digit id inside a URL token, which a looser "GLS named + any number" rule would turn into a
  // bogus parcel. Do not "fix" it to extract.
  test('real e-shop mail 1/2, the DISPATCH mail: names GLS and prints "Číslo zásielky je <number>" -> shape', async () => {
    const e = await extract(fx('mtbiker-dispatch-names-gls'))
    expect(e).toEqual({ carrier: 'gls', number: '1234567890', merchant: 'MTBIKER shop', confidence: 'shape' })
  })

  test('real e-shop mail 2/2, the ORDER CONFIRMATION for the same order: names GLS, prints no tracking number -> none', async () => {
    const e = await extract(fx('mtbiker-order-confirmation-names-gls'))
    expect(e).toEqual({ confidence: 'none' })
  })

  describe('e-shop dispatch mail: a named carrier AND a labelled number of its shape, both required', () => {
    const shop = 'MTBIKER shop <objednavky@mtbiker.sk>'

    // Synthetic cases below; the REAL e-shop mail is tested above ("real e-shop mail 1/2").
    test('(synthetic) English dispatch mail naming GLS with a labelled 12-digit number -> shape, merchant from the sender', async () => {
      const e = await extract(fx('synthetic-eshop-dispatch-gls'))
      expect(e).toMatchObject({ carrier: 'gls', number: '000000000001', confidence: 'shape', merchant: 'Example Shop' })
    })

    test.each([
      ['10 digits (the length of the first real GLS parcel)', '1234567890'],
      ['11 digits', '12345678901'],
      ['12 digits', '123456789012'],
    ])('Slovak dispatch mail, GLS ParcelShop, %s', async (_, n) => {
      const e = await extract(eml(shop, 'Objednávka č. 0000004 bola odoslaná',
        `Tvoju objednávku sme odovzdali GLS ParcelShopu.\r\nČíslo balíka: ${n}\r\nSledovanie na gls-group.com.`))
      expect(e).toMatchObject({ carrier: 'gls', number: n, confidence: 'shape', merchant: 'MTBIKER shop' })
    })

    test('the carrier may be named in the subject while the number is in the body', async () => {
      const e = await extract(eml(shop, 'Objednávka odoslaná cez GLS', 'Sledovacie číslo: 1234567890'))
      expect(e).toMatchObject({ carrier: 'gls', number: '1234567890', confidence: 'shape' })
    })

    test('DPD named with a labelled 14-digit number', async () => {
      const e = await extract(eml(shop, 'Vaša zásielka je na ceste', 'Doručí DPD. Číslo balíka: 00000000000001'))
      expect(e).toMatchObject({ carrier: 'dpd', number: '00000000000001', confidence: 'shape' })
    })

    test.each([
      ['Packeta', 'Odoslané cez Packeta. Sledovanie: Z 000 0000 003', 'packeta', 'Z0000000003'],
      ['Zásielkovňa', 'Odoslané cez Zásielkovňu. Číslo zásielky Z0000000004', 'packeta', 'Z0000000004'],
      ['Slovenská pošta', 'Odoslané Slovenskou poštou, číslo RR000000001SK', 'posta', 'RR000000001SK'],
      ['SPS', 'Odoslané cez SPS, číslo 7030000000000010', 'sps', '7030000000000010'],
    ] as const)('%s: its own distinctive shape still works', async (_, body, carrier, number) => {
      expect(await extract(eml(shop, 'Objednávka odoslaná', body))).toMatchObject({ carrier, number, confidence: 'shape' })
    })

    test('a carrier name alone (no number) -> none', async () => {
      expect(await extract(eml(shop, 'Objednávka odoslaná cez GLS', 'Balík vám doručí GLS ParcelShop. Ďakujeme.')))
        .toEqual({ confidence: 'none' })
    })

    test('a labelled number alone (no carrier named) -> none', async () => {
      expect(await extract(eml(shop, 'Objednávka odoslaná', 'Číslo balíka: 1234567890'))).toEqual({ confidence: 'none' })
    })

    test('a carrier named and a bare number with NO tracking label -> none', async () => {
      expect(await extract(eml(shop, 'Odoslané cez GLS', 'Ďakujeme, 1234567890 je kód pre kupón.'))).toEqual({ confidence: 'none' })
    })

    test.each([
      ['an order number', 'Číslo objednávky: 1234567890'],
      ['an English order number', 'Order number: 1234567890'],
      ['an invoice number', 'Číslo faktúry: 1234567890'],
      ['a phone number', 'Telefónne číslo: 1234567890'],
      ['a national-format phone number', 'Číslo balíka: 0900123456'],
      ['a +421 phone number', 'Phone number: 421900123456'],
    ])('a GLS-named mail whose only labelled number is %s -> none', async (_, line) => {
      expect(await extract(eml(shop, 'Odoslané cez GLS', line))).toEqual({ confidence: 'none' })
    })

    test('a number cut out of a longer alphanumeric token is not taken', async () => {
      expect(await extract(eml(shop, 'Odoslané cez GLS', 'Číslo balíka: 5523b1793017928'))).toEqual({ confidence: 'none' })
    })

    test('9 and 13 digits are not a GLS number', async () => {
      expect(await extract(eml(shop, 'Odoslané cez GLS', 'Číslo balíka: 123456789'))).toEqual({ confidence: 'none' })
      expect(await extract(eml(shop, 'Odoslané cez GLS', 'Číslo balíka: 1234567890123'))).toEqual({ confidence: 'none' })
    })

    test('two different labelled numbers are ambiguous, not a guess', async () => {
      expect(await extract(eml(shop, 'Odoslané cez GLS', 'Číslo balíka: 1234567890\r\nČíslo balíka: 1234567891')))
        .toEqual({ confidence: 'none' })
    })

    test('two carriers each named with their own labelled number are ambiguous -> none', async () => {
      expect(await extract(eml(shop, 'Odoslané', 'Balík 1 cez GLS, číslo balíka: 1234567890\r\nBalík 2 cez DPD, číslo balíka: 00000000000001')))
        .toEqual({ confidence: 'none' })
    })

    test('"GLS" inside another word is not the carrier', async () => {
      expect(await extract(eml(shop, 'Odoslané', 'Angels and OGLS. Číslo balíka: 1234567890'))).toEqual({ confidence: 'none' })
    })

    test('a known carrier sender is unaffected: it still goes through the sender path', async () => {
      expect(await extract(eml('noreply@gls-group.eu', 'Your parcel', 'Parcel number: 1234567890')))
        .toMatchObject({ carrier: 'gls', confidence: 'sender' })
    })
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

  test('of the real MTBIKER pair, the dispatch mail makes a gls parcel and the confirmation goes to needs-attention', async () => {
    const { db, deps } = setup([mail(1, 'mtbiker-order-confirmation-names-gls', 2), mail(2, 'mtbiker-dispatch-names-gls', 1)])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 2, created: 1, needsAttention: 1 })
    expect(findParcel(db, 'gls', '1234567890')).toMatchObject({ source: 'email', merchant: 'MTBIKER shop' })
    expect(listUnparsedMessages(db)).toHaveLength(1)
  })

  test('an e-shop dispatch mail naming GLS creates a gls parcel, labelled with the shop, the first notice of it', async () => {
    const { db, deps } = setup([mail(1, 'synthetic-eshop-dispatch-gls', 1)])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 1, created: 1, needsAttention: 0 })
    expect(findParcel(db, 'gls', '000000000001')).toMatchObject({ source: 'email', merchant: 'Example Shop', postalCode: '81101' })
    expect(listUnparsedMessages(db)).toEqual([])
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
      mail(1, 'synthetic-newsletter-number-like', 1), mail(2, 'synthetic-no-number', 1), mail(3, 'mtbiker-order-confirmation-names-gls', 1),
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
    const r = await reprocessMessages(db, { now: NOW, adapters: allAdapters(), defaultPostalCode: '81101' })
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
    const r = await reprocessMessages(db, { now: NOW, adapters: allAdapters(), defaultPostalCode: '81101' })
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

// --- fix round 1 ---------------------------------------------------------------------------------

describe('ingestMessages: dates', () => {
  test('a bogus-old Date header does not archive a fresh parcel on arrival (INTERNALDATE is the later)', async () => {
    const { db, deps } = setup([mail(1, 'packeta-accepted', 1, {
      date: new Date('2020-01-01T00:00:00Z'), internalDate: new Date(NOW.getTime() - DAY),
    })])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ created: 1, archivedOld: 0 })
    expect(findParcel(db, 'packeta', 'Z0000000001')!.archivedAt).toBeUndefined()
  })

  test('a parcel archived on arrival is first seen when its mail was, and its status stays unknown', async () => {
    const { db, deps } = setup([mail(1, 'packeta-accepted', 200)])
    await ingestMessages(db, deps)
    const p = findParcel(db, 'packeta', 'Z0000000001')!
    expect(p.archivedAt).toEqual(NOW)
    expect(p.firstSeenAt).toEqual(new Date(NOW.getTime() - 200 * DAY))
    expect(p.status).toBe('unknown')       // status never comes from mail
  })

  test('a live parcel is first seen NOW (the backoff and dormancy clocks run from it)', async () => {
    const { db, deps } = setup([mail(1, 'packeta-accepted', 2)])
    const before = Date.now()
    await ingestMessages(db, deps)
    expect(findParcel(db, 'packeta', 'Z0000000001')!.firstSeenAt.getTime()).toBeGreaterThanOrEqual(before)
  })
})

describe('ingestMessages: one message is one unit', () => {
  const three = () => [
    mail(1, 'packeta-accepted', 3),                        // Z...01
    mail(2, 'packeta-zbox-next-day', 2),                   // Z...02
    mail(3, 'synthetic-eshop-dispatch-packeta', 1),        // Z...03
  ]
  const rows = (db: ReturnType<typeof memDb>) => db.prepare('SELECT message_id, parsed_ok, parcel_id FROM messages ORDER BY id').all()

  test('a throw while STORING message k (disk) rolls that message back; the earlier ones stay placed, and the next run retries it', async () => {
    const s = setup(three())
    // The third message gets row id 3 (a rolled-back id is reused, so only the LAST message can be singled
    // out by id). A directory in the way of 3.eml makes the rename fail (EISDIR/ENOTEMPTY).
    mkdirSync(join(s.deps.mailDir, '3.eml', 'x'), { recursive: true })
    const r = await ingestMessages(s.db, s.deps)
    expect(r).toMatchObject({ read: 3, created: 2, failed: 1 })
    expect(findParcel(s.db, 'packeta', 'Z0000000001')).toBeDefined()
    expect(findParcel(s.db, 'packeta', 'Z0000000002')).toBeDefined()
    expect(findParcel(s.db, 'packeta', 'Z0000000003')).toBeUndefined()
    // No stranded row: the failed message is not "known", so it is fetched again.
    expect(s.db.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 2 })
    expect(s.db.prepare('SELECT COUNT(*) n FROM messages WHERE parsed_ok = 0 AND parcel_id IS NULL').get()).toEqual({ n: 0 })

    // Disk fixed: the next run places exactly the one that failed.
    const fake = fakeImap(three())
    const again = await ingestMessages(s.db, { ...s.deps, client: fake.client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-fixed-')) })
    expect(again).toMatchObject({ read: 1, created: 1, failed: 0 })
    expect(findParcel(s.db, 'packeta', 'Z0000000003')).toBeDefined()
    expect(counts(s.db)).toEqual({ parcels: 3, messages: 3 })
  })

  test('a throw while PLACING message k (database) rolls it back whole; the others still land; nothing is stranded', async () => {
    const s = setup(three())
    s.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON parcels WHEN NEW.tracking_number = 'Z0000000002'
               BEGIN SELECT RAISE(ABORT, 'SQLITE_BUSY (simulated)'); END`)
    const r = await ingestMessages(s.db, s.deps)
    expect(r).toMatchObject({ read: 3, created: 2, failed: 1 })
    expect(rows(s.db)).toHaveLength(2)                              // no stored-but-unplaced row
    expect((rows(s.db) as Array<{ parsed_ok: number }>).every(m => m.parsed_ok === 1)).toBe(true)

    s.db.exec('DROP TRIGGER boom')
    const again = await ingestMessages(s.db, { ...s.deps, client: fakeImap(three()).client })
    expect(again).toMatchObject({ read: 1, created: 1, failed: 0 })
    expect(counts(s.db)).toEqual({ parcels: 3, messages: 3 })
  })

  test('counts only reflect committed messages (a rolled-back creation is not "created")', async () => {
    const s = setup([mail(1, 'packeta-accepted', 40)])      // old -> would be archived on arrival
    s.db.exec(`CREATE TRIGGER boom2 BEFORE UPDATE OF archived_at ON parcels BEGIN SELECT RAISE(ABORT, 'x'); END`)
    const r = await ingestMessages(s.db, s.deps)
    expect(r).toMatchObject({ created: 0, archivedOld: 0, failed: 1 })
    expect(counts(s.db)).toEqual({ parcels: 0, messages: 0 })
  })
})

describe('ingest health', () => {
  const status = (db: ReturnType<typeof memDb>) =>
    db.prepare('SELECT consecutive_failures n, last_ok_at ok, last_error e, notified_at nt FROM ingest_status').get() as
      { n: number; ok: string | null; e: string | null; nt: string | null }
  const run = async (db: ReturnType<typeof memDb>, client: ReturnType<typeof fakeImap>['client'], at: Date, notifier?: { send(n: unknown): Promise<void> }) =>
    runPoll({
      db, http: bodyHttp(), adapters: [], config, now: at, notifier: notifier as never,
      ingest: { imap, client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-health-')) },
    })
  const down = () => fakeImap([], { connectError: new Error('Invalid credentials (Failure)') }).client
  const up = () => fakeImap([]).client

  test('a failed run is recorded, a good run resets it', async () => {
    const db = memDb()
    await run(db, down(), NOW)
    expect(status(db)).toMatchObject({ n: 1, e: 'Error: Invalid credentials (Failure)', ok: null })
    await run(db, down(), new Date(NOW.getTime() + 3_600_000))
    expect(status(db).n).toBe(2)
    await run(db, up(), new Date(NOW.getTime() + 7_200_000))
    expect(status(db)).toMatchObject({ n: 0, nt: null })
    expect(status(db).ok).not.toBeNull()
  })

  test('a run in which messages fail to store is a FAILED ingest run, not ok, and the Health page says so', async () => {
    const db = memDb()
    const mailDir = mkdtempSync(join(tmpdir(), 'parcels-health-'))
    mkdirSync(join(mailDir, '1.eml', 'x'), { recursive: true })   // the rename of message 1's .eml fails
    const client = fakeImap([mail(1, 'packeta-accepted', 2)]).client
    const report = await runPoll({ db, http: bodyHttp(), adapters: [], config, now: NOW, ingest: { imap, client, mailDir } })
    expect(report.ingest).toMatchObject({ read: 1, created: 0, failed: 1 })
    expect(status(db)).toMatchObject({ n: 1, ok: null })
    expect(status(db).e).toMatch(/1 of 1 new message\(s\) failed/)
    const page = healthPage([], { configured: true, status: getIngestStatus(db) }, { overdue: false }, { now: NOW, health: [] }).toString()
    expect(page).toContain('failing')
    expect(page).toContain('1 of 1 new message(s) failed')
  })

  test('no ingest configured -> no ingest_status row at all', async () => {
    const db = memDb()
    await runPoll({ db, http: bodyHttp(), adapters: [], config, now: NOW })
    expect(db.prepare('SELECT COUNT(*) n FROM ingest_status').get()).toEqual({ n: 0 })
  })

  test('ONE notification after 3 consecutive failures, none for the 4th, and a new one for the next outage', async () => {
    const db = memDb()
    const sent: Array<{ groupKey: string; title: string }> = []
    const notifier = { send: async (n: { groupKey: string; title: string }) => { sent.push(n) } }
    const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000)

    await run(db, down(), at(0), notifier)
    await run(db, down(), at(1), notifier)
    expect(sent).toEqual([])                                   // not yet: two failures is a blip
    await run(db, down(), at(2), notifier)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ groupKey: 'ingest', title: 'Mail ingest is failing' })
    await run(db, down(), at(3), notifier)
    await run(db, down(), at(4), notifier)
    expect(sent).toHaveLength(1)                               // still the same outage

    await run(db, up(), at(5), notifier)                       // recovery clears the stamp
    for (const h of [6, 7, 8]) await run(db, down(), at(h), notifier)
    expect(sent).toHaveLength(2)                               // a new outage is announced afresh
  })

  test('the banner never carries the raw error (it can name hosts); the Health page shows it instead', async () => {
    const db = memDb()
    const sent: Array<{ message: string }> = []
    const notifier = { send: async (n: { message: string }) => { sent.push(n) } }
    for (let h = 0; h < 3; h++) await run(db, down(), new Date(NOW.getTime() + h * 3_600_000), notifier)
    expect(sent[0]!.message).not.toMatch(/credentials/i)
    expect(sent[0]!.message).toMatch(/3 runs in a row/)
  })

  test('held back (not spent) when every carrier also failed in that run: the Mac is offline', async () => {
    const db = memDb()
    const sent: Array<{ groupKey: string }> = []
    const notifier = { send: async (n: { groupKey: string }) => { sent.push(n) } }
    const dead = (id: 'packeta' | 'dpd') => stubAdapter(id, () => { throw new Error('offline') })
    const mkRun = (at: Date, client = down()) => {
      return runPoll({
        db, http: bodyHttp(), adapters: [dead('packeta'), dead('dpd')], config, now: at, notifier: notifier as never,
        ingest: { imap, client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-health-')) },
      })
    }
    db.prepare("INSERT INTO parcels (carrier, tracking_number, status, first_seen_at, source) VALUES ('packeta','Z0000000008','unknown',?,'manual'),('dpd','00000000000008','unknown',?,'manual')")
      .run(NOW.toISOString(), NOW.toISOString())
    for (const h of [0, 1, 2]) await mkRun(new Date(NOW.getTime() + h * 3_600_000))
    expect(sent.filter(n => n.groupKey === 'ingest')).toEqual([])
    expect(db.prepare('SELECT notified_at FROM ingest_status').get()).toEqual({ notified_at: null })
  })
})

describe('mail directory permissions through the ingest', () => {
  test('raw mail lands owner-only', async () => {
    const { db, deps } = setup([mail(1, 'packeta-accepted', 2)], { mailDir: join(mkdtempSync(join(tmpdir(), 'parcels-perm-')), 'mail') })
    await ingestMessages(db, deps)
    expect(statSync(deps.mailDir).mode & 0o777).toBe(0o700)
    const path = (db.prepare('SELECT raw_path FROM messages').get() as { raw_path: string }).raw_path
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
