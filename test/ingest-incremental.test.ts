import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { fetchMessages } from '../src/ingest/imap.js'
import { ingestMessages, type IngestDeps } from '../src/ingest/ingest.js'
import { accountKey, getImapState } from '../src/db/imap-state.js'
import { allAdapters } from '../src/carriers/registry.js'
import { findParcel } from '../src/db/parcels.js'
import type { Database } from '../src/db/index.js'
import { fakeImap, UID_VALIDITY, type FakeMessage } from './imap-fake.js'
import { NOW, memDb } from './poll-helpers.js'

const DAY = 86_400_000
const imap = { host: 'imap.example.com', port: 993, user: 'u@example.com', pass: 'pw', mailbox: 'parcels' }

/** A Packeta "accepted for transport" mail for parcel `n`, so the ingest makes a real parcel of it. */
const source = (n: number) => {
  const d = String(n).padStart(10, '0')
  return Buffer.from(
    'From: noreply@packeta.sk\r\nTo: me@example.com\r\nSubject: Zásielka bola prijatá do prepravy\r\n'
    + 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'
    + `Číslo zásielky Z ${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}\r\n`,
  )
}
const number = (n: number) => `Z${String(n).padStart(10, '0')}`

/**
 * Message `n` of the mailbox, at UID `uid`. The Message-ID is keyed on `n` and NOT on the UID, so the
 * same message can be given a new UID (which is what Gmail does when a label is applied to old mail).
 */
const mail = (uid: number, n: number, over: Partial<FakeMessage> = {}): FakeMessage => ({
  uid, messageId: `<p${n}@fixture>`, subject: 'Zásielka bola prijatá do prepravy',
  from: 'noreply@packeta.sk', date: new Date(NOW.getTime() - 2 * DAY), source: source(n), ...over,
})

const mailDir = () => mkdtempSync(join(tmpdir(), 'parcels-incr-'))

function setup(messages: FakeMessage[], over: Partial<IngestDeps> = {}) {
  const db = memDb()
  const fake = fakeImap(messages)
  const deps: IngestDeps = {
    imap, client: fake.client, mailDir: mailDir(),
    now: NOW, adapters: allAdapters(), defaultPostalCode: '81101', ...over,
  }
  return { db, fake, deps }
}

/** The next run over `messages`, with its own client so the ranges it asked for can be inspected. */
async function rerun(db: Database, deps: IngestDeps, messages: FakeMessage[], opts: Parameters<typeof fakeImap>[1] = {}) {
  const fake = fakeImap(messages, opts)
  const report = await ingestMessages(db, { ...deps, client: fake.client })
  return { fake, report }
}

const stored = (db: Database) => getImapState(db, accountKey(imap), imap.mailbox)

describe('incremental IMAP: the watermark', () => {
  test('the first run against an existing mailbox reads it in full, as it always did, and records what it saw', async () => {
    const { db, fake, deps } = setup([mail(10, 1), mail(11, 2)])
    const r = await ingestMessages(db, deps)
    expect(r).toMatchObject({ read: 2, created: 2 })
    expect(fake.fetches).toEqual([{ range: '1:*', uid: true }])
    expect(stored(db)).toEqual({ uidValidity: String(UID_VALIDITY), lastUid: 11 })
  })

  test('the second run fetches only above the watermark, so the cost stops growing with the label', async () => {
    const { db, deps } = setup([mail(10, 1), mail(11, 2)])
    await ingestMessages(db, deps)

    const next = await rerun(db, deps, [mail(10, 1), mail(11, 2), mail(12, 3)])
    expect(next.fake.fetches).toEqual([{ range: '12:*', uid: true }])
    expect(next.report).toMatchObject({ read: 1, created: 1 })
    expect(next.fake.downloaded).toEqual([12])          // the two known messages are not even enveloped
    expect(findParcel(db, 'packeta', number(3))).toBeDefined()
    expect(stored(db)).toEqual({ uidValidity: String(UID_VALIDITY), lastUid: 12 })
  })

  test('the watermark is per account and mailbox: another label is scanned in full', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    const other = { ...imap, mailbox: 'parcels-archive' }
    const next = await rerun(db, { ...deps, imap: other }, [mail(4, 2)])
    expect(next.fake.fetches).toEqual([{ range: '1:*', uid: true }])
    expect(next.report).toMatchObject({ read: 1 })
    expect(getImapState(db, accountKey(other), other.mailbox)).toEqual({ uidValidity: String(UID_VALIDITY), lastUid: 4 })
    expect(stored(db)).toEqual({ uidValidity: String(UID_VALIDITY), lastUid: 10 })   // untouched
  })

  test('a different account on the same mailbox name does not inherit the other one\'s UIDs', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    const next = await rerun(db, { ...deps, imap: { ...imap, user: 'someone-else@example.com' } }, [mail(4, 2)])
    expect(next.fake.fetches).toEqual([{ range: '1:*', uid: true }])
    expect(next.report).toMatchObject({ read: 1 })
  })
})

