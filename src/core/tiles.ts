import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isTile, type Tile } from './slippy.js'

/**
 * The on-disk tile cache: `data/tiles/{z}/{x}/{y}.png`, beside `data/mail/` and with the same posture
 * (`0700` directories, `0600` files). Tiles are fetched during a poll and only ever read when a page
 * is rendered, which is the whole design: viewing a parcel must not touch the network.
 */

/** Street-level without being so deep that nine tiles cover a single block. */
export const TILE_ZOOM = 16

/** A 3x3 block: enough context around the point, nine requests, and a 512px crop with no gaps. */
export const GRID_SIZE = 3

/** OpenStreetMap's own tile server. Same politeness rules as Nominatim: identify yourself, cache, stay small. */
export const tileUrl = (t: Tile): string => `https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`

export const TILE_USER_AGENT = 'parcels/0.1 (self-hosted personal parcel tracker; single user; a few tiles per day)'

/** The tile cache lives beside the database, exactly as `data/mail` does. */
export const tileDirFor = (dbPath: string): string => join(dirname(dbPath), 'tiles')

/**
 * Where a tile is kept. Built only from numbers: every caller gets its `Tile` from `parseTile` or from
 * `tileGrid`, so no string from a request ever reaches a path segment.
 */
export const tilePath = (dir: string, t: Tile): string =>
  join(dir, String(t.z), String(t.x), `${String(t.y)}.png`)

/** The eight bytes every PNG begins with. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Whether `bytes` really is a PNG. A free tile server under load answers with an HTML error page and a
 * 200 as often as not, and a cached HTML page would render as a broken image for ever (nothing ever
 * refetches a tile that is already on disk).
 */
export const isPng = (bytes: Uint8Array): boolean =>
  bytes.length > PNG_MAGIC.length && PNG_MAGIC.every((b, i) => bytes[i] === b)

export const hasTile = (dir: string, t: Tile): boolean => existsSync(tilePath(dir, t))

/** The tile's bytes, or `undefined` when it is not cached. Never fetches; a page render must not. */
export function readTile(dir: string, t: Tile): Buffer | undefined {
  if (!isTile(t)) return undefined
  try {
    return readFileSync(tilePath(dir, t))
  } catch {
    return undefined
  }
}

/**
 * Writes a tile into the cache, through a temporary file and a rename, so a half-written PNG can never
 * be served (and so an interrupted poll leaves no permanently broken tile behind). Returns whether it
 * was stored; a body that is not a PNG is refused rather than cached.
 */
export function storeTile(dir: string, t: Tile, bytes: Uint8Array): boolean {
  if (!isTile(t) || !isPng(bytes)) return false
  const path = tilePath(dir, t)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 })
    renameSync(tmp, path)
    return true
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* the temp file may not exist; nothing to clean up */ }
    throw err
  }
}
