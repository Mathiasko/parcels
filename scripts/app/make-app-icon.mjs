#!/usr/bin/env node
// Makes the Mac app's icon, build/icon.icns, from the Postal stamp drawn in assets/icon/.
//
//   node scripts/app/make-app-icon.mjs [--png-dir DIR]
//
// Each size is rendered natively from its SVG by headless Chrome on a transparent background (no size
// is a downscale of another): 16 and 32 px from app-icon-small.svg, which has fewer, bigger
// perforations, a plain box for the parcel and a thicker postmark; 64 px and up from app-icon.svg,
// the mood board's drawing. The PNGs go into an icon.iconset in a temporary folder, and
// `iconutil -c icns` turns that into build/icon.icns, which is committed: electron-builder.yml's
// mac.icon points at it, and the build never runs this script. --png-dir also keeps a copy of each
// rendered size there as icon-<N>.png, for looking at.
//
// Chrome runs with its own throwaway profile per size, and offline: everything but loopback goes to
// a dead proxy and nothing resolves (the same flags as the persona simulator's shots). The SVGs fetch
// nothing anyway. Set CHROME to use another Chrome binary. Needs macOS (iconutil).
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const FULL = join(ROOT, 'assets/icon/app-icon.svg')
const SMALL = join(ROOT, 'assets/icon/app-icon-small.svg')
const OUT = join(ROOT, 'build/icon.icns')

/** The largest size drawn from the small variant; above it the board's full drawing holds up. */
const SMALL_MAX = 32
/** The iconset's ten slots, and the pixel size each holds. */
const SLOTS = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
]

/** Stops the run; the temporary folder is still removed, and the reason printed. */
const die = (why) => { throw new Error(why) }

const args = process.argv.slice(2)
let pngDir = null
if (args.length === 2 && args[0] === '--png-dir') pngDir = resolve(args[1])
else if (args.length !== 0) {
  console.error('usage: node scripts/app/make-app-icon.mjs [--png-dir DIR]')
  process.exit(2)
}
if (!existsSync(CHROME)) {
  console.error(`make-app-icon: there is no Chrome at ${CHROME} (set CHROME to another)`)
  process.exit(1)
}

/** A PNG's width, height and colour type, from its IHDR. */
function pngHeader(file) {
  const b = readFileSync(file)
  if (b.length < 26 || b.toString('latin1', 1, 4) !== 'PNG' || b.toString('latin1', 12, 16) !== 'IHDR') die(`${file} is not a PNG`)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colourType: b[25] }
}

const tmp = mkdtempSync(join(tmpdir(), 'parcels-app-icon-'))
try {
  const iconset = join(tmp, 'icon.iconset')
  mkdirSync(iconset)
  const rendered = new Map()
  for (const size of [...new Set(SLOTS.map(([, s]) => s))]) {
    const svg = readFileSync(size <= SMALL_MAX ? SMALL : FULL)
    // An <img> keeps the SVG an image: no script, no fetch; Chrome scales the 1024 viewBox to the size.
    const page = join(tmp, `icon-${size}.html`)
    writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}img{display:block}</style></head>'
      + `<body><img width="${size}" height="${size}" alt="" src="data:image/svg+xml;base64,${svg.toString('base64')}"></body></html>`)
    const png = join(tmp, `icon-${size}.png`)
    const r = spawnSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(tmp, `profile-${size}`)}`, '--disable-background-networking', '--disable-component-update',
      '--disable-sync', '--disable-extensions', '--disable-default-apps', '--metrics-recording-only', '--no-pings',
      '--disable-breakpad', '--disable-crash-reporter',
      '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1',
      '--default-background-color=00000000', '--force-device-scale-factor=1',
      `--window-size=${size},${size}`, `--screenshot=${png}`, `file://${page}`,
    ], { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' })
    if (!existsSync(png)) die(`Chrome wrote no ${size} px PNG (${r.error?.message ?? `exit ${r.status}`}): ${(r.stderr ?? '').trim().split('\n').slice(-3).join(' / ')}`)
    const h = pngHeader(png)
    if (h.width !== size || h.height !== size) die(`Chrome's ${size} px PNG is ${h.width}x${h.height}`)
    if (h.colourType !== 6) die(`Chrome's ${size} px PNG has no alpha channel (colour type ${h.colourType})`)
    rendered.set(size, png)
    console.log(`make-app-icon: rendered ${size} px from ${size <= SMALL_MAX ? 'app-icon-small.svg' : 'app-icon.svg'}`)
  }
  for (const [name, size] of SLOTS) copyFileSync(rendered.get(size), join(iconset, name))
  if (pngDir) {
    mkdirSync(pngDir, { recursive: true })
    for (const [size, png] of rendered) copyFileSync(png, join(pngDir, `icon-${size}.png`))
  }

  mkdirSync(join(ROOT, 'build'), { recursive: true })
  const r = spawnSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', OUT], { encoding: 'utf8' })
  if (r.status !== 0) die(`iconutil failed: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`)
  console.log(`make-app-icon: wrote ${OUT} (${readFileSync(OUT).length} bytes)`)
} catch (e) {
  console.error(`make-app-icon: ${e.message}`)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
