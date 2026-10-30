import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

// The app's icon is build/icon.icns, made from assets/icon/*.svg by scripts/app/make-app-icon.mjs
// (headless Chrome and iconutil, run by hand) and committed. These tests only read the committed
// files: nothing here runs Chrome, iconutil or the network.
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ICNS = `${ROOT}build/icon.icns`
const ELECTRON_ICNS = `${ROOT}node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns`

/** The pixel size each PNG-carrying icns type holds (Apple's icns types). */
const PNG_TYPES: Record<string, number> = {
  icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512,
}
/** The bitmap types that also stand for 16 and 32 px: today's iconutil writes icon_16x16.png and
 *  icon_32x32.png as ic04 and ic05 (`ARGB`, run-length coded); older ones wrote icp4/icp5 or is32/il32. */
const BITMAP_SIZE: Record<string, number> = { ic04: 16, ic05: 32, is32: 16, il32: 32 }

type Chunk = { type: string, data: Buffer }

/** Walks the icns file's table of chunks: a 4-byte `icns` magic and a big-endian total length, then
 *  type/length/data chunks that must tile the rest of the file exactly. (Older iconutils also wrote a
 *  `TOC ` chunk listing the others; today's writes none, so the chunks themselves are the table.) */
function parseIcns(buf: Buffer): Chunk[] {
  expect(buf.subarray(0, 4).toString('latin1')).toBe('icns')
  expect(buf.readUInt32BE(4)).toBe(buf.length)
  const chunks: Chunk[] = []
  let at = 8
  while (at < buf.length) {
    expect(at + 8, `a chunk header at ${at} runs past the end`).toBeLessThanOrEqual(buf.length)
    const type = buf.subarray(at, at + 4).toString('latin1')
    const len = buf.readUInt32BE(at + 4)
    expect(len, `chunk ${type} at ${at}`).toBeGreaterThanOrEqual(8)
    expect(at + len, `chunk ${type} at ${at} runs past the end`).toBeLessThanOrEqual(buf.length)
    chunks.push({ type, data: buf.subarray(at + 8, at + len) })
    at += len
  }
  expect(at).toBe(buf.length)
  return chunks
}

/** A PNG's width, height and colour type, from its IHDR. */
function pngHeader(data: Buffer) {
  expect(data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
  expect(data.subarray(12, 16).toString('latin1')).toBe('IHDR')
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colourType: data[25] }
}

/** An ic04/ic05 bitmap: `ARGB`, then the A, R, G and B planes one after another, each run-length coded
 *  (a byte below 0x80 is followed by that many plus one literal bytes; one from 0x80 repeats the next
 *  byte that many minus 125 times). Returns the planes, or throws if they do not decode to size² each. */
function argbPlanes(data: Buffer, size: number): Buffer[] {
  expect(data.subarray(0, 4).toString('latin1')).toBe('ARGB')
  const out: number[] = []
  let at = 4
  while (out.length < 4 * size * size) {
    if (at >= data.length) throw new Error(`the ARGB data ends after ${out.length} of ${4 * size * size} bytes`)
    const n = data[at++]!
    if (n < 0x80) { for (let i = 0; i <= n; i++) out.push(data[at++]!) } else { const v = data[at++]!; for (let i = 0; i < n - 125; i++) out.push(v) }
  }
  expect(out.length, 'no plane runs over its size').toBe(4 * size * size)
  expect(at, 'nothing is left after the four planes').toBe(data.length)
  const planes = Buffer.from(out)
  return [0, 1, 2, 3].map(p => planes.subarray(p * size * size, (p + 1) * size * size))
}

