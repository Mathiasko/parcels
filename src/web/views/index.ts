import { postcodeRejected, type Parcel } from '../../db/parcels.js'
import type { StoredEvent } from '../../db/events.js'
import type { CanonicalStatus } from '../../core/types.js'
import {
  calendarDaysBetween, CARRIER_NAME, formatDateTime, formatDay, isBadge, plural, statusIndicator, toneClass,
} from './format.js'
import { glyph } from './glyphs.js'
import { html, raw, type Html } from './html.js'
import { layout, notice, type PageCtx } from './layout.js'
import { STATUS_TITLE } from '../../notify/rules.js'

export const parcelName = (p: Parcel): string => p.label ?? p.merchant ?? p.trackingNumber

export function pickupSummary(p: Parcel): string | undefined {
  if (!p.pickup) return undefined
  const place = [p.pickup.name, p.pickup.street].filter(Boolean).join(', ')
  return [place, p.pickup.city].filter(Boolean).join(', ') || undefined
}

/** A Maps link only when the carrier gave coordinates: a link built from a name alone would be a guess. */
export function mapsUrl(p: Parcel): string | undefined {
  const { lat, lon, name } = p.pickup ?? {}
  if (lat === undefined || lon === undefined) return undefined
  return `https://maps.apple.com/?ll=${lat},${lon}${name ? `&q=${encodeURIComponent(name)}` : ''}`
}

/** The result of the last "refresh now" click, carried through the redirect as plain counters. */
export interface RefreshNote { polled: number; failures: number; busy: boolean }

export function refreshBanner(n: RefreshNote | undefined): Html {
  if (!n) return html``
  if (n.busy) return notice('neutral', html`<p>A refresh is already running; try again in a moment.</p>`, true)
  const note = n.polled === 0
    ? 'Nothing was polled: each parcel here is paused (its carrier is failing, or its postcode was rejected) or was tried under a minute ago.'
    : `Polled ${plural(n.polled, 'parcel')}.`
  if (n.failures === 0) return notice('neutral', html`<p>${note}</p>`, true)
  return notice('warn', html`<p><strong>${plural(n.failures, 'carrier failure')}.</strong> See <a href="/health">Health</a>.</p><p>${note}</p>`, true)
}

export interface Entry { parcel: Parcel; last: StoredEvent | undefined }

/** The time that put a parcel where it is: the status change, else the newest event. */
export const sinceOf = (e: Entry): Date | undefined => e.parcel.lastChangedAt ?? e.last?.occurredAt

const stamp = (e: Entry): number => (e.last?.occurredAt ?? e.parcel.firstSeenAt).getTime()
const newestFirst = (a: Entry, b: Entry): number => stamp(b) - stamp(a) || b.parcel.id - a.parcel.id

/** At most this many pickup places get a card; any further pickups fall back to compact rows. */
const MAX_PICKUP_CARDS = 4

// --- the pickup clock ------------------------------------------------------------------------------

type Urgency = 'none' | 'soon' | 'now'

/**
 * The line that tells you how long you have. Only Slovenská pošta ever sends a deadline, so for most parcels
 * this is the age of the pickup ("Since Mon 26 Oct, 17:19 · 3 days"), which is all we know. Relative counts
 * are never printed without the absolute date beside them: the page cannot refresh itself.
 */
function pickupClock(e: Entry, now: Date): { out: Html; urgency: Urgency } {
  const p = e.parcel
  if (p.retainedTill) {
    const d = calendarDaysBetween(now, p.retainedTill)
    const urgency: Urgency = d <= 0 ? 'now' : d <= 2 ? 'soon' : 'none'
    const rel = d < 0 ? 'deadline passed' : d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === 2 ? 'in 2 days' : `${d} days left`
    return {
      urgency,
      out: html`<p class="clock"><b class="due${urgency === 'now' ? raw(' due-now') : ''}">Collect by ${formatDay(p.retainedTill, now)}</b> · ${urgency === 'soon' ? html`<b>${rel}</b>` : html`<span class="t-2">${rel}</span>`}</p>`,
    }
  }
  const since = sinceOf(e)
  if (!since) return { urgency: 'none', out: html`` }
  const days = Math.floor((now.getTime() - since.getTime()) / 86_400_000)
  return { urgency: 'none', out: html`<p class="clock">Since ${formatDateTime(since, now)}${days >= 1 ? html` · <b>${plural(days, 'day')}</b>` : ''}</p>` }
}

