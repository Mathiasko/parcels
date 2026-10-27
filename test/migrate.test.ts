import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { openDb, type Database } from '../src/db/index.js'
import { applyMigrations, isEmptyDatabase, latestVersion, userVersion, BASELINE, MIGRATIONS, type Migration } from '../src/db/migrate.js'
import { insertParcel, getParcel } from '../src/db/parcels.js'

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
    const before = openDb(path)
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
    openDb(path).close()                                  // a baseline database first
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
    openDb(path).close()
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
    const db = openDb(path)
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
    const db = openDb(path)
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
