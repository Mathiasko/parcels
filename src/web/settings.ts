import { DEFAULT_APPEARANCE, MODES, THEME_IDS, type Mode } from '../core/appearance.js'
import { DEFAULT_NOTIFICATIONS, NOTIFIERS, validateConfig, type Config, type ConfigDocument, type NotificationPrefs } from '../core/config.js'
import type { SettingField } from '../db/activity-log.js'
import { THEMES } from './themes/index.js'

/**
 * The form, as `application/x-www-form-urlencoded` delivers it. `port` and `dbPath` are deliberately
 * absent: they are bound at process start, the page shows them read-only, and a crafted POST that
 * sends them must change nothing - which it cannot, because nothing here ever reads them.
 */
export interface SettingsForm {
  defaultPostalCode?: string
  notifier?: string
  mapPreview?: string
  /** Absent when the page could not list the calendars and so offered no choice: the stored one is kept. */
  pickupCalendar?: string
  /** Absent from a form rendered before themes existed (a tab left open over an upgrade): the stored one is kept. */
  theme?: string
  mode?: string
  imapHost?: string
  imapPort?: string
  imapUser?: string
  imapMailbox?: string
  imapPass?: string
  /**
   * `1` on every page this version renders, and the only thing that makes the three checkboxes below
   * mean anything: an unticked checkbox is not sent at all, so "absent" cannot tell "turned off" from
   * "this form never had the box" (an old cached page, a crafted POST). Without the marker the stored
   * `notifications` block is kept as it is; with it, a box that is not `on` is off.
   */
  notificationsForm?: string
  /** `on` when ticked (what a browser sends for a checkbox without a value), absent when not. */
  notifyProgress?: string
  notifyDailyReminder?: string
  notifyDelivered?: string
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
  /** The chosen calendar's name; `''` is the first writable calendar. */
  pickupCalendar: string
  /** A theme id, as the file has it (or the default when it has none). */
  theme: string
  /** `system`, `light` or `dark`, likewise. */
  mode: string
  /** Whether the file actually has a mail block, as opposed to the form merely showing defaults. */
  imapConfigured: boolean
  imapHost: string
  imapPort: string
  imapUser: string
  imapMailbox: string
  passSet: boolean
  /** The three switches as they are in effect: stored values over the defaults. */
  notifications: NotificationPrefs
  /** The Gmail filter version last imported, as in effect: a stored whole number from 1, else 1. */
  filterVersion: number
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

/** What each mode is called on the page and in the errors; the order is the order the select lists them. */
export const MODE_LABEL: Record<Mode, string> = { system: 'Same as the Mac', light: 'Light', dark: 'Dark' }

/**
 * The theme and mode the file effectively has: what it says, or the default for whatever it does not.
 * This is also what changes are compared as, so a document that gains the explicit defaults has not
 * changed its appearance.
 */
function storedAppearance(doc: ConfigDocument): { theme: string; mode: string } {
  const block = isObject(doc.appearance) ? doc.appearance : undefined
  return {
    theme: text(block?.theme) || DEFAULT_APPEARANCE.theme,
    mode: text(block?.mode) || DEFAULT_APPEARANCE.mode,
  }
}

/**
 * Gmail, because that is what the setup instructions, the filter file and the App Password steps all
 * assume. Shown only when the file has no mail block at all, so a first-time reader fills in two
 * boxes instead of five and never has to know the host or the port. Every field stays editable, and
 * nothing is written until the form is saved - these are a starting point, not a decision.
 */
const GMAIL_DEFAULTS = { host: 'imap.gmail.com', port: '993', mailbox: 'parcels' } as const

/**
 * The switches in effect for a document: each stored boolean, the default for anything else. Lenient
 * on purpose, unlike `validateConfig`: the page must still render for a hand-edited file that the
 * validator rejects, because it is the place that repairs it.
 */
const notificationPrefs = (doc: ConfigDocument): NotificationPrefs => {
  const stored = isObject(doc.notifications) ? doc.notifications : {}
  const on = (key: keyof NotificationPrefs): boolean =>
    typeof stored[key] === 'boolean' ? stored[key] : DEFAULT_NOTIFICATIONS[key]
  return { progress: on('progress'), dailyReminder: on('dailyReminder'), delivered: on('delivered') }
}

/**
 * The filter version in effect for a document. Lenient like `notificationPrefs`: a hand-edited value
 * that the validator would reject reads as 1, so the page still renders and still offers the notice.
 */
export const effectiveFilterVersion = (doc: ConfigDocument): number =>
  Number.isInteger(doc.filterVersion) && (doc.filterVersion as number) >= 1 ? (doc.filterVersion as number) : 1

/** The submitted checkboxes, or null when the form did not carry them (see `SettingsForm.notificationsForm`). */
const submittedNotifications = (f: SettingsForm): NotificationPrefs | null =>
  f.notificationsForm === '1'
    ? { progress: f.notifyProgress === 'on', dailyReminder: f.notifyDailyReminder === 'on', delivered: f.notifyDelivered === 'on' }
    : null

/** The saved values, for the page's first render. Shows the effective default for anything absent. */
export function settingsValues(doc: ConfigDocument): SettingsValues {
  const imap = imapBlock(doc)
  const fresh = imap === undefined
  return {
    defaultPostalCode: text(doc.defaultPostalCode),
    notifier: text(doc.notifier) || 'auto',
    mapPreview: doc.mapPreview !== false,
    pickupCalendar: text(doc.pickupCalendar).trim(),
    ...storedAppearance(doc),
    imapConfigured: !fresh,
    imapHost: fresh ? GMAIL_DEFAULTS.host : text(imap?.host),
    imapPort: fresh ? GMAIL_DEFAULTS.port : text(imap?.port),
    imapUser: text(imap?.user),
    imapMailbox: fresh ? GMAIL_DEFAULTS.mailbox : text(imap?.mailbox),
    passSet: storedPass(doc) !== undefined,
    notifications: notificationPrefs(doc),
    filterVersion: effectiveFilterVersion(doc),
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
    pickupCalendar: f.pickupCalendar === undefined ? text(doc.pickupCalendar).trim() : f.pickupCalendar.trim(),
    theme: f.theme ?? storedAppearance(doc).theme,
    mode: f.mode ?? storedAppearance(doc).mode,
    imapHost: (f.imapHost ?? '').trim(),
    imapPort: (f.imapPort ?? '').trim(),
    imapUser: (f.imapUser ?? '').trim(),
    imapMailbox: (f.imapMailbox ?? '').trim(),
    passSet: storedPass(doc) !== undefined,
    notifications: submittedNotifications(f) ?? notificationPrefs(doc),
    filterVersion: effectiveFilterVersion(doc),
  }
}

const no = (message: string): ApplyResult => ({ ok: false, message })

/** Whether the submitted host, port and account are the ones the stored password was saved with. */
const sameMailServer = (stored: ConfigDocument | undefined, host: string, port: number, user: string): boolean =>
  stored !== undefined
  && text(stored.host).trim().toLowerCase() === host.toLowerCase()
  && Number(text(stored.port)) === port
  && text(stored.user).trim().toLowerCase() === user.toLowerCase()

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

