import { isDormant } from '../../core/backoff.js'
import { postcodeRejected, type Parcel } from '../../db/parcels.js'
import type { StoredEvent } from '../../db/events.js'
import type { CanonicalStatus } from '../../core/types.js'
import {
  calendarDaysBetween, CARRIER_NAME, formatAgo, formatDateTime, formatDay, isBadge, plural, statusIndicator,
  toneClass,
} from './format.js'
import { glyph } from './glyphs.js'
import { html, raw, type Html } from './html.js'
import { layout, notice, type PageCtx } from './layout.js'
import { STATUS_TITLE } from '../../notify/rules.js'

export const parcelName = (p: Parcel): string => p.label ?? p.merchant ?? p.trackingNumber

/** What the dashboard's "Refresh now" does, said while it is doing it. */
const REFRESH_DOES = 'Checking for new mail and asking the carriers for updates.'

export function pickupSummary(p: Parcel): string | undefined {
  if (!p.pickup) return undefined
  const place = [p.pickup.name, p.pickup.street].filter(Boolean).join(', ')
  return [place, p.pickup.city].filter(Boolean).join(', ') || undefined
}

/**
 * A Maps link for the pickup point. Coordinates are a pin and win when present, but only Packeta ever
 * sends them and not for every point, so insisting on them left the link off almost every parcel that
 * has somewhere to go. Without them the link is a SEARCH for the address instead: less precise, and
 * occasionally the wrong branch of a chain, but it gets you walking rather than leaving you to retype
 * the address by hand.
 *
 * The search text is exactly the string the panel displays, so the place you read is the place you open.
 */
export function mapsUrl(p: Parcel): string | undefined {
  const { lat, lon, name } = p.pickup ?? {}
  if (lat !== undefined && lon !== undefined) {
    return `https://maps.apple.com/?ll=${lat},${lon}${name ? `&q=${encodeURIComponent(name)}` : ''}`
  }
  // A postal address, not the place's name. Searching a name drags in the wrong branch of a chain, and a
  // name that embeds its city ahead of its street ("Z-BOX Bratislava, Hlavna 6") sends the search to
  // whichever town matches the street first. Only when there is no street at all is the name the best we have.
  const { street, city, postalCode } = p.pickup ?? {}
  const where = [postalCode, city].filter(Boolean).join(' ')
  const query = street ? [street, where].filter(Boolean).join(', ') : [name, where].filter(Boolean).join(', ')
  return query === '' ? undefined : `https://maps.apple.com/?q=${encodeURIComponent(query)}`
}

/**
 * What the page says about a poll run: one still going, one that ended badly, or the counts of one that
 * finished. The counts arrive either from the `poll_runs` row the refresh redirected to, or (for a link
 * typed or bookmarked from before) from the query string.
 */
export interface RefreshNote {
  polled: number
  failures: number
  busy: boolean
  /** The run is still going: when it started, so the page can say how long. No counters are known yet. */
  startedAt?: Date
  /** The run did not complete at all (the process died, or something threw that nothing caught). */
  error?: string
  /** New messages the mailbox yielded, and the parcels they became. Absent when no mail is configured. */
  read?: number
  created?: number
  /** How many parcels were in flight afterwards, which is what makes "nothing to poll" readable. */
  active?: number
}

/**
 * The result of a poll run, or the run itself while it is still going.
 *
 * `doing` is what this page's refresh actually does, supplied by the page because only it knows: the
 * dashboard button reads the mailbox as well as polling, the parcel button asks about one parcel. A
 * spinner on its own does not say whether something is stuck, so it never appears without this and
 * without how long the run has been going.
 */
export function refreshBanner(n: RefreshNote | undefined, now: Date, doing?: string): Html {
  if (!n) return html``
  if (n.busy) return notice('neutral', html`<p>A refresh is already running; try again in a moment.</p>`, true)
  // In progress. The spinner alone would not say whether anything is stuck, so it is paired with how
  // long the run has been going and with what the page will do next.
  if (n.startedAt) {
    return notice('busy', html`<p><strong>Refreshing.</strong>${doing ? html` ${doing}` : ''}</p>
<p class="meta">Started ${formatAgo(n.startedAt, now)}. This page updates itself until the run finishes.</p>`, true)
  }
  // A run that ended badly is the most important thing on the page: it means the numbers did not change.
  if (n.error) {
    return notice('warn', html`<p><strong>The refresh did not finish.</strong></p><p>${n.error}</p>
<p class="meta">See <a href="/health">Health</a> for the recent runs.</p>`, true)
  }
  // What the mailbox gave, when a mailbox is configured at all. Said first: on a new install this is
  // the only part that can do anything, and "0 parcels polled" otherwise reads as a failure.
  const created = n.created ?? 0
  const mail = n.read === undefined ? ''
    : created > 0 ? `Read ${plural(n.read, 'new email')} and added ${plural(created, 'parcel')}. `
    : n.read > 0 ? `Read ${plural(n.read, 'new email')}, none of which named a parcel. `
    : 'No new mail. '
  // "Every parcel is paused" is only true when there ARE parcels. On a fresh install there are none,
  // and claiming otherwise sends the reader looking for a problem that does not exist.
  const note = n.polled > 0
    ? `${mail}Polled ${plural(n.polled, 'parcel')}.`
    : n.active === 0
      ? `${mail}Nothing is in flight yet.`
      : `${mail}Nothing was polled: each parcel here is paused (its carrier is failing, or its postcode was rejected) or was tried under a minute ago.`
  if (n.failures === 0) return notice('neutral', html`<p>${note}</p>`, true)
  return notice('warn', html`<p><strong>${plural(n.failures, 'carrier failure')}.</strong> See <a href="/health">Health</a>.</p><p>${note}</p>`, true)
}

