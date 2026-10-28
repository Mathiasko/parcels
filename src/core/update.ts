import { execFile, spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Database } from '../db/index.js'
import type { Cause, UpdateLogOutcome } from '../db/activity-log.js'
import { logAction } from '../db/activity-log.js'
import {
  dueForUpdateCheck, loggedUpdateStart, markUpdateLogged, recordUpdateCheck, recordUpdateInstalled,
  UPDATE_CHECK_INTERVAL_MS,
} from '../db/update-state.js'
import { repoRoot } from './version.js'

/**
 * Updating this app without a terminal.
 *
 * The git is all in `scripts/update.sh`, which already refuses a dirty tree, a divergent branch, a
 * detached HEAD and a directory that is not a checkout. Nothing here reimplements any of that: this
 * module runs that script in two modes and reads what it says.
 *
 *   `--check --porcelain`   one `git fetch`, then `key value` lines. Run at most once a day from
 *                           inside a poll, and by the Check button. It moves remote-tracking refs
 *                           and touches neither the working tree nor the branch.
 *   the update itself       `scripts/update-run.sh`, DETACHED. The update re-bootstraps the launchd
 *                           web agent, i.e. it kills the very process that started it, and
 *                           `launchctl bootout` signals the whole process group - so a child spawned
 *                           the ordinary way dies in the middle of `npm ci` and leaves a
 *                           half-installed tree. Its own session, and its output to a file rather
 *                           than to a pipe nobody will be alive to read.
 *
 * Because the parent does not survive to see how it went, the outcome travels through a file
 * (`data/update-status.json`) that the wrapper writes and the next page view reads - the same
 * recover-on-the-next-look shape as `reapStaleRuns`. `adoptUpdateOutcome` is what turns that file
 * into an activity-log entry, once.
 *
 * Nothing here is ever allowed to throw at its caller: a check is decoration on a diagnostics page
 * and must not be able to fail a poll, and a status file somebody edited by hand must not be able to
 * take /health down.
 */

export { UPDATE_CHECK_INTERVAL_MS }

/** How long `scripts/update.sh --check` is given. A `git fetch` over https, so seconds, not minutes. */
export const UPDATE_CHECK_TIMEOUT_MS = 60_000

/**
 * An update still unfinished after this long is not running. `npm ci` on a cold cache plus a build
 * plus two `launchctl bootstrap` retries is a couple of minutes; this is generous by an order of
 * magnitude, because the cost of being wrong in one direction is a page that says "still going" for
 * a few extra minutes and in the other a page that says an update failed while it is working.
 */
export const UPDATE_STALE_MS = 20 * 60_000

/** How many of the commits that would be installed the page lists, and how much of each subject. */
export const CHANGES_SHOWN = 20
export const CHANGE_MAX = 120
/** How much of a refusal is kept. It is one sentence from update.sh, printed on the page. */
export const REASON_MAX = 300

/**
 * Where this checkout stands against its upstream.
 *
 * `unknown` is "never looked", which is the state of a fresh install before its first poll; it is a
 * state rather than an absent row because `markUpdateLogged` can create the row before any check has
 * been made. `ahead` is somebody's own commits on top - not an update, and not a fault. `blocked` is
 * every refusal `scripts/update.sh` makes, with the sentence it made it in.
 */
export type UpdateState = 'unknown' | 'current' | 'behind' | 'ahead' | 'blocked'

export interface UpdateCheck {
  state: UpdateState
  /** How many commits behind the upstream. Zero unless `state` is `behind`. */
  behind: number
  /** The one-line subjects of the commits that would be installed, newest first. */
  changes: string[]
  version?: string
  branch?: string
  upstream?: string
  localSha?: string
  remoteSha?: string
  /** Why this checkout cannot be updated; set only when `state` is `blocked`. */
  reason?: string
}

/** What running `scripts/update.sh` produced. A `status` of null means it could not be run at all. */
export interface ScriptResult {
  status: number | null
  stdout: string
  stderr: string
}

/** The seam every test substitutes, so nothing in the suite spawns git or touches a repository. */
export type ScriptRunner = (args: readonly string[]) => ScriptResult

/**
 * The same seam for a caller that must not block: the web server. A `git fetch` can take the whole
 * `UPDATE_CHECK_TIMEOUT_MS`, and a synchronous spawn inside a request handler stops every other page
 * for that long. A synchronous runner is accepted too, so a test's stub serves both.
 */
