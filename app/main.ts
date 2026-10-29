import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, Notification, powerMonitor, protocol, shell, utilityProcess } from 'electron'
import type { ToMain } from '../src/core/app-ipc.js'
import { appUpdateStatusPath, readAppUpdateStatus, RELEASES_URL_ENV, runCommand, writeAppUpdateStatus } from '../src/core/app-update.js'
import { devReleasesUrl, hasDevReleasesFlag } from './dev-releases.js'
import { decideFirstRun, type FirstRun } from './first-run.js'
import { dashboardOrigin, isInside, notificationPath } from './guards.js'
import { offerMoveToApplications, MOVE_DETAIL, MOVE_QUESTION } from './location.js'
import { appendRotating } from './logs.js'
import { finishInterruptedMoveIn, moveIn, type MoveInDeps, type MoveInResult } from './move-in.js'
import { appPaths, bundlePath } from './paths.js'
import { readPages, registerFirstRun, SCHEME } from './protocol.js'
import { Supervisor, type Child } from './supervise.js'
import { failedSwapToReveal, swapScript, sweepOldCopies, verifyStaged } from './swap.js'
import { createTray, type ParcelsTray } from './tray.js'
import { allowFirstRunPages, currentWindow, openWindow } from './window.js'

// Before anything reads it: the menu, the notifications and app.getPath('userData') say "Parcels"
// in a dev run too, not "Electron".
app.setName('Parcels')

const DEFAULT_PORT = 8787

// The first-run pages are served on parcels:// (spec §4). Only a scheme registered as standard and
// secure before the app is ready gets real URLs (a host and a path) and may receive a form's POST.
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }])

const paths = appPaths(homedir())

/**
 * A smoke run (scripts/app/smoke.sh): the built app starts its server and quits on SIGTERM, with no
 * window or Dock icon (only the menu-bar icon, for those few seconds) and nothing changed on the Mac.
 * It skips the login item, the offer to move to Applications and the window, and refuses to show a
 * first-run page: the smoke script writes the config, on a free port, into a temporary HOME. It is
 * read from the environment only, never from the command line, so it holds in a packaged build too,
 * which is the build the smoke test is for. It never holds under the user's real home folder, so a
 * stray PARCELS_SMOKE cannot change how Parcels starts on a real Mac.
 */
const smoke = process.env.PARCELS_SMOKE === '1' && homedir() !== userInfo().homedir

// Chromium's own state (cookies, caches, the GPU cache) gets a folder of its own inside the support
// folder, instead of being spread among config.json and data/. It is also placed from HOME: Electron's
// default comes from macOS, which ignores HOME, so a run with a temporary home would otherwise write
// into the real ~/Library.
app.setPath('userData', join(paths.support, 'Chromium'))
app.setPath('crashDumps', join(paths.support, 'Chromium', 'Crashpad'))
const mainLogPath = join(paths.logs, 'main.log')
const updatesDir = join(paths.support, 'updates')
const swapScriptPath = join(updatesDir, 'swap.sh')
const swapFailedPath = join(updatesDir, 'swap-failed')
const serverLogPath = join(paths.logs, 'server.log')

/** One line in main.log. Never throws: a full disk must not turn a logged problem into a crash. */
function log(line: string): void {
  try { appendRotating(mainLogPath, `${new Date().toISOString()} ${line}\n`) } catch { /* Nowhere left to say it. */ }
}

const describe = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err))

/** Set once startup has finished, so a later failure is not reported as one at startup. */
let startedUp = false
let failed = false
/** Set while an install is being checked and started, so a second Restart to update is not a second swap. */
let installing = false

/**
 * A failure the app cannot carry on from: logged, said in a dialog, and the app exits. Carrying on
 * after an uncaught exception would leave a menu-bar icon over a main process in an unknown state,
 * which is worse than a clear stop the user can recover from by opening Parcels again.
 */
function fatal(err: unknown): void {
  if (failed) return
  failed = true
  const reason = err instanceof Error ? err.message : String(err)
  try {
    dialog.showErrorBox(
      startedUp ? 'Parcels stopped' : 'Parcels could not start',
      `Something went wrong, so Parcels has to close. Open it again; if this keeps happening, the details are in ${mainLogPath}.\n\n${reason}`,
    )
  } catch { /* No dialog either: the log has it. */ }
  app.exit(1)
}

