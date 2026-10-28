import type { CarrierId } from '../../core/types.js'
import { isEmailOnlyCarrier } from '../../core/types.js'
import type { HealthRow } from '../../db/health.js'
import type { IngestStatus } from '../../db/ingest-status.js'
import type { PollerStatus } from '../../core/pollwatch.js'
import { POLL_RUNS_KEPT, type PollRun, type RunTrigger } from '../../db/poll-runs.js'
import {
  ACTIVITY_LOG_KEPT, activityKindWord, describeActivity, type ActivityEntry, type Actor,
} from '../../db/activity-log.js'
import type { StoredUpdateCheck } from '../../db/update-state.js'
import type { UpdateOutcome, UpdateRun } from '../../core/update.js'
import { CARRIER_NAME, formatAgo, formatDateTime } from './format.js'
import { glyph, type GlyphName } from './glyphs.js'
import { html, type Html } from './html.js'
import { layout, notice, scroller, type PageCtx } from './layout.js'

/** `gated` means the adapter itself is broken (key rotated, endpoint closed): always an alarm while it persists. */
export const needsAttention = (h: HealthRow | undefined): boolean =>
  h !== undefined && h.lastErrorKind === 'gated' && h.consecutiveFailures > 0

/**
 * A health state: its glyph, colour and weight carry it as well as the word, so no state is a coloured
 * word alone. `email` is not a health state at all - it is the answer to a question this board cannot
 * ask - so it gets the quiet register and no hue, like `nodata`, and never the warn wash.
 */
function state(kind: 'ok' | 'nodata' | 'failing' | 'attention' | 'email', word: string, streak?: number): Html {
  const quiet = kind === 'ok' || kind === 'nodata' || kind === 'email'
  const g: GlyphName = kind === 'ok' ? 'delivered' : quiet ? 'pre_transit' : 'problem'
  const tone = kind === 'ok' ? 't-ok' : quiet ? 't-3' : 't-warn'
  return html`<span class="st ${tone}${quiet ? ' quiet' : ''}">${glyph(g)}${word}${streak ? html` · <span>${streak}</span> in a row` : ''}</span>`
}

function verdict(h: HealthRow | undefined): Html {
  if (!h) return state('nodata', 'no data')
  if (needsAttention(h)) return state('attention', 'needs attention', h.consecutiveFailures)
  if (h.consecutiveFailures > 0) return state('failing', 'failing', h.consecutiveFailures)
  return state('ok', 'ok')
}

const bad = (h: HealthRow | undefined): boolean => h !== undefined && h.consecutiveFailures > 0

/**
 * `4 of 5 carriers reporting. SPS has never been polled.` It says "all" only when it counts all.
 *
 * Counted over the carriers that are polled. An email-only one has no last-ok and never will, so
 * including it would make "all reporting" unreachable and "has never been polled" read as a fault;
 * it gets its own clause saying what it actually is.
 */
function lede(rows: Map<CarrierId, HealthRow>, ids: CarrierId[], mailConfigured: boolean): Html {
  const polled = ids.filter(id => !isEmailOnlyCarrier(id))
  const byEmail = ids.filter(isEmailOnlyCarrier).map(id => CARRIER_NAME[id])
  const failing = polled.filter(id => bad(rows.get(id)))
  const never = polled.filter(id => !rows.has(id)).map(id => CARRIER_NAME[id])
  const ok = polled.length - failing.length - never.length
  const head = failing.length > 0
    ? `${failing.length} of ${polled.length} carriers failing.`
    : ok === polled.length ? `All ${polled.length} carriers reporting.` : `${ok} of ${polled.length} carriers reporting.`
  const tail = never.length > 0 ? ` ${never.join(' and ')} ${never.length === 1 ? 'has' : 'have'} never been polled.` : ''
  const email = byEmail.length > 0
    ? ` ${byEmail.join(' and ')} ${byEmail.length === 1 ? 'is' : 'are'} not polled: ${byEmail.length === 1 ? 'its' : 'their'} updates arrive by email.`
    : ''
  // A board of green carriers is not "all well" while no mail can arrive: say it, and where to fix it.
  const mail = mailConfigured ? '' : html` Gmail is not connected yet, so no parcels arrive by email (see <a href="/settings">Settings</a>).`
  return html`${head + tail + email}${mail}`
}

