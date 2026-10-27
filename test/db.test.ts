import { test, expect, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { openDb, type Database } from '../src/db/index.js'
import {
  insertParcel, findParcel, getParcel, listActive, updateParcelState, setArchived, deleteParcel,
  type NewParcel,
} from '../src/db/parcels.js'
import { appendEvents } from '../src/db/events.js'

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
  expect(names).toEqual(['carrier_health', 'deadline_reminders', 'events', 'geocode_cache', 'ingest_status', 'last_poll', 'messages', 'parcels', 'pickup_codes', 'raw_responses', 'stale_poll_notice'])
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

test('deleteParcel keeps the emails, unlinked and parsed_ok = 1: no re-ingest, and not dumped into needs-attention', () => {
  const id = insertParcel(db, base)
  db.prepare(`
    INSERT INTO messages (message_id, received_at, from_addr, subject, raw_path, parsed_ok, parse_note, parcel_id)
    VALUES ('<m1@x>', '2026-07-13T11:08:00.000Z', 'shop@example.com', 'Shipped', '/tmp/1.eml', 1, NULL, ?)
  `).run(id)

  deleteParcel(db, id)

  // The row is what the ingest dedupes against: delete it and the next poll would recreate the parcel.
  const row = db.prepare('SELECT message_id, parsed_ok, parcel_id, raw_path FROM messages').get()
  expect(row).toMatchObject({ message_id: '<m1@x>', parsed_ok: 1, parcel_id: null, raw_path: '/tmp/1.eml' })
  // parsed_ok = 1, so the attention predicate (parsed_ok = 0 AND parcel_id IS NULL) does not match it.
  expect(count(db, 'messages WHERE parsed_ok = 0 AND parcel_id IS NULL')).toBe(0)
  expect(db.pragma('foreign_key_check')).toEqual([])
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
    expect(() => openDb(path)).toThrow(/table "parcels" is missing columns .*"needs_postcode"/)
    expect(() => openDb(path)).toThrow(/"last_attempted_at"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