  // Not checked against Calendar's list: the list may not be readable right now, and a name that is not
  // there is reported when it is used. Absent from the form (no list to offer) keeps what is stored.
  const pickupCalendar = f.pickupCalendar === undefined ? text(doc.pickupCalendar).trim() : f.pickupCalendar.trim()
  if (Array.from(pickupCalendar).length > 255) return no('A calendar name is not longer than 255 characters.')

  // Checked here, against the names the page shows, so the message says what the person saw in the
  // list. Absent from the form keeps what is stored; the exact id is required (no trimming, no case folding).
  if (f.theme !== undefined && !(THEME_IDS as readonly string[]).includes(f.theme)) {
    return no(`The theme must be one of ${THEMES.map(t => t.name).join(', ')}.`)
  }
  if (f.mode !== undefined && !(MODES as readonly string[]).includes(f.mode)) {
    return no(`The mode must be one of ${MODES.map(m => MODE_LABEL[m]).join(', ')}.`)
  }

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
    // The stored password belongs to the server and account it was saved for. Keeping it across a
    // change of either would let anything that can reach this loopback server (another local account,
    // a sandboxed app) point it at a server of its own and press "test": the real App Password would
    // be sent there. So a blank box keeps the password only when it would go back where it came from.
    if (typedPass === '' && kept !== undefined && !sameMailServer(imapBlock(doc), host, Number(portText), user)) {
      return no('Re-enter the App Password when changing the server or account. The saved one is only ever sent to the server it was saved for.')
    }
    const pass = typedPass !== '' ? typedPass : kept
    if (pass === undefined) return no('An App Password is needed to read the mailbox. Leave it blank only if one is already stored.')
    imap = { ...imapBlock(doc), host, port: Number(portText), user, pass, mailbox }
  }

  const next: ConfigDocument = { ...doc, defaultPostalCode: postcode, notifier, mapPreview }
  // The first writable calendar is the absence of a choice, so it is written as no key at all.
  if (pickupCalendar === '') delete next.pickupCalendar
  else next.pickupCalendar = pickupCalendar
  if (imap === undefined) delete next.imap
  else next.imap = imap
  // Written whole, all three keys, so the file says what the page showed; a form without the marker
  // leaves the block exactly as it was (and does not add one).
  const notifications = submittedNotifications(f)
  if (notifications !== null) next.notifications = { ...notifications }

  // Only the keys the form sent are written, into the stored block, so anything else inside it survives.
  if (f.theme !== undefined || f.mode !== undefined) {
    next.appearance = {
      ...(isObject(doc.appearance) ? doc.appearance : {}),
      ...(f.theme !== undefined && { theme: f.theme }),
      ...(f.mode !== undefined && { mode: f.mode }),
    }
  }

  try {
    return { ok: true, doc: next, config: validateConfig(next, 'these settings') }
  } catch (err) {
    // The form checks above cover every field the form can reach; this catches the rest of the file
    // (a hand-edited `port`, say) rather than writing something the app could not load afterwards.
    return no(err instanceof Error ? err.message : String(err))
  }
}

