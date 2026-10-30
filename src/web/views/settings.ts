import { NOTIFIERS } from '../../core/config.js'
import type { ImapProbeResult } from '../../ingest/imap-probe.js'
import { CalendarFailure } from '../../core/calendar-app.js'
import type { SettingsValues } from '../settings.js'
import { appearanceFields } from './appearance.js'
import { glyph } from './glyphs.js'
import { html, raw, type Html } from './html.js'
import { layout, notice, type PageCtx } from './layout.js'

/** The two fields a form cannot change, and the file they live in. Shown, with the reason, never editable. */
export interface RuntimeFacts {
  port: number
  dbPath: string
  configPath: string
}

export interface SettingsState {
  /** A rejected save. The form is re-rendered with what was typed. */
  error?: string
  /** Arrived here from a successful save. */
  saved?: boolean
  /** The result of a connection test made by the POST that rendered this page. */
  test?: ImapProbeResult
  /**
   * The file on disk does not load - it was edited by hand into a state this app rejects. The page
   * still renders (it is the one place that can explain and repair it), but nothing is tested until
   * it loads, because the poller is failing on the same file.
   */
  configError?: string
  /** The writable calendars Calendar.app listed for this render, or why it could not. Absent: not asked. */
  calendars?: CalendarList
}

export type CalendarList = { ok: true; names: string[] } | { ok: false; why: string }

/** Why Calendar.app could not list its calendars, as a sentence for the settings page. */
export function calendarListWhy(err: unknown): string {
  const f = err instanceof CalendarFailure ? err : undefined
  switch (f?.kind) {
    case 'denied':
      return 'macOS has not allowed this app to control Calendar. Allow it in System Settings → Privacy & Security → Automation → node → Calendar, then reload this page.'
    case 'not_running':
      return 'Calendar is not open, and this page does not open it for you. Open Calendar, then reload this page.'
    case 'timeout':
      return 'Calendar did not answer in time. The first time, macOS asks whether node may control Calendar: answer that, then reload this page.'
    default: {
      const said = f?.detail ?? (err instanceof Error ? err.message : String(err))
      return `Calendar said: ${said}`
    }
  }
}

const APP_PASSWORDS = 'https://myaccount.google.com/apppasswords'
const TWO_STEP = 'https://myaccount.google.com/signinoptions/twosv'
// Straight to the tab, not to the inbox: `u/0` is the first signed-in account, which is why the guide
// says to check the address before importing.
const GMAIL_FILTERS = 'https://mail.google.com/mail/u/0/#settings/filters'
const GMAIL_LABELS = 'https://mail.google.com/mail/u/0/#settings/labels'

/**
 * How to connect Gmail, click by click, on the page where the result is typed in. Open until a mail
 * account is saved, folded after. Every button is named as Gmail and Google name it, in bold, in the
 * order they appear, and every page is a direct link - the person following this has never seen the
 * Filters tab, and "Settings, Filters and Blocked Addresses" is three clicks they would have to find.
 * The filter itself is a download from this server, so "Choose File" finds it in Downloads.
 *
 * The order matters: the label must exist and be visible to IMAP before the first test, or that test
 * says the mailbox is not there.
 */
function gmailGuide(v: SettingsValues): Html {
  return html`<details class="guide"${v.imapConfigured ? '' : raw(' open')}><summary>How to connect Gmail — three steps, about five minutes</summary>
<ol class="steps">
<li><strong>Label your shipping emails.</strong>
<ol>
<li>Download the filter: <a href="/gmail-filter.xml" download>gmail-filter.xml</a>. It goes to your Downloads folder.</li>
<li>Open <a href="${GMAIL_FILTERS}">Gmail’s filter settings</a> (in Gmail: the gear icon → <strong>See all settings</strong> → <strong>Filters and Blocked Addresses</strong>). Signed in to more than one Google account? Check the address at the top right is the one you will enter below.</li>
<li>At the bottom of the page, click <strong>Import filters</strong>.</li>
<li>Click <strong>Choose File</strong>, pick <strong>gmail-filter.xml</strong> in Downloads, then click <strong>Open file</strong>.</li>
<li>Gmail shows the filter it found. Tick <strong>Apply new filters to existing email</strong> — without it only mail that arrives from now on is labelled — then click <strong>Create filters</strong>.</li>
<li>Open <a href="${GMAIL_LABELS}">Gmail’s label settings</a>, find <strong>parcels</strong> under Labels, and make sure <strong>Show in IMAP</strong> is ticked.</li>
</ol></li>
<li><strong>Make an App Password</strong>, which lets this app read that label without your Google password.
<ol>
<li><a href="${TWO_STEP}">2-Step Verification</a> has to be on. If it is off, turn it on first.</li>
<li>Open <a href="${APP_PASSWORDS}">App passwords</a>, type a name such as <strong>Parcels</strong>, and click <strong>Create</strong>.</li>
<li>Google shows a 16-letter password once. Copy it.</li>
</ol></li>
<li><strong>Paste it here.</strong> Enter your Gmail address and the App Password below and click <strong>Save settings</strong>. Saving tests the connection, and the answer appears at the top of this page.</li>
</ol></details>`
}