describe('incremental IMAP: UIDVALIDITY', () => {
  test('a changed UIDVALIDITY rescans the whole mailbox, so renumbered mail BELOW the watermark is still seen', async () => {
    const { db, deps } = setup([mail(10, 1), mail(11, 2)])
    await ingestMessages(db, deps)
    expect(stored(db)!.lastUid).toBe(11)

    // The server has renumbered everything: the same two messages are now UID 1 and 2, and a message
    // that was never seen is UID 3. Every stored UID is meaningless, and 12:* would find nothing at all.
    const next = await rerun(db, deps, [mail(1, 1), mail(2, 2), mail(3, 3)], { uidValidity: 7777 })
    expect(next.fake.fetches).toEqual([{ range: '1:*', uid: true }])
    expect(next.report).toMatchObject({ read: 1, created: 1 })
    expect(findParcel(db, 'packeta', number(3))).toBeDefined()
    expect(stored(db)).toEqual({ uidValidity: '7777', lastUid: 3 })   // the new promise replaces the old one
  })

  test('an UNCHANGED UIDVALIDITY is what permits the range: the same mailbox, same promise, resumes', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    const next = await rerun(db, deps, [mail(10, 1), mail(11, 2)], { uidValidity: UID_VALIDITY })
    expect(next.fake.fetches).toEqual([{ range: '11:*', uid: true }])
    expect(next.report).toMatchObject({ read: 1 })
  })

  test('a server that reports no UIDVALIDITY is never resumed from: full scan every run, nothing stored', async () => {
    const { db, deps } = setup([mail(10, 1)], {})
    const first = await rerun(db, deps, [mail(10, 1)], { uidValidity: null })
    expect(first.fake.fetches).toEqual([{ range: '1:*', uid: true }])
    expect(stored(db)).toBeUndefined()
    const next = await rerun(db, deps, [mail(10, 1), mail(11, 2)], { uidValidity: null })
    expect(next.fake.fetches).toEqual([{ range: '1:*', uid: true }])
    expect(next.report).toMatchObject({ read: 1 })
  })

  test('a server that selects the mailbox but reports nothing about it behaves exactly as today', async () => {
    const { db, deps } = setup([mail(10, 1)])
    const first = await rerun(db, deps, [mail(10, 1)], { noMailboxObject: true })
    expect(first.fake.fetches).toEqual([{ range: '1:*', uid: true }])
    expect(first.report).toMatchObject({ read: 1 })
    expect(stored(db)).toBeUndefined()
  })

  test('UIDVALIDITY 0 is not a promise (RFC 9051: it is non-zero), so it is treated as unknown', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await rerun(db, deps, [mail(10, 1)], { uidValidity: 0 })
    expect(stored(db)).toBeUndefined()
  })

  test('a 32-bit UIDVALIDITY arriving as a BigInt is stored and compared without losing a digit', async () => {
    const big = 4294967295n
    const { db, deps } = setup([mail(10, 1)])
    await rerun(db, deps, [mail(10, 1)], { uidValidity: big })
    expect(stored(db)).toEqual({ uidValidity: '4294967295', lastUid: 10 })
    const next = await rerun(db, deps, [mail(10, 1), mail(11, 2)], { uidValidity: big })
    expect(next.fake.fetches).toEqual([{ range: '11:*', uid: true }])
  })
})

