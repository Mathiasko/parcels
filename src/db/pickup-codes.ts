import type { Database } from './index.js'

interface Row { code: string | null; checked_messages: number }

/** The stored code for a parcel, if one was found in its mail. */
export function getPickupCode(db: Database, parcelId: number): string | undefined {
  const r = db.prepare('SELECT code FROM pickup_codes WHERE parcel_id = ?').get(parcelId) as { code: string | null } | undefined
  return r?.code ?? undefined
}

/** Every stored code, by parcel id - one query for a page that lists several parcels. */
export function pickupCodesFor(db: Database, parcelIds: number[]): Map<number, string> {
  if (parcelIds.length === 0) return new Map()
  const rows = db.prepare(
    `SELECT parcel_id, code FROM pickup_codes WHERE code IS NOT NULL AND parcel_id IN (${parcelIds.map(() => '?').join(',')})`,
  ).all(...parcelIds) as { parcel_id: number; code: string }[]
  return new Map(rows.map(r => [r.parcel_id, r.code]))
}

/**
 * Whether the parcel's mail is worth scanning again. A parcel whose mail yielded no code is the
 * normal case for a staffed pickup point, so "no code" must be remembered rather than retried; the
 * message count is the trigger, because the only thing that can change the answer is new mail.
 */
export function needsPickupCodeCheck(db: Database, parcelId: number, messageCount: number): boolean {
  const r = db.prepare('SELECT code, checked_messages FROM pickup_codes WHERE parcel_id = ?').get(parcelId) as Row | undefined
  if (!r) return true
  if (r.code !== null) return false            // found once is found for good: the locker code does not change
  return messageCount > r.checked_messages
}

/** Records the outcome of a scan, code or no code. */
export function recordPickupCode(
  db: Database, parcelId: number, code: string | undefined, messageCount: number, at: Date,
): void {
  db.prepare(`
    INSERT INTO pickup_codes (parcel_id, code, checked_messages, checked_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(parcel_id) DO UPDATE SET
      code = COALESCE(excluded.code, pickup_codes.code),
      checked_messages = excluded.checked_messages,
      checked_at = excluded.checked_at
  `).run(parcelId, code ?? null, messageCount, at.toISOString())
}
