import type { CarrierId } from '../../core/types.js'
import type { HealthRow } from '../../db/health.js'
import { CARRIER_NAME, formatDateTime } from './format.js'
import { html, type Html } from './html.js'
import { layout } from './layout.js'

/** `gated` means the adapter itself is broken (key rotated, endpoint closed): always an alarm while it persists. */
export const needsAttention = (h: HealthRow | undefined): boolean =>
  h !== undefined && h.lastErrorKind === 'gated' && h.consecutiveFailures > 0

function verdict(h: HealthRow | undefined): Html {
  if (!h) return html`<span class="muted">no data</span>`
  if (needsAttention(h)) return html`<span class="alarm-text">needs attention</span>`
  if (h.consecutiveFailures > 0) return html`<span>failing</span>`
  return html`<span>ok</span>`
}

export function healthPage(rows: HealthRow[]): Html {
  const byCarrier = new Map(rows.map(r => [r.carrier, r]))
  return layout('Health', '/health', html`
<h1>Carrier health</h1>
<table><tr><th>Carrier</th><th>State</th><th>Last ok</th><th>Last error</th><th>Consecutive failures</th></tr>${
  (Object.keys(CARRIER_NAME) as CarrierId[]).map(id => {
    const h = byCarrier.get(id)
    return html`<tr data-carrier="${id}"><td>${CARRIER_NAME[id]}</td><td>${verdict(h)}</td>
<td>${h?.lastOkAt ? formatDateTime(h.lastOkAt) : 'never'}</td>
<td>${h?.lastErrorAt ? html`${formatDateTime(h.lastErrorAt)} · ${h.lastErrorKind}${h.lastErrorDetail ? html`<br><span class="muted small">${h.lastErrorDetail}</span>` : ''}` : '—'}</td>
<td>${h?.consecutiveFailures ?? 0}</td></tr>`
  })}</table>`)
}
