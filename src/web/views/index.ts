import { isDormant } from '../../core/backoff.js'
import { postcodeRejected, type Parcel } from '../../db/parcels.js'
import type { StoredEvent, UserMark } from '../../db/events.js'
import type { CanonicalStatus } from '../../core/types.js'
import { isEmailOnlyCarrier } from '../../core/types.js'
import {
  calendarDaysBetween, CARRIER_NAME, formatAgo, formatDateTime, formatDay, isKnown, plural, quietIndicator,
  statusIndicator,
} from './format.js'
import { glyph } from './glyphs.js'
import { html, raw, type Html } from './html.js'
import { layout, notice, type PageCtx } from './layout.js'
import { calendarForm, calendarNotice, calendarOffered, type CalendarFormState, type CalendarOutcome } from './calendar-form.js'

export { parcelName, pickupSummary } from '../../db/parcels.js'
import { parcelName, pickupSummary } from '../../db/parcels.js'

/** What the dashboard's "Refresh now" does, said while it is doing it. */
const REFRESH_DOES = 'Checking for new mail and asking the carriers for updates.'

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
 * The .ics fallback of "Add to Calendar", offered for exactly the parcels the form is (`calendarOffered`).
 * The route answers 404 for anything this returns undefined for, so a link and its target cannot disagree.
 */
export function calendarUrl(p: Parcel): string | undefined {
  return calendarOffered(p) ? `/parcel/${p.id}/calendar.ics` : undefined
}

/**
 * The line of facts under a pickup: that the carrier gave no deadline, and the Maps link. Empty when there
 * is nothing to say. One function for the dashboard card and the parcel page, so the two cannot drift.
 * "Add to Calendar" is not here: it belongs to one parcel, so it rides on that parcel's clock line.
 */
export function pickupFacts(note: string, maps: string | undefined): Html | undefined {
  if (!note && !maps) return undefined
  return html`${note}${note && maps ? ' ' : ''}${maps ? html`<a href="${maps}">Open in Apple Maps <span aria-hidden="true">↗</span></a>` : ''}`
}

/**
 * What the page says about a poll run: one still going, one that ended badly, or the counts of one that
 * finished. The counts come from the `poll_runs` row the refresh redirected to, never from the URL.
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
      : `${mail}Nothing was polled: each parcel here is paused (its carrier is failing, or its postcode was rejected), updated by email only, or was tried under a minute ago.`
  if (n.failures === 0) return notice('neutral', html`<p>${note}</p>`, true)
  return notice('warn', html`<p><strong>${plural(n.failures, 'carrier failure')}.</strong> See <a href="/health">Health</a>.</p><p>${note}</p>`, true)
}

export interface Entry {
  parcel: Parcel
  last: StoredEvent | undefined
  /** The Z-BOX opening code, when its mail carried one. */
  code?: string
  /** The event "Add to Calendar" already made, and a refused submission to show again. */
  cal?: CalendarFormState
}

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

/**
 * "Mark as collected", as a form because the page has no script. A quiet secondary button, never
 * `--signal`: the chip already says the parcel is waiting on you, and blue on the button as well would be
 * the second use that wears the colour out. Lifted above the card's stretched link (`.got`), so it takes
 * its own click and the rest of the card still opens the parcel.
 *
 * `back=home` brings the click back to the dashboard with the Undo notice; from the parcel page it
 * stays on the parcel page. The button's accessible name carries the parcel's name, because a card that
 * groups several parcels has several of these and "Mark as collected" alone would not say which.
 */
export function markForm(p: Parcel, label: string, back?: 'home'): Html {
  return html`<form class="got" method="post" action="/parcel/${p.id}/collected">${
    back ? html`<input type="hidden" name="back" value="${back}">` : ''}<button>${label}<span class="vh">: ${parcelName(p)}</span></button></form>`
}

/** The small Undo form a mark offers: a POST, the page has no script. */
export function undoForm(p: Parcel, back?: 'home'): Html {
  return html`<form class="undo-f" method="post" action="/parcel/${p.id}/uncollected">${
    back ? html`<input type="hidden" name="back" value="${back}">` : ''}<button class="link">Undo</button></form>`
}

/**
 * What the dashboard says after a parcel was marked from it: it has just left the page, so the page says
 * where it went and offers to put it back. The server shows this only for a parcel that really IS marked
 * right now, recently, so a bookmarked `?collected=` can neither replay a stale notice nor offer to
 * undo something that is no longer there.
 */
