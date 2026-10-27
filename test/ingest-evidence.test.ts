import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { extract } from '../src/ingest/extract.js'
import { ingestMessages, reprocessMessages, type IngestDeps } from '../src/ingest/ingest.js'
import { runPoll, summarize } from '../src/core/poll.js'
import { allAdapters } from '../src/carriers/registry.js'
import { findParcel } from '../src/db/parcels.js'
import { dismissMessages } from '../src/db/messages.js'
import { getUnparsedMessage, listUnparsedMessages } from '../src/web/queries.js'
import { buildServer } from '../src/web/server.js'
import type { Database } from '../src/db/index.js'
import { fakeImap, type FakeMessage } from './imap-fake.js'
import { bodyHttp, config, memDb, NOW, okResult, stubAdapter } from './poll-helpers.js'

const imap = { host: 'imap.example.com', port: 993, user: 'u@example.com', pass: 'pw', mailbox: 'parcels' }
const DAY = 86_400_000

/** One message, built inline: the subject and the sender ARE the test in most of these cases. */
function msg(uid: number, from: string, subject: string, body: string, over: Partial<FakeMessage> = {}): FakeMessage {
  const source = Buffer.from(
    `From: Sender <${from}>\r\nTo: recipient@example.com\r\nSubject: ${subject}\r\n`
    + `Message-ID: <evidence-${uid}@fixture>\r\nMIME-Version: 1.0\r\n`
    + `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`,
  )
  return {
    uid, source, messageId: `<evidence-${uid}@fixture>`, subject, from,
    date: new Date(NOW.getTime() - DAY), ...over,
  }
}

function setup(messages: FakeMessage[], over: Partial<IngestDeps> = {}) {
  const db = memDb()
  const fake = fakeImap(messages)
  const deps: IngestDeps = {
    imap, client: fake.client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-evidence-')),
    now: NOW, adapters: allAdapters(), defaultPostalCode: '81101', ...over,
  }
  return { db, fake, deps }
}

const rows = (db: Database) =>
  db.prepare('SELECT id, subject, parsed_ok, parcel_id, ignored, parse_note FROM messages ORDER BY id')
    .all() as Array<{ id: number; subject: string; parsed_ok: number; parcel_id: number | null; ignored: number; parse_note: string | null }>

const subjects = (db: Database) => listUnparsedMessages(db).map(m => m.subject)

// The real mail that forced this: Gmail labels CONVERSATIONS, so one shipping message in an order
// thread drags the invoices and the order confirmations in with it.
const INVOICE = ['objednavky@mtbiker.sk', 'MTBIKER shop - Faktúra k objednávke č. 1410452',
  'Ahoj Matus, v prílohe nájdeš faktúru k objednávke č. 1410452. Suma 125,00 EUR. Variabilný symbol 1410452.'] as const
const ORDER_CONFIRMED = ['sluzobnicek@alza.sk', 'Ďakujeme za objednávku 562638869',
  'Objednávka 562638869 bola prijatá. Celkovo na úhradu 1 339,00 EUR. Zvolený spôsob platby: TatraPay.'] as const