describe('incremental IMAP: a run that does not finish', () => {
  test('a failure mid-fetch does not advance the watermark, so the mail it never read is read next time', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    expect(stored(db)!.lastUid).toBe(10)

    const broken = fakeImap([mail(10, 1), mail(11, 2), mail(12, 3)], { fetchError: new Error('connection reset') })
    await expect(ingestMessages(db, { ...deps, client: broken.client })).rejects.toThrow(/connection reset/)
    expect(stored(db)!.lastUid).toBe(10)                 // NOT 12: nothing was read

    const next = await rerun(db, deps, [mail(10, 1), mail(11, 2), mail(12, 3)])
    expect(next.fake.fetches).toEqual([{ range: '11:*', uid: true }])
    expect(next.report).toMatchObject({ read: 2, created: 2 })
  })

  test('a body that could not be downloaded does not advance the watermark either', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    // Envelopes arrived; the connection died on the first BODY.PEEK.
    const fake = fakeImap([mail(10, 1), mail(11, 2)], { fetchOneError: new Error('connection closed mid-download') })
    await expect(ingestMessages(db, { ...deps, client: fake.client })).rejects.toThrow(/mid-download/)
    expect(stored(db)!.lastUid).toBe(10)
  })

  test('a message that failed to store keeps the watermark where it was: it has no row, so it must stay in range', async () => {
    const { db, deps } = setup([mail(10, 1), mail(11, 2)])
    await ingestMessages(db, deps)

    // Message row 3 cannot be written: a directory sits where 3.eml goes (the same trick the
    // one-message-is-one-unit tests use).
    const dir = mailDir()
    mkdirSync(join(dir, '3.eml', 'x'), { recursive: true })
    const blocked = fakeImap([mail(12, 3)])
    const failed = await ingestMessages(db, { ...deps, client: blocked.client, mailDir: dir })
    expect(failed).toMatchObject({ read: 1, created: 0, failed: 1 })
    expect(stored(db)!.lastUid).toBe(11)

    const next = await rerun(db, deps, [mail(12, 3)])
    expect(next.fake.fetches).toEqual([{ range: '12:*', uid: true }])
    expect(next.report).toMatchObject({ read: 1, created: 1, failed: 0 })
    expect(findParcel(db, 'packeta', number(3))).toBeDefined()
  })
})

describe('incremental IMAP: nothing new', () => {
  test('when UIDNEXT says there is nothing new, no FETCH is issued at all', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    const next = await rerun(db, deps, [mail(10, 1)])
    expect(next.fake.fetches).toEqual([])
    expect(next.report).toMatchObject({ read: 0, created: 0, failed: 0 })
    expect(stored(db)).toEqual({ uidValidity: String(UID_VALIDITY), lastUid: 10 })
  })

  test('a server that answers the empty range with its highest message anyway yields nothing new', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    // No UIDNEXT to go on, so the range IS issued; the server answers 11:* with UID 10.
    const next = await rerun(db, deps, [mail(10, 1)], { uidNext: null, emptyRangeYieldsHighest: true })
    expect(next.fake.fetches).toEqual([{ range: '11:*', uid: true }])
    expect(next.report).toMatchObject({ read: 0, failed: 0 })
    expect(next.fake.downloaded).toEqual([])
    expect(stored(db)!.lastUid).toBe(10)                 // and it does not go BACKWARDS to 10's own value
  })

  test('a server that refuses an empty UID set is not an error either: there is simply no new mail', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    const refusal = Object.assign(new Error('Invalid messageset'), { responseStatus: 'BAD', responseText: 'Invalid messageset' })
    const next = await rerun(db, deps, [mail(10, 1)], { uidNext: null, emptyRangeError: refusal })
    expect(next.report).toMatchObject({ read: 0, failed: 0 })
    expect(next.report.error).toBeUndefined()
    expect(stored(db)!.lastUid).toBe(10)
  })

  test('but a real failure on that same range is still a failure, not an empty mailbox', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    const dead = Object.assign(new Error('socket closed unexpectedly'), { code: 'ECONNRESET' })
    const fake = fakeImap([mail(10, 1)], { uidNext: null, emptyRangeError: dead })
    await expect(ingestMessages(db, { ...deps, client: fake.client })).rejects.toThrow(/socket closed/)
  })

  test('a refusal that arrives AFTER real envelopes is a real failure: half a range is not an empty one', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    // The same "Invalid messageset" text, but a message came back first, so the range was not empty.
    const fake = fakeImap([mail(10, 1), mail(11, 2), mail(12, 3)], {
      fetchErrorAfter: { count: 1, error: Object.assign(new Error('Invalid messageset'), { responseStatus: 'BAD' }) },
    })
    await expect(ingestMessages(db, { ...deps, client: fake.client })).rejects.toThrow(/Invalid messageset/)
    expect(stored(db)!.lastUid).toBe(10)
  })

  test('an empty mailbox is not fetched at all and does not forget the watermark', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    // Every message has been unlabelled. EXISTS alone settles it, with no UIDNEXT to go on - and a
    // range over an empty mailbox is exactly what the servers that refuse one would refuse.
    const next = await rerun(db, deps, [], { uidNext: null })
    expect(next.fake.fetches).toEqual([])
    expect(next.report).toMatchObject({ read: 0 })
    expect(stored(db)!.lastUid).toBe(10)
  })
})

