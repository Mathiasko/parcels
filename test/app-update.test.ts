import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  APP_BUNDLE_ID, appUpdateStatusPath, checkAppRelease, CODESIGN, compareVersions, defaultDownload, DITTO,
  githubFetchJson, parseSha256Sums, PLUTIL, readAppUpdateStatus, RELEASES_URL, sha256File, stageUpdate, type StageDeps,
} from '../src/core/app-update.js'
import { readZipEntries, unsafeZipEntry, ZipFormatError } from '../src/core/zip-check.js'
import { LEGIT_APP, makeZip, type WriteEntry } from './zip-writer.js'
import { CHANGE_MAX, CHANGES_SHOWN } from '../src/core/update.js'
import { buildPollDeps } from '../src/core/runtime.js'
import { config, memDb } from './poll-helpers.js'

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parcels-app-update-')) })
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('compareVersions', () => {
  test('compares numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.1')).toBe(1)
    expect(compareVersions('0.9.1', '0.10.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
  })

  test('a leading v is ignored', () => {
    expect(compareVersions('v0.3.0', '0.3.0')).toBe(0)
    expect(compareVersions('0.3.0', 'v0.3.0')).toBe(0)
  })

  test('a -suffix build is lower than the plain version, and suffixes compare as text', () => {
    expect(compareVersions('0.2.0-a', '0.2.0')).toBe(-1)
    expect(compareVersions('0.2.0', '0.2.0-a')).toBe(1)
    expect(compareVersions('0.2.0-a', '0.2.0-b')).toBe(-1)
    expect(compareVersions('0.2.0-b', '0.2.0-b')).toBe(0)
  })

  test('something that is not a version is refused rather than guessed at', () => {
    expect(() => compareVersions('latest', '0.1.0')).toThrow()
  })
})

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.3.0',
  draft: false,
  prerelease: false,
  body: '## What is new\n\n- Faster start\r\n* The menu shows the count\n\n   \nPlain line\n',
  ...over,
})

const httpError = (status: number) => Object.assign(new Error(`GitHub answered HTTP ${status}`), { status })

describe('checkAppRelease', () => {
  test('a newer release is behind, with its notes as the changes', async () => {
    const urls: string[] = []
    const check = await checkAppRelease('0.2.0', async url => { urls.push(url); return release() })
    expect(urls).toEqual([RELEASES_URL])
    expect(check).toEqual({
      state: 'behind',
      behind: 1,
      version: '0.3.0',
      upstream: 'GitHub Releases',
      changes: ['## What is new', 'Faster start', 'The menu shows the count', 'Plain line'],
    })
  })

  test('the changes are capped in number and in length', async () => {
    const body = Array.from({ length: CHANGES_SHOWN + 5 }, (_, i) => `- change ${i} ${'x'.repeat(CHANGE_MAX)}`).join('\n')
    const check = await checkAppRelease('0.2.0', async () => release({ body }))
    expect(check.changes).toHaveLength(CHANGES_SHOWN)
    for (const c of check.changes) expect(c.length).toBeLessThanOrEqual(CHANGE_MAX)
  })

  test('a release without notes is still an update', async () => {
    const check = await checkAppRelease('0.2.0', async () => release({ body: null }))
    expect(check.state).toBe('behind')
    expect(check.changes).toEqual([])
  })

  test('the same version is current', async () => {
    const check = await checkAppRelease('0.3.0', async () => release())
    expect(check.state).toBe('current')
    expect(check.behind).toBe(0)
    expect(check.changes).toEqual([])
  })

  test('an older release is current too, never a downgrade', async () => {
    expect((await checkAppRelease('0.4.0', async () => release())).state).toBe('current')
  })

  test('a draft or a prerelease is never offered', async () => {
    expect((await checkAppRelease('0.2.0', async () => release({ prerelease: true }))).state).not.toBe('behind')
    expect((await checkAppRelease('0.2.0', async () => release({ draft: true }))).state).not.toBe('behind')
  })

  test('HTTP 403 is the rate limit, in one sentence', async () => {
    const check = await checkAppRelease('0.2.0', async () => { throw httpError(403) })
    expect(check.state).toBe('blocked')
    expect(check.reason).toBe('GitHub refused the check (rate limit); it is retried tomorrow.')
  })

  test('a network failure is blocked with a sentence, not an exception', async () => {
    const check = await checkAppRelease('0.2.0', async () => { throw new TypeError('fetch failed') })
    expect(check.state).toBe('blocked')
    expect(check.reason).toMatch(/^[A-Z].*\.$/)
  })

  test('another HTTP status is blocked and says which', async () => {
    const check = await checkAppRelease('0.2.0', async () => { throw httpError(502) })
    expect(check.state).toBe('blocked')
    expect(check.reason).toContain('502')
  })

  test('JSON without tag_name is blocked', async () => {
    const check = await checkAppRelease('0.2.0', async () => ({ name: 'x' }))
    expect(check.state).toBe('blocked')
    expect(check.reason).toMatch(/\.$/)
  })

  test('JSON that is not an object at all is blocked', async () => {
    expect((await checkAppRelease('0.2.0', async () => null)).state).toBe('blocked')
    expect((await checkAppRelease('0.2.0', async () => 'v0.3.0')).state).toBe('blocked')
  })

  test('a tag that is not a version is blocked', async () => {
    expect((await checkAppRelease('0.2.0', async () => release({ tag_name: 'nightly' }))).state).toBe('blocked')
    expect((await checkAppRelease('0.2.0', async () => release({ tag_name: 'v0.3.0/../../x' }))).state).toBe('blocked')
  })

  test('a running version that cannot be read is blocked, not "behind"', async () => {
    expect((await checkAppRelease('0.1.0 (0db9a83)', async () => release())).state).toBe('blocked')
  })
})

