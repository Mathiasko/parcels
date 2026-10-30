import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import {
  readConfigDocument, runtimeConfigPath, validateConfig, writeConfigDocument, type Config, type ConfigDocument,
} from '../core/config.js'
import type { CarrierId } from '../core/types.js'
import type { Database } from '../db/index.js'
import { latestEvent, listEvents, userMark, userMarks } from '../db/events.js'
import { markCollected, undoCollected } from '../core/collected.js'
import { deleteParcel, getParcel, listActive, parcelName, type Parcel } from '../db/parcels.js'
import type { Carrier, HttpClient } from '../core/types.js'
import { createHttpClient } from '../core/http.js'
import { cachedGrid } from '../core/map-preview.js'
import { parseTile } from '../core/slippy.js'
import { readTile, tileDirFor } from '../core/tiles.js'
import { FONT_HEADERS, fontDir as defaultFontDir, readFont } from './fonts.js'
import { isDormant } from '../core/backoff.js'
import { recordPollRun, runPoll, type PollDeps } from '../core/poll.js'
import { claimRun, failRun, getRun, listRuns, reapStaleRuns, runningRun, type PollRun } from '../db/poll-runs.js'
import { allAdapters } from '../carriers/registry.js'
import { notifierFor } from '../notify/send.js'
import type { Notifier } from '../notify/types.js'
import { listDelivered, setLabel, setPostalCode } from '../db/parcels.js'
import { carrierHealth } from '../db/health.js'
import { getIngestStatus } from '../db/ingest-status.js'
import { getPickupCode, pickupCodesFor } from '../db/pickup-codes.js'
import { dismissMessage, dismissMessages, linkMessage } from '../db/messages.js'
import { listActivity, logAction, type Cause } from '../db/activity-log.js'
import { addParcel, cleanPostcode, MAX_LABEL } from './actions.js'
import { applySettings, changedSettingFields, settingsValues, submittedSettings, type SettingsValues } from './settings.js'
import { probeImap, type ImapProbeLike, type ImapProbeResult } from '../ingest/imap-probe.js'
import type { ImapConfig } from '../ingest/imap.js'
import { calendarListWhy, settingsPage, type CalendarList, type SettingsState } from './views/settings.js'
import { CalendarFailure, osascriptCalendar, type CalendarClient } from '../core/calendar-app.js'
import { calendarEventsFor, getCalendarEvent, saveCalendarEvent } from '../db/calendar-events.js'
import { calendarOffered, type CalendarFormState, type CalendarOutcome } from './views/calendar-form.js'
import { isTime, pickupSlots, slotAllowed, slotStart, timeLabel, type Slots } from './calendar-slots.js'
import { CARRIER_NAME, DISPLAY_ZONE } from './views/format.js'
import {
  countUnparsedMessages, deliveryStats, getUnparsedMessage, listUnparsedMessages, rawResponsesFor,
} from './queries.js'
import { html, type Html } from './views/html.js'
import { errorPage, notFoundPage, serverErrorPage } from './views/error.js'
import { addPage } from './views/add.js'
import { attentionPage, type AttentionError } from './views/attention.js'
import { appUpdateBusy, healthPage, updateBusy, type AppHealth, type UpdateView } from './views/health.js'
import { pollerStatus } from '../core/pollwatch.js'
import {
  buildSupportBundle, supportBundleFilename, type LaunchdReport, type SupportEnv,
} from '../core/support.js'
import { resourceRoot } from '../core/host.js'
import { appVersion, repoRoot } from '../core/version.js'
import {
  adoptUpdateOutcome, checkForUpdateAsync, readUpdateRun, startUpdate, updateOutcome, updateStatusPath,
  type AsyncScriptRunner, type SpawnFn,
} from '../core/update.js'
import { getUpdateCheck, recordUpdateCheck } from '../db/update-state.js'
import {
  appUpdateDownloading, appUpdateStatusPath, checkAppRelease, compareVersions, downloadBaseBeside, githubFetchJson, isVersion,
  readAppUpdateStatus, RELEASES_URL, stagingDir, type AppUpdateStatus, type StageDeps,
} from '../core/app-update.js'
import { postToMain } from '../core/app-ipc.js'
import { nextSlot } from '../core/schedule.js'
import type { UpdateCheck } from '../core/update.js'
import { historyPage } from './views/history.js'
import { calendarUrl, indexPage, type RefreshNote } from './views/index.js'
import { calendarFilename, parcelCalendar, pickupEventSpec } from './calendar.js'
import { parcelPage } from './views/parcel.js'
import { DateTime } from 'luxon'
import type { PageCtx } from './views/layout.js'

export interface WebDeps {
  db: Database
  config: Config
  /**
   * The config file `config` was loaded from: the settings page reads it back and writes it. Defaults
   * to the file the runtime entry points load, which is the right answer for a real server - but a
   * test that posts to `/settings` must pass a temp path, or it would write the user's own config.
   */
  configPath?: string
  /** The remaining dependencies exist so tests can run a refresh without the network or a real banner. */
  http?: HttpClient
  adapters?: Carrier[]
  notifier?: Notifier
  now?: () => Date
  /** The map-tile cache; defaults to `data/tiles` beside the database, as the poller writes it. */
  tileDir?: string
  /** The theme fonts; defaults to the repo's `assets/fonts`. Tests plant a fake one. */
  fontDir?: string
  /**
   * Calendar.app, for "Add to Calendar" and the settings page's list of calendars. Defaults to the
   * osascript client (core/calendar-app.ts); every test injects a fake, and the real one refuses to run
   * under the test runner anyway, so no test can raise the Automation prompt or touch a real calendar.
   */
  calendar?: CalendarClient
  /** The IMAP client the connection test uses; injected so tests never touch the network. */
  imapClient?: (config: ImapConfig) => ImapProbeLike
  /**
   * The IMAP client a whole-dashboard refresh ingests with; injected so tests never touch the
   * network. Separate from `imapClient`: the connection test only looks, the ingest reads messages.
   */
  ingestClient?: NonNullable<PollDeps['ingest']>['client']
  /**
   * What `/health` reports as the running version. Defaults to this checkout, resolved once (see
   * core/version.ts); injected by tests, which must not depend on the commit they happen to run at.
   */
  version?: string
  /**
   * The parts of the support bundle that cannot be read from the database: the machine, the launchd
   * agents, and the directory holding the logs and the mail. Injected so a test never spawns
   * `launchctl`, never depends on the host it runs on, and never reads the author's own `data/`.
   */
  support?: { env?: SupportEnv; launchd?: LaunchdReport; dataDir?: string }
  /**
   * Updating the app from /health. Every field is injected by tests, because the real ones spawn a
   * shell script that pulls from the internet and reboots this process: no test may run one.
   *
   * `root` is the checkout to update (this one), `dataDir` is where the update's log and status file
   * live (`data/`, beside the database), `run` is how `scripts/update.sh --check` is run for the
   * Check button, and `spawn`/`openLog` are the detachment seam (see core/update.ts).
   */
  update?: {
    root?: string
    dataDir?: string
    run?: AsyncScriptRunner
    spawn?: SpawnFn
    openLog?: (path: string) => number
    closeLog?: (fd: number) => void
  }
  /**
   * The Mac app that runs this server. Present exactly when the host is the app (core/app-host.ts fills
   * it in from the environment the main process sets); absent in the git install, where every page and
   * route behaves as it always has. Where it is set, Health, Settings and the support bundle speak
   * about the app, the update routes drive the app updater (core/app-update.ts), and two app-only
   * routes exist: POST /update/restart and POST /app/reveal-data.
   */
  app?: AppWebDeps
}

/** What the web app needs to know about, and do through, the Mac app; see `WebDeps.app`. */
export interface AppWebDeps {
  /** `~/Library/Application Support/Parcels`: the config, the data and the updater's status file. */
  supportDir: string
  /** `~/Library/Logs/Parcels`, whose `server.log` the support bundle tails. */
  logDir: string
  /** The running `Parcels.app`; an update is staged beside it. */
  appBundle: string
  /** The app's own version, which is what Health says is running. */
  version: string
  /** When this server process started, for "running for". */
  startedAt: Date
  /** How often the app has restarted this server since it opened. Read per request: it is the app's count. */
  restarts: () => number
  /**
   * Downloads and verifies a release (`stageUpdate`). The host adds what only it knows (this Mac's
   * architecture and the certificate shipped in the bundle) and the real download and commands, so the
   * web layer hands over only the release and where things are. Tests always pass a fake.
   */
  stage?: (d: Omit<StageDeps, 'download' | 'run' | 'arch' | 'expectedCertSha'>) => Promise<AppUpdateStatus>
  /** The release check for the Check button; defaults to asking GitHub. Tests pass a fake. */
  check?: () => Promise<UpdateCheck>
  /**
   * A `releases/latest` URL to use in place of GitHub's, for a test build (`RELEASES_URL_ENV` in
   * core/app-update.ts): the default check asks it, and Update now downloads from beside it.
   */
  releasesUrl?: string
}