export type AsyncScriptRunner = (args: readonly string[]) => ScriptResult | Promise<ScriptResult>

const SHA = /^[0-9a-f]{4,40}$/
/** A branch, an upstream or a version: git's own and package.json's, never free text. */
const WORD = /^[A-Za-z0-9][A-Za-z0-9._@/+-]{0,79}$/

/** Control characters out, ends trimmed. Applied to every line before it is looked at. */
const clean = (s: string): string => s.replace(/[\u0000-\u001F\u007F]/g, ' ').trim()

const firstLine = (s: string): string | undefined => {
  for (const line of s.split('\n')) {
    const t = clean(line)
    if (t !== '') return t
  }
  return undefined
}

const sha = (v: string | undefined): string | undefined => (v !== undefined && SHA.test(v) ? v : undefined)
const word = (v: string | undefined): string | undefined => (v !== undefined && WORD.test(v) ? v : undefined)

/**
 * Reads `scripts/update.sh --check --porcelain`.
 *
 * The contract is `key value` lines, which is why there is a `--porcelain` at all: the human output is
 * prose, and a page that parsed prose would quietly start reporting "up to date" the day a sentence
 * was reworded. Unknown keys are ignored, so the script may add lines; a repeated key keeps the first.
 *
 * A non-zero exit is `blocked`, always, whatever the output says. Every success path of that script
 * exits 0, so a non-zero exit means a refusal or a crash - and the one mistake this function must
 * never make is reporting a crash as "up to date".
 */
export function parseUpdateCheck(r: ScriptResult): UpdateCheck {
  const fields = new Map<string, string>()
  const changes: string[] = []
  for (const line of r.stdout.split('\n')) {
    const at = line.indexOf(' ')
    if (at <= 0) continue
    const key = line.slice(0, at)
    const value = clean(line.slice(at + 1))
    if (key === 'log') {
      if (changes.length < CHANGES_SHOWN && value !== '') changes.push(value.slice(0, CHANGE_MAX))
    } else if (!fields.has(key)) {
      fields.set(key, value)
    }
  }

  const blocked = (reason: string): UpdateCheck =>
    ({ state: 'blocked', behind: 0, changes: [], reason: reason.slice(0, REASON_MAX) })
  const state = fields.get('state')
  const why = () => fields.get('reason') || firstLine(r.stderr) || firstLine(r.stdout) || 'the update check could not be run'
  if (r.status !== 0 || state === undefined || state === 'blocked') return blocked(why())
  if (state !== 'current' && state !== 'behind' && state !== 'ahead') return blocked(why())

  const common = {
    version: word(fields.get('version')),
    branch: word(fields.get('branch')),
    upstream: word(fields.get('upstream')),
    localSha: sha(fields.get('local')),
    remoteSha: sha(fields.get('remote')),
  }
  if (state !== 'behind') return { state, behind: 0, changes: [], ...common }

  // "behind" with no number is not an answer: the page prints the count, and the button offers to
  // install that many commits. An unreadable one is a malformed report, not an update.
  const behind = Number(fields.get('behind'))
  if (!Number.isInteger(behind) || behind < 1) {
    return blocked('update.sh said this checkout is behind but did not say by how many commits')
  }
  return { state, behind, changes, ...common }
}

