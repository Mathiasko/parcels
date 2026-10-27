import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { openDb, type Database } from '../src/db/index.js'
import { applyMigrations, isEmptyDatabase, latestVersion, userVersion, BASELINE, MIGRATIONS, type Migration } from '../src/db/migrate.js'
import { insertParcel, getParcel, findParcel } from '../src/db/parcels.js'
import { appendEvents } from '../src/db/events.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'parcels-migrate-'))

/** A migration of the only kind that needs one: a new column on an existing table. */
const addColumn = (version: number, column: string): Migration => ({
  version, name: `add ${column}`,
  up: db => { db.exec(`ALTER TABLE parcels ADD COLUMN ${column} TEXT`) },
})

const columns = (db: Database, table: string): string[] =>
  (db.pragma(`table_info(${table})`) as { name: string }[]).map(c => c.name)

test('the shipped migration list is valid and the baseline is what a fresh database gets', () => {
  const db = openDb(':memory:')
  expect(userVersion(db)).toBe(latestVersion(MIGRATIONS))
  expect(latestVersion(MIGRATIONS)).toBeGreaterThanOrEqual(BASELINE)
})

test('a fresh database is stamped at the latest version and runs nothing', () => {
  // schema.sql already describes the newest shape, so replaying history over it would fail on the
  // first duplicate column. This is the case that makes the `fresh` flag necessary.
  const db = new BetterSqlite3(':memory:')
  expect(isEmptyDatabase(db)).toBe(true)
  const applied = applyMigrations(db, [addColumn(2, 'a'), addColumn(3, 'b')], true)
  expect(applied).toEqual([])
  expect(userVersion(db)).toBe(3)
})

