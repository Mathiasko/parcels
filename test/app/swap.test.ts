import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  readSwapFailedMarker, shQuote, swapScript, SWAP_WAIT_SECONDS, verifyStaged, type VerifyStagedDeps,
} from '../../app/swap.js'
import { APP_BUNDLE_ID, CODESIGN, PLUTIL, stagingDir } from '../../src/core/app-update.js'

const VERSION = '0.2.0'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

let root: string
let sleepers: number[] = []

beforeEach(() => {
  // The real path, so the path a process is started from is the one `ps` reports and the script compares.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'parcels-swap-')))
})
afterEach(() => {
  for (const pid of sleepers) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
  sleepers = []
  rmSync(root, { recursive: true, force: true })
})

describe('shQuote', () => {
  test('wraps in single quotes and escapes an embedded one as the four characters quote-backslash-quote-quote', () => {
    expect(shQuote('/a b')).toBe("'/a b'")
    expect(shQuote("it's")).toBe("'it'\\''s'")
    expect(shQuote('')).toBe("''")
  })

  test('the shell reads back exactly the value, whatever it holds', () => {
    for (const v of ["it's", 'a $(touch x) `touch y` $HOME "q" \\ ; & | > <', "'", "''", 'line\nbreak', '*']) {
      const r = spawnSync('/bin/sh', ['-c', `printf '%s' ${shQuote(v)}`], { cwd: root, encoding: 'utf8' })
      expect(r.stdout).toBe(v)
    }
    expect(readdirSync(root)).toEqual([])
  })
})

/**
 * An installed app and a staged one, beside each other as `stageUpdate` leaves them, under `parent`
 * (whose name a test may make as awkward as it likes); a stub `open` on PATH that records what it was
 * asked to open and whether ELECTRON_RUN_AS_NODE reached it; and a working directory of its own, so a
 * command smuggled into a path that did run would leave a file there.
 */
function fixture(parent = 'Applications', o: { staged?: boolean } = {}) {
  const apps = join(root, parent)
  const app = join(apps, 'Parcels.app')
  const staging = stagingDir(app, VERSION)
  const staged = join(staging, 'Parcels.app')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(app, 'v1'), 'old')
  mkdirSync(staging, { recursive: true })
  if (o.staged !== false) {
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'v2'), 'new')
  }
  const updates = join(root, parent, 'support', 'updates')
  mkdirSync(updates, { recursive: true })
  const marker = join(updates, 'swap-failed')

  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const openLog = join(root, 'open.log')
  writeFileSync(join(bin, 'open'), '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$OPEN_LOG"\nprintf \'%s\\n\' "${ELECTRON_RUN_AS_NODE-unset}" >> "$OPEN_LOG.env"\n')
  chmodSync(join(bin, 'open'), 0o755)
  const cwd = join(root, 'cwd')
  mkdirSync(cwd, { recursive: true })

  const opened = () => (existsSync(openLog) ? readFileSync(openLog, 'utf8').split('\n').filter(Boolean) : [])
  const openEnv = () => (existsSync(`${openLog}.env`) ? readFileSync(`${openLog}.env`, 'utf8').split('\n').filter(Boolean) : [])

  /** Writes the script to a folder of its own and runs it with /bin/sh, as the main process does. */
  const run = (pid: number, waitSeconds?: number) => {
    const script = swapScript({ pid, app, staged, version: VERSION, marker, ...(waitSeconds !== undefined && { waitSeconds }) })
    const scripts = join(root, 'scripts')
    mkdirSync(scripts, { recursive: true })
    const file = join(scripts, 'swap.sh')
    writeFileSync(file, script)
    const started = Date.now()
    const r = spawnSync('/bin/sh', [file], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      // Set here as some terminals set it: the script must keep it away from `open`.
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, OPEN_LOG: openLog, ELECTRON_RUN_AS_NODE: '1' },
    })
    return { code: r.status, stderr: r.stderr, ms: Date.now() - started }
  }

  /** A process whose executable is inside the installed app, as the running Parcels's is. */
  const startAppProcess = (seconds: number): number => {
    const exe = join(app, 'Contents', 'MacOS', 'Parcels')
    // A link to /bin/sleep: a copy of a system binary is killed by code signing, a link is not, and
    // ps reports the path the process was started from, which is inside the app.
    symlinkSync('/bin/sleep', exe)
    // Started in the background by a shell that exits at once, so it is launchd's child, as the real
    // app is, and is reaped when it ends. As this test's own child it would linger as a zombie while
    // spawnSync blocks, and kill -0 would go on finding it.
    const r = spawnSync('/bin/sh', ['-c', '"$0" "$1" >/dev/null 2>&1 & echo $!', exe, String(seconds)], { encoding: 'utf8' })
    const pid = Number(r.stdout.trim())
    sleepers.push(pid)
    return pid
  }

  return { apps, app, staging, staged, marker, cwd, opened, openEnv, run, startAppProcess }
}