process.on('uncaughtException', err => { log(`uncaught: ${describe(err)}`); fatal(err) })
process.on('unhandledRejection', err => log(`unhandled rejection: ${describe(err)}`))

/**
 * The port the config asks for, read without validating the rest (the server does that). It is the
 * window's address until the server says where it listens, and the port the "in use" dialog names.
 */
function configPort(): number {
  try {
    const port = (JSON.parse(readFileSync(paths.config, 'utf8')) as { port?: unknown }).port
    return Number.isInteger(port) && (port as number) > 0 && (port as number) <= 65535 ? port as number : DEFAULT_PORT
  } catch {
    return DEFAULT_PORT
  }
}

/**
 * The environment the server process runs with: this process's own (HOME, PATH, TZ, LANG, which the
 * poll and the calendar need), plus what tells the server it runs inside the app and where its files
 * are (spec §2.1, ruling R3).
 */
function serverEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // Inherited from a terminal or an Electron-based tool, this would make a child Electron binary run
  // as plain Node. The server does not need it and nothing it starts should see it.
  delete env.ELECTRON_RUN_AS_NODE
  // A test feed is passed on only when this run may follow one (ruling R16, app/dev-releases.ts);
  // otherwise the server must not see an inherited one at all.
  delete env[RELEASES_URL_ENV]
  const feed = releasesFeed()
  return {
    ...env,
    ...(feed !== undefined && { [RELEASES_URL_ENV]: feed }),
    PARCELS_HOST: 'app',
    PARCELS_CONFIG: paths.config,
    PARCELS_APP_VERSION: app.getVersion(),
    // In a dev run this is node_modules' Electron.app. Harmless: updates are only offered when packaged.
    PARCELS_APP_BUNDLE: bundlePath(process.execPath),
    PARCELS_LOG_DIR: paths.logs,
    // Unpackaged, process.resourcesPath is Electron's own folder, which has no gmail-filter.xml; the
    // repository root has it (ruling R3).
    PARCELS_RESOURCES: app.isPackaged ? process.resourcesPath : app.getAppPath(),
  }
}

/**
 * The release feed to follow instead of GitHub's, if this run may follow one: an unpackaged dev run,
 * or a test build whose package.json carries `parcelsDevReleases` (ruling R16). Logged when used, so
 * a test build that updates from somewhere else says so in main.log.
 */
function releasesFeed(): string | undefined {
  let pkg: string | undefined
  try { pkg = readFileSync(join(app.getAppPath(), 'package.json'), 'utf8') } catch { /* No flag, then. */ }
  const url = devReleasesUrl({ packaged: app.isPackaged, flagged: hasDevReleasesFlag(pkg), url: process.env[RELEASES_URL_ENV] })
  if (url !== undefined) log(`following the test release feed at ${url}`)
  else if (process.env[RELEASES_URL_ENV]) log(`ignored ${RELEASES_URL_ENV}: this build follows GitHub's releases only`)
  return url
}

/** Starts one server process, with its output appended to server.log, as a `Child` for the supervisor. */
function forkServer(env: Record<string, string>): Child {
  const child = utilityProcess.fork(join(app.getAppPath(), 'dist', 'app-server.js'), [], {
    env,
    stdio: 'pipe',
    serviceName: 'Parcels Server',
  })
  const toLog = (chunk: Buffer | string) => {
    try { appendRotating(serverLogPath, chunk.toString()) } catch (err) { log(`server.log: ${describe(err)}`) }
  }
  child.stdout?.on('data', toLog)
  child.stderr?.on('data', toLog)
  return {
    on(event: 'exit' | 'message', f: ((code: number) => void) | ((m: unknown) => void)) {
      if (event === 'exit') child.on('exit', f as (code: number) => void)
      else child.on('message', f as (m: unknown) => void)
    },
    postMessage: m => child.postMessage(m),
    kill: () => { child.kill() },
  }
}

/**
 * What a second launch does: bring the window forward. Until startup has got far enough to know which
 * window that is, the wish is remembered and granted then.
 */
let reveal: (() => void) | undefined
let revealWanted = false
function setReveal(f: () => void): void {
  reveal = f
  if (revealWanted) { revealWanted = false; f() }
}

if (!app.requestSingleInstanceLock()) {
  // Another Parcels is running; it gets 'second-instance' and shows its window.
  app.quit()
} else {
  // Registered at once: a second launch during startup must not be lost.
  app.on('second-instance', () => { if (reveal) reveal(); else revealWanted = true })
  run().catch(err => { log(`startup failed: ${describe(err)}`); fatal(err) })
}

