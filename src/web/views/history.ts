import type { CarrierId } from '../../core/types.js'
import { isEmailOnlyCarrier } from '../../core/types.js'
import type { Parcel } from '../../db/parcels.js'
import type { UserMark } from '../../db/events.js'
import type { CarrierDeliveryStats } from '../queries.js'
import { CARRIER_NAME, formatDayMonth, formatDuration, quietIndicator, statusIndicator, userMarkIndicator, yearOf } from './format.js'
import { html, type Html } from './html.js'
import { layout, scroller, type PageCtx } from './layout.js'
import { parcelName } from './index.js'

export interface HistoryFilters { carrier?: string; q?: string; from?: string; to?: string }

/**
 * How many timed deliveries a carrier needs before its median is shown. With one or two, the "median"
 * is those parcels' own story (a weekend, a held parcel), not the carrier's, and printing it next to a
 * carrier with dozens of parcels reads as a fact about that carrier. Three is the least that can have a
 * middle that is not also an end.
 */
export const MIN_TIMED = 3

/** A carrier with enough timed deliveries: its median, and n beside it (ink-2: hiding n is the worse mistake). */
function statsRow(carrier: CarrierId, s: CarrierDeliveryStats & { medianMs: number }): Html {
  return html`<tr data-carrier="${carrier}"><td>${CARRIER_NAME[carrier]}</td><td class="d"><strong>${formatDuration(s.medianMs)}</strong></td>
<td class="t-2">n = ${s.measured} of ${s.delivered}</td></tr>`
}

const listed = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

/**
 * The per-carrier medians, for the carriers that have earned one; the rest are named in a sentence
 * instead of given rows of dashes. A carrier nobody polls (DHL) is said apart: nothing ever marks its
 * parcels delivered, so "not enough yet" would promise a number that cannot ever appear.
 */
function medianSection(stats: Map<CarrierId, CarrierDeliveryStats>, carriers: CarrierId[], marked: boolean): Html {
  const timed = carriers.flatMap(c => {
    const s = stats.get(c)
    return s && s.medianMs !== undefined && s.measured >= MIN_TIMED ? [{ c, s: s as CarrierDeliveryStats & { medianMs: number } }] : []
  })
  const shown = new Set(timed.map(t => t.c))
  const byEmail = carriers.filter(c => isEmailOnlyCarrier(c) && !shown.has(c)).map(c => CARRIER_NAME[c])
  const tooFew = carriers.filter(c => !isEmailOnlyCarrier(c) && !shown.has(c)).map(c => CARRIER_NAME[c])
  const few = tooFew.length === 0 ? ''
    : `Not enough deliveries yet to time ${timed.length === 0 ? 'any carrier' : listed(tooFew)}: a median needs at least ${MIN_TIMED} delivered parcels with a tracking history.`
  const email = byEmail.length === 0 ? ''
    : `${listed(byEmail)} ${byEmail.length === 1 ? 'is' : 'are'} not timed: ${byEmail.length === 1 ? 'its' : 'their'} updates arrive by email.`
  const note = [few, email].filter(Boolean).join(' ')
  return html`<h2>Median delivery time</h2>
<p class="meta">Per carrier across all delivered parcels, from its first scan to delivery. Parcels with no usable scan history are left out${
  marked ? ', and so are the ones you marked collected yourself (that is when you clicked, not when the carrier handed it over)' : ''}; n shows how many were measured.</p>
${timed.length === 0
    ? html`<p class="empty">${note}</p>`
    : html`${scroller('Median delivery time per carrier', html`<table class="stats"><thead><tr><th scope="col">Carrier</th><th scope="col" class="d">Median</th><th scope="col">Based on</th></tr></thead><tbody>${timed.map(t => statsRow(t.c, t.s))}</tbody></table>`)}${
      note ? html`<p class="meta">${note}</p>` : ''}`}`
}

/**
 * `collected` and `received` are parcels the user marked as theirs: finished, but not on the carrier's
 * word, so they are not called `Delivered` (and are left out of the medians below).
 */
type Outcome = 'delivered' | 'collected' | 'received' | 'returned' | 'archived'
type Marks = ReadonlyMap<number, Pick<UserMark, 'kind'>>
const outcomeOf = (p: Parcel, marks: Marks): Outcome =>
  (p.deliveredAt ? (marks.get(p.id)?.kind ?? 'delivered') : p.status === 'returned' ? 'returned' : 'archived')