/** Which part of the app acted. Named for what the user did, not for the process that did it. */
const RUN_SOURCE: Record<RunTrigger, string> = { poller: 'Poller', cli: 'Command line', web: 'Refresh now' }

/**
 * A run's verdict. A run that ERRORED is the most important row on this panel - it is the one that
 * means the numbers did not change - so it is washed warn exactly like a failing carrier, and its
 * error is printed in full. Carrier failures inside an otherwise complete run are warn too, but not
 * washed: the carrier board above already carries that alarm.
 */
function runVerdict(run: PollRun): Html {
  if (!run.finishedAt) return state('nodata', 'running')
  if (run.error) return state('attention', 'failed')
  if (run.failures > 0) return state('failing', 'carrier failures')
  return state('ok', 'ok')
}

/**
 * What each poll run did, newest first: the log that answers "is it working?" rather than "did my
 * click work?", which is why every entry point writes it (see db/poll-runs.ts). Bounded, and it says so.
 */
function runsPanel(runs: PollRun[], ctx: PageCtx): Html {
  if (runs.length === 0) {
    return html`<h2>Recent runs</h2><p class="empty">No runs recorded yet. The hourly poller and the Refresh now button both record here.</p>`
  }
  return html`<h2>Recent runs</h2>
<p class="meta">What each poll did, newest first. The last ${POLL_RUNS_KEPT} runs are kept.</p>${
    scroller('Recent poll runs', html`<table class="board runs"><thead><tr><th scope="col">State</th><th scope="col">Started</th><th scope="col">Source</th><th scope="col">What it did</th></tr></thead>
<tbody>${runs.map(r => html`<tr data-run="${r.id}"${r.error ? html` class="bad"` : ''}><td>${runVerdict(r)}</td>
<td>${formatDateTime(r.startedAt, ctx.now)}<span class="meta why">${formatAgo(r.startedAt, ctx.now)}</span></td>
<td class="src">${RUN_SOURCE[r.trigger] ?? r.trigger}</td>
<td class="did">${r.error ?? r.summary ?? (r.finishedAt ? 'nothing to report' : 'still going')}</td></tr>`)}</tbody></table>`)}`
}

/**
 * Who acted. Deliberately NOT `RUN_SOURCE`: a web RUN is only ever started by the Refresh now button,
 * so that table can call it that, but a web ENTRY is any action taken on these pages - a deletion, a
 * dismissal, a settings save - and labelling those "Refresh now" would be a small lie on every row.
 * Typed over `Actor`, so adding an actor is a compile error here rather than a bare word on the page.
 */
const ACTOR_SOURCE: Record<Actor, string> = {
  poller: 'Poller', cli: 'Command line', web: 'In the app', migration: 'Upgrade', unknown: 'Not recorded',
}

/**
 * What changed and who changed it, newest first: the log that answers "where did my parcel go?" and
 * "why does it say that?" rather than "is the poller running?" (which is the panel above).
 *
 * The status transitions and the user actions are one table on purpose - they are the same question
 * asked twice, and reading two interleaved lists by eye is how a cause gets missed. See
 * db/activity-log.ts for what a row may and may not carry.
 */
function activityPanel(entries: ActivityEntry[], ctx: PageCtx): Html {
  if (entries.length === 0) {
    return html`<h2>Recent activity</h2><p class="empty">Nothing has been recorded yet. Every status change, and everything you do here, lands in this log.</p>`
  }
  return html`<h2>Recent activity</h2>
<p class="meta">What changed and what you did, newest first. The last ${ACTIVITY_LOG_KEPT} entries are kept.</p>${
    scroller('Recent activity', html`<table class="board runs"><thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Detail</th><th scope="col">Source</th></tr></thead>
<tbody>${entries.map(e => html`<tr data-activity="${e.id}"><td>${formatDateTime(e.at, ctx.now)}<span class="meta why">${formatAgo(e.at, ctx.now)}</span></td>
<td>${activityKindWord(e.kind)}</td>
<td class="did">${describeActivity(e)}</td>
<td class="src">${ACTOR_SOURCE[e.actor] ?? e.actor}${e.runId === undefined ? '' : html`<span class="meta why">run ${e.runId}</span>`}</td></tr>`)}</tbody></table>`)}`
}