/** Runs `scripts/update.sh` in `root`. No shell: the arguments reach the script exactly as given. */
export const updateScriptRunner = (root: string): ScriptRunner => args => {
  const r = spawnSync(join(root, 'scripts/update.sh'), [...args], {
    cwd: root, encoding: 'utf8', timeout: UPDATE_CHECK_TIMEOUT_MS,
  })
  if (r.error) return { status: null, stdout: r.stdout ?? '', stderr: r.error.message }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * `scripts/update.sh` without blocking the event loop: what the web server's Check button uses. Never
 * rejects - a missing script, a timeout or a non-zero exit all resolve to a result that
 * `parseUpdateCheck` reads as `blocked`, exactly as the synchronous runner's do.
 */
export const updateScriptRunnerAsync = (
  root: string, timeoutMs: number = UPDATE_CHECK_TIMEOUT_MS,
): ((args: readonly string[]) => Promise<ScriptResult>) => args => new Promise(resolve => {
  execFile(join(root, 'scripts/update.sh'), [...args], {
    cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024,
  }, (err, stdout, stderr) => {
    if (!err) return resolve({ status: 0, stdout, stderr })
    // A numeric `code` is the script's own exit status; anything else (ENOENT, a kill on timeout) means
    // it did not run to an answer, which is what `status: null` says.
    const code = (err as { code?: unknown }).code
    if (typeof code === 'number') return resolve({ status: code, stdout, stderr })
    resolve({ status: null, stdout: stdout ?? '', stderr: err.killed ? `timed out after ${timeoutMs} ms` : err.message })
  })
})

const unrunnable = (err: unknown): UpdateCheck => ({
  state: 'blocked',
  behind: 0,
  changes: [],
  reason: `the update check could not be run: ${err instanceof Error ? err.message : String(err)}`.slice(0, REASON_MAX),
})

/**
 * One check. Never throws: a missing script, a timeout or a `git` that is not installed all come back
 * as `blocked` with the reason, because this is called from inside a poll and from a page.
 *
 * Synchronous, for the poller: it is its own short-lived process, so blocking it for a fetch costs
 * nothing. The web server uses `checkForUpdateAsync`.
 */
export function checkForUpdate(run: ScriptRunner = updateScriptRunner(repoRoot())): UpdateCheck {
  try {
    return parseUpdateCheck(run(['--check', '--porcelain']))
  } catch (err) {
    return unrunnable(err)
  }
}

/** `checkForUpdate` for the web server: the fetch happens off the event loop. Never rejects. */
export async function checkForUpdateAsync(
  run: AsyncScriptRunner = updateScriptRunnerAsync(repoRoot()),
): Promise<UpdateCheck> {
  try {
    return parseUpdateCheck(await run(['--check', '--porcelain']))
  } catch (err) {
    return unrunnable(err)
  }
}

export interface UpdateCheckOptions {
  /** Injected by tests; defaults to really running `scripts/update.sh` in this checkout. */
  run?: ScriptRunner
  /** Overridable so the rate limit can be tested without a day of fake clock. */
  intervalMs?: number
}

/**
 * The once-a-day check, as a poll step. Returns what it found, or nothing when it was not due.
 *
 * The result is stored before it is returned, which is what the rate limit keys on and what the
 * notification rules and /health read - so a check made by the hourly poller is what the page shows,
 * and the page costs no `git fetch` of its own.
 */
export function maybeCheckForUpdate(
  db: Database, now: Date, opts: UpdateCheckOptions = {},
): UpdateCheck | undefined {
  if (!dueForUpdateCheck(db, now, opts.intervalMs)) return undefined
  const check = checkForUpdate(opts.run)
  recordUpdateCheck(db, check, now)
  return check
}

// --- the update itself ------------------------------------------------------------------------------

/** What `scripts/update-run.sh` says it is doing. `failed` carries how the rollback went. */
export type UpdateRunState = 'running' | 'ok' | 'failed'

/**
 * What was done about a failed update. `none` is a refusal that never moved HEAD, so there was
 * nothing to undo - and nothing that could safely be undone, because a `git reset --hard` on a tree
 * refused for being dirty would eat the edit it was refused for.
 */
export type RollbackState = 'none' | 'ok' | 'failed'

export interface UpdateRun {
  state: UpdateRunState
  startedAt: Date
  finishedAt?: Date
  /** The commit the checkout was on when the update started: where a rollback goes back to. */
  from?: string
  /** The commit it is on now. */
  to?: string
  rollback?: RollbackState
  /** `scripts/update.sh`'s exit status, for the support bundle. */
  exit?: number
}

/**
 * What the page should say. `abandoned` is a `running` file whose process is plainly gone: the whole
 * point of a time-out here is that the page's reload loop ends by itself, exactly as it does for a
 * poll run nothing will ever finish.
 */
export type UpdateOutcome = 'running' | 'ok' | 'failed' | 'abandoned'

/** Where the detached update reports to, and where its output goes. Beside the database, in `data/`. */
export const updateStatusPath = (dataDir: string): string => join(dataDir, 'update-status.json')
export const updateLogPath = (dataDir: string): string => join(dataDir, 'update.log')

const RUN_STATES: readonly string[] = ['running', 'ok', 'failed']
const ROLLBACKS: readonly string[] = ['none', 'ok', 'failed']

const date = (v: unknown): Date | undefined => {
  if (typeof v !== 'string') return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/**
 * Reads the status file, trusting nothing in it.
 *
 * It is written by a shell script that is still running while this reads it, so a half-written file is
 * a normal event rather than a corruption (the writer renames into place, so it should not be, but
 * "should not" is not a defence). Every field is validated and a bad one is dropped; a file with no
 * usable state or no start time is no file at all. Never throws.
 */
export function readUpdateRun(path: string): UpdateRun | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const state = o.state
  const startedAt = date(o.startedAt)
  if (typeof state !== 'string' || !RUN_STATES.includes(state) || startedAt === undefined) return undefined
  const from = typeof o.from === 'string' ? sha(o.from) : undefined
  const to = typeof o.to === 'string' ? sha(o.to) : undefined
  const rollback = typeof o.rollback === 'string' && ROLLBACKS.includes(o.rollback)
    ? (o.rollback as RollbackState) : undefined
  return {
    state: state as UpdateRunState,
    startedAt,
    ...(date(o.finishedAt) && { finishedAt: date(o.finishedAt) }),
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
    ...(rollback !== undefined && { rollback }),
    ...(Number.isInteger(o.exit) && { exit: o.exit as number }),
  }
}

export function updateOutcome(run: UpdateRun, now: Date, staleMs: number = UPDATE_STALE_MS): UpdateOutcome {
  if (run.state !== 'running') return run.state
  return now.getTime() - run.startedAt.getTime() > staleMs ? 'abandoned' : 'running'
}

/**
 * Marks an update as started, before the child exists.
 *
 * Written by the parent rather than left to the wrapper script because of the redirect: the page is
 * requested within milliseconds of the POST, and a page that found no status file would show no
 * spinner, emit no meta refresh, and leave the user looking at a dashboard that says nothing is
 * happening while `npm ci` runs. The wrapper overwrites it with the same `startedAt` (it arrives in
 * the environment), so both halves describe one run.
 *
 * Written through a temporary file and renamed, so a reader never sees half of it.
 */
export function writeRunningUpdate(path: string, startedAt: Date): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify({ state: 'running', startedAt: startedAt.toISOString() })}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/** The options `startUpdate` passes to `spawn`. Narrow on purpose: there is no way to ask for a shell. */
export interface SpawnOptions {
  cwd: string
  detached: boolean
  stdio: Array<'ignore' | number>
  env?: NodeJS.ProcessEnv
}

