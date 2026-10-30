import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { extract, mailText, pickupFromMail } from '../src/ingest/extract.js'
import { ingestMessages } from '../src/ingest/ingest.js'
import { allAdapters } from '../src/carriers/registry.js'
import { runPickupCodes } from '../src/core/pickup-code.js'
import { getParcel, insertParcel, updateParcelState } from '../src/db/parcels.js'
import { appendEvents } from '../src/db/events.js'
import { buildServer } from '../src/web/server.js'
import { pickupSummary } from '../src/db/parcels.js'
import { STYLE } from '../src/web/views/style.js'
import type { Database } from '../src/db/index.js'
import type { PickupPoint } from '../src/core/types.js'
import { fakeImap } from './imap-fake.js'
import { NOW, config, memDb } from './poll-helpers.js'

/**
 * Regression tests for the bugs the fake-mail corpus run found (test/fixtures/fake-mail/FINDINGS.md).
 * Each `describe` is one finding; the fixtures are the corpus mails themselves, which are synthetic
 * through and through (MANIFEST.md), so they can sit in the repo beside the scrubbed real ones.
 */
const corpus = (name: string) => readFileSync(new URL(`./fixtures/fake-mail/${name}.eml`, import.meta.url))
const real = (name: string) => readFileSync(new URL(`./fixtures/mail/${name}.eml`, import.meta.url))