/**
 * The way a non-technical user reports a fault.
 *
 * The button is the whole feature: one press gathers the diagnostics (see core/support.ts) and prints
 * them here, in a block that one click selects whole (`.sel`), with a download of the same bytes beside
 * it. There is no clipboard button because there cannot be one - the CSP ships no JavaScript - so
 * "select it and copy it" has to be made easy by the markup instead of done for them by a script.
 *
 * The bundle is shown rather than merely offered, and the link to the file appears only once it has
 * been shown, because the person pressing this is about to send a file about their own mailbox to
 * somebody else: they get to read it first, in full, before there is anything to send.
 */
function supportPanel(bundle: string | undefined): Html {
  return html`<h2>Support</h2>
<p class="meta">If something here looks wrong, this gathers what the author needs to work out why: the versions, whether the background jobs are loaded, the counts, and the end of the logs. Your parcels themselves are left out — no tracking numbers, parcel names, shops, addresses, locker codes, mail subjects or senders, and never your mail address or your App Password. You can read the whole file below before you send it.</p>
<form method="post" action="/support"><button>Gather support bundle</button></form>${bundle === undefined ? '' : html`
<p>Select the text below and copy it, or <a href="/support.txt">download it as a file</a>, and send it to whoever is helping you.</p>
<pre class="sel bundle" id="support-bundle">${bundle}</pre>`}`
}

/**
 * What the Update section has to work with: the last check, and the last update attempt.
 *
 * Both are read per request from outside the database's parcel tables - the check from its own row,
 * the attempt from the file the detached updater writes - and both are optional, because a fresh
 * install has neither. See core/update.ts.
 */
export interface UpdateView {
  check?: StoredUpdateCheck
  run?: UpdateRun
  /** What `updateOutcome` makes of `run`: the page must not work that out a second way. */
  outcome?: UpdateOutcome
}

/** Whether an update is in flight, which is what hides the button and drives the reload loop. */
export const updateBusy = (u: UpdateView | undefined): boolean => u?.outcome === 'running'

/**
 * How an update that has already happened went. The one that matters is `rolled_back`: the build
 * broke, the checkout was put back, and the dashboard the reader is looking at is the proof that
 * worked - so it says so plainly rather than only reporting a failure.
 */
function updateResult(u: UpdateView, ctx: PageCtx): Html {
  const run = u.run
  if (!run) return html``
  const where = (sha: string | undefined) => (sha ? html`<b class="mono sel">${sha}</b>` : html`an unrecorded commit`)
  if (u.outcome === 'running') {
    return notice('busy', html`<p><strong>Updating.</strong> Fetching the new code, reinstalling and rebuilding, then restarting the two background jobs.</p>
<p class="meta">Started ${formatAgo(run.startedAt, ctx.now)}. This page updates itself until it finishes, and the dashboard may be unreachable for a few seconds near the end.</p>`, true)
  }
  if (u.outcome === 'abandoned') {
    return notice('warn', html`<p><strong>The update stopped answering.</strong> It began ${formatAgo(run.startedAt, ctx.now)} and never reported how it went.</p>
<p class="meta">What it was doing is at the end of <span class="mono">data/update.log</span>. The version below is what this page is actually running.</p>`, true)
  }
  if (u.outcome === 'ok') {
    return notice('neutral', html`<p><strong>Updated.</strong> Now running ${where(run.to)}, from ${where(run.from)}.</p>`, true)
  }
  if (u.outcome !== 'failed') return html``
  if (run.rollback === 'ok') {
    return notice('warn', html`<p><strong>The update did not finish, and was rolled back.</strong> The checkout was put back to ${where(run.from)} and rebuilt, so the dashboard is running exactly what it ran before.</p>
<p class="meta">Nothing was lost. The reason is at the end of <span class="mono">data/update.log</span>; gathering a support bundle below carries it.</p>`, true)
  }
  if (run.rollback === 'failed') {
    return notice('warn', html`<p><strong>The update failed and could not be rolled back.</strong> The checkout is at ${where(run.to)} and this needs a person at a terminal.</p>
<p class="meta">Gather a support bundle below and send it. Do not press Update again until somebody has looked.</p>`, true)
  }
  return notice('warn', html`<p><strong>The update was refused and nothing was installed.</strong> Still running ${where(run.from)}.</p>
<p class="meta">Why is at the end of <span class="mono">data/update.log</span>, and in the Update state below.</p>`, true)
}

