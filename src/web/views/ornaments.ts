import { DateTime } from 'luxon'
import type { CarrierId, PickupPoint } from '../../core/types.js'
import { CARRIER_NAME } from './format.js'
import { html, type Html } from './html.js'

/**
 * Helpers for the theme-neutral ornament hooks. Every `orn-*` element is `aria-hidden` and hidden by the
 * base stylesheet, so Classic never shows one; a theme that wants them styles them. None of them says
 * anything the page does not already say in text.
 */

/** How a code is used at its place: opened at a box, shown at a counter, or claiming nothing. */
export function codeKind(k: PickupPoint['kind'] | undefined): 'box' | 'counter' | 'plain' {
  return k === 'zbox' || k === 'locker' ? 'box'
    : k === 'parcelshop' || k === 'post_office' ? 'counter'
    : 'plain'
}

/** The short name of the kind of place, for the plate's small print. None when the kind is unknown. */
export function placeName(k: PickupPoint['kind'] | undefined): string | undefined {
  return k === 'zbox' ? 'Z-BOX'
    : k === 'locker' ? 'Box'
    : k === 'parcelshop' ? 'ParcelShop'
    : k === 'post_office' ? 'Post office'
    : undefined
}

/** `<Place> · <Carrier>`, or nothing when there is no place name or no carrier to put after it. */
export function placeLine(k: PickupPoint['kind'] | undefined, carrier: CarrierId | undefined): Html {
  const place = placeName(k)
  if (!place || !carrier) return html``
  return html`<span class="orn-place" aria-hidden="true">${place} · ${CARRIER_NAME[carrier]}</span>`
}

const RUBBER_MAX_WORDS = 3
const RUBBER_MAX_CHARS = 24
const RUBBER_FALLBACK = 'Not delivered'

/** The carrier's own words when they are short enough to stamp (at most 3 words and 24 characters). */
export function rubberText(description: string): string {
  const words = description.trim().split(/\s+/).filter(Boolean)
  const text = words.join(' ')
  return words.length === 0 || words.length > RUBBER_MAX_WORDS || text.length > RUBBER_MAX_CHARS ? RUBBER_FALLBACK : text
}

/** The stamp on a failed card, from its single parcel's latest event. */
export function rubberStamp(description: string | undefined): Html {
  return html`<span class="orn-rubber" aria-hidden="true">${rubberText(description ?? '')}</span>`
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']

/** A postmark's date as `6·XI·26` (day, Roman month, two-digit year) and its time as `14:05`, in `zone`. */
export function postmarkDate(at: Date, zone: string): { date: string; time: string } {
  const t = DateTime.fromJSDate(at, { zone })
  return { date: `${t.day}·${ROMAN[t.month - 1]}·${String(t.year % 100).padStart(2, '0')}`, time: t.toFormat('HH:mm') }
}
