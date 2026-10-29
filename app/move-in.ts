import BetterSqlite3 from 'better-sqlite3'
import {
  chmodSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { authStorePathFor } from '../src/carriers/dpd.js'
import { loadConfig, readConfigDocument, validateConfig, writeConfigDocument } from '../src/core/config.js'
import { LABELS, plistWorkingDirectory } from './first-run.js'

/**
 * Moving a git-clone install into the app (spec §4). It runs on friends' Macs and carries their only
 * copy of their parcel history and their Gmail App Password, so every step is undone on failure, and
 * nothing in the clone is ever deleted or changed: the clone only gains a `launchd-backup/` folder.
 */

export interface MoveInDeps {
  clone: string
  plists: string[]
  support: string
  uid: number
  /** Runs launchctl with these arguments. Injected, so no test can reach the real launchd. */
  launchctl: (args: string[]) => { code: number; stderr: string }
  /** Waiting on launchd. Injected so the tests do not wait for real; real timers by default. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * `oldInstall` says how a failed move left the git install: `running` (never stopped, or started
 * again) or `not-running` (starting it again did not work), so the page can say which, and what to do.
 */
export type MoveInResult =
  | { ok: true }
  | { ok: false; step: 'stop' | 'copy' | 'check' | 'park'; reason: string; oldInstall: 'running' | 'not-running' }

type Step = Exclude<MoveInResult, { ok: true }>['step']

/** The app's own database path, relative to config.json (§3). */
const APP_DB_PATH = 'data/parcels.db'

/**
 * Left in the support folder for as long as a move is under way. A move cut off by a power cut or a
 * force quit leaves a partial `data/` behind; this marker is how the next attempt knows that folder is
 * its own leftover, and not something else it must never remove.
 */
const MARKER = '.moving-in'

class StepError extends Error {
  constructor(readonly step: Step, message: string) { super(message) }
}

/** An error as one sentence for the result page: SQLite's and Node's messages carry no full stop. */
const message = (err: unknown) => {
  const m = (err instanceof Error ? err.message : String(err)).trim()
  return /[.!?)]$/.test(m) ? m : `${m}.`
}

/** Runs `f`, turning whatever it throws into a failure of `step`. */
function at<T>(step: Step, f: () => T): T {
  try {
    return f()
  } catch (err) {
    throw err instanceof StepError ? err : new StepError(step, message(err))
  }
}

/** The launchd label of a plist: install-agents.sh names each file after its label. */
const labelOf = (plist: string) => basename(plist, '.plist')

type Launchd = Pick<MoveInDeps, 'uid' | 'launchctl' | 'sleep' | 'now'>

const realSleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

/** How long a stopped job may linger in launchd before the stop counts as failed. */
export const STOP_WAIT_MS = 15_000
const STOP_POLL_MS = 500
/** Bootstrap attempts, and the pause after attempt n (n seconds), as scripts/install-agents.sh does. */
export const BOOTSTRAP_ATTEMPTS = 8

/**
 * Waits until launchd has let go of `label`. `bootout` returns before the job is fully gone: until it
 * is, its process may still be writing the database or holding the port, and a `bootstrap` of it fails
 * with EIO (scripts/install-agents.sh learned this on a real Mac). `launchctl print` failing is the
 * sign it is gone. True once gone, false if it is still there after STOP_WAIT_MS.
 */
async function waitGone(d: Launchd, label: string): Promise<boolean> {
  const sleep = d.sleep ?? realSleep
  const now = d.now ?? Date.now
  const deadline = now() + STOP_WAIT_MS
  for (;;) {
    if (d.launchctl(['print', `gui/${d.uid}/${label}`]).code !== 0) return true
    if (now() >= deadline) return false
    await sleep(STOP_POLL_MS)
  }
}

/** Stops one job and waits for it to be gone. 'stopped' if it was running, 'not-loaded' if it never was. */
async function stopJob(d: Launchd, label: string): Promise<'stopped' | 'not-loaded'> {
  const r = d.launchctl(['bootout', `gui/${d.uid}/${label}`])
  if (r.code !== 0) {
    if (notLoaded(r)) return 'not-loaded'
    throw new StepError('stop', `launchctl could not stop ${label}: ${r.stderr.trim() || `exit ${r.code}`}`)
  }
  if (!(await waitGone(d, label))) {
    throw new StepError('stop', `${label} was still running ${STOP_WAIT_MS / 1000} seconds after launchctl was told to stop it.`)
  }
  return 'stopped'
}

/**
 * Starts a job again from its plist: first waits for any trace of the stopped one to go, then tries up
 * to BOOTSTRAP_ATTEMPTS times with a growing pause, as install-agents.sh does. Undefined on success,
 * else launchctl's last word.
 */
async function startJob(d: Launchd, plist: string): Promise<string | undefined> {
  const sleep = d.sleep ?? realSleep
  await waitGone(d, labelOf(plist))
  let last = ''
  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
    const r = d.launchctl(['bootstrap', `gui/${d.uid}`, plist])
    if (r.code === 0) return undefined
    last = r.stderr.trim() || `exit ${r.code}`
    if (attempt < BOOTSTRAP_ATTEMPTS) await sleep(attempt * 1000)
  }
  return last
}