export interface SpawnedProcess {
  pid?: number
  unref: () => void
  /**
   * A real `ChildProcess` emits `error` when the script could not be started at all (it is missing,
   * or not executable), and an `error` event with no listener is an UNCAUGHT exception - which here
   * would take the web server down because a shell script had the wrong mode. `startUpdate`
   * therefore always listens. Optional, so a test's recorder need not pretend to be an EventEmitter.
   */
  once?: (event: 'error', listener: (err: Error) => void) => unknown
}

export type SpawnFn = (
  command: string, args: readonly string[], options: SpawnOptions,
) => SpawnedProcess

export interface StartUpdateDeps {
  /** The checkout to update. */
  root: string
  /** Where the status file and the log go; `data/`, beside the database. */
  dataDir: string
  startedAt: Date
  spawn?: SpawnFn
  openLog?: (path: string) => number
  closeLog?: (fd: number) => void
}

const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, [...args], options)

/**
 * Records an update that never started. The wrapper script writes every other outcome, but it cannot
 * write this one - it never ran - and without this the page would show the spinner for the full
 * `UPDATE_STALE_MS` before deciding the update had stopped answering, for something that is known
 * now. `rollback: 'none'` is the truth: nothing was installed, so nothing was undone.
 */
function writeFailedStart(path: string, startedAt: Date, at: Date): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify({
    state: 'failed', startedAt: startedAt.toISOString(), finishedAt: at.toISOString(), rollback: 'none',
  })}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Starts the update and returns immediately.
 *
 * `detached: true` is the whole hazard. The update ends by running `scripts/install-agents.sh`, which
 * boots the launchd web agent out and bootstraps it again - and the web agent is this process.
 * `launchctl bootout` signals the whole process group, so an ordinary child is killed somewhere inside
 * `npm ci`, leaving node_modules half-replaced and dist/ built from neither commit. `detached` puts
 * the child in a session and process group of its own, where that signal does not reach it.
 *
 * For the same reason its stdio cannot be a pipe: there will be nobody at the other end. Both streams
 * go to `data/update.log`, appended, which is also the only place the real reason for a failed build
 * ever appears (the support bundle carries its tail).
 */
