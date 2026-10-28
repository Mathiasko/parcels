import { postcodeRejected, type Parcel } from '../../db/parcels.js'
import { isEmailOnlyCarrier } from '../../core/types.js'
import type { StoredEvent } from '../../db/events.js'
import type { RawResponse } from '../queries.js'
import {
  CARRIER_NAME, dayKey, formatClock, formatDateTime, formatDayHeading, isKnown, plural,
  quietIndicator, statusIndicator, toneClass,
} from './format.js'
import { STATUS_TITLE } from '../../notify/rules.js'
import { glyph } from './glyphs.js'
import { html, raw, type Html } from './html.js'
import { layout, notice, type PageCtx } from './layout.js'
import { mapsUrl, noDeadlineNote, parcelName, pickupClock, pickupCodeLine, pickupSummary, refreshBanner, type RefreshNote } from './index.js'
import type { TileGrid } from '../../core/slippy.js'

const RAW_SHOWN_CHARS = 20_000

/**
 * Delivered, returned and archived parcels are never polled, so offering to refresh them would be a
 * lie - and so is offering it for an email-only carrier (§6.7), which is never polled at all. The
 * button would start a run that asks nobody anything and come back saying it had refreshed.
 */
const isTracked = (p: Parcel): boolean =>
  p.archivedAt === undefined && p.status !== 'delivered' && p.status !== 'returned'
  && !isEmailOnlyCarrier(p.carrier)

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
  <input name="postcode" value="${p.postalCode ?? ''}" size="8" inputmode="numeric" aria-label="Postcode"><button>Save postcode</button></form>`
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

/**
 * The static map: a grid of cached tiles inside a fixed window, shifted so the pickup point lands dead
 * centre, with a marker over it. No JavaScript and no map library; the only moving part is the CSS
 * offset, which is why the arithmetic behind it (`src/core/slippy.ts`) is unit-tested on its own.
 *
 * Every `<img>` is a path on this server. The caller has already checked that each tile is on disk, so
 * nothing here can produce a broken image, and nothing here can produce a request to anyone else.
 *
 * The credit is not decoration: OpenStreetMap's licence requires visible attribution wherever its
 * data is shown, so it sits on the map itself and goes away only when the map does.
 */
function mapPanel(grid: TileGrid, where: string): Html {
  // Rounded to whole pixels: a sub-pixel offset blurs a raster tile, and the error is under half a pixel.
  const offset = `left:calc(50% - ${Math.round(grid.pointX)}px);top:calc(50% - ${Math.round(grid.pointY)}px);width:${grid.width}px;height:${grid.height}px;grid-template-columns:repeat(${grid.size},${grid.tileSize}px)`
  return html`<div class="map"><div class="map-f">
<div class="map-g" role="img" aria-label="Map of ${where}" style="${offset}">${grid.tiles.map(t =>
    html`<img src="/tile/${t.z}/${t.x}/${t.y}.png" alt="" width="${grid.tileSize}" height="${grid.tileSize}">`)}</div>
<span class="map-pin"></span>
<p class="map-c">© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a></p>
</div></div>`
}

/** The place, how long it has been waiting (or the deadline), and a Maps link only if the carrier gave coordinates. */
function pickupPanel(p: Parcel, last: StoredEvent | undefined, ctx: PageCtx, map?: TileGrid, code?: string): Html {
  const where = pickupSummary(p)
  if (!where) return html``
  const maps = mapsUrl(p)
  const ready = p.status === 'ready_for_pickup'
  // The dashboard's own clock line, so a deadline reads the same on both pages: a deadline whenever the
  // carrier gave one, else how long it has waited - which is only true while it is waiting.
  const { out: clock, urgency } = p.retainedTill || ready ? pickupClock({ parcel: p, last }, ctx.now) : { out: html``, urgency: 'none' }
  const note = ready ? noDeadlineNote([{ parcel: p, last }]) : ''
  return html`<section class="pk" aria-label="Pickup point"><div class="pk-h${ready ? '' : raw(' plain')}${ready && urgency === 'now' ? raw(' due-now') : ''}"><div class="where">${where}</div>${ready ? statusIndicator('ready_for_pickup') : html`<span class="meta">Pickup point</span>`}</div>
<div class="pk-b">${clock}${ready ? pickupCodeLine(code) : ''}${ready && map ? mapPanel(map, where) : ''}${note || maps ? html`<p class="meta">${note}${note && maps ? ' ' : ''}${maps ? html`<a href="${maps}">Open in Apple Maps <span aria-hidden="true">↗</span></a>` : ''}</p>` : ''}</div></section>`
}

/**
 * What the carriers actually sent, for whoever is diagnosing a wrong status. Closed by default under
 * "Technical details": an open heading of JSON above Delete told the owner it was something to read.
 */
function rawSection(raws: RawResponse[], ctx: PageCtx): Html {
  if (raws.length === 0) return html``
  return html`<details class="tech"><summary>Technical details</summary>