/** A PID that has certainly exited: a process that ran and was waited for. */
const exitedPid = (): number => spawnSync('/usr/bin/true').pid

describe('swapScript, run for real by /bin/sh on temporary folders', () => {
  test('the staged app takes the old one\'s place, the old copy and the staging folder go, and the app is opened', () => {
    const f = fixture()
    const r = f.run(exitedPid())
    expect(r.code).toBe(0)
    expect(readdirSync(f.app).sort()).toEqual(['v2'])
    expect(existsSync(`${f.app}.old-${VERSION}`)).toBe(false)
    expect(existsSync(f.staging)).toBe(false)
    expect(existsSync(f.marker)).toBe(false)
    expect(f.opened()).toEqual([f.app])
    expect(readdirSync(f.apps).sort()).toEqual(['Parcels.app', 'support'])
  })

  test('open runs without ELECTRON_RUN_AS_NODE, which would make the app binary run as plain Node', () => {
    const f = fixture()
    f.run(exitedPid())
    expect(f.openEnv()).toEqual(['unset'])
  })

  test('a staged app that is not there puts the old one back, leaves the marker with the version and the path, and still opens the app', () => {
    const f = fixture('Applications', { staged: false })
    const r = f.run(exitedPid())
    expect(r.code).not.toBe(0)
    expect(readdirSync(f.app).sort()).toEqual(['Contents', 'v1'])
    expect(existsSync(`${f.app}.old-${VERSION}`)).toBe(false)
    expect(readFileSync(f.marker, 'utf8')).toBe(`${VERSION}\n${f.staged}`)
    expect(f.opened()).toEqual([f.app])
    // The staging folder is what Finder will show, so a failed swap leaves it alone.
    expect(existsSync(f.staging)).toBe(true)
  })

  test('an old app that cannot be moved aside is left as it is, with the marker, and opened', () => {
    const f = fixture()
    // A read-only folder: the app cannot be renamed inside it.
    chmodSync(f.apps, 0o555)
    try {
      const r = f.run(exitedPid())
      expect(r.code).not.toBe(0)
    } finally {
      chmodSync(f.apps, 0o755)
    }
    expect(readdirSync(f.app).sort()).toEqual(['Contents', 'v1'])
    expect(existsSync(f.staged)).toBe(true)
    expect(readFileSync(f.marker, 'utf8')).toBe(`${VERSION}\n${f.staged}`)
    expect(f.opened()).toEqual([f.app])
  })

  test('a leftover .old copy from an earlier attempt does not swallow the app', () => {
    const f = fixture()
    mkdirSync(`${f.app}.old-${VERSION}`)
    writeFileSync(join(`${f.app}.old-${VERSION}`, 'stale'), '')
    expect(f.run(exitedPid()).code).toBe(0)
    expect(readdirSync(f.app).sort()).toEqual(['v2'])
    expect(existsSync(`${f.app}.old-${VERSION}`)).toBe(false)
  })

  test('paths with spaces, a single quote, $(...), a backtick and shell punctuation are values, never code', () => {
    const awkward = "it's a $(touch pwned1) `touch pwned2` dir; touch pwned3 & | \"q\" $HOME"
    const f = fixture(awkward)
    expect(f.run(exitedPid()).code).toBe(0)
    expect(readdirSync(f.app).sort()).toEqual(['v2'])
    expect(existsSync(f.staging)).toBe(false)
    expect(f.opened()).toEqual([f.app])
    expect(readdirSync(f.cwd)).toEqual([])
    expect(readdirSync(root).filter(n => n.startsWith('pwned'))).toEqual([])
    expect(readdirSync(f.apps).filter(n => n.startsWith('pwned'))).toEqual([])
  })

  test('the failure branch with the same awkward path writes the marker byte for byte and runs nothing', () => {
    const awkward = "it's a $(touch pwned1) `touch pwned2` dir; touch pwned3"
    const f = fixture(awkward, { staged: false })
    expect(f.run(exitedPid()).code).not.toBe(0)
    expect(readFileSync(f.marker, 'utf8')).toBe(`${VERSION}\n${f.staged}`)
    expect(f.opened()).toEqual([f.app])
    expect(readdirSync(f.cwd)).toEqual([])
    expect(readdirSync(root).filter(n => n.startsWith('pwned'))).toEqual([])
  })

  test('it waits for the app to exit before touching it', () => {
    const f = fixture()
    const r = f.run(f.startAppProcess(1))
    expect(r.code).toBe(0)
    expect(r.ms).toBeGreaterThanOrEqual(700)
    expect(readdirSync(f.app).sort()).toEqual(['v2'])
  })

  test('an app that never exits is given up on after the bound: nothing is swapped and the old app is opened', () => {
    const f = fixture()
    const r = f.run(f.startAppProcess(30), 1)
    expect(r.code).not.toBe(0)
    expect(r.ms).toBeLessThan(5_000)
    expect(readdirSync(f.app).sort()).toEqual(['Contents', 'v1'])
    expect(existsSync(f.staged)).toBe(true)
    expect(existsSync(f.marker)).toBe(false)
    expect(f.opened()).toEqual([f.app])
  })

  test('a PID already given to another program is not waited for', () => {
    const f = fixture()
    // This test runner is alive, and its executable is node, not anything inside the app.
    const r = f.run(process.pid)
    expect(r.code).toBe(0)
    expect(r.ms).toBeLessThan(3_000)
    expect(readdirSync(f.app).sort()).toEqual(['v2'])
  })

  test('the wait is bounded at about a minute by default', () => {
    expect(SWAP_WAIT_SECONDS).toBe(60)
    const s = swapScript({ pid: 1, app: '/A/Parcels.app', staged: '/A/.Parcels-update-0.2.0/Parcels.app', version: VERSION, marker: '/m' })
    expect(s).toMatch(/tries=300\b/)
  })

  test('refuses a PID, version or path it could not write safely', () => {
    const ok = { pid: 10, app: '/A/Parcels.app', staged: '/A/.Parcels-update-0.2.0/Parcels.app', version: VERSION, marker: '/m' }
    expect(() => swapScript({ ...ok, pid: 0 })).toThrow()
    expect(() => swapScript({ ...ok, pid: 1.5 })).toThrow()
    expect(() => swapScript({ ...ok, version: '0.2.0; rm -rf ~' })).toThrow()
    expect(() => swapScript({ ...ok, app: 'Parcels.app' })).toThrow()
    expect(() => swapScript({ ...ok, staged: '' })).toThrow()
    expect(() => swapScript({ ...ok, marker: 'rel' })).toThrow()
    expect(() => swapScript({ ...ok, app: '/A/Parcels.app\0x' })).toThrow()
  })
})


