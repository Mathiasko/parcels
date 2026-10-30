import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'

// The menu-bar icon is app/assets/trayTemplate.png (+ @2x), drawn by scripts/app/make-tray-icon.py
// and committed. macOS tints a template image, so only alpha may carry the drawing. These tests read
// the committed files; nothing here runs the script.
const ASSETS = fileURLToPath(new URL('../../app/assets/', import.meta.url))

/** Decodes an 8-bit RGBA, non-interlaced PNG whose scanlines all use filter 0 (what the script writes). */
function decode(file: string) {
  const buf = readFileSync(`${ASSETS}${file}`)
  expect(buf.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n')
  expect(buf.subarray(12, 16).toString('latin1')).toBe('IHDR')
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const [depth, colourType, , , interlace] = [buf[24], buf[25], buf[26], buf[27], buf[28]]
  let at = 8
  const idat: Buffer[] = []
  while (at < buf.length) {
    const len = buf.readUInt32BE(at)
    if (buf.subarray(at + 4, at + 8).toString('latin1') === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len))
    at += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = 1 + width * 4
  expect(raw.length).toBe(stride * height)
  const px: { r: number, g: number, b: number, a: number }[][] = []
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride], `scanline ${y} filter`).toBe(0)
    const row = []
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 4
      row.push({ r: raw[o], g: raw[o + 1], b: raw[o + 2], a: raw[o + 3] })
    }
    px.push(row)
  }
  return { width, height, depth, colourType, interlace, px }
}

describe.each([['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]] as const)('%s', (file, size) => {
  const img = decode(file)

  test(`is ${size}x${size}, 8-bit RGBA, not interlaced`, () => {
    expect([img.width, img.height]).toEqual([size, size])
    expect([img.depth, img.colourType, img.interlace]).toEqual([8, 6, 0])
  })

  test('is a template image: every pixel fully on or off, and every ink pixel black', () => {
    for (const p of img.px.flat()) {
      expect([0, 255]).toContain(p.a)
      if (p.a === 255) expect([p.r, p.g, p.b]).toEqual([0, 0, 0])
    }
  })

  test('draws a stamp: a perforated edge in dashes, a solid picture inside, a clear margin', () => {
    const ink = (x: number, y: number) => img.px[y][x].a === 255
    const all = img.px.flat().filter((p) => p.a === 255).length
    expect(all).toBeGreaterThan(size * size * 0.2)
    expect(all).toBeLessThan(size * size * 0.6)
    expect(ink(size / 2, size / 2)).toBe(true)
    // Nothing on the canvas's outermost ring.
    for (let i = 0; i < size; i++) {
      expect([ink(i, 0), ink(i, size - 1), ink(0, i), ink(size - 1, i)]).toEqual([false, false, false, false])
    }
    // The top edge of the stamp (the first row with ink) is dashed: at least five separate dashes.
    const rows = img.px.map((row) => row.map((p) => p.a === 255))
    const edge = rows.find((r) => r.some(Boolean))!
    const dashes = edge.reduce((n, on, x) => n + (on && !edge[x - 1] ? 1 : 0), 0)
    expect(dashes).toBeGreaterThanOrEqual(5)
  })
})
