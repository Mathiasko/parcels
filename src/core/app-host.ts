import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { loadRuntimeConfig, type Config } from './config.js'
import type { ToMain, ToServer } from './app-ipc.js'
import { initRuntime } from './runtime.js'
import { lastPollMs } from './pollwatch.js'
import { missedSlot, nextSlot } from './schedule.js'
import { openDb, type Database } from '../db/index.js'
import { readyCount } from '../db/parcels.js'
import { createAppNotifier } from '../notify/send.js'
import { runPollOnce } from '../poll.js'
import { buildServer, refreshIdle, startServer, type AppWebDeps, type WebDeps } from '../web/server.js'
import {
  appUpdateStatusPath, defaultDownload, readAppUpdateStatus, runCommand, stageUpdate, writeAppUpdateStatus,
  type AppUpdateStatus, type StageDeps,
} from './app-update.js'
import { resourceRoot } from './host.js'
import { appVersion } from './version.js'
import { recordUpdateInstalled } from '../db/update-state.js'

/** The longest delay `setTimeout` honours; anything larger fires at once, so it is clamped to this. */
const MAX_TIMER_MS = 2 ** 31 - 1

export interface AppHostDeps {
  configPath: string
  /** How a message reaches the main process. Allowed to throw (the channel is gone): the host carries on. */
  post: (m: ToMain) => void
  now?: () => Date
  setTimer?: (fn: () => void, ms: number) => { clear(): void }
  /** One scheduled poll on the open database. Defaults to `runPollOnce`, with the app's notifier. */
  poll?: (db: Database, config: Config) => Promise<{ ran: boolean }>
  /** Extra dependencies for the dashboard; tests inject fakes here. */
  web?: Partial<WebDeps>
  /** Overrides `config.port`; tests pass 0 and read the real port back from `AppHost.port`. */
  port?: number
  /** The environment the main process set (`PARCELS_APP_VERSION`, `PARCELS_APP_BUNDLE`, ...); tests pass their own. */
  env?: NodeJS.ProcessEnv
}

export interface AppHost {
  handle(m: ToServer): Promise<void>
  close(): Promise<void>
  port: number
}

/**
 * Deliberately not `unref`'d: in the app this process exists to serve the dashboard and to poll, and
 * a timer that did not hold the event loop open would let it exit between slots if the socket ever
 * closed. The delay is clamped because Node fires a larger one immediately, which would turn a clock
 * oddity into a burst of polls.
 */
