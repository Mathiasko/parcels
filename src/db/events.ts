import type { Database } from './index.js'
import type { CanonicalStatus, ParcelEvent } from '../core/types.js'
import { dedupHash } from '../core/dedup.js'

/** A persisted event: the canonical event plus the ids needed to act on it. */
export type StoredEvent = ParcelEvent & { id: number; parcelId: number }

type Row = Record<string, string | number | null>

function toEvent(r: Row): StoredEvent {
  return {
    id: r.id as number,
    parcelId: r.parcel_id as number,
    occurredAtRaw: r.occurred_at_raw as string,
    occurredAtTz: r.occurred_at_tz as string,
    occurredAt: new Date(r.occurred_at as string),
    status: r.status as CanonicalStatus,
    code: r.code === null ? undefined : (r.code as string),
    description: (r.description as string | null) ?? '',
    location: r.location === null ? undefined : (r.location as string),
  }
}

/**
 * Inserts events idempotently and returns ONLY those newly inserted. Carriers return full
 * history on every call, so this return value is the diff — there is no separate differ.
 */
export function appendEvents(db: Database, parcelId: number, events: ParcelEvent[]): ParcelEvent[] {
  const insert = db.prepare(`
    INSERT INTO events (parcel_id, occurred_at, occurred_at_raw, occurred_at_tz, status, code,
                        description, location, dedup_hash, first_seen_at)
    VALUES (@parcelId, @occurredAt, @occurredAtRaw, @occurredAtTz, @status, @code,
            @description, @location, @dedupHash, @firstSeenAt)
    ON CONFLICT (parcel_id, dedup_hash) DO NOTHING
  `)
  const now = new Date().toISOString()
  return db.transaction((): ParcelEvent[] => {
    const inserted: ParcelEvent[] = []
    for (const e of events) {
      const info = insert.run({
        parcelId,
        occurredAt: e.occurredAt.toISOString(),
        occurredAtRaw: e.occurredAtRaw,
        occurredAtTz: e.occurredAtTz,
        status: e.status,
        code: e.code ?? null,
        description: e.description,
        location: e.location ?? null,
        dedupHash: dedupHash(e),
        firstSeenAt: now,
      })
      if (info.changes > 0) inserted.push(e)
    }
    return inserted
  })()
}

/** Newest event by occurredAt (insertion order breaks ties). */
export function latestEvent(db: Database, parcelId: number): StoredEvent | undefined {
  const row = db.prepare(
    'SELECT * FROM events WHERE parcel_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1',
  ).get(parcelId) as Row | undefined
  return row && toEvent(row)
}

/** A parcel's full timeline, oldest first (insertion order breaks ties). */
export function listEvents(db: Database, parcelId: number): StoredEvent[] {
  const rows = db.prepare(
    'SELECT * FROM events WHERE parcel_id = ? ORDER BY occurred_at, id',
  ).all(parcelId) as Row[]
  return rows.map(toEvent)
}

/**
 * Settles the parcel's cached status and `delivered_at`.
 *
 * On the poll path pass the adapter's authoritative top-level `status`: it is written as-is and
 * never overridden by the newest event, because stored events are never restamped (carriers with
 * prose-only events would otherwise be reverted on every poll). `delivered_at` is the newest
 * event's time when that status is `delivered` (`now` when there are no events), else cleared.
 *
 * Without an authoritative status the status is derived from the newest event instead, and a
 * parcel with no events is left untouched.
 */
export function recomputeParcelStatus(
  db: Database, parcelId: number, authoritativeStatus?: CanonicalStatus, now: Date = new Date(),
): void {
  const newest = latestEvent(db, parcelId)
  const status = authoritativeStatus ?? newest?.status
  if (status === undefined) return
  const deliveredAt = status === 'delivered' ? (newest?.occurredAt ?? now) : undefined
  db.prepare('UPDATE parcels SET status = ?, delivered_at = ? WHERE id = ?').run(
    status, deliveredAt?.toISOString() ?? null, parcelId,
  )
}

export function unnotifiedEvents(db: Database): StoredEvent[] {
  const rows = db.prepare(
    'SELECT * FROM events WHERE notified_at IS NULL ORDER BY occurred_at, id',
  ).all() as Row[]
  return rows.map(toEvent)
}

export function markNotified(db: Database, eventIds: number[], at: Date): void {
  const mark = db.prepare('UPDATE events SET notified_at = ? WHERE id = ?')
  const iso = at.toISOString()
  db.transaction(() => { for (const id of eventIds) mark.run(iso, id) })()
}