/** The state sentence: what a check found, or that none has been made. */
function updateState(check: StoredUpdateCheck | undefined, ctx: PageCtx): Html {
  if (!check || check.state === 'unknown') {
    return html`<p>This copy has not been checked for updates yet. Press the button below, or leave it: the hourly background job checks once a day and tells you if there is anything.</p>`
  }
  const when = html`<span class="meta">Checked ${formatDateTime(check.checkedAt, ctx.now)} (${formatAgo(check.checkedAt, ctx.now)}).</span>`
  if (check.state === 'blocked') {
    return html`<p><strong>This copy cannot be updated from here.</strong> ${check.reason ?? 'No reason was given.'}</p><p>${when}</p>`
  }
  if (check.state === 'ahead') {
    return html`<p>This copy is <strong>ahead</strong> of ${check.upstream ?? 'its upstream'}: it has commits that are not published there, so there is nothing to install.</p><p>${when}</p>`
  }
  if (check.state === 'current') {
    return html`<p>This copy is <strong>up to date</strong> with ${check.upstream ?? 'its upstream'}.</p><p>${when}</p>`
  }
  return html`<p>There is a newer version: this copy is <strong>${check.behind} commit${check.behind === 1 ? '' : 's'} behind</strong> ${check.upstream ?? 'its upstream'}.</p><p>${when}</p>${
    check.changes.length === 0 ? '' : html`<p class="meta">What would change:</p>
<ul class="meta chg">${check.changes.map(line => html`<li class="mono">${line}</li>`)}</ul>`}`
}

/**
 * Updating the app from the dashboard, which is the whole point of this section: the alternative is a
 * terminal, and somebody who needs a terminal to update will simply never update.
 *
 * The button appears only when a check has actually found something to install - not when the copy is
 * up to date, not when it is somebody's own branch, and not when the directory is not a git checkout
 * at all, because in none of those cases is there anything for it to do. It is also hidden while an
 * update is going, so a second press cannot start a second one.
 *
 * There is deliberately no automatic update. What this button runs is code fetched from the internet
 * on a page with no authentication, so the one safeguard that matters is that a person pressed it:
 * the route is a POST behind the same Host and cross-site refusals as every other write here (see
 * `onRequest` in web/server.ts), and nothing on this page ever triggers it by being loaded.
 */
function updatePanel(version: string, u: UpdateView | undefined, ctx: PageCtx): Html {
  const view = u ?? {}
  const behind = view.check?.state === 'behind'
  return html`<h2>Update</h2>
<p class="meta">Where this copy of the app stands against the one it was installed from. Updating fetches the newer code, reinstalls its dependencies, rebuilds, and restarts the two background jobs; it takes a minute or two. If the new code does not build, the previous version is put back and rebuilt, so the dashboard always comes back.</p>
${updateResult(view, ctx)}
<p>Running <b class="mono sel">${version}</b>.</p>
${updateState(view.check, ctx)}
<div class="toolbar">${updateBusy(view) ? '' : html`<form method="post" action="/update/check"><button>Check for updates</button></form>${
    behind ? html`<form method="post" action="/update"><button>Update now</button></form>` : ''}`}</div>`
}

