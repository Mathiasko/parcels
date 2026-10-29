#!/usr/bin/env node
// Runs a release zip through the same checks the installed app's updater runs before it installs an
// update (src/core/app-update.ts, stageUpdate), so a zip the updater would refuse is never published.
//
//   node scripts/app/check-release-zip.mjs <zip> <version> <signing-cert.sha256> [<SHA256SUMS>]
//
// In order: the zip's name is the one the updater downloads; its SHA256SUMS line matches (when the
// file is given); its table of contents passes readZipEntries and unsafeZipEntry; `ditto -x -k`
// unpacks it into a temporary folder whose tree passes unsafeUnpackedTree; that folder holds a real
// Parcels.app; that app is not a test build (dev-releases-flag.mjs: no `parcelsDevReleases` in its
// package.json); and checkAppBundle accepts it - a valid signature, the leaf certificate whose SHA-256
// is in <signing-cert.sha256>, and Parcels's bundle id at <version>.
//
// It imports the checks from the built dist/, not copies of them, so it can only ever agree with the
// app being released. Run `npm run build` first; build-release.sh does. Exit 0: the updater would
// accept the zip. Exit 1: it would refuse it, with the updater's own sentence and the detail. Exit 2:
// wrong arguments, or no dist/.
import { lstatSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const usage = 'usage: node scripts/app/check-release-zip.mjs <zip> <version> <signing-cert.sha256> [<SHA256SUMS>]'
const [zip, version, certFile, sumsFile] = process.argv.slice(2)
if (!zip || !version || !certFile) {
  console.error(usage)
  process.exit(2)
}

const dist = new URL('../../dist/core/', import.meta.url)
if (!existsSync(new URL('zip-check.js', dist))) {
  console.error('check-release-zip: dist/ has not been built; run npm run build first.')
  process.exit(2)
}
const { readZipEntries, unsafeZipEntry, unsafeUnpackedTree, ZipFormatError } = await import(new URL('zip-check.js', dist).href)
const { checkAppBundle, DITTO, isVersion, parseSha256Sums, runCommand, sha256File } = await import(new URL('app-update.js', dist).href)
const { devReleasesRefusal } = await import(new URL('./dev-releases-flag.mjs', import.meta.url).href)

/** Thrown for a refusal: the sentence the updater would show, and the detail it would log. */
class Refused extends Error {
  constructor(reason, detail) {
    super(reason)
    this.detail = detail
  }
}
const refuse = (reason, detail) => { throw new Refused(reason, detail) }

// The updater's own sentences, where it has one, so a refusal here reads as the user would see it.
const OUTSIDE = 'The download contains files that would land outside its folder, so it was thrown away.'

let work
let entryCount = 0
try {
  if (!isVersion(version)) refuse(`"${version}" is not a version like 1.2.3.`)
  const certSha = readFileSync(certFile, 'utf8').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(certSha)) refuse(`${certFile} is not a SHA-256 in hex, so no app could be checked against it.`)

  // The updater asks for exactly this name, so any other would be a 404 for every friend's app.
  const name = basename(zip)
  if (name !== `Parcels-${version}-arm64.zip` && name !== `Parcels-${version}-x64.zip`) {
    refuse(`the zip must be named Parcels-${version}-arm64.zip or Parcels-${version}-x64.zip, as the updater asks for it.`, name)
  }

  if (sumsFile) {
    const expected = parseSha256Sums(readFileSync(sumsFile, 'utf8')).get(name)
    if (expected === undefined) refuse('The release\'s checksum list does not mention this Mac\'s download, so it was thrown away.', name)
    const actual = await sha256File(zip)
    if (actual !== expected) refuse('The download did not match its published checksum, so it was thrown away.', `${actual} != ${expected}`)
  }

  let entries
  try {
    entries = await readZipEntries(zip)
  } catch (err) {
    refuse('The download is not a zip this app can check, so it was thrown away.', err instanceof ZipFormatError ? err.message : String(err))
  }
  entryCount = entries.length
  const unsafe = unsafeZipEntry(entries)
  if (unsafe !== undefined) refuse(OUTSIDE, unsafe)

  work = mkdtempSync(join(tmpdir(), 'parcels-release-check-'))
  const staging = join(work, 'staging')
  const unpacked = await runCommand(DITTO, ['-x', '-k', zip, staging])
  if (unpacked.code !== 0) refuse('The download could not be unpacked, so it was not installed.', `ditto exited ${unpacked.code}`)
  const tree = unsafeUnpackedTree(staging, entries)
  if (tree !== undefined) refuse(OUTSIDE, tree)

  const app = join(staging, 'Parcels.app')
  let isApp = false
  try {
    const st = lstatSync(app)
    isApp = st.isDirectory() && !st.isSymbolicLink()
  } catch { /* Missing: refused below. */ }
  if (!isApp) refuse('The download did not contain the Parcels app, so it was not installed.')

  // Not one of the updater's checks: a test build may follow a release feed other than GitHub's
  // (ruling R16), so it must never be published. Before codesign, which has nothing to say about it.
  const testBuild = devReleasesRefusal(app)
  if (testBuild) refuse(`The zip holds an app that must not be released: ${testBuild}.`)

  const refused = await checkAppBundle(app, version, certSha, runCommand, join(work, 'certs'))
  if (refused) refuse(refused.reason, refused.detail)

  console.log(`check-release-zip: ${zip}: ok (${entryCount} entries; the updater would accept it)`)
} catch (err) {
  if (err instanceof Refused) {
    console.error(`check-release-zip: ${zip}: refused: ${err.message}${err.detail ? ` (${err.detail})` : ''}`)
  } else {
    console.error(`check-release-zip: ${zip}: refused: the check itself failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  process.exitCode = 1
} finally {
  if (work) rmSync(work, { recursive: true, force: true })
}