describe('incremental IMAP: what the range must not hide', () => {
  test('mail labelled retroactively gets a NEW uid above the watermark, so old mail still arrives', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)

    // Gmail applies the label to a three-year-old message: same mailbox, a brand new UID at the top.
    const old = mail(11, 2, { date: new Date(NOW.getTime() - 400 * DAY) })
    const next = await rerun(db, deps, [mail(10, 1), old])
    expect(next.report).toMatchObject({ read: 1, created: 1, archivedOld: 1 })
    const p = findParcel(db, 'packeta', number(2))!
    expect(p.archivedAt).toEqual(NOW)                    // old mail, so archived on arrival as before
  })

  test('Message-ID dedupe still holds inside the range: the same mail at a new uid is not stored twice', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    // The very same message (same Message-ID) re-appears above the watermark.
    const next = await rerun(db, deps, [mail(10, 1), mail(42, 1)])
    expect(next.report).toMatchObject({ read: 0, created: 0 })
    expect(next.fake.downloaded).toEqual([])             // known: the body is never downloaded
    expect(db.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) n FROM parcels').get()).toEqual({ n: 1 })
    expect(stored(db)!.lastUid).toBe(42)                 // the envelope was read, so the range may move past it
  })

  test('the incremental path is as read-only as the full one: EXAMINE, and no write call of any kind', async () => {
    const { db, deps } = setup([mail(10, 1)])
    await ingestMessages(db, deps)
    const next = await rerun(db, deps, [mail(10, 1), mail(11, 2)])
    expect(next.fake.forbidden).toEqual([])
    expect(next.fake.locks).toEqual([{ path: 'parcels', readOnly: true, released: true }])
    expect(next.fake.calls.filter(c => /flag|store|move|delete|copy|append|expunge|search|create|rename/i.test(c))).toEqual([])
  })
})

describe('fetchMessages: the range as an argument', () => {
  test('resumes from the state it is handed and reports what the next run should resume from', async () => {
    const fake = fakeImap([mail(10, 1), mail(11, 2)])
    const seen: Array<{ uidValidity: string; lastUid: number }> = []
    const out = await fetchMessages({
      config: imap, client: fake.client,
      state: { uidValidity: String(UID_VALIDITY), lastUid: 10 },
      onScanned: s => seen.push(s),
    })
    expect(fake.fetches).toEqual([{ range: '11:*', uid: true }])
    expect(out.map(m => m.messageId)).toEqual(['<p2@fixture>'])
    expect(seen).toEqual([{ uidValidity: String(UID_VALIDITY), lastUid: 11 }])
  })

  test('a server that ignores the range is not trusted: messages below the watermark are dropped', async () => {
    // Some servers answer `11:*` with more than was asked for. Everything at or below the watermark has
    // already been read and stored, so re-reading it would undo the whole point of the range.
    const fake = fakeImap([mail(5, 9), mail(10, 1), mail(11, 2)], { ignoresRange: true })
    const out = await fetchMessages({
      config: imap, client: fake.client, state: { uidValidity: String(UID_VALIDITY), lastUid: 10 },
    })
    expect(out.map(m => m.messageId)).toEqual(['<p2@fixture>'])
    expect(fake.downloaded).toEqual([11])
  })

  test('does not report a resume point when the pass threw, whether on an envelope or on a body', async () => {
    const seen: unknown[] = []
    const onScanned = (s: unknown) => { seen.push(s) }

    const broken = fakeImap([mail(10, 1)], { fetchError: new Error('boom') })
    await expect(fetchMessages({ config: imap, client: broken.client, onScanned })).rejects.toThrow(/boom/)
    expect(seen).toEqual([])

    // Envelopes all arrived; the connection died on a BODY.PEEK. The mail that was never downloaded
    // has no row anywhere, so this pass must not count as having read its range.
    const dying = fakeImap([mail(10, 1), mail(11, 2)], { fetchOneError: new Error('closed mid-download') })
    await expect(fetchMessages({ config: imap, client: dying.client, onScanned })).rejects.toThrow(/mid-download/)
    expect(seen).toEqual([])
  })
})
