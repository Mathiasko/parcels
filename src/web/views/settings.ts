import { NOTIFIERS } from '../../core/config.js'
import type { ImapProbeResult } from '../../ingest/imap-probe.js'
import type { SettingsValues } from '../settings.js'
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
}

const APP_PASSWORDS = 'https://myaccount.google.com/apppasswords'

const NOTIFIER_LABEL: Record<string, string> = {
  auto: 'auto (terminal-notifier, else osascript)',
  'terminal-notifier': 'terminal-notifier',
  osascript: 'osascript',
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
<p>Nothing was tried. Fill in the mail connection below and save it, or leave it empty and add parcels by hand.</p>`, true)

    case 'ok':
      return r.messages === 0
        ? notice('neutral', html`<p class="st t-3">${glyph('pre_transit')}Connected, nothing to read</p>
<p><strong>${r.user}</strong> — the label <strong>${r.mailbox}</strong> exists, and it is empty.</p>
<p class="meta">The connection, the password and the label are all fine, so this is not a fault: a Gmail filter that matches nothing looks exactly like this. Check that the filter's action is <strong>Apply the label: ${r.mailbox}</strong>, and that <strong>Also apply filter to matching conversations</strong> was ticked when you made it, which is what back-fills the label with mail you already have.</p>`, true)
        : notice('neutral', html`<p class="st t-ok">${glyph('delivered')}Connected</p>
<p><strong>${r.user}</strong> — the label <strong>${r.mailbox}</strong> has <strong>${r.messages}</strong> ${r.messages === 1 ? 'message' : 'messages'}.</p>
<p class="meta">Authenticated, the label is visible to IMAP, and its messages are readable. Mail ingest has everything it needs; new mail becomes parcels at the next poll.</p>`, true)

    case 'auth':
      return notice('warn', html`<p><strong>Authentication failed for ${r.user}.</strong></p>
<p>The host answered, so this is the App Password: it is wrong, or it has been revoked. Create a new one at <a href="${APP_PASSWORDS}">myaccount.google.com/apppasswords</a> and paste it into the App Password field below. (That page exists only while 2-step verification is on.)</p>${why(r.detail)}`, true)

    case 'mailbox':
      return notice('warn', html`<p><strong>The mailbox <span class="mono">${r.mailbox}</span> is not there.</strong></p>
<p>Connected and authenticated, so the account is fine. Gmail hides a label from IMAP until you say otherwise, and this is the step that catches everyone: <strong>Gmail, Settings, Labels</strong>, find <strong>${r.mailbox}</strong>, tick <strong>Show in IMAP</strong>. Then test again.</p>
<p class="meta">If it is already ticked, check the name: it is case-sensitive, and a nested label is written <span class="mono">parent/child</span>.</p>${why(r.detail)}`, true)

    case 'network':
      return notice('warn', html`<p><strong>Could not reach <span class="mono">${r.host}</span> on port <span class="mono">${r.port}</span>.</strong></p>
<p>A network, DNS or TLS problem rather than a mail one: nothing was authenticated, so the password was never in question. Check that this machine is online, and that the host and port below are right (Gmail is <span class="mono">imap.gmail.com</span> on <span class="mono">993</span>).</p>${why(r.detail)}`, true)

    case 'unknown':
      return notice('warn', html`<p><strong>The mail server refused the request.</strong></p>
<p>Not one of the usual failures, so it is reported as it came rather than guessed at.</p>${why(r.detail)}`, true)
  }
}

/** What the button is about to do, in the saved values, so the test is never a black box. */
function testTarget(v: SettingsValues): Html {
  if (v.imapHost === '' && v.imapUser === '' && v.imapMailbox === '') {
    return html`<p class="meta">No mail account is saved yet, so there is nothing to test.</p>`
  }
  return html`<p class="meta">Connects to <span class="mono">${v.imapHost}</span> on port <span class="mono">${v.imapPort}</span> as <span class="mono">${v.imapUser}</span> and opens <span class="mono">${v.imapMailbox}</span> read-only, exactly as a poll does: it counts what is in the mailbox and marks nothing as read. It uses the settings <strong>as they are saved</strong>, not unsaved edits below.</p>`
}