const defaultSetTimer = (fn: () => void, ms: number) => {
  const handle = setTimeout(fn, Math.min(Math.max(ms, 0), MAX_TIMER_MS))
  return { clear: () => clearTimeout(handle) }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * The SHA-256 of the certificate the bundle was signed with, as shipped in its Resources folder
 * (`app/signing-cert.sha256`). Read when an update is staged rather than at startup, so a missing file
 * costs nothing until it matters; then it is empty, and `stageUpdate` refuses with a sentence rather
 * than trusting whatever it downloaded.
 */
function shippedCertSha(env: NodeJS.ProcessEnv): string {
  try { return readFileSync(join(resourceRoot(env), 'signing-cert.sha256'), 'utf8').trim() } catch { return '' }
}

/**
 * The staging the dashboard's Update now runs: `stageUpdate` with what only this process knows (the
 * Mac it runs on and the certificate in its bundle) and the real download and commands. `process.arch`
 * is passed through as it is: on anything but arm64 or x64, `stageUpdate` refuses with a sentence.
 * Exported, with the staging injectable, so a test can check what is passed without downloading anything.
 */
export function appStage(
  env: NodeJS.ProcessEnv, stage: (d: StageDeps) => Promise<AppUpdateStatus> = stageUpdate,
): NonNullable<AppWebDeps['stage']> {
  return d => stage({
    ...d,
    arch: process.arch as StageDeps['arch'],
    expectedCertSha: shippedCertSha(env),
    download: defaultDownload,
    run: runCommand,
  })
}

/**
 * Settles what an earlier run of the app left in the updater's status file, before anyone reads it.
 *
 * - `staged` for the version now running: the swap worked and this is the new app, so it becomes
 *   `installed` (Health then says "Updated to <v>."), and the check from before the update, which still
 *   offers this very version, becomes `current`, as the git updater's `recordUpdateInstalled` does.
 * - `downloading`: the staging runs inside the server process, so a download that is "going" while a
 *   new process starts died with the old one. It becomes `failed`, so the button comes back at once
 *   instead of after the staleness bound.
 *
 * Never throws: a status file that cannot be settled must not stop the dashboard from starting.
 */
function settleUpdateStatus(db: Database, supportDir: string, version: string, at: Date): void {
  const path = appUpdateStatusPath(supportDir)
  try {
    const s = readAppUpdateStatus(path)
    if (s?.state === 'staged' && s.version === version) {
      writeAppUpdateStatus(path, { state: 'installed', version, finishedAt: at })
      recordUpdateInstalled(db, undefined, at)
    } else if (s?.state === 'downloading') {
      writeAppUpdateStatus(path, {
        state: 'failed', version: s.version, startedAt: s.startedAt, finishedAt: at,
        reason: 'The download stopped when Parcels restarted, so nothing was changed. Press Update now to try again.',
      })
    }
  } catch (err) {
    console.error(`app-host: could not settle the update status: ${message(err)}`)
  }
}

/**
 * The Mac app's server process, minus the Electron glue (`src/app-server.ts` holds that): the same
 * dashboard `src/server.ts` serves, plus the poll schedule launchd runs for the git install, plus the
 * messages that keep the menu-bar icon's count right.
 *
 * Startup follows `src/server.ts` step for step (config, runtime, database, server, listen) so the two
 * entries cannot disagree about what "the server" is. Only after the socket is open does the host tell
 * the main process anything: `listening` is the main process's cue to load the window, and announcing
 * a port nobody is listening on would show the user an error page.
 */
export async function startAppHost(deps: AppHostDeps): Promise<AppHost> {
  const now = deps.now ?? (() => new Date())
  const setTimer = deps.setTimer ?? defaultSetTimer
  const env = deps.env ?? process.env
  const config = loadRuntimeConfig(deps.configPath)
  initRuntime(config)
  const db = openDb(config.dbPath)

  // What the dashboard says about the app, from the environment the main process sets. The support
  // folder is where the config file is (PARCELS_CONFIG). The version is PARCELS_APP_VERSION; a test's
  // fixed `web.version` comes next, so building the server in a test spawns no git; and the checkout's
  // answer is the last resort. The process start is when this server started, which "running for"
  // counts from; PARCELS_RESTARTS is read per request, so it is whatever the main process last set.
  const supportDir = dirname(deps.configPath)
  const version = env.PARCELS_APP_VERSION || deps.web?.version || appVersion()
  const appDeps: AppWebDeps = {
    supportDir,
    logDir: env.PARCELS_LOG_DIR || join(homedir(), 'Library', 'Logs', 'Parcels'),
    appBundle: env.PARCELS_APP_BUNDLE ?? '',
    version,
    startedAt: new Date(Date.now() - process.uptime() * 1000),
    restarts: () => {
      const n = Number(env.PARCELS_RESTARTS ?? 0)
      return Number.isInteger(n) && n >= 0 ? n : 0
    },
    stage: appStage(env),
  }
  settleUpdateStatus(db, supportDir, version, now())
  // The app notifier goes to both the dashboard's refresh and the scheduled poll: inside the bundle the
  // configured terminal-notifier or osascript would post under the wrong identity, or not at all.
  const notifier = createAppNotifier(deps.post)
  const poll = deps.poll ?? ((pdb: Database, pconfig: Config) =>
    runPollOnce(pdb, pconfig, { notifier, ...(deps.now ? { now: now() } : {}) }))

  /** A message the main process may never see (it is quitting) must not take a poll or a response down with it. */
  const send = (m: ToMain) => {
    try { deps.post(m) } catch (err) { console.error(`app-host: could not post ${m.type}: ${message(err)}`) }
  }
  const postReadyCount = () => {
    let n: number
    try { n = readyCount(db) } catch (err) {
      console.error(`app-host: could not count ready parcels: ${message(err)}`)
      return
    }
    send({ type: 'ready-count', n })
  }

  let built: FastifyInstance | undefined
  try {
    built = buildServer({
      notifier,
      ...(deps.now ? { now: deps.now } : {}),
      app: appDeps,
      ...deps.web,
      db, config, configPath: deps.configPath,
    })
    // Any write can move a parcel into or out of "ready" (collected, undone, deleted, a postcode that
    // lets a carrier answer), so every non-GET is followed by a fresh count rather than a list of the
    // routes that matter today; a count is one cheap query. HEAD is a GET without the body.
    built.addHook('onResponse', async req => {
      if (req.method !== 'GET' && req.method !== 'HEAD') postReadyCount()
    })
    await startServer(built, deps.port ?? config.port)
  } catch (err) {
    // Nothing was announced and no timer is armed; leave nothing open behind the error, which the entry
    // turns into an exit status (EADDRINUSE is 3, so the main process can name the port).
    await built?.close().catch(() => {})
    db.close()
    throw err
  }
  const app = built
  const port = (app.server.address() as AddressInfo).port
  send({ type: 'listening', port })
  postReadyCount()

  // The last poll this host knows of, for deciding on wake whether a slot passed while asleep. It
  // starts from `last_poll`, the start time of the last completed scheduled poll (written by
  // `runPollOnce` via `recordPoll`, and the same record the sleep-gap check and /health read), so a
  // restart does not forget a poll that just ran. After that it is the start of each poll this host
  // begins. The dashboard's refresh is not counted: it does not write `last_poll` either, and a
  // scheduled poll it pre-empts is skipped by `claimRun` rather than lost.
  let lastRun: Date | undefined
  try {
    const ms = lastPollMs(db)
    if (ms !== undefined) lastRun = new Date(ms)
  } catch (err) { console.error(`app-host: could not read the last poll time: ${message(err)}`) }

  let timer: { clear(): void } | undefined
  /** The slot the timer that last fired was armed for; see `arm`. */
  let firedSlot: Date | undefined
  let inFlight: Promise<void> | undefined
  let closing: Promise<void> | undefined

  /**
   * Arms the one timer for the next slot, replacing any earlier one. Planned from the later of now and
   * the slot that just fired: a timer that fires a hair early would otherwise find that same slot still
   * ahead and poll it twice.
   */
  const arm = () => {
    timer?.clear()
    timer = undefined
    if (closing) return
    const from = Math.max(now().getTime(), firedSlot?.getTime() ?? 0)
    const slot = nextSlot(new Date(from))
    timer = setTimer(() => { firedSlot = slot; void runScheduled(slot) }, slot.getTime() - now().getTime())
  }

  /**
   * The config file is read again for every run, as the git install's poller does by being a fresh
   * process each hour: the settings page rewrites the file, and mail set up there must be read by the
   * next poll, not after a restart. A file that no longer loads keeps the last good config. `dbPath`
   * stays the one that was opened, since that is the database this process holds.
   */
  let current = config
  const freshConfig = (): Config => {
    try { current = { ...loadRuntimeConfig(deps.configPath), dbPath: config.dbPath } } catch (err) {
      console.error(`app-host: could not reload the config, polling with the last good one: ${message(err)}`)
    }
    return current
  }

  /**
   * One scheduled poll, then the count it may have changed, then the next slot. A trigger that finds a
   * poll already running from this host is dropped, not queued: the running poll is the one the
   * trigger asked for, and it re-arms when it ends. (`claimRun` inside the poll is what keeps it apart
   * from a dashboard refresh or another process.) Never rejects: a failed poll is logged, and the
   * schedule carries on.
   *
   * `slot` is the slot a timer fired for. The run counts as that slot even when the timer fired a hair
   * before it: recorded as "now", a run at 14:59:59.9 would leave the 15:00 slot looking missed, and a
   * wake at 15:20 would poll a second time in the same hour.
   */
  const runScheduled = (slot?: Date): Promise<void> => {
    if (inFlight || closing) return inFlight ?? Promise.resolve()
    lastRun = new Date(Math.max(now().getTime(), slot?.getTime() ?? 0))
    inFlight = (async () => {
      try {
        await poll(db, freshConfig())
      } catch (err) {
        console.error(`${new Date().toISOString()} app-host: poll failed: ${message(err)}`)
      } finally {
        inFlight = undefined
      }
      if (closing) return
      postReadyCount()
      arm()
    })()
    return inFlight
  }

  /**
   * "Refresh now" in the menu is the dashboard's Refresh button pressed from elsewhere, so it goes in
   * through that very route rather than through a second copy of it: the same forced poll of the same
   * parcels, the mailbox read, the press in the activity log, the double-click guard and the claim. The
   * route answers before its run finishes, so the count is posted once `refreshIdle` says it is done.
   */
  const refresh = async () => {
    if (closing) return
    const res = await app.inject({ method: 'POST', url: '/refresh' })
    if (res.statusCode >= 400) console.error(`app-host: refresh was refused with ${res.statusCode}`)
    await refreshIdle(app)
    if (!closing) postReadyCount()
  }

  /**
   * Stops in the order that loses nothing: no new timer, then the scheduled poll that is running (it
   * holds the database), then fastify (whose `onClose` waits for a dashboard refresh), then the
   * database. Idempotent, because the main process may send `shutdown` and then also kill.
   */
  const close = (): Promise<void> => {
    closing ??= (async () => {
      timer?.clear()
      timer = undefined
      await inFlight
      await app.close()
      db.close()
    })()
    return closing
  }

  const handle = async (m: ToServer): Promise<void> => {
    switch (m.type) {
      case 'refresh': return refresh()
      case 'shutdown': return close()
      case 'wake':
        if (closing) return
        // After a sleep the armed timer cannot be trusted to mean the right wall-clock time, so the
        // next slot is always planned again; a slot that passed while asleep is polled once first,
        // which is what launchd's coalescing of missed calendar intervals does for the git install.
        if (missedSlot(lastRun, now())) return runScheduled()
        arm()
    }
  }

  // A slot that passed while the app was not running is polled once now, before the timer is armed (the
  // run arms it when it ends): the app quit last night and opened at 10:20 has missed 07:00 to 10:00,
  // and launchd would have coalesced those into one run on the next wake. Only when a poll is on record:
  // a fresh install has nothing to catch up on, and the git install's poller does not run at load either.
  if (lastRun !== undefined && missedSlot(lastRun, now())) void runScheduled()
  else arm()
  return { handle, close, port }
}
