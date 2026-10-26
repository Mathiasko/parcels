import BetterSqlite3 from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type Database = BetterSqlite3.Database

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')

/**
 * Opens (creating the parent directory and file if needed) the SQLite database and applies the
 * schema idempotently. `data/` is gitignored, so a fresh clone relies on this to exist.
 */
export function openDb(path: string): Database {
  if (path !== ':memory:' && path !== '') mkdirSync(dirname(path), { recursive: true })
  const db = new BetterSqlite3(path)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.exec(schema)
    assertSchemaCurrent(db)
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

/**
 * `CREATE TABLE IF NOT EXISTS` leaves an older database's tables as they were, so a column added
 * since would only surface later as a confusing runtime SQL error. Compare every table against a
 * pristine copy of the schema and fail at open time, naming what is missing.
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
          `database table "${name}" is missing column${missing.length > 1 ? 's' : ''} ${missing.map(c => `"${c}"`).join(', ')}; `
          + 'it was created by an older schema and there is no migration (delete the database file or add the column)',
        )
      }
    }
  } finally {
    reference.close()
  }
}
