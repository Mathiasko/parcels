import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { DEFAULT_NOTIFICATIONS, writeConfigDocument, type ConfigDocument } from '../src/core/config.js'
import { escapeHtml } from '../src/web/views/html.js'

/**
 * What the app does at launch, before any server is started (spec §4): start normally, offer to move
 * an existing git-clone install in, or ask for the postcode on a fresh Mac.
 */
export type FirstRun = { kind: 'ready' } | { kind: 'welcome' } | { kind: 'move-in'; clone: string; plists: string[] }

/** The two launchd jobs a git-clone install runs, in the order they are stopped: the poller writes on its own, so it goes first. */
export const LABELS = ['local.parcels.poller', 'local.parcels.web'] as const

const WEB_PLIST = 'local.parcels.web.plist'

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** The text of an XML string element, entities undone; undefined if it is not well-formed. */
function unescapeXml(text: string): string | undefined {
  let ok = true
  const out = text.replace(/&([^;&]*);?/g, (whole, name: string) => {
    if (!whole.endsWith(';')) { ok = false; return '' }
    if (name in NAMED) return NAMED[name]!
    const num = /^#x([0-9a-f]+)$/i.exec(name) ?? /^#([0-9]+)$/.exec(name)
    const code = num ? parseInt(num[1]!, name[1] === 'x' || name[1] === 'X' ? 16 : 10) : NaN
    // A NUL or a value past Unicode cannot be in an XML document.
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) { ok = false; return '' }
    return String.fromCodePoint(code)
  })
  return ok ? out : undefined
}

/**
 * The WorkingDirectory of a launchd plist: the `<string>` that directly follows
 * `<key>WorkingDirectory</key>`. A small, strict reading rather than `plutil`, so it is testable and
 * runs nothing: anything it cannot be sure of (two such keys, another element in between, a bare
 * `&`, a relative path) gives undefined, and the app then offers a fresh start instead of guessing
 * which folder holds someone's parcels.
 */
export function plistWorkingDirectory(xml: string): string | undefined {
  const re = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/g
  const keys = xml.match(/<key>WorkingDirectory<\/key>/g) ?? []
  const found = [...xml.matchAll(re)]
  if (keys.length !== 1 || found.length !== 1) return undefined
  const dir = unescapeXml(found[0]![1]!)
  return dir !== undefined && isAbsolute(dir) ? dir : undefined
}

/**
 * Which first run this is. A config in the support folder means the app is set up. Otherwise a web
 * plist whose WorkingDirectory holds a config.json is a git-clone install to move in, listing
 * whichever of its two plists exist. Anything else, including a plist that cannot be read, is a fresh
 * start.
 */
export function decideFirstRun(
  p: { config: string; launchAgents: string },
  fs: Pick<typeof nodeFs, 'existsSync' | 'readFileSync'> = nodeFs,
): FirstRun {
  if (fs.existsSync(p.config)) return { kind: 'ready' }
  const web = join(p.launchAgents, WEB_PLIST)
  if (!fs.existsSync(web)) return { kind: 'welcome' }
  let clone: string | undefined
  try {
    clone = plistWorkingDirectory(String(fs.readFileSync(web, 'utf8')))
  } catch {
    return { kind: 'welcome' }
  }
  if (clone === undefined || !fs.existsSync(join(clone, 'config.json'))) return { kind: 'welcome' }
  const plists = LABELS.map(label => join(p.launchAgents, `${label}.plist`)).filter(f => fs.existsSync(f))
  return { kind: 'move-in', clone, plists }
}

/**
 * The config document `setup.sh` writes for a new install: config.example.json without its imap
 * placeholders, with the postcode filled in. It is a constant here because the app bundle does not
 * carry config.example.json; a test compares the two so they cannot drift apart.
 */
export const WELCOME_DOCUMENT: Readonly<ConfigDocument> = {
  dbPath: 'data/parcels.db',
  port: 8787,
  notifier: 'auto',
  mapPreview: true,
  notifications: { ...DEFAULT_NOTIFICATIONS },
  pickupCalendar: '',
}

/** The postcode as setup.sh and the settings page accept it: five digits once whitespace is removed. */
export function normalisePostcode(input: string): string | undefined {
  const postcode = input.replace(/\s/g, '')
  return /^\d{5}$/.test(postcode) ? postcode : undefined
}

/**
 * Writes the first config of a fresh install, at mode 0600 in an owner-only support folder. A bad
 * postcode throws without writing. An existing config is never replaced, as `setup.sh` never replaces
 * one: a second press of the button must not undo settings saved since the first.
 */
export function writeWelcomeConfig(configPath: string, postcode: string): void {
  const code = normalisePostcode(postcode)
  if (code === undefined) throw new Error(`"${postcode}" is not a postcode: five digits, like 81101`)
  if (existsSync(configPath)) throw new Error(`${configPath} already exists`)
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  // setup.sh's document puts the postcode first; keep the same key order so the two files read alike.
  const { dbPath, ...rest } = WELCOME_DOCUMENT
  writeConfigDocument(configPath, { defaultPostalCode: code, dbPath, ...rest })
}

/**
 * Fills a static page's `{{name}}` placeholders, each value HTML-escaped. `{{style}}` is the one
 * exception: it takes `style` verbatim, since CSS inside `<style>` is not HTML text and escaping
 * would break its quotes and child selectors. A placeholder without a value, or a value without a
 * placeholder, means the page and the code have drifted apart, and throws rather than showing a
 * page with a hole in it.
 */
export function fillPage(template: string, values: Record<string, string>, style = ''): string {
  if ('style' in values) throw new Error('fillPage: "style" is the stylesheet, not a value')
  // A `</` would end the <style> element early and let the rest be read as markup.
  if (style.includes('</')) throw new Error('fillPage: the stylesheet contains "</"')
  const used = new Set<string>()
  const out = template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (name === 'style') return style
    const v = values[name]
    if (v === undefined) throw new Error(`fillPage: no value for {{${name}}}`)
    used.add(name)
    return escapeHtml(v)
  })
  const unused = Object.keys(values).filter(k => !used.has(k))
  if (unused.length > 0) throw new Error(`fillPage: the page has no {{${unused.join('}}, {{')}}}`)
  return out
}