/**
 * launchctl's way of saying a job was not loaded in the first place, which for "stop it" is as good as
 * stopped: exit 3 (ESRCH), or the words "No such process".
 */
const notLoaded = (r: { code: number; stderr: string }) => r.code === 3 || /No such process/i.test(r.stderr)

/** Makes every directory under `dir` (and `dir`) 0700 and every file 0600, as the app keeps its data. */
function ownerOnly(dir: string): void {
  chmodSync(dir, 0o700)
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) ownerOnly(p)
    else if (e.isFile()) chmodSync(p, 0o600)
  }
}

/** A free name for `name` in `dir`: `name`, else `stem.2.plist`, `stem.3.plist`, … so an earlier backup is never replaced. */
function freeName(dir: string, name: string): string {
  const stem = basename(name, '.plist')
  let candidate = join(dir, name)
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${stem}.${n}.plist`)
  return candidate
}

/** Moves a file, falling back to copy-then-remove across volumes (rename cannot cross them). */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    copyFileSync(from, to, constants.COPYFILE_EXCL)
    unlinkSync(from)
  }
}

export async function moveIn(d: MoveInDeps): Promise<MoveInResult> {
  const data = join(d.support, 'data')
  const config = join(d.support, 'config.json')
  const pendingConfig = join(d.support, '.config.json.moving-in')
  const marker = join(d.support, MARKER)
  const backup = join(d.clone, 'launchd-backup')

  // What this move has done so far, so that a failure undoes exactly that and nothing else.
  /** The plists whose jobs this move stopped: only these are started again on failure. */
  const stopped: string[] = []
  let madeMarker = false
  let madeData = false
  let madePending = false
  let madeConfig = false
  let madeBackup = false
  const parked: Array<{ from: string; to: string }> = []

  try {
    // --- Before anything is stopped: everything that can be known to fail without touching launchd.
    const { cloneDoc, sourceDb } = at('copy', () => {
      const cloneDoc = readConfigDocument(join(d.clone, 'config.json'))
      // The same rules the app will apply: a config it would refuse is better found while the old
      // install is still running.
      const cloneConfig = validateConfig(cloneDoc, join(d.clone, 'config.json'))
      if (cloneConfig.dbPath === ':memory:') throw new Error('The old install keeps no database on disk, so there is nothing to move.')
      // As the git install reads it: relative to the clone (its config's folder) unless absolute.
      const sourceDb = isAbsolute(cloneConfig.dbPath) ? cloneConfig.dbPath : resolve(d.clone, cloneConfig.dbPath)
      if (!existsSync(sourceDb)) throw new Error(`There is no database at ${sourceDb}.`)
      if (existsSync(config)) throw new Error(`The app already has settings at ${config}.`)
      if (existsSync(data)) {
        // Only a leftover of an interrupted move may be cleared; anything else is not the app's to remove.
        if (!existsSync(marker)) throw new Error(`The app's folder already holds ${data}. Move that folder somewhere else, then try again.`)
        rmSync(data, { recursive: true, force: true })
      }
      return { cloneDoc, sourceDb }
    })

    // The marker goes down before anything is stopped. It names the clone and the plists, so a launch
    // after a crash between config.json and the parking can finish the job (finishInterruptedMoveIn).
    at('copy', () => {
      mkdirSync(d.support, { recursive: true, mode: 0o700 })
      // Chromium may have made the folder first, with its own looser mode.
      chmodSync(d.support, 0o700)
      writeFileSync(marker, `${JSON.stringify({ clone: d.clone, plists: d.plists })}\n`, { mode: 0o600 })
      madeMarker = true
    })

    // --- 1. Stop the old install and wait for launchd to let go, so nothing writes to the database
    // while it is copied and the old web page no longer holds the port the app's server will want.
    for (const plist of d.plists) {
      const label = labelOf(plist)
      const r = d.launchctl(['bootout', `gui/${d.uid}/${label}`])
      if (r.code !== 0) {
        if (notLoaded(r)) continue
        throw new StepError('stop', `launchctl could not stop ${label}: ${r.stderr.trim() || `exit ${r.code}`}`)
      }
      // Recorded before the wait: a job that was told to stop but lingers must be started again.
      stopped.push(plist)
      if (!(await waitGone(d, label))) {
        throw new StepError('stop', `${label} was still running ${STOP_WAIT_MS / 1000} seconds after launchctl was told to stop it.`)
      }
    }

    // --- 2-5. Copy the database, the files beside it, and the config.
    const sourceData = dirname(sourceDb)
    const appDb = join(data, 'parcels.db')
    await (async () => {
      try {
        mkdirSync(data, { mode: 0o700 })
        madeData = true
        chmodSync(data, 0o700)

        // SQLite's online backup, never a file copy: it reads through SQLite, so rows still in the WAL
        // are included and a half-written page never is.
        try {
          const source = new BetterSqlite3(sourceDb, { readonly: true, fileMustExist: true })
          try {
            await source.backup(appDb)
          } finally {
            source.close()
          }
        } catch (err) {
          throw new Error(`The old database at ${sourceDb} could not be read: ${message(err)}`)
        }
        repointMail(appDb, join(sourceData, 'mail'), join(data, 'mail'))
        for (const f of [appDb, `${appDb}-wal`, `${appDb}-shm`]) if (existsSync(f)) chmodSync(f, 0o600)

        // Mail, map tiles and the DPD sign-in live beside the database. Only what exists is copied, and
        // only directories and plain files: a link could point anywhere.
        for (const name of ['mail', 'tiles']) {
          const from = join(sourceData, name)
          if (!existsSync(from) || !lstatSync(from).isDirectory()) continue
          const to = join(data, name)
          cpSync(from, to, {
            recursive: true, preserveTimestamps: true, errorOnExist: true, force: false,
            filter: src => { const s = lstatSync(src); return s.isDirectory() || s.isFile() },
          })
          ownerOnly(to)
        }
        const dpdFrom = authStorePathFor(sourceDb)
        const dpdTo = authStorePathFor(appDb)
        if (dpdFrom && dpdTo && existsSync(dpdFrom) && lstatSync(dpdFrom).isFile()) {
          cpSync(dpdFrom, dpdTo, { preserveTimestamps: true, errorOnExist: true, force: false })
          chmodSync(dpdTo, 0o600)
        }

        // The clone's own document, every key kept, with the database where the app keeps it. It is
        // written under a temporary name: config.json appearing is what makes the next launch start
        // the app, so it must not exist before the copy has been checked.
        const doc = { ...cloneDoc }
        if (doc.dbPath !== undefined && doc.dbPath !== APP_DB_PATH) doc.dbPath = APP_DB_PATH
        madePending = true
        writeConfigDocument(pendingConfig, doc)
      } catch (err) {
        throw new StepError('copy', message(err))
      }
    })()

    // --- 6. Check the copy before the old install is put away.
    at('check', () => {
      const copy = new BetterSqlite3(appDb, { readonly: true, fileMustExist: true })
      try {
        const result = copy.pragma('integrity_check', { simple: true })
        if (result !== 'ok') throw new Error(`The copied database failed its check: ${String(result)}`)
      } finally {
        copy.close()
      }
      const loaded = loadConfig(pendingConfig)
      if (resolve(d.support, loaded.dbPath) !== appDb) throw new Error(`The copied settings point at ${loaded.dbPath}, not ${APP_DB_PATH}.`)
      renameSync(pendingConfig, config)
      madeConfig = true
    })

    // --- 7. Park the plists in the clone, so launchd never starts the old jobs again.
    at('park', () => {
      if (!existsSync(backup)) { mkdirSync(backup); madeBackup = true }
      for (const plist of d.plists) {
        const to = freeName(backup, basename(plist))
        moveFile(plist, to)
        parked.push({ from: plist, to })
      }
    })

    rmSync(marker, { force: true })
    return { ok: true }
  } catch (err) {
    const failure = err instanceof StepError ? err : new StepError('copy', message(err))
    const after = await rollBack()
    return {
      ok: false,
      step: failure.step,
      reason: after.said ? `${failure.message} ${after.said}` : failure.message,
      oldInstall: after.running ? 'running' : 'not-running',
    }
  }

  /**
   * Undoes what the move did, newest first, and says how the old install was left. It removes only
   * what this attempt made (config.json, data/, its marker): the support folder also holds Chromium's
   * live state and the login-item marker, and may hold settings or data the move refused to replace,
   * none of which were the move's.
   */
  async function rollBack(): Promise<{ said: string; running: boolean }> {
    const problems: string[] = []
    const attempt = (what: string, f: () => void) => {
      try { f() } catch (err) { problems.push(`${what}: ${message(err)}`) }
    }
    for (const p of parked.reverse()) attempt(`putting back ${p.from}`, () => moveFile(p.to, p.from))
    if (madeBackup) attempt('removing the empty launchd-backup folder', () => { if (readdirSync(backup).length === 0) rmdirSync(backup) })
    if (madeConfig) attempt('removing the copied settings', () => rmSync(config, { force: true }))
    if (madePending) attempt('removing the copied settings', () => rmSync(pendingConfig, { force: true }))
    if (madeData) attempt('removing the copied data', () => rmSync(data, { recursive: true, force: true }))
    if (madeMarker) attempt('removing the move marker', () => rmSync(marker, { force: true }))
    const cleanup = problems.length ? `Cleaning up also failed (${problems.join('; ')}).` : ''
    if (stopped.length === 0) return { said: cleanup, running: true }

    // Only the jobs this move stopped, in the reverse order: the web page first. A job that was not
    // loaded stays as the user left it, and one whose stop failed is still loaded.
    const failed: string[] = []
    for (const plist of [...stopped].reverse()) {
      const why = await startJob(d, plist)
      if (why !== undefined) failed.push(`launchctl could not start ${labelOf(plist)}: ${why}`)
    }
    if (failed.length) {
      return { said: [cleanup, `Starting the old install again did not work (${failed.join('; ')}).`].filter(Boolean).join(' '), running: false }
    }
    return { said: [cleanup, 'The old install was started again.'].filter(Boolean).join(' '), running: true }
  }
}