test('a database created before migrations existed is treated as the baseline and caught up', () => {
  const dir = tmp()
  try {
    const path = join(dir, 'parcels.db')
    // Born with no stamp at all, exactly like the databases already in use.
    const before = openDb(path, [])
    const id = insertParcel(before, { carrier: 'packeta', trackingNumber: 'Z1234567890', source: 'manual' })
    before.pragma('user_version = 0')
    expect(columns(before, 'parcels')).not.toContain('nickname')
    before.close()

    const after = openDb(path, [addColumn(2, 'nickname')])
    expect(columns(after, 'parcels')).toContain('nickname')
    expect(userVersion(after)).toBe(2)
    expect(getParcel(after, id)?.trackingNumber).toBe('Z1234567890')   // the data is still there
    after.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('migrations run in order, once, and a later open is a no-op', () => {
  const dir = tmp()
  try {
    const path = join(dir, 'parcels.db')
    const order: number[] = []
    const track = (v: number, c: string): Migration => ({
      ...addColumn(v, c), up: db => { order.push(v); db.exec(`ALTER TABLE parcels ADD COLUMN ${c} TEXT`) },
    })
    openDb(path, []).close()                              // a baseline database first
    const list = [track(3, 'third'), track(2, 'second')]  // deliberately out of order in the array

    const db = openDb(path, list)
    expect(order).toEqual([2, 3])
    expect(userVersion(db)).toBe(3)
    db.close()

    const again = openDb(path, list)
    expect(order).toEqual([2, 3])                         // not re-run on the second open
    expect(userVersion(again)).toBe(3)
    again.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a failing migration is rolled back, and the version does not advance past it', () => {
  const dir = tmp()
  try {
    const path = join(dir, 'parcels.db')
    openDb(path, []).close()
    const boom: Migration = {
      version: 3, name: 'boom',
      up: db => { db.exec('ALTER TABLE parcels ADD COLUMN half_done TEXT'); throw new Error('bad SQL') },
    }

    expect(() => openDb(path, [addColumn(2, 'ok'), boom, addColumn(4, 'never')]))
      .toThrow(/migration 3 \("boom"\) failed and was rolled back: bad SQL/)

    // Migration 2 committed and stands; 3 did not; 4 was never reached.
    const db = openDb(path, [addColumn(2, 'ok')])
    expect(userVersion(db)).toBe(2)
    expect(columns(db, 'parcels')).toContain('ok')
    expect(columns(db, 'parcels')).not.toContain('half_done')   // the partial work was undone
    expect(columns(db, 'parcels')).not.toContain('never')
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a half-written migration list is refused rather than half-applied', () => {
  const db = new BetterSqlite3(':memory:')
  expect(() => applyMigrations(db, [addColumn(2, 'a'), addColumn(2, 'b')], false))
    .toThrow(/two migrations share version 2/)
  expect(() => applyMigrations(db, [addColumn(BASELINE, 'a')], false))
    .toThrow(/must have a version above the baseline/)
  expect(() => applyMigrations(db, [addColumn(2.5, 'a')], false))
    .toThrow(/non-integer version/)
})

test('a column added to schema.sql with no migration fails the open by name, and says what to do', () => {
  const dir = tmp()
  try {
    const path = join(dir, 'parcels.db')
    const db = openDb(path, [])
    // Simulate the old database: drop a column that the current schema declares.
    db.exec('ALTER TABLE parcels DROP COLUMN merchant')
    db.close()

    expect(() => openDb(path, [])).toThrow(/missing column "merchant"/)
    expect(() => openDb(path, [])).toThrow(/Append one to MIGRATIONS/)
    expect(() => openDb(path, [])).not.toThrow(/delete the database/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the migration that fixes such a database makes the open succeed', () => {
  const dir = tmp()
  try {
    const path = join(dir, 'parcels.db')
    const db = openDb(path, [])
    db.exec('ALTER TABLE parcels DROP COLUMN merchant')
    db.close()

    const fixed = openDb(path, [{
      version: 2, name: 'restore merchant', up: d => { d.exec('ALTER TABLE parcels ADD COLUMN merchant TEXT') },
    }])
    expect(columns(fixed, 'parcels')).toContain('merchant')
    expect(userVersion(fixed)).toBe(2)
    fixed.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('migration 2 rescues a GLS parcel left sitting in a locker as "delivered"', () => {
  const dir = tmp()
  try {
    const path = join(dir, 'parcels.db')
    const db = openDb(path, [])                       // born at the baseline, before the fix
    const id = insertParcel(db, { carrier: 'gls', trackingNumber: '1234567890', source: 'manual' })
    db.prepare("UPDATE parcels SET status = 'delivered', status_raw = 'DELIVEREDPS' WHERE id = ?").run(id)
    appendEvents(db, id, [{
      occurredAtRaw: '2026-10-27 16:43:12', occurredAtTz: 'Europe/Bratislava',
      occurredAt: new Date('2026-10-27T15:43:12Z'), status: 'delivered',
      description: 'Balik bol doruceny pre vyzdvihnutie do Balikomatu.',
    }])
    // A GLS parcel genuinely delivered to the door must not be touched.
    const doorstep = insertParcel(db, { carrier: 'gls', trackingNumber: '1234567891', source: 'manual' })
    db.prepare("UPDATE parcels SET status = 'delivered', status_raw = 'DELIVERED' WHERE id = ?").run(doorstep)
    db.close()

    const after = openDb(path, MIGRATIONS)
    expect(getParcel(after, id)?.status).toBe('ready_for_pickup')
    expect(getParcel(after, doorstep)?.status).toBe('delivered')
    expect(db2status(after, id)).toBe('ready_for_pickup')
    after.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const db2status = (db: Database, parcelId: number): string =>
  (db.prepare('SELECT status FROM events WHERE parcel_id = ? ORDER BY id DESC LIMIT 1').get(parcelId) as { status: string }).status

// --- migration 3: the leading-zero duplicates ---------------------------------------------------

/**
 * A parcel row written by hand, so the pre-migration numbers survive verbatim: `insertParcel`
 * canonicalises now, which is exactly what these databases were created without.
 */
function rawParcel(db: Database, carrier: string, number: string, o: {
  label?: string; merchant?: string; status?: string; firstSeenAt?: string; lastPolledAt?: string
  postalCode?: string; statusRaw?: string; pickupName?: string; archivedAt?: string
} = {}): number {
  return Number(db.prepare(`
    INSERT INTO parcels (carrier, tracking_number, label, merchant, postal_code, status, status_raw,
                         pickup_kind, pickup_name, first_seen_at, last_polled_at, archived_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'email')
  `).run(
    carrier, number, o.label ?? null, o.merchant ?? null, o.postalCode ?? null,
    o.status ?? 'unknown', o.statusRaw ?? null,
    o.pickupName === undefined ? null : 'parcelshop', o.pickupName ?? null,
    o.firstSeenAt ?? '2026-10-01T00:00:00.000Z', o.lastPolledAt ?? null, o.archivedAt ?? null,
  ).lastInsertRowid)
}

const event = (raw: string, description: string, status = 'in_transit' as const) =>
  ({ occurredAtRaw: raw, occurredAtTz: 'Europe/Bratislava', occurredAt: new Date(`${raw.replace(' ', 'T')}Z`), status, description })

const numbers = (db: Database): string[] =>
  (db.prepare('SELECT tracking_number FROM parcels ORDER BY id').all() as { tracking_number: string }[])
    .map(r => r.tracking_number)

/** A pre-migration database, with the migrations deliberately not applied. */
function legacy(dir: string): { path: string; db: Database } {
  const path = join(dir, 'parcels.db')
  return { path, db: openDb(path, []) }
}

test('migration 3 merges the one GLS shipment that was ingested twice, once zero-padded', () => {
  const dir = tmp()
  try {
    const { path, db } = legacy(dir)
    // Parcels 39 and 40, as they really are: the padded one came first and carries the shop's name;
    // the bare one came from GLS's own mail and was the one actually being polled.
    const padded = rawParcel(db, 'gls', '01928813352', {
      merchant: 'SUPERSKLEP', firstSeenAt: '2026-10-20T09:00:00.000Z', label: 'Winter tyres',
    })
    const bare = rawParcel(db, 'gls', '1928813352', {
      merchant: 'gls-slovakia.sk', postalCode: '81101', firstSeenAt: '2026-10-22T09:00:00.000Z',
      status: 'ready_for_pickup', statusRaw: 'DELIVEREDPS', pickupName: 'GLS ParcelShop Dunajska',
      lastPolledAt: '2026-10-23T09:00:00.000Z',
    })
    appendEvents(db, padded, [event('2026-10-20 09:00:00', 'Preadvice')])
    appendEvents(db, bare, [event('2026-10-22 09:00:00', 'In transit'), event('2026-10-23 09:00:00', 'At the ParcelShop')])
    const msg = db.prepare('INSERT INTO messages (message_id, subject, parsed_ok, parcel_id) VALUES (?, ?, 1, ?)')
    msg.run('<shop@x>', 'Your order has shipped', padded)
    msg.run('<gls@x>', 'Zasielka je pripravena', bare)
    db.prepare('INSERT INTO raw_responses (parcel_id, carrier, fetched_at, body) VALUES (?, ?, ?, ?)')
      .run(bare, 'gls', '2026-10-23T09:00:00.000Z', '{}')
    db.prepare('INSERT INTO deadline_reminders (parcel_id, notified_at) VALUES (?, ?)').run(bare, '2026-10-23T10:00:00.000Z')
    db.prepare('INSERT INTO pickup_codes (parcel_id, code, checked_messages, checked_at) VALUES (?, ?, 1, ?)')
      .run(bare, '004467', '2026-10-23T09:00:00.000Z')
    db.prepare(`
      UPDATE parcels SET needs_postcode = '99999', last_attempted_at = ?, last_changed_at = ?,
                         source_message_id = '<gls@x>' WHERE id = ?
    `).run('2026-10-24T09:00:00.000Z', '2026-10-23T09:00:00.000Z', bare)
    db.close()

    const after = openDb(path, MIGRATIONS)
    // One parcel left, and it is the one the user has been looking at (the lower id, first ingested).
    expect(numbers(after)).toEqual(['1928813352'])
    expect(getParcel(after, bare)).toBeUndefined()
    const p = getParcel(after, padded)!
    expect(p.trackingNumber).toBe('1928813352')          // stored canonically, so both forms now find it
    expect(p.merchant).toBe('SUPERSKLEP')                // the survivor's own facts win
    expect(p.label).toBe('Winter tyres')
    expect(p.postalCode).toBe('81101')                   // and the loser fills what it had nothing in
    expect(p.firstSeenAt.toISOString()).toBe('2026-10-20T09:00:00.000Z')   // the earlier sighting
    // The status is one coherent snapshot, taken from whichever row was polled last.
    expect(p.status).toBe('ready_for_pickup')
    expect(p.statusRaw).toBe('DELIVEREDPS')
    expect(p.pickup).toMatchObject({ kind: 'parcelshop', name: 'GLS ParcelShop Dunajska' })
    expect(p.lastPolledAt?.toISOString()).toBe('2026-10-23T09:00:00.000Z')
    expect(p.lastAttemptedAt?.toISOString()).toBe('2026-10-24T09:00:00.000Z')      // the latest of the two
    expect(p.lastChangedAt?.toISOString()).toBe('2026-10-23T09:00:00.000Z')
    expect(p.sourceMessageId).toBe('<gls@x>')
    // Cleared, not merged: it only means anything against this row's own postal_code, which has
    // just changed. One poll re-flags the parcel if the carrier still rejects the code.
    expect(p.needsPostcode).toBeUndefined()

    // Every child row moved, and nothing is left dangling.
    expect(rows(after, 'events WHERE parcel_id = ?', padded)).toBe(3)
    expect(rows(after, 'events')).toBe(3)
    expect(rows(after, 'messages WHERE parcel_id = ?', padded)).toBe(2)
    expect(rows(after, 'raw_responses WHERE parcel_id = ?', padded)).toBe(1)
    expect(rows(after, 'deadline_reminders WHERE parcel_id = ?', padded)).toBe(1)
    expect(rows(after, 'pickup_codes WHERE parcel_id = ?', padded)).toBe(1)
    expect(after.pragma('foreign_key_check')).toEqual([])
    after.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('migration 3 survives events that collide on dedup_hash, keeping one copy of each', () => {
  const dir = tmp()
  try {
    const { path, db } = legacy(dir)
    const padded = rawParcel(db, 'gls', '01928813352')
    const bare = rawParcel(db, 'gls', '1928813352')
    // Both rows were polled from the same shipment, so most of their history is the same event twice;
    // the dedup hash is per parcel, so moving them onto one parcel collides on UNIQUE(parcel_id, dedup_hash).
    const shared = [event('2026-10-20 09:00:00', 'Preadvice'), event('2026-10-21 09:00:00', 'In transit')]
    appendEvents(db, padded, [...shared, event('2026-10-22 09:00:00', 'Only the padded one saw this')])
    appendEvents(db, bare, [...shared, event('2026-10-23 09:00:00', 'Only the bare one saw this')])
    // Same for the tables keyed by parcel alone, and by parcel plus slot.
    const codes = db.prepare('INSERT INTO pickup_codes (parcel_id, code, checked_messages, checked_at) VALUES (?, ?, 1, ?)')
    codes.run(padded, '004467', '2026-10-23T09:00:00.000Z')
    codes.run(bare, '004467', '2026-10-23T09:00:00.000Z')
    const nudges = db.prepare('INSERT INTO pickup_nudges (parcel_id, slot_key, sent_at) VALUES (?, ?, ?)')
    nudges.run(padded, '2026-10-23T08:00', '2026-10-23T08:00:00.000Z')
    nudges.run(bare, '2026-10-23T08:00', '2026-10-23T08:00:00.000Z')
    nudges.run(bare, '2026-10-23T18:00', '2026-10-23T18:00:00.000Z')
    db.close()

    const after = openDb(path, MIGRATIONS)   // must not throw: a collision is a duplicate, not an error
    expect(numbers(after)).toEqual(['1928813352'])
    expect(rows(after, 'events')).toBe(4)                  // 2 shared + 1 each, not 6
    expect(rows(after, 'events WHERE parcel_id = ?', padded)).toBe(4)
    expect(rows(after, 'pickup_codes')).toBe(1)
    expect(rows(after, 'pickup_nudges')).toBe(2)
    expect(after.pragma('foreign_key_check')).toEqual([])
    after.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('migration 3 rewrites a lone zero-padded number, so the next email finds it instead of duplicating it', () => {
  const dir = tmp()
  try {
    const { path, db } = legacy(dir)
    const only = rawParcel(db, 'gls', '01928813352', { label: 'Winter tyres' })
    db.close()

    const after = openDb(path, MIGRATIONS)
    expect(getParcel(after, only)?.trackingNumber).toBe('1928813352')
    expect(findParcel(after, 'gls', '1928813352')?.id).toBe(only)
    expect(findParcel(after, 'gls', '01928813352')?.id).toBe(only)
    after.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('migration 3 keeps the active parcel active and never re-announces a pickup already announced', () => {
  const dir = tmp()
  try {
    const { path, db } = legacy(dir)
    const padded = rawParcel(db, 'gls', '01928813352', { archivedAt: '2026-10-21T09:00:00.000Z' })
    db.prepare('UPDATE parcels SET pickup_announced = 1 WHERE id = ?').run(padded)
    rawParcel(db, 'gls', '1928813352', { status: 'ready_for_pickup', lastPolledAt: '2026-10-23T09:00:00.000Z' })
    db.close()

    const after = openDb(path, MIGRATIONS)
    expect(getParcel(after, padded)?.archivedAt).toBeUndefined()   // one row said it is still live
    expect(after.prepare('SELECT pickup_announced FROM parcels').get()).toEqual({ pickup_announced: 1 })
    after.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('migration 3 leaves alone every number that is not a duplicate, whatever its leading zeros', () => {
  const dir = tmp()
  try {
    const { path, db } = legacy(dir)
    // DHL's eCommerce form and DPD's fixed-width form both begin with zeros that mean something, and
    // 10 digits is GLS's own floor, so none of these three may be touched.
    for (const [carrier, number] of [
      ['dhl', '0001234567890123'], ['dpd', '01505515835276'], ['gls', '0123456789'],
      ['gls', '1234567890'], ['packeta', 'Z0000000001'], ['posta', 'RA123456785SK'],
    ] as const) rawParcel(db, carrier, number)
    const before = numbers(db)
    db.close()

    const after = openDb(path, MIGRATIONS)
    expect(numbers(after)).toEqual(before)
    expect(rows(after, 'parcels')).toBe(6)
    after.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('migration 3 does nothing on a clean database, and running it again changes nothing', () => {
  const dir = tmp()
  try {
    // A fresh database never runs it at all: it is stamped at the latest version straight away.
    const fresh = openDb(':memory:')
    expect(userVersion(fresh)).toBe(latestVersion(MIGRATIONS))
    expect(rows(fresh, 'parcels')).toBe(0)
    fresh.close()

    // An empty legacy one does run it, and it must be a no-op rather than a failure.
    const { path, db } = legacy(dir)
    db.close()
    const once = openDb(path, MIGRATIONS)
    expect(rows(once, 'parcels')).toBe(0)
    const padded = rawParcel(once, 'gls', '01928813352')   // added AFTER the migration ran
    once.close()

    // Re-opening does not re-run it (the stamp has moved on), so this row is left exactly as written.
    const again = openDb(path, MIGRATIONS)
    expect(getParcel(again, padded)?.trackingNumber).toBe('01928813352')
    expect(userVersion(again)).toBe(latestVersion(MIGRATIONS))
    again.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const rows = (db: Database, sql: string, ...args: unknown[]): number =>
  (db.prepare(`SELECT COUNT(*) n FROM ${sql}`).get(...args as never[]) as { n: number }).n

// --- migration 4: messages.ignored --------------------------------------------------------------

test('migration 4 gives an existing database the messages.ignored column, and is safe to re-run', () => {
  const dir = tmp()
  try {
    const path = join(dir, 'parcels.db')
    const db = openDb(path, [])                       // born at the baseline, before the column existed
    // Simulate that database: the column is in today's schema.sql, so take it away again.
    db.exec('ALTER TABLE messages DROP COLUMN ignored')
    db.prepare("INSERT INTO messages (message_id, received_at, parsed_ok) VALUES ('<old@x>', '2026-01-01T00:00:00Z', 0)").run()
    db.close()

    const after = openDb(path, MIGRATIONS)
    expect(columns(after, 'messages')).toContain('ignored')
    // An existing row defaults to 0: nothing already on /attention silently disappears on upgrade.
    expect(after.prepare("SELECT ignored FROM messages WHERE message_id = '<old@x>'").get()).toEqual({ ignored: 0 })
    expect(userVersion(after)).toBe(latestVersion(MIGRATIONS))
    after.close()

    // The second open runs nothing; a third `ALTER TABLE ... ADD COLUMN` would be a hard error.
    const again = openDb(path, MIGRATIONS)
    expect(columns(again, 'messages')).toContain('ignored')
    again.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('migration 4 does not fail on a database that already has the column but an older stamp', () => {
  // `schema.sql` is applied on every open, BEFORE the migrations, so this really happens: the tables
  // come from a current schema while the stamp comes from an older migration list.
  const dir = tmp()
  try {
    const path = join(dir, 'parcels.db')
    const db = openDb(path, [])                       // stamped at the baseline, column already present
    expect(columns(db, 'messages')).toContain('ignored')
    db.close()
    const after = openDb(path, MIGRATIONS)            // must not throw "duplicate column name"
    expect(columns(after, 'messages')).toContain('ignored')
    after.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