export function healthPage(
  rows: HealthRow[], ingest: { configured: boolean; status?: IngestStatus }, poller: PollerStatus, ctx: PageCtx,
  /** `0.1.0 (0db9a83)`, or `unknown`. Resolved once at startup; see core/version.ts. */
  version: string,
  /** The run log, newest first. Empty (and absent for a caller that has none) is a stated fact, not a gap. */
  runs: PollRun[] = [],
  /** The support bundle, when one has just been gathered. Absent on a plain view of the page. */
  support?: string,
  /** The activity log, newest first: status transitions and user actions. Empty is a stated fact. */
  activity: ActivityEntry[] = [],
  /** The Update section's two facts. Absent for a caller that has not gathered them. */
  update?: UpdateView,
): Html {
  const byCarrier = new Map(rows.map(r => [r.carrier, r]))
  const ids = Object.keys(CARRIER_NAME) as CarrierId[]
  const ing = ingest.status
  // The last-error column appears only when some row has an error: otherwise it is a column of dashes.
  const anyError = rows.some(r => r.lastErrorAt) || Boolean(ing?.lastErrorAt)
  const cols = anyError ? 4 : 3
  // An error followed by a later ok run has healed itself: it is history, not the state. It stays
  // readable (it is often the answer to "why did that parcel not update this morning?") but quiet,
  // so a green row does not sit next to what looks like a live fault.
  const err = (at: Date | undefined, detail: string | undefined, okAt: Date | undefined): Html => {
    if (!at) return html`<td class="meta">—</td>`
    const why = detail ? html`<span class="meta why">${detail}</span>` : ''
    return okAt && okAt > at
      ? html`<td class="recovered">${formatDateTime(at, ctx.now)} · recovered since${why}</td>`
      : html`<td>${formatDateTime(at, ctx.now)}${why}</td>`
  }
  const errCell = (at: Date | undefined, okAt: Date | undefined, detail?: string, kind?: string): Html => anyError
    ? err(at, [kind, detail].filter(Boolean).join(' · ') || undefined, okAt) : html``
  const ingestState = !ingest.configured ? state('nodata', 'not set up')
    : !ing ? state('nodata', 'no data')
    : ing.consecutiveFailures > 0 ? state('failing', 'failing', ing.consecutiveFailures) : state('ok', 'ok')
  // Mail not set up is a fact about this install, not a fault: no wash, and the way to set it up.
  const ingestBad = ingest.configured && ing !== undefined && ing.consecutiveFailures > 0
  const ingestLastOk = !ingest.configured
    ? html`never<span class="meta why"><a href="/settings">Connect Gmail in Settings</a></span>`
    : ing?.lastOkAt ? formatDateTime(ing.lastOkAt, ctx.now) : 'never'
  const pollState = !poller.lastPollAt ? state('nodata', 'no data') : poller.overdue ? state('attention', 'not running?') : state('ok', 'ok')

  return layout('Health', '/health', html`
<h1>Health</h1>
<p class="lede">${lede(byCarrier, ids, ingest.configured)}</p>
${scroller('Carrier and system health', html`<table class="board"><thead><tr><th scope="col">State</th><th scope="col">Name</th><th scope="col">Last ok</th>${anyError ? html`<th scope="col">Last error</th>` : ''}</tr></thead>
<tbody><tr class="grp"><th scope="rowgroup" colspan="${cols}">Carriers</th></tr>${ids.map(id => {
    // An email-only carrier is listed, because leaving it off would be its own small lie (the user
    // has parcels with it), but it is listed as what it is: never asked, so never ok and never broken.
    if (isEmailOnlyCarrier(id)) {
      return html`<tr data-carrier="${id}"><td>${state('email', 'by email')}</td><td>${CARRIER_NAME[id]}</td>
<td>not polled<span class="meta why">updates arrive by email</span></td>${anyError ? html`<td class="meta">—</td>` : ''}</tr>`
    }
    const h = byCarrier.get(id)
    return html`<tr data-carrier="${id}"${bad(h) ? html` class="bad"` : ''}><td>${verdict(h)}</td><td>${CARRIER_NAME[id]}</td>
<td>${h?.lastOkAt ? formatDateTime(h.lastOkAt, ctx.now) : 'never'}</td>${errCell(h?.lastErrorAt, h?.lastOkAt, h?.lastErrorDetail, h?.lastErrorKind)}</tr>`
  })}
<tr class="grp"><th scope="rowgroup" colspan="${cols}">System</th></tr>
<tr id="poller-health"${poller.overdue ? html` class="bad"` : ''}><td>${pollState}</td><td>Poller</td><td>${poller.lastPollAt ? formatDateTime(poller.lastPollAt, ctx.now) : 'never'}</td>${anyError ? html`<td class="meta">—</td>` : ''}</tr>
<tr id="ingest-health"${ingestBad ? html` class="bad"` : ''}><td>${ingestState}</td><td>Mail ingest</td>
<td>${ingestLastOk}</td>${errCell(ing?.lastErrorAt, ing?.lastOkAt, ing?.lastError)}</tr></tbody></table>`)}${
  poller.overdue ? html`<p class="meta">No poll has completed for over 2 hours of the 07:00-21:00 day. Parcels are not being updated: check that the launchd poller agent is loaded and that the Node path in its plist still exists.</p>` : ''}
${runsPanel(runs, ctx)}
${activityPanel(activity, ctx)}
${updatePanel(version, update, ctx)}
${supportPanel(support)}
<p class="meta" id="version">Version ${version}</p>`, ctx)
}