describe('evidence that a message is about a parcel at all', () => {
  test('an invoice with no parcel signal is stored, but never listed on /attention', async () => {
    const { db, deps } = setup([msg(1, ...INVOICE)])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 1, created: 0, needsAttention: 0, ignored: 1 })

    // The row is still there - it is the Message-ID dedupe key and the watermark depends on it.
    expect(rows(db)).toHaveLength(1)
    expect(rows(db)[0]).toMatchObject({ parsed_ok: 0, parcel_id: null, ignored: 1 })
    // ...and it says WHY, so "where did my email go" is answerable from the database alone.
    expect(rows(db)[0]!.parse_note).toMatch(/ignored/i)
    expect(rows(db)[0]!.parse_note).toMatch(/no sign of a parcel/i)

    expect(listUnparsedMessages(db)).toEqual([])
    expect(getUnparsedMessage(db, rows(db)[0]!.id)).toBeUndefined()
  })

  test('an order confirmation whose only number is the shop\'s own is ignored too', async () => {
    const { db, deps } = setup([msg(1, ...ORDER_CONFIRMED)])
    expect(await ingestMessages(db, deps)).toMatchObject({ needsAttention: 0, ignored: 1 })
    expect(listUnparsedMessages(db)).toEqual([])
  })

  test('a mail naming a carrier with a number nothing can parse IS listed', async () => {
    const { db, deps } = setup([msg(1, 'orders@shop.example', 'Order update',
      'Your order will be delivered by GLS. Reference GLS/XX-7 (not a number we can read).')])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ created: 0, needsAttention: 1, ignored: 0 })
    expect(subjects(db)).toEqual(['Order update'])
    // The note distinguishes "looked like a parcel, could not parse it" from "ignored".
    expect(rows(db)[0]!.parse_note).toMatch(/no tracking number/i)
    expect(rows(db)[0]!.parse_note).not.toMatch(/ignored/i)
  })

  test('a mail from a carrier domain is always listed, even when nothing at all parses', async () => {
    const { db, deps } = setup([msg(1, 'noreply@packeta.sk', 'Overenie aplikácie', 'Váš kód je 123456.')])
    expect(await ingestMessages(db, deps)).toMatchObject({ needsAttention: 1, ignored: 0 })
    expect(subjects(db)).toEqual(['Overenie aplikácie'])
  })

  test('shipping wording in the SUBJECT is enough on its own', async () => {
    const { db, deps } = setup([
      msg(1, 'sluzobnicek@alza.sk', 'Pripravené v AlzaBoxe / Obj. č. 562638869', 'Objednávka 562638869 je pripravená.'),
      msg(2, 'objednavky@mtbiker.sk', 'MTBIKER shop - Objednávka č. 1410452 pripravená na prevzatie',
        'Tvoja objednávka č. 1410452 je pripravená. Spôsob doručenia: Osobný odber v MTBIKER Bratislava.'),
      msg(3, 'orders@shop.example', 'Your parcel is on its way', 'Thanks for shopping with us.'),
    ])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 3, created: 0, needsAttention: 3, ignored: 0 })
    expect(subjects(db)).toHaveLength(3)
  })

  test('a distinctive tracking-number shape is enough, with no carrier named and no wording', async () => {
    // Two Slovenska posta numbers in a note from a person: ambiguous, so NOTHING parses and the
    // shape is the only signal there is. A single number would prove nothing here - it would become
    // a parcel and never reach the evidence test at all.
    const { db, deps } = setup([msg(1, 'friend@example.com', 'FYI', 'EB629066058SK a EB629066059SK')])
    expect(await ingestMessages(db, deps)).toMatchObject({ created: 0, needsAttention: 1, ignored: 0 })
    expect(subjects(db)).toEqual(['FYI'])
  })

  test('shipping wording in the BODY is NOT evidence: every invoice from the shop has it', async () => {
    // Alza prints "Doprava - AlzaBox" and "môžete vyzdvihnúť" in the footer of every mail it sends,
    // invoices included. Reading the body for those words would put the whole order thread back on
    // the page, which is the problem this rule exists to solve.
    const { db, deps } = setup([msg(1, 'sluzobnicek@alza.sk', 'Ďakujeme za objednávku 562638869',
      'Objednávka 562638869 bola prijatá.\r\n1x Doprava - AlzaBox 2,67 EUR\r\n'
      + 'Do svojho AlzaBoxu môžete vrátiť, alebo reklamovať tovar, a po vybavení si zariadenie aj vyzdvihnúť.')])
    expect(await ingestMessages(db, deps)).toMatchObject({ needsAttention: 0, ignored: 1 })
    expect(listUnparsedMessages(db)).toEqual([])
  })

  test('a labelled bare-digit number is enough; the shop\'s own order number is not', async () => {
    const { db, deps } = setup([
      msg(1, 'orders@shop.example', 'Update', 'Číslo zásielky je 1930144672. Status bude aktualizovaný.'),
      msg(2, 'orders@shop.example', 'Update', 'Číslo objednávky 1930144672. Ďakujeme.', { messageId: '<ev-2@fixture>' }),
    ])
    const r = await ingestMessages(db, deps)
    // The first has a parcel-labelled number (and parses: GLS has no distinctive shape, so a bare
    // labelled number with no carrier named cannot become a parcel, but it IS evidence).
    expect(r).toMatchObject({ read: 2, needsAttention: 1, ignored: 1 })
    expect(subjects(db)).toEqual(['Update'])
  })

  test('a message that could not be read at all is listed, never ignored', async () => {
    // Nothing readable means no basis for saying it is NOT a parcel: err toward showing.
    const { db, deps } = setup([msg(1, 'x@example.com', 'Lunch?', 'hi', { source: Buffer.from([0, 255, 254, 1]) })])
    expect(await ingestMessages(db, deps)).toMatchObject({ needsAttention: 1, ignored: 0 })
    expect((await extract(Buffer.from([0, 255, 254, 1]))).evidence).toBe('unreadable')
    // And when the parse THROWS rather than yielding nothing, which is the other half of the same
    // judgement: `mailparser` does not throw on any byte sequence tried, but it does on a value that
    // is not a message at all, and that is the only way to reach the catch.
    expect((await extract({} as unknown as Buffer)).evidence).toBe('unreadable')
  })

  test('an over-size message is listed: there is no body to judge it by', async () => {
    const { db, deps } = setup([msg(1, ...INVOICE, { size: 50_000_000 })])
    expect(await ingestMessages(db, deps)).toMatchObject({ needsAttention: 1, ignored: 0 })
    expect(subjects(db)).toHaveLength(1)
  })

  test('the attention page does not render an ignored message', async () => {
    const { db, deps } = setup([msg(1, ...INVOICE), msg(2, 'noreply@packeta.sk', 'Overenie', 'kód 123456', { messageId: '<ev-2@fixture>' })])
    await ingestMessages(db, deps)
    const res = await buildServer({ db, config, now: () => NOW, notifier: { send: async () => {} } })
      .inject({ method: 'GET', url: '/attention' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Overenie')
    expect(res.body).not.toContain('Faktúra')
  })

  test('a bulk dismissal cannot reach an ignored message, so its count stays honest', async () => {
    const { db, deps } = setup([msg(1, ...INVOICE), msg(2, 'noreply@packeta.sk', 'Overenie', 'kód 123456', { messageId: '<ev-2@fixture>' })])
    await ingestMessages(db, deps)
    const upTo = rows(db).reduce((hi, r) => Math.max(hi, r.id), 0)
    expect(dismissMessages(db, { upTo })).toBe(1)
    // The ignored row is untouched: still pending, still reprocessable, its .eml still on disk.
    expect(rows(db).find(r => r.ignored === 1)).toMatchObject({ parsed_ok: 0, parcel_id: null })
  })
})

