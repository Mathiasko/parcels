import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { simpleParser } from 'mailparser'
import { carrierForAddress, extract, htmlToText, pickupFromMail } from '../src/ingest/extract.js'
import {
  ARCHIVE_AFTER_DAYS, ingestMessages, reprocessMessages, type IngestDeps,
} from '../src/ingest/ingest.js'
import { runPoll, summarize } from '../src/core/poll.js'
import { allAdapters, detectCarrier } from '../src/carriers/registry.js'
import { deleteParcel, findParcel, listActive } from '../src/db/parcels.js'
import { dismissMessage } from '../src/db/messages.js'
import { listUnparsedMessages } from '../src/web/queries.js'
import { healthPage } from '../src/web/views/health.js'
import { getIngestStatus } from '../src/db/ingest-status.js'
import { recordHealth } from '../src/db/health.js'
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
    ['x@ppl.cz', 'ppl'], ['x@mail.ppl.cz', 'ppl'], ['x@ppl.cz.evil.example', undefined],
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

/**
 * Extraction is synchronous inside `extract`, and the web server runs it during a refresh, so one
 * crafted message with a regex that backtracks quadratically freezes every page for as long as it
 * takes (29.8 s was measured for one 400 KB mail). Each of these is the worst case of one pattern.
 */