export function startUpdate(deps: StartUpdateDeps): { pid?: number; log: string } {
  const log = updateLogPath(deps.dataDir)
  const status = updateStatusPath(deps.dataDir)
  writeRunningUpdate(status, deps.startedAt)
  const fd = (deps.openLog ?? (p => openSync(p, 'a')))(log)
  try {
    const child = (deps.spawn ?? defaultSpawn)(join(deps.root, 'scripts/update-run.sh'), [], {
      cwd: deps.root,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        PARCELS_UPDATE_STATUS: status,
        PARCELS_UPDATE_STARTED: deps.startedAt.toISOString(),
      },
    })
    // The script is missing, or not executable: nothing will ever write an outcome, so one is written
    // here. Listening at all is the load-bearing part - an `error` event nobody listens for is an
    // uncaught exception, and the web server would go down because of a file mode.
    child.once?.('error', err => {
      console.error(`update: could not start ${join(deps.root, 'scripts/update-run.sh')}: ${err.message}`)
      try { writeFailedStart(status, deps.startedAt, new Date()) } catch { /* the page falls back to going stale */ }
    })
    // Nothing in this process waits for it, and an event loop held open by a child that outlives the
    // process on purpose would stop the web server from ever shutting down cleanly.
    child.unref()
    return { pid: child.pid, log }
  } finally {
    // The child has already dup'd the descriptor by the time spawn returns, so closing it here leaks
    // nothing and leaves the child writing. A fake fd in a test is not ours to close; hence the catch.
    try { (deps.closeLog ?? closeSync)(fd) } catch { /* not a real descriptor, or already closed */ }
  }
}

const LOG_OUTCOME: Record<Exclude<UpdateOutcome, 'running'>, (run: UpdateRun) => UpdateLogOutcome> = {
  ok: () => 'ok',
  abandoned: () => 'abandoned',
  failed: run => (run.rollback === 'ok' ? 'rolled_back' : run.rollback === 'failed' ? 'rollback_failed' : 'failed'),
}

/**
 * Turns a finished update into one activity-log entry, and returns what the status file says. A
 * successful one also brings the stored check up to date (see `recordUpdateInstalled`), once.
 *
 * The process that started the update does not live to record how it went - that is the point of
 * detaching it - so the recording happens on the next look, like `reapStaleRuns`: whichever of
 * /health or the next poll gets there first writes the row. `logged_started_at` is what makes it
 * once: opening the page five times records nothing five times, and the next update is a different
 * `startedAt` and so a second entry.
 *
 * Never throws. It reads a file and writes a diagnostics row; neither is worth a 500 on the page
 * somebody opened to find out what is wrong.
 */
export function adoptUpdateOutcome(
  db: Database, dataDir: string, now: Date, cause: Cause,
): UpdateOutcome | undefined {
  let run: UpdateRun | undefined
  try {
    run = readUpdateRun(updateStatusPath(dataDir))
  } catch {
    return undefined
  }
  if (!run) return undefined
  const outcome = updateOutcome(run, now)
  if (outcome === 'running') return outcome
  try {
    const key = run.startedAt.toISOString()
    if (loggedUpdateStart(db) !== key) {
      logAction(db, {
        kind: 'update',
        outcome: LOG_OUTCOME[outcome](run),
        ...(run.from !== undefined && { from: run.from }),
        ...(run.to !== undefined && { to: run.to }),
      }, cause)
      // The check stored before the update still says "behind" and still offers the button; what was
      // installed is the upstream it was behind, so the answer is now "current" at the new commit.
      if (outcome === 'ok') recordUpdateInstalled(db, run.to, run.finishedAt ?? now)
      markUpdateLogged(db, key, now)
    }
  } catch (err) {
    console.error(`update: could not record the outcome: ${err instanceof Error ? err.message : String(err)}`)
  }
  return outcome
}
