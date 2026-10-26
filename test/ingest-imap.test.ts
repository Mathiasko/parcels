import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { fetchMessages, type RawMessage } from '../src/ingest/imap.js'
import { storeMessage } from '../src/db/messages.js'
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
