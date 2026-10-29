import { join } from 'node:path'
import { app, dialog, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { SupervisorState } from './supervise.js'

export interface TrayActions {
  /** Opens the dashboard window; with a path, at that page. */
  open(path?: string): void
  refresh(): void
  quit(): void
  /** The port named in the "port in use" dialog: the one the config asks for. */
  port(): number
  /**
   * Whether the Start at login checkbox may change the login item. False in a dev run, where the
   * running binary is Electron.app from node_modules, which must never become a login item.
   */
  loginItemEditable: boolean
}

export interface ParcelsTray {
  setCount(n: number): void
  setState(s: SupervisorState): void
}

/** The exact words of the "port in use" dialog (plan, Task 8), with the port the config really asks for. */
export const portBusyMessage = (port: number): string =>
  `Parcels could not start: port ${port} is in use. Another copy of Parcels - probably the one installed ` +
  'with Terminal - is still running. Quit it (or move it into the app) and open Parcels again.'

/** Held here so the tray is never garbage-collected, which would make the icon vanish from the menu bar. */
let tray: Tray | undefined

/**
 * The menu-bar icon: the parcel glyph as a template image (macOS tints it for a light or dark menu
 * bar), the number of parcels ready for pickup as its title, and the menu. While the server is down,
 * the first item says so instead of offering a dashboard that cannot load.
 */
export function createTray(actions: TrayActions): ParcelsTray {
  // `trayTemplate@2x.png` beside it is picked up for Retina screens; the "Template" suffix marks both
  // as template images, and setTemplateImage says so again in case the name is ever changed.
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'app', 'assets', 'trayTemplate.png'))
  icon.setTemplateImage(true)
  const t = new Tray(icon)
  tray = t
  t.setToolTip('Parcels')
  let state: SupervisorState = 'running'
  let busyShown = false

  const build = () => {
    const down = state === 'restarting'
    const template: MenuItemConstructorOptions[] = [
      down
        ? { label: 'Parcels stopped – restarting…', enabled: false }
        : { label: 'Open Parcels', click: () => actions.open() },
      { label: 'Refresh now', enabled: state === 'running', click: () => actions.refresh() },
      { label: 'Check for updates…', click: () => actions.open('/health#update') },
      { type: 'separator' },
      {
        id: 'login',
        label: 'Start at login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        enabled: actions.loginItemEditable,
        click: item => {
          if (actions.loginItemEditable) app.setLoginItemSettings({ openAtLogin: item.checked })
        },
      },
      { type: 'separator' },
      { label: 'Quit Parcels', click: () => actions.quit() },
    ]
    const menu = Menu.buildFromTemplate(template)
    // The login item can also be changed in System Settings, so the checkbox is read again each time
    // the menu opens rather than trusted from when it was built.
    menu.on('menu-will-show', () => {
      const item = menu.getMenuItemById('login')
      if (item) item.checked = app.getLoginItemSettings().openAtLogin
    })
    t.setContextMenu(menu)
  }
  build()

  return {
    setCount(n) {
      t.setTitle(n > 0 ? String(n) : '')
    },
    setState(s) {
      state = s
      build()
      if (s === 'port-busy' && !busyShown) {
        busyShown = true
        // The server will not be retried (another copy holds the port), so the app has nothing to
        // offer. It says what to do and then quits, which is what "open Parcels again" asks for.
        void dialog.showMessageBox({ type: 'warning', message: portBusyMessage(actions.port()), buttons: ['Quit'] })
          .then(() => actions.quit())
      }
    },
  }
}
