import { test, expect, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Database } from '../src/db/index.js'
import {
  insertParcel, findParcel, listActive, updateParcelState, setArchived,
  type NewParcel,
} from '../src/db/parcels.js'

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
  expect(names).toEqual(['carrier_health', 'events', 'messages', 'parcels', 'raw_responses'])
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