/**
 * The launchctl the move in runs. A packaged app always runs /bin/launchctl, by absolute path and
 * without a shell. An unpackaged dev run may name another program in PARCELS_DEV_LAUNCHCTL: the hand
 * rehearsal points it at a stub that only records its arguments, so a rehearsal never stops or starts
 * a real launchd job. A packaged app ignores the variable.
 */
function launchctl(): MoveInDeps['launchctl'] {
  const dev = process.env.PARCELS_DEV_LAUNCHCTL
  const bin = !app.isPackaged && dev ? dev : '/bin/launchctl'
  return args => {
    log(`launchctl ${args.join(' ')}${bin === '/bin/launchctl' ? '' : ` (dev: ${bin})`}`)
    try {
      execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000 })
      return { code: 0, stderr: '' }
    } catch (err) {
      const e = err as { status?: number | null; stderr?: string; message?: string }
      const r = { code: typeof e.status === 'number' ? e.status : 1, stderr: e.stderr || e.message || '' }
      log(`launchctl exit ${r.code}: ${r.stderr.trim()}`)
      return r
    }
  }
}

/**
 * Dev-only stand-ins for a click, for the hand rehearsal, which cannot click in the window: with
 * PARCELS_DEV_AUTO_MOVE_IN=1 the Move in button is pressed once the page has loaded, and with
 * PARCELS_DEV_AUTO_POSTCODE=<text> the postcode is typed and Continue pressed. They press the page's
 * real button, so the form, the POST and the handler are the ones a user's click goes through. A
 * packaged app ignores both.
 */
function devAutoSubmit(w: BrowserWindow, first: FirstRun): void {
  if (app.isPackaged) return
  const postcode = process.env.PARCELS_DEV_AUTO_POSTCODE
  const script = first.kind === 'move-in' && process.env.PARCELS_DEV_AUTO_MOVE_IN === '1'
    ? "document.querySelector('button[value=move]').click()"
    : first.kind === 'welcome' && postcode !== undefined
      // noValidate: the field's own pattern would stop a bad postcode in the page, and the rehearsal is
      // of the check behind it, which is what any postcode that gets past the page meets.
      ? `const f = document.querySelector('form'); f.noValidate = true; f.postcode.value = ${JSON.stringify(postcode)}; f.requestSubmit()`
      : undefined
  if (script === undefined) return
  w.webContents.once('did-finish-load', () => {
    log(`dev: pressing the ${first.kind} button`)
    w.webContents.executeJavaScript(script).catch(err => log(`dev: could not press it: ${describe(err)}`))
  })
}

/**
 * Dev-only: with PARCELS_DEV_CAPTURE_DIR set, every page the window finishes loading is saved there as
 * a PNG, numbered in order. The rehearsal uses it to see the real window without Screen Recording
 * permission. A packaged app ignores it.
 */
function devCapture(w: BrowserWindow): void {
  const dir = process.env.PARCELS_DEV_CAPTURE_DIR
  if (app.isPackaged || !dir) return
  let n = 0
  w.webContents.on('did-finish-load', () => {
    const name = `${++n}-${new URL(w.webContents.getURL()).host.replace(/[^\w.-]/g, '_')}.png`
    // A moment for the first paint after the load event.
    setTimeout(() => {
      if (w.isDestroyed()) return
      w.webContents.capturePage().then(
        img => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), img.toPNG()); log(`dev: captured ${name}`) },
        err => log(`dev: capture failed: ${describe(err)}`),
      )
    }, 500)
  })
}

