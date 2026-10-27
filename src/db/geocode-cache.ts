import type { Database } from './index.js'

/**
 * `found`   - Nominatim returned a usable point; it is in `lat`/`lon` and will never be asked again.
 * `not_found` - Nominatim answered, with nothing. Near-permanent: an address it does not know today
 *             it almost certainly will not know next hour.
 * `error`   - the request itself failed (no answer, a bad status, an unreadable body). Worth retrying,
 *             but on a widening window.
 */
export type GeocodeOutcome = 'found' | 'not_found' | 'error'

export interface GeocodeResult {
  outcome: GeocodeOutcome
  lat?: number
  lon?: number
  /** Why the attempt failed; never shown to the user, only useful when reading the table by hand. */
  detail?: string
}

export interface GeocodeRow extends GeocodeResult {
  /** The normalised query this row answers; see `geocodeQuery`. */
  query: string
  /** Consecutive failed attempts, 0 once the address has been found. Drives the back-off. */
  attempts: number
  attemptedAt: Date
}

type Row = Record<string, string | number | null>

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v)

const toRow = (r: Row): GeocodeRow => ({
  query: r.query as string,
  outcome: r.outcome as GeocodeOutcome,
  lat: opt(r.lat as number | null),
  lon: opt(r.lon as number | null),
  attempts: r.attempts as number,
  attemptedAt: new Date(r.attempted_at as string),
  detail: opt(r.detail as string | null),
})

export function getGeocode(db: Database, query: string): GeocodeRow | undefined {
  const row = db.prepare('SELECT * FROM geocode_cache WHERE query = ?').get(query) as Row | undefined
  return row && toRow(row)
}

/**
 * Records an attempt against `query`, whatever it produced. A success resets `attempts` to 0 and
 * clears the stale failure detail; a failure increments the stored count, so the back-off widens
 * across poll runs (the poller is a fresh process every hour and can keep no count in memory).
 */
export function recordGeocode(db: Database, query: string, r: GeocodeResult, at: Date): void {
  const found = r.outcome === 'found'
  db.prepare(`
    INSERT INTO geocode_cache (query, outcome, lat, lon, attempts, attempted_at, detail)
    VALUES (@query, @outcome, @lat, @lon, @first, @at, @detail)
    ON CONFLICT (query) DO UPDATE SET
      outcome      = @outcome,
      lat          = @lat,
      lon          = @lon,
      attempts     = CASE WHEN @found THEN 0 ELSE attempts + 1 END,
      attempted_at = @at,
      detail       = @detail
  `).run({
    query,
    outcome: r.outcome,
    lat: found ? r.lat ?? null : null,
    lon: found ? r.lon ?? null : null,
    first: found ? 0 : 1,
    found: found ? 1 : 0,
    at: at.toISOString(),
    detail: r.detail ?? null,
  })
}
