import type { Database } from './index.js'

export interface IngestStatus {
  lastOkAt?: Date
  lastErrorAt?: Date
  lastError?: string
  consecutiveFailures: number
  notifiedAt?: Date
}

const ERROR_MAX = 300

/**
 * Records one ingest run. Success resets the streak and clears `notified_at` (so the next outage is
 * announced afresh); a failure extends the streak and keeps the last error for the Health page.
 */
export function recordIngest(db: Database, outcome: { ok: true } | { ok: false; error: string }, at: Date): void {
  const iso = at.toISOString()
  if (outcome.ok) {
    db.prepare(`
      INSERT INTO ingest_status (id, last_ok_at, consecutive_failures) VALUES (1, ?, 0)
      ON CONFLICT (id) DO UPDATE SET last_ok_at = excluded.last_ok_at, consecutive_failures = 0, notified_at = NULL
    `).run(iso)
    return
  }
  db.prepare(`
    INSERT INTO ingest_status (id, last_error_at, last_error, consecutive_failures) VALUES (1, ?, ?, 1)
    ON CONFLICT (id) DO UPDATE SET
      last_error_at = excluded.last_error_at, last_error = excluded.last_error,
      consecutive_failures = consecutive_failures + 1
  `).run(iso, outcome.error.slice(0, ERROR_MAX))
}

type Row = Record<string, string | number | null>
const date = (v: string | number | null) => (v === null ? undefined : new Date(v as string))

export function getIngestStatus(db: Database): IngestStatus | undefined {
  const r = db.prepare('SELECT * FROM ingest_status WHERE id = 1').get() as Row | undefined
  return r && {
    lastOkAt: date(r.last_ok_at),
    lastErrorAt: date(r.last_error_at),
    lastError: r.last_error === null ? undefined : (r.last_error as string),
    consecutiveFailures: r.consecutive_failures as number,
    notifiedAt: date(r.notified_at),
  }
}

export function markIngestNotified(db: Database, at: Date): void {
  db.prepare('UPDATE ingest_status SET notified_at = ? WHERE id = 1').run(at.toISOString())
}