describe('extract: hostile mail finishes quickly', () => {
  const timed = async (raw: Buffer) => {
    const started = performance.now()
    const e = await extract(raw)
    return { e, ms: performance.now() - started }
  }

  test('a merchant phrase repeated to the size cap', async () => {
    const unit = 'od odosielateľa x '
    const body = 'Ahoj\r\n\r\n---------- Forwarded message ---------\r\nFrom: Packeta <info@packeta.com>\r\n\r\n'
      + `Zasielka Z 1234567890\r\n${unit.repeat(Math.ceil(390_000 / unit.length))}`
    const { e, ms } = await timed(eml('a@evil.example', 'balik', body))
    expect(e).toMatchObject({ carrier: 'packeta', number: 'Z1234567890' })
    expect(ms).toBeLessThan(1000)
  })

  test('a carrier-name stem repeated with no space after it', async () => {
    const { ms } = await timed(eml('a@evil.example', 'hello', 'slovensk'.repeat(50_000)))
    expect(ms).toBeLessThan(1000)
  })

  test.each([
    ['a shipping word', `balik${'balík'.repeat(60_000)}ek`],
    ['the first half of a two-word phrase', 'osobn'.repeat(60_000)],
  ])('a subject of %s repeated', async (_, text) => {
    const subject = `=?utf-8?B?${Buffer.from(text).toString('base64')}?=`
    const { ms } = await timed(eml('a@evil.example', subject, 'hi'))
    expect(ms).toBeLessThan(1000)
  })

  test('the bounds keep the words they were written for', async () => {
    // `Slovenská pošta` in the nominative: `\w` is ASCII-only, so the old pattern never matched the
    // carrier's own name, only its declined forms that happen to end in ASCII.
    for (const name of ['Slovenská pošta', 'Slovenskou poštou', 'slovenska posta']) {
      expect(await extract(eml('shop@example.com', 'Info', `Doručí ${name}.`))).toEqual({ confidence: 'none', evidence: 'carrier-named' })
    }
    expect(await extract(eml('shop@example.com', 'Info', 'Ako Československá pošta kedysi'))).toEqual({ confidence: 'none' })
    expect(await extract(eml('shop@example.com', 'Váš balík je na ceste', 'hi'))).toEqual({ confidence: 'none', evidence: 'shipping-subject' })
    expect(await extract(eml('shop@example.com', 'Darčekový balíček', 'hi'))).toEqual({ confidence: 'none' })
    for (const subject of ['Osobný odber v predajni', 'Odberné miesto zmenené', 'Osobny odber']) {
      expect(await extract(eml('shop@example.com', subject, 'hi'))).toEqual({ confidence: 'none', evidence: 'shipping-subject' })
    }
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
    expect(e).toEqual({ carrier: 'gls', number: '1234567890', merchant: 'MTBIKER shop', confidence: 'shape', evidence: 'carrier-named' })
  })

  test('real e-shop mail 2/2, the ORDER CONFIRMATION for the same order: names GLS, prints no tracking number -> none', async () => {
    const e = await extract(fx('mtbiker-order-confirmation-names-gls'))
    // Still a question, not junk: it names GLS, so it waits on /attention.
    expect(e).toEqual({ confidence: 'none', evidence: 'carrier-named' })
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

    // `evidence` is the second half of every one of these: no parcel, but the mail still names a
    // carrier (or prints a parcel-shaped number), so it waits on /attention instead of being ignored.
    test('a carrier name alone (no number) -> none', async () => {
      expect(await extract(eml(shop, 'Objednávka odoslaná cez GLS', 'Balík vám doručí GLS ParcelShop. Ďakujeme.')))
        .toEqual({ confidence: 'none', evidence: 'carrier-named' })
    })

    test('a labelled number alone (no carrier named) -> none', async () => {
      expect(await extract(eml(shop, 'Objednávka odoslaná', 'Číslo balíka: 1234567890')))
        .toEqual({ confidence: 'none', evidence: 'tracking-shape' })
    })

    test('a carrier named and a bare number with NO tracking label -> none', async () => {
      expect(await extract(eml(shop, 'Odoslané cez GLS', 'Ďakujeme, 1234567890 je kód pre kupón.')))
        .toEqual({ confidence: 'none', evidence: 'carrier-named' })
    })

    test.each([
      ['an order number', 'Číslo objednávky: 1234567890'],
      ['an English order number', 'Order number: 1234567890'],
      ['an invoice number', 'Číslo faktúry: 1234567890'],
      ['a phone number', 'Telefónne číslo: 1234567890'],
      ['a national-format phone number', 'Číslo balíka: 0900123456'],
      ['a +421 phone number', 'Phone number: 421900123456'],
    ])('a GLS-named mail whose only labelled number is %s -> none', async (_, line) => {
      expect(await extract(eml(shop, 'Odoslané cez GLS', line))).toEqual({ confidence: 'none', evidence: 'carrier-named' })
    })

    test('a number cut out of a longer alphanumeric token is not taken', async () => {
      expect(await extract(eml(shop, 'Odoslané cez GLS', 'Číslo balíka: 5523b1793017928')))
        .toEqual({ confidence: 'none', evidence: 'carrier-named' })
    })

    test('9 and 13 digits are not a GLS number', async () => {
      expect(await extract(eml(shop, 'Odoslané cez GLS', 'Číslo balíka: 123456789')))
        .toEqual({ confidence: 'none', evidence: 'carrier-named' })
      expect(await extract(eml(shop, 'Odoslané cez GLS', 'Číslo balíka: 1234567890123')))
        .toEqual({ confidence: 'none', evidence: 'carrier-named' })
    })

    test('two different labelled numbers are ambiguous, not a guess', async () => {
      expect(await extract(eml(shop, 'Odoslané cez GLS', 'Číslo balíka: 1234567890\r\nČíslo balíka: 1234567891')))
        .toEqual({ confidence: 'none', evidence: 'carrier-named' })
    })

    test('two carriers each named with their own labelled number are ambiguous -> none', async () => {
      expect(await extract(eml(shop, 'Odoslané', 'Balík 1 cez GLS, číslo balíka: 1234567890\r\nBalík 2 cez DPD, číslo balíka: 00000000000001')))
        .toEqual({ confidence: 'none', evidence: 'carrier-named' })
    })

    // Persona finding A4: CykloParts' "Parcel 1: 01505666666605 / Parcel 2: 01505666666606" went to
    // /attention as "no tracking number found (it names a carrier)": the "1" after "Parcel" broke the label.
    test('a numbered label ("Parcel 1:") still introduces its number', async () => {
      const dpd = (line: string) => extract(eml('CykloParts GmbH <versand@cykloparts.example.de>',
        'Versandbestätigung / Shipping confirmation CP-77120', `your order CP-77120 has been dispatched with DPD.\r\n${line}\r\n\r\nItems:\r\n - Shimano chain CN-HG71 x20`))
      for (const line of ['Parcel 1: 01505666666602', 'Balík č. 1: 01505666666602', 'Parcel #1: 01505666666602', 'Parcel no. 2 - 01505666666602']) {
        expect(await dpd(line), line).toMatchObject({ carrier: 'dpd', number: '01505666666602', confidence: 'shape', merchant: 'CykloParts GmbH' })
      }
    })

    test('a numbered two-line list makes both parcels (the persona\'s real mail)', async () => {
      const e = await extract(eml('CykloParts GmbH <versand@cykloparts.example.de>', 'Shipping confirmation CP-77125',
        'Dear customer,\r\n\r\nyour order CP-77125 has been dispatched with DPD.\r\nParcel 1: 01505666666605\r\nParcel 2: 01505666666606\r\n\r\nItems:\r\n - Brake pads x4'))
      expect(e).toMatchObject({ carrier: 'dpd', number: '01505666666605', moreNumbers: ['01505666666606'], confidence: 'shape' })
    })

    test.each([
      ['a three-digit "ordinal"', 'Parcel 123: 01505666666605'],
      ['digits run on from the label with no punctuation', 'Parcel 12 01505666666605'],
      ['a list where only one label is numbered', 'Parcel 1: 01505666666605\r\nČíslo balíka: 01505666666606'],
      // The ordinal must not hide the word that says what the number is.
      ['a numbered ORDER number', 'Order number 1: 01505666666605'],
      ['a numbered order list', 'Číslo objednávky 1: 01505666666605\r\nČíslo objednávky 2: 01505666666606'],
    ])('the ordinal lets nothing else through: %s -> none', async (_, line) => {
      expect(await extract(eml(shop, 'Odoslané cez DPD', line))).toMatchObject({ confidence: 'none' })
    })

    // A numbered list is a list of parcels only when every label says PARCEL and the number follows the
    // label directly. "Number", "číslo" and a product "package" also number product, catalogue,
    // customer and receipt lines, and before ordinals were read those were refused as ambiguous.
    test.each([
      ['a numbered product list', 'Potvrdenie objednávky – doprava GLS', 'Product number 1: 1234567890\r\nProduct number 2: 2345678901\r\nProduct number 3: 3456789012'],
      ['a numbered catalogue list', 'Potvrdenie objednávky – doprava GLS', 'Katalógové číslo 1: 1234567890\r\nKatalógové číslo 2: 2345678901'],
      ['a numbered customer number list', 'Odoslané cez GLS', 'Zákaznícke číslo 1: 1234567890\r\nZákaznícke číslo 2: 2234567890'],
      ['a numbered receipt list', 'Payment receipt (GLS delivery)', 'Receipt number 1: 1234567890\r\nReceipt number 2: 2234567890'],
      ['one numbered customer number', 'Odoslané cez GLS', 'Customer number 1: 1234567890'],
      ['numbered items with item numbers', 'Order confirmation, shipping by DPD', 'Item 1 - Shimano chain, item number 1: 12345678901234\r\nItem 2 - Brake pads, item number 2: 22345678901234'],
      ['numbered product packages with an EAN', 'Order confirmation, shipping by GLS', 'Package 1: Starter kit, EAN 123456789012\r\nPackage 2: Pro kit, EAN 223456789012'],
      ['a numbered "Paket" (a product pack) list', 'Objednávka prijatá, doprava GLS', 'Paket 1: 123456789012\r\nPaket 2: 223456789012'],
      ['a numbered gift box with a product code', 'Objednávka prijatá',
        'Doprava: GLS kuriér\r\nPoložky:\r\nBalík 1: darčekové balenie, kód 123456789012\r\nBalík 2: darčekové balenie, kód 223456789012'],
      // The ordinal must not hide a phone label either; "Tel." ends in a full stop.
      ['a numbered phone number', 'Odoslané cez GLS', 'Tel. číslo 1: 0212345678'],
      ['a numbered phone number after the courier', 'Odoslané cez GLS', 'Kuriér – Tel. číslo 1: 0212345678'],
      ['a numbered contact number', 'Odoslané cez GLS', 'Kontaktné číslo 1: 0212345678'],
      ['a numbered hotline', 'Odoslané cez GLS', 'Tel.: hotline number 1: 0850123456'],
      ['a parcel line with a phone label', 'Odoslané cez GLS', 'Tel. pre zásielku 1: 0212345678'],
      // A number printed in groups joined by -, . or – is not an ordinal and its tail.
      ['a hyphen-grouped number', 'Odoslané cez GLS', 'Parcel 12-3456789012'],
      ['a dot-grouped number', 'Odoslané cez GLS', 'Číslo zásielky 12.3456789012'],
      ['an en-dash-grouped number', 'Odoslané cez GLS', 'Číslo zásielky 12–3456789012'],
      ['a hyphen-grouped DPD number', 'Odoslané cez DPD', 'Tracking 01-50566666666020'],
    ])('a numbered label that is not a parcel\'s gives nothing: %s -> none', async (_, subject, body) => {
      expect(await extract(eml(shop, subject, body))).toMatchObject({ confidence: 'none' })
    })

    test('"Tracking number 1:" and "Číslo zásielky 1:" number parcels too', async () => {
      const e = await extract(eml(shop, 'Odoslané cez DPD', 'Tracking number 1: 01505666666605\r\nČíslo zásielky 2: 01505666666606'))
      expect(e).toMatchObject({ carrier: 'dpd', number: '01505666666605', moreNumbers: ['01505666666606'], confidence: 'shape' })
    })

    // The subject names the first parcel with a plain label and the body numbers both. Before numbered
    // labels were read the subject's number was the one parcel; it must not be lost to the mix of labels.
    test('a number labelled both plainly and in the numbered list is listed', async () => {
      const e = await extract(eml('Shop <a@shop.example>', 'Your DPD parcel 01505666666605 is on its way',
        'Parcel 1: 01505666666605\r\nParcel 2: 01505666666606'))
      expect(e).toMatchObject({ carrier: 'dpd', number: '01505666666605', moreNumbers: ['01505666666606'], confidence: 'shape' })
    })

    test('"GLS" inside another word is not the carrier', async () => {
      // "OGLS" is not GLS, so the carrier-name signal does not fire; the labelled number does.
      expect(await extract(eml(shop, 'Odoslané', 'Angels and OGLS. Číslo balíka: 1234567890')))
        .toEqual({ confidence: 'none', evidence: 'tracking-shape' })
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

/**
 * PPL's numbers are 11 bare digits, which is also a GLS number (10-12). So a mail's 11 digits are PPL
 * only when PPL itself sent the mail, or when a shop names PPL beside the labelled number ("in the same
 * sentence": back to the paragraph start, at most 160 characters, or later on the number's own line).
 * Never by shape alone, and GLS mail keeps its 11-digit numbers.
 */
describe('extract: PPL, whose 11 digits are also a GLS number', () => {
  const shop = 'Obchod <info@obchod.example.cz>'

  test('from ppl.cz: the sender says PPL, and a courier phone printed first does not win', async () => {
    const e = await extract(eml('PPL CZ <noreply@ppl.cz>', 'Vaše zásilka je na cestě',
      'Kurýr: +420 777 123 456\r\nČíslo zásilky: 40888888801\r\nDoručení zítra.'))
    expect(e).toMatchObject({ carrier: 'ppl', number: '40888888801', confidence: 'sender', evidence: 'carrier-sender' })
  })

  test('from ppl.cz: an unspaced +420 phone (12 digits) is not a PPL number', async () => {
    const e = await extract(eml('noreply@ppl.cz', 'Zásilka', 'Volejte +420777123456. Číslo zásilky: 40888888802'))
    expect(e).toMatchObject({ carrier: 'ppl', number: '40888888802', confidence: 'sender' })
  })

  test('from ppl.cz: only 11 digits are a PPL number, so a 10- or 12-digit reference gives none', async () => {
    expect(await extract(eml('noreply@ppl.cz', 'Zásilka', 'Reference 1234567890 a 123456789012')))
      .toEqual({ carrier: 'ppl', confidence: 'none', evidence: 'carrier-sender' })
  })

  test('from ppl.cz: a listed second number comes too', async () => {
    const e = await extract(eml('noreply@ppl.cz', 'Zásilky', 'Čísla zásilek: 40888888803, 40888888804'))
    expect(e).toMatchObject({ carrier: 'ppl', number: '40888888803', moreNumbers: ['40888888804'], confidence: 'sender' })
  })

  test('a shop that names no carrier: the 11 digits are not PPL (no parcel)', async () => {
    const e = await extract(eml(shop, 'Objednávka odeslána', 'Číslo zásilky: 40888888801'))
    expect(e).toMatchObject({ confidence: 'none' })
    expect(e.carrier).toBeUndefined()
    expect(e.number).toBeUndefined()
  })

  test('a shop naming PPL on the line above the labelled number -> PPL, titled by the shop', async () => {
    const e = await extract(eml(shop, 'Objednávka odeslána', 'Dopravce: PPL\r\nČíslo zásilky: 40888888801'))
    expect(e).toMatchObject({ carrier: 'ppl', number: '40888888801', confidence: 'shape', evidence: 'carrier-named', merchant: 'Obchod' })
  })

  test('a shop naming PPL later on the number\'s own line -> PPL', async () => {
    const e = await extract(eml(shop, 'Objednávka odeslána', 'Číslo zásilky: 40888888801 (doručí PPL)\r\nDěkujeme.'))
    expect(e).toMatchObject({ carrier: 'ppl', number: '40888888801', confidence: 'shape' })
  })

  test('PPL only in a footer three paragraphs below the number -> not PPL', async () => {
    const e = await extract(eml(shop, 'Objednávka odeslána',
      'Dobrý den,\r\n\r\nvaše objednávka byla odeslána.\r\nČíslo zásilky: 40888888801\r\n\r\nDěkujeme za nákup.\r\n\r\nVáš Obchod\r\n\r\nDoručujeme s PPL.'))
    expect(e).toEqual({ confidence: 'none', evidence: 'carrier-named' })
  })

  test('PPL in the paragraph above, past a blank line -> not PPL', async () => {
    const e = await extract(eml(shop, 'Objednávka odeslána', 'Doručujeme s PPL.\r\n\r\nČíslo zásilky: 40888888801'))
    expect(e).toEqual({ confidence: 'none', evidence: 'carrier-named' })
  })

  test('PPL more than 160 characters before the number, even in one paragraph -> not PPL', async () => {
    const filler = 'Zboží jsme pečlivě zabalili a předali k doručení, sledovat jej můžete podle čísla níže, které vám '
      + 'pošleme také v samostatné zprávě, jakmile bude zásilka připravena k vyzvednutí na výdejním místě'
    expect(filler.length).toBeGreaterThan(160)
    const e = await extract(eml(shop, 'Objednávka odeslána', `Dopravce PPL. ${filler}\r\nČíslo zásilky: 40888888801`))
    expect(e).toEqual({ confidence: 'none', evidence: 'carrier-named' })
  })

  test('"PPL" inside another word is not the carrier', async () => {
    expect(await extract(eml(shop, 'Objednávka odeslána', 'Kód PPLX.\r\nČíslo zásilky: 40888888801')))
      .toEqual({ confidence: 'none', evidence: 'tracking-shape' })
  })

  test('ppl.cz in a footer link, far from the number -> not PPL (only the sender rule reads ppl.cz)', async () => {
    const e = await extract(eml(shop, 'Objednávka odeslána',
      'Číslo zásilky: 40888888801\r\n\r\nDěkujeme za nákup.\r\n\r\nVáš Obchod\r\n\r\nSledování: https://www.ppl.cz/vyhledat-zasilku'))
    expect(e).toEqual({ confidence: 'none', evidence: 'carrier-named' })
  })

  test('a GLS mail\'s 11 digits stay GLS', async () => {
    expect(await extract(eml('GLS Slovakia <noreply@gls-slovakia.sk>', 'Váš balík', 'Číslo balíka: 90444444401')))
      .toMatchObject({ carrier: 'gls', number: '90444444401', confidence: 'sender' })
  })

  test('a shop naming GLS beside a labelled 11-digit number -> GLS, even with PPL in a far footer', async () => {
    expect(await extract(eml(shop, 'Objednávka odoslaná', 'Prepravca: GLS\r\nČíslo zásielky: 90444444402')))
      .toEqual({ carrier: 'gls', number: '90444444402', merchant: 'Obchod', confidence: 'shape', evidence: 'carrier-named' })
    expect(await extract(eml(shop, 'Objednávka odoslaná', 'Prepravca: GLS\r\nČíslo zásielky: 90444444402\r\n\r\nĎakujeme.\r\n\r\nDopravcovia: PPL, DPD')))
      .toMatchObject({ carrier: 'gls', number: '90444444402', confidence: 'shape' })
  })

  // Both rules accept the number, and nothing in the mail says which carrier has it: a question.
  test('a shop naming GLS and PPL beside one 11-digit number -> none, on /attention', async () => {
    expect(await extract(eml(shop, 'Objednávka odeslána', 'Dopravce: PPL (dříve GLS)\r\nČíslo zásilky: 40888888801')))
      .toEqual({ confidence: 'none', evidence: 'carrier-named' })
  })

  test('Detect on 11 digits stays GLS', () => {
    expect(detectCarrier('40888888801')).toEqual(['gls'])
  })

  test.each([
    ['PPL in the display name', 'PPL <noreply@ppl-cz.example.com>'],
    ['ppl as a label of the domain', 'Info <noreply@ppl-cz.example.com>'],
  ])('a look-alike PPL sender (%s) makes no parcel', async (_, from) => {
    expect(await extract(eml(from, 'Zásilka', 'Dopravce: PPL\r\nČíslo zásilky: 40888888801')))
      .toEqual({ confidence: 'none', evidence: 'lookalike-sender', claimed: { carrier: 'ppl', host: 'ppl-cz.example.com' } })
  })

  test('a PPL brand domain (ppl.de) is not a look-alike', async () => {
    expect(await extract(eml('PPL <noreply@ppl.de>', 'Zásilka', 'Dopravce: PPL\r\nČíslo zásilky: 40888888801')))
      .toMatchObject({ carrier: 'ppl', number: '40888888801', confidence: 'shape' })
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

  test('a deleted parcel is not resurrected by the next run over the very same mail', async () => {
    const mailbox = [mail(1, 'packeta-accepted', 2)]
    const { db, deps } = setup(mailbox)
    await ingestMessages(db, deps)
    const p = findParcel(db, 'packeta', 'Z0000000001')!

    deleteParcel(db, p.id)
    expect(counts(db)).toEqual({ parcels: 0, messages: 1 })   // the message row survives: it is the dedupe key

    // The mail is still in the mailbox, exactly as before. Its Message-ID is known, so it is not even downloaded.
    const again = fakeImap(mailbox)
    const r = await ingestMessages(db, { ...deps, client: again.client })
    expect(r).toMatchObject({ read: 0, created: 0, linked: 0, needsAttention: 0 })
    expect(again.downloaded).toEqual([])
    expect(counts(db).parcels).toBe(0)
    expect(listUnparsedMessages(db)).toEqual([])   // nor does the orphaned mail show up as a new alert
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
    // Only the one that names a carrier is a question. The sale newsletter (whose numbers are a
    // discount code and a reference) and "Lunch on Friday?" say nothing about a parcel, so they are
    // stored and ignored - see test/ingest-evidence.test.ts for that rule.
    expect(r).toMatchObject({ read: 3, created: 0, needsAttention: 1, ignored: 2 })
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

  test('a dismissed message is never reprocessed again, even once the parser could read it', async () => {
    const db = memDb()
    const dir = mkdtempSync(join(tmpdir(), 'parcels-reproc-'))
    // Ingested while packeta had no adapter, so it waited for attention; then it was dismissed by hand.
    const s = setup([mail(1, 'packeta-accepted', 2)], { adapters: allAdapters().filter(a => a.id !== 'packeta'), mailDir: dir })
    await ingestMessages(db, s.deps)
    const id = (db.prepare('SELECT id FROM messages').get() as { id: number }).id
    expect(dismissMessage(db, id)).toBe(true)

    // Every adapter is registered now, so without the dismissal this run WOULD create the parcel.
    const r = await reprocessMessages(db, { now: NOW, adapters: allAdapters(), defaultPostalCode: '81101' })
    expect(r).toMatchObject({ read: 0, created: 0, needsAttention: 0 })
    expect(counts(db).parcels).toBe(0)
    expect(listUnparsedMessages(db)).toEqual([])
  })

  test('dismissing deletes the stored .eml, and reprocess is untroubled by its absence', async () => {
    const db = memDb()
    const dir = mkdtempSync(join(tmpdir(), 'parcels-prune-'))
    const s = setup([mail(1, 'packeta-app-verification', 2)], { mailDir: dir })
    await ingestMessages(db, s.deps)
    const before = (db.prepare('SELECT id, raw_path FROM messages').get() as { id: number; raw_path: string })
    expect(existsSync(before.raw_path)).toBe(true)

    expect(dismissMessage(db, before.id)).toBe(true)
    expect(existsSync(before.raw_path)).toBe(false)          // 139 MB of newsletters is why
    expect(db.prepare('SELECT raw_path FROM messages WHERE id = ?').get(before.id)).toEqual({ raw_path: null })

    const r = await reprocessMessages(db, { now: NOW, adapters: allAdapters(), defaultPostalCode: '81101' })
    expect(r).toMatchObject({ read: 0, failed: 0 })
  })

  test('a message still waiting for attention whose file vanished is skipped, not a failure', async () => {
    const db = memDb()
    const dir = mkdtempSync(join(tmpdir(), 'parcels-gone-'))
    // Two messages: one keeps its file, the other's is removed from under the reprocess.
    const s = setup([mail(1, 'packeta-app-verification', 2), mail(2, 'packeta-accepted', 2)], {
      adapters: allAdapters().filter(a => a.id !== 'packeta'), mailDir: dir,
    })
    await ingestMessages(db, s.deps)
    const rows = db.prepare('SELECT id, raw_path FROM messages ORDER BY id').all() as Array<{ id: number; raw_path: string }>
    rmSync(rows[0]!.raw_path)

    const r = await reprocessMessages(db, { now: NOW, adapters: allAdapters(), defaultPostalCode: '81101' })
    expect(r).toMatchObject({ read: 1, created: 1, failed: 0 })   // only the one still on disk
    expect(findParcel(db, 'packeta', 'Z0000000001')).toBeDefined()
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

  // Persona finding "3 hours behind Gmail": the carrier's mail said the parcel was ready, and the
  // dashboard said so hours later, because a parcel idle for days sits in a slow backoff tier and
  // `isDue` looked only at the clock. New mail about it is the carrier telling us to look now.
  describe('new mail about a parcel already tracked makes it due in that run', () => {
    const HOUR = 3_600_000
    /** Z0000000001 (the number in packeta-accepted.eml), idle 4 days and polled 30 minutes ago: not due by time. */
    function quietParcel(db: ReturnType<typeof memDb>): number {
      const id = Number(db.prepare(`INSERT INTO parcels (carrier, tracking_number, status, first_seen_at, last_changed_at, last_polled_at, source)
        VALUES ('packeta', 'Z0000000001', 'in_transit', ?, ?, ?, 'manual')`)
        .run(new Date(NOW.getTime() - 5 * DAY).toISOString(), new Date(NOW.getTime() - 4 * DAY).toISOString(),
          new Date(NOW.getTime() - HOUR / 2).toISOString()).lastInsertRowid)
      return id
    }
    const run = (db: ReturnType<typeof memDb>, adapter: ReturnType<typeof stubAdapter>, client: ReturnType<typeof fakeImap>['client'], now = NOW) =>
      runPoll({ db, http: bodyHttp(), adapters: [adapter], config, now, ingest: { imap, client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-due-')) } })

    test('polled in the same run that read the mail, and only once per mail', async () => {
      const db = memDb()
      quietParcel(db)
      const adapter = stubAdapter('packeta', inputs => inputs.map(i => okResult(i.number, [])))
      // Without mail the backoff holds, which is what the rest of this relies on.
      expect((await run(db, adapter, fakeImap([]).client)).polled).toBe(0)

      const mailbox = [mail(1, 'packeta-accepted', 0)]
      const report = await run(db, adapter, fakeImap(mailbox).client)
      expect(report.ingest).toMatchObject({ created: 0, linked: 1 })
      expect(adapter.calls.flat().map(i => i.number)).toEqual(['Z0000000001'])
      expect(report.polled).toBe(1)

      // The same mail again (nothing new) is not a reason to ask again: the backoff is back in charge.
      const again = await run(db, adapter, fakeImap(mailbox).client, new Date(NOW.getTime() + 10 * 60_000))
      expect(again.polled).toBe(0)
      expect(adapter.calls).toHaveLength(1)
    })

    test('a carrier inside its gated backoff window is still left alone', async () => {
      const db = memDb()
      quietParcel(db)
      recordHealth(db, 'packeta', 'gated', 'HTTP 429', new Date(NOW.getTime() - 10 * 60_000))
      const adapter = stubAdapter('packeta', inputs => inputs.map(i => okResult(i.number, [])))
      const report = await run(db, adapter, fakeImap([mail(1, 'packeta-accepted', 0)]).client)
      expect(report.ingest).toMatchObject({ linked: 1 })
      expect(report.polled).toBe(0)
      expect(adapter.calls).toHaveLength(0)
    })

    // Dormancy (no carrier event in 30 days) waits for a sign of life, and mail about the parcel is one.
    test('a dormant parcel is revived and polled by mail about it', async () => {
      const db = memDb()
      const id = quietParcel(db)
      db.prepare('UPDATE parcels SET first_seen_at = ?, last_changed_at = NULL WHERE id = ?')
        .run(new Date(NOW.getTime() - 40 * DAY).toISOString(), id)
      const adapter = stubAdapter('packeta', inputs => inputs.map(i => okResult(i.number, [])))
      // Dormant, so not even a forced run without mail asks about it.
      expect((await runPoll({ db, http: bodyHttp(), adapters: [adapter], config, now: NOW, forceAll: true })).polled).toBe(0)

      const report = await run(db, adapter, fakeImap([mail(1, 'packeta-accepted', 0)]).client)
      expect(report.ingest).toMatchObject({ linked: 1 })
      expect(adapter.calls.flat().map(i => i.number)).toEqual(['Z0000000001'])
    })

    // A mail listing several parcels links to its first; the others it names are news about them too.
    test('a parcel named only among the extra numbers of a multi-parcel mail is polled too', async () => {
      const db = memDb()
      db.prepare(`INSERT INTO parcels (carrier, tracking_number, status, first_seen_at, last_changed_at, last_polled_at, source)
        VALUES ('dpd', '01505666666606', 'in_transit', ?, ?, ?, 'manual')`)
        .run(new Date(NOW.getTime() - 5 * DAY).toISOString(), new Date(NOW.getTime() - 4 * DAY).toISOString(),
          new Date(NOW.getTime() - HOUR / 2).toISOString())
      const adapter = stubAdapter('dpd', inputs => inputs.map(i => okResult(i.number, [])))
      expect((await run(db, adapter, fakeImap([]).client)).polled).toBe(0)

      const source = eml('CykloParts GmbH <versand@cykloparts.example.de>', 'Shipping confirmation CP-77125',
        'Dear customer,\r\n\r\nyour order CP-77125 has been dispatched with DPD.\r\nParcel 1: 01505666666605\r\nParcel 2: 01505666666606\r\n')
      const report = await run(db, adapter, fakeImap([{
        uid: 1, source, messageId: '<cp-77125@fixture>', subject: 'Shipping confirmation CP-77125',
        from: 'versand@cykloparts.example.de', date: NOW,
      }]).client)
      // 605 is new (and due because it was never polled); 606 is due only because the mail named it.
      expect(report.ingest).toMatchObject({ created: 1, linked: 0 })
      expect(adapter.calls.flat().map(i => i.number).sort()).toEqual(['01505666666605', '01505666666606'])
    })

    test('a delivered parcel is not polled again because a late mail mentions it', async () => {
      const db = memDb()
      const id = quietParcel(db)
      db.prepare("UPDATE parcels SET status = 'delivered' WHERE id = ?").run(id)
      const adapter = stubAdapter('packeta', inputs => inputs.map(i => okResult(i.number, [])))
      const report = await run(db, adapter, fakeImap([mail(1, 'packeta-accepted', 0)]).client)
      expect(report.ingest).toMatchObject({ linked: 1 })
      expect(report.polled).toBe(0)
    })
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
    expect(status(db)).toMatchObject({ n: 1, e: 'AuthenticationFailure: Invalid credentials (Failure)', ok: null })
    await run(db, down(), new Date(NOW.getTime() + 3_600_000))
    expect(status(db).n).toBe(2)
    await run(db, up(), new Date(NOW.getTime() + 7_200_000))
    expect(status(db)).toMatchObject({ n: 0, nt: null })
    expect(status(db).ok).not.toBeNull()
  })

  // imapflow's real shape: the message says nothing, the reason is on the side. Stored as plain
  // `describe(err)` this was "Error: Command failed", and the revoked-password banner never matched it.
  test('a refused login stored the way imapflow throws it still reads as a refused login', async () => {
    const db = memDb()
    const err = Object.assign(new Error('Command failed'), {
      authenticationFailed: true, serverResponseCode: 'AUTHENTICATIONFAILED', responseText: 'Invalid credentials (Failure)',
    })
    await run(db, fakeImap([], { connectError: err }).client, NOW)
    expect(status(db).e).toBe('AuthenticationFailure: Invalid credentials (Failure)')
  })

  test('a network failure is stored as it was thrown', async () => {
    const db = memDb()
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND imap.gmail.com'), { code: 'ENOTFOUND' })
    await run(db, fakeImap([], { connectError: err }).client, NOW)
    expect(status(db).e).toBe('Error: getaddrinfo ENOTFOUND imap.gmail.com')
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
    const page = healthPage([], { configured: true, status: getIngestStatus(db) }, { overdue: false }, { now: NOW, health: [] }, 'test').toString()
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

describe('pickupFromMail (where the carrier never said, but the mail did)', () => {
  /** Exactly what the poll-side scan feeds the extractor: the text part, or the html flattened. */
  const mailText = async (name: string): Promise<string> => {
    const mail = await simpleParser(fx(name))
    return mail.text || (typeof mail.html === 'string' ? htmlToText(mail.html) : '')
  }

  test('the real GLS pickup mail yields the box, its street, its postcode and its town', async () => {
    // The fixture is message 147 of the live mailbox, with the names, numbers and the PIN replaced.
    // Its block reads (one `<br>` per line, inside one `<strong>`):
    //   Odberné miesto:
    //   ExampleBox Testville - Príklad (Example Mall),
    //   Príkladová 6,
    //   00001, Testville
    expect(pickupFromMail(await mailText('gls-ready-for-pickup'))).toEqual({
      kind: 'locker',
      name: 'ExampleBox Testville - Príklad (Example Mall)',
      street: 'Príkladová 6',
      postalCode: '00001',
      city: 'Testville',
    })
  })

  test('the GLS block reads the same when the html has to be flattened by hand', async () => {
    // mailparser derives `text` for this mail, but a multipart/mixed one gets none and goes through
    // htmlToText instead - where `<br>` becomes a newline and the town lands on its own line.
    const mail = await simpleParser(fx('gls-ready-for-pickup'))
    const flattened = htmlToText(mail.html as string)
    expect(flattened).toContain('00001,')
    expect(pickupFromMail(flattened)?.city).toBe('Testville')
    expect(pickupFromMail(flattened)?.street).toBe('Príkladová 6')
  })

  test('the real Packeta Z-BOX mail yields the postcode its API never sends', async () => {
    expect(pickupFromMail(await mailText('packeta-ready-zbox'))).toEqual({
      kind: 'zbox',
      name: 'Z-BOX Testville, Example Street 1',
      street: 'Example Street 1',
      postalCode: '000 00',
      city: 'Testville',
    })
  })

  test('the real DPD Pickup Station mail yields the box and leaves its opening hours out', async () => {
    // The town and the next label share a line, separated only by the collapsed table cell:
    // "000 00 TESTVILLE   Otváracie hodiny: Pondelok: ..."
    expect(pickupFromMail(await mailText('dpd-pickup-station'))).toEqual({
      kind: 'locker',
      name: 'ExampleBox (Example Mall)',
      street: 'EXAMPLE STREET 1',
      postalCode: '000 00',
      city: 'TESTVILLE',
    })
  })

  test('a mail with no pickup block yields nothing', async () => {
    expect(pickupFromMail(await mailText('synthetic-gls-notification'))).toBeUndefined()
    expect(pickupFromMail(await mailText('sps-number-in-subject'))).toBeUndefined()
  })

  test('where a parcel WILL be stored is not where it is', async () => {
    // Packeta's acceptance mail prints the same block under "Miesto, kde BUDE vaša zásielka uložená",
    // naming a box the parcel has not reached and may never reach.
    const text = await mailText('packeta-accepted')
    expect(text).toContain('Miesto, kde bude vaša zásielka uložená')
    expect(pickupFromMail(text)).toBeUndefined()
  })

  test('a block with only a town is not a pickup point', () => {
    expect(pickupFromMail('Odberné miesto:\nBratislava 5\n')).toBeUndefined()
    expect(pickupFromMail('Odberné miesto:\nAlzaBox Bratislava,\nBratislava\n')).toBeUndefined()
  })

  test('a town and a postcode with no street is not a pickup point either', () => {
    expect(pickupFromMail('Odberné miesto:\nAlzaBox Bratislava,\n821 01 Bratislava\n')).toBeUndefined()
  })

  test('a street with no house number is not a street', () => {
    expect(pickupFromMail('Odberné miesto:\nZ-BOX Hlavna,\nHlavna,\n821 01 Bratislava\n')).toBeUndefined()
  })

  test('a sentence that merely mentions a pickup point is not a block', () => {
    // DPD's own mail says this under the address, as link text; GLS's label owns a line and ends in a colon.
    expect(pickupFromMail('Zobraziť odberné miesto Pickup Station na mape\nBratislava 821 01\n')).toBeUndefined()
    expect(pickupFromMail(
      'Vaša zásielka je pripravená na vyzdvihnutie v odbernom mieste balíkovo Lekáreň Nádej, Mateja Belu 24/239, Kalinovo.',
    )).toBeUndefined()
  })

  test('the postcode may be written with or without its space, and keeps the spelling it had', () => {
    const block = (zip: string) => `Odberné miesto:\nAlzaBox Nivy,\nMlynské nivy 16,\n${zip}, Bratislava\n`
    expect(pickupFromMail(block('82109'))?.postalCode).toBe('82109')
    expect(pickupFromMail(block('821 09'))?.postalCode).toBe('821 09')
  })

  test('a block that names a post office or a shop is kinded as what it says it is', () => {
    const at = (name: string) => pickupFromMail(`Odberné miesto:\n${name},\nHlavna 6,\n821 01 Bratislava\n`)?.kind
    expect(at('Z-BOX Bratislava')).toBe('zbox')
    expect(at('AlzaBox Bratislava')).toBe('locker')
    expect(at('Balíkomat Bratislava')).toBe('locker')
    expect(at('Pošta Bratislava 5')).toBe('post_office')
    expect(at('Lekáreň Nádej')).toBe('unknown')   // a counter in a pharmacy: nothing in the name says what it is
  })

  test('nothing is read from the hours, the deadline or the links that follow the block', () => {
    const point = pickupFromMail(
      'Odberné miesto:\nAlzaBox Nivy,\nMlynské nivy 16,\n82109, Bratislava   Otváracie hodiny: Pondelok: 00:00 - 23:59\n'
      + 'Zobraziť na mape [https://maps.example/?q=48.1,17.1]\n',
    )
    expect(point).toEqual({
      kind: 'locker', name: 'AlzaBox Nivy', street: 'Mlynské nivy 16', postalCode: '82109', city: 'Bratislava',
    })
  })
})

describe('pickupFromMail: a street a table cell split in two', () => {
  test('a house number left alone on its line is joined back to the street above it', () => {
    // Real bytes, from message 77 of the live mailbox flattened by `htmlToText`: DPD's template puts
    // the street name and the house number in separate cells, so the number arrives on its own.
    //   "Adresa samoobslužného boxu Pickup Station: | AlzaBox (OC Retro), | NEVÄDZOVÁ | 6, | 821 01 BRATISLAVA"
    const point = pickupFromMail(
      'Adresa samoobslužného boxu Pickup Station:    AlzaBox (OC Retro),   NEVÄDZOVÁ   6,   821 01 BRATISLAVA   Otváracie hodiny: Pondelok: 00:01 - 23:59',
    )
    expect(point).toEqual({
      kind: 'locker', name: 'AlzaBox (OC Retro)', street: 'NEVÄDZOVÁ 6', postalCode: '821 01', city: 'BRATISLAVA',
    })
  })

  test('a bare number with no street above it is still not a street', () => {
    expect(pickupFromMail('Odberné miesto:\n6,\n821 01 Bratislava\n')).toBeUndefined()
  })
})

describe('pickupFromMail: what a town and a street may not be', () => {
  test('a sentence that follows the town on the same line is not part of the town', () => {
    // No table-cell gap to split on here, so the town validator is the only thing standing between
    // "Bratislava" and a pickup point whose town is a sentence.
    expect(pickupFromMail(
      'Odberné miesto:\nAlzaBox Nivy,\nMlynské nivy 16,\n82109 Bratislava od 8:00\n',
    )).toBeUndefined()
    expect(pickupFromMail(
      'Odberné miesto:\nAlzaBox Nivy,\nMlynské nivy 16,\n82109 Bratislava otvorené denne od 8:00 do 20:00\n',
    )).toBeUndefined()
  })

  test('a block that stops at the postcode names no town, so it is no pickup point', () => {
    expect(pickupFromMail('Odberné miesto:\nAlzaBox Nivy,\nMlynské nivy 16,\n82109\n')).toBeUndefined()
  })

  test('a block with no postcode is refused, even with a street and a town', () => {
    // Deliberate: the postcode is the anchor that tells the street from the town. Without it the
    // parser would have to guess which part is which, and a guessed town is a pin in a wrong place.
    expect(pickupFromMail('Odberné miesto:\nLekáreň Nádej,\nMateja Belu 24/239,\nKalinovo\n')).toBeUndefined()
  })

  test('a mail that mentions a pickup point in passing does not hand over the reader\'s own address', () => {
    // The danger the anchoring exists for: "odberné miesto" in a sentence, with the delivery address
    // printed under it. A loose label would store the reader's home as the place to collect from.
    expect(pickupFromMail(
      'Svoje odberné miesto si môžete zmeniť na našej stránke.\n'
      + 'Doručovacia adresa: Jane Doe,\nHlavná 12,\n821 01 Bratislava\n',
    )).toBeUndefined()
  })

  test('prose that happens to carry a postcode is not an address', () => {
    const prose = 'Odberné miesto:\n'
      + 'Vašu zásielku sme uložili a môžete si ju vyzdvihnúť kedykoľvek počas otváracích hodín, '
      + 'pričom na vyzdvihnutie je potrebný PIN kód 4 zo dňa 11. 9. 2026 a doklad totožnosti,\n'
      + '82101, Bratislava\n'
    expect(pickupFromMail(prose)).toBeUndefined()
  })
})
