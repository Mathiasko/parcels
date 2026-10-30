import type { CanonicalStatus } from '../../core/types.js'
import { html, raw, type Html } from './html.js'

/**
 * The only icons on the site: ten status glyphs, drawn once per page as a zero-size sprite and
 * referenced with a same-document `<use href="#g-...">` (a fragment reference is not a fetch, so the
 * CSP's `default-src 'none'` does not touch it). Everything here is a constant; no data reaches it.
 */
export type GlyphName = CanonicalStatus

const RING = '<circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/>'
const SYMBOLS: Record<GlyphName, string> = {
  pre_transit: RING,
  in_transit: `${RING}<path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="currentColor"/>`,
  out_for_delivery: `${RING}<path d="M8 8V2.6a5.4 5.4 0 1 1-5.4 5.4z" fill="currentColor"/>`,
  ready_for_pickup: '<path fill="currentColor" d="M4 2h8a2 2 0 0 1 2 2v1.25H2V4a2 2 0 0 1 2-2zM2 6.75h12V12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/>',
  delivered: '<path fill-rule="evenodd" fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM4.6 8.2l1.1-1.1 1.5 1.5 3.1-3.2 1.1 1.1-4.2 4.3z"/>',
  failed_attempt: '<path fill-rule="evenodd" fill="currentColor" d="M8 1.2 14.8 8 8 14.8 1.2 8zM8 6.9 9.9 5 11 6.1 9.1 8 11 9.9 9.9 11 8 9.1 6.1 11 5 9.9 6.9 8 5 6.1 6.1 5z"/>',
  problem: '<path fill-rule="evenodd" fill="currentColor" d="M8 1.6 15 14H1zM7.2 6v4h1.6V6zM7.2 11v1.4h1.6V11z"/>',
  returning: '<path d="M6.25 3 3.25 6l3 3M3.5 6h6.25a3.25 3.25 0 0 1 0 6.5H7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  returned: `${RING}<path d="M7.4 5.4 5.4 7.4l2 2M5.6 7.4h3.2a1.9 1.9 0 0 1 0 3.8H7.6" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>`,
  unknown: '<circle cx="8" cy="8" r="2.25" fill="currentColor"/>',
}


/**
 * The Postal alternates (`gp-`), from the mood board's stamp, chevron, voided-ring, envelope and postmark
 * shapes. They keep the board's 24x24 drawing: a `<use>` scales the symbol's viewBox into the 16px svg, so
 * they need no redraw. The five statuses the board has no shape for reuse their Classic drawing. The
 * stamp's perforation mask lives in the sprite's `<defs>` under an id of its own.
 */
const POSTAL_MASK = '<mask id="gp-m-stamp" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect x="0" y="0" width="24" height="24" fill="#fff"/><g fill="#000">'
  + [3.5, 8.5, 12, 15.5, 20.5].map(x => `<circle cx="${x}" cy="3.5" r="1.25"/><circle cx="${x}" cy="20.5" r="1.25"/>`).join('')
  + [8.5, 12, 15.5].map(y => `<circle cx="3.5" cy="${y}" r="1.25"/><circle cx="20.5" cy="${y}" r="1.25"/>`).join('')
  + '</g><rect x="6.6" y="6.6" width="10.8" height="10.8" fill="none" stroke="#000" stroke-width="1.3"/></mask>'
const POSTAL: Partial<Record<GlyphName, string>> = {
  ready_for_pickup: '<rect x="3.5" y="3.5" width="17" height="17" fill="currentColor" mask="url(#gp-m-stamp)"/>',
  out_for_delivery: '<path d="M3.5 5.5 10 12l-6.5 6.5M12 5.5l6.5 6.5L12 18.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="miter"/>',
  failed_attempt: '<circle cx="12" cy="12" r="7.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M4 4l16 16M20 4 4 20" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/>',
  in_transit: '<rect x="3" y="6" width="18" height="12.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 7l8.5 6 8.5-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  delivered: '<circle cx="9" cy="12" r="6.3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="12" r="1.8" fill="currentColor"/><path d="M13 8.2q2.5-2 5 0t5 0M14.6 12q2-1.6 4.2 0t4.2 0M13 15.8q2.5-2 5 0t5 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
}

