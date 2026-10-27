import { expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPoll } from '../src/core/poll.js'
import { getGeocode, recordGeocode } from '../src/db/geocode-cache.js'
import { getParcel, updateParcelState } from '../src/db/parcels.js'
import { cachedGrid, MAX_GEOCODES_PER_RUN, MAX_TILE_POINTS_PER_RUN } from '../src/core/map-preview.js'
import { GRID_SIZE, hasTile, readTile, storeTile, TILE_ZOOM, tileDirFor, tilePath, tileUrl } from '../src/core/tiles.js'
import { tileGrid } from '../src/core/slippy.js'
import type { BinaryFetch } from '../src/core/http.js'
import type { Database } from '../src/db/index.js'
import type { HttpClient, PickupPoint } from '../src/core/types.js'
import { addParcel, config, failResult, memDb, NOW, stubAdapter } from './poll-helpers.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The shape of a real Slovenská pošta pickup point: a full postal address and no coordinates. */
const POST: PickupPoint = {
  kind: 'post_office', name: 'Pošta Bratislava 1', street: 'Nám. SNP 35', city: 'Bratislava', postalCode: '81101',
}
const QUERY = 'nám. snp 35, 81101 bratislava'
const LAT = 48.1448231
const LON = 17.119207
const FOUND = JSON.stringify([{ lat: String(LAT), lon: String(LON) }])

/** The eight-byte PNG signature, which is all `storeTile` is asked to recognise. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

const tmpTiles = () => mkdtempSync(join(tmpdir(), 'parcels-tiles-'))

interface Fakes {
  http: HttpClient
  fetchBytes: BinaryFetch
  sleep: (ms: number) => Promise<void>
  /** The decoded `q` of every Nominatim search, in order. */
  searches: string[]
  tileUrls: string[]
  sleeps: number[]
  /** Every outbound call and every wait, interleaved: `search`, `tile`, `sleep:<ms>`. */
  timeline: string[]
}

/**
 * Every outbound call the map step could make, faked. Anything that is not a Nominatim search throws,
 * so a request to a host this feature was never meant to touch fails the test rather than going out.
 */
function fakes(o: {
  reply?: (q: string) => { status: number; body: string } | Error
  tile?: (url: string) => { status: number; bytes: Uint8Array } | Error
} = {}): Fakes {
  const searches: string[] = []
  const tileUrls: string[] = []
  const sleeps: number[] = []
  const timeline: string[] = []
  const reply = o.reply ?? (() => ({ status: 200, body: FOUND }))
  const tile = o.tile ?? (() => ({ status: 200, bytes: PNG }))
  return {
    searches,
    tileUrls,
    sleeps,
    timeline,
    sleep: async ms => { sleeps.push(ms); timeline.push(`sleep:${ms}`) },
    http: async (url, init) => {
      const u = new URL(url)
      if (u.host !== 'nominatim.openstreetmap.org') throw new Error(`unexpected request to ${u.host}`)
      const q = u.searchParams.get('q') ?? ''
      searches.push(q)
      timeline.push('search')
      const r = reply(q)
      if (r instanceof Error) throw r
      void init
      return { status: r.status, headers: {}, text: async () => r.body, json: async <T>() => JSON.parse(r.body) as T }
    },
    fetchBytes: async url => {
      tileUrls.push(url)
      timeline.push('tile')
      const r = tile(url)
      if (r instanceof Error) throw r
      return r
    },
  }
}

/** `not_found` leaves the parcel's status and pickup columns exactly as they are, so the map step is what is under test. */
const inertCarrier = () => stubAdapter('posta', ins => ins.map(i => failResult(i.number, 'not_found')), 100)

function ready(db: Database, number: string, pickup: PickupPoint = POST): number {
  const id = addParcel(db, 'posta', number)
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup })
  return id
}

const poll = (db: Database, f: Fakes, o: { now?: Date; tileDir?: string; enabled?: boolean } = {}) =>
  runPoll({
    db,
    http: f.http,
    adapters: [inertCarrier()],
    config: o.enabled === false ? { ...config, mapPreview: false } : config,
    now: o.now ?? NOW,
    mapPreview: { tileDir: o.tileDir ?? tmpTiles(), fetchBytes: f.fetchBytes, sleep: f.sleep },
  })

// --- geocoding -------------------------------------------------------------------------------------

test('a ready-for-pickup parcel with an address is geocoded, and the coordinates land on the parcel', async () => {
  const db = memDb()
  const id = ready(db, 'RA000000001SK')
  const f = fakes()
  await poll(db, f)
  expect(f.searches).toEqual([QUERY])
  expect(getParcel(db, id)!.pickup).toMatchObject({ lat: LAT, lon: LON })
  expect(getGeocode(db, QUERY)).toMatchObject({ outcome: 'found', lat: LAT, lon: LON })
})

