import { describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer, type WebDeps } from '../src/web/server.js'
import { appendEvents } from '../src/db/events.js'
import { insertParcel, updateParcelState } from '../src/db/parcels.js'
import { storeTile, TILE_ZOOM, tilePath } from '../src/core/tiles.js'
import { tileGrid } from '../src/core/slippy.js'
import type { Database } from '../src/db/index.js'
import type { PickupPoint } from '../src/core/types.js'
import { config, ev, memDb, NOW } from './poll-helpers.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

const LAT = 48.1486
const LON = 17.1077
const POST: PickupPoint = {
  kind: 'post_office', name: 'Pošta Bratislava 1', street: 'Nám. SNP 35', city: 'Bratislava', postalCode: '81101',
  lat: LAT, lon: LON,
}

const tmpTiles = () => mkdtempSync(join(tmpdir(), 'parcels-web-tiles-'))

/** Lays down every tile of the 3x3 grid around the point, which is what lets the page draw a map. */
function cacheTiles(dir: string, lat = LAT, lon = LON): void {
  for (const t of tileGrid(lat, lon, TILE_ZOOM)!.tiles) storeTile(dir, t, PNG)
}

function readyParcel(db: Database, pickup: PickupPoint = POST): number {
  const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RA000000001SK', label: 'Shoes', source: 'manual' })
  appendEvents(db, id, [ev('x', 'ready_for_pickup')])
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup })
  return id
}

const server = (db: Database, extra: Partial<WebDeps> = {}) => buildServer({ db, config, now: () => NOW, ...extra })
const get = (db: Database, url: string, extra: Partial<WebDeps> = {}) =>
  server(db, extra).inject({ method: 'GET', url })

