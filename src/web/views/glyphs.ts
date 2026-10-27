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

export const SPRITE: Html = raw(`<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false"><defs>${
  (Object.keys(SYMBOLS) as GlyphName[]).map(n => `<symbol id="g-${n}" viewBox="0 0 16 16">${SYMBOLS[n]}</symbol>`).join('')
}</defs></svg>`)

/** A status can come from the database; a value outside the closed set falls back to the neutral dot. */
export function glyph(name: GlyphName): Html {
  const id = name in SYMBOLS ? name : 'unknown'
  return html`<svg class="g" width="16" height="16" aria-hidden="true"><use href="#g-${id}"/></svg>`
}