/**
 * The database records each stored email by its absolute path, which in the copy still points into
 * the clone. Left so, the app would read the clone's files, and dismissing an email would delete one
 * of them. Paths inside the clone's mail folder are pointed at the app's copy; any other path is left
 * as it was. Both spellings of the old folder are matched, as written and with links resolved.
 */
function repointMail(db: string, oldMail: string, newMail: string): void {
  const prefixes = [oldMail]
  try { prefixes.push(join(realpathSync(dirname(oldMail)), 'mail')) } catch { /* No folder, no real path. */ }
  const conn = new BetterSqlite3(db, { fileMustExist: true })
  try {
    const hasTable = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get()
    if (!hasTable) return
    const rows = conn.prepare('SELECT id, raw_path FROM messages WHERE raw_path IS NOT NULL').all() as Array<{ id: number; raw_path: string }>
    const update = conn.prepare('UPDATE messages SET raw_path = ? WHERE id = ?')
    conn.transaction(() => {
      for (const r of rows) {
        const prefix = prefixes.find(p => r.raw_path.startsWith(`${p}/`))
        if (prefix !== undefined) update.run(join(newMail, r.raw_path.slice(prefix.length + 1)), r.id)
      }
    })()
  } finally {
    conn.close()
  }
}

export type FinishResult = { kind: 'nothing' } | { kind: 'finished'; clone: string } | { kind: 'failed'; reason: string }