/** The notifier choices, said as what they do. Only under Advanced; "Automatic" is right for everyone. */
const NOTIFIER_LABEL: Record<string, string> = {
  auto: 'Automatic (recommended)',
  'terminal-notifier': 'terminal-notifier only',
  osascript: 'Built-in macOS notifications only',
}

const option = (value: string, label: string, current: string): Html =>
  html`<option value="${value}"${value === current ? raw(' selected') : ''}>${label}</option>`

/** The server's own words, when it gave any: one line, already redacted and bounded by the probe. */
const why = (detail: string | undefined): Html =>
  detail ? html`<p class="meta">The server said: ${detail}</p>` : html``

/**
 * The answer to the one question this page exists to answer. Every branch names what to do next,
 * because every one of these failures is otherwise silent: a wrong password shows up three polls
 * later on /health, and a label that is not ticked "Show in IMAP" is indistinguishable from no mail.
 */
function testResult(r: ImapProbeResult): Html {
  switch (r.kind) {
    case 'not_configured':
      return notice('neutral', html`<p><strong>No mail account is configured.</strong></p>
<p>Nothing was tried. Fill in your Gmail details below and save them, or leave them empty and add parcels by hand.</p>`, true)

    case 'ok':
      return r.messages === 0
        ? notice('neutral', html`<p class="st t-3">${glyph('pre_transit')}Connected, nothing to read</p>
<p><strong>${r.user}</strong> — the label <strong>${r.mailbox}</strong> exists, and it is empty.</p>
<p class="meta">The connection, the password and the label are all fine, so this is not a fault: a Gmail filter that matches nothing looks exactly like this. Check that the filter's action is <strong>Apply the label: ${r.mailbox}</strong>, and that <strong>Apply new filters to existing email</strong> was ticked when you imported it (<strong>Also apply filter to matching conversations</strong>, on a filter made by hand), which is what fills the label with mail you already have.</p>`, true)
        : notice('neutral', html`<p class="st t-ok">${glyph('delivered')}Connected</p>
<p><strong>${r.user}</strong> — the label <strong>${r.mailbox}</strong> has <strong>${r.messages}</strong> ${r.messages === 1 ? 'message' : 'messages'}.</p>
<p class="meta">Signed in, the label is visible, and its emails can be read. Everything is in place: new shipping emails become parcels at the next hourly check.</p>`, true)

    case 'auth':
      return notice('warn', html`<p><strong>Authentication failed for ${r.user}.</strong></p>
<p>The host answered, so this is the App Password: it is wrong, or it has been revoked. Create a new one at <a href="${APP_PASSWORDS}">myaccount.google.com/apppasswords</a> and paste it into the App Password field below. (That page exists only while 2-step verification is on.)</p>${why(r.detail)}`, true)

    case 'mailbox':
      return notice('warn', html`<p><strong>The mailbox <span class="mono">${r.mailbox}</span> is not there.</strong></p>
<p>Connected and authenticated, so the account is fine. Gmail hides a label from IMAP until you say otherwise, and this is the step that catches everyone: open <a href="${GMAIL_LABELS}">Gmail’s label settings</a>, find <strong>${r.mailbox}</strong>, tick <strong>Show in IMAP</strong>. Then test again.</p>
<p class="meta">If it is already ticked, check the name: it is case-sensitive, and a nested label is written <span class="mono">parent/child</span>.</p>${why(r.detail)}`, true)

    case 'network':
      return notice('warn', html`<p><strong>Could not reach <span class="mono">${r.host}</span> on port <span class="mono">${r.port}</span>.</strong></p>
<p>A network problem rather than a mail one: nothing was signed in to, so the password was never in question. Check that this Mac is online. If it is, check the mail server and port under Advanced below (for Gmail they are <span class="mono">imap.gmail.com</span> and <span class="mono">993</span>).</p>${why(r.detail)}`, true)

    case 'unknown':
      return notice('warn', html`<p><strong>The mail server refused the request.</strong></p>
<p>Not one of the usual failures, so it is reported as it came rather than guessed at.</p>${why(r.detail)}`, true)
  }
}