/** Ingests corpus mails (by name, a day apart, all recent) into a fresh database; returns the database. */
async function ingest(...names: Array<string | Buffer>) {
  const db = memDb()
  const fake = fakeImap(names.map((name, i) => ({
    uid: i + 1, source: typeof name === 'string' ? corpus(name) : name, messageId: `<${i}@fake-mail>`, subject: `mail ${i}`, from: 'x@example.com',
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

describe('F10: Slovenská pošta\'s own mail about an inbound international item (…CN, …DE) is tracked', () => {
  test('customs notice from posta.sk for RB666666042CN', async () => {
    expect(await extract(corpus('57-posta-customs-foreign-s10'))).toMatchObject({
      carrier: 'posta', number: 'RB666666042CN', confidence: 'sender',
    })
  })

  test('from anyone else, a foreign S10 is still not trusted on its shape alone', async () => {
    expect((await extract(eml('Shop <orders@shop.example>', 'Odoslané', 'Číslo zásielky: RB666666042CN'))).number).toBeUndefined()
  })
})

describe('F16: a bare "číslo" (a catalogue or product number) is no sign of a parcel', () => {
  test('the number-heavy newsletter is ignored, not put on /attention', async () => {
    expect(await extract(corpus('07-newsletter-number-like'))).toEqual({ confidence: 'none' })
  })

  test('a number labelled as a PARCEL\'s is still evidence with no carrier named', async () => {
    expect(await extract(eml('Shop <orders@shop.example>', 'Novinky', 'Číslo balíka: 1234567890')))
      .toEqual({ confidence: 'none', evidence: 'tracking-shape' })
  })

  test('an e-shop mail that NAMES GLS may still label its number with a bare "číslo"', async () => {
    expect(await extract(eml('Shop <orders@shop.example>', 'Odoslané cez GLS', 'Sledovacie číslo: 1234567890')))
      .toMatchObject({ carrier: 'gls', number: '1234567890', confidence: 'shape' })
  })
})

describe('F5: a number only in the HTML part is found when the text part is a "view in browser" stub', () => {
  test('multipart/alternative whose text part is one line: the html part\'s number is read', async () => {
    expect(await extract(corpus('41-eshop-number-only-in-html'))).toMatchObject({
      carrier: 'packeta', number: 'Z2222222211', confidence: 'shape', merchant: 'Hobby Dielňa',
    })
  })

  test('a text part that does yield a number still wins over the html part', async () => {
    const raw = Buffer.from([
      'From: Shop <orders@shop.example>', 'Subject: Odoslané', 'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b"', '', '--b', 'Content-Type: text/plain; charset=utf-8', '',
      'Zásielka Z 222 2222 201', '--b', 'Content-Type: text/html; charset=utf-8', '',
      '<p>Zásielka Z 222 2222 202</p>', '--b--', '',
    ].join('\r\n'))
    expect((await extract(raw)).number).toBe('Z2222222201')
  })
})

describe('F15: a very long mail is read at both ends, and one too long to read whole is never silently ignored', () => {
  test('the number in the last lines of a ~470 KB order summary is found', async () => {
    expect(await extract(corpus('59-eshop-very-long-mail'))).toMatchObject({
      carrier: 'packeta', number: 'Z2222222210', confidence: 'shape',
    })
  })

  test('a mail cut in the middle with no sign of a parcel at either end waits on /attention', async () => {
    const body = `${'Obchodné podmienky. '.repeat(20_000)}Zásielka Z 222 2222 210. ${'Článok. '.repeat(10_000)}`
    expect(await extract(eml('Shop <orders@shop.example>', 'Súhrn objednávky', body)))
      .toEqual({ confidence: 'none', evidence: 'too-long' })
  })
})

describe('F4: a carrier mail listing two parcel numbers tracks both', () => {
  test('DPD "Číslo balíka: 01505333333305, 01505333333306": the second is in moreNumbers', async () => {
    expect(await extract(corpus('45-dpd-two-parcels-one-mail'))).toMatchObject({
      carrier: 'dpd', number: '01505333333305', moreNumbers: ['01505333333306'], confidence: 'sender',
    })
  })

  test('only numbers LISTED with the first count; a lone number elsewhere in the mail does not', async () => {
    const e = await extract(eml('no_reply@dpd.sk', 'Zásielka', 'Číslo balíka: 01505333333305\r\nReferencia 01505333333399.'))
    expect(e).toMatchObject({ carrier: 'dpd', number: '01505333333305' })
    expect(e.moreNumbers).toBeUndefined()
  })

  test('ingest: two parcels, both named after the shop', async () => {
    const { parcels, report } = await ingest('45-dpd-two-parcels-one-mail')
    expect(parcels).toEqual([
      { carrier: 'dpd', number: '01505333333305', merchant: 'Nábytok Domov # N-1200' },
      { carrier: 'dpd', number: '01505333333306', merchant: 'Nábytok Domov # N-1200' },
    ])
    expect(report).toMatchObject({ created: 2, needsAttention: 0 })
  })
})

describe('F11: an e-shop mail naming two parcels of one carrier tracks both', () => {
  test('two distinctive Packeta numbers: the first is the number, the second in moreNumbers', async () => {
    expect(await extract(corpus('25-eshop-two-packeta-parcels'))).toMatchObject({
      carrier: 'packeta', number: 'Z2222222205', moreNumbers: ['Z2222222206'], confidence: 'shape', merchant: 'Mobilonline',
    })
  })

  test('ingest: two Packeta parcels, both named after the shop', async () => {
    const { parcels, report } = await ingest('25-eshop-two-packeta-parcels')
    expect(parcels).toEqual([
      { carrier: 'packeta', number: 'Z2222222205', merchant: 'Mobilonline' },
      { carrier: 'packeta', number: 'Z2222222206', merchant: 'Mobilonline' },
    ])
    expect(report).toMatchObject({ created: 2, needsAttention: 0 })
  })

  test('a later mail about the second parcel links to it instead of making another', async () => {
    const { parcels, report, db } = await ingest('25-eshop-two-packeta-parcels',
      eml('Packeta Slovakia <noreply@packeta.sk>', 'Zásielka Z 222 2222 206', 'Vaša zásielka Z 222 2222 206 je na ceste.'))
    expect(parcels).toHaveLength(2)
    expect(report).toMatchObject({ created: 2, linked: 1 })
    const second = db.prepare(`SELECT COUNT(*) n FROM messages m JOIN parcels p ON p.id = m.parcel_id WHERE p.tracking_number = 'Z2222222206'`).get()
    expect(second).toEqual({ n: 1 })
  })

  test('numbers of two DIFFERENT carriers stay ambiguous: a question, not a guess', async () => {
    expect(await extract(eml('Shop <orders@shop.example>', 'Odoslané', 'Z 222 2222 205 a RR123456785SK')))
      .toMatchObject({ confidence: 'none' })
  })
})

describe('F19: Packeta\'s Czech and English mail name the shop, and the Czech one gives the pickup point', () => {
  test.each([
    ['31-zasilkovna-cz-ready-iso8859-2', 'Čokoládovna Příkladná'],   // "od odesílatele … je pro vás"
    ['67-packeta-com-english', 'LedLight Store'],                     // "the sender … has just handed over"
  ])('%s -> %s', async (name, merchant) => {
    expect((await extract(corpus(name))).merchant).toBe(merchant)
  })

  test('"Místo, kde je vaše zásilka uložena" is read like the Slovak block', async () => {
    expect(pickupFromMail(await mailText(corpus('31-zasilkovna-cz-ready-iso8859-2')))).toMatchObject({
      kind: 'zbox', name: 'Z-BOX Testovice, Hlavní 12 (Albert)', street: 'Hlavní 12', city: 'Testovice',
    })
  })

  test('...but not the FUTURE tense ("kde bude"), a box the parcel has not reached', () => {
    expect(pickupFromMail('Místo, kde bude vaše zásilka uložena\nZ-BOX Testovice, Hlavní 12\nHlavní 12 999 11 Testovice\n')).toBeUndefined()
  })
})

describe('F23: a postcode read from mail is stored the way the carriers send theirs', () => {
  test('Packeta\'s "Hlavná 5 999 01 Testovo" fills the parcel\'s point with postcode 99901', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z2222222201', source: 'manual' })
    updateParcelState(db, id, { status: 'ready_for_pickup', statusRaw: 'raw' })
    db.prepare('INSERT INTO messages (message_id, received_at, from_addr, subject, raw_path, parsed_ok, parcel_id) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run('<26@fake-mail>', NOW.toISOString(), 'noreply@packeta.sk', 'Zásielka je pripravená', '/mail/26.eml', id)
    await runPickupCodes({ db, now: NOW, readMail: () => corpus('26-packeta-ready-zbox-code-leading-zero') })
    expect(getParcel(db, id)?.pickup).toMatchObject({ street: 'Hlavná 5', city: 'Testovo', postalCode: '99901' })
  })
})

// --- pages ---------------------------------------------------------------------------------------

const page = async (db: Database, url: string) =>
  (await buildServer({ db, config, now: () => NOW, notifier: { send: async () => {} } }).inject({ method: 'GET', url })).body
const DAY = 86_400_000
const ZBOX: PickupPoint = { kind: 'zbox', name: 'Z-BOX Testovo, Nová 8 (Lidl)', street: 'Nová 8', city: 'Testovo', postalCode: '99901' }

describe('F3: a collected or returned parcel shows no "Collect by" line', () => {
  const parcel = (status: 'ready_for_pickup' | 'delivered' | 'returned', deadlineDays: number) => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z2222222201', source: 'email' })
    updateParcelState(db, id, {
      status, statusRaw: 'raw', pickup: ZBOX, retainedTill: new Date(NOW.getTime() + deadlineDays * DAY),
      ...(status === 'delivered' && { deliveredAt: NOW }),
    })
    return { db, id }
  }

  test.each([
    ['delivered, deadline passed', 'delivered', -3],
    ['delivered, deadline ahead (posta parcel 18: "6 days left")', 'delivered', 6],
    ['returned, deadline passed', 'returned', -5],
  ] as const)('%s', async (_, status, days) => {
    const { db, id } = parcel(status, days)
    const body = await page(db, `/parcel/${id}`)
    expect(body).toContain('Z-BOX Testovo')        // the place is still named
    expect(body).not.toContain('Collect by')
    expect(body).not.toMatch(/deadline passed|days left/)
  })

  test('a parcel still waiting keeps its deadline', async () => {
    const { db, id } = parcel('ready_for_pickup', 3)
    expect(await page(db, `/parcel/${id}`)).toContain('Collect by')
  })
})