/**
 * Finishes a move that was cut off after config.json was in place but before the old plists were
 * parked (a crash, a power cut, a force quit in that moment). The app is then set up, but the old
 * jobs would start again at the next login and both installs would run. The `.moving-in` marker is
 * left in exactly that state; it names the clone and the plists. This stops the old jobs, waits for
 * launchd to let go, parks whichever plists are still in LaunchAgents, and removes the marker.
 *
 * Nothing is done without both config.json and the marker. A marker that cannot be read (from an
 * older build, or damaged) falls back to the web plist's WorkingDirectory and the two known labels.
 */
export async function finishInterruptedMoveIn(
  d: { support: string; launchAgents: string } & Launchd,
): Promise<FinishResult> {
  const marker = join(d.support, MARKER)
  if (!existsSync(join(d.support, 'config.json')) || !existsSync(marker)) return { kind: 'nothing' }
  try {
    let clone: string | undefined
    let plists: string[] | undefined
    try {
      const m = JSON.parse(readFileSync(marker, 'utf8')) as { clone?: unknown; plists?: unknown }
      if (typeof m.clone === 'string' && isAbsolute(m.clone)) clone = m.clone
      if (Array.isArray(m.plists) && m.plists.every(p => typeof p === 'string' && isAbsolute(p))) plists = m.plists as string[]
    } catch { /* Read below from the plists themselves. */ }
    plists ??= LABELS.map(label => join(d.launchAgents, `${label}.plist`))
    // Only the old install's own two jobs are ever stopped or moved, whatever the marker says.
    plists = plists.filter(p => (LABELS as readonly string[]).includes(labelOf(p)))
    const web = plists.find(p => labelOf(p) === 'local.parcels.web')
    if (clone === undefined && web !== undefined && existsSync(web)) clone = plistWorkingDirectory(readFileSync(web, 'utf8'))

    const left = plists.filter(p => existsSync(p))
    if (left.length > 0) {
      if (clone === undefined) throw new Error('It is not known which folder the old install is in.')
      for (const plist of left) await stopJob(d, labelOf(plist))
      const backup = join(clone, 'launchd-backup')
      if (!existsSync(backup)) mkdirSync(backup)
      for (const plist of left) moveFile(plist, freeName(backup, basename(plist)))
    }
    rmSync(marker, { force: true })
    return { kind: 'finished', clone: clone ?? '' }
  } catch (err) {
    return { kind: 'failed', reason: message(err) }
  }
}
