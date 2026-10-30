import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The three switches on which notifications the app sends. Quiet by default: progress notes ("on the
 * way", "out for delivery") are the noisy ones and are opt-in, while the reminder to collect a parcel
 * and the "delivered" note are the ones a person would miss, so they start on.
 */
export interface NotificationPrefs {
  /** A note when a parcel moves along its route, before it is ready for pickup. Default off. */
  progress: boolean
  /** The once-a-day reminder that a parcel is waiting at a pickup point. Default on. */
  dailyReminder: boolean
  /** A note when a parcel is delivered. Default on. */
  delivered: boolean
}

export const DEFAULT_NOTIFICATIONS: NotificationPrefs = { progress: false, dailyReminder: true, delivered: true }

export interface Config {
  dbPath: string
  port: number
  defaultPostalCode: string
  notifier: 'auto' | 'terminal-notifier' | 'osascript'
  /**
   * The pickup-point map preview: geocoding through Nominatim and map tiles from OpenStreetMap, both
   * fetched during a poll and cached on disk, both served from loopback. `false` turns off all three
   * halves at once - no geocoding, no tile fetching, no map on the page - and is the escape hatch if
   * either service ever objects to us. Default on.
   */
  mapPreview: boolean
  /** Which notifications are sent; always a full object, with the defaults filled in for absent keys. */
  notifications: NotificationPrefs
  /**
   * The Calendar.app calendar "Add to Calendar" puts pickups into, by name. Absent (or `""` in the file)
   * means the first writable calendar; the success notice always names the calendar it used, so a wrong
   * default is seen and can be changed on /settings.
   */
  pickupCalendar?: string
  imap?: { host: string; port: number; user: string; pass: string; mailbox: string }
}

/**
 * The config file as it is on disk: every key, including ones this version of the app knows nothing
 * about. The settings page edits a document rather than a `Config`, because narrowing to `Config` and
 * writing that back would silently delete any key a newer (or older) version of the app put there.
 */
export type ConfigDocument = Record<string, unknown>

export const NOTIFIERS = ['auto', 'terminal-notifier', 'osascript'] as const

const isObject = (v: unknown): v is ConfigDocument => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The `notifications` block, over the defaults. A key that is not one of the three switches is an
 * error rather than ignored: a typo such as `"deliverd": false` would otherwise leave the note on
 * while the file says it is off.
 */
function notificationPrefs(raw: unknown, label: string): NotificationPrefs {
  const prefs = { ...DEFAULT_NOTIFICATIONS }
  if (raw === undefined) return prefs
  if (!isObject(raw)) throw new Error(`config ${label}: "notifications" must be an object, or absent`)
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULT_NOTIFICATIONS, key)) throw new Error(`config ${label}: "notifications.${key}" is not a setting`)
    if (typeof value !== 'boolean') throw new Error(`config ${label}: "notifications.${key}" must be true or false`)
    prefs[key as keyof NotificationPrefs] = value
  }
  return prefs
}

/** A non-empty string field of the `imap` block, named in the error so the message says which one. */
function imapString(imap: ConfigDocument, key: string, label: string): string {
  const v = imap[key]
  if (typeof v !== 'string' || v === '') throw new Error(`config ${label}: "imap.${key}" must be a non-empty string`)
  return v
}

/**
 * The validation rules, applied to an already-parsed document. `loadConfig` is this plus a file read,
 * and `writeConfigDocument` is this plus a write, which is the point: a document that passes here is a
 * document the poller, the CLI and the web server can all load, so the settings page cannot write a
 * file that stops the app from starting.
 */
