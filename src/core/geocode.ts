import type { GeocodeResult, GeocodeRow } from '../db/geocode-cache.js'
import type { HttpClient, PickupPoint } from './types.js'

/**
 * Turning a pickup address into coordinates, through Nominatim (OpenStreetMap's own geocoder, no API
 * key). Four of the five carriers never send coordinates, so without this almost no pickup point could
 * be drawn on a map.
 *
 * Nominatim's usage policy is a condition of use, not advice: at most one request per second, a
 * User-Agent that identifies the application, and results cached so the same query is never sent
 * twice. The pacing lives in the caller (`map-preview.ts`), the caching in `geocode_cache`, and this
 * module holds the query, the request and the back-off rule.
 */

export const NOMINATIM_HOST = 'nominatim.openstreetmap.org'
const NOMINATIM_URL = `https://${NOMINATIM_HOST}/search`

/**
 * Identifies this application, as the policy requires. Not a browser string, not blank, and specific
 * enough that an operator reading their logs can tell what it is and that its volume is tiny.
 */
export const USER_AGENT = 'parcels/0.1 (self-hosted personal parcel tracker; single user; a few requests per day)'

/**
 * Every pickup point this app has ever seen is in Slovakia: all five carriers are Slovak and a pickup
 * point is in the delivery country by definition. Saying so keeps a bare "<postcode> <town>" from
 * resolving to a Czech or Polish town with the same street name, which is a wrong pin rather than no pin.
 */
const COUNTRY = 'sk'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** A `not_found` is near-permanent, but not eternal: an address missing from OSM may be added. */
export const NOT_FOUND_RETRY_MS = 30 * DAY
/** First retry after a transport error; doubles with each consecutive failure. */
export const ERROR_BASE_WAIT_MS = HOUR
export const ERROR_MAX_WAIT_MS = 7 * DAY

/**
 * The normalised query for a pickup point, which is both what is sent to Nominatim and the cache key.
 * One string for both is the point: two parcels whose carrier spelled the same address differently
 * (spacing, capitals) must collapse to one lookup.
 *
 * A town is the minimum. A street with no town is unplaceable, and the place's *name* is deliberately
 * not used: "Z-BOX Bratislava, Hlavna 6" is a label, not an address, and geocoding a chain's name
 * lands on whichever branch sorts first - exactly the wrong-branch problem `mapsUrl` describes. A
 * point with only a name therefore gets no coordinates and no map, and keeps its address search link.
 */
export function geocodeQuery(pickup: PickupPoint | undefined): string | undefined {
  const clean = (s: string | undefined): string | undefined => {
    const out = s?.replace(/\s+/g, ' ').trim()
    return out === '' ? undefined : out
  }
  const city = clean(pickup?.city)
  if (!city) return undefined
  const where = [clean(pickup?.postalCode), city].filter(Boolean).join(' ')
  return [clean(pickup?.street), where].filter(Boolean).join(', ').toLowerCase()
}

/**
 * Whether a cached row should be attempted again. A found address: never. A `not_found`: after a
 * month. An error: after `2**(attempts-1)` hours, capped at a week. The row's own `attempts` is what
 * makes this survive the poller exiting between runs.
 */
export function retryDue(row: GeocodeRow, now: Date): boolean {
  if (row.outcome === 'found') return false
  const wait = row.outcome === 'not_found'
    ? NOT_FOUND_RETRY_MS
    : Math.min(ERROR_BASE_WAIT_MS * 2 ** Math.max(0, row.attempts - 1), ERROR_MAX_WAIT_MS)
  return now.getTime() - row.attemptedAt.getTime() >= wait
}

/** A latitude/longitude pair that can actually be drawn: finite, in range, and not the null island. */
const usable = (lat: number, lon: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  && !(lat === 0 && lon === 0)

/**
 * One Nominatim search. Never throws: every way this can go wrong is an outcome to be recorded, and
 * a geocode is an optional extra that must not be able to fail a poll run.
 */
export async function lookupPoint(http: HttpClient, query: string): Promise<GeocodeResult> {
  const url = `${NOMINATIM_URL}?${new URLSearchParams({
    q: query, format: 'jsonv2', limit: '1', countrycodes: COUNTRY,
  })}`
  try {
    const res = await http(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
    if (res.status !== 200) return { outcome: 'error', detail: `HTTP ${res.status}` }
    const body = await res.json<unknown>()
    if (!Array.isArray(body)) return { outcome: 'error', detail: 'response was not a list of places' }
    if (body.length === 0) return { outcome: 'not_found' }
    const first = body[0] as { lat?: unknown; lon?: unknown }
    const lat = Number(first.lat)
    const lon = Number(first.lon)
    if (!usable(lat, lon)) return { outcome: 'error', detail: `unusable coordinates ${String(first.lat)}/${String(first.lon)}` }
    return { outcome: 'found', lat, lon }
  } catch (err) {
    return { outcome: 'error', detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
  }
}
