import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import {
  APP_BUNDLE_ID, appUpdateStatusPath, checkAppRelease, CODESIGN, compareVersions, defaultDownload, DITTO,
  downloadBaseBeside, githubFetchJson, isSafeDownloadUrl, parseSha256Sums, PLUTIL, readAppUpdateStatus, RELEASES_URL,
  releasesUrlOverride, runCommand, sha256File, stageUpdate, SUMS_MAX_BYTES, ZIP_MAX_BYTES, type DownloadOptions, type StageDeps,
} from '../src/core/app-update.js'
import {
  readZipEntries, unsafeUnpackedTree, unsafeZipEntry, ZipFormatError, type ZipEntry,
} from '../src/core/zip-check.js'
import { LEGIT_APP, localHeader, makeZip, type WriteEntry } from './zip-writer.js'
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
  /** Runs inside the fake ditto, after it made Parcels.app: what a misbehaving unpacker left behind. */
  dittoExtra?: (staging: string) => void
  downloadThrows?: string
  dittoCode?: number
  dittoMakesApp?: boolean
  dittoMakesSymlink?: boolean
  verifyCode?: number
  cert?: Buffer
  /** codesign -d succeeds but extracts no certificate: an ad hoc signature carries none. */
  adHoc?: boolean
}

function setup(fake: Fake = {}, over: Partial<StageDeps> = {}) {
  const supportDir = join(dir, 'support')
  const apps = join(dir, 'Applications')
  mkdirSync(apps, { recursive: true })
  const appBundle = join(apps, 'Parcels.app')
  const staging = join(apps, `.Parcels-update-${VERSION}`)
  const downloads = join(supportDir, 'updates', VERSION)
  const urls: string[] = []
  const options: Array<DownloadOptions | undefined> = []
  const calls: Array<[string, string[]]> = []
  const zipBytes = fake.zipBytes ?? ZIP_BYTES
  const deps: StageDeps = {
    version: VERSION,
    arch: 'arm64',
    appBundle,
    supportDir,
    expectedCertSha: sha(CERT),
    download: async (url, dest, o) => {
      urls.push(url)
      options.push(o)
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
        fake.dittoExtra?.(dest)
        return { code: fake.dittoCode ?? 0, stdout: '' }
      }
      if (cmd === CODESIGN && args[0] === '--verify') return { code: fake.verifyCode ?? 0, stdout: '' }
      if (cmd === CODESIGN && args[0] === '-d') {
        if (fake.adHoc) return { code: 0, stdout: '' }
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
  return { deps, supportDir, appBundle, staging, downloads, urls, options, calls, statusPath: appUpdateStatusPath(supportDir) }
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

  // The end-to-end test's tampered build (Task 12): re-signed ad hoc, so `codesign -d` succeeds and
  // extracts nothing. That is not a certificate that could not be read; it is no certificate of ours.
  test('an app signed ad hoc, with no certificate at all, is not signed by the same certificate', async () => {
    await failsCleanly(setup({ adHoc: true }), /not signed by the same certificate/)
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

  // Bypass A from the review, as the reviewer built it: the directory lists a harmless link and a
  // regular file; the file's local header claims 4 bytes, and the rest of its data is a second local
  // header reusing the link's name with an escaping target, plus a hidden entry. ditto walks the local
  // headers by their own sizes and would make `l -> ../../..`.
  const BYPASS_A: WriteEntry[] = [
    { name: 'Parcels.app/l', link: 'A' },
    {
      name: 'Parcels.app/u',
      data: Buffer.concat([Buffer.from('abcd'), localHeader('Parcels.app/l', '../../..'), localHeader('P/hidden', 'x')]),
      local: { comp: 4 },
    },
  ]
  // Bypass B: APFS folds the long s into s, so "s/.." walks through the link "ſ -> ..".
  const BYPASS_B: WriteEntry[] = [
    { name: 'Parcels.app/\u017f', link: '..' },
    { name: 'Parcels.app/\ufb00', link: 's/..' },
  ]

  test('bypass A, a local header sized differently from the directory, is refused before ditto runs', async () => {
    const s = withZip([...LEGIT_APP, ...BYPASS_A])
    await failsCleanly(s)
    expect(s.calls).toEqual([])
  })

  test('bypass B, names that are not ASCII, is refused before ditto runs', async () => {
    const s = withZip([...LEGIT_APP, ...BYPASS_B])
    await failsCleanly(s)
    expect(s.calls).toEqual([])
  })

  const disagreements: Array<[string, WriteEntry]> = [
    ['flags', { name: 'Parcels.app/f', data: 'abcd', local: { flags: 0 } }],
    ['the CRC', { name: 'Parcels.app/f', data: 'abcd', local: { crc: 1 } }],
    ['the method', { name: 'Parcels.app/f', data: 'abcd', local: { method: 8 } }],
    ['the size', { name: 'Parcels.app/f', data: 'abcdefgh', local: { comp: 8 + 1 } }],
  ]
  for (const [what, entry] of disagreements) {
    test(`a local header that disagrees with the directory on ${what} is refused`, async () => {
      const s = withZip([...LEGIT_APP, entry])
      await failsCleanly(s)
      expect(s.calls).toEqual([])
    })
  }

  test('an entry with a data descriptor (bit 3) is refused', async () => {
    const s = withZip([...LEGIT_APP, { name: 'Parcels.app/f', data: 'abcd', deflate: true, flags: 0x0808 }])
    await failsCleanly(s)
    expect(s.calls).toEqual([])
  })

  test('a symlink target that is not ASCII is refused', async () => {
    const s = withZip([...LEGIT_APP, { name: 'Parcels.app/l', link: 'Contents/\u017f' }])
    await failsCleanly(s)
    expect(s.calls).toEqual([])
  })

  test('names with . or empty components are refused', async () => {
    await failsCleanly(withZip([...LEGIT_APP, { name: 'Parcels.app/./f', data: 'x' }]), OUTSIDE)
    await failsCleanly(withZip([...LEGIT_APP, { name: 'Parcels.app//f', data: 'x' }]), OUTSIDE)
  })

  // Round 3, P3: a deflated file whose stream ends early. Flags, CRC and sizes all agree, but ditto
  // finds the end of deflated data from the stream, and reads what follows it as further entries.
  const P3: WriteEntry[] = [
    { name: 'Parcels.app/f', data: 'real content '.repeat(20), deflate: true, trailing: localHeader('Parcels.app/hidden', 'x') },
  ]
  // P6: a directory entry that carries data; ditto skips a directory's data and reads what is in it.
  const P6: WriteEntry[] = [{ name: 'Parcels.app/d/', data: localHeader('Parcels.app/hidden', 'x') }]
  // P12: P3's trick used to rewrite two listed, harmless links into a chain that dangles above the folder.
  const P12: WriteEntry[] = [
    { name: 'Parcels.app/x', link: 'Contents' },
    { name: 'Parcels.app/y', link: 'Contents' },
    {
      name: 'Parcels.app/f', data: 'real content '.repeat(20), deflate: true,
      trailing: Buffer.concat([localHeader('Parcels.app/x', '..'), localHeader('Parcels.app/y', 'x/../nonexistent')]),
    },
  ]

  for (const [what, entries] of [['P3, a deflate stream that ends early', P3], ['P6, a directory with data', P6], ['P12, a short stream rewriting links', P12]] as const) {
    test(`${what}, is refused before ditto runs`, async () => {
      const s = withZip([...LEGIT_APP, ...entries])
      await failsCleanly(s, /not a zip this app can check/)
      expect(s.calls).toEqual([])
    })
  }

  test('a deflated entry whose data is corrupt is refused before ditto runs', async () => {
    const zip = makeZip([...LEGIT_APP, { name: 'Parcels.app/f', data: 'real content '.repeat(20), deflate: true }])
    // The first match is the local header; its data starts right after the name (no extra field).
    const at = zip.indexOf(Buffer.from('Parcels.app/f')) + 'Parcels.app/f'.length + 3
    zip[at] = zip[at]! ^ 0xff
    const s = setup({ zipBytes: zip, sums: `${sha(zip)}  ${ZIP}\n` })
    await failsCleanly(s, /not a zip this app can check/)
    expect(s.calls).toEqual([])
  })

  test('a link that lands on nothing the archive lists is refused before ditto runs', async () => {
    const s = withZip([...LEGIT_APP, { name: 'Parcels.app/l', link: 'Contents/nonexistent' }])
    await failsCleanly(s, OUTSIDE)
    expect(s.calls).toEqual([])
  })

  test('P12 got past ditto anyway: a dangling link in the unpacked tree is refused', async () => {
    const s = withZip([...LEGIT_APP, { name: 'Parcels.app/x', link: 'Contents' }, { name: 'Parcels.app/y', link: 'Contents' }])
    const fake = s.deps.run
    s.deps.run = async (cmd, args) => {
      const r = await fake(cmd, args)
      if (cmd === DITTO) {
        symlinkSync('..', join(args[3]!, 'Parcels.app', 'x'))
        symlinkSync('x/../nonexistent', join(args[3]!, 'Parcels.app', 'y'))
      }
      return r
    }
    await failsCleanly(s, OUTSIDE)
    expect(s.calls.some(([cmd]) => cmd === CODESIGN)).toBe(false)
  })

  // --- what ditto actually made ---

  const FW = join('Parcels.app', 'Contents', 'Frameworks', 'X.framework', 'Versions')

  test('a link that ditto made pointing outside is refused, and the clean-up does not follow it', async () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'still here')
    const s = setup({
      dittoExtra: staging => {
        mkdirSync(join(staging, FW), { recursive: true })
        symlinkSync(outside, join(staging, FW, 'Current'))
      },
    })
    await failsCleanly(s, OUTSIDE)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('still here')
    expect(s.calls.some(([cmd]) => cmd === CODESIGN)).toBe(false)
  })

  test('a file ditto made that the archive did not list is refused', async () => {
    const s = setup({ dittoExtra: staging => writeFileSync(join(staging, 'Parcels.app', 'Contents', 'evil.sh'), 'x') })
    await failsCleanly(s, OUTSIDE)
    expect(s.calls.some(([cmd]) => cmd === CODESIGN)).toBe(false)
  })

  test('an AppleDouble file ditto made is refused', async () => {
    await failsCleanly(setup({ dittoExtra: staging => writeFileSync(join(staging, 'Parcels.app', '._Contents'), 'x') }), OUTSIDE)
  })

  test('a listed file that ditto made as something else is refused', async () => {
    await failsCleanly(setup({ dittoExtra: staging => mkdirSync(join(staging, 'Parcels.app', 'Contents', 'Info.plist')) }), OUTSIDE)
  })

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

  test('each download is capped, and plain http on this Mac is allowed only when the release base is there', async () => {
    const github = setup()
    expect((await stageUpdate(github.deps)).state).toBe('staged')
    expect(github.options).toEqual([
      { allowLocalHttp: false, maxBytes: ZIP_MAX_BYTES }, { allowLocalHttp: false, maxBytes: SUMS_MAX_BYTES },
    ])
    const local = setup({}, { releaseBase: 'http://127.0.0.1:8899/v0.3.0/' })
    expect((await stageUpdate(local.deps)).state).toBe('staged')
    expect(local.options).toEqual([
      { allowLocalHttp: true, maxBytes: ZIP_MAX_BYTES }, { allowLocalHttp: true, maxBytes: SUMS_MAX_BYTES },
    ])
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

  test('lists names and symlink targets, stored or deflated', async () => {
    const entries = await readZipEntries(write(makeZip(LEGIT_APP)))
    expect(entries.map(e => e.name)).toEqual(LEGIT_APP.map(e => e.name))
    expect(entries.find(e => e.name.endsWith('Versions/Current'))).toMatchObject({ isSymlink: true, target: 'A' })
    expect(entries.find(e => e.name.endsWith('X.framework/Resources'))).toMatchObject({ isSymlink: true, target: 'Versions/Current/Resources' })
    expect(unsafeZipEntry(entries)).toBeUndefined()
  })

  test('a truncated zip is a format error', async () => {
    const zip = makeZip(LEGIT_APP)
    await expect(readZipEntries(write(zip.subarray(0, zip.length - 30)))).rejects.toThrow(ZipFormatError)
  })

  test('a name that is not valid UTF-8 is a format error', async () => {
    // A lone 0xC0 where the slash was: a lenient decoder and the unpacker could disagree about the name.
    const zip = makeZip([{ name: 'Parcels.app/a', data: 'x' }])
    const at = zip.lastIndexOf(Buffer.from('Parcels.app/a'))
    zip[at + 11] = 0xc0
    const first = zip.indexOf(Buffer.from('Parcels.app/a'))
    zip[first + 11] = 0xc0
    await expect(readZipEntries(write(zip))).rejects.toThrow(ZipFormatError)
  })

  test.skipIf(!existsSync('/usr/bin/zip'))('reads what /usr/bin/zip writes, symlinks included', async () => {
    const src = join(dir, 'src')
    mkdirSync(join(src, 'Parcels.app', 'Versions', 'A'), { recursive: true })
    writeFileSync(join(src, 'Parcels.app', 'Versions', 'A', 'bin'), 'x')
    symlinkSync('A', join(src, 'Parcels.app', 'Versions', 'Current'))
    const good = join(dir, 'good.zip')
    execFileSync('/usr/bin/zip', ['-q', '-r', '-y', good, 'Parcels.app'], { cwd: src })
    const entries = await readZipEntries(good)
    expect(entries.find(e => e.name === 'Parcels.app/Versions/Current')).toMatchObject({ isSymlink: true, target: 'A' })
    expect(unsafeZipEntry(entries)).toBeUndefined()

    symlinkSync('../../../../Library', join(src, 'Parcels.app', 'Versions', 'Out'))
    const evil = join(dir, 'evil.zip')
    execFileSync('/usr/bin/zip', ['-q', '-r', '-y', evil, 'Parcels.app'], { cwd: src })
    expect(unsafeZipEntry(await readZipEntries(evil))).toMatch(/outside/)
  })
})

describe('unsafeUnpackedTree', () => {
  const asListed = (entries: WriteEntry[]): ZipEntry[] =>
    entries.filter(e => !e.hidden).map(e => ({ name: e.name, isSymlink: e.link !== undefined, ...(e.link !== undefined && { target: e.link }) }))

  const build = (root: string, entries: WriteEntry[]) => {
    for (const e of entries) {
      const p = join(root, e.name)
      if (e.link !== undefined) { mkdirSync(dirname(p), { recursive: true }); symlinkSync(e.link, p) }
      else if (e.name.endsWith('/')) mkdirSync(p, { recursive: true })
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, e.data ?? '') }
    }
  }

  test('the app-shaped tree, framework links and all, passes', () => {
    const root = join(dir, 'staging')
    build(root, LEGIT_APP)
    expect(unsafeUnpackedTree(root, asListed(LEGIT_APP))).toBeUndefined()
  })

  // Electron's fs reads an app.asar as a folder, so inside the app the walk found Parcels.app's
  // app.asar to be "a dir the archive did not list as one" and refused every genuine update (the
  // end-to-end test, Task 12). The walk must see the disk as it is: process.noAsar for its duration.
  test('walks with Electron\'s asar support off, and puts it back as it was', () => {
    const root = join(dir, 'staging')
    const entries: WriteEntry[] = [...LEGIT_APP, { name: 'Parcels.app/Contents/Resources/app.asar', data: 'archive' }]
    build(root, entries)
    const seen: unknown[] = []
    let value: unknown = false
    const had = Object.getOwnPropertyDescriptor(process, 'noAsar')
    Object.defineProperty(process, 'noAsar', {
      configurable: true,
      get: () => value,
      set: v => { seen.push(v); value = v },
    })
    try {
      expect(unsafeUnpackedTree(root, asListed(entries))).toBeUndefined()
      expect(seen).toEqual([true, false])
      // A refusal returns early, and still restores it.
      seen.length = 0
      expect(unsafeUnpackedTree(root, asListed(LEGIT_APP))).toMatch(/the archive did not list/)
      expect(seen).toEqual([true, false])
    } finally {
      if (had) Object.defineProperty(process, 'noAsar', had)
      else delete (process as { noAsar?: unknown }).noAsar
    }
  })

  test('a chain that only leaves the folder once the file system follows it is refused', () => {
    const root = join(dir, 'staging')
    const entries: WriteEntry[] = [{ name: 'Parcels.app/' }, { name: 'Parcels.app/x', link: '..' }, { name: 'Parcels.app/y', link: 'x/..' }]
    build(root, entries)
    expect(unsafeUnpackedTree(root, asListed(entries))).toMatch(/resolves outside/)
  })

  // The real /usr/bin/ditto, on crafted zips, in temporary folders only. This is what the reviewer did:
  // it proves the walk catches both bypasses even if the archive check had let them through.
  const realDitto = test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/ditto'))
  const unpack = async (entries: WriteEntry[]) => {
    const zip = join(dir, 'u.zip')
    writeFileSync(zip, makeZip(entries))
    const root = join(dir, 'staging')
    await runCommand('/usr/bin/ditto', ['-x', '-k', zip, root])
    return root
  }

  realDitto('the real ditto unpacks the app-shaped zip into exactly what it lists', async () => {
    const root = await unpack(LEGIT_APP)
    expect(lstatSync(join(root, 'Parcels.app/Contents/Frameworks/X.framework/Versions/Current')).isSymbolicLink()).toBe(true)
    expect(unsafeUnpackedTree(root, asListed(LEGIT_APP))).toBeUndefined()
  })

  realDitto('after the real ditto, bypass A is caught by the walk', async () => {
    const entries: WriteEntry[] = [...LEGIT_APP,
      { name: 'Parcels.app/l', link: 'A' },
      { name: 'Parcels.app/u', data: Buffer.concat([Buffer.from('abcd'), localHeader('Parcels.app/l', '../../..'), localHeader('P/hidden', 'x')]), local: { comp: 4 } },
    ]
    const root = await unpack(entries)
    expect(unsafeUnpackedTree(root, asListed(entries))).toBeDefined()
  })

  realDitto('after the real ditto, bypass B is caught by the walk', async () => {
    const entries: WriteEntry[] = [...LEGIT_APP, { name: 'Parcels.app/\u017f', link: '..' }, { name: 'Parcels.app/\ufb00', link: 's/..' }]
    const root = await unpack(entries)
    expect(unsafeUnpackedTree(root, asListed(entries))).toMatch(/outside/)
  })

  // Round 3's three, through the real ditto: whatever it makes of them, the walk refuses the result.
  const P_REAL: Array<[string, WriteEntry[]]> = [
    ['P3', [{ name: 'Parcels.app/f', data: 'real content '.repeat(20), deflate: true, trailing: localHeader('Parcels.app/hidden', 'x') }]],
    ['P6', [{ name: 'Parcels.app/d/', data: localHeader('Parcels.app/hidden', 'x') }]],
    ['P12', [
      { name: 'Parcels.app/x', link: 'Contents' },
      { name: 'Parcels.app/y', link: 'Contents' },
      {
        name: 'Parcels.app/f', data: 'real content '.repeat(20), deflate: true,
        trailing: Buffer.concat([localHeader('Parcels.app/x', '..'), localHeader('Parcels.app/y', 'x/../nonexistent')]),
      },
    ]],
  ]
  for (const [what, extra] of P_REAL) {
    realDitto(`after the real ditto, ${what} is caught by the walk`, async () => {
      const entries = [...LEGIT_APP, ...extra]
      const root = await unpack(entries)
      expect(unsafeUnpackedTree(root, asListed(entries))).toBeDefined()
    })
  }

  realDitto('stageUpdate with the real ditto stages the app-shaped zip', async () => {
    const s = setup()
    const fake = s.deps.run
    s.deps.run = (cmd, args) => (cmd === DITTO ? runCommand(cmd, args) : fake(cmd, args))
    expect((await stageUpdate(s.deps)).state).toBe('staged')
  })
})

// --- the real fetch wrapper, with fetch stubbed, and the real download -------------------------------------------------------

describe('githubFetchJson', () => {
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
})

/**
 * A server on this Mac that answers as the simplest HTTP servers do (python's http.server among them):
 * HTTP/1.0, no length, the body ending when the connection closes. Undici (fetch) in Electron's Node
 * crashes the process on such a body when it arrives faster than the file is written
 * ("assert(!this.paused)"), which is why the download does not use fetch.
 */
async function rawServer(answer: (path: string) => { head: string; body?: Buffer; stall?: boolean }) {
  const seen: string[] = []
  const sockets: Array<{ destroy(): void }> = []
  const server = createNetServer(socket => {
    let req = ''
    socket.on('data', chunk => {
      req += chunk.toString('latin1')
      if (!req.includes('\r\n\r\n')) return
      const path = req.split(' ')[1] ?? '/'
      seen.push(path)
      const a = answer(path)
      socket.write(`${a.head}\r\n\r\n`)
      if (a.body) socket.write(a.body)
      if (a.stall) { sockets.push(socket); return }
      socket.end()
    })
    socket.on('error', () => {})
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`, seen,
    close: () => new Promise<void>(r => { for (const so of sockets) so.destroy(); server.close(() => r()) }),
  }
}

describe('defaultDownload', () => {
  const noFetch = () => vi.stubGlobal('fetch', async () => { throw new Error('the download must not use fetch') })
  /** The test servers are plain http on this Mac, which only a release base on this Mac allows. */
  const LOCAL: DownloadOptions = { allowLocalHttp: true }

  test('plain http on this Mac is refused without a request unless the release base is there too', async () => {
    noFetch()
    const srv = await rawServer(() => ({ head: 'HTTP/1.0 200 OK', body: Buffer.from('zip body') }))
    try {
      await expect(defaultDownload(`${srv.base}/y.zip`, join(dir, 'out.zip'))).rejects.toThrow(/not https/)
      expect(srv.seen).toEqual([])
    } finally { await srv.close() }
  })

  test('a redirect to plain http on this Mac is refused when the download did not start there', () => {
    // getFollowing checks every hop with the same flag the download was started with.
    expect(isSafeDownloadUrl('http://127.0.0.1:8899/y.zip', false)).toBe(false)
    expect(isSafeDownloadUrl('http://localhost/y.zip', false)).toBe(false)
    expect(isSafeDownloadUrl('http://127.0.0.1:8899/y.zip', true)).toBe(true)
    expect(isSafeDownloadUrl('http://example.com/y.zip', true)).toBe(false)
    expect(isSafeDownloadUrl('https://objects.githubusercontent.com/y.zip', false)).toBe(true)
  })

  test('a Content-Length above the cap is refused before the body is read', async () => {
    noFetch()
    const srv = await rawServer(() => ({ head: 'HTTP/1.1 200 OK\r\nContent-Length: 1000', body: Buffer.alloc(1000, 1) }))
    try {
      await expect(defaultDownload(`${srv.base}/y.zip`, join(dir, 'out.zip'), { ...LOCAL, maxBytes: 100 })).rejects.toThrow(/larger than/)
      expect(existsSync(join(dir, 'out.zip'))).toBe(false)
    } finally { await srv.close() }
  })

  test('a body that runs past the cap without saying its length is cut off', async () => {
    noFetch()
    const srv = await rawServer(() => ({ head: 'HTTP/1.0 200 OK', body: Buffer.alloc(64 * 1024, 1) }))
    try {
      await expect(defaultDownload(`${srv.base}/y.zip`, join(dir, 'out.zip'), { ...LOCAL, maxBytes: 1000 })).rejects.toThrow(/larger than/)
    } finally { await srv.close() }
  })

  test('a body shorter than its Content-Length fails', async () => {
    noFetch()
    const srv = await rawServer(() => ({ head: 'HTTP/1.1 200 OK\r\nContent-Length: 1000', body: Buffer.alloc(10, 1) }))
    try {
      await expect(defaultDownload(`${srv.base}/y.zip`, join(dir, 'out.zip'), LOCAL)).rejects.toThrow()
    } finally { await srv.close() }
  })

  test('a server that stops sending fails at the time limit', async () => {
    noFetch()
    const srv = await rawServer(() => ({ head: 'HTTP/1.1 200 OK\r\nContent-Length: 1000', body: Buffer.alloc(10, 1), stall: true }))
    try {
      await expect(defaultDownload(`${srv.base}/y.zip`, join(dir, 'out.zip'), { ...LOCAL, timeoutMs: 200 })).rejects.toThrow()
    } finally { await srv.close() }
  })

  test('streams a large body that ends when the server closes the connection, without fetch', async () => {
    noFetch()
    const body = Buffer.alloc(24 * 1024 * 1024, 7)
    const srv = await rawServer(() => ({ head: 'HTTP/1.0 200 OK\r\nContent-Type: application/zip', body }))
    try {
      const dest = join(dir, 'out.zip')
      await defaultDownload(`${srv.base}/y.zip`, dest, LOCAL)
      expect(statSync(dest).size).toBe(body.length)
      expect(sha(readFileSync(dest))).toBe(sha(body))
      expect(statSync(dest).mode & 0o777).toBe(0o600)
    } finally { await srv.close() }
  })

  test('follows a redirect, relative or absolute, on a safe address', async () => {
    noFetch()
    const srv = await rawServer(path => path === '/a' ? { head: 'HTTP/1.1 302 Found\r\nLocation: /b\r\nContent-Length: 0' }
      : path === '/b' ? { head: `HTTP/1.1 301 Moved\r\nLocation: http://127.0.0.1:${new URL(srvBase()).port}/c\r\nContent-Length: 0` }
      : { head: 'HTTP/1.0 200 OK', body: Buffer.from('zip body') })
    const srvBase = () => srv.base
    try {
      const dest = join(dir, 'out.zip')
      await defaultDownload(`${srv.base}/a`, dest, LOCAL)
      expect(readFileSync(dest, 'utf8')).toBe('zip body')
      expect(srv.seen).toEqual(['/a', '/b', '/c'])
    } finally { await srv.close() }
  })

  test('a download answered with 404 throws with the status', async () => {
    noFetch()
    const srv = await rawServer(() => ({ head: 'HTTP/1.0 404 Not Found', body: Buffer.from('nope') }))
    try {
      await expect(defaultDownload(`${srv.base}/y.zip`, join(dir, 'out.zip'), LOCAL)).rejects.toMatchObject({ status: 404 })
    } finally { await srv.close() }
  })

  test('a redirect to plain http elsewhere is refused before anything is asked of it', async () => {
    noFetch()
    const srv = await rawServer(() => ({ head: 'HTTP/1.1 302 Found\r\nLocation: http://objects.example.com/y.zip\r\nContent-Length: 0' }))
    try {
      await expect(defaultDownload(`${srv.base}/y.zip`, join(dir, 'out.zip'), LOCAL)).rejects.toThrow(/redirected away from https/)
      expect(srv.seen).toEqual(['/y.zip'])
    } finally { await srv.close() }
  })

  test('a redirect loop ends', async () => {
    noFetch()
    const srv = await rawServer(() => ({ head: 'HTTP/1.1 302 Found\r\nLocation: /again\r\nContent-Length: 0' }))
    try {
      await expect(defaultDownload(`${srv.base}/y.zip`, join(dir, 'out.zip'), LOCAL)).rejects.toThrow(/redirects/)
      expect(srv.seen.length).toBeLessThanOrEqual(6)
    } finally { await srv.close() }
  })

  test('plain http to another machine is refused without a request', async () => {
    noFetch()
    await expect(defaultDownload('http://example.com/y.zip', join(dir, 'out.zip'))).rejects.toThrow(/not https/)
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

describe('a test release feed (ruling R16)', () => {
  test('is read from PARCELS_RELEASES_URL when it is https, or http on this Mac', () => {
    expect(releasesUrlOverride({ PARCELS_RELEASES_URL: 'http://127.0.0.1:8899/releases/latest' })).toBe('http://127.0.0.1:8899/releases/latest')
    expect(releasesUrlOverride({ PARCELS_RELEASES_URL: 'https://example.com/releases/latest' })).toBe('https://example.com/releases/latest')
  })

  test('is ignored when absent, empty, plain http elsewhere, or not a URL', () => {
    expect(releasesUrlOverride({})).toBeUndefined()
    expect(releasesUrlOverride({ PARCELS_RELEASES_URL: '' })).toBeUndefined()
    expect(releasesUrlOverride({ PARCELS_RELEASES_URL: 'http://example.com/releases/latest' })).toBeUndefined()
    expect(releasesUrlOverride({ PARCELS_RELEASES_URL: 'not a url' })).toBeUndefined()
  })

  test('keeps the release\'s files beside it, laid out as GitHub lays them out', () => {
    expect(downloadBaseBeside('http://127.0.0.1:8899/releases/latest', '0.90.1')).toBe('http://127.0.0.1:8899/releases/download/v0.90.1')
  })

  test('is what the app\'s daily check asks when the main process passed one on', async () => {
    vi.stubEnv('PARCELS_HOST', 'app')
    vi.stubEnv('PARCELS_APP_VERSION', '0.2.0')
    vi.stubEnv('PARCELS_RELEASES_URL', 'http://127.0.0.1:8899/releases/latest')
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url)
      return new Response(JSON.stringify({ tag_name: 'v0.3.0', draft: false, prerelease: false, body: '' }), { status: 200 })
    })
    const check = await buildPollDeps(memDb(), config).updateCheck!.check!()
    expect(check).toMatchObject({ state: 'behind', version: '0.3.0' })
    expect(seen).toEqual(['http://127.0.0.1:8899/releases/latest'])
  })
})