test('a second parcel at the same pickup address costs no second lookup', async () => {
  const db = memDb()
  ready(db, 'RA000000001SK')
  const f = fakes()
  await poll(db, f)
  expect(f.searches).toHaveLength(1)

  // Same Z-BOX, typed slightly differently by the carrier: the normalised query is the same key.
  const second = ready(db, 'RA000000002SK', { ...POST, city: 'BRATISLAVA', street: ' Nám. SNP 35 ' })
  await poll(db, f)
  expect(f.searches).toHaveLength(1)                     // still one, for both parcels
  expect(getParcel(db, second)!.pickup).toMatchObject({ lat: LAT, lon: LON })
})

test('a found address is never looked up again, even after the carrier overwrites the coordinates', async () => {
  const db = memDb()
  const id = ready(db, 'RA000000001SK')
  const f = fakes()
  await poll(db, f)
  // A fresh carrier answer replaces the pickup point wholesale, and no carrier but Packeta sends lat/lon.
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup: POST })
  expect(getParcel(db, id)!.pickup!.lat).toBeUndefined()
  await poll(db, f)
  expect(f.searches).toHaveLength(1)
  expect(getParcel(db, id)!.pickup).toMatchObject({ lat: LAT, lon: LON })
})

test('a not-found address is recorded and not asked about again on the next poll', async () => {
  const db = memDb()
  const id = ready(db, 'RA000000001SK')
  const f = fakes({ reply: () => ({ status: 200, body: '[]' }) })
  await poll(db, f)
  expect(f.searches).toEqual([QUERY])
  expect(getGeocode(db, QUERY)).toMatchObject({ outcome: 'not_found', attempts: 1 })
  expect(getParcel(db, id)!.pickup!.lat).toBeUndefined()

  await poll(db, f, { now: new Date(NOW.getTime() + HOUR) })
  await poll(db, f, { now: new Date(NOW.getTime() + DAY) })
  await poll(db, f, { now: new Date(NOW.getTime() + 29 * DAY) })
  expect(f.searches).toHaveLength(1)
  expect(getGeocode(db, QUERY)).toMatchObject({ attempts: 1 })   // no further attempts were even made

  await poll(db, f, { now: new Date(NOW.getTime() + 31 * DAY) })
  expect(f.searches).toHaveLength(2)
})

test('a transport error backs off and is retried once its window has elapsed', async () => {
  const db = memDb()
  ready(db, 'RA000000001SK')
  const f = fakes({ reply: () => new Error('connection refused') })
  await poll(db, f)
  expect(getGeocode(db, QUERY)).toMatchObject({ outcome: 'error', attempts: 1 })

  await poll(db, f, { now: new Date(NOW.getTime() + HOUR / 2) })
  expect(f.searches).toHaveLength(1)
  await poll(db, f, { now: new Date(NOW.getTime() + HOUR) })
  expect(f.searches).toHaveLength(2)
  expect(getGeocode(db, QUERY)).toMatchObject({ outcome: 'error', attempts: 2 })
  // Now the window is two hours, so an hour later is still too soon.
  await poll(db, f, { now: new Date(NOW.getTime() + 2 * HOUR) })
  expect(f.searches).toHaveLength(2)
})

test('a failing geocode never fails the poll run', async () => {
  const db = memDb()
  ready(db, 'RA000000001SK')
  const f = fakes({ reply: () => new Error('connection refused') })
  const report = await poll(db, f)
  expect(report.failures).toEqual([])
  expect(report.polled).toBe(1)
})

test('parcels with nothing to geocode are left alone', async () => {
  const db = memDb()
  const noCity = ready(db, 'RA000000001SK', { kind: 'zbox', name: 'Z-BOX Bratislava, Hlavna 6' })
  const notReady = addParcel(db, 'posta', 'RA000000002SK')
  updateParcelState(db, notReady, { status: 'in_transit', pickup: POST })
  const already = ready(db, 'RA000000003SK', { ...POST, lat: 1.5, lon: 2.5 })
  const f = fakes()
  await poll(db, f)
  expect(f.searches).toEqual([])
  expect(getParcel(db, noCity)!.pickup!.lat).toBeUndefined()
  expect(getParcel(db, notReady)!.pickup!.lat).toBeUndefined()
  expect(getParcel(db, already)!.pickup).toMatchObject({ lat: 1.5, lon: 2.5 })
})

/** The longest run of `timeline` entries between consecutive entries of `kind`, as waited milliseconds. */
function waitsBetween(timeline: string[], kind: string): number[] {
  const out: number[] = []
  let waited: number | undefined
  for (const e of timeline) {
    if (e === kind) {
      if (waited !== undefined) out.push(waited)
      waited = 0
    } else if (waited !== undefined && e.startsWith('sleep:')) {
      waited += Number(e.slice('sleep:'.length))
    }
  }
  return out
}