async function run(): Promise<void> {
  // Without a listener Electron quits when the last window closes. Parcels lives in the menu bar.
  app.on('window-all-closed', () => {})

  await app.whenReady()
  log(`starting ${app.getVersion()}${app.isPackaged ? '' : ' (dev run)'}${smoke ? ' (smoke run)' : ''}`)
  // Logout, restart and shutdown take the same path as Quit, so the server is stopped cleanly. The
  // event's preventDefault asks macOS to wait while that happens; Electron's typings leave the event
  // out of the listener, so it is taken from the arguments.
  powerMonitor.on('shutdown', (...args: unknown[]) => {
    (args[0] as { preventDefault?: () => void } | undefined)?.preventDefault?.()
    app.quit()
  })

  const first = decideFirstRun(paths)
  log(`first run: ${first.kind}${first.kind === 'move-in' ? ` from ${first.clone}` : ''}`)
  if (smoke && first.kind !== 'ready') {
    // A first-run page would wait for a click that never comes, and a move in would act on whatever
    // install the temporary HOME points at. Either way the smoke run is set up wrong; say so and stop.
    log(`smoke run: no config at ${paths.config}, so there is nothing to start`)
    app.exit(2)
    return
  }

  // Asked once the route is known but before anything acts on it: no server, no window, no move in
  // has started, so a move that quits and relaunches the app cuts nothing off, and the relaunched app
  // decides its route again from where it now lives. A "no" lasts for this launch only.
  const moved = smoke ? 'not-offered' : await offerMoveToApplications({
    packaged: app.isPackaged,
    bundle: bundlePath(process.execPath),
    home: homedir(),
    ask: async () => (await dialog.showMessageBox({
      type: 'question',
      message: MOVE_QUESTION,
      detail: MOVE_DETAIL,
      buttons: ['Move to Applications', 'Not Now'],
      defaultId: 0,
      cancelId: 1,
    })).response === 0,
    move: () => app.moveToApplicationsFolder(),
    log,
  })
  // Electron is already quitting to relaunch the moved copy.
  if (moved === 'moved') return

  // Opened at login: Parcels starts in the menu bar only, with no Dock icon and no window. A Mac that
  // is not set up yet shows its first-run page either way.
  const atLogin = first.kind === 'ready' && app.getLoginItemSettings().wasOpenedAtLogin
  // A smoke run starts the same way, so that no window or Dock icon appears.
  if (atLogin || smoke) app.dock?.hide()

  let port = configPort()
  let shownAtStart = atLogin || smoke
  /** The page the dashboard opens on when the server first answers: `/settings` after Welcome. */
  let firstPath: string | undefined
  const origin = () => dashboardOrigin(port)
  const open = (path?: string) => { openWindow(origin(), path) }

  /** On screen notifications by groupKey, so a newer one replaces its predecessor (and is not collected). */
  const notes = new Map<string, Notification>()

  let tray: ParcelsTray | undefined
  const supervisor = new Supervisor({
    fork: forkServer,
    env: serverEnv(),
    onState: s => {
      log(`server ${s}`)
      tray?.setState(s)
    },
    onInvalid: m => log(`ignored a message from the server: ${safeJson(m)}`),
    onMessage: (m: ToMain) => {
      switch (m.type) {
        case 'notify': {
          notes.get(m.groupKey)?.close()
          const note = new Notification({ title: m.title, body: m.message })
          notes.set(m.groupKey, note)
          note.on('click', () => open(notificationPath(m.url)))
          note.on('close', () => { if (notes.get(m.groupKey) === note) notes.delete(m.groupKey) })
          note.show()
          break
        }
        case 'ready-count':
          tray?.setCount(m.n)
          break
        case 'listening':
          port = m.port
          // A normal launch opens the dashboard once it can answer; a launch at login does not. After
          // a first run this replaces the first-run page in the same window.
          if (!shownAtStart) { shownAtStart = true; open(firstPath) }
          allowFirstRunPages(false)
          break
        case 'reveal':
          // openPath launches apps and scripts as readily as it opens folders, so only the app's own
          // folders may be shown this way.
          if (isInside(m.path, [paths.support, paths.logs])) void shell.openPath(m.path)
          else log(`refused to reveal ${m.path}: not a Parcels folder`)
          break
        case 'install':
          log(`install requested: ${m.version} from ${m.staged}`)
          void installAndRelaunch(m.staged, m.version)
          break
      }
    },
  })

  let quitting = false
  /** A move in under way: quitting waits for it, so it is never cut off between its steps. */
  let moving: Promise<MoveInResult> | undefined

  /** Starts the server and the menu-bar icon, once: at launch when set up, else when a first run ends. */
  let serving = false
  const startServer = (path?: string) => {
    if (serving || quitting) return
    serving = true
    port = configPort()
    firstPath = path
    setLoginItemOnce()
    tray = createTray({
      open,
      refresh: () => supervisor.send({ type: 'refresh' }),
      quit: () => app.quit(),
      port: configPort,
      loginItemEditable: app.isPackaged,
    })
    supervisor.start()
  }

  /** Shows the first-run page, in a window of its own that quits the app when closed before setup ends. */
  const openFirstRun = (f: Exclude<FirstRun, { kind: 'ready' }>) => {
    if (currentWindow()) { openWindow(`${SCHEME}://${f.kind}`); return }
    const w = openWindow(`${SCHEME}://${f.kind}`)
    // Not set up, there is nothing to do in the menu bar: closing the window is "not now".
    w.once('closed', () => { if (!serving) app.quit() })
    devAutoSubmit(w, f)
    devCapture(w)
  }

  if (first.kind !== 'ready') {
    allowFirstRunPages(true)
    registerFirstRun(protocol, {
      firstRun: first,
      configPath: paths.config,
      pages: readPages(join(app.getAppPath(), 'app', 'pages')),
      start: startServer,
      moveIn: () => {
        moving = moveIn({
          clone: first.kind === 'move-in' ? first.clone : '',
          plists: first.kind === 'move-in' ? first.plists : [],
          support: paths.support,
          uid: process.getuid?.() ?? 0,
          launchctl: launchctl(),
        }).finally(() => { moving = undefined })
        return moving
      },
      quit: () => app.quit(),
      log,
    })
  }

  const show = () => {
    if (serving) open()
    else if (first.kind !== 'ready') openFirstRun(first)
  }
  setReveal(show)
  // Clicking the Dock icon while the window is closed brings it back.
  app.on('activate', () => { if (!currentWindow()) show() })
  // The server re-plans its next poll; a slot that passed during sleep is caught up.
  powerMonitor.on('resume', () => supervisor.send({ type: 'wake' }))

  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    log('quitting')
    Promise.resolve(moving).catch(() => {}).then(() => supervisor.stop()).then(
      () => app.quit(),
      err => { log(`stop failed: ${describe(err)}`); app.exit(0) },
    )
  })
  // `kill` and logout send SIGTERM; it takes the same path as Quit so the server is shut down too.
  process.on('SIGTERM', () => app.quit())
  process.on('SIGINT', () => app.quit())

  if (first.kind === 'ready') {
    // A move cut off between writing config.json and parking the old plists is finished first, so the
    // old jobs let go of the port and do not come back at the next login.
    const finish = await finishInterruptedMoveIn({
      support: paths.support, launchAgents: paths.launchAgents, uid: process.getuid?.() ?? 0, launchctl: launchctl(),
    })
    if (finish.kind === 'finished') log(`finished an interrupted move in from ${finish.clone}`)
    startServer()
    if (finish.kind === 'failed') {
      // The app has the parcels now, so it starts regardless; the old install is what needs a hand.
      log(`could not finish an interrupted move in: ${finish.reason}`)
      void dialog.showMessageBox({
        type: 'warning',
        message: 'Parcels could not put the old install aside.',
        detail: `${finish.reason} Parcels has your parcels and runs as usual. So that the old install does not also start when you log in, move local.parcels.web.plist and local.parcels.poller.plist out of ~/Library/LaunchAgents.`,
        buttons: ['OK'],
      })
    }
  } else {
    openFirstRun(first)
  }
  revealFailedSwap()
  // A dev run's bundle is node_modules' Electron.app, whose neighbours are none of Parcels's business.
  if (app.isPackaged) sweepOldCopies(bundlePath(process.execPath), log)
  startedUp = true
}

