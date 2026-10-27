import type { Database } from './index.js'

/**
 * A change to an existing table's shape. New TABLES do not need one: `schema.sql` is applied with
 * `CREATE TABLE IF NOT EXISTS` on every open, so an older database gains them for free. A new
 * COLUMN, a changed constraint or a data fix-up does need one, because `CREATE TABLE IF NOT EXISTS`
 * leaves an existing table exactly as it was.
 *
 * Add the column to `schema.sql` (so a fresh database is born correct) AND a migration here (so an
 * existing one catches up). Both halves, every time; `assertSchemaCurrent` fails the open if you
 * write only one.
 */
export interface Migration {
  version: number
  name: string
  up(db: Database): void
}

/**
 * The schema as it stood when migrations were introduced. A database created before that has no
 * `user_version` stamp, and is indistinguishable from one created at this baseline, so that is what
 * it is assumed to be - correct, because this is the only shape that existed before now.
 */
export const BASELINE = 1

/**
 * Ordered, append-only. Never renumber or edit one that has shipped: somebody's database has already
 * recorded that it ran, and editing it changes what their database contains without telling them.
 */
export const MIGRATIONS: Migration[] = []

export const latestVersion = (migrations: Migration[] = MIGRATIONS): number =>
  migrations.reduce((n, m) => Math.max(n, m.version), BASELINE)

export const userVersion = (db: Database): number => (db.pragma('user_version', { simple: true })) as number

function setUserVersion(db: Database, v: number): void {
  if (!Number.isInteger(v) || v < 0) throw new Error(`refusing to stamp a non-integer schema version: ${v}`)
  db.pragma(`user_version = ${v}`)   // PRAGMA takes no bound parameters, hence the check above
}

/** True when nothing has ever been created here, so the schema about to be applied is the whole story. */
export function isEmptyDatabase(db: Database): boolean {
  const r = db.prepare(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).get() as { n: number }
  return r.n === 0
}

function validate(migrations: Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  const seen = new Set<number>()
  for (const m of sorted) {
    if (!Number.isInteger(m.version)) throw new Error(`migration "${m.name}" has a non-integer version`)
    if (m.version <= BASELINE) throw new Error(`migration "${m.name}" must have a version above the baseline (${BASELINE})`)
    if (seen.has(m.version)) throw new Error(`two migrations share version ${m.version}`)
    seen.add(m.version)
  }
  return sorted
}

/**
 * Brings a database up to the current schema version, and returns the versions it ran.
 *
 * A FRESH database is stamped at the latest version without running anything: `schema.sql` already
 * describes the newest shape, so replaying history over it would fail on the first duplicate column.
 * An existing one runs every migration above its stamp, each in its own transaction, so a failure
 * leaves the database at the last version that did succeed rather than half-way through.
 */
export function applyMigrations(db: Database, migrations: Migration[], fresh: boolean): number[] {
  const ordered = validate(migrations)
  if (fresh) {
    setUserVersion(db, latestVersion(ordered))
    return []
  }
  if (userVersion(db) === 0) setUserVersion(db, BASELINE)   // created before migrations existed

  const applied: number[] = []
  for (const m of ordered) {
    if (m.version <= userVersion(db)) continue
    try {
      db.transaction(() => {
        m.up(db)
        setUserVersion(db, m.version)
      })()
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      throw new Error(`migration ${m.version} ("${m.name}") failed and was rolled back: ${why}`)
    }
    applied.push(m.version)
  }
  return applied
}