export function validateConfig(raw: ConfigDocument, label = 'config.json'): Config {
  if (typeof raw.defaultPostalCode !== 'string' || raw.defaultPostalCode === '') {
    throw new Error(`config ${label}: required field "defaultPostalCode" is missing`)
  }
  const notifier = (raw.notifier ?? 'auto') as Config['notifier']
  if (!NOTIFIERS.includes(notifier)) {
    throw new Error(`config ${label}: "notifier" must be one of ${NOTIFIERS.join(', ')}`)
  }
  if (raw.mapPreview !== undefined && typeof raw.mapPreview !== 'boolean') {
    throw new Error(`config ${label}: "mapPreview" must be true or false`)
  }
  const notifications = notificationPrefs(raw.notifications, label)
  if (raw.pickupCalendar !== undefined && typeof raw.pickupCalendar !== 'string') {
    throw new Error(`config ${label}: "pickupCalendar" must be a calendar's name, or "" for the first writable calendar`)
  }
  if (raw.dbPath !== undefined && (typeof raw.dbPath !== 'string' || raw.dbPath === '')) {
    throw new Error(`config ${label}: "dbPath" must be a non-empty string`)
  }
  if (raw.port !== undefined && (!Number.isInteger(raw.port) || (raw.port as number) < 0 || (raw.port as number) > 65535)) {
    throw new Error(`config ${label}: "port" must be a whole number from 0 to 65535`)
  }

  // The imap block is validated here rather than at connect time: a half-written one would otherwise
  // leave the poller failing every hour against a mailbox it can never open.
  let imap: Config['imap']
  if (raw.imap !== undefined) {
    if (!isObject(raw.imap)) throw new Error(`config ${label}: "imap" must be an object, or absent`)
    const port = raw.imap.port
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
      throw new Error(`config ${label}: "imap.port" must be a whole number from 1 to 65535`)
    }
    imap = {
      host: imapString(raw.imap, 'host', label),
      port: port as number,
      user: imapString(raw.imap, 'user', label),
      pass: imapString(raw.imap, 'pass', label),
      mailbox: imapString(raw.imap, 'mailbox', label),
    }
  }

  return {
    dbPath: (raw.dbPath as string | undefined) ?? 'data/parcels.db',
    port: (raw.port as number | undefined) ?? 8787,
    defaultPostalCode: raw.defaultPostalCode,
    notifier,
    mapPreview: (raw.mapPreview as boolean | undefined) ?? true,
    notifications,
    ...(typeof raw.pickupCalendar === 'string' && raw.pickupCalendar.trim() !== '' && { pickupCalendar: raw.pickupCalendar.trim() }),
    imap,
  }
}

export function loadConfig(path = 'config.json'): Config {
  return validateConfig(readConfigDocument(path), path)
}

/** The file as it is, unnarrowed: what a writer must start from if it is not to drop unknown keys. */
export function readConfigDocument(path: string): ConfigDocument {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isObject(raw)) throw new Error(`config ${path}: the file must contain a JSON object`)
  return raw
}

/**
 * The only writer of the config file, and the first one this app has had.
 *
 * Three properties, each the answer to a way this could go wrong:
 *
 * 1. **Validated first.** An unloadable `config.json` stops the poller AND the web server from
 *    starting at all, so the document is put through `validateConfig` - the same rules `loadConfig`
 *    applies - and nothing is written if it fails. A caller that wants to show the user a message
 *    should validate before calling; this is the backstop that makes the file safe regardless.
 * 2. **Atomic.** A temp file in the same directory, fsynced, then renamed over the target. A crash or
 *    a full disk leaves either the old file or the new one, never a truncated one.
 * 3. **Mode 600.** The file holds the App Password; `rename` keeps the temp file's mode, and the
 *    chmod afterwards also repairs a file that was left readable by hand.
 *
 * Returns the validated config, so a caller can keep its in-process copy in step without re-reading.
 */
export function writeConfigDocument(path: string, doc: ConfigDocument): Config {
  const config = validateConfig(doc, path)
  const json = `${JSON.stringify(doc, null, 2)}\n`
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, json)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  chmodSync(path, 0o600)
  return config
}

/** `<repo root>/config.json`; this file sits two levels below the root in both `src/` and `dist/`. */
const REPO_CONFIG = fileURLToPath(new URL('../../config.json', import.meta.url))

/**
 * Which file the long-running entry points read: the explicit argument, else `$PARCELS_CONFIG`, else
 * `config.json` in the repo root. Exported because the web server needs the *path* and not only the
 * loaded values: the settings page writes it back.
 */
export const runtimeConfigPath = (explicitPath?: string): string =>
  resolve(explicitPath ?? process.env.PARCELS_CONFIG ?? REPO_CONFIG)

/**
 * Config for the long-running entry points (poller, CLI, web), which launchd starts with an
 * arbitrary working directory. A relative `dbPath` is resolved against the config file's own
 * directory, so nothing depends on the cwd.
 */
export function loadRuntimeConfig(explicitPath?: string): Config {
  const path = runtimeConfigPath(explicitPath)
  const config = loadConfig(path)
  return config.dbPath === ':memory:' ? config : { ...config, dbPath: resolve(dirname(path), config.dbPath) }
}
