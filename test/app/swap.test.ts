import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  failedSwapToReveal, readSwapFailedMarker, removeRefusedStaging, shQuote, sweepOldCopies, swapScript, SWAP_WAIT_SECONDS, verifyStaged,
  type VerifyStagedDeps,
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

  /**
   * A process standing in for the running Parcels. `ps -o comm=` reports its argv[0], so `how` picks
   * what that is: the executable inside the installed app (`in-app`), an app's executable somewhere
   * else (`elsewhere`, a path that only ends in /Contents/MacOS/Parcels), or `./Parcels`, launched
   * from inside its MacOS folder (`relative`).
   */
  const startAppProcess = (seconds: number, how: 'in-app' | 'elsewhere' | 'relative' = 'in-app'): number => {
    const bundle = how === 'elsewhere' ? join(root, 'Seen elsewhere', 'Parcels.app') : app
    const macos = join(bundle, 'Contents', 'MacOS')
    mkdirSync(macos, { recursive: true })
    // A link to /bin/sleep: a copy of a system binary is killed by code signing, a link is not, and
    // ps reports argv[0], the path it was started by.
    symlinkSync('/bin/sleep', join(macos, 'Parcels'))
    // Started in the background by a shell that exits at once, so it is launchd's child, as the real
    // app is, and is reaped when it ends. As this test's own child it would linger as a zombie while
    // spawnSync blocks, and kill -0 would go on finding it.
    const script = how === 'relative'
      ? 'cd "$0" || exit 1; ./Parcels "$1" >/dev/null 2>&1 & echo $!'
      : '"$0/Parcels" "$1" >/dev/null 2>&1 & echo $!'
    const r = spawnSync('/bin/sh', ['-c', script, macos, String(seconds)], { encoding: 'utf8' })
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

  test('a process whose argv[0] is an app executable seen by another path, or ./Parcels, is still waited for', () => {
    for (const how of ['elsewhere', 'relative'] as const) {
      const f = fixture(`Applications ${how}`)
      const r = f.run(f.startAppProcess(1, how))
      expect(r.code).toBe(0)
      expect(r.ms).toBeGreaterThanOrEqual(700)
      expect(readdirSync(f.app).sort()).toEqual(['v2'])
    }
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


describe('removeRefusedStaging', () => {
  test('removes the staging folder Parcels makes for that version beside the app, and nothing else', () => {
    const appBundle = join(root, 'Applications', 'Parcels.app')
    mkdirSync(appBundle, { recursive: true })
    const staging = stagingDir(appBundle, VERSION)
    mkdirSync(join(staging, 'Parcels.app', 'Contents'), { recursive: true })
    const other = stagingDir(appBundle, '0.1.9')
    mkdirSync(other, { recursive: true })
    removeRefusedStaging(appBundle, VERSION)
    expect(existsSync(staging)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(appBundle)).toBe(true)
  })

  test('a version that is not one, or a bundle path that is not absolute, removes nothing', () => {
    const apps = join(root, 'Applications')
    mkdirSync(join(apps, '.Parcels-update-x'), { recursive: true })
    removeRefusedStaging(join(apps, 'Parcels.app'), '../../x')
    removeRefusedStaging('Parcels.app', VERSION)
    expect(readdirSync(apps)).toEqual(['.Parcels-update-x'])
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
      appBundle, staged, version: VERSION, running: '0.1.0', expectedCertSha: sha(CERT), workDir,
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

  test('a staged version that is not newer than the running app is refused before anything runs', async () => {
    const s = setup()
    for (const running of [VERSION, '0.3.0', 'not-a-version']) {
      await refused({ ...s.deps, running }, /^The update is not newer than the Parcels that is running, so it was not installed\.$/)
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

  test('an app re-signed ad hoc, which carries no certificate, is not signed by the same certificate', async () => {
    const s = setup({})
    const run = s.deps.run
    s.deps.run = async (cmd, args) => (cmd === CODESIGN && args[0] === '-d' ? { code: 0, stdout: '' } : run(cmd, args))
    await refused(s.deps, /not signed by the same certificate/)
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

describe('failedSwapToReveal', () => {
  const setup = () => {
    const appBundle = join(root, 'Applications', 'Parcels.app')
    const staged = join(stagingDir(appBundle, VERSION), 'Parcels.app')
    mkdirSync(staged, { recursive: true })
    mkdirSync(appBundle, { recursive: true })
    const marker = join(root, 'swap-failed')
    const logged: string[] = []
    const reveal = (text: string) => {
      writeFileSync(marker, text)
      const out = failedSwapToReveal(marker, appBundle, line => logged.push(line))
      expect(existsSync(marker)).toBe(false)
      return out
    }
    return { appBundle, staged, logged, reveal }
  }

  test('the staged copy Parcels made for that version is revealed', () => {
    const s = setup()
    expect(s.reveal(`${VERSION}\n${s.staged}`)).toEqual({ version: VERSION, staged: s.staged })
  })

  test('a path anywhere else is never revealed, however plausible, and the refusal is logged', () => {
    const s = setup()
    const evil = join(root, 'Downloads', 'Evil.app')
    mkdirSync(evil, { recursive: true })
    for (const staged of [evil, join(stagingDir(s.appBundle, '0.9.9'), 'Parcels.app'), `${s.staged}/`]) {
      expect(s.reveal(`${VERSION}\n${staged}`)).toBeUndefined()
    }
    // The version and the path must belong together: another version's folder is not this one's.
    mkdirSync(join(stagingDir(s.appBundle, '0.9.9'), 'Parcels.app'), { recursive: true })
    expect(s.reveal(`${VERSION}\n${join(stagingDir(s.appBundle, '0.9.9'), 'Parcels.app')}`)).toBeUndefined()
    expect(s.logged.length).toBeGreaterThanOrEqual(4)
  })

  test('a link at the right path is not revealed', () => {
    const s = setup()
    rmSync(s.staged, { recursive: true })
    symlinkSync(join(root, 'Applications'), s.staged)
    expect(s.reveal(`${VERSION}\n${s.staged}`)).toBeUndefined()
  })

  test('a staged copy that is gone is not revealed', () => {
    const s = setup()
    rmSync(s.staged, { recursive: true })
    expect(s.reveal(`${VERSION}\n${s.staged}`)).toBeUndefined()
  })

  test('a garbage version, or a running app outside a bundle, reveals nothing', () => {
    const s = setup()
    expect(s.reveal(`../../x\n${s.staged}`)).toBeUndefined()
    expect(s.reveal(`failed\n`)).toBeUndefined()
    writeFileSync(join(root, 'swap-failed'), `${VERSION}\n${s.staged}`)
    expect(failedSwapToReveal(join(root, 'swap-failed'), '', () => {})).toBeUndefined()
  })

  test('no marker is nothing to do, and nothing is logged', () => {
    const s = setup()
    expect(failedSwapToReveal(join(root, 'none'), s.appBundle, line => s.logged.push(line))).toBeUndefined()
    expect(s.logged).toEqual([])
  })
})

describe('sweepOldCopies', () => {
  const setup = () => {
    const apps = join(root, 'Applications')
    const appBundle = join(apps, 'Parcels.app')
    mkdirSync(appBundle, { recursive: true })
    const logged: string[] = []
    return { apps, appBundle, logged, sweep: () => sweepOldCopies(appBundle, line => logged.push(line)) }
  }
  const halfDeleted = (path: string) => {
    mkdirSync(join(path, 'Contents', 'Frameworks'), { recursive: true })
    writeFileSync(join(path, 'Contents', 'Frameworks', 'left'), 'x')
  }

  test('removes half-deleted Parcels.app.old-<version> copies beside the app', () => {
    const s = setup()
    halfDeleted(join(s.apps, 'Parcels.app.old-0.1.0'))
    halfDeleted(join(s.apps, 'Parcels.app.old-0.2.0-a'))
    s.sweep()
    expect(readdirSync(s.apps).sort()).toEqual(['Parcels.app'])
    expect(s.logged.join('\n')).toMatch(/Parcels\.app\.old-0\.1\.0/)
  })

  test('touches only names that match exactly with a real version', () => {
    const s = setup()
    const keep = ['Parcels.app.old-notaversion', 'Parcels.app.old-0.2.0x', 'Parcels.app.old-', 'Other.app.old-0.2.0',
      'xParcels.app.old-0.2.0', 'Parcels.app.old-../x', '.Parcels-update-0.2.0']
    for (const n of keep.filter(n => !n.includes('/'))) halfDeleted(join(s.apps, n))
    s.sweep()
    expect(readdirSync(s.apps).sort()).toEqual(['Parcels.app', ...keep.filter(n => !n.includes('/'))].sort())
  })

  test('a link with the name is removed as a link; what it points at is left alone', () => {
    const s = setup()
    const target = join(root, 'precious')
    halfDeleted(target)
    symlinkSync(target, join(s.apps, 'Parcels.app.old-0.1.0'))
    s.sweep()
    expect(existsSync(join(s.apps, 'Parcels.app.old-0.1.0'))).toBe(false)
    expect(readdirSync(join(target, 'Contents', 'Frameworks'))).toEqual(['left'])
  })

  test('a copy that cannot be removed is logged, and the rest are still swept', () => {
    const s = setup()
    const stuck = join(s.apps, 'Parcels.app.old-0.1.0')
    halfDeleted(stuck)
    halfDeleted(join(s.apps, 'Parcels.app.old-0.1.1'))
    // A folder whose contents cannot be removed, standing in for chflags or immutable files.
    chmodSync(join(stuck, 'Contents', 'Frameworks'), 0o555)
    try {
      expect(() => s.sweep()).not.toThrow()
      expect(existsSync(join(s.apps, 'Parcels.app.old-0.1.1'))).toBe(false)
      expect(existsSync(stuck)).toBe(true)
      expect(s.logged.join('\n')).toMatch(/could not remove .*Parcels\.app\.old-0\.1\.0/)
    } finally {
      chmodSync(join(stuck, 'Contents', 'Frameworks'), 0o755)
    }
  })

  test('the running bundle itself is never swept, even when it runs from an .old copy', () => {
    const s = setup()
    const running = join(s.apps, 'Parcels.app.old-0.1.0')
    halfDeleted(running)
    sweepOldCopies(running, () => {})
    expect(existsSync(running)).toBe(true)
  })

  test('an app outside a bundle, or a folder that cannot be read, sweeps nothing and does not throw', () => {
    expect(() => sweepOldCopies('', () => {})).not.toThrow()
    expect(() => sweepOldCopies(join(root, 'nowhere', 'Parcels.app'), () => {})).not.toThrow()
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