test('only a handful of addresses are looked up in one run; the rest wait for the next poll', async () => {
  const db = memDb()
  const offered = MAX_GEOCODES_PER_RUN + 3
  for (let i = 0; i < offered; i++) ready(db, `RA00000000${i}SK`, { ...POST, street: `Street ${i}` })
  const f = fakes()
  await poll(db, f)
  // The cap itself has to stay small: this is a free service and the poller runs every hour.
  expect(MAX_GEOCODES_PER_RUN).toBeLessThanOrEqual(10)
  expect(MAX_TILE_POINTS_PER_RUN).toBeLessThanOrEqual(10)
  expect(f.searches).toHaveLength(MAX_GEOCODES_PER_RUN)
  expect(f.searches.length).toBeLessThan(offered)

  // The ones that were skipped are not recorded as failures, so the next run tries them untouched.
  expect(db.prepare('SELECT count(*) AS n FROM geocode_cache').get()).toEqual({ n: MAX_GEOCODES_PER_RUN })
  await poll(db, f)
  expect(f.searches).toHaveLength(offered)
})

test('searches are at least a second apart, which is the limit Nominatim publishes', async () => {
  const db = memDb()
  for (let i = 0; i < 3; i++) ready(db, `RA00000000${i}SK`, { ...POST, street: `Street ${i}` })
  const f = fakes()
  await poll(db, f)
  expect(f.searches).toHaveLength(3)
  const waits = waitsBetween(f.timeline, 'search')
  expect(waits).toHaveLength(2)
  for (const ms of waits) expect(ms).toBeGreaterThanOrEqual(900)
})

test('tile requests are spaced out too, so nine of them are not nine at once', async () => {
  const db = memDb()
  ready(db, 'RA000000001SK', { ...POST, lat: LAT, lon: LON })
  const f = fakes()
  await poll(db, f)
  const waits = waitsBetween(f.timeline, 'tile')
  expect(waits).toHaveLength(GRID_SIZE * GRID_SIZE - 1)
  for (const ms of waits) expect(ms).toBeGreaterThan(0)
})

// --- tiles -----------------------------------------------------------------------------------------

test('the tiles around the point are fetched once and stored 0600 under 0700 directories', async () => {
  const db = memDb()
  ready(db, 'RA000000001SK')
  const dir = tmpTiles()
  const f = fakes()
  await poll(db, f, { tileDir: dir })

  const grid = tileGrid(LAT, LON, TILE_ZOOM)!
  expect(grid.tiles).toHaveLength(GRID_SIZE * GRID_SIZE)
  expect(f.tileUrls.sort()).toEqual(grid.tiles.map(tileUrl).sort())
  for (const t of grid.tiles) {
    expect(hasTile(dir, t)).toBe(true)
    const path = tilePath(dir, t)
    expect(readFileSync(path)).toEqual(Buffer.from(PNG))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, String(t.z))).mode & 0o777).toBe(0o700)
  }

  await poll(db, f, { tileDir: dir })
  expect(f.tileUrls).toHaveLength(GRID_SIZE * GRID_SIZE)   // nothing refetched
})

test('tile fetching is capped per run and paced, and a failure costs nothing but that tile', async () => {
  const db = memDb()
  for (let i = 0; i < MAX_TILE_POINTS_PER_RUN + 2; i++) {
    const id = ready(db, `RA00000000${i}SK`, { ...POST, lat: 48.1 + i / 10, lon: 17.1 })
    expect(getParcel(db, id)!.pickup!.lat).toBeDefined()
  }
  const dir = tmpTiles()
  let n = 0
  const f = fakes({ tile: () => (n++ % 4 === 0 ? new Error('502') : { status: 200, bytes: PNG }) })
  await poll(db, f, { tileDir: dir })
  expect(f.tileUrls).toHaveLength(MAX_TILE_POINTS_PER_RUN * GRID_SIZE * GRID_SIZE)
  expect(f.searches).toEqual([])
})

test('a body that is not a PNG is never stored as a tile', async () => {
  const db = memDb()
  ready(db, 'RA000000001SK')
  const dir = tmpTiles()
  const html = new TextEncoder().encode('<html>rate limited</html>')
  const f = fakes({ tile: () => ({ status: 200, bytes: html }) })
  await poll(db, f, { tileDir: dir })
  const grid = tileGrid(LAT, LON, TILE_ZOOM)!
  for (const t of grid.tiles) expect(hasTile(dir, t)).toBe(false)
  expect(cachedGrid(dir, LAT, LON)).toBeUndefined()
})