const listNames = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

/** `Packeta gives no pickup deadline.` Stated, not omitted: otherwise the reader assumes there is no limit. */
export function noDeadlineNote(entries: Entry[]): string {
  const carriers = [...new Set(entries.filter(e => !e.parcel.retainedTill).map(e => e.parcel.carrier))]
  if (carriers.length === 0) return ''
  const names = carriers.map(c => CARRIER_NAME[c])
  return `${listNames(names)} ${names.length === 1 ? 'gives' : 'give'} no pickup deadline.`
}

// --- the page ---------------------------------------------------------------------------------------

function pickupCard(where: string, members: Entry[], ctx: PageCtx): Html {
  const clocks = members.map(m => pickupClock(m, ctx.now))
  const dueNow = clocks.some(c => c.urgency === 'now')
  const maps = members.map(m => mapsUrl(m.parcel)).find(u => u !== undefined)
  const note = noDeadlineNote(members)
  return html`<article class="pk">
<div class="pk-h${dueNow ? raw(' due-now') : ''}"><h2>${where}</h2>${statusIndicator('ready_for_pickup')}</div>
<ul class="pk-l">${members.map((m, i) => html`<li><h3><a href="/parcel/${m.parcel.id}">${parcelName(m.parcel)}</a></h3>
<span class="meta">${CARRIER_NAME[m.parcel.carrier]} · <span class="mono sel">${m.parcel.trackingNumber}</span></span>
${clocks[i]!.out}${postcodeRejected(m.parcel) ? html`<p class="meta t-warn">${glyph('problem')} Postcode needed: <a class="sel" href="/parcel/${m.parcel.id}">set one</a> to resume full tracking.</p>` : ''}</li>`)}</ul>
${note || maps ? html`<p class="pk-f meta">${note}${note && maps ? ' ' : ''}${maps ? html`<a href="${maps}">Open in Apple Maps ↗</a>` : ''}</p>` : ''}
</article>`
}

/** What a row says about the parcel, on its second line. The cause of an `unknown` status decides it (see §2.4). */
function rowLine(e: Entry, overflowPlace?: string): { glyphCol: Html; line: Html } {
  const { parcel: p, last } = e
  const sentence = last ? html`${last.description}${last.location ? html` <span class="loc">· ${last.location}</span>` : ''}` : undefined
  if (isBadge(p.status)) {
    // The badge carries the glyph, so the glyph column stays empty rather than repeat it.
    const body = p.status === 'ready_for_pickup' && overflowPlace ? html`${overflowPlace}` : sentence ?? html``
    return { glyphCol: html``, line: html`<div class="ev">${statusIndicator(p.status)}${body}</div>` }
  }
  if (p.status === 'unknown') {
    return sentence
      // For a prose-only carrier the sentence IS the status: promoted one colour step, with no word beside it.
      ? { glyphCol: html`<span class="gl t-3">${glyph('unknown')}</span>`, line: html`<div class="ev prose">${sentence}</div>` }
      : { glyphCol: html`<span class="gl t-3">${glyph('unknown')}</span>`, line: html`<div class="ev quiet">No updates yet</div>` }
  }
  return {
    glyphCol: html`<span class="gl ${toneClass(p.status)}">${glyph(p.status)}</span>`,
    line: html`<div class="ev">${statusWord(p.status)}${sentence ?? ''}</div>`,
  }
}

const statusWord = (s: CanonicalStatus): Html => html`<b>${STATUS_TITLE[s]}</b>`

function parcelRow(e: Entry, ctx: PageCtx, overflowPlace?: string): Html {
  const { parcel: p, last } = e
  const { glyphCol, line } = rowLine(e, overflowPlace)
  return html`<li class="row">${glyphCol}<h3><a href="/parcel/${p.id}">${parcelName(p)}</a><span class="meta">${CARRIER_NAME[p.carrier]} · <span class="mono sel">${p.trackingNumber}</span></span></h3>${line}${
    last ? html`<time datetime="${last.occurredAt.toISOString()}">${formatDateTime(last.occurredAt, ctx.now)}</time>` : ''}${
    postcodeRejected(p) ? html`<div class="meta t-warn full">Postcode needed: set one on the parcel page to resume full tracking.</div>` : ''}</li>`
}

