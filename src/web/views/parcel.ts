import type { Parcel } from '../../db/parcels.js'
import type { StoredEvent } from '../../db/events.js'
import type { RawResponse } from '../queries.js'
import { CARRIER_NAME, formatDateTime, formatDay, statusChip } from './format.js'
import { html, type Html } from './html.js'
import { layout } from './layout.js'
import { parcelName, pickupSummary, refreshBanner, type RefreshNote } from './index.js'

const RAW_SHOWN_CHARS = 20_000

/** The carrier rejected this parcel's postcode, and it has not been changed since. */
export const postcodeRejected = (p: Parcel): boolean =>
  p.needsPostcode !== undefined && p.needsPostcode === (p.postalCode ?? '')

function mapsUrl(p: Parcel): string | undefined {
  const { lat, lon, name } = p.pickup ?? {}
  if (lat === undefined || lon === undefined) return undefined
  return `https://maps.apple.com/?ll=${lat},${lon}${name ? `&q=${encodeURIComponent(name)}` : ''}`
}

/**
 * Two carriers (Packeta, SPS) return prose-only events with no per-event code, so their older events
 * are legitimately `unknown`. A row of grey "unknown" chips would look like data loss, so such an
 * event shows only the carrier's own text. An unknown event that does carry a code is a genuinely
 * unmapped one and keeps its chip.
 */
const hasNoStatusInfo = (e: StoredEvent): boolean => e.code === undefined && e.status === 'unknown'

function timeline(events: StoredEvent[]): Html {
  if (events.length === 0) return html`<p class="muted">No tracking events yet.</p>`
  return html`<ol class="timeline" id="timeline">${events.map(e => html`<li>
  <time datetime="${e.occurredAt.toISOString()}">${formatDateTime(e.occurredAt)}</time>
  <div>${hasNoStatusInfo(e) ? '' : html`${statusChip(e.status)} `}${e.description}${e.location ? html` <span class="muted">· ${e.location}</span>` : ''}</div>
</li>`)}</ol>`
}

function postcodeSection(p: Parcel): Html {
  const form = html`<form class="inline" method="post" action="/parcel/${p.id}/postcode">
  <input name="postcode" value="${p.postalCode ?? ''}" size="8" aria-label="Postcode"> <button>Save postcode</button></form>`
  if (postcodeRejected(p)) {
    return html`<div class="notice alarm"><strong>The postcode ${p.postalCode ? `"${p.postalCode}"` : '(none was set)'} was rejected by the carrier.</strong>
  This parcel is tracked by status only, with no event history, until a correct postcode is saved here.<br>${form}</div>`
  }
  if (p.needsPostcode !== undefined) {
    return html`<div class="notice">The postcode was changed after the carrier rejected "${p.needsPostcode}"; it will be tried again at the next poll.<br>${form}</div>`
  }
  return html`<div class="small muted">Postcode (used by GLS and DPD): ${form}</div>`
}

function rawSection(raws: RawResponse[]): Html {
  if (raws.length === 0) return html``
  return html`<h2>Raw carrier responses</h2>${raws.map(r => html`<details>
  <summary>${formatDateTime(r.fetchedAt)}${r.carrierLevel ? ' · carrier-level (a failed batch of several parcels, not specific to this one)' : ''}</summary>
  <pre>${r.body.length > RAW_SHOWN_CHARS ? `${r.body.slice(0, RAW_SHOWN_CHARS)}\n... (${r.body.length - RAW_SHOWN_CHARS} more characters)` : r.body}</pre>
</details>`)}`
}

export function parcelPage(
  p: Parcel, events: StoredEvent[], raws: RawResponse[], note?: RefreshNote,
): Html {
  const pickup = pickupSummary(p)
  const maps = mapsUrl(p)
  return layout(parcelName(p), '', html`
<div class="row"><h1>${parcelName(p)}</h1>${statusChip(p.status)}
  <form class="inline" method="post" action="/refresh"><input type="hidden" name="parcel" value="${p.id}"><button>Refresh this parcel</button></form></div>
<p class="muted">${CARRIER_NAME[p.carrier]} · ${p.trackingNumber}${p.merchant ? html` · ${p.merchant}` : ''}${p.statusRaw ? html` · carrier says: ${p.statusRaw}` : ''}</p>
${refreshBanner(note)}
<form class="inline" method="post" action="/parcel/${p.id}/label">
  <input name="label" value="${p.label ?? ''}" placeholder="Label" aria-label="Label"> <button>Save label</button></form>
${postcodeSection(p)}
${pickup ? html`<h2>Pickup</h2><p>${pickup}${maps ? html` · <a href="${maps}">Open in Apple Maps</a>` : ''}
${p.retainedTill ? html`<br><strong>Collect by ${formatDay(p.retainedTill)}</strong>` : ''}</p>` : ''}
<h2>Timeline</h2>${timeline(events)}
${rawSection(raws)}`)
}