describe('parseSha256Sums', () => {
  test('reads shasum lines and ignores everything else', () => {
    const a = 'a'.repeat(64)
    const b = 'B'.repeat(64)
    const sums = parseSha256Sums([
      `${a}  Parcels-0.3.0-arm64.zip`,
      '',
      '   ',
      'not a checksum line',
      `${'c'.repeat(63)}  short.zip`,
      `${'z'.repeat(64)}  nothex.zip`,
      `${b} *Parcels-0.3.0-x64.zip`,
      '',
    ].join('\n'))
    expect([...sums.entries()]).toEqual([
      ['Parcels-0.3.0-arm64.zip', a],
      ['Parcels-0.3.0-x64.zip', 'b'.repeat(64)],
    ])
  })
})

describe('readAppUpdateStatus', () => {
  test('garbage, a missing file and an unknown state are all undefined', () => {
    const p = join(dir, 'status.json')
    expect(readAppUpdateStatus(p)).toBeUndefined()
    writeFileSync(p, '{not json')
    expect(readAppUpdateStatus(p)).toBeUndefined()
    writeFileSync(p, JSON.stringify({ state: 'exploded', version: '0.3.0', startedAt: new Date().toISOString() }))
    expect(readAppUpdateStatus(p)).toBeUndefined()
    writeFileSync(p, JSON.stringify({ state: 'staged', version: '0.3.0', startedAt: 'yesterday', staged: '/x' }))
    expect(readAppUpdateStatus(p)).toBeUndefined()
    writeFileSync(p, JSON.stringify({ state: 'failed', version: '../../x', reason: 'r', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }))
    expect(readAppUpdateStatus(p)).toBeUndefined()
  })

  test('an installed status reads back', () => {
    const p = join(dir, 'status.json')
    writeFileSync(p, JSON.stringify({ state: 'installed', version: '0.3.0', finishedAt: '2026-10-29T10:00:00.000Z' }))
    expect(readAppUpdateStatus(p)).toEqual({ state: 'installed', version: '0.3.0', finishedAt: new Date('2026-10-29T10:00:00.000Z') })
  })
})

describe('sha256File', () => {
  test('hashes a file as a stream', async () => {
    const p = join(dir, 'f')
    writeFileSync(p, 'hello')
    expect(await sha256File(p)).toBe(sha('hello'))
  })
})

