import type { AddressInfo } from 'node:net'
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
import { buildServer, refreshIdle, startServer, type WebDeps } from '../web/server.js'

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
  const config = loadRuntimeConfig(deps.configPath)
  initRuntime(config)
  const db = openDb(config.dbPath)
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
    timer = setTimer(() => { firedSlot = slot; void runScheduled() }, slot.getTime() - now().getTime())
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
   */
  const runScheduled = (): Promise<void> => {
    if (inFlight || closing) return inFlight ?? Promise.resolve()
    lastRun = now()
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

  arm()
  return { handle, close, port }
}