/**
 * "Calendar for pickups": a select of the writable calendars Calendar.app listed for this render. The
 * empty value is the first writable one, named so the default is not a mystery. A stored name that is
 * not in the list stays selectable and says so, so a save does not quietly change it; a name several
 * calendars share says that too, because adding to it is refused until it is told apart.
 *
 * When the list could not be read there is no select at all, only a sentence saying why: the form then
 * does not send the field, and a save keeps whatever is stored.
 */
function calendarField(v: SettingsValues, list: CalendarList | undefined): Html {
  const hint = html`<span class="meta hint">Where “Add to Calendar” puts a pickup. Calendar can sync it to your phone.</span>`
  if (!list || !list.ok) {
    return html`<div class="wide" id="calendar"><span class="lbl">Calendar for pickups</span>
<p class="meta hint">${v.pickupCalendar ? html`Now “${v.pickupCalendar}”.` : 'Now the first calendar you can write to.'} The list of your calendars could not be read, so it cannot be changed here right now: ${list ? list.why : 'it was not asked for'}</p></div>`
  }
  const counts = new Map<string, number>()
  for (const n of list.names) counts.set(n, (counts.get(n) ?? 0) + 1)
  const names = [...counts.keys()]
  const first = list.names[0]
  const extra = v.pickupCalendar !== '' && !counts.has(v.pickupCalendar) ? [v.pickupCalendar] : []
  return html`<label class="wide" id="calendar">Calendar for pickups<select name="pickupCalendar">${
    option('', first ? `The first one (now “${first}”)` : 'The first one (there is none yet)', v.pickupCalendar)}${
    names.map(n => option(n, (counts.get(n) ?? 0) > 1 ? `${n} (${counts.get(n)} calendars have this name)` : n, v.pickupCalendar))}${
    extra.map(n => option(n, `${n} (not found in Calendar)`, v.pickupCalendar))}</select>${hint}</label>`
}

/** What the button is about to do, in the saved values, so the test is never a black box. */
function testTarget(v: SettingsValues): Html {
  if (!v.imapConfigured) {
    return html`<p class="meta">No Gmail account is saved yet, so there is nothing to test.</p>`
  }
  return html`<p class="meta">Signs in as <span class="mono">${v.imapUser}</span> and counts the emails under the label <span class="mono">${v.imapMailbox}</span>, without changing or marking anything. It uses the settings <strong>as they are saved</strong>, not unsaved changes above.</p>`
}

/**
 * Where the app keeps its files, in place of the paths a git install shows. The button sits inside
 * the settings form on the page but belongs to its own empty form (`revealForm`, outside it) through
 * the `form` attribute: forms cannot nest, and a submit button of the settings form placed before
 * "Save settings" would become the one Enter presses in any field, revealing a folder instead of saving.
 */
const appFiles = html`<p class="meta">Parcels keeps its settings and data in Application Support/Parcels.</p>
<p><button form="reveal-data" type="submit">Show in Finder</button></p>`

const revealForm = html`<form method="post" action="/app/reveal-data" id="reveal-data"></form>`

/**
 * The settings page, written for the person who has just been handed this Mac rather than for its
 * author. What a first-time reader needs - the Gmail address, the App Password, the label, the
 * postcode - is in plain sight with one primary button after it. The things they will never need to
 * touch (the notifier, the mail server's host and port, what is fixed at startup) are under a closed
 * "Advanced", because a page that opens with `config.json` and `launchctl` reads as "not for you".
 *
 * Saving a change to the mail settings tests it straight away (see POST /settings), so the answer to
 * "did that work?" is on the page the save lands on; "Test again" re-asks without saving.
 */
