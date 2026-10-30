import type { HealthRow } from '../../db/health.js'
import type { PollerStatus } from '../../core/pollwatch.js'
import { glyph } from './glyphs.js'
import { SPRITE } from './glyphs.js'
import { DEFAULT_APPEARANCE, type Appearance } from '../../core/appearance.js'
import { html, raw, type Html } from './html.js'
import { STYLE } from './style.js'

/** What every page needs beyond its own data: the clock the server uses, and carrier health for the lede and the nav dot. */
export interface PageCtx {
  now: Date
  health: HealthRow[]
  /**
   * When the poller last completed a run, and whether that is overdue (over two hours of the polling
   * day without one: every status shown may be stale). Read once per request, for every page.
   */
  poller?: PollerStatus
  /**
   * Emails waiting on /attention: not yet assigned or dismissed. The nav shows the number on every
   * page, and the index lede says it (and withholds its all-clear) while it is above zero. Absent
   * counts as none, which is what an error page whose database failed can honestly not show.
   */
  attention?: number
  /**
   * Seconds after which the page re-requests itself, set only while a poll run is in progress. This is
   * the no-JS way to show progress: a `<meta http-equiv="refresh">` on a page that re-renders itself
   * until the work is done. Absent is what ENDS the loop, so nothing may default it to a number - a run
   * that has finished, or is too old to still be going, leaves it out and the browser stops asking.
   */
  reloadIn?: number
  /**
   * Where the reload goes, when it is not this page: the "Restarting Parcels" page sends the browser
   * to the update section once the new app is likely to be answering. Only ever a path on this server.
   */
  reloadTo?: string
  /** The configured theme and mode, named on `<html>`; absent is the defaults. */
  appearance?: Appearance
}

/** A carrier that has failed its last run(s). The nav shows a dot for this and for nothing else (see design-language §5.1). */
export const carrierTrouble = (health: HealthRow[]): boolean => health.some(h => h.consecutiveFailures > 0)

const NAV = [
  ['/', 'In flight'], ['/history', 'History'], ['/attention', 'Attention'], ['/health', 'Health'],
  ['/settings', 'Settings'],
] as const

/**
 * The Attention item's count (design-language §5.1): the badge is what the eye finds, the hidden words
 * are what a screen reader says - "Attention, 2 emails waiting" - since "Attention 2" alone does not
 * say two of what, and with no separator the name ran together as "Attention2". Label and badge
 * share one span so the column-flex link keeps them on one line.
 */
function attentionLabel(label: string, waiting: number): Html {
  if (waiting <= 0) return html`${label}`
  return html`<span class="lb">${label}<span class="vh">, </span><span class="n">${String(waiting)}</span><span class="vh"> ${waiting === 1 ? 'email' : 'emails'} waiting</span></span>`
}

export function layout(title: string, current: string, body: Html, ctx: PageCtx): Html {
  const trouble = carrierTrouble(ctx.health)
  const waiting = ctx.attention ?? 0
  const a = ctx.appearance ?? DEFAULT_APPEARANCE
  return html`<!doctype html>
<html lang="en" data-theme="${a.theme}" data-mode="${a.mode}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${ctx.reloadIn ? html`<meta http-equiv="refresh" content="${ctx.reloadTo ? `${ctx.reloadIn};url=${ctx.reloadTo}` : ctx.reloadIn}">` : ''}<title>${title} - Parcels</title>
<style>${raw(STYLE)}</style></head>
<body>${SPRITE}<div class="frame">
<header><nav aria-label="Main"><a class="brand" href="/">Parcels</a>${NAV.map(([href, label]) =>
    html`<a href="${href}" data-t="${label}"${href === current ? raw(' aria-current="page"') : ''}>${href === '/attention' ? attentionLabel(label, waiting) : label}${href === '/health' && trouble ? html`<span class="dot"></span><span class="vh"> carrier problem</span>` : ''}</a>`)
  }<a class="add" href="/add" data-t="Add parcel"${current === '/add' ? raw(' aria-current="page"') : ''}>Add parcel</a></nav></header>
<main>${body}</main></div></body></html>
`
}

/**
 * The notice box. `warn` leads with the problem glyph; `busy` leads with the spinner, which is the one
 * place on the site anything moves, and is otherwise a neutral notice - a run in progress is progress,
 * not a demand, so it gets no colour at all. `role="status"` so a result is announced.
 */
export function notice(tone: 'neutral' | 'warn' | 'busy', content: Html, status = false, id?: string): Html {
  const mark = tone === 'warn' ? glyph('problem') : tone === 'busy' ? raw('<span class="spin"></span>') : ''
  return html`<div class="notice${tone === 'warn' ? raw(' warn') : ''}"${id ? html` id="${id}"` : ''}${status ? raw(' role="status"') : ''}>${mark}<div>${content}</div></div>`
}

/** A table that scrolls sideways on a narrow window instead of widening the page; focusable so a keyboard can scroll it. */
export const scroller = (label: string, content: Html): Html =>
  html`<div class="scroll" role="region" aria-label="${label}" tabindex="0">${content}</div>`