/**
 * The SHA-256 of the certificate this bundle was signed with. Packaged, it sits in Resources; a dev
 * run reads the committed file in the repository. Empty when missing, which `verifyStaged` refuses.
 */
function shippedCertSha(): string {
  const file = app.isPackaged
    ? join(process.resourcesPath, 'signing-cert.sha256')
    : join(app.getAppPath(), 'app', 'signing-cert.sha256')
  try { return readFileSync(file, 'utf8').trim() } catch { return '' }
}

/**
 * The environment the swap script runs with: this one, without ELECTRON_RUN_AS_NODE (the script also
 * removes it for `open`), and with PATH set to the system's folders, so `mv`, `rm`, `ps` and `open`
 * are the system's own whatever PATH the app was started with.
 */
function swapEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
  return env
}

/**
 * Records in the updater's status file that the staged version was refused, so the Health page says
 * why and offers Update now again, instead of a Restart to update that can only be refused again.
 */
function markInstallRefused(version: string, reason: string): void {
  const path = appUpdateStatusPath(paths.support)
  try {
    const s = readAppUpdateStatus(path)
    const startedAt = s?.state === 'staged' && s.version === version ? s.startedAt : new Date()
    writeAppUpdateStatus(path, { state: 'failed', version, reason, startedAt, finishedAt: new Date() })
  } catch (err) {
    log(`could not record the refused install: ${describe(err)}`)
  }
}

