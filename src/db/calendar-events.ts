import type { Database } from './index.js'

/**
 * The event "Add to Calendar" put into Calendar.app for a parcel, if any (see `calendar_events` in
 * schema.sql). Only what is needed to replace it and to say where it is: Calendar's uid, the calendar's
 * name, and when it starts.
 */
export interface StoredCalendarEvent {
  parcelId: number
  uid: string
  calendar: string
  startsAt: Date
  createdAt: Date
}

interface Row { parcel_id: number; uid: string; calendar: string; starts_at: string; created_at: string }

const toEvent = (r: Row): StoredCalendarEvent => ({
  parcelId: r.parcel_id, uid: r.uid, calendar: r.calendar, startsAt: new Date(r.starts_at), createdAt: new Date(r.created_at),
})

export function getCalendarEvent(db: Database, parcelId: number): StoredCalendarEvent | undefined {
  const r = db.prepare('SELECT * FROM calendar_events WHERE parcel_id = ?').get(parcelId) as Row | undefined
  return r && toEvent(r)
}

/** Every stored event, by parcel id - one query for a page that lists several parcels. */
export function calendarEventsFor(db: Database, parcelIds: number[]): Map<number, StoredCalendarEvent> {
  if (parcelIds.length === 0) return new Map()
  const rows = db.prepare(
    `SELECT * FROM calendar_events WHERE parcel_id IN (${parcelIds.map(() => '?').join(',')})`,
  ).all(...parcelIds) as Row[]
  return new Map(rows.map(r => [r.parcel_id, toEvent(r)]))
}

/** Records the event just added, replacing the row for an earlier one. */
export function saveCalendarEvent(db: Database, e: StoredCalendarEvent): void {
  db.prepare(`
    INSERT INTO calendar_events (parcel_id, uid, calendar, starts_at, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(parcel_id) DO UPDATE SET
      uid = excluded.uid, calendar = excluded.calendar, starts_at = excluded.starts_at, created_at = excluded.created_at
  `).run(e.parcelId, e.uid, e.calendar, e.startsAt.toISOString(), e.createdAt.toISOString())
}
