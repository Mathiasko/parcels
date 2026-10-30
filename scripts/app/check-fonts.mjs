#!/usr/bin/env node
// Proves a packaged Parcels.app carries the theme fonts. The server inside the app reads them out of
// Contents/Resources/app.asar and serves them at /fonts/<file> (src/web/fonts.ts), so a font that
// electron-builder.yml's `files:` did not pick up would be a 404 in every friend's app.
//
//   node scripts/app/check-fonts.mjs <path/to/Parcels.app>
//
// Lists app.asar with @electron/asar and requires every .woff2 in this repo's assets/fonts/ (the
// subfolders hold only licences) to be in it under assets/fonts/. Exit 0: all are there. Exit 1: the
// asar is missing, unreadable, or lacks a font (each is named), or the repo has no fonts to check.
// Exit 2: wrong arguments.
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const usage = 'usage: node scripts/app/check-fonts.mjs <path/to/Parcels.app>'
const [app] = process.argv.slice(2)
if (!app || process.argv.length > 3) {
  console.error(usage)
  process.exit(2)
}

const fail = (why) => {
  console.error(`check-fonts: ${app}: ${why}`)
  process.exit(1)
}

const fontsDir = fileURLToPath(new URL('../../assets/fonts/', import.meta.url))
const wanted = readdirSync(fontsDir).filter((f) => f.endsWith('.woff2')).sort()
if (wanted.length === 0) fail(`${fontsDir} holds no .woff2 files, so there is nothing to check`)

const archive = join(app, 'Contents', 'Resources', 'app.asar')
if (!existsSync(archive)) fail(`${archive} does not exist`)

let entries
try {
  const { listPackage } = createRequire(import.meta.url)('@electron/asar')
  // Entries come back like "/assets/fonts/x.woff2"; normalise the separator so either style matches.
  entries = new Set(listPackage(archive, {}).map((e) => e.replace(/\\/g, '/').replace(/^\/+/, '')))
} catch (err) {
  fail(`could not list app.asar: ${err instanceof Error ? err.message : String(err)}`)
}

const missing = wanted.filter((f) => !entries.has(`assets/fonts/${f}`))
if (missing.length > 0) {
  fail(`app.asar is missing ${missing.length} of ${wanted.length} theme fonts: ${missing.join(', ')}`)
}
console.log(`check-fonts: ${app}: ok (${wanted.length} theme fonts in app.asar)`)
