import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { extract } from '../src/ingest/extract.js'
import { ingestMessages } from '../src/ingest/ingest.js'
import { allAdapters } from '../src/carriers/registry.js'
import { fakeImap } from './imap-fake.js'
import { NOW, memDb } from './poll-helpers.js'

/**
 * Regression tests for the bugs the fake-mail corpus run found (test/fixtures/fake-mail/FINDINGS.md).
 * Each `describe` is one finding; the fixtures are the corpus mails themselves, which are synthetic
 * through and through (MANIFEST.md), so they can sit in the repo beside the scrubbed real ones.
 */
const corpus = (name: string) => readFileSync(new URL(`./fixtures/fake-mail/${name}.eml`, import.meta.url))
const real = (name: string) => readFileSync(new URL(`./fixtures/mail/${name}.eml`, import.meta.url))

/** Ingests corpus mails (by name, a day apart, all recent) into a fresh database; returns the database. */
async function ingest(...names: string[]) {
  const db = memDb()
  const fake = fakeImap(names.map((name, i) => ({
    uid: i + 1, source: corpus(name), messageId: `<${name}@fake-mail>`, subject: name, from: 'x@example.com',
    date: new Date(NOW.getTime() - (names.length - i) * 86_400_000),
  })))
  const report = await ingestMessages(db, {
    imap: { host: 'imap.example.com', port: 993, user: 'u@example.com', pass: 'pw', mailbox: 'parcels' },
    client: fake.client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-fake-mail-')),
    now: NOW, adapters: allAdapters(), defaultPostalCode: '81101',
  })
  const parcels = db.prepare('SELECT carrier, tracking_number AS number, merchant FROM parcels ORDER BY id').all()
  const notes = db.prepare('SELECT parse_note AS note FROM messages WHERE parcel_id IS NULL ORDER BY id').all() as Array<{ note: string }>
  return { db, report, parcels, notes: notes.map(n => n.note) }
}

/** An eml built inline, for cases a fixture would be overkill for. */
const eml = (from: string, subject: string, body: string) =>
  Buffer.from(`From: ${from}\r\nTo: recipient@example.com\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`)

describe('F1: GLS Slovakia\'s own mail is a carrier sender, and its number is read from the body', () => {
  test('a GLS BOX mail from gls-slovakia.sk is confidence sender', async () => {
    expect(await extract(corpus('20-gls-ready-glsbox-pin'))).toMatchObject({
      carrier: 'gls', number: '90444444401', confidence: 'sender', evidence: 'carrier-sender',
    })
  })

  test('the real scrubbed GLS mail parses from its body alone, with no number in the subject', async () => {
    const raw = real('gls-ready-for-pickup').toString('latin1')
      .replace(/^Subject: .*$/m, 'Subject: =?UTF-8?Q?Bal=C3=ADk_je_pripraven=C3=BD_k_vyzdvihnutiu?=')
    expect(await extract(Buffer.from(raw, 'latin1'))).toMatchObject({
      carrier: 'gls', number: '000000000001', confidence: 'sender',
    })
  })

  test('the courier\'s phone printed first does not win over the number under "Číslo balíka:"', async () => {
    expect(await extract(corpus('12-gls-transit-courier-phone-first'))).toMatchObject({
      carrier: 'gls', number: '90444444402', confidence: 'sender',
    })
  })

  test('an Outlook forward (underscore rule, no "Forwarded message" line) of a GLS mail is the carrier\'s', async () => {
    const e = await extract(corpus('61-outlook-forwarded-gls-reminder'))
    expect(e).toMatchObject({ carrier: 'gls', number: '90444444401', confidence: 'sender' })
    expect(e.merchant).toBeUndefined()   // never the colleague who forwarded it
  })

  test('an e-shop mail naming GLS may put the number on the line under its label', async () => {
    expect(await extract(eml('Shop <orders@shop.example>', 'Odoslané cez GLS', 'Číslo balíka:\r\n1234567890')))
      .toMatchObject({ carrier: 'gls', number: '1234567890', confidence: 'shape' })
  })

  test('...but an order number on the line under ITS label is still not a parcel number', async () => {
    expect(await extract(eml('Shop <orders@shop.example>', 'Odoslané cez GLS', 'Číslo objednávky:\r\n1234567890')))
      .toEqual({ confidence: 'none', evidence: 'carrier-named' })
  })
})

