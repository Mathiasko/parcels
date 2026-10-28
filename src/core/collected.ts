import type { Database } from '../db/index.js'
import { getParcel, markAnnounced, type Parcel } from '../db/parcels.js'
import {
  deleteUserMark, insertUserMark, recomputeParcelStatus, userMark, type UserMark, type UserMarkKind,
} from '../db/events.js'
import { logAction, UNATTRIBUTED, type Cause } from '../db/activity-log.js'
import { passedSlots } from '../notify/nudge.js'
import { isTerminalStatus } from './types.js'

/**
 * "Mark as collected": the user saying they have the parcel, for the parcels the carrier is slow to
 * close (a locker pickup is reported hours later) or never closes at all (a shop's own delivery, a
 * tracking number that went quiet). Without it the only way off the dashboard was Delete, which loses
 * the parcel's history.
 *
 * It is modelled as an EVENT, not as a status overwrite: one `delivered` event at the moment of the
 * click, named in `user_marks` so it can be told apart from what a carrier said and taken back exactly.
 * The status, `delivered_at`, History and the timeline then follow from events through the one writer
 * that already settles them (`recomputeParcelStatus`), which is also what keeps a later poll or mail
 * from putting the parcel back.
 */

export type MarkOutcome =
  | { ok: true; parcel: Parcel; mark: UserMark }
  | { ok: false; reason: 'no_parcel' | 'not_in_flight' | 'not_marked' }

/** Which word the button, the event and History use: a parcel waiting at a pickup point is collected. */
export const markKindFor = (p: Parcel): UserMarkKind => (p.status === 'ready_for_pickup' ? 'collected' : 'received')

/** Whether the parcel can be marked at all: it is still in flight (not delivered, returned or archived). */
export const canMark = (p: Parcel): boolean => p.archivedAt === undefined && !isTerminalStatus(p.status)

/**
 * Marks a parcel in flight as collected (or received), in one IMMEDIATE transaction: the poller is
 * another process writing the same rows.
 *
 * The new status is recorded as ANNOUNCED in the same transaction, along with the pickup point: the
 * notification rules announce whatever differs from `last_announced_status`, and a "Delivered" banner
 * about something the user has just done themselves is noise. Reminders stop on their own, because
 * they are only ever sent for a parcel that is `ready_for_pickup`.
 */
export function markCollected(db: Database, parcelId: number, cause: Cause = UNATTRIBUTED): MarkOutcome {
  const at = cause.at ?? new Date()
  return db.transaction((): MarkOutcome => {
    const p = getParcel(db, parcelId)
    if (!p) return { ok: false, reason: 'no_parcel' }
    if (!canMark(p)) return { ok: false, reason: 'not_in_flight' }
    const kind = markKindFor(p)
    insertUserMark(db, p.id, kind, p.status, at)
    recomputeParcelStatus(db, p.id, p.status, at)
    markAnnounced(db, p.id, 'delivered', p.pickup !== undefined)
    // One row for the action, carrying the move it caused: there is no separate `status` row, because
    // this IS the cause of that move and two rows would read as two things happening.
    logAction(db, { kind: 'collected', as: kind, parcelId: p.id, carrier: p.carrier, from: p.status }, { ...cause, at })
    return { ok: true, parcel: getParcel(db, p.id)!, mark: userMark(db, p.id)! }
  }).immediate()
}

/**
 * Takes a mark back: deletes exactly the event it added and recomputes, so the parcel returns to what
 * the carrier says (usually `ready_for_pickup`) and to the dashboard.
 *
 * Also silent. The restored status is recorded as announced (the user is looking at it, and a "Ready for
 * pickup" banner for a parcel they just un-marked would be the noise the mark avoided), and today's
 * reminder slots that have already passed are marked spent, so the next poll does not answer the
 * undo with "Still waiting for you". The next slot still comes round as usual.
 */
export function undoCollected(db: Database, parcelId: number, cause: Cause = UNATTRIBUTED): MarkOutcome {
  const at = cause.at ?? new Date()
  return db.transaction((): MarkOutcome => {
    const p = getParcel(db, parcelId)
    if (!p) return { ok: false, reason: 'no_parcel' }
    const mark = userMark(db, p.id)
    if (!mark || p.archivedAt !== undefined) return { ok: false, reason: 'not_marked' }
    deleteUserMark(db, mark)
    recomputeParcelStatus(db, p.id, mark.carrierStatus, at)
    markAnnounced(db, p.id, mark.carrierStatus, false)
    if (mark.carrierStatus === 'ready_for_pickup') {
      const spend = db.prepare('INSERT OR IGNORE INTO pickup_nudges (parcel_id, slot_key, sent_at) VALUES (?, ?, ?)')
      for (const slot of passedSlots(at)) spend.run(p.id, slot, at.toISOString())
    }
    logAction(db, {
      kind: 'uncollected', as: mark.kind, parcelId: p.id, carrier: p.carrier, to: mark.carrierStatus,
    }, { ...cause, at })
    return { ok: true, parcel: getParcel(db, p.id)!, mark }
  }).immediate()
}
