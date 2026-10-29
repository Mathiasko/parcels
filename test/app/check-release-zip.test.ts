import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { makeZip, type WriteEntry } from '../zip-writer.js'

// scripts/app/check-release-zip.mjs runs the app's own update checks (from the built dist/) on a zip
// the release just made, so a zip the updater would refuse is never published. These tests hand it
// crafted zips that fail before the signature checks: the tests must never run codesign, and every
// zip here is refused before it gets that far. The real zips' full run, codesign included, is in the
// release build. Skipped until `npm run build` has made dist/.
const SCRIPT = fileURLToPath(new URL('../../scripts/app/check-release-zip.mjs', import.meta.url))
const DIST = fileURLToPath(new URL('../../dist/core/zip-check.js', import.meta.url))
const CERT_SHA = 'a'.repeat(64)

describe.skipIf(!existsSync(DIST))('check-release-zip.mjs', () => {
  let dir: string
  let scratch: string
  let certFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'parcels-relzip-'))
    // The script's own temporary folder goes here (TMPDIR), so the test can see it is removed again.
    scratch = join(dir, 'scratch')
    mkdirSync(scratch)
    certFile = join(dir, 'signing-cert.sha256')
    writeFileSync(certFile, `${CERT_SHA}\n`)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const zipAt = (name: string, entries: WriteEntry[]) => {
    const path = join(dir, name)
    writeFileSync(path, makeZip(entries))
    return path
  }
  const sums = (zip: string, name: string, sha?: string) => {
    const path = join(dir, 'SHA256SUMS')
    const real = createHash('sha256').update(readFileSync(zip)).digest('hex')
    writeFileSync(path, `${sha ?? real}  ${name}\n`)
    return path
  }
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, TMPDIR: scratch },
    })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }

  test('without its arguments it says how to run it and exits 2', () => {
    const r = run()
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/usage: .*check-release-zip\.mjs <zip> <version> <signing-cert\.sha256>/)
  })

  test('a zip with an entry that climbs out of its folder is refused', () => {
    const zip = zipAt('Parcels-1.2.3-arm64.zip', [{ name: 'Parcels.app/' }, { name: '../evil', data: 'x' }])
    const r = run(zip, '1.2.3', certFile)
    expect(r.code).toBe(1)
    expect(r.out).toContain('refused')
    expect(r.out).toContain('would land outside its folder')
    expect(r.out).toContain('"../evil"')
  })

  test('a file that is not a zip is refused', () => {
    const zip = join(dir, 'Parcels-1.2.3-arm64.zip')
    writeFileSync(zip, 'not a zip at all')
    const r = run(zip, '1.2.3', certFile)
    expect(r.code).toBe(1)
    expect(r.out).toContain('not a zip this app can check')
  })

  test('a zip not named as the updater downloads it is refused', () => {
    const zip = zipAt('Parcels-1.2.3-universal.zip', [{ name: 'Parcels.app/' }])
    const r = run(zip, '1.2.3', certFile)
    expect(r.code).toBe(1)
    expect(r.out).toContain('Parcels-1.2.3-arm64.zip or Parcels-1.2.3-x64.zip')
  })

  test('a zip whose SHA256SUMS line does not match is refused', () => {
    const zip = zipAt('Parcels-1.2.3-x64.zip', [{ name: 'Parcels.app/' }])
    const r = run(zip, '1.2.3', certFile, sums(zip, 'Parcels-1.2.3-x64.zip', 'b'.repeat(64)))
    expect(r.code).toBe(1)
    expect(r.out).toContain('did not match its published checksum')
  })

  test('a zip SHA256SUMS does not list is refused', () => {
    const zip = zipAt('Parcels-1.2.3-x64.zip', [{ name: 'Parcels.app/' }])
    const r = run(zip, '1.2.3', certFile, sums(zip, 'Parcels-1.2.3-arm64.zip'))
    expect(r.code).toBe(1)
    expect(r.out).toContain('does not mention')
  })

  test('a safe zip without Parcels.app in it is refused after unpacking, and its temporary folder is gone', () => {
    const zip = zipAt('Parcels-1.2.3-arm64.zip', [{ name: 'Other.app/' }, { name: 'Other.app/readme.txt', data: 'hi', deflate: true }])
    const r = run(zip, '1.2.3', certFile, sums(zip, 'Parcels-1.2.3-arm64.zip'))
    expect(r.code).toBe(1)
    expect(r.out).toContain('did not contain the Parcels app')
    expect(readdirSync(scratch)).toEqual([])
  })

  test('a certificate file that holds no hash is refused before anything is read', () => {
    writeFileSync(certFile, 'nope\n')
    const zip = zipAt('Parcels-1.2.3-arm64.zip', [{ name: 'Parcels.app/' }])
    const r = run(zip, '1.2.3', certFile)
    expect(r.code).toBe(1)
    expect(r.out).toContain('is not a SHA-256')
  })
})