/** The index lede: what is known, and a calm all-clear only when the data can support it. See design-language §5.2. */
export function indexLede(entries: Entry[], health: PageCtx['health']): string {
  const n = (pred: (e: Entry) => boolean) => entries.filter(pred).length
  const ready = n(e => e.parcel.status === 'ready_for_pickup')
  const ofd = n(e => e.parcel.status === 'out_for_delivery')
  const attn = n(e => e.parcel.status === 'failed_attempt' || e.parcel.status === 'problem')
  // An uncoded latest sentence is not "nothing": we cannot tell, and must say so rather than call it quiet.
  const unclassified = n(e => e.parcel.status === 'unknown' && e.last !== undefined)
  const carriers = new Set(entries.map(e => e.parcel.carrier))
  const failing = health.filter(h => h.consecutiveFailures > 0 && carriers.has(h.carrier)).map(h => CARRIER_NAME[h.carrier])
  const parts: string[] = []
  const act = [ready && `${ready} ready for pickup`, ofd && `${ofd} out for delivery`, attn && `${attn} ${attn === 1 ? 'needs' : 'need'} attention`].filter(Boolean)
  if (act.length) parts.push(`${act.join(', ')}.`)
  parts.push(`${entries.length} in flight.`)
  if (unclassified) parts.push(`${unclassified} ${unclassified === 1 ? 'has' : 'have'} no status; read ${unclassified === 1 ? 'its' : 'their'} latest message.`)
  if (failing.length) parts.push(`${listNames(failing)} ${failing.length === 1 ? 'is' : 'are'} failing, so this may be out of date.`)
  // The all-clear is earned: nothing waiting, nothing unreadable, and no carrier it depends on is broken.
  if (!act.length && !unclassified && !failing.length) parts.push('Nothing needs you.')
  return parts.join(' ')
}

export function indexPage(entries: Entry[], ctx: PageCtx, note?: RefreshNote): Html {
  const ACT_ORDER: Partial<Record<CanonicalStatus, number>> = { failed_attempt: 0, problem: 1, ready_for_pickup: 2, out_for_delivery: 3 }
  const ready = entries.filter(e => e.parcel.status === 'ready_for_pickup')
  const placed = new Map<string, Entry[]>()
  for (const e of ready) {
    const where = pickupSummary(e.parcel)
    if (where) placed.set(where, [...(placed.get(where) ?? []), e])
  }
  // Cards: by earliest deadline (those with one first), then by how long they have been waiting. Past the cap, rows.
  const earliest = (es: Entry[]) => Math.min(...es.map(e => e.parcel.retainedTill?.getTime() ?? Infinity))
  const oldest = (es: Entry[]) => Math.min(...es.map(e => sinceOf(e)?.getTime() ?? Infinity))
  const places = [...placed.entries()].sort(([, a], [, b]) => earliest(a) - earliest(b) || oldest(a) - oldest(b))
  const carded = new Set(places.slice(0, MAX_PICKUP_CARDS).flatMap(([, es]) => es.map(e => e.parcel.id)))

  const actRows = entries.filter(e => ACT_ORDER[e.parcel.status] !== undefined && !carded.has(e.parcel.id))
    .sort((a, b) => ACT_ORDER[a.parcel.status]! - ACT_ORDER[b.parcel.status]! || newestFirst(a, b))
  const rank = (e: Entry): number => {
    if (e.parcel.status === 'unknown') return e.last ? 0 : 3        // unclassified first, no events last
    if (e.parcel.status === 'returning') return 1
    return e.last ? 2 : 3
  }
  const rest = entries.filter(e => ACT_ORDER[e.parcel.status] === undefined)
    .sort((a, b) => rank(a) - rank(b) || newestFirst(a, b))

  const body = entries.length === 0
    ? html`<p class="empty">Nothing in flight. Parcels appear here when an email arrives or when you add one.</p>`
    : html`<p class="lede">${indexLede(entries, ctx.health)}</p>${refreshBanner(note)}${
        actRows.length ? html`<ul class="list">${actRows.map(e => parcelRow(e, ctx, pickupSummary(e.parcel)))}</ul>` : ''}${
        places.slice(0, MAX_PICKUP_CARDS).map(([where, es]) => pickupCard(where, es, ctx))}${
        rest.length ? html`<ul class="list">${rest.map(e => parcelRow(e, ctx))}</ul>` : ''}`
  return layout('In flight', '/', html`
<div class="col"><div class="head"><h1>In flight</h1>
  <form class="inline" method="post" action="/refresh"><button>Refresh now</button></form></div>
${entries.length === 0 ? refreshBanner(note) : ''}${body}</div>`, ctx)
}