test('a non-200 tile response is not stored either', async () => {
  const db = memDb()
  ready(db, 'RA000000001SK')
  const dir = tmpTiles()
  const f = fakes({ tile: () => ({ status: 404, bytes: PNG }) })
  await poll(db, f, { tileDir: dir })
  expect(cachedGrid(dir, LAT, LON)).toBeUndefined()
})

// --- cachedGrid: what the page is allowed to render ------------------------------------------------

test('cachedGrid returns the grid only when every tile is already on disk', async () => {
  const db = memDb()
  ready(db, 'RA000000001SK')
  const dir = tmpTiles()
  expect(cachedGrid(dir, LAT, LON)).toBeUndefined()
  await poll(db, fakes(), { tileDir: dir })
  const grid = cachedGrid(dir, LAT, LON)!
  expect(grid.tiles).toEqual(tileGrid(LAT, LON, TILE_ZOOM)!.tiles)

  // One tile missing is a broken map, so there is no map.
  rmSync(tilePath(dir, grid.tiles[0]!))
  expect(cachedGrid(dir, LAT, LON)).toBeUndefined()
})

test('cachedGrid refuses coordinates it cannot place', () => {
  const dir = tmpTiles()
  expect(cachedGrid(dir, Number.NaN, 17)).toBeUndefined()
  expect(cachedGrid(dir, 48.1, 999)).toBeUndefined()
})

// --- the opt-out -----------------------------------------------------------------------------------

test('with mapPreview off the poll makes no geocode and no tile request at all', async () => {
  const db = memDb()
  const id = ready(db, 'RA000000001SK')
  const dir = tmpTiles()
  const f = fakes({
    reply: () => new Error('the map preview is off; nothing should be requested'),
    tile: () => new Error('the map preview is off; nothing should be requested'),
  })
  const report = await poll(db, f, { tileDir: dir, enabled: false })
  expect(report.failures).toEqual([])
  expect(f.searches).toEqual([])
  expect(f.tileUrls).toEqual([])
  expect(getParcel(db, id)!.pickup!.lat).toBeUndefined()
  expect(db.prepare('SELECT count(*) AS n FROM geocode_cache').get()).toEqual({ n: 0 })
})

test('with the preview off even an already cached geocode is not applied to a parcel', async () => {
  const db = memDb()
  const id = ready(db, 'RA000000001SK')
  recordGeocode(db, QUERY, { outcome: 'found', lat: LAT, lon: LON }, NOW)
  const f = fakes({ reply: () => new Error('nothing should be requested') })
  await poll(db, f, { enabled: false })
  expect(getParcel(db, id)!.pickup!.lat).toBeUndefined()
})

// --- the tile directory ----------------------------------------------------------------------------

test('tileDirFor puts the cache beside the database, like data/mail', () => {
  expect(tileDirFor('/Users/x/parcels/data/parcels.db')).toBe('/Users/x/parcels/data/tiles')
})

test('tilePath is built from the parsed numbers, one directory per zoom and column', () => {
  expect(tilePath('/d', { z: 16, x: 35882, y: 22740 })).toBe('/d/16/35882/22740.png')
})

test('tileUrl points at the OpenStreetMap tile server and nowhere else', () => {
  expect(tileUrl({ z: 16, x: 35882, y: 22740 })).toBe('https://tile.openstreetmap.org/16/35882/22740.png')
})

test('storeTile refuses a body that is not a PNG, and a tile that is not a tile', () => {
  const dir = tmpTiles()
  const t = { z: 16, x: 35882, y: 22740 }
  // A free tile server under load answers with an HTML error page and a 200; caching it would leave a
  // broken image on the page for ever, because nothing refetches a tile that is already on disk.
  expect(storeTile(dir, t, new TextEncoder().encode('<html>rate limited</html>'))).toBe(false)
  expect(storeTile(dir, t, PNG.slice(0, 4))).toBe(false)
  expect(hasTile(dir, t)).toBe(false)
  expect(storeTile(dir, { z: 16, x: -1, y: 0 }, PNG)).toBe(false)
  expect(storeTile(dir, { z: 99, x: 0, y: 0 }, PNG)).toBe(false)
  expect(storeTile(dir, t, PNG)).toBe(true)
  expect(hasTile(dir, t)).toBe(true)
})

test('readTile reads only real tiles, and never leaves the cache directory', () => {
  const dir = tmpTiles()
  const t = { z: 16, x: 35882, y: 22740 }
  expect(readTile(dir, t)).toBeUndefined()
  storeTile(dir, t, PNG)
  expect(readTile(dir, t)).toEqual(Buffer.from(PNG))
  expect(readTile(dir, { z: 16, x: 65536, y: 0 })).toBeUndefined()
  expect(readTile(dir, { z: 16, x: 1.5, y: 0 })).toBeUndefined()
})