export function collectedNotice(c: { parcel: Parcel; mark: Pick<UserMark, 'kind'> } | undefined): Html {
  if (!c) return html``
  return notice('neutral', html`<div class="undo"><p>Marked <strong>${parcelName(c.parcel)}</strong> as ${c.mark.kind}. It is in <a href="/history">History</a>.</p>${undoForm(c.parcel, 'home')}</div>`, true)
}

/** The time that put a parcel where it is: the status change, else the newest event. */
export const sinceOf = (e: Entry): Date | undefined => e.parcel.lastChangedAt ?? e.last?.occurredAt

const stamp = (e: Entry): number => (e.last?.occurredAt ?? e.parcel.firstSeenAt).getTime()
const newestFirst = (a: Entry, b: Entry): number => stamp(b) - stamp(a) || b.parcel.id - a.parcel.id

// --- the pickup clock ------------------------------------------------------------------------------

export type Urgency = 'none' | 'soon' | 'now'

/**
 * The line that tells you how long you have. Only Slovenská pošta ever sends a deadline, so for most parcels
 * this is the age of the pickup ("Since Mon 26 Oct, 17:19 · 3 days"), which is all we know. Relative counts
 * are never printed without the absolute date beside them: the page cannot refresh itself.
 *
 * The parcel page prints this same line, so a deadline is worded one way wherever it appears.
 *
 * "Add to Calendar" (`cal`, the `<details>` from views/calendar-form.ts) rides at the end of this line,
 * with or without a deadline: the event is planned against this clock, and on a card holding several
 * parcels it is the one line that is unmistakably that parcel's. A `<details>` cannot live inside a `<p>`,
 * so with it the line becomes a `.cline` row holding the unchanged `<p class="clock">` and the
 * disclosure; opened, the disclosure takes a row of its own below (see `.calf` in style.ts).
 */
export function pickupClock(e: Entry, now: Date, cal?: Html): { out: Html; urgency: Urgency } {
  const { line, urgency } = clockLine(e, now)
  const form = cal && cal.toString() !== '' ? cal : undefined
  if (!form) return { urgency, out: line ? html`<p class="clock">${line}</p>` : html`` }
  return {
    urgency,
    out: html`<div class="cline">${line ? html`<p class="clock">${line}</p><span class="sep" aria-hidden="true">·</span>` : ''}${form}</div>`,
  }
}