// --- stageUpdate -------------------------------------------------------------------------------------

const VERSION = '0.3.0'
const ZIP = `Parcels-${VERSION}-arm64.zip`
const ZIP_BYTES = makeZip(LEGIT_APP)
const CERT = Buffer.from('the leaf certificate, DER')

interface Fake {
  zipBytes?: string | Buffer
  sums?: string
  bundleId?: string
  bundleVersion?: string
  plutilCode?: number
  downloadThrows?: string
  dittoCode?: number
  dittoMakesApp?: boolean
  dittoMakesSymlink?: boolean
  verifyCode?: number
  cert?: Buffer
}

function setup(fake: Fake = {}, over: Partial<StageDeps> = {}) {
  const supportDir = join(dir, 'support')
  const apps = join(dir, 'Applications')
  mkdirSync(apps, { recursive: true })
  const appBundle = join(apps, 'Parcels.app')
  const staging = join(apps, `.Parcels-update-${VERSION}`)
  const downloads = join(supportDir, 'updates', VERSION)
  const urls: string[] = []
  const calls: Array<[string, string[]]> = []
  const zipBytes = fake.zipBytes ?? ZIP_BYTES
  const deps: StageDeps = {
    version: VERSION,
    arch: 'arm64',
    appBundle,
    supportDir,
    expectedCertSha: sha(CERT),
    download: async (url, dest) => {
      urls.push(url)
      if (fake.downloadThrows !== undefined && url.endsWith(fake.downloadThrows)) {
        writeFileSync(dest, 'trunc')
        throw new Error('terminated: other side closed')
      }
      writeFileSync(dest, url.endsWith('/SHA256SUMS') ? (fake.sums ?? `${sha(ZIP_BYTES)}  ${ZIP}\n`) : zipBytes)
    },
    run: async (cmd, args) => {
      calls.push([cmd, args])
      if (cmd === DITTO) {
        const dest = args[3]!
        mkdirSync(dest, { recursive: true })
        if (fake.dittoMakesSymlink) symlinkSync(dir, join(dest, 'Parcels.app'))
        else if (fake.dittoMakesApp !== false) mkdirSync(join(dest, 'Parcels.app', 'Contents'), { recursive: true })
        return { code: fake.dittoCode ?? 0, stdout: '' }
      }
      if (cmd === CODESIGN && args[0] === '--verify') return { code: fake.verifyCode ?? 0, stdout: '' }
      if (cmd === CODESIGN && args[0] === '-d') {
        const prefix = args.find(a => a.startsWith('--extract-certificates='))!.slice('--extract-certificates='.length)
        writeFileSync(`${prefix}0`, fake.cert ?? CERT)
        writeFileSync(`${prefix}1`, 'the issuer, which is the same self-signed one')
        return { code: 0, stdout: '' }
      }
      if (cmd === PLUTIL) {
        if (fake.plutilCode) return { code: fake.plutilCode, stdout: '' }
        const key = args[1]
        if (key === 'CFBundleIdentifier') return { code: 0, stdout: `${fake.bundleId ?? APP_BUNDLE_ID}\n` }
        if (key === 'CFBundleShortVersionString') return { code: 0, stdout: `${fake.bundleVersion ?? VERSION}\n` }
        return { code: 1, stdout: '' }
      }
      return { code: 127, stdout: '' }
    },
    ...over,
  }
  return { deps, supportDir, appBundle, staging, downloads, urls, calls, statusPath: appUpdateStatusPath(supportDir) }
}