describe('the tile route', () => {
  test('serves a cached tile as a PNG from this server', async () => {
    const db = memDb()
    const dir = tmpTiles()
    storeTile(dir, { z: 16, x: 35882, y: 22740 }, PNG)
    const res = await get(db, '/tile/16/35882/22740.png', { tileDir: dir })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(new Uint8Array(res.rawPayload)).toEqual(PNG)
  })

  test('a tile that is not in the cache is a 404, never a fetch', async () => {
    const res = await get(memDb(), '/tile/16/35882/22740.png', { tileDir: tmpTiles() })
    expect(res.statusCode).toBe(404)
  })

  test('refuses to read anything outside the cache: traversal in any parameter is a 404', async () => {
    const db = memDb()
    const dir = tmpTiles()
    storeTile(dir, { z: 16, x: 35882, y: 22740 }, PNG)
    // A readable PNG just outside the per-zoom directory, so a traversal that worked would be visible.
    writeFileSync(join(dir, 'secret.png'), PNG)
    writeFileSync(join(dir, '16', 'secret.png'), PNG)
    const paths = [
      '/tile/16/%2e%2e%2f%2e%2e%2fetc%2fpasswd/22740.png',
      '/tile/16/35882/%2e%2e%2f%2e%2e%2fsecret.png',
      '/tile/16/35882/%2e%2e%2fsecret.png',
      '/tile/%2e%2e/%2e%2e/0.png',
      '/tile/16/35882/..%2fsecret.png',
      '/tile/16/..%2f..%2f..%2f..%2fetc%2fhosts/0.png',
    ]
    for (const p of paths) {
      const res = await get(db, p, { tileDir: dir })
      expect(res.statusCode, p).toBe(404)
      expect(res.headers['content-type'], p).not.toContain('image/png')
      expect(res.rawPayload.includes(Buffer.from(PNG)), p).toBe(false)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test('refuses non-numeric, negative, non-canonical and out-of-range parameters', async () => {
    const db = memDb()
    const dir = tmpTiles()
    storeTile(dir, { z: 16, x: 35882, y: 22740 }, PNG)
    const bad = [
      '/tile/abc/0/0.png', '/tile/16/abc/0.png', '/tile/16/0/abc.png',
      '/tile/-1/0/0.png', '/tile/16/-5/0.png', '/tile/16/0/-5.png',
      '/tile/1e2/0/0.png', '/tile/16/0x10/0.png', '/tile/16/1.5/0.png',
      '/tile/016/35882/22740.png', '/tile/16/035882/22740.png',
      '/tile/20/0/0.png', '/tile/99/0/0.png', '/tile/16/65536/0.png', '/tile/16/0/65536.png',
      '/tile/0/1/0.png',
      '/tile/16/35882/22740.png.png',
      '/tile//0/0.png',
    ]
    for (const p of bad) expect((await get(db, p, { tileDir: dir })).statusCode, p).toBe(404)
    // and the canonical form still works, so the guard is not simply refusing everything
    expect((await get(db, '/tile/16/35882/22740.png', { tileDir: dir })).statusCode).toBe(200)
  })

  test('serves no tile at all when the map preview is turned off', async () => {
    const db = memDb()
    const dir = tmpTiles()
    storeTile(dir, { z: 16, x: 35882, y: 22740 }, PNG)
    const res = await get(db, '/tile/16/35882/22740.png', { tileDir: dir, config: { ...config, mapPreview: false } })
    expect(res.statusCode).toBe(404)
  })
})

describe('the map on the parcel page', () => {
  test('draws the grid of cached tiles, a marker and the OpenStreetMap credit', async () => {
    const db = memDb()
    const id = readyParcel(db)
    const dir = tmpTiles()
    cacheTiles(dir)
    const body = (await get(db, `/parcel/${id}`, { tileDir: dir })).body
    const grid = tileGrid(LAT, LON, TILE_ZOOM)!
    for (const t of grid.tiles) expect(body).toContain(`src="/tile/${t.z}/${t.x}/${t.y}.png"`)
    expect(body).toContain('class="map-pin"')
    expect(body).toContain('https://www.openstreetmap.org/copyright')
    expect(body).toContain('OpenStreetMap contributors')
    // The Apple Maps link is still there, upgraded to an exact pin by the same coordinates.
    expect(body).toMatch(/href="https:\/\/maps\.apple\.com\/\?[^"]*ll=48\.1486(,|%2C)17\.1077/)
  })

  test('centres the grid on the point: the offset is the pixel position inside the assembled tiles', async () => {
    const db = memDb()
    const id = readyParcel(db)
    const dir = tmpTiles()
    cacheTiles(dir)
    const body = (await get(db, `/parcel/${id}`, { tileDir: dir })).body
    const grid = tileGrid(LAT, LON, TILE_ZOOM)!
    expect(body).toContain(`left:calc(50% - ${Math.round(grid.pointX)}px)`)
    expect(body).toContain(`top:calc(50% - ${Math.round(grid.pointY)}px)`)
  })

  test('no tiles cached: no map, and the address link is still there', async () => {
    const db = memDb()
    const id = readyParcel(db)
    const body = (await get(db, `/parcel/${id}`, { tileDir: tmpTiles() })).body
    expect(body).not.toContain('/tile/')
    expect(body).not.toContain('openstreetmap.org')      // no map, so no credit either
    expect(body).toContain('Pošta Bratislava 1')
    expect(body).toContain('Open in Apple Maps')
  })

  test('one tile missing is no map rather than a hole in it', async () => {
    const db = memDb()
    const id = readyParcel(db)
    const dir = tmpTiles()
    cacheTiles(dir)
    rmSync(tilePath(dir, tileGrid(LAT, LON, TILE_ZOOM)!.tiles[4]!))
    const body = (await get(db, `/parcel/${id}`, { tileDir: dir })).body
    expect(body).not.toContain('/tile/')
    expect(body).toContain('Open in Apple Maps')
  })

  test('no coordinates: no map, and the maps link falls back to searching the address', async () => {
    const db = memDb()
    const id = readyParcel(db, { kind: 'post_office', name: 'Pošta Bratislava 1', street: 'Nám. SNP 35', city: 'Bratislava' })
    const dir = tmpTiles()
    cacheTiles(dir)
    const body = (await get(db, `/parcel/${id}`, { tileDir: dir })).body
    expect(body).not.toContain('/tile/')
    expect(body).toContain('maps.apple.com/?q=')
  })

  test('a parcel that is not waiting for collection gets no map, even with coordinates and tiles', async () => {
    const db = memDb()
    const id = readyParcel(db)
    updateParcelState(db, id, { status: 'in_transit', pickup: POST })
    const dir = tmpTiles()
    cacheTiles(dir)
    const body = (await get(db, `/parcel/${id}`, { tileDir: dir })).body
    expect(body).not.toContain('/tile/')
  })

  test('with the map preview turned off there is no map, whatever is on disk', async () => {
    const db = memDb()
    const id = readyParcel(db)
    const dir = tmpTiles()
    cacheTiles(dir)
    const body = (await get(db, `/parcel/${id}`, { tileDir: dir, config: { ...config, mapPreview: false } })).body
    expect(body).not.toContain('/tile/')
    expect(body).toContain('Open in Apple Maps')
  })

  test('the index page never draws a map: the pickup cards stay a list', async () => {
    const db = memDb()
    readyParcel(db)
    const dir = tmpTiles()
    cacheTiles(dir)
    const body = (await get(db, '/', { tileDir: dir })).body
    expect(body).not.toContain('/tile/')
  })
})

describe('the page makes no third-party request', () => {
  const bodyWithMap = async () => {
    const db = memDb()
    const id = readyParcel(db)
    const dir = tmpTiles()
    cacheTiles(dir)
    return (await get(db, `/parcel/${id}`, { tileDir: dir })).body
  }

  test('the policy gains img-src self and keeps default-src none, with no script-src and no third-party origin', async () => {
    const db = memDb()
    const id = readyParcel(db)
    const dir = tmpTiles()
    cacheTiles(dir)
    const res = await get(db, `/parcel/${id}`, { tileDir: dir })
    const csp = res.headers['content-security-policy'] as string
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("img-src 'self'")
    expect(csp).not.toMatch(/script-src/)
    expect(csp).not.toMatch(/https?:/)          // no third-party origin is allowed by the policy
    expect(csp).not.toMatch(/img-src[^;]*\*/)
    // every page carries it, including the tile itself
    expect((await get(db, '/tile/16/35882/22740.png', { tileDir: dir })).headers['content-security-policy']).toBe(csp)
  })

  test('every resource the page loads is same-origin and relative', async () => {
    const body = await bodyWithMap()
    const srcs = [...body.matchAll(/(?:src|srcset|poster)="([^"]*)"/g)].map(m => m[1]!)
    expect(srcs.length).toBeGreaterThan(0)
    for (const s of srcs) expect(s, s).toMatch(/^\/[^/]/)
    expect(body).not.toMatch(/<script/i)
    expect(body).not.toMatch(/url\(\s*['"]?https?:/i)
    expect(body).not.toMatch(/<link\b/i)
  })

  test('the only outside hostnames in the markup are the maps link and the OpenStreetMap credit', async () => {
    const body = await bodyWithMap()
    const hosts = new Set([...body.matchAll(/https?:\/\/([^/"'\s)]+)/g)].map(m => m[1]!))
    expect([...hosts].sort()).toEqual(['maps.apple.com', 'www.openstreetmap.org'])
    expect(body).not.toContain('tile.openstreetmap.org')
    expect(body).not.toContain('nominatim')
  })
})
