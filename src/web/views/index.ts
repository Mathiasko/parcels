import type { Parcel } from '../../db/parcels.js'
import type { StoredEvent } from '../../db/events.js'
import { CARRIER_NAME, formatDay, formatDateTime, statusChip } from './format.js'
import { html, type Html } from './html.js'
import { layout } from './layout.js'

export const parcelName = (p: Parcel): string => p.label ?? p.merchant ?? p.trackingNumber

export function pickupSummary(p: Parcel): string | undefined {
  if (!p.pickup) return undefined
  const place = [p.pickup.name, p.pickup.street].filter(Boolean).join(', ')
  return [place, p.pickup.city].filter(Boolean).join(', ') || undefined
}

/** The result of the last "refresh now" click, carried through the redirect as plain counters. */
export interface RefreshNote { polled: number; failures: number; busy: boolean }

export function refreshBanner(n: RefreshNote | undefined): Html {
  if (!n) return html``
  if (n.busy) return html`<p class="notice">A refresh is already running; try again in a moment.</p>`
  const note = n.polled === 0
    ? 'Nothing was due: parcels are polled less often as they go quiet, and a carrier that is failing is paused.'
    : `Polled ${n.polled} ${n.polled === 1 ? 'parcel' : 'parcels'}.`
  const failed = n.failures > 0 ? ` ${n.failures} carrier ${n.failures === 1 ? 'failure' : 'failures'}: see Health.` : ''
  return html`<p class="notice${n.failures > 0 ? ' alarm' : ' ok'}">${note}${failed}</p>`
}

export function indexPage(
  entries: { parcel: Parcel; last: StoredEvent | undefined }[], note?: RefreshNote,
): Html {
  const body = entries.length === 0
    ? html`<p class="muted">No parcels in flight.</p>`
    : entries.map(({ parcel: p, last }) => {
        const pickup = pickupSummary(p)
        return html`<div class="card">
  <div class="row"><h3><a href="/parcel/${p.id}">${parcelName(p)}</a></h3>${statusChip(p.status)}
    <span class="muted small">${CARRIER_NAME[p.carrier]} · ${p.trackingNumber}</span></div>
  ${last ? html`<div class="small muted">${formatDateTime(last.occurredAt)}: <span>${last.description}</span>${last.location ? html` · ${last.location}` : ''}</div>` : ''}
  ${pickup ? html`<div>Pickup: ${pickup}${p.retainedTill ? html` · <strong>Collect by ${formatDay(p.retainedTill)}</strong>` : ''}</div>` : ''}
  ${p.needsPostcode !== undefined && p.needsPostcode === (p.postalCode ?? '')
    ? html`<div class="alarm-text small">Postcode needed: <a href="/parcel/${p.id}">set one</a> to resume full tracking.</div>` : ''}
</div>`
      })
  return layout('In flight', '/', html`
<div class="row"><h1>In flight</h1>
  <form class="inline" method="post" action="/refresh"><button>Refresh now</button></form></div>
${refreshBanner(note)}${body}`)
}
