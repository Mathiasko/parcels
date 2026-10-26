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
  } catch (err) {
    db.close()
    throw err
  }
  return db
}
