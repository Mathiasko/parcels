#!/usr/bin/env node
// Refuses a Parcels.app built for testing updates (ruling R16), so a release can never ship one.
//
//   node scripts/app/dev-releases-flag.mjs <Parcels.app>...
//
// A test build carries `"parcelsDevReleases": true` in its package.json (electron-builder
// -c.extraMetadata.parcelsDevReleases=true), which lets PARCELS_RELEASES_URL point its updater at a
// feed other than GitHub's (app/dev-releases.ts). Such a bundle must never be published: whoever could
// set that variable for it would choose the code it installs.
//
// The package.json is read from Contents/Resources/app.asar, or from Contents/Resources/app/ when the
// bundle is not packed. One that cannot be read at all is refused too, because then nobody can say
// the flag is absent. Exit 0: every bundle is a release build. Exit 1: at least one is not, with the
// reason. Exit 2: no bundle named. check-release-zip.mjs imports `devReleasesRefusal` from here.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FLAG = 'parcelsDevReleases'

/**
 * Why `appPath` must not be released, or undefined when its package.json is readable and does not
 * set the flag. Never throws.
 */
export function devReleasesRefusal(appPath) {
  const resources = join(appPath, 'Contents', 'Resources')
  const archive = join(resources, 'app.asar')
  let text
  try {
    if (existsSync(archive)) {
      const asar = createRequire(import.meta.url)('@electron/asar')
      text = asar.extractFile(archive, 'package.json').toString('utf8')
    } else {
      text = readFileSync(join(resources, 'app', 'package.json'), 'utf8')
    }
  } catch (err) {
    return `its package.json could not be read, so it cannot be shown to be a release build (${err instanceof Error ? err.message : String(err)})`
  }
  let pkg
  try {
    pkg = JSON.parse(text)
  } catch {
    return 'its package.json is not JSON, so it cannot be shown to be a release build'
  }
  if (pkg === null || typeof pkg !== 'object') return 'its package.json is not an object, so it cannot be shown to be a release build'
  if (FLAG in pkg) {
    return `it is a test build (its package.json names ${FLAG}), which may follow a release feed other than GitHub's`
  }
  return undefined
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const apps = process.argv.slice(2)
  if (apps.length === 0) {
    console.error('usage: node scripts/app/dev-releases-flag.mjs <Parcels.app>...')
    process.exit(2)
  }
  let bad = false
  for (const app of apps) {
    const why = devReleasesRefusal(app)
    if (why) {
      console.error(`dev-releases-flag: ${app}: refused: ${why}.`)
      bad = true
    } else {
      console.log(`dev-releases-flag: ${app}: a release build`)
    }
  }
  process.exitCode = bad ? 1 : 0
}