export function settingsPage(
  v: SettingsValues, runtime: RuntimeFacts, ctx: PageCtx, state: SettingsState = {},
  /**
   * Run by the Mac app. Advanced then names no file paths and no notifier: the app posts its own
   * notifications, and its files live in one folder it can show in Finder.
   */
  app = false,
): Html {
  return layout('Settings', '/settings', html`
<div class="col"><h1>Settings</h1>
<p class="lede">Connect your Gmail so parcels are added from your shipping emails, and set the postcode some carriers need. A save takes effect at once on these pages; the hourly check in the background picks it up on its next run.</p>
${state.configError ? notice('warn', html`<p><strong>The saved settings cannot be loaded.</strong></p>
<p>${state.configError}</p>
<p class="meta">Parcels are not being checked until this is fixed. Correcting the fields below and saving puts things right.</p>`) : ''}
${state.error ? notice('warn', html`<p>${state.error}</p><p class="meta">Nothing was saved.</p>`, true) : ''}
${state.saved ? notice('neutral', html`<p>Saved.</p>`, true) : ''}
${state.test && state.saved ? testResult(state.test) : ''}

<form method="post" action="/settings">
<h2>Gmail</h2>
<p class="meta">The app reads the emails Gmail files under one label, signing in with an App Password rather than your Google password. To stop reading mail, clear these fields and the mail server under Advanced.</p>
${gmailGuide(v)}
<div class="fields">
<label class="wide">Gmail address<input type="email" name="imapUser" value="${v.imapUser}" autocomplete="username" placeholder="you@gmail.com" autocapitalize="off" spellcheck="false"></label>
<label class="wide">App Password <span class="meta">${v.passSet ? '(set)' : '(not set)'}</span><input type="password" name="imapPass" autocomplete="new-password" spellcheck="false">${
    v.passSet
      ? html`<span class="meta hint">Saved, and never shown again. Leave this blank to keep it; type a new one to replace it.</span>`
      : html`<span class="meta hint">A 16-character App Password from <a href="${APP_PASSWORDS}">myaccount.google.com/apppasswords</a>, not your Google password. Spaces are ignored.</span>`
  }</label>
<label class="wide">Gmail label<input name="imapMailbox" value="${v.imapMailbox}" autocapitalize="off" spellcheck="false"><span class="meta hint">The label your parcel emails are filed under. In Gmail's label settings it must have "Show in IMAP" ticked. A label inside another is written <span class="mono">parent/child</span>.</span></label>
</div>

<h2>Parcels</h2>
<div class="fields">
<label>Default postcode<input name="defaultPostalCode" value="${v.defaultPostalCode}" size="8" inputmode="numeric" pattern="[0-9]{3} ?[0-9]{2}" required><span class="meta hint">GLS and DPD need one to answer; a parcel can have its own.</span></label>
<label>Pickup map<select name="mapPreview">${option('true', 'On', String(v.mapPreview))}${option('false', 'Off', String(v.mapPreview))}</select><span class="meta hint">Off removes the map and stops looking addresses up online.</span></label>
${calendarField(v, state.calendars)}
</div>

${appearanceFields(v)}
<details class="adv"${app ? raw(' id="adv"') : ''}><summary>Advanced</summary>
<p class="meta">Nothing here normally needs changing.</p>
<div class="fields">
<label>Mail server<input name="imapHost" value="${v.imapHost}" autocapitalize="off" spellcheck="false"></label>
<label>Port<input name="imapPort" value="${v.imapPort}" size="6" inputmode="numeric"></label>
${app ? '' : html`<label class="wide">Notifications<select name="notifier">${NOTIFIERS.map(n => option(n, NOTIFIER_LABEL[n] ?? n, v.notifier))}</select><span class="meta hint">How desktop notifications are shown.</span></label>`}
</div>
${app ? appFiles : html`<p class="meta">Fixed while the app is running:</p>
<table class="stats"><tbody>
<tr><td>Port</td><td class="mono">${runtime.port}</td></tr>
<tr><td>Database</td><td class="mono">${runtime.dbPath}</td></tr>
<tr><td>Settings file</td><td class="mono">${runtime.configPath}</td></tr>
</tbody></table>
<p class="meta">The app opens these once, when it starts, so no form can move them. Changing one means editing the settings file and restarting the app: ask whoever set this Mac up.</p>`}
</details>

<p><button class="pri">Save settings</button></p>
</form>

<h2 id="test">Test the Gmail connection</h2>
${state.test && !state.saved ? testResult(state.test) : ''}
${testTarget(v)}
<form method="post" action="/settings/test#test"><button>${state.test ? 'Test again' : 'Test connection'}</button></form>
${app ? revealForm : ''}</div>`, ctx)
}
