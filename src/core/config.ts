import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  imap?: { host: string; port: number; user: string; pass: string; mailbox: string }
}

const NOTIFIERS = ['auto', 'terminal-notifier', 'osascript'] as const

export function loadConfig(path = 'config.json'): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>

  if (typeof raw.defaultPostalCode !== 'string' || raw.defaultPostalCode === '') {
    throw new Error(`config ${path}: required field "defaultPostalCode" is missing`)
  }
  const notifier = raw.notifier ?? 'auto'
  if (!NOTIFIERS.includes(notifier)) {
    throw new Error(`config ${path}: "notifier" must be one of ${NOTIFIERS.join(', ')}`)
  }
  if (raw.mapPreview !== undefined && typeof raw.mapPreview !== 'boolean') {
    throw new Error(`config ${path}: "mapPreview" must be true or false`)
  }

  return {
    dbPath: raw.dbPath ?? 'data/parcels.db',
    port: raw.port ?? 8787,
    defaultPostalCode: raw.defaultPostalCode,
    notifier,
    mapPreview: raw.mapPreview ?? true,
    imap: raw.imap,
  }
}

/** `<repo root>/config.json`; this file sits two levels below the root in both `src/` and `dist/`. */
const REPO_CONFIG = fileURLToPath(new URL('../../config.json', import.meta.url))

/**
 * Config for the long-running entry points (poller, CLI, web), which launchd starts with an
 * arbitrary working directory. The path is the explicit argument, else `$PARCELS_CONFIG`, else
 * `config.json` in the repo root; a relative `dbPath` is resolved against the config file's own
 * directory, so nothing depends on the cwd.
 */
export function loadRuntimeConfig(explicitPath?: string): Config {
  const path = resolve(explicitPath ?? process.env.PARCELS_CONFIG ?? REPO_CONFIG)
  const config = loadConfig(path)
  return config.dbPath === ':memory:' ? config : { ...config, dbPath: resolve(dirname(path), config.dbPath) }
}
