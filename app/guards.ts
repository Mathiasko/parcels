import { basename, extname, isAbsolute, join, normalize, sep } from 'node:path'

/**
 * The checks between the outside world and the app's window, notifications and Finder. They are pure
 * functions, so the rules that keep a page or a message from reaching further than the dashboard are
 * tested without Electron.
 */

/** The dashboard's origin. The server binds only to 127.0.0.1, never `localhost`, so this is exact. */
export const dashboardOrigin = (port: number): string => `http://127.0.0.1:${port}`

const parse = (url: string): URL | undefined => {
  try { return new URL(url) } catch { return undefined }
}

/**
 * True only for the dashboard itself. The parsed origin is compared, not the string's start, so
 * `http://127.0.0.1:8799@evil.example/` (a user name, then another host) does not pass.
 */
export function isDashboardUrl(url: string, port: number): boolean {
  const u = parse(url)
  return u !== undefined && u.origin === new URL(dashboardOrigin(port)).origin
}

/**
 * What may be handed to the default browser: http and https only. `shell.openExternal` would also
 * open `file:` (which can launch an app), `smb:` or a custom scheme, none of which a dashboard link
 * should ever do.
 */
export function isWebUrl(url: string): boolean {
  const u = parse(url)
  return u !== undefined && (u.protocol === 'http:' || u.protocol === 'https:')
}

/**
 * The dashboard path a notification's click opens. The server writes its links as
 * `http://127.0.0.1:<port>/parcel/12`, so a loopback http URL is reduced to its path; a bare path
 * is kept. Anything else, including a protocol-relative `//host` and a backslash that a browser would
 * read as one, becomes `/`. The window always prefixes the dashboard's own origin, so a notification
 * can choose a page but never a site.
 */
export function notificationPath(url: string | undefined): string {
  if (!url) return '/'
  if (url.startsWith('/')) return url.startsWith('//') || url.includes('\\') ? '/' : url
  const u = parse(url)
  if (u && u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password) {
    return `${u.pathname}${u.search}${u.hash}`
  }
  return '/'
}

/**
 * True when `path` is one of `roots` or inside one. Used before `shell.openPath`, which would launch
 * an app or a script as readily as it opens a folder: the server may only ask to show its own folders.
 * The path is normalised first, so `..` cannot climb out.
 */
export function isInside(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false
  const p = normalize(path)
  return roots.some(root => {
    const r = normalize(root)
    return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)
  })
}

/**
 * Where a download is saved in `dir`, without asking. Only the base name of what the server suggests
 * is used, so a name cannot climb out of the folder, and an existing file is never overwritten: the
 * next free "name (n).ext" is taken instead, as browsers do.
 */
export function downloadName(dir: string, suggested: string, exists: (path: string) => boolean): string {
  let name = basename(suggested)
  if (name === '' || name === '.' || name === '..') name = 'download'
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = join(dir, name)
  for (let n = 1; exists(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`)
  return candidate
}
