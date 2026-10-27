import BetterSqlite3 from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { applyMigrations, isEmptyDatabase, MIGRATIONS, type Migration } from './migrate.js'

export type Database = BetterSqlite3.Database

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')

/**
 * Opens (creating the parent directory and file if needed) the SQLite database and applies the
 * schema idempotently. `data/` is gitignored, so a fresh clone relies on this to exist.
 */
export function openDb(path: string, migrations: Migration[] = MIGRATIONS): Database {
  if (path !== ':memory:' && path !== '') mkdirSync(dirname(path), { recursive: true })
  const db = new BetterSqlite3(path)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    // Asked BEFORE the schema is applied: afterwards every database looks established.
    const fresh = isEmptyDatabase(db)
    db.exec(schema)
    applyMigrations(db, migrations, fresh)
    assertSchemaCurrent(db)
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

/**
 * The safety net behind the migrations, not the migration mechanism itself.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an older database's tables as they were, so a column added to
 * `schema.sql` without a matching migration would only surface later as a confusing runtime SQL
 * error, on whichever query happened to touch it first. Comparing every table against a pristine
 * copy of the schema turns that into a failure at open time, naming exactly what is missing.
 *
 * Reaching this now means the two halves of a schema change got out of step: the column went into
 * `schema.sql` but no migration was added to bring existing databases up to it.
 */
function assertSchemaCurrent(db: Database): void {
  const reference = new BetterSqlite3(':memory:')
  try {
    reference.exec(schema)
    const tables = reference.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[]
    for (const { name } of tables) {
      const columns = (d: Database) => (d.pragma(`table_info(${name})`) as { name: string }[]).map(c => c.name)
      const actual = new Set(columns(db))
      const missing = columns(reference).filter(c => !actual.has(c))
      if (missing.length > 0) {
        throw new Error(
          `database table "${name}" is missing column${missing.length > 1 ? 's' : ''} ${missing.map(c => `"${c}"`).join(', ')}. `
          + 'The column is in schema.sql but no migration adds it to an existing database. Append one to '
          + 'MIGRATIONS in src/db/migrate.ts; do not ask anyone to delete their database.',
        )
      }
    }
  } finally {
    reference.close()
  }
}
