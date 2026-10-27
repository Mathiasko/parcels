import type { Database } from './index.js'
import { canonicalNumber } from '../carriers/registry.js'
import type { CarrierId } from '../core/types.js'

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
export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    name: 'GLS DELIVEREDPS is awaiting collection, not delivered',
    /**
     * `DELIVEREDPS` means GLS handed the parcel to a ParcelShop or a Balikomat, which is the START of
     * waiting rather than the end of it. Mapping it to `delivered` took a parcel off the dashboard
     * while it sat in a locker, with its pickup deadline and its reminders gone with it.
     *
     * The adapter is fixed, but a delivered parcel is terminal and is never polled again, so nothing
     * would ever re-read these rows and correct them. That is what this migration is for: the parcels
     * already in that state on anyone's machine, and the newest event that put them there.
     */
    up: db => {
      db.prepare(`
        UPDATE events SET status = 'ready_for_pickup'
        WHERE status = 'delivered' AND parcel_id IN (
          SELECT id FROM parcels WHERE carrier = 'gls' AND status_raw = 'DELIVEREDPS')
      `).run()
      db.prepare(`
        UPDATE parcels SET status = 'ready_for_pickup'
        WHERE carrier = 'gls' AND status_raw = 'DELIVEREDPS' AND status = 'delivered'
      `).run()
    },
  },
  {
    version: 3,
    name: 'merge parcels that are one shipment spelled two ways',
    /**
     * One GLS shipment, two parcels. Parcels 39 and 40 in the author's database were the same
     * shipment, ingested from two different emails as `01928813352` and `1928813352`: the padded
     * spelling did not match the bare one, `findParcel` missed, and a second parcel was created.
     *
     * `canonicalNumber` stops that happening again, but only for writes from now on. The pairs
     * already in a database would stay two parcels for ever, because nothing re-reads a stored
     * tracking number - and worse, a row still holding the padded spelling would be missed by every
     * future lookup and duplicated all over again. Both are fixed here.
     *
     * Deliberately asks `canonicalNumber` rather than freezing a copy of the rule: a database that
     * has not run this migration yet should be reconciled with the rule the app enforces on writes
     * TODAY, or the migration would leave behind exactly the duplicates that rule now prevents.
     * Written over every carrier, not just GLS, so widening `ZERO_PADDED` needs no new migration
     * for databases that have yet to catch up.
     */
    up: db => {
      interface Row { id: number; carrier: CarrierId; tracking_number: string }
      // Ordered by id, so each group's first member is the parcel that was created first.
      const rows = db.prepare('SELECT id, carrier, tracking_number FROM parcels ORDER BY id').all() as Row[]
      const groups = new Map<string, { canonical: string; stored: string; ids: number[] }>()
      for (const r of rows) {
        const canonical = canonicalNumber(r.carrier, r.tracking_number)
        const key = `${r.carrier} ${canonical}`
        const group = groups.get(key) ?? { canonical, stored: r.tracking_number, ids: [] }
        group.ids.push(r.id)
        groups.set(key, group)
      }

      const rename = db.prepare('UPDATE parcels SET tracking_number = ? WHERE id = ?')
      for (const { canonical, stored, ids } of groups.values()) {
        const [keep, ...losers] = ids as [number, ...number[]]
        // The losers go first: one of them may be holding the canonical spelling that the survivor is
        // about to take, and `UNIQUE (carrier, tracking_number)` would refuse the overlap.
        for (const loser of losers) mergeParcel(db, keep, loser)
        // A lone parcel still gets here, because a row left holding the padded spelling would be
        // missed by every future lookup and duplicated all over again.
        if (stored !== canonical) rename.run(canonical, keep)
      }
    },
  },
]

/** Tables with no uniqueness on `parcel_id`: every row moves, and none may be dropped. */
const MOVED_WHOLESALE = ['messages', 'raw_responses'] as const
/**
 * Tables keyed by `parcel_id` (plus something, for `events` and `pickup_nudges`). A row whose key the
 * survivor already holds cannot move - and is a duplicate of it by definition, both rows having been
 * polled from the same shipment - so it is dropped. `events` is the one that really collides: its
 * `dedup_hash` is per parcel, so the same carrier event exists under both parcels with the same hash.
 * `UPDATE OR IGNORE` skips such a row instead of throwing; the DELETE then clears what stayed behind.
 */