export interface Entry { parcel: Parcel; last: StoredEvent | undefined; /** The Z-BOX opening code, when its mail carried one. */ code?: string }

/**
 * The code that opens the locker, shown only when the mail actually carried one.
 *
 * There is deliberately no empty state: a staffed pickup point never has a code, because a person
 * hands the parcel over, so "no code" is the normal and permanent answer for those and saying so
 * would invent a problem. Rendered big, monospaced and selectable - it is read off the screen while
 * standing at the box, or copied, and a mis-read digit is a wasted trip.
 */
export function pickupCodeLine(code: string | undefined): Html {
  if (!code) return html``
  return html`<p class="code"><span class="code-l">Open the box with</span> <b class="mono sel">${code}</b></p>`
}

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
  // "gives no deadline" is a claim about the carrier, and it was wrong: Packeta sends one in `storedUntil`
  // and this app simply did not read it. What can honestly be said is what THIS response contained.
  return `${listNames(names)} did not give a pickup deadline.`
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
${clocks[i]!.out}${pickupCodeLine(m.code)}${postcodeRejected(m.parcel) ? html`<p class="meta t-warn">${glyph('problem')} Postcode needed: <a class="sel" href="/parcel/${m.parcel.id}">set one</a> to resume full tracking.</p>` : ''}</li>`)}</ul>
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
export function indexLede(entries: Entry[], ctx: PageCtx): string {
  const { health, now } = ctx
  const n = (pred: (e: Entry) => boolean) => entries.filter(pred).length
  const ready = n(e => e.parcel.status === 'ready_for_pickup')
  const ofd = n(e => e.parcel.status === 'out_for_delivery')
  const attn = n(e => e.parcel.status === 'failed_attempt' || e.parcel.status === 'problem')
  // An uncoded latest sentence is not "nothing": we cannot tell, and must say so rather than call it quiet.
  const unclassified = n(e => e.parcel.status === 'unknown' && e.last !== undefined)
  // States that are actionable but are not statuses: the poller will never ask about these parcels again
  // (a carrier-rejected postcode; dormancy), or has stopped asking about all of them. Each one must be
  // said, and each one forfeits the all-clear: a page that stopped learning cannot claim there is nothing to learn.
  const noPostcode = n(e => postcodeRejected(e.parcel))
  const dormant = n(e => isDormant(e.parcel, now))
  const carriers = new Set(entries.map(e => e.parcel.carrier))
  const failing = health.filter(h => h.consecutiveFailures > 0 && carriers.has(h.carrier)).map(h => CARRIER_NAME[h.carrier])
  const parts: string[] = []
  const act = [ready && `${ready} ready for pickup`, ofd && `${ofd} out for delivery`, attn && `${attn} ${attn === 1 ? 'needs' : 'need'} attention`].filter(Boolean)
  if (act.length) parts.push(`${act.join(', ')}.`)
  parts.push(`${entries.length} in flight.`)
  if (noPostcode) parts.push(`${noPostcode} ${noPostcode === 1 ? 'needs' : 'need'} a postcode.`)
  if (dormant) parts.push(`${dormant} ${dormant === 1 ? 'is' : 'are'} no longer polled (see Attention).`)
  if (unclassified) parts.push(`${unclassified} ${unclassified === 1 ? 'has' : 'have'} no status; read ${unclassified === 1 ? 'its' : 'their'} latest message.`)
  if (failing.length) parts.push(`${listNames(failing)} ${failing.length === 1 ? 'is' : 'are'} failing, so this may be out of date.`)
  if (ctx.pollerOverdue) parts.push('The poller has not run lately, so this may be out of date (see Health).')
  // The all-clear is earned: nothing waiting, nothing unreadable or unpolled, and nothing it depends on is broken.
  if (!act.length && !unclassified && !failing.length && !noPostcode && !dormant && !ctx.pollerOverdue) parts.push('Nothing needs you.')
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
    : html`<p class="lede">${indexLede(entries, ctx)}</p>${refreshBanner(note, ctx.now, REFRESH_DOES)}${
        actRows.length ? html`<ul class="list">${actRows.map(e => parcelRow(e, ctx, pickupSummary(e.parcel)))}</ul>` : ''}${
        places.slice(0, MAX_PICKUP_CARDS).map(([where, es]) => pickupCard(where, es, ctx))}${
        rest.length ? html`<ul class="list">${rest.map(e => parcelRow(e, ctx))}</ul>` : ''}`
  return layout('In flight', '/', html`
<div class="col"><div class="head"><h1>In flight</h1>
  <form class="inline" method="post" action="/refresh"><button>Refresh now</button></form></div>
${entries.length === 0 ? refreshBanner(note, ctx.now, REFRESH_DOES) : ''}${body}</div>`, ctx)
}
