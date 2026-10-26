import type { CarrierId } from '../../core/types.js'
import type { Parcel } from '../../db/parcels.js'
import type { CarrierDeliveryStats } from '../queries.js'
import { CARRIER_NAME, formatDate, formatDuration } from './format.js'
import { html, type Html } from './html.js'
import { layout } from './layout.js'
import { parcelName } from './index.js'

export interface HistoryFilters { carrier?: string; q?: string; from?: string; to?: string }

function statsRow(carrier: CarrierId, s: CarrierDeliveryStats | undefined): Html {
  const name = CARRIER_NAME[carrier]
  if (!s) return html`<tr data-carrier="${carrier}"><td>${name}</td><td>—</td><td class="muted">no deliveries yet</td></tr>`
  if (s.medianMs === undefined) {
    return html`<tr data-carrier="${carrier}"><td>${name}</td><td>—</td>
<td class="muted">no measurable deliveries (n = 0 of ${s.delivered})</td></tr>`
  }
  return html`<tr data-carrier="${carrier}"><td>${name}</td><td>${formatDuration(s.medianMs)}</td>
<td class="muted">n = ${s.measured} of ${s.delivered}</td></tr>`
}

export function historyPage(parcels: Parcel[], stats: Map<CarrierId, CarrierDeliveryStats>, f: HistoryFilters): Html {
  const carriers = Object.keys(CARRIER_NAME) as CarrierId[]
  return layout('History', '/history', html`
<h1>History</h1>
<form method="get" action="/history" class="row">
  <select name="carrier" aria-label="Carrier"><option value="">All carriers</option>${carriers.map(id =>
    html`<option value="${id}"${f.carrier === id ? ' selected' : ''}>${CARRIER_NAME[id]}</option>`)}</select>
  <input name="q" value="${f.q ?? ''}" placeholder="Merchant, label or number" aria-label="Search">
  <input type="date" name="from" value="${f.from ?? ''}" aria-label="Delivered from">
  <input type="date" name="to" value="${f.to ?? ''}" aria-label="Delivered to">
  <button>Filter</button></form>
${parcels.length === 0
    ? html`<p class="muted">No delivered or archived parcels${f.carrier || f.q || f.from || f.to ? ' match these filters' : ' yet'}.</p>`
    : html`<table><tr><th>Parcel</th><th>Carrier</th><th>Merchant</th><th>Delivered / archived</th></tr>${parcels.map(p => html`<tr>
  <td><a href="/parcel/${p.id}">${parcelName(p)}</a></td><td>${CARRIER_NAME[p.carrier]}</td>
  <td>${p.merchant ?? ''}</td><td>${p.deliveredAt ? formatDate(p.deliveredAt) : html`<span class="muted">archived · ${formatDate(p.firstSeenAt)}</span>`}</td></tr>`)}</table>`}
<h2>Median delivery time</h2>
<p class="muted small">Per carrier across all delivered parcels, from its first scan to delivery. Parcels with no usable scan history are left out; n shows how many were measured.</p>
<table><tr><th>Carrier</th><th>Median</th><th>Based on</th></tr>${carriers.map(c => statsRow(c, stats.get(c)))}</table>`)
}
