import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, dialog, Notification, powerMonitor, shell, utilityProcess } from 'electron'
import type { ToMain } from '../src/core/app-ipc.js'
import { dashboardOrigin, isInside, notificationPath } from './guards.js'
import { appendRotating } from './logs.js'
import { appPaths, bundlePath } from './paths.js'
import { Supervisor, type Child } from './supervise.js'
import { createTray, type ParcelsTray } from './tray.js'
import { currentWindow, openWindow } from './window.js'

// Before anything reads it: the menu, the notifications and app.getPath('userData') say "Parcels"
// in a dev run too, not "Electron".
app.setName('Parcels')

const DEFAULT_PORT = 8787

const paths = appPaths(homedir())

// Chromium's own state (cookies, caches, the GPU cache) gets a folder of its own inside the support
// folder, instead of being spread among config.json and data/. It is also placed from HOME: Electron's
// default comes from macOS, which ignores HOME, so a run with a temporary home would otherwise write
// into the real ~/Library.
app.setPath('userData', join(paths.support, 'Chromium'))
app.setPath('crashDumps', join(paths.support, 'Chromium', 'Crashpad'))
const mainLogPath = join(paths.logs, 'main.log')
const serverLogPath = join(paths.logs, 'server.log')

/** One line in main.log. Never throws: a full disk must not turn a logged problem into a crash. */
function log(line: string): void {
  try { appendRotating(mainLogPath, `${new Date().toISOString()} ${line}\n`) } catch { /* Nowhere left to say it. */ }
}

const describe = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err))
process.on('uncaughtException', err => log(`uncaught: ${describe(err)}`))
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
  return {
    ...env,
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

if (!app.requestSingleInstanceLock()) {
  // Another Parcels is running; it gets 'second-instance' and shows its window.
  app.quit()
} else {
  void run()
}

async function run(): Promise<void> {
  // Without a listener Electron quits when the last window closes. Parcels lives in the menu bar.
  app.on('window-all-closed', () => {})

  await app.whenReady()
  log(`starting ${app.getVersion()}${app.isPackaged ? '' : ' (dev run)'}`)

  if (!existsSync(paths.config)) {
    // First-run routing (Welcome, Move in) comes later; until then there is nothing to start.
    await dialog.showMessageBox({ type: 'info', message: 'Parcels is not set up yet.', buttons: ['Quit'] })
    app.exit(0)
    return
  }

  // Opened at login: Parcels starts in the menu bar only, with no Dock icon and no window.
  const atLogin = app.getLoginItemSettings().wasOpenedAtLogin
  if (atLogin) app.dock?.hide()

  setLoginItemOnce()

  let port = configPort()
  let shownAtStart = atLogin
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
          // A normal launch opens the dashboard once it can answer; a launch at login does not.
          if (!shownAtStart) { shownAtStart = true; open() }
          break
        case 'reveal':
          // openPath launches apps and scripts as readily as it opens folders, so only the app's own
          // folders may be shown this way.
          if (isInside(m.path, [paths.support, paths.logs])) void shell.openPath(m.path)
          else log(`refused to reveal ${m.path}: not a Parcels folder`)
          break
        case 'install':
          // The swap and relaunch arrive with the updater's main-process half (Task 10).
          log(`install requested: ${m.version} from ${m.staged}`)
          break
      }
    },
  })

  tray = createTray({
    open,
    refresh: () => supervisor.send({ type: 'refresh' }),
    quit: () => app.quit(),
    port: configPort,
    loginItemEditable: app.isPackaged,
  })

  app.on('second-instance', () => open())
  // Clicking the Dock icon while the window is closed brings it back.
  app.on('activate', () => { if (!currentWindow()) open() })
  // The server re-plans its next poll; a slot that passed during sleep is caught up.
  powerMonitor.on('resume', () => supervisor.send({ type: 'wake' }))

  let quitting = false
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    log('quitting')
    supervisor.stop().then(
      () => app.quit(),
      err => { log(`stop failed: ${describe(err)}`); app.exit(0) },
    )
  })
  // `kill` and logout send SIGTERM; it takes the same path as Quit so the server is shut down too.
  process.on('SIGTERM', () => app.quit())
  process.on('SIGINT', () => app.quit())

  supervisor.start()
}

/**
 * Turns on "open at login" once, on the first launch, and leaves a marker so that a user who turns it
 * off is not overruled at the next launch. A dev run never touches it: the running binary is
 * node_modules' Electron.app, which must not become a login item on this Mac.
 */
function setLoginItemOnce(): void {
  if (!app.isPackaged) {
    log('login item left alone: this is a dev run')
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