export function settingsPage(
  v: SettingsValues, runtime: RuntimeFacts, ctx: PageCtx, state: SettingsState = {},
): Html {
  return layout('Settings', '/settings', html`
<div class="col"><h1>Settings</h1>
<p class="lede">What this tracker reads out of <span class="mono">config.json</span>. A save takes effect in this page and the rest of the web server at once; the poller is a separate process that re-reads the file at the start of every run, so mail ingest and the carriers follow at the next hourly poll.</p>
${state.configError ? notice('warn', html`<p><strong>The config file on disk cannot be loaded.</strong></p>
<p>${state.configError}</p>
<p class="meta">The poller is failing on the same file. Correcting the fields below and saving replaces it with a file that loads.</p>`) : ''}
${state.error ? notice('warn', html`<p>${state.error}</p><p class="meta">Nothing was saved.</p>`, true) : ''}
${state.saved ? notice('neutral', html`<p>Saved to <span class="mono">${runtime.configPath}</span>.</p>`, true) : ''}

<h2>Mail connection test</h2>
${state.test ? testResult(state.test) : ''}
<form method="post" action="/settings/test"><button class="pri">Test mail connection</button></form>
${testTarget(v)}

<form method="post" action="/settings">
<h2>General</h2>
<div class="fields">
<label>Default postcode<input name="defaultPostalCode" value="${v.defaultPostalCode}" size="8" inputmode="numeric" pattern="[0-9]{3} ?[0-9]{2}" required><span class="meta hint">GLS and DPD need one to answer; a parcel can override it.</span></label>
<label>Notifier<select name="notifier">${NOTIFIERS.map(n => option(n, NOTIFIER_LABEL[n] ?? n, v.notifier))}</select></label>
<label class="wide">Pickup map preview<select name="mapPreview">${option('true', 'On', String(v.mapPreview))}${option('false', 'Off', String(v.mapPreview))}</select><span class="meta hint">Off removes the map and stops all geocoding and tile fetching.</span></label>
</div>

<h2>Mail connection</h2>
<p class="meta">Clear all four fields to turn mail ingest off and add parcels by hand.</p>
<div class="fields">
<label>Host<input name="imapHost" value="${v.imapHost}" autocapitalize="off" spellcheck="false"></label>
<label>Port<input name="imapPort" value="${v.imapPort}" size="6" inputmode="numeric"></label>
<label class="wide">Account<input name="imapUser" value="${v.imapUser}" autocapitalize="off" spellcheck="false"></label>
<label class="wide">Mailbox<input name="imapMailbox" value="${v.imapMailbox}" autocapitalize="off" spellcheck="false"><span class="meta hint">The Gmail label, which must be ticked "Show in IMAP". A nested label is <span class="mono">parent/child</span>.</span></label>
<label class="wide">App Password <span class="meta">${v.passSet ? '(set)' : '(not set)'}</span><input type="password" name="imapPass" autocomplete="off" spellcheck="false">${
    v.passSet
      ? html`<span class="meta hint">Stored, and never shown again. Leave this blank to keep it; type a new one to replace it.</span>`
      : html`<span class="meta hint">A 16-character App Password from <a href="${APP_PASSWORDS}">myaccount.google.com/apppasswords</a>, not your Google password. Spaces are ignored.</span>`
  }</label>
</div>
<p><button class="pri">Save settings</button></p>
</form>

<h2>Fixed until the server restarts</h2>
<table class="stats"><tbody>
<tr><td>Port</td><td class="mono">${runtime.port}</td></tr>
<tr><td>Database</td><td class="mono">${runtime.dbPath}</td></tr>
<tr><td>Config file</td><td class="mono">${runtime.configPath}</td></tr>
</tbody></table>
<p class="meta">These two are read once, at startup: the server is already listening on that port and the database is already open, so no form can move them. Edit <span class="mono">config.json</span> and restart the web agent (<span class="mono">launchctl kickstart -k gui/$(id -u)/local.parcels.web</span>) to change either.</p>
</div>`, ctx)
}