/**
 * The postmark's ring, from the mood board's `postmark`: two rough circles, the arc's words and the wavy
 * cancellation lines, drawn once here. The date and time differ per mark, so each postmark carries its
 * own two `<text>`s beside a `<use>` of this (see `postmark` in ornaments.ts). The board's town is
 * dropped from the arc, so the words are spaced out (`textLength`, a little short of the arc's 251) to
 * go all the way round instead of leaving a quarter of the ring bare. The filter and the arc path are
 * document-wide ids, so they are prefixed `pm-`.
 * The font is a theme token through an inline style, because an SVG presentation attribute cannot read
 * a custom property; `style-src 'unsafe-inline'` allows it.
 */
const POSTMARK_DEFS = '<filter id="pm-rough" x="-10%" y="-10%" width="120%" height="120%">'
  + '<feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7" result="t"/>'
  + '<feDisplacementMap in="SourceGraphic" in2="t" scale="2.6" result="d"/>'
  + '<feTurbulence type="fractalNoise" baseFrequency=".35" numOctaves="2" seed="3" result="s"/>'
  + '<feColorMatrix in="s" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.4 2.05" result="sm"/>'
  + '<feComposite in="d" in2="sm" operator="in"/></filter>'
  + '<path id="pm-arc" d="M20 60a40 40 0 1 1 80 0a40 40 0 1 1 -80 0"/>'
  + '<symbol id="postmark-ring" viewBox="0 0 236 142"><g filter="url(#pm-rough)" fill="none" stroke="currentColor">'
  + '<circle cx="60" cy="71" r="52" stroke-width="4"/><circle cx="60" cy="71" r="34" stroke-width="1.6"/>'
  + '<g transform="translate(0 11)"><text style="font-family:var(--font-body)" font-weight="800" font-size="12" letter-spacing="2.6" textLength="243" lengthAdjust="spacing" fill="currentColor" stroke="none">'
  + '<textPath href="#pm-arc" startOffset="0">PARCELS ✶ COLLECTED ✶</textPath></text></g>'
  + '<path d="M118 44q14-10 28 0t28 0t28 0t28 0M118 62q14-10 28 0t28 0t28 0t28 0M118 80q14-10 28 0t28 0t28 0t28 0M118 98q14-10 28 0t28 0t28 0t28 0" stroke-width="3.4" stroke-linecap="round"/>'
  + '</g></symbol>'

export const SPRITE: Html = raw(`<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false"><defs>${POSTAL_MASK}${POSTMARK_DEFS}${
  (Object.keys(SYMBOLS) as GlyphName[]).map(n => `<symbol id="g-${n}" viewBox="0 0 16 16">${SYMBOLS[n]}</symbol>`).join('')
}${
  (Object.keys(SYMBOLS) as GlyphName[]).map(n => {
    const p = POSTAL[n]
    return `<symbol id="gp-${n}" viewBox="${p === undefined ? '0 0 16 16' : '0 0 24 24'}">${p ?? SYMBOLS[n]}</symbol>`
  }).join('')
}</defs></svg>`)

/**
 * A status can come from the database; a value outside the closed set falls back to the neutral dot.
 * Two `<use>`s: Classic shows `.gc`, and the base CSS hides `.gp`; a theme swaps them (CSS cannot change a `<use href>`).
 */
export function glyph(name: GlyphName): Html {
  const id = name in SYMBOLS ? name : 'unknown'
  return html`<svg class="g" width="16" height="16" aria-hidden="true"><use class="gc" href="#g-${id}"/><use class="gp" href="#gp-${id}"/></svg>`
}