describe('stageUpdate', () => {
  test('the happy path stages the app, says so in the status file, and keeps no download', async () => {
    const s = setup()
    const out = await stageUpdate(s.deps)
    expect(out.state).toBe('staged')
    const staged = join(s.staging, 'Parcels.app')
    expect(out).toMatchObject({ version: VERSION, staged })
    expect(existsSync(staged)).toBe(true)
    expect(existsSync(s.downloads)).toBe(false)

    const status = readAppUpdateStatus(s.statusPath)
    expect(status).toMatchObject({ state: 'staged', version: VERSION, staged })
    expect(statSync(s.statusPath).mode & 0o777).toBe(0o600)

    expect(s.urls).toEqual([
      `https://github.com/Mathiasko/parcels/releases/download/v${VERSION}/${ZIP}`,
      `https://github.com/Mathiasko/parcels/releases/download/v${VERSION}/SHA256SUMS`,
    ])
    expect(s.calls[0]).toEqual([DITTO, ['-x', '-k', join(s.downloads, ZIP), s.staging]])
    expect(s.calls[1]).toEqual([CODESIGN, ['--verify', '--deep', '--strict', staged]])
    expect(s.calls[2]![0]).toBe(CODESIGN)
    expect(s.calls[2]![1][0]).toBe('-d')
    expect(s.calls[2]![1].at(-1)).toBe(staged)
    const plist = join(staged, 'Contents', 'Info.plist')
    expect(s.calls[3]).toEqual([PLUTIL, ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]])
    expect(s.calls[4]).toEqual([PLUTIL, ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]])
    expect(s.calls).toHaveLength(5)
  })

  test('the checksum and the certificate hash are compared without regard to case', async () => {
    const s = setup({ sums: `${sha(ZIP_BYTES).toUpperCase()}  ${ZIP}\n` }, { expectedCertSha: `${sha(CERT).toUpperCase()}\n` })
    expect((await stageUpdate(s.deps)).state).toBe('staged')
  })

  test('leftovers from an earlier attempt are removed before starting', async () => {
    const s = setup()
    mkdirSync(join(s.staging, 'junk'), { recursive: true })
    mkdirSync(s.downloads, { recursive: true })
    writeFileSync(join(s.downloads, 'partial.zip'), 'half')
    expect((await stageUpdate(s.deps)).state).toBe('staged')
    expect(existsSync(join(s.staging, 'junk'))).toBe(false)
    expect(existsSync(s.downloads)).toBe(false)
  })

  const failsCleanly = async (s: ReturnType<typeof setup>, reason?: RegExp) => {
    const out = await stageUpdate(s.deps)
    expect(out.state).toBe('failed')
    if (out.state !== 'failed') return out
    if (reason) expect(out.reason).toMatch(reason)
    expect(out.reason).toMatch(/^[A-Z].*\.$/)
    expect(existsSync(s.staging)).toBe(false)
    expect(existsSync(s.downloads)).toBe(false)
    expect(readAppUpdateStatus(s.statusPath)).toMatchObject({ state: 'failed', version: VERSION, reason: out.reason })
    return out
  }

  test('a wrong checksum fails, and nothing is unpacked', async () => {
    const s = setup({ zipBytes: 'tampered bytes' })
    await failsCleanly(s, /did not match/)
    expect(s.calls).toHaveLength(0)
  })

  test('a SHA256SUMS without this download in it fails', async () => {
    const s = setup({ sums: `${sha(ZIP_BYTES)}  Parcels-${VERSION}-x64.zip\n` })
    await failsCleanly(s)
    expect(s.calls).toHaveLength(0)
  })

  test('a download that breaks off fails', async () => {
    await failsCleanly(setup({ downloadThrows: ZIP }))
    await failsCleanly(setup({ downloadThrows: 'SHA256SUMS' }))
  })

  test('ditto failing fails', async () => {
    await failsCleanly(setup({ dittoCode: 1 }))
  })

  test('a zip without Parcels.app in it fails', async () => {
    const s = setup({ dittoMakesApp: false })
    await failsCleanly(s)
    expect(s.calls.some(([cmd]) => cmd === CODESIGN)).toBe(false)
  })

  test('a Parcels.app that is a symlink out of the staging folder fails', async () => {
    const s = setup({ dittoMakesSymlink: true })
    await failsCleanly(s)
    expect(s.calls.some(([cmd]) => cmd === CODESIGN)).toBe(false)
    expect(existsSync(dir)).toBe(true)   // removing the staging folder did not follow the link
  })

  test('a broken signature fails', async () => {
    const s = setup({ verifyCode: 1 })
    await failsCleanly(s)
    expect(s.calls).toHaveLength(2)
  })

  test('a stale status is removed, and if the first status cannot be written nothing is downloaded', async () => {
    const s = setup()
    mkdirSync(dirname(s.statusPath), { recursive: true })
    writeFileSync(s.statusPath, JSON.stringify({ state: 'installed', version: '0.2.0', finishedAt: new Date().toISOString() }))
    // A directory where the writer's temporary file goes: only the status write fails, nothing else.
    mkdirSync(`${s.statusPath}.tmp.${process.pid}`)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const out = await stageUpdate(s.deps)
      expect(out.state).toBe('failed')
      expect(s.urls).toEqual([])
      expect(s.calls).toEqual([])
      expect(existsSync(s.statusPath)).toBe(false)
      expect(existsSync(s.downloads)).toBe(false)
    } finally { errors.mockRestore() }
  })

  test('a different certificate fails', async () => {
    await failsCleanly(setup({ cert: Buffer.from('somebody else') }), /not signed by the same certificate/)
  })

  test('another app signed with the same certificate fails', async () => {
    await failsCleanly(setup({ bundleId: 'local.parcelsspike.app' }), /not the version it claims to be/)
  })

  test('an older Parcels signed with the same certificate fails', async () => {
    await failsCleanly(setup({ bundleVersion: '0.2.0' }), /not the version it claims to be/)
  })

  test('an Info.plist that cannot be read fails', async () => {
    await failsCleanly(setup({ plutilCode: 1 }), /not the version it claims to be/)
  })

  test('a missing expected certificate hash fails rather than accepting anything', async () => {
    await failsCleanly(setup({}, { expectedCertSha: '' }))
  })

  const withZip = (entries: WriteEntry[], opts: { zip64?: boolean } = {}) => {
    const zip = makeZip(entries, opts)
    return setup({ zipBytes: zip, sums: `${sha(zip)}  ${ZIP}\n` })
  }
  const OUTSIDE = /outside its folder/

  test('a zip shaped like the real app, framework symlinks and all, is unpacked (zip64 too)', async () => {
    expect((await stageUpdate(withZip(LEGIT_APP).deps)).state).toBe('staged')
    expect((await stageUpdate(withZip(LEGIT_APP, { zip64: true }).deps)).state).toBe('staged')
  })

  const escapes: Array<[string, WriteEntry[]]> = [
    ['a ../ name', [{ name: '../evil', data: 'x' }]],
    ['a ../ inside the app', [{ name: 'Parcels.app/../../evil', data: 'x' }]],
    ['an absolute name', [{ name: '/abs', data: 'x' }]],
    ['a backslash', [{ name: 'Parcels.app\\..\\..\\evil', data: 'x' }]],
    ['a symlink to /Users', [{ name: 'Parcels.app/l', link: '/Users' }]],
    ['a symlink to ../../x', [{ name: 'Parcels.app/l', link: '../../x' }]],
    ['a deflated symlink out', [{ name: 'Parcels.app/l', link: '../../../Library/LaunchAgents', deflate: true }]],
    ['a write through a symlinked directory', [
      { name: 'Parcels.app/d', link: 'Contents' }, { name: 'Parcels.app/d/evil', data: 'x' },
    ]],
    ['a write through a symlink spelled in another case', [
      { name: 'Parcels.app/D', link: 'Contents' }, { name: 'parcels.app/d/evil', data: 'x' },
    ]],
    ['a chain of in-tree links that ends outside', [
      { name: 'Parcels.app/x', link: '..' }, { name: 'Parcels.app/y', link: 'x/..' },
    ]],
    ['a link loop', [{ name: 'Parcels.app/a', link: 'b' }, { name: 'Parcels.app/b', link: 'a' }]],
    ['the same path twice', [{ name: 'Parcels.app/f', data: 'x' }, { name: 'Parcels.app/f', link: 'Contents' }]],
  ]
  for (const [what, entries] of escapes) {
    test(`a zip with ${what} is refused before ditto runs`, async () => {
      const s = withZip([...LEGIT_APP, ...entries])
      await failsCleanly(s, OUTSIDE)
      expect(s.calls).toEqual([])
    })
  }

  test('a local header naming a different file than the directory is refused', async () => {
    const s = withZip([...LEGIT_APP, { name: 'Parcels.app/ok', localName: '../evi', data: 'x' }])
    await failsCleanly(s)
    expect(s.calls).toEqual([])
  })

  test('an entry hidden from the directory is refused', async () => {
    const s = withZip([...LEGIT_APP, { name: '../evil', data: 'x', hidden: true }])
    await failsCleanly(s)
    expect(s.calls).toEqual([])
  })

  test('a download that is not a zip at all is refused before ditto runs', async () => {
    const s = setup({ zipBytes: 'not a zip', sums: `${sha('not a zip')}  ${ZIP}\n` })
    await failsCleanly(s)
    expect(s.calls).toEqual([])
  })

  test('an http download base is refused unless it is this Mac', async () => {
    const s = setup({}, { releaseBase: 'http://example.com/releases/v0.3.0' })
    await failsCleanly(s)
    expect(s.urls).toEqual([])

    const local = setup({}, { releaseBase: 'http://127.0.0.1:8899/v0.3.0/' })
    expect((await stageUpdate(local.deps)).state).toBe('staged')
    expect(local.urls[0]).toBe(`http://127.0.0.1:8899/v0.3.0/${ZIP}`)
  })

  test('a version that is not a version touches nothing', async () => {
    const s = setup({}, { version: '../../evil' })
    const out = await stageUpdate(s.deps)
    expect(out.state).toBe('failed')
    expect(s.urls).toEqual([])
    expect(existsSync(join(dir, 'evil'))).toBe(false)
  })

  test('the status file is written through a rename, mode 0600, and leaves no temporary file behind', async () => {
    const s = setup({ verifyCode: 1 })
    await stageUpdate(s.deps)
    expect(JSON.parse(readFileSync(s.statusPath, 'utf8')).state).toBe('failed')
    expect(lstatSync(s.statusPath).isFile()).toBe(true)
    expect(statSync(s.statusPath).mode & 0o777).toBe(0o600)
    expect(readdirSync(dirname(s.statusPath)).filter(n => n.includes('.tmp'))).toEqual([])
  })
})

