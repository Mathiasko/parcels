import { postcodeRejected, type Parcel } from '../../db/parcels.js'
import type { StoredEvent } from '../../db/events.js'
import type { RawResponse } from '../queries.js'
import {
  calendarDaysBetween, CARRIER_NAME, dayKey, formatClock, formatDateTime, formatDay, formatDayHeading, isKnown, plural,
  quietIndicator, statusIndicator, toneClass,
} from './format.js'
import { STATUS_TITLE } from '../../notify/rules.js'
import { glyph } from './glyphs.js'
import { html, raw, type Html } from './html.js'
import { layout, notice, type PageCtx } from './layout.js'
import { mapsUrl, noDeadlineNote, parcelName, pickupSummary, refreshBanner, sinceOf, type RefreshNote } from './index.js'

const RAW_SHOWN_CHARS = 20_000

/** Delivered, returned and archived parcels are never polled, so offering to refresh them would be a lie. */
const isTracked = (p: Parcel): boolean =>
  p.archivedAt === undefined && p.status !== 'delivered' && p.status !== 'returned'

/**
 * The timeline, newest first. The query returns oldest first (ties by id), so reversing it gives
 * `occurred_at DESC, id DESC`. A *run* is consecutive rows of one known status; its head is the newest row,
 * the first one met reading down, and carries the glyph and the status word. When a run has more than one row,
 * a 2px bar in the status colour joins its members (and passes through any day heading between them), so a
 * row that is NOT part of the run above (an `unknown` row, say the carrier's "returned for expiry" directly
 * under "Delivered") is visibly outside it. `unknown` rows, coded or not (two carriers send prose with no
 * code, legitimately), are a plain dot and the carrier's own sentence: nothing that could read as an error.
 * A carrier's code is not shown; it is in a `title`.
 */
function timeline(events: StoredEvent[], ctx: PageCtx): Html {
  const shown = [...events].reverse()
  const same = (i: number, j: number): boolean => shown[j] !== undefined && isKnown(shown[i]!.status) && shown[i]!.status === shown[j]!.status
  let prevDay = ''
  return html`<ol class="tl" id="timeline">${shown.map((e, i) => {
    const day = dayKey(e.occurredAt)
    const joinedAbove = same(i, i - 1)
    const joinedBelow = same(i, i + 1)
    const head = isKnown(e.status) && !joinedAbove
    // A day heading sits inside a run when the row above it (newer) and this one share a status.
    const heading = day !== prevDay
      ? html`<li class="day${joinedAbove ? html` bar ${toneClass(e.status)}` : ''}">${formatDayHeading(e.occurredAt, ctx.now)}</li>` : ''
    prevDay = day
    const bar = joinedAbove || joinedBelow
    return html`${heading}<li class="er${i === 0 ? raw(' now') : ''}${i === shown.length - 1 ? raw(' last') : ''}${bar ? html` bar ${toneClass(e.status)}` : ''}${head && joinedBelow ? raw(' top') : ''}${bar && !joinedBelow ? raw(' end') : ''}">
<time datetime="${e.occurredAt.toISOString()}">${formatClock(e.occurredAt)}</time>
<span class="gl ${head ? toneClass(e.status) : 't-3 dotg'}">${glyph(head ? e.status : 'unknown')}</span>
<div class="tx"${e.code ? html` title="carrier code ${e.code}"` : ''}>${head ? html`<span class="w ${toneClass(e.status)}">${STATUS_TITLE[e.status]}</span>` : ''}${e.description}${e.location ? html` <span class="loc">· ${e.location}</span>` : ''}</div></li>`
  })}</ol>`
}

function postcodeForm(p: Parcel): Html {
  return html`<form class="inl" method="post" action="/parcel/${p.id}/postcode">
  <input name="postcode" value="${p.postalCode ?? ''}" size="8" aria-label="Postcode"><button>Save postcode</button></form>`
}

/** A rejected or just-changed postcode is a notice with the fix inside it; otherwise the form lives in the details column. */
function postcodeNotice(p: Parcel): Html {
  if (postcodeRejected(p)) {
    return notice('warn', html`<p><strong>The postcode ${p.postalCode ? `"${p.postalCode}"` : '(none was set)'} was rejected by the carrier.</strong></p>
<p>This parcel is tracked by status only, with no event history, until a correct postcode is saved here.</p>${postcodeForm(p)}`)
  }
  if (p.needsPostcode !== undefined) {
    return notice('neutral', html`<p>The postcode was changed after the carrier rejected "${p.needsPostcode}"; it will be tried again at the next poll.</p>${postcodeForm(p)}`)
  }
  return html``
}

