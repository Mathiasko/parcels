import type { HealthRow } from '../../db/health.js'
import { glyph } from './glyphs.js'
import { SPRITE } from './glyphs.js'
import { html, raw, type Html } from './html.js'
import { STYLE } from './style.js'

/** What every page needs beyond its own data: the clock the server uses, and carrier health for the lede and the nav dot. */
export interface PageCtx {
  now: Date
  health: HealthRow[]
  /** The poller has not completed a run for over two hours of the polling day: every status shown may be stale. */
  pollerOverdue?: boolean
}

/** A carrier that has failed its last run(s). The nav shows a dot for this and for nothing else (see design-language §5.1). */
export const carrierTrouble = (health: HealthRow[]): boolean => health.some(h => h.consecutiveFailures > 0)

const NAV = [
  ['/', 'In flight'], ['/history', 'History'], ['/attention', 'Attention'], ['/health', 'Health'],
  ['/settings', 'Settings'],
] as const

export function layout(title: string, current: string, body: Html, ctx: PageCtx): Html {
  const trouble = carrierTrouble(ctx.health)
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Parcels</title>
<style>${raw(STYLE)}</style></head>
<body>${SPRITE}<div class="frame">
<header><nav aria-label="Main"><b>Parcels</b>${NAV.map(([href, label]) =>
    html`<a href="${href}" data-t="${label}"${href === current ? raw(' aria-current="page"') : ''}>${label}${href === '/health' && trouble ? html`<span class="dot"></span><span class="vh"> carrier problem</span>` : ''}</a>`)
  }<a class="add" href="/add" data-t="Add parcel"${current === '/add' ? raw(' aria-current="page"') : ''}>Add parcel</a></nav></header>
<main>${body}</main></div></body></html>
`
}

/** The warn or neutral notice box; the leading glyph is only for warn. `role="status"` so a result is announced. */
export function notice(tone: 'neutral' | 'warn', content: Html, status = false): Html {
  return html`<div class="notice${tone === 'warn' ? raw(' warn') : ''}"${status ? raw(' role="status"') : ''}>${tone === 'warn' ? glyph('problem') : ''}<div>${content}</div></div>`
}

/** A table that scrolls sideways on a narrow window instead of widening the page; focusable so a keyboard can scroll it. */
export const scroller = (label: string, content: Html): Html =>
  html`<div class="scroll" role="region" aria-label="${label}" tabindex="0">${content}</div>`