/** The date a finished parcel sorts and is grouped by: delivery, return, or (archived mail) when it first appeared. */
const dateOf = (p: Parcel): Date => p.deliveredAt ?? (p.status === 'returned' ? (p.lastChangedAt ?? p.firstSeenAt) : p.firstSeenAt)

function outcomeCell(o: Outcome): Html {
  if (o === 'delivered' || o === 'returned') return statusIndicator(o)
  if (o === 'collected' || o === 'received') return userMarkIndicator(o)
  return quietIndicator('Archived')
}

function row(p: Parcel, marks: Marks): Html {
  const o = outcomeOf(p, marks)
  const name = parcelName(p)
  return html`<tr><td><a href="/parcel/${p.id}">${name}</a>${p.merchant && p.merchant !== name ? html`<span class="meta">${p.merchant}</span>` : ''}${name !== p.trackingNumber ? html`<span class="mono t-3 num">${p.trackingNumber}</span>` : ''}</td>
<td>${CARRIER_NAME[p.carrier]}</td>
<td>${outcomeCell(o)}</td>
<td class="d"><time datetime="${dateOf(p).toISOString()}">${formatDayMonth(dateOf(p))}</time></td></tr>`
}

/** "34 finished parcels: 1 delivered, 32 archived." Only the outcomes that exist are named. */
function lede(parcels: Parcel[], filtered: boolean, marks: Marks): string {
  const count = (o: Outcome) => parcels.filter(p => outcomeOf(p, marks) === o).length
  const parts = (['delivered', 'collected', 'received', 'returned', 'archived'] as const).map(o => [o, count(o)] as const).filter(([, n]) => n > 0).map(([o, n]) => `${n} ${o}`)
  return `${parcels.length} ${filtered ? 'matching' : 'finished'} ${parcels.length === 1 ? 'parcel' : 'parcels'}${parts.length ? `: ${parts.join(', ')}` : ''}.`
}

export function historyPage(
  parcels: Parcel[], stats: Map<CarrierId, CarrierDeliveryStats>, f: HistoryFilters, ctx: PageCtx, marks: Marks = new Map(),
): Html {
  const carriers = Object.keys(CARRIER_NAME) as CarrierId[]
  const filtered = Boolean(f.carrier || f.q || f.from || f.to)
  const years = [...new Set(parcels.map(p => yearOf(dateOf(p))))]
  const hasArchived = parcels.some(p => outcomeOf(p, marks) === 'archived')
  return layout('History', '/history', html`
<h1>History</h1>
${parcels.length === 0 ? '' : html`<p class="lede">${lede(parcels, filtered, marks)} Dates are delivery or return dates${hasArchived ? '; for archived mail, the day it first appeared' : ''}.</p>`}
<form method="get" action="/history" class="toolbar">
  <label class="grow">Search<input name="q" value="${f.q ?? ''}" placeholder="Shop, name or number"></label>
  <label>Carrier<select name="carrier"><option value="">All carriers</option>${carriers.map(id =>
    html`<option value="${id}"${f.carrier === id ? ' selected' : ''}>${CARRIER_NAME[id]}</option>`)}</select></label>
  <label>Date from<input type="date" name="from" value="${f.from ?? ''}"></label>
  <label>Date to<input type="date" name="to" value="${f.to ?? ''}"></label>
  <button>Filter</button>${filtered ? html`<a href="/history">Clear</a>` : ''}</form>
${parcels.length === 0
    ? html`<p class="empty">No delivered, returned or archived parcels${filtered ? ' match these filters' : ' yet'}.</p>`
    : scroller('Finished parcels', html`<table><thead><tr><th scope="col">Parcel</th><th scope="col">Carrier</th><th scope="col">Outcome</th><th scope="col" class="d">Date</th></tr></thead>${
        years.map(y => {
          const inYear = parcels.filter(p => yearOf(dateOf(p)) === y)
          return html`<tbody><tr class="yr"><th scope="rowgroup" colspan="4">${y} · ${inYear.length}</th></tr>${inYear.map(p => row(p, marks))}</tbody>`
        })}</table>`)}
${medianSection(stats, carriers, marks.size > 0)}`, ctx)
}
