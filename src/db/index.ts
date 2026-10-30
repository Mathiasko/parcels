import BetterSqlite3 from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { applyMigrations, isEmptyDatabase, MIGRATIONS, type Migration } from './migrate.js'
import { PENDING } from './messages.js'

export type Database = BetterSqlite3.Database

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')

/**
 * Indexes over a column a migration adds, created on every open AFTER the migrations. `schema.sql`
 * runs before them, so there an index naming `messages.ignored` is "no such column" on a database
 * older than migration 4, and the open fails for good.
 *
 * `messages_pending` is the mail waiting on /attention, which the nav counts on every page. SQLite
 * takes a partial index only when the query's WHERE is the index's own, hence `PENDING` itself rather
 * than a copy of its SQL; on `parcel_id` because `parcel_id IS NULL` is an equality the planner can
 * search it by, where on any other column it preferred `messages_parcel` and read every unassigned row.
 */
const AFTER_MIGRATIONS = `CREATE INDEX IF NOT EXISTS messages_pending ON messages(parcel_id) WHERE ${PENDING};`

/**
 * The database holds more than tracking numbers: pickup addresses, the user's own postcode, the
 * senders and subjects of their mail, and the codes that open parcel lockers. It is as sensitive as
 * `data/mail` (0700) and `config.json` (0600), and was the only one of the three left readable by
 * every account on the machine.
 *
 * Tightening is done on every open, not only at creation: a database made by an earlier version is
 * already world-readable, and nothing else would ever fix it. The WAL and shared-memory files get
 * the same treatment - they carry the same rows, and SQLite creates them on its own schedule.
 */
function restrict(path: string): void {
  try {
    if (statSync(dirname(path)).uid === process.getuid?.()) chmodSync(dirname(path), 0o700)
    for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600)
  } catch (err) {
    // A database that cannot be tightened is still a database; say so and carry on rather than
    // refusing to start over a permission bit on someone else's unusual setup.
    console.error(`db: could not restrict permissions on ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Opens (creating the parent directory and file if needed) the SQLite database and applies the
 * schema idempotently. `data/` is gitignored, so a fresh clone relies on this to exist.
 */
export function openDb(path: string, migrations: Migration[] = MIGRATIONS): Database {
  const onDisk = path !== ':memory:' && path !== ''
  if (onDisk) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new BetterSqlite3(path)
  if (onDisk) restrict(path)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    // Asked BEFORE the schema is applied: afterwards every database looks established.
    const fresh = isEmptyDatabase(db)
    db.exec(schema)
    applyMigrations(db, migrations, fresh)
    db.exec(AFTER_MIGRATIONS)
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