describe('an ignored message is still reprocessed', () => {
  test('reprocess reaches it and can turn it into a parcel once the parser improves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parcels-ev-reproc-'))
    // Reads as an invoice today: no carrier, no number, nothing that says "parcel".
    const { db, deps } = setup([msg(1, ...INVOICE)], { mailDir: dir })
    expect(await ingestMessages(db, deps)).toMatchObject({ ignored: 1, needsAttention: 0 })

    // What a parser fix amounts to here: the same stored bytes now yield a parcel. Rewriting the
    // .eml in place is the cheapest way to say "extraction reads this message differently now".
    const path = (db.prepare('SELECT raw_path FROM messages').get() as { raw_path: string }).raw_path
    writeFileSync(path, msg(1, 'objednavky@mtbiker.sk', 'MTBIKER shop - Objednávka č. 1410452 odoslaná',
      'Zásielka je na ceste s GLS. Číslo zásielky je 1930144672.').source!)

    const r = await reprocessMessages(db, { now: NOW, adapters: allAdapters(), defaultPostalCode: '81101' })
    expect(r).toMatchObject({ read: 1, created: 1, ignored: 0, needsAttention: 0 })
    expect(findParcel(db, 'gls', '1930144672')).toBeDefined()
    expect(rows(db)[0]).toMatchObject({ parsed_ok: 1, ignored: 0 })
  })

  test('a reprocess that still finds no parcel leaves it ignored, not on the page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parcels-ev-reproc2-'))
    const { db, deps } = setup([msg(1, ...INVOICE)], { mailDir: dir })
    await ingestMessages(db, deps)
    const r = await reprocessMessages(db, { now: NOW, adapters: allAdapters(), defaultPostalCode: '81101' })
    expect(r).toMatchObject({ read: 1, created: 0, needsAttention: 0, ignored: 1 })
    expect(listUnparsedMessages(db)).toEqual([])
  })

  test('a message that becomes visible on reprocess loses its ignored flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parcels-ev-reproc3-'))
    const { db, deps } = setup([msg(1, ...INVOICE)], { mailDir: dir })
    await ingestMessages(db, deps)
    const path = (db.prepare('SELECT raw_path FROM messages').get() as { raw_path: string }).raw_path
    // Same mail, but now it names a carrier and a number nothing can parse: a real question.
    writeFileSync(path, msg(1, 'objednavky@mtbiker.sk', 'Faktúra', 'Doručuje GLS, číslo neznáme.').source!)

    const r = await reprocessMessages(db, { now: NOW, adapters: allAdapters(), defaultPostalCode: '81101' })
    expect(r).toMatchObject({ created: 0, needsAttention: 1, ignored: 0 })
    expect(rows(db)[0]).toMatchObject({ parsed_ok: 0, parcel_id: null, ignored: 0 })
    expect(listUnparsedMessages(db)).toHaveLength(1)
  })
})

