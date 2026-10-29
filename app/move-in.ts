import BetterSqlite3 from 'better-sqlite3'
import {
  chmodSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync,
  renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { authStorePathFor } from '../src/carriers/dpd.js'
import { loadConfig, readConfigDocument, validateConfig, writeConfigDocument } from '../src/core/config.js'

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
}

export type MoveInResult = { ok: true } | { ok: false; step: 'stop' | 'copy' | 'check' | 'park'; reason: string }

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
  let stopped = false
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

    // --- 1. Stop the old install, so nothing writes to the database while it is copied.
    stopped = true
    for (const plist of d.plists) {
      const label = labelOf(plist)
      const r = d.launchctl(['bootout', `gui/${d.uid}/${label}`])
      if (r.code !== 0 && !notLoaded(r)) {
        throw new StepError('stop', `launchctl could not stop ${label}: ${r.stderr.trim() || `exit ${r.code}`}`)
      }
    }

    // --- 2-5. Copy the database, the files beside it, and the config.
    const sourceData = dirname(sourceDb)
    const appDb = join(data, 'parcels.db')
    await (async () => {
      try {
        mkdirSync(d.support, { recursive: true, mode: 0o700 })
        // Chromium may have made the folder first, with its own looser mode.
        chmodSync(d.support, 0o700)
        writeFileSync(marker, '', { mode: 0o600 })
        madeMarker = true
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
    const after = rollBack()
    return { ok: false, step: failure.step, reason: after ? `${failure.message} ${after}` : failure.message }
  }

  /**
   * Undoes what the move did, newest first, and says how the old install was left. It removes only
   * what this attempt made (config.json, data/, its marker): the support folder also holds Chromium's
   * live state and the login-item marker, and may hold settings or data the move refused to replace,
   * none of which were the move's.
   */
  function rollBack(): string {
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
    if (!stopped) return problems.length ? `Cleaning up also failed (${problems.join('; ')}).` : ''

    // Started again in the reverse of the order they were stopped: the web page first.
    for (const plist of [...d.plists].reverse()) {
      const r = d.launchctl(['bootstrap', `gui/${d.uid}`, plist])
      if (r.code !== 0) problems.push(`launchctl could not start ${labelOf(plist)}: ${r.stderr.trim() || `exit ${r.code}`}`)
    }
    return problems.length
      ? `Putting the old install back did not fully work either (${problems.join('; ')}). To start it again, run scripts/install-agents.sh in ${d.clone}.`
      : 'The old install was started again.'
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
