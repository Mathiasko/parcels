import { test, expect, beforeEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { openDb, type Database } from '../src/db/index.js'
import {
  insertParcel, findParcel, getParcel, listActive, updateParcelState, setArchived, deleteParcel,
  type NewParcel,
} from '../src/db/parcels.js'
import { appendEvents } from '../src/db/events.js'
import { linkMessage, storeMessage } from '../src/db/messages.js'

let db: Database
beforeEach(() => { db = openDb(':memory:') })

const base: NewParcel = { carrier: 'packeta', trackingNumber: 'Z1234567890', source: 'manual' }

test('openDb creates all tables and re-applying the schema on the same handle is idempotent', () => {
  const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8')
  insertParcel(db, base)
  expect(() => db.exec(schema)).not.toThrow()
  expect(findParcel(db, 'packeta', 'Z1234567890')).toBeDefined()   // data survived the re-exec
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[]).map(r => r.name)
  expect(names).toEqual(['activity_log', 'carrier_health', 'deadline_reminders', 'events', 'geocode_cache', 'imap_state', 'ingest_status', 'last_poll', 'messages', 'parcels', 'pickup_codes', 'pickup_nudges', 'poll_runs', 'raw_responses', 'stale_poll_notice', 'update_check', 'user_marks'])
})