// Ruling R16: a test build (package.json names parcelsDevReleases) may follow a release feed other
// than GitHub's, so the release refuses it. The check runs before codesign, so these zips never reach it.
const asar = createRequire(import.meta.url)('@electron/asar') as { createPackage(src: string, dest: string): Promise<unknown> }
const FLAG_SCRIPT = fileURLToPath(new URL('../../scripts/app/dev-releases-flag.mjs', import.meta.url))

/** An app.asar holding just a package.json, built by electron-builder's own asar library. */
async function asarWith(dir: string, pkg: Record<string, unknown>): Promise<Buffer> {
  const src = mkdtempSync(join(dir, 'asar-src-'))
  writeFileSync(join(src, 'package.json'), JSON.stringify(pkg))
  const out = join(dir, `app-${Math.random().toString(36).slice(2)}.asar`)
  await asar.createPackage(src, out)
  return readFileSync(out)
}

describe.skipIf(!existsSync(DIST))('check-release-zip.mjs refuses a test build', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parcels-relzip-dev-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const appZip = (archive: Buffer | undefined) => {
    const entries: WriteEntry[] = [
      { name: 'Parcels.app/' }, { name: 'Parcels.app/Contents/' }, { name: 'Parcels.app/Contents/Resources/' },
      ...(archive ? [{ name: 'Parcels.app/Contents/Resources/app.asar', data: archive }] : []),
    ]
    const zip = join(dir, 'Parcels-1.2.3-arm64.zip')
    writeFileSync(zip, makeZip(entries))
    const cert = join(dir, 'signing-cert.sha256')
    writeFileSync(cert, `${CERT_SHA}\n`)
    const r = spawnSync(process.execPath, [SCRIPT, zip, '1.2.3', cert], { encoding: 'utf8', timeout: 30_000 })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }

  test('an app whose package.json names parcelsDevReleases is refused before codesign', async () => {
    const r = appZip(await asarWith(dir, { name: 'parcels', version: '1.2.3', parcelsDevReleases: true }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('must not be released')
    expect(r.out).toContain('test build')
    // codesign's own refusal would name the signature; it never ran.
    expect(r.out).not.toContain('signature')
  })

  test('an app whose package.json cannot be read is refused too', () => {
    const r = appZip(undefined)
    expect(r.code).toBe(1)
    expect(r.out).toContain('could not be read')
  })
})

describe('dev-releases-flag.mjs', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parcels-devflag-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const bundle = async (name: string, pkg: Record<string, unknown>, packed: boolean) => {
    const resources = join(dir, name, 'Contents', 'Resources')
    mkdirSync(resources, { recursive: true })
    if (packed) writeFileSync(join(resources, 'app.asar'), await asarWith(dir, pkg))
    else {
      mkdirSync(join(resources, 'app'))
      writeFileSync(join(resources, 'app', 'package.json'), JSON.stringify(pkg))
    }
    return join(dir, name)
  }
  const run = (...apps: string[]) => {
    const r = spawnSync(process.execPath, [FLAG_SCRIPT, ...apps], { encoding: 'utf8', timeout: 30_000 })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }

  test('a release build passes, packed or not', async () => {
    const r = run(await bundle('A.app', { name: 'parcels', version: '1.2.3' }, true), await bundle('B.app', { name: 'parcels' }, false))
    expect(r.code).toBe(0)
    expect(r.out).toContain('a release build')
  })

  test('a test build is refused, packed or not, even beside a release build', async () => {
    const ok = await bundle('Ok.app', { name: 'parcels' }, true)
    expect(run(ok, await bundle('Dev.app', { name: 'parcels', parcelsDevReleases: true }, true)).code).toBe(1)
    expect(run(await bundle('Dev2.app', { name: 'parcels', parcelsDevReleases: true }, false)).code).toBe(1)
    // Present at all is enough: a release build never names it.
    expect(run(await bundle('Dev3.app', { name: 'parcels', parcelsDevReleases: false }, true)).code).toBe(1)
  })

  test('without a bundle it says how to run it and exits 2', () => {
    expect(run().code).toBe(2)
  })
})