<p class="meta">What the carrier sent back, newest first.</p>${raws.map(r => html`<details>
  <summary>${formatDateTime(r.fetchedAt, ctx.now)}${r.carrierLevel ? ' · carrier-level (a failed batch of several parcels, not specific to this one)' : ''}</summary>
  <pre tabindex="0">${r.body.length > RAW_SHOWN_CHARS ? `${r.body.slice(0, RAW_SHOWN_CHARS)}\n... (${r.body.length - RAW_SHOWN_CHARS} more characters)` : r.body}</pre>
</details>`)}</details>`
}

/**
 * Deleting is irreversible and needs a confirm step, and with no JS there are two ways to get one: a
 * `GET /parcel/:id/delete` confirm page, or a disclosure here. The disclosure wins because the thing
 * being confirmed is already on screen - the name, the number, the timeline the user is about to lose -
 * so a confirm page would be a second route that re-renders what this page already shows, plus a way
 * back from it. It also keeps the action on the page that owns the parcel.
 *
 * Collapsed by default, last on the page, with the tertiary register the design language reserves for
 * actions that must not compete (design-language §6.7): no `--signal` (blue means "this needs you", never a destructive
 * action), no warn wash either - nothing is wrong here, it is simply final. The copy says exactly what
 * goes and what stays, because the emails staying is the non-obvious half.
 */
function deleteSection(p: Parcel): Html {
  return html`<details class="del">
  <summary>Delete this parcel</summary>
  <p>The parcel and its whole tracking history are deleted for good; there is no undo. The emails it came from are kept and simply unlinked, so the next mail check will not bring it back, and they will not turn up as something needing attention.</p>
  <form method="post" action="/parcel/${p.id}/delete"><button>Delete ${parcelName(p)}</button></form>
</details>`
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
  if (events.length === 0) {
    return quietIndicator(isEmailOnlyCarrier(p.carrier) ? 'Updates arrive by email' : 'No updates yet')
  }
  return html``
}

/** The status line's box, or nothing at all when the line is empty: an empty box is a gap in the page. */
const statusBox = (line: Html): Html => (line.toString() === '' ? html`` : html`<div class="status">${line}</div>`)

function timelineSection(p: Parcel, events: StoredEvent[], ctx: PageCtx): Html {
  if (events.length > 0) return html`<h2 class="sec">Timeline · ${plural(events.length, 'event')}</h2>${timeline(events, ctx)}`
  const why = p.archivedAt !== undefined
    ? (p.source === 'email' ? 'Found in old mail; never tracked.' : 'Archived; no tracking events were recorded.')
    // Not "nothing from the carrier yet": nobody is asking the carrier, so what is missing is mail.
    : isEmailOnlyCarrier(p.carrier) ? `No email about this parcel has arrived yet. ${CARRIER_NAME[p.carrier]} is never polled.`
    : 'Nothing from the carrier yet.'
  return html`<h2 class="sec">Timeline</h2><p class="empty">${why}</p>`
}

/**
 * `map` is the tile grid the server found in the cache for this parcel's pickup point, or undefined
 * when there is none to draw (no coordinates, a tile missing, or the preview turned off). The view
 * never looks at the disk itself: a page render reads the database and nothing else.
 */
export function parcelPage(
  p: Parcel, events: StoredEvent[], raws: RawResponse[], ctx: PageCtx, note?: RefreshNote, map?: TileGrid, code?: string,
): Html {
  const last = events.at(-1)
  const plain = postcodeRejected(p) || p.needsPostcode !== undefined
  return layout(parcelName(p), '', html`
<div class="cols"><div>
<div class="head"><h1 class="big">${parcelName(p)}</h1>
  ${isTracked(p) ? html`<form class="inline" method="post" action="/refresh"><input type="hidden" name="parcel" value="${p.id}"><button>Refresh this parcel</button></form>` : ''}</div>
${statusBox(statusLine(p, events))}
<p class="meta">${CARRIER_NAME[p.carrier]} · <span class="mono sel">${p.trackingNumber}</span>${p.merchant && p.merchant !== parcelName(p) ? html` · ${p.merchant}` : ''}${p.statusRaw ? html` · carrier says: ${p.statusRaw}` : ''}</p>${
  // Said on every email-only parcel, with or without events: it is why there is no refresh button and
  // why the timeline is whatever the mail said, which is not guessable from the page otherwise.
  isEmailOnlyCarrier(p.carrier) ? html`<p class="meta">Never polled: updates arrive by email, in ${CARRIER_NAME[p.carrier]}'s own words.</p>` : ''}
${refreshBanner(note, ctx.now, 'Asking the carrier about this parcel.')}${postcodeNotice(p)}${pickupPanel(p, last, ctx, map, code)}
${timelineSection(p, events, ctx)}
${rawSection(raws, ctx)}
${deleteSection(p)}
</div>
<aside class="side"><h3 class="sec">Name</h3>
<form class="inl" method="post" action="/parcel/${p.id}/label">
  <input name="label" value="${p.label ?? ''}" placeholder="e.g. Shoes from Zalando" aria-label="Name"><button>Save name</button></form>
${plain ? '' : html`<h3 class="sec">Postcode <span class="meta">(used by GLS and DPD)</span></h3>${postcodeForm(p)}`}
</aside></div>`, ctx)
}