describe('verifyStaged', () => {
  const CERT = 'the leaf certificate, in DER'

  function setup(fake: {
    verifyCode?: number; cert?: string; bundleId?: string; bundleVersion?: string; noCert?: boolean
  } = {}, over: Partial<VerifyStagedDeps> = {}) {
    const apps = join(root, 'Applications')
    const appBundle = join(apps, 'Parcels.app')
    const staged = join(stagingDir(appBundle, VERSION), 'Parcels.app')
    mkdirSync(join(staged, 'Contents'), { recursive: true })
    mkdirSync(appBundle, { recursive: true })
    const workDir = join(root, 'support', 'updates')
    const calls: Array<[string, string[]]> = []
    const deps: VerifyStagedDeps = {
      appBundle, staged, version: VERSION, expectedCertSha: sha(CERT), workDir,
      run: async (cmd, args) => {
        calls.push([cmd, args])
        if (cmd === CODESIGN && args[0] === '--verify') return { code: fake.verifyCode ?? 0, stdout: '' }
        if (cmd === CODESIGN && args[0] === '-d') {
          if (fake.noCert) return { code: 1, stdout: '' }
          const prefix = args.find(a => a.startsWith('--extract-certificates='))!.slice('--extract-certificates='.length)
          writeFileSync(`${prefix}0`, fake.cert ?? CERT)
          return { code: 0, stdout: '' }
        }
        if (cmd === PLUTIL) {
          if (args[1] === 'CFBundleIdentifier') return { code: 0, stdout: `${fake.bundleId ?? APP_BUNDLE_ID}\n` }
          if (args[1] === 'CFBundleShortVersionString') return { code: 0, stdout: `${fake.bundleVersion ?? VERSION}\n` }
        }
        return { code: 127, stdout: '' }
      },
      ...over,
    }
    return { deps, calls, staged, appBundle, workDir }
  }

  const refused = async (deps: VerifyStagedDeps, pattern: RegExp) => {
    const out = await verifyStaged(deps)
    expect(out).toBeDefined()
    expect(out!.reason).toMatch(pattern)
    expect(out!.reason).toMatch(/^[A-Z].*\.$/)
    return out!
  }

  test('a staged app where Parcels put it, signed by our certificate, with our identity and that version, passes', async () => {
    const s = setup()
    expect(await verifyStaged(s.deps)).toBeUndefined()
    expect(s.calls[0]).toEqual([CODESIGN, ['--verify', '--deep', '--strict', s.staged]])
    expect(s.calls[1]![1][0]).toBe('-d')
    expect(s.calls.map(c => c[0])).toEqual([CODESIGN, CODESIGN, PLUTIL, PLUTIL])
    // The extracted certificates are not left in the support folder.
    expect(existsSync(s.workDir) ? readdirSync(s.workDir) : []).toEqual([])
  })

  test('a path other than the staging folder Parcels made for this version is refused before anything runs', async () => {
    const s = setup()
    const elsewhere = join(root, 'Elsewhere', 'Parcels.app')
    mkdirSync(elsewhere, { recursive: true })
    for (const staged of [
      elsewhere,
      join(stagingDir(s.appBundle, '0.1.9'), 'Parcels.app'),
      `${dirname(s.staged)}/../.Parcels-update-${VERSION}/Parcels.app`,
      `${s.staged}/`,
    ]) {
      await refused({ ...s.deps, staged }, /not where Parcels put it/)
    }
    expect(s.calls).toEqual([])
  })

  test('a staged app that is gone, or is a link, is refused before anything runs', async () => {
    const s = setup()
    rmSync(s.staged, { recursive: true })
    await refused(s.deps, /no longer there/)
    symlinkSync(root, s.staged)
    await refused(s.deps, /no longer there/)
    expect(s.calls).toEqual([])
  })

  test('a version that is not one, or an app outside a bundle, is refused', async () => {
    const s = setup()
    await refused({ ...s.deps, version: '../x' }, /not where Parcels put it/)
    await refused({ ...s.deps, appBundle: '' }, /not where Parcels put it/)
    expect(s.calls).toEqual([])
  })

  test('a broken signature is refused', async () => {
    await refused(setup({ verifyCode: 1 }).deps, /signature is broken/)
  })

  test('another certificate is refused', async () => {
    await refused(setup({ cert: 'somebody else' }).deps, /same certificate/)
  })

  test('a certificate that cannot be read is refused', async () => {
    await refused(setup({ noCert: true }).deps, /certificate could not be read/)
  })

  test('an app that does not know its own certificate installs nothing', async () => {
    await refused(setup({}, { expectedCertSha: '' }).deps, /does not know its own certificate/)
  })

  test('another bundle identifier, or another version, is refused', async () => {
    await refused(setup({ bundleId: 'local.parcelsspike.app' }).deps, /not the version it claims/)
    await refused(setup({ bundleVersion: '0.1.9' }).deps, /not the version it claims/)
  })
})

describe('readSwapFailedMarker', () => {
  test('gives the version and the staged path, and removes the marker', () => {
    const marker = join(root, 'swap-failed')
    const staged = join(root, "it's here", 'Parcels.app')
    writeFileSync(marker, `${VERSION}\n${staged}`)
    expect(readSwapFailedMarker(marker)).toEqual({ version: VERSION, staged })
    expect(existsSync(marker)).toBe(false)
  })

  test('no marker is nothing to do', () => {
    expect(readSwapFailedMarker(join(root, 'swap-failed'))).toBeUndefined()
  })

  test('a marker that cannot be read sensibly is removed and ignored', () => {
    const marker = join(root, 'swap-failed')
    for (const text of ['failed\n', '', 'not a version\n/x/Parcels.app', `${VERSION}\nrelative/Parcels.app`, `${VERSION}`]) {
      writeFileSync(marker, text)
      expect(readSwapFailedMarker(marker)).toBeUndefined()
      expect(existsSync(marker)).toBe(false)
    }
  })
})
