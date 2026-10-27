import type { CarrierId } from '../../core/types.js'
import { isEmailOnlyCarrier } from '../../core/types.js'
import type { Parcel } from '../../db/parcels.js'
import type { CarrierDeliveryStats } from '../queries.js'
import { CARRIER_NAME, formatDayMonth, formatDuration, statusIndicator, yearOf } from './format.js'
import { html, type Html } from './html.js'
import { layout, scroller, type PageCtx } from './layout.js'
import { parcelName } from './index.js'

export interface HistoryFilters { carrier?: string; q?: string; from?: string; to?: string }

function statsRow(carrier: CarrierId, s: CarrierDeliveryStats | undefined): Html {
  const name = CARRIER_NAME[carrier]
  // A carrier nobody polls has no delivery to time: nothing marks its parcels delivered, so "no
  // deliveries yet" would promise a number that cannot ever appear.
  if (isEmailOnlyCarrier(carrier) && !s) {
    return html`<tr data-carrier="${carrier}"><td>${name}</td><td class="d">—</td><td class="meta">not timed: updates arrive by email</td></tr>`
  }
  if (!s) return html`<tr data-carrier="${carrier}"><td>${name}</td><td class="d">—</td><td class="meta">no deliveries yet</td></tr>`
  if (s.medianMs === undefined) {
    return html`<tr data-carrier="${carrier}"><td>${name}</td><td class="d">—</td>
<td class="meta">no measurable deliveries (n = 0 of ${s.delivered})</td></tr>`
  }
  // n is ink-2, not ink-3: hiding the sample size is the more dangerous mistake.
  return html`<tr data-carrier="${carrier}"><td>${name}</td><td class="d"><strong>${formatDuration(s.medianMs)}</strong></td>
<td class="t-2">n = ${s.measured} of ${s.delivered}</td></tr>`
}

type Outcome = 'delivered' | 'returned' | 'archived'
const outcomeOf = (p: Parcel): Outcome => (p.deliveredAt ? 'delivered' : p.status === 'returned' ? 'returned' : 'archived')

/** The date a finished parcel sorts and is grouped by: delivery, return, or (archived mail) when it first appeared. */
const dateOf = (p: Parcel): Date => p.deliveredAt ?? (p.status === 'returned' ? (p.lastChangedAt ?? p.firstSeenAt) : p.firstSeenAt)

function row(p: Parcel): Html {
  const o = outcomeOf(p)
  const name = parcelName(p)
  return html`<tr><td><a href="/parcel/${p.id}">${name}</a>${p.merchant && p.merchant !== name ? html`<span class="meta">${p.merchant}</span>` : ''}${name !== p.trackingNumber ? html`<span class="mono t-3 num">${p.trackingNumber}</span>` : ''}</td>
<td>${CARRIER_NAME[p.carrier]}</td>
<td>${o === 'delivered' ? statusIndicator('delivered') : o === 'returned' ? statusIndicator('returned') : ''}</td>
<td class="d"><time datetime="${dateOf(p).toISOString()}">${formatDayMonth(dateOf(p))}</time></td></tr>`
}

/** "34 finished parcels: 1 delivered, 32 archived." Only the outcomes that exist are named. */
function lede(parcels: Parcel[], filtered: boolean): string {
  const count = (o: Outcome) => parcels.filter(p => outcomeOf(p) === o).length
  const parts = (['delivered', 'returned', 'archived'] as const).map(o => [o, count(o)] as const).filter(([, n]) => n > 0).map(([o, n]) => `${n} ${o}`)
  return `${parcels.length} ${filtered ? 'matching' : 'finished'} ${parcels.length === 1 ? 'parcel' : 'parcels'}${parts.length ? `: ${parts.join(', ')}` : ''}.`
}

export function historyPage(parcels: Parcel[], stats: Map<CarrierId, CarrierDeliveryStats>, f: HistoryFilters, ctx: PageCtx): Html {
  const carriers = Object.keys(CARRIER_NAME) as CarrierId[]
  const filtered = Boolean(f.carrier || f.q || f.from || f.to)
  const years = [...new Set(parcels.map(p => yearOf(dateOf(p))))]
  const hasArchived = parcels.some(p => outcomeOf(p) === 'archived')
  return layout('History', '/history', html`
<h1>History</h1>
${parcels.length === 0 ? '' : html`<p class="lede">${lede(parcels, filtered)} Dates are delivery or return dates${hasArchived ? '; for archived mail, the day it first appeared' : ''}.</p>`}
<form method="get" action="/history" class="toolbar">
  <label class="grow">Search<input name="q" value="${f.q ?? ''}" placeholder="Merchant, label or number"></label>
  <label>Carrier<select name="carrier"><option value="">All carriers</option>${carriers.map(id =>
    html`<option value="${id}"${f.carrier === id ? ' selected' : ''}>${CARRIER_NAME[id]}</option>`)}</select></label>
  <label>Date from<input type="date" name="from" value="${f.from ?? ''}"></label>
  <label>to<input type="date" name="to" value="${f.to ?? ''}"></label>
  <button>Filter</button>${filtered ? html`<a href="/history">Clear</a>` : ''}</form>
${parcels.length === 0
    ? html`<p class="empty">No delivered, returned or archived parcels${filtered ? ' match these filters' : ' yet'}.</p>`
    : scroller('Finished parcels', html`<table><thead><tr><th scope="col">Parcel</th><th scope="col">Carrier</th><th scope="col">Outcome</th><th scope="col" class="d">Date</th></tr></thead>${
        years.map(y => {
          const inYear = parcels.filter(p => yearOf(dateOf(p)) === y)
          return html`<tbody><tr class="yr"><th scope="rowgroup" colspan="4">${y} · ${inYear.length}</th></tr>${inYear.map(row)}</tbody>`
        })}</table>`)}
<h2>Median delivery time</h2>
<p class="meta">Per carrier across all delivered parcels, from its first scan to delivery. Parcels with no usable scan history are left out; n shows how many were measured.</p>
${scroller('Median delivery time per carrier', html`<table class="stats"><thead><tr><th scope="col">Carrier</th><th scope="col" class="d">Median</th><th scope="col">Based on</th></tr></thead><tbody>${carriers.map(c => statsRow(c, stats.get(c)))}</tbody></table>`)}`, ctx)
}