function clockLine(e: Entry, now: Date): { line?: Html; urgency: Urgency } {
  const p = e.parcel
  if (p.retainedTill) {
    const d = calendarDaysBetween(now, p.retainedTill)
    const urgency: Urgency = d <= 0 ? 'now' : d <= 2 ? 'soon' : 'none'
    const rel = d < 0 ? 'deadline passed' : d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === 2 ? 'in 2 days' : `${d} days left`
    return {
      urgency,
      line: html`<b class="due${urgency === 'now' ? raw(' due-now') : ''}">Collect by ${formatDay(p.retainedTill, now)}</b> · ${urgency === 'soon' ? html`<b>${rel}</b>` : html`<span class="t-2">${rel}</span>`}`,
    }
  }
  const since = sinceOf(e)
  if (!since) return { urgency: 'none' }
  const days = Math.floor((now.getTime() - since.getTime()) / 86_400_000)
  return { urgency: 'none', line: html`Since ${formatDateTime(since, now)}${days >= 1 ? html` · <b>${plural(days, 'day')}</b>` : ''}` }
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

// --- the card --------------------------------------------------------------------------------------

/**
 * What one card is about. Every parcel in flight is on exactly one card, and there is only ONE card: the
 * same frame, the same header, the same body block, whether it holds one parcel or four. Before this,
 * a pickup with a place got a blue-headed card and everything else got a row, so two parcels that both
 * needed collecting could be rendered as different species - the row quieter, and ABOVE the card.
 *
 * The one grouping is the one the data earns: parcels waiting at the same pickup place are a single
 * errand ("go to Hlavna 6"), so they share a card headed by that place. Everything else is a card of
 * one, headed by the parcel's own name.
 */
interface Card {
  /** The heading: the pickup place when the card is an errand, else the parcel's own name. */
  head: string
  /** The heading is a place, so each body block still has to say which parcel it is. */
  placed: boolean
  members: Entry[]
}

/**
 * The cards, unsorted. A ready parcel joins the card of its pickup place when the carrier gave one; a
 * ready parcel with NO place gets a card of its own, headed by its name, exactly like every other
 * parcel - it is not demoted, which is what the row it used to fall into did to it.
 */
function buildCards(entries: Entry[]): Card[] {
  const places = new Map<string, Entry[]>()
  for (const e of entries) {
    const where = e.parcel.status === 'ready_for_pickup' ? pickupSummary(e.parcel) : undefined
    if (where) places.set(where, [...(places.get(where) ?? []), e])
  }
  const shared = new Set([...places.values()].flat().map(e => e.parcel.id))
  return [
    ...[...places].map(([head, members]) => ({ head, placed: true, members })),
    ...entries.filter(e => !shared.has(e.parcel.id))
      .map(e => ({ head: parcelName(e.parcel), placed: false, members: [e] })),
  ]
}

/**
 * Urgency, as bands. The four states that want something from you come first, in the order they want it.
 * `out_for_delivery` stays above a pickup because it is bound to TODAY (be home, or miss it), while a
 * pickup is bound to a deadline the card prints - the same reasoning that used to put Act rows above the
 * pickup cards, now that the density difference no longer says it.
 *
 * There is no cap on cards any more. `MAX_PICKUP_CARDS` existed because a card was a louder species than
 * a row, and four was as many as the first screenful could take; past the cap a pickup fell back to a
 * row. With one design there is nothing quieter to fall back INTO, and demoting the fifth place would
 * rebuild the two-species split this page has just lost.
 */
const ACT_ORDER: Partial<Record<CanonicalStatus, number>> = {
  failed_attempt: 0, problem: 1, out_for_delivery: 2, ready_for_pickup: 3,
}
/** The first quiet band, after the four that ask for something. */
const QUIET = 4

/** Within the quiet bands: unclassified first (it could be anything), then returning, then moving, then parcels with no events. */
const rank = (e: Entry): number => {
  if (e.parcel.status === 'unknown') return e.last ? 0 : 3
  if (e.parcel.status === 'returning') return 1
  return e.last ? 2 : 3
}

const band = (c: Card): number => ACT_ORDER[c.members[0]!.parcel.status] ?? QUIET + rank(c.members[0]!)

const earliestDue = (es: Entry[]): number => Math.min(...es.map(e => e.parcel.retainedTill?.getTime() ?? Infinity))
const longestWaiting = (es: Entry[]): number => Math.min(...es.map(e => sinceOf(e)?.getTime() ?? Infinity))

/**
 * Cards, in the order to deal with them. Inside a band: pickups by earliest deadline and then by longest
 * waiting (which errand to run first); everything else by newest event, which is what moved it. The id
 * breaks the last tie so the page cannot shuffle between two identical renders.
 */
function byUrgency(a: Card, b: Card): number {
  const bands = band(a) - band(b)
  if (bands !== 0) return bands
  // Two parcels with no deadline subtract to NaN, which is falsy, so that pair falls through to the age.
  const within = band(a) === ACT_ORDER.ready_for_pickup
    ? earliestDue(a.members) - earliestDue(b.members) || longestWaiting(a.members) - longestWaiting(b.members)
    : newestFirst(a.members[0]!, b.members[0]!)
  return within || b.members[0]!.parcel.id - a.members[0]!.parcel.id
}

/**
 * The chip, in the same place on every card: the state, and the only thing on the card allowed to carry
 * a hue. `--signal` rides here and nowhere else, so a card that needs nothing has no blue on it at all.
 *
 * `unknown` is the exception the data forces (see §2.4): with events the carrier's own sentence IS the
 * status, so the slot stays empty rather than print a word we cannot stand behind; with no events, what
 * is true is HOW an update would arrive.
 */
function cardChip(c: Card): Html {
  if (c.placed) return statusIndicator('ready_for_pickup')
  const e = c.members[0]!
  if (isKnown(e.parcel.status)) return statusIndicator(e.parcel.status)
  if (e.last) return html``
  return quietIndicator(isEmailOnlyCarrier(e.parcel.carrier) ? 'Updates arrive by email' : 'No updates yet')
}

/**
 * One body block: which parcel, then the lines that matter for the state it is in. The slots are the same
 * on every card, and each is filled only from data the parcel actually has - the carrier's latest
 * sentence, a deadline or how long it has been waiting, the locker code.
 *
 * The parcel's name is its link, and it is written once: in the block when the header is a place, and in
 * the header itself when the card is that one parcel (`cardHead`). Printing it in both would be the same
 * 15-17px label twice, two lines apart; History already drops a tracking number that its name repeats.
 */
function cardEntry(c: Card, e: Entry, ctx: PageCtx): Html {
  const p = e.parcel
  // Dropped only where the header and the chip have already said it: "ready for pickup at Z-BOX Hlavna 6".
  const sentence = c.placed || !e.last ? html``
    : html`<div class="ev${p.status === 'unknown' ? raw(' prose') : ''}">${e.last.description}${
      e.last.location ? html` <span class="loc">· ${e.last.location}</span>` : ''}</div>`
  return html`<li>${c.placed ? html`<h3 class="who"><a href="/parcel/${p.id}">${parcelName(p)}</a></h3>` : ''}
<span class="meta">${CARRIER_NAME[p.carrier]}${parcelName(p) === p.trackingNumber ? ''   // unnamed: its name IS the number
    : html` · <span class="mono sel">${p.trackingNumber}</span>`}</span>
${sentence}${pickupClock(e, ctx.now, calendarForm(p, ctx.now, e.cal, 'home')).out}${pickupCodeLine(e.code)}${postcodeRejected(p)
    ? html`<p class="meta t-warn">${glyph('problem')} Postcode needed: <a class="sel" href="/parcel/${p.id}">set one</a> to resume full tracking.</p>`
    : ''}${p.status === 'ready_for_pickup' ? markForm(p, 'Mark as collected', 'home') : ''}</li>`
}

/** The header: a place, said plainly, or the one parcel's name, which is then the card's link. */
const cardHead = (c: Card): Html =>
  c.placed ? html`<h2>${c.head}</h2>` : html`<h2><a href="/parcel/${c.members[0]!.parcel.id}">${c.head}</a></h2>`

/**
 * The card: one frame (border, radius, hairlines), one header (what it is about, and the chip), one body
 * of blocks, and a footer for the facts that belong to the PLACE rather than to any one parcel.
 *
 * The only paint the frame ever takes is `--warn-wash`, and only when a collection deadline is today or
 * already past: the one state that is allowed to interrupt. The filled blue header is gone - it was the
 * main reason a pickup card and a pickup row read as two different kinds of thing.
 */
function card(c: Card, ctx: PageCtx): Html {
  const dueNow = c.members.some(m => pickupClock(m, ctx.now).urgency === 'now')
  const ready = c.members.some(m => m.parcel.status === 'ready_for_pickup')
  const note = ready ? noDeadlineNote(c.members) : ''
  const maps = ready ? c.members.map(m => mapsUrl(m.parcel)).find(u => u !== undefined) : undefined
  const facts = pickupFacts(note, maps)
  return html`<article class="card">
<div class="card-h${dueNow ? raw(' due-now') : ''}">${cardHead(c)}${cardChip(c)}</div>
<ul class="card-l">${c.members.map(m => cardEntry(c, m, ctx))}</ul>${facts ? html`<p class="card-f meta">${facts}</p>` : ''}
</article>`
}

/**
 * The parcels that want something, as a clause of the in-flight total: "2 in flight, both ready for
 * pickup." They are counted INSIDE the total, never beside it - "2 ready for pickup. 2 in flight." was
 * read as four parcels.
 */
function inFlightClause(total: number, act: Array<{ n: number; one: string; many: string }>): string {
  const head = `${total} in flight`
  const present = act.filter(a => a.n > 0)
  if (present.length === 0) return `${head}.`
  // One kind, and it is every parcel: say "both"/"all" rather than repeat the number.
  if (present.length === 1 && present[0]!.n === total) {
    const a = present[0]!
    if (total === 1) return a.one.startsWith('needs') ? `${head}, and it ${a.one}.` : `${head}, ${a.one}.`
    return `${head}, ${total === 2 ? 'both' : 'all'} ${a.many}.`
  }
  return `${head}, ${listNames(present.map(a => `${a.n} ${a.n === 1 ? a.one : a.many}`))}.`
}

/**
 * Emails on /attention, which the ingest could not turn into a parcel. One of them can be a pickup
 * notice with a deadline (a persona test found exactly that, under "Nothing needs you."), so they are
 * said, with the way to them, and they forfeit the all-clear like any other thing waiting on the reader.
 */
const mailClause = (n: number): Html =>
  html`${String(n)} ${n === 1 ? 'email needs' : 'emails need'} a look (see <a href="/attention">Attention</a>).`

/** The index lede: what is known, and a calm all-clear only when the data can support it. See design-language §5.2. */
export function indexLede(entries: Entry[], ctx: PageCtx): Html {
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
  const overdue = ctx.poller?.overdue === true
  const act = ready + ofd + attn
  const parts: Array<Html | string> = [inFlightClause(entries.length, [
    { n: ready, one: 'ready for pickup', many: 'ready for pickup' },
    { n: ofd, one: 'out for delivery', many: 'out for delivery' },
    { n: attn, one: 'needs attention', many: 'need attention' },
  ])]
  const mail = ctx.attention ?? 0
  if (mail) parts.push(mailClause(mail))
  if (noPostcode) parts.push(`${noPostcode} ${noPostcode === 1 ? 'needs' : 'need'} a postcode.`)
  if (dormant) parts.push(html`${dormant} ${dormant === 1 ? 'is' : 'are'} no longer polled (see <a href="/attention">Attention</a>).`)
  if (unclassified) parts.push(`${unclassified} ${unclassified === 1 ? 'has' : 'have'} no status; read ${unclassified === 1 ? 'its' : 'their'} latest message.`)
  if (failing.length) parts.push(`${listNames(failing)} ${failing.length === 1 ? 'is' : 'are'} failing, so this may be out of date.`)
  // Said in plain words with the time it last looked: "the poller" is the name of a background job,
  // which is not something the person reading this should need to know exists.
  if (overdue) {
    const last = ctx.poller?.lastPollAt
    parts.push(html`Not checked ${last ? `since ${formatDateTime(last, now)}` : 'lately'}, so this may be out of date — see <a href="/health">Health</a>.`)
  }
  // The all-clear is earned: nothing waiting, nothing unreadable or unpolled, and nothing it depends on is broken.
  if (!act && !mail && !unclassified && !failing.length && !noPostcode && !dormant && !overdue) parts.push('Nothing needs you.')
  return html`${parts.flatMap((p, i) => (i === 0 ? [p] : [' ', p]))}`
}

/**
 * Said on the dashboard for as long as no mail account is saved: on a fresh install this is the one
 * step between "an empty page" and "parcels arrive by themselves", and the dashboard is where the
 * friend will be looking when they wonder why nothing has appeared.
 */
const MAIL_SETUP = html`<p><strong>Gmail is not connected yet.</strong></p>
<p>Once it is, parcels are added by themselves from your shipping emails. Connect it in <a href="/settings">Settings</a>; until then you can add parcels by their tracking number.</p>`

export interface IndexOptions {
  /** Whether a mail account is saved. False shows the "connect Gmail" notice. Absent counts as set up. */
  mailConfigured?: boolean
  /** A parcel just marked collected from this page: the notice with its Undo (see `collectedNotice`). */
  collected?: { parcel: Parcel; mark: Pick<UserMark, 'kind'> }
  /** What "Add to Calendar" just did, for the parcel it did it to (see `calendarNotice`). */
  calendar?: { outcome: CalendarOutcome; parcel: Parcel }
  /** An "Add to Calendar" submission refused for a parcel that no longer shows the form to say it in. */
  calendarRefused?: string
}

export function indexPage(entries: Entry[], ctx: PageCtx, note?: RefreshNote, opts: IndexOptions = {}): Html {
  const cards = buildCards(entries).sort(byUrgency)
  const mailOff = opts.mailConfigured === false
  // "When an email arrives" is a promise only a connected mailbox can keep.
  const empty = mailOff
    ? html`<p class="empty">Nothing in flight. <a href="/add">Add a parcel</a> by its tracking number.</p>`
    : html`<p class="empty">Nothing in flight. Parcels appear here when a shipping email arrives, or when you <a href="/add">add one</a>.</p>`
  const marked = html`${collectedNotice(opts.collected)}${calendarNotice(opts.calendar?.outcome, opts.calendar?.parcel, ctx.now)}${
    opts.calendarRefused ? notice('warn', html`<p>${opts.calendarRefused}</p>`, true) : ''}`
  // The lede is the page's first sentence, right under the h1, before any notice or banner. With
  // nothing in flight there is none ("0 in flight" says nothing), unless mail is waiting: that is the
  // one thing an empty dashboard must still say.
  const lede = entries.length > 0 ? html`<p class="lede">${indexLede(entries, ctx)}</p>`
    : ctx.attention ? html`<p class="lede">${mailClause(ctx.attention)}</p>` : ''
  return layout('In flight', '/', html`
<div class="col"><div class="head"><h1>In flight</h1>
  <form class="inline" method="post" action="/refresh"><button>Refresh now</button></form></div>
${lede}${mailOff ? notice('neutral', MAIL_SETUP, false, 'mail-setup') : ''}${refreshBanner(note, ctx.now, REFRESH_DOES)}${marked}${
  entries.length === 0 ? empty : cards.map(c => card(c, ctx))}</div>`, ctx)
}
