import type { Database } from './index.js'
import type { CarrierId } from '../core/types.js'

export type HealthOutcome = 'ok' | 'gated' | 'transport' | 'parse'

export interface HealthRow {
  carrier: CarrierId
  lastOkAt?: Date
  lastErrorAt?: Date
  lastErrorKind?: Exclude<HealthOutcome, 'ok'>
  lastErrorDetail?: string
  consecutiveFailures: number
  notifiedAt?: Date
}

/**
 * Records one run's outcome for a carrier. `ok` resets the failure streak; anything else extends
 * it. The last error is kept after recovery so the history of the most recent problem survives.
 * Recovery also clears `notified_at`: that stamp means "the current outage has been announced", so
 * the next outage must be announced afresh.
 */
export function recordHealth(
  db: Database, carrier: CarrierId, outcome: HealthOutcome, detail?: string, at: Date = new Date(),
): void {
  const iso = at.toISOString()
  if (outcome === 'ok') {
    db.prepare(`
      INSERT INTO carrier_health (carrier, last_ok_at, consecutive_failures) VALUES (?, ?, 0)
      ON CONFLICT (carrier) DO UPDATE SET
        last_ok_at = excluded.last_ok_at, consecutive_failures = 0, notified_at = NULL
    `).run(carrier, iso)
    return
  }
  db.prepare(`
    INSERT INTO carrier_health (carrier, last_error_at, last_error_kind, last_error_detail, consecutive_failures)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT (carrier) DO UPDATE SET
      last_error_at = excluded.last_error_at,
      last_error_kind = excluded.last_error_kind,
      last_error_detail = excluded.last_error_detail,
      consecutive_failures = consecutive_failures + 1
  `).run(carrier, iso, outcome, detail ?? null)
}

type Row = Record<string, string | number | null>
const date = (v: string | number | null) => (v === null ? undefined : new Date(v as string))

export function carrierHealth(db: Database): HealthRow[] {
  const rows = db.prepare('SELECT * FROM carrier_health ORDER BY carrier').all() as Row[]
  return rows.map(r => ({
    carrier: r.carrier as CarrierId,
    lastOkAt: date(r.last_ok_at),
    lastErrorAt: date(r.last_error_at),
    lastErrorKind: r.last_error_kind === null ? undefined : (r.last_error_kind as HealthRow['lastErrorKind']),
    lastErrorDetail: r.last_error_detail === null ? undefined : (r.last_error_detail as string),
    consecutiveFailures: r.consecutive_failures as number,
    notifiedAt: date(r.notified_at),
  }))
}

/** Stamps that the carrier's current outage has been announced; cleared when it next records `ok`. */
export function markCarrierNotified(db: Database, carrier: CarrierId, at: Date): void {
  db.prepare('UPDATE carrier_health SET notified_at = ? WHERE carrier = ?').run(at.toISOString(), carrier)
}
