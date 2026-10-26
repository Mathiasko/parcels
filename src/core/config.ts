import { readFileSync } from 'node:fs'

export interface Config {
  dbPath: string
  port: number
  defaultPostalCode: string
  notifier: 'auto' | 'terminal-notifier' | 'osascript'
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

  return {
    dbPath: raw.dbPath ?? 'data/parcels.db',
    port: raw.port ?? 8787,
    defaultPostalCode: raw.defaultPostalCode,
    notifier,
    imap: raw.imap,
  }
}
