import BetterSqlite3 from 'better-sqlite3'
import { readFileSync } from 'node:fs'

export type Database = BetterSqlite3.Database

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')

/** Opens (creating if needed) the SQLite database and applies the schema idempotently. */
export function openDb(path: string): Database {
  const db = new BetterSqlite3(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(schema)
  return db
}
