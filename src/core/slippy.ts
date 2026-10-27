/**
 * The slippy-map (Web Mercator) projection, and nothing else: no network, no disk, no database. The
 * whole map preview rests on these few lines of arithmetic, which is why they live alone and are
 * tested directly against values that can be derived by hand.
 *
 * The convention is the standard one (OpenStreetMap, every raster tile server): at zoom `z` the world
 * is a `2**z` by `2**z` grid of square tiles, tile (0, 0) is the north-west corner, x grows east and
 * y grows south. A fractional coordinate is "this many tiles from the corner", so its integer part
 * names the tile and its fraction, times the tile size, is the pixel offset inside that tile.
 */

/** Edge length of one raster tile, in CSS pixels. Every tile server in use here serves 256. */
export const TILE_SIZE = 256

/** The deepest zoom this app will ever ask for or serve. OSM's own tiles stop at 19. */
export const MAX_ZOOM = 19

/** The latitude at which y reaches the top edge of the square; Mercator cannot represent the poles. */
const MERCATOR_LIMIT = 85.05112877980659

/** One tile, named by its zoom and its integer position in that zoom's grid. */
export interface Tile { z: number; x: number; y: number }

/** A position in fractional tile units at some zoom: both components lie in [0, 2**z]. */
export interface TileCoord { x: number; y: number }

/**
 * Latitude/longitude to fractional tile coordinates.
 *
 * `y` uses `ln(tan φ + sec φ)`, the inverse Gudermannian function, which is the definition of the
 * Mercator ordinate; `asinh(tan φ)` is the same number and the tests cross-check against it.
 */
export function project(lat: number, lon: number, z: number): TileCoord {
  const n = 2 ** z
  const phi = (lat * Math.PI) / 180
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n,
  }
}

/** Whether `t` names a tile that exists: integers, a zoom we serve, and inside that zoom's grid. */
export function isTile(t: Tile): boolean {
  if (!Number.isInteger(t.z) || !Number.isInteger(t.x) || !Number.isInteger(t.y)) return false
  if (t.z < 0 || t.z > MAX_ZOOM) return false
  const n = 2 ** t.z
  return t.x >= 0 && t.x < n && t.y >= 0 && t.y < n
}

/**
 * The three path parameters of `GET /tile/:z/:x/:y.png`, validated into numbers, or `undefined`.
 *
 * Strict on purpose, and the only place a request's strings become tile numbers: the caller builds a
 * file path from the returned integers and never from these strings, so `..`, an encoded slash, a
 * sign, an exponent or a float cannot survive into a path. Leading zeros are rejected too, so one
 * tile has exactly one URL and exactly one cache entry.
 */
export function parseTile(z: string, x: string, y: string): Tile | undefined {
  const int = (s: string): number | undefined =>
    /^(0|[1-9][0-9]{0,6})$/.test(s) ? Number(s) : undefined
  const [pz, px, py] = [int(z), int(x), int(y)]
  if (pz === undefined || px === undefined || py === undefined) return undefined
  const t = { z: pz, x: px, y: py }
  return isTile(t) ? t : undefined
}

/** A square block of tiles with the point of interest inside its middle tile. */
export interface TileGrid {
  z: number
  /** The grid is `size` by `size` tiles; always odd, so one tile is the middle. */
  size: number
  tileSize: number
  /** Row-major from the north-west tile: index `size * row + column`. */
  tiles: Tile[]
  /** Where the point sits inside the assembled block, in pixels from its top-left corner. */
  pointX: number
  pointY: number
  /** Pixel size of the assembled block. */
  width: number
  height: number
}

/**
 * The block of `size` by `size` tiles centred on (`lat`, `lon`), or `undefined` when the point cannot
 * be placed: a coordinate that is not a finite number in range, a zoom outside [0, MAX_ZOOM], a
 * latitude beyond the Mercator limit, or a block that would reach past the edge of the world (near the
 * antimeridian or the poles). Refusing is deliberate: wrapping or clamping would draw a map of
 * somewhere else, and "no map" is a state the page already handles.
 *
 * Because the point always lies within the middle tile, it is at least `tileSize` pixels from every
 * edge of the block, which is what lets a viewport up to `(size - 1) * tileSize` across be cropped
 * around it with no gap. For the 3x3 default that is 512 pixels.
 */
export function tileGrid(lat: number, lon: number, z: number, size = 3): TileGrid | undefined {
  if (size < 1 || size % 2 !== 1) throw new RangeError(`tile grid size must be odd, got ${size}`)
  if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM) return undefined
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined
  if (Math.abs(lat) > MERCATOR_LIMIT || Math.abs(lon) > 180) return undefined

  const { x, y } = project(lat, lon, z)
  const cx = Math.floor(x)
  const cy = Math.floor(y)
  const reach = (size - 1) / 2
  const tiles: Tile[] = []
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const t = { z, x: cx + dx, y: cy + dy }
      if (!isTile(t)) return undefined
      tiles.push(t)
    }
  }
  return {
    z,
    size,
    tileSize: TILE_SIZE,
    tiles,
    pointX: (reach + x - cx) * TILE_SIZE,
    pointY: (reach + y - cy) * TILE_SIZE,
    width: size * TILE_SIZE,
    height: size * TILE_SIZE,
  }
}