describe('F2: a GLS parcel is named after the shop GLS prints, never after GLS\'s domain', () => {
  test.each([
    ['18-gls-accepted', 'Hračkáreň Kocúrik'],
    ['20-gls-ready-glsbox-pin', 'Hračkáreň Kocúrik'],
    ['12-gls-transit-courier-phone-first', 'BehajSlovensko s.r.o.'],
    ['05-gls-delivered-25-days-old', 'Záhrada Plus s.r.o.'],
  ])('%s -> %s', async (name, merchant) => {
    expect((await extract(corpus(name))).merchant).toBe(merchant)
  })

  test('the real GLS mail: "Odosielateľ:" names the shop', async () => {
    expect((await extract(real('gls-ready-for-pickup'))).merchant).toBe('Example Seller')
  })
})

describe('F6: a carrier\'s sample number ("Z 000 0000 000") is not a parcel', () => {
  test('Packeta\'s promo mail explaining the number format: no parcel, a question for /attention', async () => {
    expect(await extract(corpus('08-packeta-promo-sample-number'))).toEqual({
      carrier: 'packeta', confidence: 'none', evidence: 'carrier-sender',
    })
  })

  test('a placeholder printed before the real number does not hide it', async () => {
    expect(await extract(eml('noreply@packeta.sk', 'Zásielka', 'Číslo v tvare Z 000 0000 000. Vaša zásielka: Z 222 2222 201')))
      .toMatchObject({ carrier: 'packeta', number: 'Z2222222201', confidence: 'sender' })
  })

  test.each([
    ['Packeta, from a shop', 'Odoslané cez Packeta: Z 000 0000 000'],
    ['Slovenská pošta, from a shop', 'Podacie číslo: RR000000000SK'],
  ])('%s: a number whose digits are all one digit is not taken', async (_, body) => {
    expect((await extract(eml('Shop <orders@shop.example>', 'Odoslané', body))).number).toBeUndefined()
  })
})

describe('F7: a sender dressed up as a carrier, writing from someone else\'s domain, makes no parcel', () => {
  test('"Packeta" <noreply@packeta-sk.example.com> asking for a fee: /attention, saying why', async () => {
    expect(await extract(corpus('76-phishing-lookalike-packeta'))).toEqual({ confidence: 'none', evidence: 'lookalike-sender' })
  })

  test.each([
    ['a carrier\'s name in the display name', 'DPD Slovensko <info@doprava.example.com>'],
    ['a carrier\'s name as a label of the domain', 'Info <noreply@gls-sk.example.com>'],
    ['Slovenská pošta in the display name', 'Slovenská pošta <notify@posta-sk.example.net>'],
  ])('%s', async (_, from) => {
    expect(await extract(eml(from, 'Zásielka', 'Vaša zásielka Z 222 2222 299 čaká.')))
      .toEqual({ confidence: 'none', evidence: 'lookalike-sender' })
  })

  test('a shop that merely names the carrier in the BODY is still tracked, titled by the shop', async () => {
    expect(await extract(eml('Mobilonline <objednavky@mobilonline.example.sk>', 'Odoslané', 'Prepravca: Packeta. Zásielka Z 222 2222 205')))
      .toMatchObject({ carrier: 'packeta', number: 'Z2222222205', confidence: 'shape', merchant: 'Mobilonline' })
  })

  test('ingest: no parcel, and the note on /attention says the sender was not trusted', async () => {
    const { parcels, notes } = await ingest('76-phishing-lookalike-packeta')
    expect(parcels).toEqual([])
    expect(notes).toEqual(['not tracked: its sender is named like a carrier but does not write from that carrier\'s address'])
  })

  test('the real carrier, from its own domain, is unaffected', async () => {
    expect(await extract(eml('Packeta <noreply@packeta.sk>', 'Zásielka', 'Vaša zásielka Z 222 2222 299 čaká.')))
      .toMatchObject({ carrier: 'packeta', number: 'Z2222222299', confidence: 'sender' })
  })
})
