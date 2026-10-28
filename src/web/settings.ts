import { NOTIFIERS, validateConfig, type Config, type ConfigDocument } from '../core/config.js'
import type { SettingField } from '../db/activity-log.js'

/**
 * The form, as `application/x-www-form-urlencoded` delivers it. `port` and `dbPath` are deliberately
 * absent: they are bound at process start, the page shows them read-only, and a crafted POST that
 * sends them must change nothing - which it cannot, because nothing here ever reads them.
 */
export interface SettingsForm {
  defaultPostalCode?: string
  notifier?: string
  mapPreview?: string
  imapHost?: string
  imapPort?: string
  imapUser?: string
  imapMailbox?: string
  imapPass?: string
}

/**
 * Everything the page is allowed to know. There is no `pass` field and there never will be: the
 * password is write-only, so the only honest thing to render is whether one is stored. A view that
 * cannot be handed the password cannot leak it into HTML by accident.
 */
export interface SettingsValues {
  defaultPostalCode: string
  notifier: string
  mapPreview: boolean
  /** Whether the file actually has a mail block, as opposed to the form merely showing defaults. */
  imapConfigured: boolean
  imapHost: string
  imapPort: string
  imapUser: string
  imapMailbox: string
  passSet: boolean
}

export type ApplyResult =
  | { ok: true; doc: ConfigDocument; config: Config }
  | { ok: false; message: string }

const isObject = (v: unknown): v is ConfigDocument => typeof v === 'object' && v !== null && !Array.isArray(v)
const imapBlock = (doc: ConfigDocument): ConfigDocument | undefined => (isObject(doc.imap) ? doc.imap : undefined)
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const storedPass = (doc: ConfigDocument): string | undefined => {
  const pass = imapBlock(doc)?.pass
  return typeof pass === 'string' && pass !== '' ? pass : undefined
}

/**
 * Gmail, because that is what the setup instructions, the filter file and the App Password steps all
 * assume. Shown only when the file has no mail block at all, so a first-time reader fills in two
 * boxes instead of five and never has to know the host or the port. Every field stays editable, and
 * nothing is written until the form is saved - these are a starting point, not a decision.
 */
const GMAIL_DEFAULTS = { host: 'imap.gmail.com', port: '993', mailbox: 'parcels' } as const

/** The saved values, for the page's first render. Shows the effective default for anything absent. */
export function settingsValues(doc: ConfigDocument): SettingsValues {
  const imap = imapBlock(doc)
  const fresh = imap === undefined
  return {
    defaultPostalCode: text(doc.defaultPostalCode),
    notifier: text(doc.notifier) || 'auto',
    mapPreview: doc.mapPreview !== false,
    imapConfigured: !fresh,
    imapHost: fresh ? GMAIL_DEFAULTS.host : text(imap?.host),
    imapPort: fresh ? GMAIL_DEFAULTS.port : text(imap?.port),
    imapUser: text(imap?.user),
    imapMailbox: fresh ? GMAIL_DEFAULTS.mailbox : text(imap?.mailbox),
    passSet: storedPass(doc) !== undefined,
  }
}

/**
 * What the user typed, for re-rendering a form that was rejected: nobody should have to retype four
 * fields because the fifth was wrong. The password is dropped here, not later - whether one is stored
 * is still read from the file, because a rejected form stored nothing.
 */
export function submittedSettings(f: SettingsForm, doc: ConfigDocument): SettingsValues {
  return {
    imapConfigured: imapBlock(doc) !== undefined,
    defaultPostalCode: (f.defaultPostalCode ?? '').trim(),
    notifier: (f.notifier ?? '').trim() || 'auto',
    mapPreview: f.mapPreview !== 'false',
    imapHost: (f.imapHost ?? '').trim(),
    imapPort: (f.imapPort ?? '').trim(),
    imapUser: (f.imapUser ?? '').trim(),
    imapMailbox: (f.imapMailbox ?? '').trim(),
    passSet: storedPass(doc) !== undefined,
  }
}

const no = (message: string): ApplyResult => ({ ok: false, message })

/**
 * The submitted form applied to the config file's current document, or a readable reason why not.
 *
 * It starts from `doc` and overwrites only the fields the page offers, so keys this version of the
 * app knows nothing about (and `port` and `dbPath`, which it does know and may not change) come
 * through untouched. The result is validated with `validateConfig` - the rules `loadConfig` applies -
 * so a caller that writes `doc` cannot produce a file that stops the app from starting.
 */