/** The place, how long it has been waiting (or the deadline), and a Maps link only if the carrier gave coordinates. */
function pickupPanel(p: Parcel, last: StoredEvent | undefined, ctx: PageCtx): Html {
  const where = pickupSummary(p)
  if (!where) return html``
  const maps = mapsUrl(p)
  const ready = p.status === 'ready_for_pickup'
  const since = sinceOf({ parcel: p, last })
  const days = since ? Math.floor((ctx.now.getTime() - since.getTime()) / 86_400_000) : 0
  const left = p.retainedTill ? calendarDaysBetween(ctx.now, p.retainedTill) : undefined
  const clock = p.retainedTill
    ? html`<p class="clock"><b class="due${left! <= 0 ? raw(' due-now') : ''}">Collect by ${formatDay(p.retainedTill, ctx.now)}</b> · <span class="t-2">${left! < 0 ? 'deadline passed' : left === 0 ? 'today' : left === 1 ? 'tomorrow' : `${left} days left`}</span></p>`
    : ready && since
      ? html`<p class="clock">Since ${formatDateTime(since, ctx.now)}${days >= 1 ? html` · <b>${plural(days, 'day')}</b>` : ''}</p>` : ''
  const note = ready ? noDeadlineNote([{ parcel: p, last }]) : ''
  return html`<section class="pk" aria-label="Pickup point"><div class="pk-h${ready ? '' : raw(' plain')}${ready && left !== undefined && left <= 0 ? raw(' due-now') : ''}"><div class="where">${where}</div>${ready ? statusIndicator('ready_for_pickup') : html`<span class="meta">Pickup point</span>`}</div>
<div class="pk-b">${clock}${note || maps ? html`<p class="meta">${note}${note && maps ? ' ' : ''}${maps ? html`<a href="${maps}">Open in Apple Maps ↗</a>` : ''}</p>` : ''}</div></section>`
}

function rawSection(raws: RawResponse[], ctx: PageCtx): Html {
  if (raws.length === 0) return html``
  return html`<h2>Raw carrier responses</h2>${raws.map(r => html`<details>
  <summary>${formatDateTime(r.fetchedAt, ctx.now)}${r.carrierLevel ? ' · carrier-level (a failed batch of several parcels, not specific to this one)' : ''}</summary>
  <pre tabindex="0">${r.body.length > RAW_SHOWN_CHARS ? `${r.body.slice(0, RAW_SHOWN_CHARS)}\n... (${r.body.length - RAW_SHOWN_CHARS} more characters)` : r.body}</pre>
</details>`)}`
}

/**
 * The status line depends on why a status is or is not shown. A known status gets its indicator. An `unknown` one
 * with events shows nothing: the timeline's first row is the status. Without events, an archived parcel says so
 * and a live one says it has had no updates; never "yet" about a parcel that will not change.
 */
function statusLine(p: Parcel, events: StoredEvent[]): Html {
  // A parcel waiting at a known place says so in the pickup panel's header; saying it twice is noise.
  if (p.status === 'ready_for_pickup' && pickupSummary(p)) return html``
  if (isKnown(p.status)) return statusIndicator(p.status)
  if (p.archivedAt !== undefined) return quietIndicator('Archived')
  if (events.length === 0) return quietIndicator('No updates yet')
  return html``
}

function timelineSection(p: Parcel, events: StoredEvent[], ctx: PageCtx): Html {
  if (events.length > 0) return html`<h2 class="sec">Timeline · ${plural(events.length, 'event')}</h2>${timeline(events, ctx)}`
  const why = p.archivedAt !== undefined
    ? (p.source === 'email' ? 'Found in old mail; never tracked.' : 'Archived; no tracking events were recorded.')
    : 'Nothing from the carrier yet.'
  return html`<h2 class="sec">Timeline</h2><p class="empty">${why}</p>`
}

export function parcelPage(
  p: Parcel, events: StoredEvent[], raws: RawResponse[], ctx: PageCtx, note?: RefreshNote,
): Html {
  const last = events.at(-1)
  const plain = postcodeRejected(p) || p.needsPostcode !== undefined
  return layout(parcelName(p), '', html`
<div class="cols"><div>
<div class="head"><h1 class="big">${parcelName(p)}</h1>
  ${isTracked(p) ? html`<form class="inline" method="post" action="/refresh"><input type="hidden" name="parcel" value="${p.id}"><button>Refresh this parcel</button></form>` : ''}</div>
<div class="status">${statusLine(p, events)}</div>
<p class="meta">${CARRIER_NAME[p.carrier]} · <span class="mono sel">${p.trackingNumber}</span>${p.merchant && p.merchant !== parcelName(p) ? html` · ${p.merchant}` : ''}${p.statusRaw ? html` · carrier says: ${p.statusRaw}` : ''}</p>
${refreshBanner(note)}${postcodeNotice(p)}${pickupPanel(p, last, ctx)}
${timelineSection(p, events, ctx)}
${rawSection(raws, ctx)}
</div>
<aside class="side"><h3 class="sec">Label</h3>
<form class="inl" method="post" action="/parcel/${p.id}/label">
  <input name="label" value="${p.label ?? ''}" placeholder="Label" aria-label="Label"><button>Save label</button></form>
${plain ? '' : html`<h3 class="sec">Postcode <span class="meta">(used by GLS and DPD)</span></h3>${postcodeForm(p)}`}
</aside></div>`, ctx)
}