// --- the zip check on its own ------------------------------------------------------------------------

describe('readZipEntries and unsafeZipEntry', () => {
  const write = (zip: Buffer) => { const p = join(dir, `z-${Math.random()}.zip`); writeFileSync(p, zip); return p }

  test('lists names and symlink targets, stored or deflated', () => {
    const entries = readZipEntries(write(makeZip(LEGIT_APP)))
    expect(entries.map(e => e.name)).toEqual(LEGIT_APP.map(e => e.name))
    expect(entries.find(e => e.name.endsWith('Versions/Current'))).toMatchObject({ isSymlink: true, target: 'A' })
    expect(entries.find(e => e.name.endsWith('X.framework/Resources'))).toMatchObject({ isSymlink: true, target: 'Versions/Current/Resources' })
    expect(unsafeZipEntry(entries)).toBeUndefined()
  })

  test('a truncated zip is a format error', () => {
    const zip = makeZip(LEGIT_APP)
    expect(() => readZipEntries(write(zip.subarray(0, zip.length - 30)))).toThrow(ZipFormatError)
  })

  test('a name that is not valid UTF-8 is a format error', () => {
    // A lone 0xC0 where the slash was: a lenient decoder and the unpacker could disagree about the name.
    const zip = makeZip([{ name: 'Parcels.app/a', data: 'x' }])
    const at = zip.lastIndexOf(Buffer.from('Parcels.app/a'))
    zip[at + 11] = 0xc0
    const first = zip.indexOf(Buffer.from('Parcels.app/a'))
    zip[first + 11] = 0xc0
    expect(() => readZipEntries(write(zip))).toThrow(ZipFormatError)
  })

  test.skipIf(!existsSync('/usr/bin/zip'))('reads what /usr/bin/zip writes, symlinks included', () => {
    const src = join(dir, 'src')
    mkdirSync(join(src, 'Parcels.app', 'Versions', 'A'), { recursive: true })
    writeFileSync(join(src, 'Parcels.app', 'Versions', 'A', 'bin'), 'x')
    symlinkSync('A', join(src, 'Parcels.app', 'Versions', 'Current'))
    const good = join(dir, 'good.zip')
    execFileSync('/usr/bin/zip', ['-q', '-r', '-y', good, 'Parcels.app'], { cwd: src })
    const entries = readZipEntries(good)
    expect(entries.find(e => e.name === 'Parcels.app/Versions/Current')).toMatchObject({ isSymlink: true, target: 'A' })
    expect(unsafeZipEntry(entries)).toBeUndefined()

    symlinkSync('../../../../Library', join(src, 'Parcels.app', 'Versions', 'Out'))
    const evil = join(dir, 'evil.zip')
    execFileSync('/usr/bin/zip', ['-q', '-r', '-y', evil, 'Parcels.app'], { cwd: src })
    expect(unsafeZipEntry(readZipEntries(evil))).toMatch(/outside/)
  })
})

