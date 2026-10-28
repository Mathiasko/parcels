import type { Database } from '../db/index.js'
import { getGeocode, recordGeocode } from '../db/geocode-cache.js'
import { listActive, setPickupCoords, type Parcel } from '../db/parcels.js'
import { geocodeQuery, lookupPoint, retryDue } from './geocode.js'
import { HttpTransportError, type BinaryFetch } from './http.js'
import { tileGrid, type TileGrid } from './slippy.js'
import { GRID_SIZE, hasTile, isPng, storeTile, TILE_USER_AGENT, TILE_ZOOM, tileUrl } from './tiles.js'
import type { HttpClient } from './types.js'

/**
 * The poll-time half of the map preview: geocode the pickup points that need it, then pull the tiles
 * around them into the on-disk cache. Nothing here ever runs from a web request, and the page-side
 * half (`cachedGrid`) only reads the cache. That split is the feature: viewing a parcel touches no
 * third party and blocks on nothing.
 *
 * Both services are free community infrastructure, so the volume is bounded three ways: a cache that
 * records failures as well as successes (so a bad address is not re-sent every hour), a per-run cap,
 * and a minimum gap between requests.
 */

/** Nominatim's published limit is one request per second. */
const GEOCODE_GAP_MS = 1000
/** Tiles come from a CDN with no published rate, but nine at a time still deserves a gap. */
const TILE_GAP_MS = 200

/** At most this many addresses are sent to Nominatim in one run; the rest wait for the next. */
export const MAX_GEOCODES_PER_RUN = 5
/** At most this many pickup points have their nine tiles fetched in one run. */
export const MAX_TILE_POINTS_PER_RUN = 3

export interface MapPreviewDeps {
  db: Database
  /** Used for the Nominatim search only; JSON, so the ordinary text client fits. */
  http: HttpClient
  /** Used for the tiles only; PNG bytes, which `HttpClient` cannot carry. */
  fetchBytes: BinaryFetch
  tileDir: string
  now: Date
  /** Injectable so tests do not spend real seconds inside the politeness gaps. */
  sleep?: (ms: number) => Promise<void>
}

export interface MapPreviewReport {
  /** Pickup points that gained coordinates this run, from a lookup or from the cache. */
  located: number
  /** Addresses actually sent to Nominatim. */
  searched: number
  /** Tiles newly written to the cache. */
  tiles: number
  /** Lookups and tile fetches that failed. Never fails the poll; only interesting in a log. */
  failures: number
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Keeps successive calls at least `gapMs` apart. One pacer per service, per run. */
function pacer(gapMs: number, sleep: (ms: number) => Promise<void>): () => Promise<void> {
  let last = 0
  return async () => {
    const wait = last + gapMs - Date.now()
    if (wait > 0) await sleep(wait)
    last = Date.now()
  }
}

const describe = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

/** Where a parcel's pickup point is, once it is known. */
const coordsOf = (p: Parcel): { lat: number; lon: number } | undefined => {
  const { lat, lon } = p.pickup ?? {}
  return lat !== undefined && lon !== undefined ? { lat, lon } : undefined
}

/**
 * The grid a page may draw for a point: the 3x3 block at `TILE_ZOOM`, but only when every one of its
 * tiles is already in the cache. A partial grid would render as holes and broken-image icons, so the
 * answer is `undefined` and the page shows no map at all (the address and its maps link stay).
 *
 * Pure reads: `existsSync` nine times, no network, no database.
 */
export function cachedGrid(tileDir: string, lat: number, lon: number): TileGrid | undefined {
  const grid = tileGrid(lat, lon, TILE_ZOOM, GRID_SIZE)
  if (!grid) return undefined
  return grid.tiles.every(t => hasTile(tileDir, t)) ? grid : undefined
}

/**
 * One run of the map preview. Returns what it did; it never throws for anything a remote service did,
 * so a poll run cannot be failed by a geocoder being down.
 */
export async function runMapPreview(deps: MapPreviewDeps): Promise<MapPreviewReport> {
  const { db, now, tileDir } = deps
  const sleep = deps.sleep ?? realSleep
  const paceGeocode = pacer(GEOCODE_GAP_MS, sleep)
  const paceTile = pacer(TILE_GAP_MS, sleep)
  const report: MapPreviewReport = { located: 0, searched: 0, tiles: 0, failures: 0 }

  let searchBudget = MAX_GEOCODES_PER_RUN
  let tileBudget = MAX_TILE_POINTS_PER_RUN

  // Only a parcel waiting at a place needs a map, and only an active one is worth a request.
  for (const p of listActive(db).filter(p => p.status === 'ready_for_pickup' && p.pickup !== undefined)) {
    let where = coordsOf(p)

    if (!where) {
      const query = geocodeQuery(p.pickup)
      if (!query) continue                                  // a name is not an address; see geocodeQuery
      const cached = getGeocode(db, query)
      if (cached?.outcome === 'found' && cached.lat !== undefined && cached.lon !== undefined) {
        where = { lat: cached.lat, lon: cached.lon }         // another parcel already paid for this
      } else if (cached && !retryDue(cached, now)) {
        continue                                            // failed recently enough; do not ask again
      } else {
        if (searchBudget <= 0) continue
        searchBudget--
        await paceGeocode()
        const result = await lookupPoint(deps.http, query)
        report.searched++
        recordGeocode(db, query, result, now)
        if (result.outcome !== 'found' || result.lat === undefined || result.lon === undefined) {
          if (result.outcome === 'error') report.failures++
          continue
        }
        where = { lat: result.lat, lon: result.lon }
      }
      // Onto the parcel, so `mapsUrl` upgrades from an address search to an exact pin.
      setPickupCoords(db, p.id, where.lat, where.lon)
      report.located++
    }

    const grid = tileGrid(where.lat, where.lon, TILE_ZOOM, GRID_SIZE)
    if (!grid) continue
    const missing = grid.tiles.filter(t => !hasTile(tileDir, t))
    if (missing.length === 0) continue
    if (tileBudget <= 0) continue
    tileBudget--
    for (const t of missing) {
      await paceTile()
      try {
        const res = await deps.fetchBytes(tileUrl(t), { headers: { 'User-Agent': TILE_USER_AGENT } })
        if (res.status !== 200 || !isPng(res.bytes)) { report.failures++; continue }
        if (storeTile(tileDir, t, res.bytes)) report.tiles++
      } catch (err) {
        report.failures++
        // The zoom, never x/y: at this zoom a tile's coordinates place the reader to a few hundred
        // metres, and this line ends up in the log a support bundle is made from. The URL is the same
        // coordinates again, so a transport error contributes its reason and not its message.
        const why = err instanceof HttpTransportError ? `${err.name}: ${err.detail}` : describe(err)
        console.error(`map preview: a zoom ${t.z} tile failed: ${why}`)
      }
    }
  }
  return report
}

/** One line for the poll log, or nothing at all when the run had nothing to do. */
export function summarizeMapPreview(r: MapPreviewReport): string {
  if (r.located === 0 && r.searched === 0 && r.tiles === 0 && r.failures === 0) return ''
  const parts = [
    r.located && `${r.located} point(s) located${r.searched ? ` (${r.searched} geocoded)` : ' from cache'}`,
    !r.located && r.searched && `${r.searched} address(es) geocoded, none found`,
    r.tiles && `${r.tiles} tile(s) cached`,
    r.failures && `${r.failures} request(s) failed`,
  ].filter(Boolean)
  return `, map: ${parts.join(', ')}`
}