/**
 * Restart to update (spec §5.2). The staged app is checked once more (`verifyStaged`); only then is
 * the swap script written and started, detached so it outlives this process, and the app quits
 * through the usual before-quit path, which stops the server cleanly. The script takes over from
 * there. Any refusal leaves the app running as it is, with a dialog that says why.
 */
async function installAndRelaunch(staged: string, version: string): Promise<void> {
  if (installing) return
  // A dev run's bundle is node_modules' Electron.app, which an update must never replace.
  if (!app.isPackaged) {
    log('install refused: this is a dev run')
    return
  }
  installing = true
  const refuse = (reason: string, detail?: string) => {
    installing = false
    log(`install of ${version} refused: ${reason}${detail ? ` (${detail})` : ''}`)
    markInstallRefused(version, reason)
    void dialog.showMessageBox({
      type: 'warning',
      message: 'Parcels could not install the update.',
      detail: `${reason} Parcels keeps running as it is. To try again, open Health and press Update now.`,
      buttons: ['OK'],
    })
  }
  try {
    const appBundle = bundlePath(process.execPath)
    const refused = await verifyStaged({
      appBundle, staged, version, expectedCertSha: shippedCertSha(), run: runCommand, workDir: updatesDir,
    })
    if (refused) { refuse(refused.reason, refused.detail); return }
    const script = swapScript({ pid: process.pid, app: appBundle, staged, version, marker: swapFailedPath })
    mkdirSync(updatesDir, { recursive: true, mode: 0o700 })
    // Removed first and created exclusively, so a link left in its place is not written through.
    rmSync(swapScriptPath, { force: true })
    writeFileSync(swapScriptPath, script, { mode: 0o700, flag: 'wx' })
    spawn('/bin/sh', [swapScriptPath], { detached: true, stdio: 'ignore', env: swapEnv() }).unref()
    log(`installing ${version}: the swap script is waiting for this process to quit`)
    app.quit()
  } catch (err) {
    refuse('Parcels could not start the update, so nothing was changed.', describe(err))
  }
}

/**
 * After a swap that could not move the new version into place, the script reopened this (old) app
 * and left a marker. The staged copy is shown in Finder so the user can finish by dragging it in. The
 * marker goes either way, so the message is shown once; and only Parcels's own staged copy for that
 * version is ever shown (`failedSwapToReveal`), never whatever path a marker names.
 */
function revealFailedSwap(): void {
  const failedSwap = failedSwapToReveal(swapFailedPath, bundlePath(process.execPath), log)
  if (!failedSwap) return
  log(`the swap to ${failedSwap.version} failed; showing ${failedSwap.staged}`)
  shell.showItemInFolder(failedSwap.staged)
  void dialog.showMessageBox({
    type: 'info',
    message: `Drag this Parcels into Applications to finish updating to ${failedSwap.version}.`,
    buttons: ['OK'],
  })
}

/**
 * Turns on "open at login" once, on the first launch, and leaves a marker so that a user who turns it
 * off is not overruled at the next launch. A dev run never touches it: the running binary is
 * node_modules' Electron.app, which must not become a login item on this Mac.
 */
function setLoginItemOnce(): void {
  if (!app.isPackaged || smoke) {
    log(`login item left alone: this is a ${smoke ? 'smoke' : 'dev'} run`)
    return
  }
  const marker = join(paths.support, '.login-item-set')
  if (existsSync(marker)) return
  app.setLoginItemSettings({ openAtLogin: true })
  try {
    mkdirSync(paths.support, { recursive: true, mode: 0o700 })
    writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 })
  } catch (err) {
    log(`could not write ${marker}: ${describe(err)}`)
  }
}

/** A message for main.log, cut short: a misbehaving server must not fill the log with one line. */
function safeJson(v: unknown): string {
  let s: string
  try { s = JSON.stringify(v) ?? String(v) } catch { s = String(v) }
  return s.length > 300 ? `${s.slice(0, 300)}…` : s
}
