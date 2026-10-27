import { expect, test } from 'vitest'
import { MAX_ZOOM, parseTile, project, TILE_SIZE, tileGrid } from '../src/core/slippy.js'

/**
 * The slippy-map projection, checked against values that can be derived by hand rather than against
 * whatever this implementation happens to produce: the centre and corners of the world at low zoom
 * (exact by definition), the Web Mercator latitude limit, and a second, algebraically different form
 * of the y formula (`asinh(tan φ)` instead of `ln(tan φ + sec φ)`) as an independent cross-check.
 */

/** The northern edge of the Web Mercator square: the latitude whose y is exactly 0. */
const MERCATOR_TOP = 85.05112877980659

/** The y formula written the other way round, used only as a cross-check of `project`. */
const referenceY = (lat: number, z: number): number =>
  (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2 * 2 ** z

test('project: the world is one tile at zoom 0, and (0, 0) sits in its middle', () => {
  expect(project(0, 0, 0)).toEqual({ x: 0.5, y: 0.5 })
})

test('project: the corners of the world map onto the corners of the tile square', () => {
  expect(project(MERCATOR_TOP, -180, 0).x).toBeCloseTo(0, 12)
  expect(project(MERCATOR_TOP, -180, 0).y).toBeCloseTo(0, 12)
  expect(project(MERCATOR_TOP, 180, 3).x).toBeCloseTo(8, 10)
  expect(project(-MERCATOR_TOP, 180, 3).y).toBeCloseTo(8, 10)
})

test('project: zoom 1 splits the world into four quadrants about the equator and the prime meridian', () => {
  expect(project(0, 0, 1)).toEqual({ x: 1, y: 1 })
  expect(project(0, 90, 1).x).toBeCloseTo(1.5, 12)
  expect(project(0, -90, 1).x).toBeCloseTo(0.5, 12)
})

test('project: x is linear in longitude, y is symmetric about the equator', () => {
  const n = 2 ** 10
  expect(project(0, 45, 10).x).toBeCloseTo((225 / 360) * n, 9)
  const north = project(48.1486, 17.1077, 10)
  const south = project(-48.1486, -17.1077, 10)
  expect(north.y + south.y).toBeCloseTo(n, 9)
  expect(north.x + south.x).toBeCloseTo(n, 9)
})

test('project: y agrees with the asinh form of the Mercator formula at every zoom tried', () => {
  for (const z of [0, 5, 12, 16, 19]) {
    for (const lat of [-80, -48.1486, -1, 0, 17.5, 48.1486, 60, 84]) {
      expect(project(lat, 0, z).y).toBeCloseTo(referenceY(lat, z), 9)
    }
  }
})

test('project: Bratislava at zoom 16 falls in tile 35882/22740, 93 px right and 198 px down inside it', () => {
  const { x, y } = project(48.1486, 17.1077, 16)
  expect(Math.floor(x)).toBe(35882)
  expect(Math.floor(y)).toBe(22740)
  expect((x - Math.floor(x)) * TILE_SIZE).toBeCloseTo(92.606, 2)
  expect((y - Math.floor(y)) * TILE_SIZE).toBeCloseTo(197.549, 2)
})

test('tileGrid: a 3x3 grid is row-major from the north-west tile, centred on the point', () => {
  const grid = tileGrid(48.1486, 17.1077, 16)!
  expect(grid).toMatchObject({ z: 16, size: 3, tileSize: TILE_SIZE, width: 768, height: 768 })
  expect(grid.tiles).toHaveLength(9)
  expect(grid.tiles[0]).toEqual({ z: 16, x: 35881, y: 22739 })
  expect(grid.tiles[4]).toEqual({ z: 16, x: 35882, y: 22740 })
  expect(grid.tiles[8]).toEqual({ z: 16, x: 35883, y: 22741 })
  // The point is inside the centre tile, so one tile's width/height in plus the fraction.
  expect(grid.pointX).toBeCloseTo(TILE_SIZE + 92.606, 2)
  expect(grid.pointY).toBeCloseTo(TILE_SIZE + 197.549, 2)
})

test('tileGrid: the point is always at least a half-container away from the grid edge', () => {
  // Why a 3x3 grid can be cropped to 512x512 around the point without ever showing a gap.
  for (const [lat, lon] of [[48.1486, 17.1077], [48.9, 18.0], [0.0001, 0.0001], [-33.9, 151.2]]) {
    const grid = tileGrid(lat!, lon!, 16)!
    expect(grid.pointX).toBeGreaterThanOrEqual(TILE_SIZE)
    expect(grid.pointX).toBeLessThanOrEqual(2 * TILE_SIZE)
    expect(grid.pointY).toBeGreaterThanOrEqual(TILE_SIZE)
    expect(grid.pointY).toBeLessThanOrEqual(2 * TILE_SIZE)
  }
})

test('tileGrid: a 5x5 grid keeps the centre tile in the middle', () => {
  const grid = tileGrid(48.1486, 17.1077, 16, 5)!
  expect(grid.tiles).toHaveLength(25)
  expect(grid.tiles[0]).toEqual({ z: 16, x: 35880, y: 22738 })
  expect(grid.tiles[12]).toEqual({ z: 16, x: 35882, y: 22740 })
  expect(grid.pointX).toBeCloseTo(2 * TILE_SIZE + 92.606, 2)
})

test('tileGrid: refuses coordinates it cannot place, and grids that would run off the world', () => {
  expect(tileGrid(Number.NaN, 17, 16)).toBeUndefined()
  expect(tileGrid(48.1, Number.POSITIVE_INFINITY, 16)).toBeUndefined()
  expect(tileGrid(91, 17, 16)).toBeUndefined()
  expect(tileGrid(48.1, 181, 16)).toBeUndefined()
  expect(tileGrid(48.1, 17, -1)).toBeUndefined()
  expect(tileGrid(48.1, 17, MAX_ZOOM + 1)).toBeUndefined()
  // Beyond the Mercator limit, and right at the antimeridian / the poles, where a neighbour tile
  // would be outside [0, 2**z): no map rather than a wrapped or clamped one.
  expect(tileGrid(86, 17, 16)).toBeUndefined()
  expect(tileGrid(48.1, 179.999, 16)).toBeUndefined()
  expect(tileGrid(MERCATOR_TOP, 17, 16)).toBeUndefined()
  // Zoom 0 has a single tile, so a 3x3 grid can never be built there.
  expect(tileGrid(0, 0, 0)).toBeUndefined()
})

test('parseTile: accepts canonical integers in range', () => {
  expect(parseTile('16', '35882', '22740')).toEqual({ z: 16, x: 35882, y: 22740 })
  expect(parseTile('0', '0', '0')).toEqual({ z: 0, x: 0, y: 0 })
  expect(parseTile('19', '524287', '524287')).toEqual({ z: 19, x: 524287, y: 524287 })
})

test('parseTile: rejects anything that is not a bare in-range integer', () => {
  const bad = [
    ['16', '../../etc/passwd', '22740'],
    ['16', '35882', '../../secret'],
    ['16', '35882', '22740/../../x'],
    ['..', '..', '..'],
    ['-1', '0', '0'],
    ['16', '-5', '0'],
    ['16', '0', '-5'],
    ['1e2', '0', '0'],
    ['16', '0x10', '0'],
    ['16', '1.5', '0'],
    ['16', ' 1', '0'],
    ['016', '0', '0'],          // leading zeros are not canonical: one path per tile, one cache entry
    ['16', '00', '0'],
    ['', '', ''],
    ['20', '0', '0'],           // above MAX_ZOOM
    ['99', '0', '0'],
    ['16', '65536', '0'],       // 2**16 is one past the last tile
    ['16', '0', '65536'],
    ['0', '1', '0'],            // zoom 0 has exactly one tile
  ]
  for (const [z, x, y] of bad) expect(parseTile(z!, x!, y!), `${z}/${x}/${y}`).toBeUndefined()
})