/**
 * The server has no authentication, so the bind address is the whole security boundary: loopback
 * only, never configurable, never `0.0.0.0`. `startServer` is the only place a socket is opened.
 */
export const BIND_HOST = '127.0.0.1'

/** The policy every response carries; the comment in the `onRequest` hook says why each directive is there. */
export const CSP = "default-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"

export async function startServer(app: FastifyInstance, port: number): Promise<void> {
  await app.listen({ host: BIND_HOST, port })
}

/**
 * What a refresh covers: one parcel by id, or (the dashboard's button) every parcel `select` says yes to,
 * asked once the run has read the mailbox. `pressed` is how many it covered when pressed, for the log.
 */
interface RefreshScope { parcelIds?: number[]; select?: (p: Parcel) => boolean; pressed?: number }

/** An "Add to Calendar" submission the POST would not take, shown again on the page it came from. */
interface Refused { parcelId: number; error: string; day: string; time: string }

/**
 * Why a submitted day and time is not one the form offers right now, in words for the form to show.
 * Most often a time on today that passed while the page sat open: the page has no script to notice.
 */
function slotRefusal(slots: Slots, day: string, time: string, at: Date): string {
  if (day === '') return 'Choose a day and a time.'
  if (time === '') return 'Choose a time, or type one beside Other.'
  if (!isTime(time)) return 'Type the time as hours and minutes, such as 18:30.'
  const offered = slots.days.find(d => d.date === day)
  const today = DateTime.fromJSDate(at, { zone: DISPLAY_ZONE }).toFormat('yyyy-LL-dd')
  if (offered) return `${timeLabel(time)}${day === today ? ' today' : ''} has already passed. Choose a later time or another day.`
  if (day === today) return 'Today has no time left to choose. Choose another day.'
  return slots.days.length === 0 ? 'There is no time left to plan this pickup for.' : 'That day cannot be chosen. Choose one of the days listed.'
}

/** A parcel tried within this long is left alone by the global refresh (a double click, or the hourly poll just ran). */
const MIN_REFRESH_GAP_MS = 60_000

/**
 * The Host header is part of the security boundary, not decoration: refusing a foreign one is what stops a
 * page on the open web from resolving its own domain to 127.0.0.1 and reading this unauthenticated server
 * (DNS rebinding). `parcels.local` is allowed because it is not a name anyone else can make a browser send
 * here: it resolves only through this machine's /etc/hosts, so reaching the server under it means the user
 * typed it. Keep this list exhaustive and anchored - a bare suffix match would let `parcels.local.evil.example` in.
 */
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|parcels\.local)(:\d+)?$/i

/** A config document without its `notifier` key; see POST /settings in app mode. */
const withoutNotifier = (doc: ConfigDocument): ConfigDocument => {
  const { notifier: _, ...rest } = doc
  return rest
}

const send = (reply: FastifyReply, page: Html, status = 200) =>
  reply.code(status).type('text/html; charset=utf-8').send(page.toString())

/** A repeated query key (`?q=a&q=b`) arrives as an array; only the first value is ever meaningful. */
const one = (v: unknown): string | undefined => {
  const first = Array.isArray(v) ? v[0] : v
  return typeof first === 'string' ? first : undefined
}

/**
 * The one note a URL may carry by itself: `?busy=1`, which a second click gets when a refresh is
 * already going but its run row cannot be found. A finished run's counts are never read from the URL
 * (they come from its row, via `?run=N`): a result spelled out in a query string would replay itself
 * from a bookmark or the history for ever.
 */
export function refreshNote(query: Record<string, unknown>): RefreshNote | undefined {
  return one(query.busy) === '1' ? { polled: 0, failures: 0, busy: true } : undefined
}

/**
 * How often a page waiting on a run re-requests itself. Short, because this is a local server answering
 * from a local database and the whole point is that the wait is visible. The loop is not capped here:
 * it is capped by the run, which stops being "in progress" once it finishes or once `RUN_STALE_MS` has
 * passed without it finishing (see `reapStaleRuns`), and a page with no run in progress emits no meta
 * refresh at all. One mechanism, so there is no second number that could outlive the first.
 */
const RELOAD_SECONDS = 3

/** How long the "Restarting Parcels" page waits before it goes back to Health: about how long the swap takes. */
const RESTART_RELOAD_SECONDS = 5

/** How many runs the Health page's activity log shows. */
const RUNS_SHOWN = 20

/**
 * How long after a mark the dashboard still shows "Marked X as collected. Undo" for `?collected=<id>`.
 * Long enough for a reload or a slow second look; short enough that a bookmark or a history entry does
 * not resurface the notice days later. Undo stays on the parcel page for as long as the mark stands.
 */
const COLLECTED_NOTICE_MS = 60 * 60_000

/** How long the result of an "Add to Calendar" press is shown for `?calendar=<id>`; the same hour, for the same reasons. */
const CALENDAR_NOTICE_MS = 60 * 60_000
/** How many of those results are kept in memory. Only the latest is ever wanted; a few cover several tabs. */
const CALENDAR_OUTCOMES_KEPT = 20

/**
 * How many activity entries the Health page shows. More than the runs, because these are what somebody
 * scrolls looking for the moment a parcel changed or the day they deleted one, and they are one line
 * each; far fewer than `ACTIVITY_LOG_KEPT`, because a page is not an archive.
 */
const ACTIVITY_SHOWN = 40

/**
 * True when `candidate` is a version later than `running`. False when either is not a version: an
 * update that cannot be shown to be newer is not installed.
 */
const newerThanRunning = (candidate: string, running: string): boolean =>
  isVersion(candidate) && isVersion(running) && compareVersions(candidate, running) > 0

/**
 * The background refresh each server has in flight, if any. `POST /refresh` returns before its run is
 * done, so something has to be able to wait for it: the `onClose` hook, so shutting the server down
 * does not abandon a run halfway, and tests that need the run's effects before they assert on them.
 * Resolved, never rejected - a background run that throws is recorded as a failed run, not a crash.
 */
const inFlightRefresh = new WeakMap<FastifyInstance, Promise<void>>()
export const refreshIdle = (app: FastifyInstance): Promise<void> => inFlightRefresh.get(app) ?? Promise.resolve()