// --- the real fetch wrappers, with fetch stubbed --------------------------------------------------------

describe('githubFetchJson and defaultDownload', () => {
  test('the JSON fetch sends GitHub headers and returns the parsed body', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ tag_name: 'v1.0.0' }), { status: 200 })
    })
    expect(await githubFetchJson('0.2.0')(RELEASES_URL)).toEqual({ tag_name: 'v1.0.0' })
    const headers = new Headers(seen[0]!.init!.headers)
    expect(headers.get('accept')).toBe('application/vnd.github+json')
    expect(headers.get('user-agent')).toBe('Parcels/0.2.0')
    expect(seen[0]!.init!.signal).toBeInstanceOf(AbortSignal)
  })

  test('a non-2xx is an error carrying the status', async () => {
    vi.stubGlobal('fetch', async () => new Response('rate limited', { status: 403 }))
    await expect(githubFetchJson('0.2.0')(RELEASES_URL)).rejects.toMatchObject({ status: 403 })
  })

  test('the download streams the body to the file', async () => {
    vi.stubGlobal('fetch', async () => new Response('zip body', { status: 200 }))
    const dest = join(dir, 'out.zip')
    await defaultDownload('https://github.com/x/y.zip', dest)
    expect(readFileSync(dest, 'utf8')).toBe('zip body')
  })

  test('a download answered with 404 throws with the status', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }))
    await expect(defaultDownload('https://github.com/x/y.zip', join(dir, 'out.zip'))).rejects.toMatchObject({ status: 404 })
  })

  test('a download redirected to plain http is refused', async () => {
    vi.stubGlobal('fetch', async () => {
      const res = new Response('zip body', { status: 200 })
      Object.defineProperty(res, 'url', { value: 'http://objects.example.com/y.zip' })
      return res
    })
    await expect(defaultDownload('https://github.com/x/y.zip', join(dir, 'out.zip'))).rejects.toThrow(/https/)
  })
})

describe('the poll uses the app check in the app', () => {
  test('the git install keeps the update.sh check', () => {
    vi.stubEnv('PARCELS_HOST', '')
    expect(buildPollDeps(memDb(), config).updateCheck).toEqual({})
  })

  test('the app asks GitHub Releases, with its own version', async () => {
    vi.stubEnv('PARCELS_HOST', 'app')
    vi.stubEnv('PARCELS_APP_VERSION', '0.2.0')
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify(release()), { status: 200 })
    })
    const deps = buildPollDeps(memDb(), config)
    const check = await deps.updateCheck!.check!()
    expect(check.state).toBe('behind')
    expect(check.version).toBe('0.3.0')
    expect(seen[0]!.url).toBe(RELEASES_URL)
    expect(new Headers(seen[0]!.init!.headers).get('user-agent')).toBe('Parcels/0.2.0')
  })
})