test('openDb enables WAL and foreign keys, and reopens a file-backed database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parcels-db-'))
  try {
    const path = join(dir, 'p.db')
    const a = openDb(path)
    expect(a.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(a.pragma('foreign_keys', { simple: true })).toBe(1)
    insertParcel(a, base)
    a.close()
    const b = openDb(path)
    expect(findParcel(b, 'packeta', 'Z1234567890')).toBeDefined()
    b.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a database from before the messages_parcel index gains it on the next open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parcels-db-'))
  try {
    const path = join(dir, 'p.db')
    openDb(path).close()
    const raw = new BetterSqlite3(path)
    raw.exec('DROP INDEX IF EXISTS messages_parcel')
    raw.close()
    const db = openDb(path)
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT raw_path FROM messages WHERE parcel_id = ?').all(1) as { detail: string }[]
    expect(plan.map(p => p.detail).join(' ')).toContain('USING INDEX messages_parcel')
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('openDb creates a missing parent directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parcels-db-'))
  try {
    const path = join(dir, 'nested', 'data', 'p.db')
    openDb(path).close()
    expect(existsSync(path)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('insertParcel then findParcel round-trips', () => {
  const id = insertParcel(db, { ...base, label: 'Shoes', merchant: 'Zalando', postalCode: '81101', sourceMessageId: '<m1>' })
  const p = findParcel(db, 'packeta', 'Z1234567890')!
  expect(p.id).toBe(id)
  expect(p.carrier).toBe('packeta')
  expect(p.trackingNumber).toBe('Z1234567890')
  expect(p.status).toBe('unknown')
  expect(p.label).toBe('Shoes')
  expect(p.merchant).toBe('Zalando')
  expect(p.postalCode).toBe('81101')
  expect(p.source).toBe('manual')
  expect(p.sourceMessageId).toBe('<m1>')
  expect(p.archivedAt).toBeUndefined()
  expect(p.firstSeenAt).toBeInstanceOf(Date)
})

test('findParcel returns undefined for an unknown parcel', () => {
  expect(findParcel(db, 'gls', '31217533227')).toBeUndefined()
})

test('inserting the same carrier+number twice throws a unique constraint', () => {
  insertParcel(db, base)
  expect(() => insertParcel(db, base)).toThrow(/UNIQUE/)
})

test('the two forms of one real GLS shipment are one parcel, stored under the shortest', () => {
  // Parcels 39 and 40 in the author's database: the same GLS shipment, once padded and once bare.
  const id = insertParcel(db, { carrier: 'gls', trackingNumber: '01928813352', merchant: 'SUPERSKLEP', source: 'email' })
  expect(getParcel(db, id)?.trackingNumber).toBe('1928813352')
  expect(findParcel(db, 'gls', '01928813352')?.id).toBe(id)
  expect(findParcel(db, 'gls', '1928813352')?.id).toBe(id)
  expect(findParcel(db, 'gls', '001928813352')?.id).toBe(id)
})

test('a second email naming the other form finds the existing parcel instead of creating one', () => {
  // The ingest's own sequence: findParcel first, insertParcel only when that misses.
  const first = insertParcel(db, { carrier: 'gls', trackingNumber: '1928813352', source: 'email' })
  expect(findParcel(db, 'gls', '01928813352')?.id).toBe(first)
  // And the table itself refuses the second form, so no other write path can create one either.
  expect(() => insertParcel(db, { carrier: 'gls', trackingNumber: '01928813352', source: 'email' })).toThrow(/UNIQUE/)
  expect(count(db, 'parcels')).toBe(1)
})

test('parcels whose numbers genuinely differ stay apart, and padded carriers keep their zeros', () => {
  insertParcel(db, { carrier: 'gls', trackingNumber: '0123456789', source: 'manual' })   // 10 digits: GLS's floor
  insertParcel(db, { carrier: 'gls', trackingNumber: '1234567890', source: 'manual' })
  insertParcel(db, { carrier: 'dhl', trackingNumber: '0001234567890123', source: 'manual' })
  insertParcel(db, { carrier: 'dpd', trackingNumber: '01505515835276', source: 'manual' })
  expect(count(db, 'parcels')).toBe(4)
  expect(findParcel(db, 'gls', '0123456789')?.trackingNumber).toBe('0123456789')
  expect(findParcel(db, 'dhl', '0001234567890123')?.trackingNumber).toBe('0001234567890123')
  expect(findParcel(db, 'dpd', '01505515835276')?.trackingNumber).toBe('01505515835276')
  // Stripping a DHL or DPD number would be a lookup for a parcel that is not there, not a reconciliation.
  expect(findParcel(db, 'dhl', '1234567890123')).toBeUndefined()
  expect(findParcel(db, 'dpd', '1505515835276')).toBeUndefined()
})

test('updateParcelState writes status, pickup and timestamps', () => {
  const id = insertParcel(db, base)
  const at = new Date('2026-07-13T13:08:08.000Z')
  updateParcelState(db, id, {
    status: 'ready_for_pickup', statusRaw: 'Ready', statusDetail: 'D1',
    pickup: { kind: 'zbox', name: 'Z-BOX 1', city: 'Bratislava', lat: 48.1, lon: 17.1 },
    retainedTill: new Date('2026-07-20T00:00:00.000Z'),
    lastPolledAt: at, lastChangedAt: at,
  })
  const p = findParcel(db, 'packeta', 'Z1234567890')!
  expect(p.status).toBe('ready_for_pickup')
  expect(p.statusRaw).toBe('Ready')
  expect(p.statusDetail).toBe('D1')
  expect(p.pickup).toEqual({ kind: 'zbox', name: 'Z-BOX 1', city: 'Bratislava', lat: 48.1, lon: 17.1 })
  expect(p.retainedTill?.toISOString()).toBe('2026-07-20T00:00:00.000Z')
  expect(p.lastPolledAt?.toISOString()).toBe(at.toISOString())
  expect(p.lastChangedAt?.toISOString()).toBe(at.toISOString())
})

test('a new pickup point replaces the old one wholesale; omitting pickup leaves it alone', () => {
  const id = insertParcel(db, base)
  const get = () => findParcel(db, 'packeta', 'Z1234567890')!
  updateParcelState(db, id, {
    status: 'ready_for_pickup',
    pickup: { kind: 'locker', name: 'Locker 1', street: 'Hlavna 1', city: 'Kosice', postalCode: '04001', lat: 48.7, lon: 21.2 },
  })
  expect(get().pickup).toMatchObject({ lat: 48.7, lon: 21.2, street: 'Hlavna 1' })

  // omitted pickup: untouched
  updateParcelState(db, id, { status: 'ready_for_pickup' })
  expect(get().pickup).toMatchObject({ name: 'Locker 1', lat: 48.7, lon: 21.2 })

  // replaced by a point without coordinates/street: stale values must be gone
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup: { kind: 'parcelshop', name: 'Shop 2', city: 'Presov' } })
  expect(get().pickup).toEqual({ kind: 'parcelshop', name: 'Shop 2', city: 'Presov' })
  const row = db.prepare('SELECT pickup_lat, pickup_lon, pickup_street, pickup_zip FROM parcels WHERE id = ?').get(id)
  expect(row).toEqual({ pickup_lat: null, pickup_lon: null, pickup_street: null, pickup_zip: null })
})

test('listActive excludes delivered, returned and archived parcels', () => {
  const active = insertParcel(db, { ...base, trackingNumber: 'Z0000000001' })
  const delivered = insertParcel(db, { ...base, trackingNumber: 'Z0000000002' })
  const returned = insertParcel(db, { ...base, trackingNumber: 'Z0000000003' })
  const archived = insertParcel(db, { ...base, trackingNumber: 'Z0000000004' })
  updateParcelState(db, active, { status: 'in_transit' })
  updateParcelState(db, delivered, { status: 'delivered' })
  updateParcelState(db, returned, { status: 'returned' })
  setArchived(db, archived, new Date('2026-07-14T00:00:00.000Z'))
  const list = listActive(db)
  expect(list.map(p => p.id)).toEqual([active])
})

/** One scan, reusable for two parcels (the dedup hash is per parcel). */
const scan = {
  occurredAtRaw: '13.07.2026 13:08', occurredAtTz: 'Europe/Bratislava',
  occurredAt: new Date('2026-07-13T11:08:00.000Z'), status: 'in_transit' as const, description: 'Scanned',
}
const count = (db: Database, sql: string, ...args: unknown[]) =>
  (db.prepare(`SELECT COUNT(*) n FROM ${sql}`).get(...args as never[]) as { n: number }).n

test('deleteParcel removes the parcel with its events, raw responses and deadline reminder, and nothing else', () => {
  const id = insertParcel(db, base)
  const other = insertParcel(db, { ...base, trackingNumber: 'Z0000000099' })
  appendEvents(db, id, [scan])
  appendEvents(db, other, [scan])
  const raws = db.prepare('INSERT INTO raw_responses (parcel_id, carrier, fetched_at, body) VALUES (?, ?, ?, ?)')
  raws.run(id, 'packeta', '2026-07-13T11:08:00.000Z', 'this parcel')
  raws.run(other, 'packeta', '2026-07-13T11:08:00.000Z', 'the other parcel')
  raws.run(null, 'packeta', '2026-07-13T11:08:00.000Z', 'a failed batch, carrier-level')
  const reminders = db.prepare('INSERT INTO deadline_reminders (parcel_id, notified_at) VALUES (?, ?)')
  reminders.run(id, '2026-07-13T11:08:00.000Z')
  reminders.run(other, '2026-07-13T11:08:00.000Z')

  deleteParcel(db, id)

  expect(getParcel(db, id)).toBeUndefined()
  expect(count(db, 'events WHERE parcel_id = ?', id)).toBe(0)
  expect(count(db, 'raw_responses WHERE parcel_id = ?', id)).toBe(0)
  expect(count(db, 'deadline_reminders WHERE parcel_id = ?', id)).toBe(0)
  // The other parcel keeps everything, and the carrier-level body belongs to the carrier, not to this parcel.
  expect(getParcel(db, other)).toBeDefined()
  expect(count(db, 'events')).toBe(1)
  expect(count(db, 'deadline_reminders')).toBe(1)
  expect(count(db, 'raw_responses')).toBe(2)
  expect(count(db, 'raw_responses WHERE parcel_id IS NULL')).toBe(1)
  // Nothing may be left pointing at the row that is gone.
  expect(db.pragma('foreign_key_check')).toEqual([])
})

test('linkMessage resolves a waiting message against a parcel: no note left saying why it was waiting', () => {
  const id = insertParcel(db, base)
  const insert = db.prepare(`
    INSERT INTO messages (message_id, received_at, from_addr, subject, parsed_ok, parse_note, ignored)
    VALUES (?, '2026-07-13T11:08:00.000Z', 'shop@example.com', 'Shipped', 0, ?, ?)
  `)
  const waiting = Number(insert.run('<m1@x>', 'no tracking number found in this message', 0).lastInsertRowid)
  const ignored = Number(insert.run('<m2@x>', 'ignored: no sign of a parcel', 1).lastInsertRowid)

  linkMessage(db, waiting, id)
  linkMessage(db, ignored, id, 'a note of its own')

  const rows = db.prepare('SELECT id, parsed_ok, parcel_id, parse_note, ignored FROM messages ORDER BY id').all()
  expect(rows).toEqual([
    { id: waiting, parsed_ok: 1, parcel_id: id, parse_note: null, ignored: 0 },
    { id: ignored, parsed_ok: 1, parcel_id: id, parse_note: 'a note of its own', ignored: 0 },
  ])
})

test('deleteParcel keeps the email ROWS, unlinked and parsed_ok = 1: no re-ingest, and not dumped into needs-attention', () => {
  const id = insertParcel(db, base)
  db.prepare(`
    INSERT INTO messages (message_id, received_at, from_addr, subject, raw_path, parsed_ok, parse_note, parcel_id)
    VALUES ('<m1@x>', '2026-07-13T11:08:00.000Z', 'shop@example.com', 'Shipped', '/tmp/1.eml', 1, NULL, ?)
  `).run(id)

  deleteParcel(db, id)

  // The row is what the ingest dedupes against: delete it and the next poll would recreate the parcel.
  // Its stored .eml is gone, though, so `raw_path` must no longer point at a file (see the test below).
  const row = db.prepare('SELECT message_id, parsed_ok, parcel_id, raw_path FROM messages').get()
  expect(row).toMatchObject({ message_id: '<m1@x>', parsed_ok: 1, parcel_id: null, raw_path: null })
  // parsed_ok = 1, so the attention predicate (parsed_ok = 0 AND parcel_id IS NULL) does not match it.
  expect(count(db, 'messages WHERE parsed_ok = 0 AND parcel_id IS NULL')).toBe(0)
  expect(db.pragma('foreign_key_check')).toEqual([])
})

test('deleteParcel throws away the stored .eml files and clears raw_path, exactly like a dismissal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parcels-del-'))
  try {
    const id = insertParcel(db, base)
    const kept = insertParcel(db, { ...base, trackingNumber: 'Z0000000077' })
    const paths = ['1.eml', '2.eml', '3.eml'].map(n => join(dir, n))
    for (const p of paths) writeFileSync(p, 'raw mail')
    const add = db.prepare(
      'INSERT INTO messages (message_id, subject, raw_path, parsed_ok, parcel_id) VALUES (?, ?, ?, 1, ?)',
    )
    add.run('<a@x>', 'Shipped', paths[0], id)
    add.run('<b@x>', 'Ready', paths[1], id)
    add.run('<c@x>', 'Other parcel', paths[2], kept)
    // An oversize message was never written to disk: raw_path is already NULL and must not confuse anything.
    add.run('<d@x>', 'Huge', null, id)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    deleteParcel(db, id)

    expect(errors).not.toHaveBeenCalled()   // the row with no file is skipped, not unlinked as `null`
    errors.mockRestore()

    expect(existsSync(paths[0]!)).toBe(false)
    expect(existsSync(paths[1]!)).toBe(false)
    expect(existsSync(paths[2]!)).toBe(true)                       // another parcel's mail is untouched
    expect(count(db, 'messages')).toBe(4)                          // every row survives
    expect(count(db, 'messages WHERE raw_path IS NULL')).toBe(3)
    expect(count(db, 'messages WHERE parcel_id = ?', kept)).toBe(1)
    expect(db.prepare('SELECT raw_path FROM messages WHERE message_id = ?').get('<c@x>'))
      .toEqual({ raw_path: paths[2] })
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a deleted parcel is not resurrected by re-ingesting the same mailbox, and its .eml is not rewritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parcels-del-'))
  try {
    const id = insertParcel(db, base)
    const mail = {
      messageId: '<m1@x>', from: 'shop@example.com', subject: 'Shipped',
      receivedAt: new Date('2026-07-13T11:08:00.000Z'), raw: Buffer.from('From: shop\r\n\r\nbody'),
    }
    const msg = storeMessage(db, mail, dir)
    db.prepare('UPDATE messages SET parsed_ok = 1, parcel_id = ? WHERE id = ?').run(id, msg)
    const path = join(dir, `${msg}.eml`)
    expect(existsSync(path)).toBe(true)

    deleteParcel(db, id)
    expect(existsSync(path)).toBe(false)

    // The next poll offers the very same mail again. The row is the Message-ID dedupe key, so the
    // message is recognised, nothing is created, and the .eml is not written back either.
    expect(storeMessage(db, mail, dir)).toBe(msg)
    expect(count(db, 'messages')).toBe(1)
    expect(count(db, 'parcels')).toBe(0)
    expect(existsSync(path)).toBe(false)
    expect(db.prepare('SELECT parsed_ok, parcel_id, raw_path FROM messages').get())
      .toEqual({ parsed_ok: 1, parcel_id: null, raw_path: null })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('deleteParcel on an id that is not there changes nothing', () => {
  const id = insertParcel(db, base)
  expect(() => deleteParcel(db, 404)).not.toThrow()
  expect(getParcel(db, id)).toBeDefined()
})

test('openDb on a database from an older schema fails at open, naming the missing column', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parcels-old-'))
  try {
    const path = join(dir, 'old.db')
    const old = new BetterSqlite3(path)
    old.exec('CREATE TABLE parcels (id INTEGER PRIMARY KEY, carrier TEXT NOT NULL, tracking_number TEXT NOT NULL)')
    old.close()
    expect(() => openDb(path, [])).toThrow(/table "parcels" is missing columns .*"needs_postcode"/)
    expect(() => openDb(path, [])).toThrow(/"last_attempted_at"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the database is not readable by other accounts on the machine', () => {
  // It holds pickup addresses, the user's postcode, the senders and subjects of their mail, and the
  // codes that open parcel lockers. data/mail is 0700 and config.json is 0600; this was 0644.
  const dir = mkdtempSync(join(tmpdir(), 'parcels-perm-'))
  try {
    const path = join(dir, 'nested', 'parcels.db')
    const db = openDb(path)
    insertParcel(db, base)                       // force a write so the WAL exists
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    if (existsSync(`${path}-wal`)) expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600)
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a database left world-readable by an older version is tightened on the next open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parcels-perm2-'))
  try {
    const path = join(dir, 'parcels.db')
    openDb(path).close()
    chmodSync(path, 0o644)
    chmodSync(dir, 0o755)
    openDb(path).close()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