const MOVED_IF_FREE = ['events', 'deadline_reminders', 'pickup_codes', 'pickup_nudges'] as const

/** The columns that are one coherent snapshot of what the carrier last said, and so move together. */
const STATUS_SNAPSHOT = [
  'status', 'status_raw', 'status_detail', 'retained_till', 'delivered_at', 'last_announced_status',
  'pickup_kind', 'pickup_name', 'pickup_street', 'pickup_city', 'pickup_zip', 'pickup_lat', 'pickup_lon',
] as const

type Value = string | number | null
/** The newest of two ISO timestamps, either of which may be NULL ("never"), which always loses. */
const later = (a: Value, b: Value): Value => ((a ?? '') > (b ?? '') ? a : b)
const earlier = (a: Value, b: Value): Value => (later(a, b) === a ? b : a)

/**
 * Folds `loser` into `keep` and deletes it. `keep` is the lower id, which is the parcel created
 * first: it is the one whose `/parcel/<id>` link the user already has, and ids are only ever handed
 * out in order, so the choice is deterministic. Nothing the loser knew is thrown away:
 *
 *   - the descriptive columns are the survivor's, falling back to the loser's where it has none, so a
 *     hand-typed label or a merchant parsed from the other email is never lost;
 *   - `first_seen_at` is the earlier of the two, which is when the shipment really was first seen;
 *   - the status columns come from whichever row was polled LAST, as a block. Picking them field by
 *     field could invent a state neither row was ever in - `delivered` still carrying a pickup point;
 *   - `pickup_announced` is the OR, so a pickup point the user has already been told about is not
 *     announced a second time;
 *   - `archived_at` survives only if BOTH rows were archived: one of them saying the shipment is live
 *     means it is live;
 *   - `needs_postcode` is cleared. It is only meaningful against the row's own `postal_code`, and the
 *     merged row's may now come from the other parcel; clearing it costs one poll, which re-flags the
 *     parcel if the carrier still rejects the code.
 */
function mergeParcel(db: Database, keep: number, loser: number): void {
  const read = db.prepare('SELECT * FROM parcels WHERE id = ?')
  const a = read.get(keep) as Record<string, Value>
  const b = read.get(loser) as Record<string, Value>

  // Which row the carrier spoke to last. A tie (including neither ever polled) keeps the survivor's.
  const fresher = (b.last_polled_at ?? '') > (a.last_polled_at ?? '') ? b : a
  const merged: Record<string, Value> = {
    label: a.label ?? b.label,
    merchant: a.merchant ?? b.merchant,
    postal_code: a.postal_code ?? b.postal_code,
    source_message_id: a.source_message_id ?? b.source_message_id,
    first_seen_at: earlier(a.first_seen_at, b.first_seen_at),
    last_polled_at: later(a.last_polled_at, b.last_polled_at),
    last_attempted_at: later(a.last_attempted_at, b.last_attempted_at),
    last_changed_at: later(a.last_changed_at, b.last_changed_at),
    pickup_announced: a.pickup_announced || b.pickup_announced ? 1 : 0,
    archived_at: a.archived_at === null || b.archived_at === null ? null : later(a.archived_at, b.archived_at),
    needs_postcode: null,
  }
  for (const c of STATUS_SNAPSHOT) merged[c] = fresher[c] ?? null

  const columns = Object.keys(merged)
  db.prepare(`UPDATE parcels SET ${columns.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`)
    .run({ ...merged, id: keep })

  for (const table of MOVED_WHOLESALE) {
    db.prepare(`UPDATE ${table} SET parcel_id = ? WHERE parcel_id = ?`).run(keep, loser)
  }
  for (const table of MOVED_IF_FREE) {
    db.prepare(`UPDATE OR IGNORE ${table} SET parcel_id = ? WHERE parcel_id = ?`).run(keep, loser)
    db.prepare(`DELETE FROM ${table} WHERE parcel_id = ?`).run(loser)
  }
  db.prepare('DELETE FROM parcels WHERE id = ?').run(loser)
}

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
