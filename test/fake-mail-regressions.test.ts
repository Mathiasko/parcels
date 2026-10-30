import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { extract } from '../src/ingest/extract.js'

/**
 * Regression tests for the bugs the fake-mail corpus run found (test/fixtures/fake-mail/FINDINGS.md).
 * Each `describe` is one finding; the fixtures are the corpus mails themselves, which are synthetic
 * through and through (MANIFEST.md), so they can sit in the repo beside the scrubbed real ones.
 */
const corpus = (name: string) => readFileSync(new URL(`./fixtures/fake-mail/${name}.eml`, import.meta.url))
const real = (name: string) => readFileSync(new URL(`./fixtures/mail/${name}.eml`, import.meta.url))

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
