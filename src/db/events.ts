import type { Database } from './index.js'
import type { CanonicalStatus, ParcelEvent } from '../core/types.js'
import { dedupHash } from '../core/dedup.js'

/**
 * A persisted event: the canonical event plus the ids needed to act on it. `byUser` is set on the one
 * event a "Mark as collected" added (see `user_marks` in schema.sql); every other event is a carrier's
 * or a mail's, and leaves it unset.
 */
export type StoredEvent = ParcelEvent & { id: number; parcelId: number; byUser?: true }

/** What the user said they did: collected it from a pickup point, or received it some other way. */
export type UserMarkKind = 'collected' | 'received'

/** A parcel the user marked as theirs (`user_marks`), with the time of the event it added. */
export interface UserMark {
  parcelId: number
  eventId: number
  kind: UserMarkKind
  /** What the carrier says underneath the mark; undo restores it. */
  carrierStatus: CanonicalStatus
  at: Date
}

type Row = Record<string, string | number | null>

function toEvent(r: Row): StoredEvent {
  return {
    ...(r.by_user === 1 && { byUser: true as const }),
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

/** Every event column, plus whether the event is the user's own mark. */
const WITH_SOURCE = 'e.*, (m.event_id IS NOT NULL) AS by_user FROM events e LEFT JOIN user_marks m ON m.event_id = e.id'

/** Newest event by occurredAt (insertion order breaks ties). */
export function latestEvent(db: Database, parcelId: number): StoredEvent | undefined {
  const row = db.prepare(
    `SELECT ${WITH_SOURCE} WHERE e.parcel_id = ? ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1`,
  ).get(parcelId) as Row | undefined
  return row && toEvent(row)
}

/** A parcel's full timeline, oldest first (insertion order breaks ties). */
export function listEvents(db: Database, parcelId: number): StoredEvent[] {
  const rows = db.prepare(
    `SELECT ${WITH_SOURCE} WHERE e.parcel_id = ? ORDER BY e.occurred_at, e.id`,
  ).all(parcelId) as Row[]
  return rows.map(toEvent)
}

/**
 * Settles the parcel's cached status and `delivered_at`. The status is the adapter's authoritative
 * top-level `status`: it is written as-is and never derived from, or overridden by, the newest event,
 * because stored events are never restamped (carriers with prose-only events would otherwise be
 * reverted on every poll). `delivered_at` is the newest event's time when that status is `delivered`
 * (`now` when there are no events), else cleared.
 *
 * The one thing that outranks the carrier is the user saying they have the parcel (`user_marks`):
 * while that mark stands the parcel is `delivered`, at the moment of the mark, whatever `status` the
 * caller brings. This is the only writer of that rule, so a poll, an ingest or anything added later
 * that recomputes a parcel cannot put a collected parcel back on the dashboard.
 */
export function recomputeParcelStatus(
  db: Database, parcelId: number, status: CanonicalStatus, now: Date = new Date(),
): void {
  const mark = userMark(db, parcelId)
  const settled = mark ? 'delivered' : status
  const deliveredAt = settled === 'delivered'
    ? (mark?.at ?? latestEvent(db, parcelId)?.occurredAt ?? now)
    : undefined
  db.prepare('UPDATE parcels SET status = ?, delivered_at = ? WHERE id = ?').run(
    settled, deliveredAt?.toISOString() ?? null, parcelId,
  )
}

/**
 * The status to store for a parcel the carrier has just answered about. Normally the carrier's own; for
 * a parcel the user has marked (which only a poll already in flight when they clicked can reach - a
 * delivered parcel is never selected for polling), it stays `delivered`, and the carrier's answer is
 * kept under the mark instead, so that an undo restores what the carrier says NOW rather than what it
 * said before the click.
 */
export function settleCarrierStatus(db: Database, parcelId: number, carrier: CanonicalStatus): CanonicalStatus {
  if (!userMark(db, parcelId)) return carrier
  db.prepare('UPDATE user_marks SET carrier_status = ? WHERE parcel_id = ?').run(carrier, parcelId)
  return 'delivered'
}

const MARK_SQL = `SELECT m.parcel_id, m.event_id, m.kind, m.carrier_status, e.occurred_at
  FROM user_marks m JOIN events e ON e.id = m.event_id`

const toMark = (r: Row): UserMark => ({
  parcelId: r.parcel_id as number,
  eventId: r.event_id as number,
  kind: r.kind as UserMarkKind,
  carrierStatus: r.carrier_status as CanonicalStatus,
  at: new Date(r.occurred_at as string),
})

/** The user's mark on this parcel, if they have marked it collected or received. */
export function userMark(db: Database, parcelId: number): UserMark | undefined {
  const row = db.prepare(`${MARK_SQL} WHERE m.parcel_id = ?`).get(parcelId) as Row | undefined
  return row && toMark(row)
}

/** Every mark, by parcel id: one query for a page that lists many parcels (History). */
export function userMarks(db: Database): Map<number, UserMark> {
  const rows = db.prepare(MARK_SQL).all() as Row[]
  return new Map(rows.map(r => [r.parcel_id as number, toMark(r)]))
}

/** The sentence the mark's event carries, which is what the timeline prints for it. */
export const USER_MARK_TEXT: Record<UserMarkKind, string> = {
  collected: 'Collected — marked by you',
  received: 'Received — marked by you',
}

/**
 * Adds the mark's event and the row that names it. The event is an ordinary `delivered` event at the
 * moment of the click, so everything that reads events (the timeline, `delivered_at`) needs no special
 * case. Its `dedup_hash` is `user:<kind>:<instant>`, a namespace no carrier hash can ever be in (those are
 * SHA-256 hex), so `UNIQUE (parcel_id, dedup_hash)` can neither reject the mark nor fold a carrier
 * event into it. Callers hold the transaction; see core/collected.ts.
 */
export function insertUserMark(
  db: Database, parcelId: number, kind: UserMarkKind, carrierStatus: CanonicalStatus, at: Date,
): number {
  const iso = at.toISOString()
  const info = db.prepare(`
    INSERT INTO events (parcel_id, occurred_at, occurred_at_raw, occurred_at_tz, status, code,
                        description, location, dedup_hash, first_seen_at)
    VALUES (?, ?, ?, 'UTC', 'delivered', NULL, ?, NULL, ?, ?)
  `).run(parcelId, iso, iso, USER_MARK_TEXT[kind], `user:${kind}:${iso}`, iso)
  const eventId = Number(info.lastInsertRowid)
  db.prepare('INSERT INTO user_marks (parcel_id, event_id, kind, carrier_status) VALUES (?, ?, ?, ?)')
    .run(parcelId, eventId, kind, carrierStatus)
  return eventId
}

/** Removes the mark and exactly the event it added; no carrier event is touched. */
export function deleteUserMark(db: Database, mark: UserMark): void {
  db.prepare('DELETE FROM user_marks WHERE parcel_id = ?').run(mark.parcelId)
  db.prepare('DELETE FROM events WHERE id = ?').run(mark.eventId)
}