describe('an ignored message is still deduped', () => {
  test('a second delivery of the same Message-ID does not duplicate it', async () => {
    const { db, deps } = setup([msg(1, ...INVOICE)])
    expect(await ingestMessages(db, deps)).toMatchObject({ read: 1, ignored: 1 })

    const again = fakeImap([msg(1, ...INVOICE)])
    const r = await ingestMessages(db, { ...deps, client: again.client })
    expect(r).toMatchObject({ read: 0, ignored: 0, needsAttention: 0 })
    expect(again.downloaded).toEqual([])                    // known Message-ID: not even downloaded
    expect(rows(db)).toHaveLength(1)
    expect(rows(db)[0]).toMatchObject({ ignored: 1 })
  })
})

describe('the poll summary says how many were ignored', () => {
  test('the count is in the line, so it is visible rather than silently swallowed', async () => {
    const db = memDb()
    const fake = fakeImap([
      msg(1, ...INVOICE),
      msg(2, ...ORDER_CONFIRMED, { messageId: '<ev-2@fixture>' }),
      msg(3, 'noreply@packeta.sk', 'Zásielka bola prijatá', 'Číslo zásielky Z 000 0000 001', { messageId: '<ev-3@fixture>' }),
    ])
    const adapter = stubAdapter('packeta', inputs => inputs.map(i => okResult(i.number, [])))
    const report = await runPoll({
      db, http: bodyHttp(), adapters: [adapter], config, now: NOW,
      ingest: { imap, client: fake.client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-ev-poll-')) },
    })
    expect(report.ingest).toMatchObject({ read: 3, created: 1, needsAttention: 0, ignored: 2 })
    expect(summarize(report)).toMatch(/mail: 3 new, 1 parcel\(s\) created, 2 ignored/)
  })

  test('nothing ignored says nothing about ignoring', async () => {
    const db = memDb()
    const fake = fakeImap([msg(1, 'noreply@packeta.sk', 'Zásielka bola prijatá', 'Číslo zásielky Z 000 0000 001')])
    const report = await runPoll({
      db, http: bodyHttp(), adapters: [], config, now: NOW,
      ingest: { imap, client: fake.client, mailDir: mkdtempSync(join(tmpdir(), 'parcels-ev-poll2-')) },
    })
    expect(summarize(report)).not.toMatch(/ignored/)
  })
})