describe('build/icon.icns', () => {
  test('is a whole icns file', () => {
    expect(parseIcns(readFileSync(ICNS)).length).toBeGreaterThan(0)
  })

  test('holds the 16, 32 and 1024 px representations', () => {
    const sizes = new Set<number>()
    for (const c of parseIcns(readFileSync(ICNS))) {
      if (c.type in BITMAP_SIZE) sizes.add(BITMAP_SIZE[c.type]!)
      if (c.type in PNG_TYPES) sizes.add(PNG_TYPES[c.type]!)
    }
    expect(sizes.has(16), '16 px (ic04, icp4 or is32)').toBe(true)
    expect(sizes.has(32), '32 px (ic05, icp5, il32 or ic11)').toBe(true)
    expect(sizes.has(1024), '1024 px (ic10)').toBe(true)
  })

  test('fills all ten iconset slots, each a transparent image of its own size', () => {
    const chunks = parseIcns(readFileSync(ICNS))
    const types = chunks.map(c => c.type)
    // icon_16x16.png and icon_32x32.png: a PNG or an ARGB bitmap, as iconutil chooses.
    expect(types.filter(t => t === 'ic04' || t === 'icp4'), 'icon_16x16').toHaveLength(1)
    expect(types.filter(t => t === 'ic05' || t === 'icp5'), 'icon_32x32').toHaveLength(1)
    // The other eight are always PNGs: 16@2x, 32@2x, 128, 128@2x, 256, 256@2x, 512, 512@2x.
    expect(types.filter(t => /^ic(0[789]|1[0-4])$/.test(t)).sort()).toEqual(['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14'])
    for (const c of chunks) {
      if (c.type in PNG_TYPES) {
        const h = pngHeader(c.data)
        expect({ type: c.type, width: h.width, height: h.height }).toEqual({ type: c.type, width: PNG_TYPES[c.type], height: PNG_TYPES[c.type] })
        expect(h.colourType, `${c.type} has an alpha channel (6 is RGBA)`).toBe(6)
      } else if (c.type === 'ic04' || c.type === 'ic05') {
        const size = BITMAP_SIZE[c.type]!
        const [alpha] = argbPlanes(c.data, size)
        // The macOS grid's margin is transparent at the corner; the middle of the tile is opaque.
        expect(alpha![0], `${c.type}'s corner is transparent`).toBe(0)
        expect(alpha![(size / 2) * size + size / 2], `${c.type}'s middle is opaque`).toBe(255)
      }
    }
  })

  test("is not Electron's default icon", () => {
    expect(existsSync(ELECTRON_ICNS)).toBe(true)
    expect(readFileSync(ICNS).equals(readFileSync(ELECTRON_ICNS))).toBe(false)
  })

  test('is not ignored by git, so the commit carries it', () => {
    const r = spawnSync('git', ['check-ignore', '-q', 'build/icon.icns'], { cwd: ROOT })
    expect(r.status, 'git check-ignore exits 1 for a file it does not ignore').toBe(1)
  })
})

describe('the icon sources and the packaging', () => {
  test('electron-builder.yml names build/icon.icns as the Mac icon', () => {
    const yml = readFileSync(`${ROOT}electron-builder.yml`, 'utf8')
    const mac = /^mac:\n((?:[ \t].*\n|\n)*)/m.exec(yml)?.[1] ?? ''
    expect(mac).toMatch(/^ {2}icon: build\/icon\.icns\s*$/m)
  })

  test('the SVGs are 1024-unit drawings with fixed colours and no outside references', () => {
    for (const name of ['app-icon.svg', 'app-icon-small.svg']) {
      const svg = readFileSync(`${ROOT}assets/icon/${name}`, 'utf8')
      expect(svg, name).toMatch(/<svg[^>]* viewBox="0 0 1024 1024"/)
      expect(svg, `${name}: the icon does not follow the theme`).not.toMatch(/currentColor|var\(/)
      expect(svg, `${name}: no fetch while rendering`).not.toMatch(/(?:href|src)="(?!#)|url\((?!#)/)
      // The board's colours: the blue tile, the cream stamp, the yellow inside, the red postmark.
      for (const hex of ['#23468c', '#fbf6ea', '#f6c21c', '#b3261e']) expect(svg, `${name} has ${hex}`).toContain(hex)
    }
  })
})
