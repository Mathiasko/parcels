import type { CarrierId } from '../../core/types.js'
import type { HealthRow } from '../../db/health.js'
import type { IngestStatus } from '../../db/ingest-status.js'
import type { PollerStatus } from '../../core/pollwatch.js'
import { CARRIER_NAME, formatDateTime } from './format.js'
import { glyph, type GlyphName } from './glyphs.js'
import { html, type Html } from './html.js'
import { layout, scroller, type PageCtx } from './layout.js'

/** `gated` means the adapter itself is broken (key rotated, endpoint closed): always an alarm while it persists. */
export const needsAttention = (h: HealthRow | undefined): boolean =>
  h !== undefined && h.lastErrorKind === 'gated' && h.consecutiveFailures > 0

/** A health state: its glyph, colour and weight carry it as well as the word, so no state is a coloured word alone. */
function state(kind: 'ok' | 'nodata' | 'failing' | 'attention', word: string, streak?: number): Html {
  const g: GlyphName = kind === 'ok' ? 'delivered' : kind === 'nodata' ? 'pre_transit' : 'problem'
  const tone = kind === 'ok' ? 't-ok' : kind === 'nodata' ? 't-3' : 't-warn'
  return html`<span class="st ${tone}${kind === 'ok' || kind === 'nodata' ? ' quiet' : ''}">${glyph(g)}${word}${streak ? html` · <span>${streak}</span> in a row` : ''}</span>`
}

function verdict(h: HealthRow | undefined): Html {
  if (!h) return state('nodata', 'no data')
  if (needsAttention(h)) return state('attention', 'needs attention', h.consecutiveFailures)
  if (h.consecutiveFailures > 0) return state('failing', 'failing', h.consecutiveFailures)
  return state('ok', 'ok')
}

const bad = (h: HealthRow | undefined): boolean => h !== undefined && h.consecutiveFailures > 0

/** `4 of 5 carriers reporting. SPS has never been polled.` It says "all" only when it counts all. */
function lede(rows: Map<CarrierId, HealthRow>, ids: CarrierId[]): string {
  const failing = ids.filter(id => bad(rows.get(id)))
  const never = ids.filter(id => !rows.has(id)).map(id => CARRIER_NAME[id])
  const ok = ids.length - failing.length - never.length
  const head = failing.length > 0
    ? `${failing.length} of ${ids.length} carriers failing.`
    : ok === ids.length ? `All ${ids.length} carriers reporting.` : `${ok} of ${ids.length} carriers reporting.`
  const tail = never.length > 0 ? ` ${never.join(' and ')} ${never.length === 1 ? 'has' : 'have'} never been polled.` : ''
  return head + tail
}

export function healthPage(
  rows: HealthRow[], ingest: { configured: boolean; status?: IngestStatus }, poller: PollerStatus, ctx: PageCtx,
  /** `0.1.0 (0db9a83)`, or `unknown`. Resolved once at startup; see core/version.ts. */
  version: string,
): Html {
  const byCarrier = new Map(rows.map(r => [r.carrier, r]))
  const ids = Object.keys(CARRIER_NAME) as CarrierId[]
  const showIngest = ingest.configured || ingest.status !== undefined
  const ing = ingest.status
  // The last-error column appears only when some row has an error: otherwise it is a column of dashes.
  const anyError = rows.some(r => r.lastErrorAt) || Boolean(ing?.lastErrorAt)
  const cols = anyError ? 4 : 3
  const err = (at: Date | undefined, detail?: string): Html => at
    ? html`<td>${formatDateTime(at, ctx.now)}${detail ? html`<span class="meta why">${detail}</span>` : ''}</td>` : html`<td class="meta">—</td>`
  const errCell = (at: Date | undefined, detail?: string, kind?: string): Html => anyError
    ? err(at, [kind, detail].filter(Boolean).join(' · ') || undefined) : html``
  const ingestState = !ing ? state('nodata', 'no data') : ing.consecutiveFailures > 0 ? state('failing', 'failing', ing.consecutiveFailures) : state('ok', 'ok')
  const pollState = !poller.lastPollAt ? state('nodata', 'no data') : poller.overdue ? state('attention', 'not running?') : state('ok', 'ok')

  return layout('Health', '/health', html`
<h1>Health</h1>
<p class="lede">${lede(byCarrier, ids)}</p>
${scroller('Carrier and system health', html`<table class="board"><thead><tr><th scope="col">State</th><th scope="col">Name</th><th scope="col">Last ok</th>${anyError ? html`<th scope="col">Last error</th>` : ''}</tr></thead>
<tbody><tr class="grp"><th scope="rowgroup" colspan="${cols}">Carriers</th></tr>${ids.map(id => {
    const h = byCarrier.get(id)
    return html`<tr data-carrier="${id}"${bad(h) ? html` class="bad"` : ''}><td>${verdict(h)}</td><td>${CARRIER_NAME[id]}</td>
<td>${h?.lastOkAt ? formatDateTime(h.lastOkAt, ctx.now) : 'never'}</td>${errCell(h?.lastErrorAt, h?.lastErrorDetail, h?.lastErrorKind)}</tr>`
  })}
<tr class="grp"><th scope="rowgroup" colspan="${cols}">System</th></tr>
<tr id="poller-health"${poller.overdue ? html` class="bad"` : ''}><td>${pollState}</td><td>Poller</td><td>${poller.lastPollAt ? formatDateTime(poller.lastPollAt, ctx.now) : 'never'}</td>${anyError ? html`<td class="meta">—</td>` : ''}</tr>${
  showIngest ? html`<tr id="ingest-health"${ing && ing.consecutiveFailures > 0 ? html` class="bad"` : ''}><td>${ingestState}</td><td>Mail ingest</td>
<td>${ing?.lastOkAt ? formatDateTime(ing.lastOkAt, ctx.now) : 'never'}</td>${errCell(ing?.lastErrorAt, ing?.lastError)}</tr>` : ''}</tbody></table>`)}${
  poller.overdue ? html`<p class="meta">No poll has completed for over 2 hours of the 07:00-21:00 day. Parcels are not being updated: check that the launchd poller agent is loaded and that the Node path in its plist still exists.</p>` : ''}
<p class="meta" id="version">Version ${version}</p>`, ctx)
}
