import { mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { fetchMessages, receivedAt, type RawMessage } from '../src/ingest/imap.js'
import { dismissMessage, storeMessage } from '../src/db/messages.js'
import { fakeImap, type FakeMessage } from './imap-fake.js'
import { memDb } from './poll-helpers.js'

const imap = { host: 'imap.example.com', port: 993, user: 'u@example.com', pass: 'pw', mailbox: 'parcels' }
const eml = (id: string) => Buffer.from(`Message-ID: <${id}>\r\nFrom: a@packeta.sk\r\nSubject: s\r\n\r\nbody ${id}\r\n`)
const msg = (uid: number, over: Partial<FakeMessage> = {}): FakeMessage => ({
  uid, messageId: `<m${uid}@x>`, subject: `subject ${uid}`, from: 'noreply@packeta.sk',
  date: new Date('2026-10-20T10:00:00Z'), source: eml(`m${uid}@x`), ...over,
})

describe('fetchMessages', () => {
  test('opens the configured mailbox READ-ONLY and reads every message in it, not just unseen ones', async () => {
    const fake = fakeImap([msg(1), msg(2), msg(3)])
    const out = await fetchMessages({ config: imap, client: fake.client })
    expect(fake.locks).toEqual([{ path: 'parcels', readOnly: true, released: true }])
    expect(out.map(m => m.messageId)).toEqual(['<m1@x>', '<m2@x>', '<m3@x>'])
    expect(out[0]).toMatchObject({
      from: 'noreply@packeta.sk', subject: 'subject 1', receivedAt: new Date('2026-10-20T10:00:00Z'),
    })
    expect(out[0]!.raw.toString()).toContain('body m1@x')
    expect(fake.loggedOut()).toBe(true)
  })

  test('no IMAP flag is ever written: nothing but read-only calls reaches the client', async () => {
    const fake = fakeImap([msg(1), msg(2, { size: 10_000_000, source: undefined })])
    await fetchMessages({ config: imap, client: fake.client, maxBytes: 1_000_000 })
    // A store/flag/move/delete/search call would be recorded here AND would have thrown.
    expect(fake.forbidden).toEqual([])
    expect(fake.calls.filter(c => /flag|store|move|delete|copy|append|expunge|search|create|rename/i.test(c))).toEqual([])
    expect(fake.locks.every(l => l.readOnly)).toBe(true)
  })

  test('a flag write is not swallowed: the fake client fails the call', async () => {
    // Guards the guard: proves the fake really would catch a messageFlagsAdd.
    const fake = fakeImap([msg(1)])
    const c = fake.client as unknown as { messageFlagsAdd(): void }
    expect(() => c.messageFlagsAdd()).toThrow(/forbidden IMAP call: messageFlagsAdd/)
    expect(fake.forbidden).toEqual(['messageFlagsAdd'])
  })

  test('messages the database already holds are not downloaded again', async () => {
    const fake = fakeImap([msg(1), msg(2), msg(3)])
    const out = await fetchMessages({ config: imap, client: fake.client, known: id => id === '<m2@x>' })
    expect(out.map(m => m.messageId)).toEqual(['<m1@x>', '<m3@x>'])
    expect(fake.downloaded).toEqual([1, 3])
  })

  test('a message over the size cap is reported as oversize and its body is never downloaded', async () => {
    const fake = fakeImap([msg(1), msg(2, { size: 9_000, source: Buffer.alloc(0) })])
    const out = await fetchMessages({ config: imap, client: fake.client, maxBytes: 5_000 })
    expect(fake.downloaded).toEqual([1])
    expect(out[1]).toMatchObject({ messageId: '<m2@x>', subject: 'subject 2', oversize: true })
    expect(out[1]!.raw.length).toBe(0)
  })

  test('resolves to an empty array when the mailbox is empty', async () => {
    const fake = fakeImap([])
    expect(await fetchMessages({ config: imap, client: fake.client })).toEqual([])
    expect(fake.locks[0]!.released).toBe(true)
  })

  test('a message with no Message-ID gets a stable synthetic id, so it still deduplicates', async () => {
    const a = await fetchMessages({ config: imap, client: fakeImap([msg(1, { messageId: undefined })]).client })
    const b = await fetchMessages({ config: imap, client: fakeImap([msg(9, { messageId: undefined })]).client })
    expect(a[0]!.messageId).toMatch(/^<no-id-[0-9a-f]{16,}@parcels>$/)
    expect(a[0]!.messageId).not.toBe(b[0]!.messageId)   // different uid -> different message
    const again = await fetchMessages({ config: imap, client: fakeImap([msg(1, { messageId: undefined })]).client })
    expect(again[0]!.messageId).toBe(a[0]!.messageId)
  })

  test('a connection failure rejects with the cause; a failure mid-fetch still releases the lock and logs out', async () => {
    const down = fakeImap([], { connectError: new Error('getaddrinfo ENOTFOUND imap.example.com') })
    await expect(fetchMessages({ config: imap, client: down.client })).rejects.toThrow(/ENOTFOUND/)
    expect(down.forbidden).toEqual([])

    const broken = fakeImap([msg(1)], { fetchError: new Error('connection reset') })
    await expect(fetchMessages({ config: imap, client: broken.client })).rejects.toThrow(/connection reset/)
    expect(broken.locks[0]!.released).toBe(true)
    expect(broken.loggedOut()).toBe(true)
  })
})

describe('received date', () => {
  test('is the later of the Date header and INTERNALDATE, so a bogus-old header cannot age a fresh message', async () => {
    const arrived = new Date('2026-10-25T08:00:00Z')
    const out = await fetchMessages({
      config: imap, client: fakeImap([msg(1, { date: new Date('2020-01-01T00:00:00Z'), internalDate: arrived })]).client,
    })
    expect(out[0]!.receivedAt).toEqual(arrived)
  })

  test('a genuinely old message keeps its header date when the server agrees', async () => {
    const old = new Date('2023-08-11T08:50:03Z')
    const out = await fetchMessages({ config: imap, client: fakeImap([msg(1, { date: old, internalDate: old })]).client })
    expect(out[0]!.receivedAt).toEqual(old)
  })

  test('falls back to whichever exists', () => {
    const d = new Date('2026-01-01T00:00:00Z')
    expect(receivedAt(d, undefined)).toEqual(d)
    expect(receivedAt(undefined, d)).toEqual(d)
    expect(receivedAt(new Date('2026-02-01T00:00:00Z'), d)).toEqual(new Date('2026-02-01T00:00:00Z'))   // bogus-future header: safe direction
  })
})

describe('storeMessage', () => {
  const raw = (over: Partial<RawMessage> = {}): RawMessage => ({
    messageId: '<one@x>', from: 'noreply@packeta.sk', subject: 'Zásielka', receivedAt: new Date('2026-10-20T10:00:00Z'),
    raw: eml('one@x'), ...over,
  })
  const dir = () => mkdtempSync(join(tmpdir(), 'parcels-mail-'))

  test('writes the raw eml to disk and records its path', () => {
    const db = memDb(); const d = dir()
    const id = storeMessage(db, raw(), d)
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown>
    expect(row).toMatchObject({
      message_id: '<one@x>', from_addr: 'noreply@packeta.sk', subject: 'Zásielka',
      received_at: '2026-10-20T10:00:00.000Z', parsed_ok: 0, parcel_id: null,
    })
    expect(row.raw_path).toBe(join(d, `${id}.eml`))
    expect(readFileSync(row.raw_path as string).equals(eml('one@x'))).toBe(true)
  })

  test('the mail directory is owner-only (0700) and each .eml is 0600: it holds pickup PINs and personal mail', () => {
    const db = memDb()
    const d = join(dir(), 'mail')   // not created yet: storeMessage makes it
    const id = storeMessage(db, raw(), d)
    expect(statSync(d).mode & 0o777).toBe(0o700)
    expect(statSync(join(d, `${id}.eml`)).mode & 0o777).toBe(0o600)
  })

  test('is idempotent on message-id: a second store returns the same row and writes nothing new', () => {
    const db = memDb(); const d = dir()
    const first = storeMessage(db, raw(), d)
    const second = storeMessage(db, raw({ subject: 'forwarded again' }), d)
    expect(second).toBe(first)
    expect((db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT subject FROM messages').get() as { subject: string }).subject).toBe('Zásielka')
  })

  test('an oversize message is recorded as unparsed, with a note and no file', () => {
    const db = memDb(); const d = dir()
    const id = storeMessage(db, raw({ raw: Buffer.alloc(0), oversize: true }), d)
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown>
    expect(row).toMatchObject({ parsed_ok: 0, raw_path: null })
    expect(String(row.parse_note)).toMatch(/size cap/i)
    expect(existsSync(join(d, `${id}.eml`))).toBe(false)
  })

  test('a failed disk write leaves no row behind, so the message is retried next run', () => {
    const db = memDb()
    expect(() => storeMessage(db, raw(), '/dev/null/not-a-dir')).toThrow()
    expect((db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n).toBe(0)
  })
})

describe('dismissMessage', () => {
  const row = (db: ReturnType<typeof memDb>, id: number) =>
    db.prepare('SELECT parsed_ok, parcel_id, parse_note, raw_path FROM messages WHERE id = ?').get(id) as Record<string, unknown>
  const unparsed = (db: ReturnType<typeof memDb>, path = '/tmp/1.eml') =>
    Number(db.prepare("INSERT INTO messages (message_id, subject, raw_path, parsed_ok) VALUES ('<junk@x>', 'Verification of your e-mail', ?, 0)")
      .run(path).lastInsertRowid)
  /** A stored message whose .eml really is on disk, so its deletion can be observed. */
  const withFile = (db: ReturnType<typeof memDb>) => {
    const path = join(mkdtempSync(join(tmpdir(), 'parcels-dismiss-')), '1.eml')
    writeFileSync(path, eml('junk@x'))
    return { id: unparsed(db, path), path }
  }

  test('marks junk mail parsed with a note, leaving it unassigned, and deletes the .eml it will never read again', () => {
    const db = memDb()
    const { id, path } = withFile(db)
    expect(dismissMessage(db, id)).toBe(true)
    // raw_path goes with the file: a path to a file that is not there is worse than no path.
    expect(row(db, id)).toMatchObject({ parsed_ok: 1, parcel_id: null, parse_note: 'Dismissed', raw_path: null })
    expect(existsSync(path)).toBe(false)
  })

  test('a .eml that is already gone is not an error: the dismissal still happens', () => {
    const db = memDb()
    const { id, path } = withFile(db)
    rmSync(path)
    expect(dismissMessage(db, id)).toBe(true)
    expect(row(db, id)).toMatchObject({ parsed_ok: 1, raw_path: null })
  })

  test('a message that never had a file (over the size cap) dismisses just the same', () => {
    const db = memDb()
    const id = Number(db.prepare("INSERT INTO messages (message_id, subject, parsed_ok) VALUES ('<big@x>', 'huge', 0)").run().lastInsertRowid)
    expect(dismissMessage(db, id)).toBe(true)
    expect(row(db, id)).toMatchObject({ parsed_ok: 1, raw_path: null })
  })

  test('an assigned message keeps its .eml: only mail that will never be read again is pruned', () => {
    const db = memDb()
    const { id, path } = withFile(db)
    db.prepare("INSERT INTO parcels (carrier, tracking_number, status, first_seen_at, source) VALUES ('gls','000000000009','unknown','x','manual')").run()
    db.prepare('UPDATE messages SET parsed_ok = 1, parcel_id = 1 WHERE id = ?').run(id)
    expect(dismissMessage(db, id)).toBe(false)
    expect(existsSync(path)).toBe(true)                      // the pickup-code scanner still reads it
    expect(row(db, id)).toMatchObject({ raw_path: path })
  })

  test('a second dismiss, an assigned message and an unknown id are all no-ops', () => {
    const db = memDb()
    const id = unparsed(db)
    dismissMessage(db, id)
    expect(dismissMessage(db, id)).toBe(false)

    const assigned = Number(db.prepare("INSERT INTO messages (message_id, subject, parsed_ok) VALUES ('<ok@x>', 'Shipped', 0)").run().lastInsertRowid)
    db.prepare("INSERT INTO parcels (carrier, tracking_number, status, first_seen_at, source) VALUES ('gls','000000000009','unknown','x','manual')").run()
    db.prepare('UPDATE messages SET parsed_ok = 1, parcel_id = 1 WHERE id = ?').run(assigned)
    expect(dismissMessage(db, assigned)).toBe(false)
    expect(row(db, assigned)).toMatchObject({ parcel_id: 1, parse_note: null })   // the link is not overwritten

    expect(dismissMessage(db, 404)).toBe(false)
  })
})
