import { existsSync } from 'node:fs'
import { app, BrowserWindow, Notification, shell, type Session } from 'electron'
import { downloadName, isDashboardUrl, isWebUrl } from './guards.js'

let win: BrowserWindow | undefined
/** Sessions already given a download handler; the window is recreated on every open, the session is not. */
const handled = new WeakSet<Session>()
/** Live "Saved" notifications. Electron drops a notification's click handler once the object is collected. */
const savedNotes = new Set<Notification>()

/** Chromium's net::ERR_CONNECTION_REFUSED: nothing listens on the port yet. */
const CONNECTION_REFUSED = -102

/** Loads a page; a failed load is reported through `did-fail-load`, so the promise's rejection is not news. */
const load = (w: BrowserWindow, url: string) => { w.loadURL(url).catch(() => {}) }

/** The port of a dashboard origin like `http://127.0.0.1:8799`, so navigation can be checked against it. */
const portOf = (origin: string): number => Number(new URL(origin).port)

/**
 * A link that leaves the dashboard: denied in the window, and handed to the default browser only if
 * it is http or https. Anything else (file:, javascript:, a custom scheme) is dropped, since
 * `shell.openExternal` would happily launch an app for it.
 */
function sendOut(url: string): void {
  if (isWebUrl(url)) void shell.openExternal(url)
}

/**
 * Downloads (the Gmail filter, the support bundle) go straight to ~/Downloads without a dialog, as the
 * spec asks, and a notification says where. Clicking it shows the file in Finder.
 */
function handleDownloads(session: Session): void {
  if (handled.has(session)) return
  handled.add(session)
  session.on('will-download', (_event, item) => {
    const path = downloadName(app.getPath('downloads'), item.getFilename(), existsSync)
    item.setSavePath(path)
    item.once('done', (_e, state) => {
      if (state !== 'completed') return
      const note = new Notification({ title: 'Parcels', body: `Saved ${path.split('/').pop() ?? ''}` })
      savedNotes.add(note)
      note.on('click', () => shell.showItemInFolder(path))
      note.on('close', () => savedNotes.delete(note))
      note.show()
    })
  })
  // The dashboard asks for no camera, location or notification permission; nothing is granted.
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
}

/**
 * Opens the one dashboard window at `origin` + `path`, or brings it forward if it is already open.
 * With a `path`, an open window goes there too (a notification's click); without one, it stays where
 * it is (the menu's Open Parcels). Closing the window destroys it, freeing the renderer, and hides the
 * Dock icon; opening it shows the icon again.
 */
export function openWindow(origin: string, path?: string): BrowserWindow {
  const target = origin + (path ?? '/')
  void app.dock?.show()
  if (win && !win.isDestroyed()) {
    if (path !== undefined) load(win, target)
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    app.focus({ steal: true })
    return win
  }
  const port = portOf(origin)
  const w = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 480,
    minHeight: 400,
    title: 'Parcels',
    // The dashboard is plain server-rendered HTML with no scripts of its own. The renderer gets no
    // Node, its own isolated world and the OS sandbox; there is no preload, so the page has no bridge
    // to the main process at all.
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  win = w
  handleDownloads(w.webContents.session)
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (isDashboardUrl(url, port)) return
    event.preventDefault()
    sendOut(url)
  }
  w.webContents.on('will-navigate', (event) => guard(event, event.url))
  w.webContents.on('will-redirect', (event) => guard(event, event.url))
  // A target=_blank link to the dashboard stays in this window; any other new window is refused.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (isDashboardUrl(url, port)) load(w, url)
    else sendOut(url)
    return { action: 'deny' }
  })
  // The server may still be starting, or restarting after a crash, when the window opens. A refused
  // connection is retried every second for half a minute instead of leaving an error page up.
  let retries = 0
  w.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code !== CONNECTION_REFUSED || retries >= 30) return
    retries++
    setTimeout(() => { if (!w.isDestroyed()) load(w, url) }, 1000)
  })
  w.webContents.on('did-finish-load', () => { retries = 0 })
  app.focus({ steal: true })
  w.on('closed', () => {
    if (win === w) win = undefined
    app.dock?.hide()
  })
  load(w, target)
  return w
}

/** The open window, if any; a second launch and the notification click use it. */
export const currentWindow = (): BrowserWindow | undefined => (win && !win.isDestroyed() ? win : undefined)