const NOTIFICATION_FIELDS = [
  ['notifications.progress', 'progress'], ['notifications.dailyReminder', 'dailyReminder'], ['notifications.delivered', 'delivered'],
] as const

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
  // Effective value again: `""` and no key both mean the first writable calendar.
  if (text(before.pickupCalendar).trim() !== text(after.pickupCalendar).trim()) changed.push('pickupCalendar')
  // By effective value, so a file with no block that is saved with the defaults changed nothing.
  const [was, now] = [notificationPrefs(before), notificationPrefs(after)]
  for (const [name, key] of NOTIFICATION_FIELDS) if (was[key] !== now[key]) changed.push(name)

  // Effective value too: absent means 1, so writing an explicit 1 is not a change.
  if (effectiveFilterVersion(before) !== effectiveFilterVersion(after)) changed.push('filterVersion')

  // Effective values again: an absent block and the explicit defaults are the same appearance.
  const wasLook = storedAppearance(before)
  const nowLook = storedAppearance(after)
  if (wasLook.theme !== nowLook.theme) changed.push('appearance.theme')
  if (wasLook.mode !== nowLook.mode) changed.push('appearance.mode')

  const a = imapBlock(before)
  const b = imapBlock(after)
  if ((a === undefined) !== (b === undefined)) {
    changed.push('imap')
  } else if (a !== undefined && b !== undefined) {
    for (const [name, key] of IMAP_FIELDS) if (text(a[key]) !== text(b[key])) changed.push(name)
  }
  return changed
}