export function applySettings(doc: ConfigDocument, f: SettingsForm): ApplyResult {
  const postcode = (f.defaultPostalCode ?? '').replace(/\s+/g, '')
  if (postcode === '') return no('Enter the postcode GLS and DPD should use by default.')
  if (!/^\d{5}$/.test(postcode)) return no(`"${postcode}" is not a postcode. Five digits, like 81101.`)

  const notifier = (f.notifier ?? '').trim()
  if (!(NOTIFIERS as readonly string[]).includes(notifier)) {
    return no(`The notifier must be one of ${NOTIFIERS.join(', ')}.`)
  }

  const mapPreview = f.mapPreview === 'true' ? true : f.mapPreview === 'false' ? false : undefined
  if (mapPreview === undefined) return no('The map preview must be on or off.')

  const host = (f.imapHost ?? '').trim()
  const portText = (f.imapPort ?? '').trim()
  const user = (f.imapUser ?? '').trim()
  const mailbox = (f.imapMailbox ?? '').trim()
  // Google shows an App Password in four space-separated groups; the spaces are presentation only.
  const typedPass = (f.imapPass ?? '').replace(/\s+/g, '')
  const kept = storedPass(doc)

  // A config file is not a place for a paste accident: every one of these is well under 100 in practice.
  const MAX_FIELD = 255
  if ([host, user, mailbox, typedPass].some(s => s.length > MAX_FIELD)) {
    return no(`No mail connection field is longer than ${MAX_FIELD} characters.`)
  }

  let imap: ConfigDocument | undefined
  if (host === '' && portText === '' && user === '' && mailbox === '') {
    // Every field cleared is the way to turn mail ingest off. A password with nothing to use it on is
    // more likely a half-finished edit than that intention, so it is refused rather than discarded.
    if (typedPass !== '') return no('Fill in the mail server fields, or clear the password too to turn mail ingest off.')
    imap = undefined
  } else {
    if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
      return no('The IMAP port must be a whole number from 1 to 65535 (993 for Gmail).')
    }
    if (host === '') return no('The mail server needs a host name (imap.gmail.com for Gmail).')
    if (user === '') return no('The mail server needs the account to log in as.')
    if (mailbox === '') return no('Name the mailbox to read: the Gmail label, for example "parcels".')
    const pass = typedPass !== '' ? typedPass : kept
    if (pass === undefined) return no('An App Password is needed to read the mailbox. Leave it blank only if one is already stored.')
    imap = { ...imapBlock(doc), host, port: Number(portText), user, pass, mailbox }
  }

  const next: ConfigDocument = { ...doc, defaultPostalCode: postcode, notifier, mapPreview }
  if (imap === undefined) delete next.imap
  else next.imap = imap

  try {
    return { ok: true, doc: next, config: validateConfig(next, 'these settings') }
  } catch (err) {
    // The form checks above cover every field the form can reach; this catches the rest of the file
    // (a hand-edited `port`, say) rather than writing something the app could not load afterwards.
    return no(err instanceof Error ? err.message : String(err))
  }
}

/** The mail-block fields the page offers, in the order the form shows them. */
const IMAP_FIELDS = [
  ['imap.host', 'host'], ['imap.port', 'port'], ['imap.user', 'user'],
  ['imap.mailbox', 'mailbox'], ['imap.pass', 'pass'],
] as const

/**
 * WHICH settings a save changed, by name, and never what they changed to.
 *
 * This is the whole of what the activity log records about a save, and the reason it is a list of
 * names rather than a diff: `imap.pass` is an App Password and `defaultPostalCode` is where the user
 * lives, so a log that carried values would be a log that could not be sent. "The notifier and the App
 * Password changed on Tuesday" is the diagnostic; the values are already in the config file for
 * anyone entitled to read them.
 *
 * Mail being turned on or off is reported as the single field `imap`, not as five simultaneous
 * changes: adding or removing the block is one decision, and listing its parts would read as somebody
 * having edited each of them. Compared against the document as it was on disk (the page re-reads it
 * per request), so a save that changed nothing is honestly reported as having changed nothing.
 */
export function changedSettingFields(before: ConfigDocument, after: ConfigDocument): SettingField[] {
  const changed: SettingField[] = []
  if (text(before.defaultPostalCode) !== text(after.defaultPostalCode)) changed.push('defaultPostalCode')
  if (text(before.notifier) !== text(after.notifier)) changed.push('notifier')
  // Compared as the effective value, not as the stored one: absent means on, so a document that gains
  // an explicit `true` did not change the setting and must not read as having done so.
  if ((before.mapPreview !== false) !== (after.mapPreview !== false)) changed.push('mapPreview')

  const a = imapBlock(before)
  const b = imapBlock(after)
  if ((a === undefined) !== (b === undefined)) {
    changed.push('imap')
  } else if (a !== undefined && b !== undefined) {
    for (const [name, key] of IMAP_FIELDS) if (text(a[key]) !== text(b[key])) changed.push(name)
  }
  return changed
}