export function buildServer(deps: WebDeps): FastifyInstance {
  const { db } = deps
  /**
   * What this process is running on. `deps.config` is what it STARTED on, and the settings page can
   * change the file underneath it, so this is a holder rather than a constant: a successful save
   * replaces it, and every route that reads config (the default postcode on /add, the map preview,
   * whether /health says mail is configured) follows the new file without a restart. `port` and
   * `dbPath` are never replaced - the socket is open and the database is open - which is exactly why
   * the page shows those two read-only.
   */
  let config = deps.config
  const configPath = deps.configPath ?? runtimeConfigPath()
  const tileDir = deps.tileDir ?? tileDirFor(config.dbPath)
  const fontDir = deps.fontDir ?? defaultFontDir()
  const app = Fastify({ logger: false })
  // Resolved once here, never per request: it reads package.json and spawns git. In the app the running
  // version is the app's own; a stored check carries the release it found, which is never "running".
  const version = deps.app?.version ?? deps.version ?? appVersion()
  const appDeps = deps.app
  /** The app update this process is staging right now, if any; see `stageAppUpdate`. */
  let staging: Promise<void> | undefined
  const now = () => (deps.now ?? (() => new Date()))()
  /**
   * What every page needs besides its own data: the clock, carrier health (for the lede and the nav
   * dot), and how many emails wait on /attention (for the lede and the nav count).
   */
  const ctx = (): PageCtx => {
    const at = now()
    return { now: at, health: carrierHealth(db), poller: pollerStatus(db, at), attention: countUnparsedMessages(db), appearance: config.appearance }
  }

  // Without authentication, a page the user happens to visit must not be able to drive this server:
  // a foreign Host header is a DNS-rebinding attempt, and a cross-site POST is a forged form. The Origin
  // of a write must be THIS server (same host and port), not merely some loopback address: another dev
  // server on localhost is just as foreign.
  app.addHook('onRequest', async (req, reply) => {
    // Second layer behind the structural escaping: even injected markup could load nothing and run nothing.
    // Two directives are open, each as narrow as it can be, and nothing else is:
    //   `img-src 'self' data:` - 'self' is the map preview: the tiles are served by this server from its
    //   own on-disk cache, so no third-party origin appears here. `data:` is the theme's paper grain,
    //   an inline SVG in the stylesheet; a data: image is bytes already in the page, it contacts nobody.
    //   `font-src 'self'` - the themes' fonts, served from /fonts/<file> out of this install (an
    //   allowlist of file names, see web/fonts.ts). No font is fetched from anywhere else.
    // There is still no `script-src`, so `default-src 'none'` keeps scripts, frames, connections and
    // everything else off.
    //
    // `frame-ancestors 'none'` (and X-Frame-Options for anything that predates it): no other page may
    // frame this one, or it could lay a decoy over the Delete or Update button and borrow the click.
    reply.header('Content-Security-Policy', CSP)
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    // No other site may even EMBED a response. Without this a page could `<img src>` a map tile from
    // this server and learn from `onload` which tiles are cached - which is where this person collects
    // their parcels. Reading the body is already impossible (no CORS); this stops the side channel.
    reply.header('Cross-Origin-Resource-Policy', 'same-origin')
    const host = req.headers.host ?? ''
    const refuse = () => reply.code(403).type('text/plain').send('forbidden')
    if (!LOCAL_HOST.test(host)) return refuse()
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const site = req.headers['sec-fetch-site']
      if (site !== undefined && site !== 'same-origin' && site !== 'none') return refuse()
      const origin = req.headers.origin
      if (origin !== undefined) {
        let originHost: string | undefined
        try { originHost = new URL(origin).host } catch { /* "null" and other unparseable origins are refused */ }
        if (originHost === undefined || originHost.toLowerCase() !== host.toLowerCase()) return refuse()
      }
    }
  })

  /**
   * The page context for an error page, which must render even when what failed is the database that
   * `ctx()` reads: then the page goes without the nav's health dot rather than not at all.
   */
  const errorCtx = (): PageCtx => {
    try { return ctx() } catch { return { now: new Date(), health: [], appearance: config.appearance } }
  }

  /** An error as a page of the app (see views/error.ts); plain text only if even that cannot render. */
  const sendError = (reply: FastifyReply, status: number, page: () => Html, fallback: string) => {
    let body: Html
    try { body = page() } catch { return reply.code(status).type('text/plain').send(fallback) }
    return send(reply, body, status)
  }

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500
    // The logger is off, so without this a 500 under launchd leaves nothing in web.err.log to diagnose.
    if (status >= 500) console.error(`${new Date().toISOString()} ${req.method} ${req.url}:`, err)
    if (status >= 500) return sendError(reply, status, () => serverErrorPage(errorCtx()), 'internal error')
    // A 4xx from Fastify itself (a body it could not parse, say): the request was malformed, not lost.
    return sendError(reply, status, () => errorPage('That did not work', 'The request could not be understood. Go back and try again.', errorCtx()), (err as Error).message)
  })

  // Unknown routes: Fastify would answer with JSON, which in a browser is a page of braces.
  app.setNotFoundHandler((_req, reply) => sendError(reply, 404, () => notFoundPage(errorCtx()), 'not found'))

  /**
   * What a page should say about the run named in `?run=N`, and whether it should re-request itself.
   *
   * Stale runs are closed FIRST, and that is the whole of the crash recovery: a process killed
   * mid-refresh leaves a row nothing will ever finish, and the next page view turns it into a failed
   * run rather than a dashboard that waits for it for ever. No restart, no sweep job - the recovery
   * happens on the next look, which is exactly when somebody is there to see it.
   *
   * `reloadIn` is set only while the run is genuinely unfinished, so the reload loop ends on its own:
   * either the run completes (the counters replace the spinner) or it is reaped (the failure does).
   *
   * No `run` in the query falls back to `refreshNote`, which knows only `?busy=1`.
   */
  const runState = (
    query: Record<string, unknown>, now: Date, active?: number,
  ): { note?: RefreshNote; reloadIn?: number } => {
    const id = one(query.run)
    if (id === undefined || !/^\d{1,12}$/.test(id)) return { note: refreshNote(query) }
    reapStaleRuns(db, now)
    const run = getRun(db, Number(id))
    if (!run) return {}                                     // trimmed away, or never existed
    if (!run.finishedAt) {
      return { note: { polled: 0, failures: 0, busy: false, startedAt: run.startedAt }, reloadIn: RELOAD_SECONDS }
    }
    return {
      note: {
        polled: run.polled, failures: run.failures, busy: false,
        read: run.mailRead, created: run.created, active, error: run.error,
      },
    }
  }

  /**
   * The dashboard. `refused` is an "Add to Calendar" submission the POST would not take: its parcel's
   * form opens again with the reason inside it, or - when the parcel no longer offers the form at all -
   * the reason is a notice at the top.
   */
  const home = (reply: FastifyReply, query: Record<string, unknown>, refused?: Refused, status = 200) => {
    const active = listActive(db)
    const ready = active.filter(p => p.status === 'ready_for_pickup').map(p => p.id)
    // One query for every code (and every calendar event) on the page, rather than one per parcel.
    const codes = pickupCodesFor(db, ready)
    const events = calendarEventsFor(db, ready)
    const entries = active.map(parcel => ({
      parcel, last: latestEvent(db, parcel.id), code: codes.get(parcel.id),
      cal: calState(parcel, events.get(parcel.id), refused),
    }))
    const c = ctx()
    const r = runState(query, c.now, entries.length)
    return send(reply, indexPage(entries, { ...c, reloadIn: r.reloadIn }, r.note, {
      mailConfigured: config.imap !== undefined, collected: justCollected(query, c.now),
      calendar: calendarResult(query, c.now),
      calendarRefused: refusedElsewhere(refused, active),
    }), status)
  }

  app.get('/', async (req, reply) => home(reply, req.query as Record<string, unknown>))

  /**
   * The parcel named by `?collected=<id>`, but only while it really is marked, recently, and not archived:
   * the URL names which notice to show and never what it says, so a stale or hand-edited one shows
   * nothing rather than an Undo for a mark that has gone.
   */
  const justCollected = (query: Record<string, unknown>, at: Date) => {
    const id = one(query.collected)
    const parcel = id === undefined ? undefined : parcelFor(id)
    const mark = parcel && userMark(db, parcel.id)
    if (!parcel || !mark || parcel.archivedAt !== undefined) return undefined
    const age = at.getTime() - mark.at.getTime()
    return age >= 0 && age <= COLLECTED_NOTICE_MS ? { parcel, mark } : undefined
  }

  /**
   * The tile grid to draw for a parcel, or nothing. Three conditions, all of them cheap: the preview is
   * on, the parcel is waiting for collection, and its point has coordinates. Then nine `existsSync`
   * calls decide whether a complete map can be drawn. No network, ever: the cache was filled by a poll.
   */
  const mapFor = (parcel: Parcel) => {
    const { lat, lon } = parcel.pickup ?? {}
    if (!config.mapPreview || parcel.status !== 'ready_for_pickup') return undefined
    if (lat === undefined || lon === undefined) return undefined
    return cachedGrid(tileDir, lat, lon)
  }

  const parcelView = (reply: FastifyReply, parcel: Parcel, query: Record<string, unknown>, refused?: Refused, status = 200) => {
    const c = ctx()
    // No `active` count here: "nothing is in flight yet" is a statement about the dashboard, and this
    // page's refresh only ever asked about one parcel.
    const r = runState(query, c.now)
    const result = calendarResult(query, c.now)
    return send(reply, parcelPage(
      parcel, listEvents(db, parcel.id), rawResponsesFor(db, parcel.id, parcel.carrier),
      { ...c, reloadIn: r.reloadIn }, r.note, mapFor(parcel),
      parcel.status === 'ready_for_pickup' ? getPickupCode(db, parcel.id) : undefined,
      userMark(db, parcel.id),
      {
        cal: calState(parcel, getCalendarEvent(db, parcel.id), refused),
        calendar: result?.parcel.id === parcel.id ? result.outcome : undefined,
        calendarRefused: refusedElsewhere(refused, [parcel]),
      },
    ), status)
  }

  app.get<{ Params: { id: string } }>('/parcel/:id', async (req, reply) => {
    const parcel = /^\d+$/.test(req.params.id) ? getParcel(db, Number(req.params.id)) : undefined
    if (!parcel) return notFound(reply, 'parcel')
    return parcelView(reply, parcel, req.query as Record<string, unknown>)
  })

  // --- Add to Calendar ---------------------------------------------------------------------------------

  /** The form's state for one parcel: the event already added, and the refused submission if it was this parcel's. */
  const calState = (p: Parcel, stored: CalendarFormState['stored'], refused?: Refused): CalendarFormState | undefined => {
    const mine = refused?.parcelId === p.id && calendarOffered(p) ? refused : undefined
    if (!stored && !mine) return undefined
    return { ...(stored && { stored }), ...(mine && { error: mine.error, day: mine.day, time: mine.time }) }
  }

  /** A refusal whose parcel shows no form to put it in (it stopped waiting, or was archived): said at the top instead. */
  const refusedElsewhere = (refused: Refused | undefined, shown: Parcel[]): string | undefined => {
    if (!refused) return undefined
    const p = shown.find(x => x.id === refused.parcelId)
    return p && calendarOffered(p) ? undefined : refused.error
  }

  /**
   * What each press came to, for the page it redirects to. In memory, like the settings page's connection
   * test: the URL names WHICH result (`?calendar=<id>`, an unguessable token) and never what it says, so
   * a bookmark or a hand-edited URL cannot make the page claim an event was added. Shown for an hour.
   */
  const calendarOutcomes = new Map<string, { at: Date; outcome: CalendarOutcome }>()
  const remember = (outcome: CalendarOutcome): string => {
    const id = randomBytes(6).toString('hex')
    calendarOutcomes.set(id, { at: now(), outcome })
    for (const key of calendarOutcomes.keys()) {
      if (calendarOutcomes.size <= CALENDAR_OUTCOMES_KEPT) break
      calendarOutcomes.delete(key)                                  // a Map iterates oldest first
    }
    return id
  }
  const calendarResult = (query: Record<string, unknown>, at: Date): { outcome: CalendarOutcome; parcel: Parcel } | undefined => {
    const id = one(query.calendar)
    const kept = id !== undefined && /^[0-9a-f]{12}$/.test(id) ? calendarOutcomes.get(id) : undefined
    if (!kept) return undefined
    const age = at.getTime() - kept.at.getTime()
    const parcel = getParcel(db, kept.outcome.parcelId)
    return parcel && age >= 0 && age <= CALENDAR_NOTICE_MS ? { outcome: kept.outcome, parcel } : undefined
  }

  /**
   * "Add to Calendar": the event goes into Calendar.app through osascript (core/calendar-app.ts).
   *
   * An ordinary POST, so the `onRequest` guard refuses a foreign Host or a cross-site form like any other
   * write. An unknown parcel is the 404 page. A parcel that no longer offers the form (not waiting for
   * collection, or archived) or a slot the form does not offer right now - a past time on today, a day
   * outside the range, anything malformed - is refused with a 400 that shows the page again, with the
   * form open and the reason in it: the page has no script, so "that time has passed" is said here.
   *
   * Adding again for the same parcel replaces the event added before (its uid is in `calendar_events`)
   * rather than adding a second one. Whatever happens, the request ends in a redirect to the page the
   * form was on, which shows the result: where the event went, or why it did not and the .ics instead.
   */
  app.post<{ Params: { id: string } }>('/parcel/:id/calendar', async (req, reply) => {
    const parcel = parcelFor(req.params.id)
    if (!parcel) return notFound(reply, 'parcel')
    const f = form(req)
    const back = text(f.back) === 'home'
    const day = text(f.day)
    // "Other" sends its time in `at`; the field is on the page (hidden) whichever radio is checked.
    const time = text(f.time) === 'other' ? text(f.at) : text(f.time)
    const at = now()
    const refuse = (error: string) => {
      const refused: Refused = { parcelId: parcel.id, error, day, time }
      return back ? home(reply, {}, refused, 400) : parcelView(reply, parcel, {}, refused, 400)
    }
    if (!calendarOffered(parcel)) {
      return refuse(`${parcelName(parcel)} is no longer waiting for collection, so it was not added to Calendar.`)
    }
    const slots = pickupSlots(parcel.retainedTill, at)
    if (!slotAllowed(slots, day, time)) return refuse(slotRefusal(slots, day, time, at))
    const start = slotStart(day, time)!
    const stored = getCalendarEvent(db, parcel.id)
    let outcome: CalendarOutcome
    try {
      const added = await calendar.add(
        pickupEventSpec(parcel, getPickupCode(db, parcel.id), start, at),
        config.pickupCalendar,
        stored && { uid: stored.uid, calendar: stored.calendar },
      )
      saveCalendarEvent(db, { parcelId: parcel.id, uid: added.uid, calendar: added.calendar, startsAt: start, createdAt: now() })
      // The day and time, never the locker code that went into the event's description, nor the
      // calendar's name, which is the person's own words.
      logAction(db, { kind: 'calendar_added', parcelId: parcel.id, carrier: parcel.carrier, day, time, replaced: stored !== undefined }, acted())
      outcome = { ok: true, parcelId: parcel.id, calendar: added.calendar, startsAt: start, replaced: stored !== undefined }
    } catch (err) {
      const failed = err instanceof CalendarFailure ? err : new CalendarFailure('other', err instanceof Error ? err.message : String(err))
      if (failed.kind === 'other') console.error(`${new Date().toISOString()} POST /parcel/${parcel.id}/calendar:`, failed.message)
      outcome = {
        ok: false, parcelId: parcel.id, kind: failed.kind, day, time,
        ...(failed.detail !== undefined && { detail: failed.detail }),
        ...((failed.calendar ?? config.pickupCalendar) !== undefined && { calendar: failed.calendar ?? config.pickupCalendar }),
      }
    }
    const id = remember(outcome)
    // To the notice: a Location without a fragment would inherit the form's `#cal-<id>`, and the result is
    // said in the notice, not in the form.
    return reply.redirect(back ? `/?calendar=${id}#cal-result` : `/parcel/${parcel.id}?calendar=${id}#cal-result`, 303)
  })

  /**
   * The same event as a file: the fallback every failure offers, and what Calendar.app opens straight
   * into its Add dialog when Safari is handed it `inline`. `?day=YYYY-MM-DD&time=HH:MM` must be a slot the
   * form offers right now (else 400); with neither, it is the form's default slot (the last day, at 9:00
   * or the first time still to come), so an old link still works.
   *
   * A GET with no side effects and no network: it reads the database and builds a string, behind the
   * same Host check and headers as every page. Offered on exactly the parcels the form is; anything else
   * is the ordinary 404 page, "no such parcel" only when there is none. Nothing is logged: the body
   * carries the locker code.
   */
  app.get<{ Params: { id: string } }>('/parcel/:id/calendar.ics', async (req, reply) => {
    const parcel = parcelFor(req.params.id)
    if (!parcel) return notFound(reply, 'parcel')
    if (!calendarUrl(parcel)) return notFound(reply)
    const query = req.query as Record<string, unknown>
    const at = now()
    const slots = pickupSlots(parcel.retainedTill, at)
    const asked = one(query.day) !== undefined || one(query.time) !== undefined
    const day = asked ? one(query.day) ?? '' : slots.day
    const time = asked ? one(query.time) ?? '' : slots.time
    if (day === undefined || time === undefined || !slotAllowed(slots, day, time)) {
      return sendError(reply, 400, () => errorPage('That time cannot be chosen', html`${
        day === undefined ? 'There is no time left to plan this pickup for.' : slotRefusal(slots, day, time ?? '', at)} Go back to <a href="/parcel/${parcel.id}">${parcelName(parcel)}</a> and choose again.`, errorCtx()),
      'that day and time cannot be chosen')
    }
    return reply.code(200)
      .type('text/calendar; charset=utf-8')
      .header('content-disposition', `inline; filename="${calendarFilename(parcel)}"`)
      .send(parcelCalendar(parcel, getPickupCode(db, parcel.id), slotStart(day, time)!, at))
  })

  /**
   * One cached map tile, read from `data/tiles` and nothing else.
   *
   * The three parameters arrive as arbitrary strings - Fastify percent-decodes them, so `..%2f..%2f`
   * reaches this handler as a real `../../` - and the only defence that matters is that they are
   * never used as strings. `parseTile` either returns three integers in range or nothing, and the
   * path is assembled from those integers, so there is no spelling of this URL that names a file
   * outside the cache. A tile that is not cached is a 404; this route never fetches anything.
   */
  app.get<{ Params: { z: string; x: string; y: string } }>('/tile/:z/:x/:y.png', async (req, reply) => {
    if (!config.mapPreview) return noTile(reply)
    const tile = parseTile(req.params.z, req.params.x, req.params.y)
    const bytes = tile && readTile(tileDir, tile)
    if (!bytes) return noTile(reply)
    // A given z/x/y is the same picture for months, and it is already on local disk; a day of browser
    // caching saves the re-request without ever making the page depend on a remote service.
    return reply.code(200).type('image/png').header('cache-control', 'private, max-age=86400').send(bytes)
  })

  /**
   * One theme font, from the install's `assets/fonts` and nothing else.
   *
   * Fastify percent-decodes the parameter, so `..%2fconfig.json` arrives as `../config.json`. The name
   * is therefore checked against the allowlist (`FONT_FILES`, every file a theme names) before any
   * disk access, and `readFont` builds the path only from a name that passed. Anything else beside the
   * fonts - the licences, the READMEs, other folders - is a 404, as is a listed font that is missing.
   */
  app.get<{ Params: { file: string } }>('/fonts/:file', async (req, reply) => {
    const bytes = readFont(fontDir, req.params.file)
    if (!bytes) return reply.code(404).type('text/plain').send('not found')
    return reply.code(200).headers(FONT_HEADERS).send(bytes)
  })

  /**
   * What this server is, for the activity log: the web, on the clock the page is rendering with. One
   * helper, so no route can attribute its own action to the poller by copying the wrong literal.
   */
  const acted = (): Cause => ({ actor: 'web', at: now() })

  /** A 404 as a page with a way home: a stale form or an old link must not strand anybody. */
  const notFound = (reply: FastifyReply, what: 'page' | 'parcel' | 'email' = 'page') =>
    sendError(reply, 404, () => notFoundPage(errorCtx(), what), 'not found')
  /** A tile that is not cached. Plain: only an `<img>` ever asks, and nobody reads the answer. */
  const noTile = (reply: FastifyReply) => reply.code(404).type('text/plain').send('not found')
  const form = (req: { body: unknown }): Record<string, string> => (req.body ?? {}) as Record<string, string>
  const text = (v: string | undefined) => (v ?? '').trim()
  const parcelFor = (id: string) => (/^\d+$/.test(id) ? getParcel(db, Number(id)) : undefined)
  const calendar = deps.calendar ?? osascriptCalendar()

  /** The writable calendars for the settings page, or why they could not be listed. Never throws. */
  const calendarList = async (): Promise<CalendarList> => {
    try {
      return { ok: true, names: await calendar.listWritable() }
    } catch (err) {
      return { ok: false, why: calendarListWhy(err) }
    }
  }

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)))
  })

  app.get('/history', async (req, reply) => {
    const query = req.query as Record<string, unknown>
    const carrier = one(query.carrier)
    const filters = {
      carrier: carrier !== undefined && Object.hasOwn(CARRIER_NAME, carrier) ? (carrier as CarrierId) : undefined,
      q: one(query.q)?.trim().slice(0, 100) || undefined,
      from: one(query.from) || undefined,
      to: one(query.to) || undefined,
    }
    const day = (v: string | undefined, end: boolean) => {
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined
      const d = DateTime.fromISO(v, { zone: 'Europe/Bratislava' })
      return d.isValid ? (end ? d.endOf('day') : d.startOf('day')).toJSDate() : undefined
    }
    const parcels = listDelivered(db, {
      carrier: filters.carrier, q: filters.q, from: day(filters.from, false), to: day(filters.to, true),
    })
    return send(reply, historyPage(parcels, deliveryStats(db), filters, ctx(), userMarks(db)))
  })

  /** The checkout the Update section is about, and where that update's log and status file live. */
  const updateRoot = () => deps.update?.root ?? repoRoot()
  const updateDataDir = () => deps.update?.dataDir ?? dirname(config.dbPath)

  /**
   * The Update section's two facts, gathered per request.
   *
   * Reading the status file here is also what records a finished update in the activity log: the
   * process that started it was deliberately replaced by it, so it could not write the outcome
   * itself. `adoptUpdateOutcome` is idempotent, so this page can be opened as often as anyone likes.
   */
  const updateView = (now: Date): UpdateView => {
    const dataDir = updateDataDir()
    const outcome = adoptUpdateOutcome(db, dataDir, now, { actor: 'web', at: now })
    const run = readUpdateRun(updateStatusPath(dataDir))
    const check = getUpdateCheck(db)
    return {
      ...(check && { check }),
      ...(run && { run }),
      ...(outcome && { outcome }),
    }
  }

  /** The app updater's status file, read per request (the staging writes it as it goes). Never throws. */
  const appStatus = (): AppUpdateStatus | undefined =>
    appDeps ? readAppUpdateStatus(appUpdateStatusPath(appDeps.supportDir)) : undefined

  /** What Health says about the app that runs it; undefined in the git install. */
  const appHealth = (at: Date): AppHealth | undefined => {
    if (!appDeps) return undefined
    const update = appStatus()
    return {
      version: appDeps.version, startedAt: appDeps.startedAt, restarts: appDeps.restarts(), nextSlot: nextSlot(at),
      ...(update && { update }),
    }
  }

  const health = (reply: FastifyReply, support?: string) => {
    const c = ctx()
    // Reaped here too, not only on the pages that wait for a run: this is the page somebody opens to ask
    // whether the app is working, and a run abandoned by a killed process must read as failed on it.
    reapStaleRuns(db, c.now)
    // In the app only the stored check is shared with the git updater: its status file and its
    // activity-log adoption belong to a `git pull` that this install never runs.
    const appInfo = appHealth(c.now)
    const check = getUpdateCheck(db)
    const update: UpdateView = appInfo ? { ...(check && { check }) } : updateView(c.now)
    const busy = appInfo ? appUpdateBusy(appInfo, c.now) || staging !== undefined : updateBusy(update)
    // The same mechanism the refresh uses, and deliberately not a second one: while an update is in
    // flight the page carries a `<meta http-equiv="refresh">` and the spinner, and when it is not,
    // `reloadIn` is absent and the browser stops asking (see `runState` and views/layout.ts).
    const page = { ...c, ...(busy && { reloadIn: RELOAD_SECONDS }) }
    return send(reply, healthPage(
      c.health, { configured: config.imap !== undefined, status: getIngestStatus(db) },
      c.poller ?? { overdue: false }, page, version, listRuns(db, RUNS_SHOWN), support,
      listActivity(db, ACTIVITY_SHOWN), update, appInfo,
    ))
  }

  app.get('/health', async (_req, reply) => health(reply))

  /**
   * The support bundle, generated fresh on every request. `config` is read from the holder rather than
   * from `deps`, so a bundle gathered after a settings save describes what the server is running on now.
   *
   * One generator for both routes (see core/support.ts): the block the sender reads and the file he
   * attaches are the same bytes, give or take the "Generated" line if he waits between the two.
   */
  const supportBundle = (): string => {
    const at = now()
    const update = appStatus()
    return buildSupportBundle({
      db, config, version, now: at,
      env: deps.support?.env, launchd: deps.support?.launchd, dataDir: deps.support?.dataDir,
      // In the app there are no launchd agents to ask and no data/*.log files: the app block and the
      // server's own log take their place (see core/support.ts).
      ...(appDeps && {
        app: {
          version: appDeps.version,
          electron: process.versions.electron ?? 'not reported',
          uptimeS: Math.max(0, Math.round((at.getTime() - appDeps.startedAt.getTime()) / 1000)),
          restarts: appDeps.restarts(),
          logPath: join(appDeps.logDir, 'server.log'),
          ...(update && { update }),
        },
      }),
    })
  }

  /**
   * POST, not GET: it spawns `launchctl` and walks the mail directory, which a prefetch or a reload of
   * /health must not do. It answers with the Health page carrying the bundle rather than with a redirect,
   * because the bundle is not stored anywhere - there is nothing for a redirect to come back and read.
   */
  app.post('/support', async (_req, reply) => health(reply, supportBundle()))

  /**
   * The same bundle as a file. This is the only way to offer a download without JavaScript, and the
   * only reason it is a separate route: `Content-Disposition` cannot be set on a page that also has to
   * show the thing. The clipboard route is the `.sel` block on /health; see views/health.ts.
   */
  app.get('/support.txt', async (_req, reply) => reply.code(200)
    .type('text/plain; charset=utf-8')
    .header('content-disposition', `attachment; filename="${supportBundleFilename(now())}"`)
    .send(supportBundle()))

  /**
   * The Gmail filter, as a download for the guide on /settings: Gmail's Import filters wants a file
   * chosen from disk, and Downloads is where anyone can find one. Read per request from the resource root -
   * the checkout in the git install (the one copy, the file the README points at), the bundle's
   * Resources folder in the app - and the ordinary 404 if it is not there.
   */
  app.get('/gmail-filter.xml', async (_req, reply) => {
    let xml: string
    try { xml = readFileSync(join(resourceRoot(), 'gmail-filter.xml'), 'utf8') } catch { return notFound(reply) }
    return reply.code(200)
      .type('application/xml; charset=utf-8')
      .header('content-disposition', 'attachment; filename="gmail-filter.xml"')
      .send(xml)
  })

  const attention = (reply: FastifyReply, error?: AttentionError, status = 200) =>
    send(reply, attentionPage(
      listUnparsedMessages(db), listActive(db).filter(p => isDormant(p, now())), ctx(), error, config.defaultPostalCode,
    ), status)
  app.get('/attention', async (_req, reply) => attention(reply))

  app.get('/add', async (_req, reply) => send(reply, addPage(ctx(), undefined, undefined, config.defaultPostalCode)))

  app.post('/add', async (req, reply) => {
    const f = form(req)
    const values = { number: text(f.number), carrier: text(f.carrier), label: text(f.label), postcode: text(f.postcode) }
    const result = addParcel(db, config, { ...values, source: 'manual' })
    if (result.ok) return reply.redirect(`/parcel/${result.id}`, 303)
    return send(reply, addPage(ctx(), result.message, values, config.defaultPostalCode), result.status)
  })

  /**
   * The config file as it is on disk, with the reason it would not load if it would not. Read per
   * request, deliberately: `deps.config` is what this process started with, and after a save (here,
   * in another tab, or by hand) that is no longer what the file says. The file is a few hundred bytes
   * and settings requests are rare, so reading it is cheaper than any scheme for keeping a copy true.
   */
  const current = (): { doc: ConfigDocument; valid?: Config; error?: string } => {
    const doc = readConfigDocument(configPath)
    try {
      return { doc, valid: validateConfig(doc, configPath) }
    } catch (err) {
      return { doc, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const settings = async (
    reply: FastifyReply, file: { doc: ConfigDocument; error?: string },
    state: SettingsState = {}, values?: SettingsValues, status = 200,
  ) => send(reply, settingsPage(
    values ?? settingsValues(file.doc),
    { port: config.port, dbPath: config.dbPath, configPath },
    ctx(), { ...state, configError: file.error, calendars: await calendarList() }, appDeps !== undefined,
  ), status)

  /**
   * The connection test a save ran, kept for the page the save redirects to. One slot, in memory: the
   * redirect needs somewhere to find the answer (the page must not dial the mail server itself just
   * because it was loaded or reloaded), and only the latest save's answer is worth showing. It holds
   * the probe's result, which never contains the password (see `probeImap`).
   */
  let saveTest: { id: number; test: ImapProbeResult } | undefined
  let saveTests = 0

  app.get('/settings', async (req, reply) => {
    const query = req.query as Record<string, unknown>
    const testId = one(query.test)
    const test = saveTest !== undefined && testId === String(saveTest.id) ? saveTest.test : undefined
    return settings(reply, current(), { saved: one(query.saved) === '1', ...(test && { test }) })
  })

  app.post('/settings', async (req, reply) => {
    const file = current()
    // The app's page has no notifier field (the app posts its own notifications), so the form does not
    // send one: the file's value is put back in before the form is applied, and a file that had none is
    // left without one, so a save neither changes it nor records it as changed.
    const f = appDeps ? { ...form(req), notifier: settingsValues(file.doc).notifier } : form(req)
    const applied = applySettings(file.doc, f)
    const result = applied.ok && appDeps && file.doc.notifier === undefined
      ? { ...applied, doc: withoutNotifier(applied.doc) } : applied
    if (!result.ok) return settings(reply, file, { error: result.message }, submittedSettings(f, file.doc), 400)
    // Validated against loadConfig's own rules and written atomically at 0600 (writeConfigDocument):
    // a file this app could not load would stop the poller AND this server at their next start.
    const saved = writeConfigDocument(configPath, result.doc)
    // `port` and `dbPath` are bound to the open socket and the open database, so they stay as they are.
    config = { ...saved, port: config.port, dbPath: config.dbPath }
    // Only after the file was written, and only the field NAMES: see `changedSettingFields`. A rejected
    // save returned above and records nothing, because nothing was saved.
    const changed = changedSettingFields(file.doc, result.doc)
    logAction(db, { kind: 'settings_saved', fields: changed }, acted())
    // A save that touched the mail settings is tested at once, so "did that work?" is answered on the
    // page it lands on rather than three polls later on /health. A save of the postcode alone does not
    // dial anything: nothing about the mailbox changed, and a test can take seconds when offline.
    const mailChanged = changed.some(f => f === 'imap' || f.startsWith('imap.'))
    if (mailChanged && config.imap) {
      const imap = config.imap
      saveTests += 1
      saveTest = { id: saveTests, test: await probeImap({ config: imap, client: deps.imapClient?.(imap) }) }
      return reply.redirect(`/settings?saved=1&test=${saveTest.id}`, 303)
    }
    return reply.redirect('/settings?saved=1', 303)
  })

  /**
   * The connection test. POST, not GET, because it opens a TLS connection to the mail server, and a
   * page must not do that because it was prefetched or reloaded.
   *
   * It tests the settings as SAVED, not as typed, so the answer is about the configuration the poller
   * will use. A save of the mail settings runs the same probe by itself; this is "Test again". `probeImap` opens the mailbox read-only, never rejects, and keeps the App Password out
   * of its result, so a failure is an answer on the page and not a 500 with a credential in the log.
   */
  app.post('/settings/test', async (_req, reply) => {
    const file = current()
    if (!file.valid) return settings(reply, file)   // the page explains why the file will not load
    const imap = file.valid.imap
    const test: ImapProbeResult = await probeImap({ config: imap, client: imap && deps.imapClient?.(imap) })
    return settings(reply, file, { test })
  })

  app.post<{ Params: { messageId: string } }>('/attention/:messageId/assign', async (req, reply) => {
    const messageId = Number(req.params.messageId)
    const message = Number.isInteger(messageId) ? getUnparsedMessage(db, messageId) : undefined
    if (!message) return notFound(reply, 'email')
    const f = form(req)
    const values = { number: text(f.number), carrier: text(f.carrier), label: text(f.label), postcode: text(f.postcode) }
    const link = (parcelId: number) => linkMessage(db, messageId, parcelId)
    const result = db.transaction(() => {
      const r = addParcel(db, config, { ...values, source: 'email', sourceMessageId: message.messageId })
      // The email is about a parcel we already track: resolve it against that parcel rather than leave it waiting.
      if (r.ok) link(r.id)
      else if (r.status === 409) link(r.existingId)
      // Logged inside the transaction, from the parcel the mail was actually attached to: the id, never
      // the number that was typed and never the sender or subject of the mail.
      const parcelId = r.ok ? r.id : r.status === 409 ? r.existingId : undefined
      if (parcelId !== undefined) {
        const linked = getParcel(db, parcelId)
        if (linked) logAction(db, { kind: 'message_assigned', parcelId, carrier: linked.carrier }, acted())
      }
      return r
    })()
    if (result.ok) return reply.redirect(`/parcel/${result.id}`, 303)
    if (result.status === 409) return reply.redirect(`/parcel/${result.existingId}`, 303)
    return attention(reply, { messageId, message: result.message, values }, result.status)
  })

  /**
   * Clearing the queue: every message the page listed, or every one of them from a single sender.
   *
   * `up_to` is the newest row id the page rendered, and it is REQUIRED - a bulk dismissal has to be
   * anchored to the list the person was looking at, or a stale page could clear mail that arrived
   * since. A malformed one is a 404 rather than a generous default, because the generous default here
   * is "dismiss everything". Decimal digits only: `Number('1e9')` is an integer too.
   *
   * The confirm step is the `<details>` disclosure on the page itself (see `clearSection`), which is
   * why this route does no confirming of its own. Idempotent, so a double submit is harmless.
   */
  app.post('/attention/dismiss', async (req, reply) => {
    const f = form(req)
    const upTo = text(f.up_to)
    if (!/^[0-9]+$/.test(upTo) || Number(upTo) < 1) return notFound(reply)
    const from = text(f.from)
    dismissMessages(db, { upTo: Number(upTo), from: from === '' ? undefined : from }, acted())
    return reply.redirect('/attention', 303)
  })

  // Junk mail with no tracking number is not a parcel and never will be, so it must be possible to
  // take it off the list. `getUnparsedMessage` is the same guard the assign route uses, so a stale page
  // or a double submit is a 404 rather than a second write. No confirm step: one row, one button.
  app.post<{ Params: { messageId: string } }>('/attention/:messageId/dismiss', async (req, reply) => {
    const messageId = Number(req.params.messageId)
    const message = Number.isInteger(messageId) ? getUnparsedMessage(db, messageId) : undefined
    if (!message) return notFound(reply, 'email')
    dismissMessage(db, messageId, acted())
    return reply.redirect('/attention', 303)
  })

  app.post<{ Params: { id: string } }>('/parcel/:id/label', async (req, reply) => {
    const parcel = parcelFor(req.params.id)
    if (!parcel) return notFound(reply, 'parcel')
    setLabel(db, parcel.id, text(form(req).label).slice(0, MAX_LABEL))
    return reply.redirect(`/parcel/${parcel.id}`, 303)
  })

  app.post<{ Params: { id: string } }>('/parcel/:id/postcode', async (req, reply) => {
    const parcel = parcelFor(req.params.id)
    if (!parcel) return notFound(reply, 'parcel')
    setPostalCode(db, parcel.id, cleanPostcode(form(req).postcode))
    return reply.redirect(`/parcel/${parcel.id}`, 303)
  })

  // Irreversible, so the confirm step is the `<details>` disclosure on the parcel page itself (there is no
  // JS for a dialog, and a separate confirm page would be a second route showing what the page already
  // shows). The page it redirects to cannot be this parcel's: it no longer exists.
  app.post<{ Params: { id: string } }>('/parcel/:id/delete', async (req, reply) => {
    const parcel = parcelFor(req.params.id)
    if (!parcel) return notFound(reply, 'parcel')
    deleteParcel(db, parcel.id, acted())
    return reply.redirect('/', 303)
  })

  /**
   * "Mark as collected" (or received) and its Undo. Ordinary POST routes, so the `onRequest` guard above
   * refuses a foreign Host and a cross-site form like every other write. An unknown parcel is the 404
   * page; a parcel that cannot be marked (already delivered or returned, or archived) or un-marked (no
   * mark of the user's on it) is sent back where it came from with nothing changed - a stale page or a
   * double click, not an error worth a page of its own.
   *
   * From the dashboard (`back=home`) a mark lands on the dashboard with the Undo notice, and an undo
   * lands back on the dashboard, where the parcel has reappeared. From anywhere else, the parcel page.
   */
  app.post<{ Params: { id: string } }>('/parcel/:id/collected', async (req, reply) => {
    const parcel = parcelFor(req.params.id)
    if (!parcel) return notFound(reply, 'parcel')
    const home = text(form(req).back) === 'home'
    const r = markCollected(db, parcel.id, acted())
    if (!r.ok) return reply.redirect(home ? '/' : `/parcel/${parcel.id}`, 303)
    return reply.redirect(home ? `/?collected=${parcel.id}` : `/parcel/${parcel.id}`, 303)
  })

  app.post<{ Params: { id: string } }>('/parcel/:id/uncollected', async (req, reply) => {
    const parcel = parcelFor(req.params.id)
    if (!parcel) return notFound(reply, 'parcel')
    undoCollected(db, parcel.id, acted())
    return reply.redirect(text(form(req).back) === 'home' ? '/' : `/parcel/${parcel.id}`, 303)
  })

  // A real poll, run from this process. The click is the user saying "now", so the per-parcel backoff tier is
  // skipped (`forceAll`), but only for the parcels they pointed at: `forceAll` skips `isDue` entirely, which
  // would also wake dormant parcels, so the set is chosen here. The gated-carrier throttle and the
  // needs_postcode skip are applied by `runPoll` regardless, so clicking cannot hammer a broken carrier.
  // A notifier is passed so a status change found here is announced, not consumed.
  //
  // No `mapPreview` here, deliberately: geocoding is rate-limited to one request per second and that
  // limit can only be held if ONE process does it. The hourly poller is that process. A click would
  // also have to wait out those politeness gaps before the redirect. So a pickup point found by a
  // manual refresh gets its map at the next hourly poll, and shows the address link until then.
  //
  // The run does NOT hold the request open. Since the mailbox became part of it, a first run downloads a
  // whole mailbox and can take minutes, and a blocked POST shows the user nothing at all for that whole
  // time. So the row is opened, the run is started, and the response is a redirect to the page that
  // reports that row - which re-renders itself until the row is finished. `refreshing` still guards
  // against a double click, and is now released by the background run rather than by the request.
  let refreshing = false
  app.post('/refresh', async (req, reply) => {
    const target = text(form(req).parcel)
    let back = '/'
    let scope: RefreshScope
    if (target !== '') {
      const parcel = parcelFor(target)
      if (!parcel) return notFound(reply, 'parcel')
      scope = { parcelIds: [parcel.id] }
      back = `/parcel/${parcel.id}`
    } else {
      // A rule, not a list of ids: the run reads the mailbox before it polls, and a list taken now would
      // leave out every parcel that mail creates - on a new install, all of them, which then sat at
      // "unknown" until the hourly poll. Dormant parcels are left out by the run itself.
      const t = now().getTime()
      const select = (p: Parcel) => p.lastAttemptedAt === undefined || t - p.lastAttemptedAt.getTime() > MIN_REFRESH_GAP_MS
      scope = { select, pressed: listActive(db).filter(p => !isDormant(p, now()) && select(p)).length }
    }
    // A double click must not poll twice. The second click is answered with the run already in flight,
    // so it lands on the spinner rather than on an error it can do nothing about.
    if (refreshing) {
      const live = runningRun(db)
      return reply.redirect(live ? `${back}?run=${live.id}` : `${back}?busy=1`, 303)
    }
    refreshing = true
    try {
      return await startRefresh(reply, target, scope, back)
    } catch (err) {
      // Anything that throws before the background run owns the guard (opening the run row, logging
      // the press, starting the poll) must hand it back here: nothing else ever would, and every later
      // click would be told a refresh is already running for the rest of this process's life.
      refreshing = false
      throw err
    }
  })

  /** Everything after the guard is taken. Once `work` exists, releasing the guard is its job. */
  const startRefresh = async (reply: FastifyReply, target: string, scope: RefreshScope, back: string) => {
    // Read the mailbox too, but only for the whole-dashboard refresh. This is what the button is for
    // on a new install: with no parcels yet, polling carriers can do nothing, and without this the
    // only way to turn mail into parcels was to wait for the next hourly run. A single-parcel
    // refresh asks about that parcel and should not go near the mailbox.
    const ingest = target === '' && config.imap
      ? {
          imap: config.imap,
          mailDir: join(dirname(config.dbPath), 'mail'),
          ...(deps.ingestClient ? { client: deps.ingestClient } : {}),
        }
      : undefined
    // Claimed, not just started: the hourly poller is another process and the in-process guard cannot
    // see it. If it is mid-run, this click joins that run's spinner instead of starting a second one.
    const claim = claimRun(db, 'web', now())
    if (!claim.claimed) {
      refreshing = false
      return reply.redirect(`${back}?run=${claim.live.id}`, 303)
    }
    const runId = claim.id
    // The press itself is an entry, not only its effects: "nothing changed when I pressed refresh" is a
    // report, and without this there would be no record that it was ever pressed. The count is how many
    // parcels it actually covered, which is the other half of that answer.
    logAction(db, {
      kind: 'refresh', count: scope.parcelIds?.length ?? scope.pressed ?? 0, scope: target === '' ? 'all' : 'one',
    }, { actor: 'web', runId, at: now() })
    let work: Promise<unknown>
    try {
      work = recordPollRun(db, runId, runPoll({
        db, config, ...(scope.parcelIds ? { parcelIds: scope.parcelIds } : {}), ...(scope.select ? { select: scope.select } : {}),
        forceAll: true, ingest,
        http: deps.http ?? createHttpClient(),
        adapters: deps.adapters ?? allAdapters(),
        notifier: deps.notifier ?? notifierFor(config),
        now: now(),
        // A status change found by the button is the WEB acting, not the hourly poller: the whole point
        // of attributing these is that "it changed while I was looking at it" is a different fact.
        cause: { actor: 'web', runId, at: now() },
      }), now)
    } catch (err) {
      // Building the poll's dependencies threw, so the row is open and nothing will ever run it: close
      // it as what it is, rather than leave Health showing a run in progress until it goes stale.
      try { failRun(db, runId, `the refresh could not start: ${err instanceof Error ? err.message : String(err)}`, now()) } catch { /* the 500 says enough */ }
      throw err
    }
    // Nothing awaits `work` on the request path, so its rejection has to be dealt with here or it is an
    // unhandled rejection that takes the process down. `recordPollRun` has already written it to the run
    // row by this point, which is where the user will see it; this only keeps the server alive and puts
    // it in the log. The guard is released either way, so one failed run cannot wedge the button.
    inFlightRefresh.set(app, work.then(() => {}, (err: unknown) => {
      console.error(`${new Date().toISOString()} POST /refresh: run ${runId} failed:`, err)
    }).finally(() => { refreshing = false }))
    return reply.redirect(`${back}?run=${runId}`, 303)
  }

  /**
   * One check: a `git fetch` and nothing else (`scripts/update.sh --check` moves remote-tracking refs
   * and touches neither the working tree nor the branch). POST, not GET, for exactly the reason the
   * support bundle and the mail test are POSTs: it reaches the network, and a page must not do that
   * because a browser prefetched or reloaded it.
   *
   * Never fails: `checkForUpdateAsync` turns a missing script, a timeout or a refusal into a `blocked`
   * result, which the page prints. The answer is stored, so the result survives the redirect.
   *
   * Awaited, not run synchronously: the fetch can take up to a minute, and the rest of the dashboard
   * must keep answering while this one request waits for it.
   */
  app.post('/update/check', async (_req, reply) => {
    if (appDeps) {
      // The app asks GitHub Releases, as its daily check does (core/runtime.ts); never the checkout's script.
      const check = appDeps.check
        ?? (() => checkAppRelease(appDeps.version, githubFetchJson(appDeps.version), appDeps.releasesUrl ?? RELEASES_URL))
      recordUpdateCheck(db, await check(), now())
      return reply.redirect('/health#update', 303)
    }
    recordUpdateCheck(db, await checkForUpdateAsync(deps.update?.run ?? undefined), now())
    return reply.redirect('/health', 303)
  })

  /**
   * Installing it. The one route on this server that runs code fetched from the internet, so:
   *
   * - POST only, behind the `onRequest` hook's foreign-Host and cross-site refusals, like every other
   *   write here. There is no GET spelling of it, so no prefetch, reload or crawl can reach it.
   * - It refuses unless a check has actually found commits to install. "Behind" is a stored fact
   *   somebody caused by pressing Check or by leaving the poller running; without it this route does
   *   nothing at all, which also means a POST to a copy that is not a git checkout spawns nothing.
   * - One at a time: a second press while one is going lands on the page that is already following it.
   * - And it is never automatic. Nothing in this app calls this route.
   *
   * The child is detached because the update replaces this process; `startUpdate` is where that is
   * explained. Nothing is awaited: the page follows the status file the child writes.
   */
  app.post('/update', async (_req, reply) => {
    const check = getUpdateCheck(db)
    if (!check || check.state !== 'behind') {
      // Most often a second press on a page from before the update finished: say so, and point back.
      return sendError(reply, 409, () => errorPage('Nothing to install', html`There is no update waiting to be installed. Open <a href="/health">Health</a> to see which version this is and to check for a newer one.`, errorCtx()),
        'there is nothing to install: check for an update first, and read what it found')
    }
    if (appDeps) return stageAppUpdate(reply, appDeps, check)
    const running = readUpdateRun(updateStatusPath(updateDataDir()))
    if (running && updateOutcome(running, now()) === 'running') return reply.redirect('/health', 303)
    startUpdate({
      root: updateRoot(),
      dataDir: updateDataDir(),
      startedAt: now(),
      ...(deps.update?.spawn && { spawn: deps.update.spawn }),
      ...(deps.update?.openLog && { openLog: deps.update.openLog }),
      ...(deps.update?.closeLog && { closeLog: deps.update.closeLog }),
    })
    return reply.redirect('/health', 303)
  })

  /**
   * The app's Update now: download and verify the release the check found (`stageUpdate`), in this
   * process, without waiting for it; the page follows the status file the staging writes, as it follows
   * the git updater's. Two guards keep it to one at a time. `staging` is the staging this process has
   * in flight, which is the authoritative answer while it lives; the status file covers a press that
   * arrives from a page after a restart, and stops counting once it is stale, so a download that died
   * with its process cannot hide the button for ever. A second staging would delete the first's folder
   * under it (`stageUpdate` clears leftovers before it starts). And the check's version must be newer
   * than this app: a "behind" stored by an older copy, before a newer one was installed by hand, would
   * otherwise stage, and then install, a downgrade.
   */
  const stageAppUpdate = (reply: FastifyReply, a: AppWebDeps, check: UpdateCheck) => {
    if (staging || appUpdateDownloading(appStatus(), now())) return reply.redirect('/health#update', 303)
    if (check.version !== undefined && !newerThanRunning(check.version, a.version)) {
      return sendError(reply, 409, () => errorPage('Nothing to install', html`Parcels ${check.version} is not newer than the Parcels that is running, so there is nothing to install. Open <a href="/health">Health</a> and press Check for updates.`, errorCtx()),
        'the version the check found is not newer than the one running')
    }
    if (!a.stage || !check.version || a.appBundle === '') {
      return sendError(reply, 409, () => errorPage('Cannot update from here', 'This copy of Parcels does not know where it is installed, so it cannot update itself. Download the new version from GitHub and drag it into Applications.', errorCtx()),
        'this copy of Parcels cannot update itself')
    }
    const run = a.stage({
      version: check.version, appBundle: a.appBundle, supportDir: a.supportDir, now,
      ...(a.releasesUrl !== undefined && { releaseBase: downloadBaseBeside(a.releasesUrl, check.version) }),
    })
    staging = run
      .then(() => {}, err => {
        // `stageUpdate` never rejects; a stage that did anyway must not become an unhandled rejection,
        // which would take this server down.
        console.error(`${new Date().toISOString()} update: staging failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => { staging = undefined })
    return reply.redirect('/health#update', 303)
  }

  if (appDeps) {
    /**
     * Restart to update. The swap itself is the main process's (spec §5.2): this only checks that what
     * the status file names is the staged app this process made, and asks for it. The path is compared
     * with the one `stagingDir` gives for this bundle and that version, so a hand-edited status file
     * cannot point the swap at any other folder on the disk; and it must still be there, and be newer
     * than the app that is running (the main process checks that once more).
     */
    app.post('/update/restart', async (_req, reply) => {
      const s = appStatus()
      const expected = s?.state === 'staged' ? join(stagingDir(appDeps.appBundle, s.version), 'Parcels.app') : undefined
      if (s?.state !== 'staged' || appDeps.appBundle === '' || s.staged !== expected || !existsSync(s.staged)) {
        return sendError(reply, 409, () => errorPage('Nothing to restart into', html`No new version is ready to install. Open <a href="/health#update">Health</a> and press Check for updates.`, errorCtx()),
          'no new version is ready to install')
      }
      if (!newerThanRunning(s.version, appDeps.version)) {
        return sendError(reply, 409, () => errorPage('Nothing to restart into', html`Parcels ${s.version} is not newer than the Parcels that is running, so it was not installed. Open <a href="/health#update">Health</a> and press Check for updates.`, errorCtx()),
          'the staged version is not newer than the one running')
      }
      if (!postToMain({ type: 'install', staged: s.staged, version: s.version })) {
        return sendError(reply, 503, () => errorPage('Could not restart', 'Parcels could not be asked to restart. Quit Parcels from its menu-bar icon and open it again; the new version is still ready.', errorCtx()),
          'parcels could not be asked to restart')
      }
      // The new app takes a few seconds to answer; until then the reload may land on an error page.
      return send(reply, errorPage('Restarting Parcels…', 'Parcels closes and opens again on the new version. This page goes back to Health in a few seconds.', { ...errorCtx(), reloadIn: RESTART_RELOAD_SECONDS, reloadTo: '/health#update' }))
    })

    /** Show in Finder: the main process opens the support folder. Nothing else is revealed, whatever is posted. */
    app.post('/app/reveal-data', async (_req, reply) => {
      postToMain({ type: 'reveal', path: appDeps.supportDir })
      return reply.redirect('/settings#adv', 303)
    })
  }

  // Shutting down must not abandon a run halfway through: the row would be left unfinished, and only
  // `reapStaleRuns` would ever close it, ten minutes later and as a failure it was not.
  app.addHook('onClose', async () => { await refreshIdle(app) })

  return app
}
