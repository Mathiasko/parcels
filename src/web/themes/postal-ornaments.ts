/**
 * Postal's ornaments: the mood board's stamps, badges, edges and postmark, drawn over the theme-neutral hooks
 * the views carry (`data-status`, `.code-plate[data-kind]`, the `.gp` glyph alternates and the `orn-*`
 * elements, which the base stylesheet hides). Static only: the motion is a later layer, so nothing here
 * animates. Every selector is scoped to Postal, so Classic never sees any of it.
 *
 * Board references are to `.superpowers/design/moodboards/1-postal-ephemera.html` (read-only).
 * Yellow (`--signal`) is only ever a fill; the text on it is `--on-signal`.
 */
import { svgUrl } from './svg-url.js'

const R = ':root[data-theme="postal"]'

/** The airmail stripes' repeat along their -45deg line, in px: the march (postal-motion.ts) moves them by exactly one. */
export const AIRMAIL_REPEAT = 32

/** The rubber stamp's opacity. Exported so the contrast test measures the ink as it is actually seen. */
export const RUBBER_OPACITY = 0.85

/**
 * A perforated edge (board `.perf`), for an element whose background is the stamp: a padding band of half a
 * hole pitch, and a mask of real holes, so the page shows through them. The holes sit on the element's
 * outer edge, one in each corner. The hole tile is laid from the content box with `round`, which stretches
 * the pitch a fraction so a whole number of holes fits each side, whatever the width the code gives the
 * stamp (the board's fixed 192px stamp did not need that). The second layer keeps the inside solid.
 */
const perforated = (pitch: string, radius: string): string =>
  `padding:calc(${pitch} / 2);mask:radial-gradient(circle,transparent ${radius},black calc(${radius} + .6px)) 0 0/${pitch} ${pitch} round content-box border-box,linear-gradient(black 0 0) content-box`

/** The rubber stamp's broken ink (board `.rubber`): fractal noise cut to a speckled alpha. */
const RUBBER_GRAIN = svgUrl("<svg xmlns='http://www.w3.org/2000/svg' width='120' height='40'><filter id='r'><feTurbulence baseFrequency='.9' numOctaves='2'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.2 1.9'/></filter><rect width='120' height='40' filter='url(#r)'/></svg>")

/** The paper stamps' shadow, and how the postmark's ink meets the page, per mode (the board's `.dk` values). */
const LIGHT_VARS = '--orn-stamp-shadow:drop-shadow(0 2px 2px rgba(60,40,10,.28)) drop-shadow(0 8px 12px rgba(60,40,10,.18));--orn-blend:multiply'
const DARK_VARS = '--orn-stamp-shadow:drop-shadow(0 2px 2px rgba(0,0,0,.5)) drop-shadow(0 8px 12px rgba(0,0,0,.4));--orn-blend:normal'

const BOX = `${R} .code-plate[data-kind=box]`
/** The counter and plain PINs, with `tail` after each (the stamp is the code itself). */
const pins = (tail: string): string => ['counter', 'plain'].map(k => `${R} .code-plate[data-kind=${k}]${tail}`).join(',')
const RUBBER_HEAD = `${R} .card-h:has(>.orn-rubber)`
const MARKED_NOTICE = `${R} .notice:has(>div>.orn-postmark)`
const MARKED_STATUS = `${R} .status:has(>.orn-postmark)`

export const POSTAL_ORNAMENTS = [
  `${R}{${LIGHT_VARS}}`,
  `${R}[data-mode="dark"]{${DARK_VARS}}`,
  `@media(prefers-color-scheme:dark){${R}[data-mode="system"]{${DARK_VARS}}}`,

  // Glyphs: the board's stamp, chevrons, voided ring, envelope and postmark ring (glyphs.ts `gp-`).
  `${R} .gc{display:none}`,
  `${R} .gp{display:inline}`,

  // Badges (board 140-160): each status keeps its word; its colour and its shape both change.
  // Ready: a solid yellow stamp, its top and bottom edges perforated.
  `${R} .b[data-status=ready_for_pickup]{height:1.625rem;padding:0 .6875rem 0 .5625rem;border-radius:0;background:radial-gradient(circle at 50% 0,transparent 1.8px,var(--signal) 2.3px) 0 0/6px 51% round no-repeat,radial-gradient(circle at 50% 100%,transparent 1.8px,var(--signal) 2.3px) 0 100%/6px 51% round no-repeat;background-origin:border-box}`,
  // Out for delivery: outlined in signal ink, a heavier rule, with the chevrons.
  `${R} .b[data-status=out_for_delivery]{border-width:1.5px}`,
  // Delivered, collected, received: a cancellation-blue ring, with the postmark glyph.
  `${R} .st[data-status=delivered],${R} .st[data-status=collected],${R} .st[data-status=received]{padding:.125rem .625rem .125rem .5rem;border-radius:999px;box-shadow:inset 0 0 0 1.5px currentColor}`,

  // Airmail (board .airmail, 52-56): an out-for-delivery card wears the red and blue chevrons on its top edge.
  `${R} .card[data-status=out_for_delivery]::before{content:"";position:absolute;top:0;left:0;right:0;height:6px;background:repeating-linear-gradient(-45deg,var(--warn) 0 10px,var(--surface) 10px 16px,var(--ok) 16px 26px,var(--surface) 26px ${AIRMAIL_REPEAT}px)}`,
  `${R} .card[data-status=out_for_delivery]>.card-h{padding-top:calc(.75rem + 4px)}`,
  // A failed attempt (board .failed, 217-223): a hatched warn edge down the left.
  `${R} .card[data-status=failed_attempt]::before{content:"";position:absolute;top:0;bottom:0;left:0;width:5px;background:repeating-linear-gradient(-45deg,var(--warn) 0 6px,transparent 6px 11px)}`,

  // The rubber stamp (board .rubber): in the header's flow, after the chip, so it never covers the chip or
  // the carrier's sentence. The header wraps instead of stacking, and the stamp keeps to the right edge:
  // beside the chip when they fit, on a row of its own under it when they do not (a phone, a long name).
  `${RUBBER_HEAD}{flex-direction:row;flex-wrap:wrap;column-gap:1rem;row-gap:.75rem}`,
  `${RUBBER_HEAD}>h2{flex:1 1 10rem}`,
  `${R} .orn-rubber{display:block;flex:none;margin:-.125rem 0 -.125rem auto;padding:.375rem .5rem;border:2px solid;border-radius:4px;color:var(--warn);font-family:var(--font-body);font-size:.75rem;font-weight:800;line-height:1;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap;opacity:${RUBBER_OPACITY};transform:rotate(-5deg);mask:${RUBBER_GRAIN}}`,

  // The box code plate (board .codestamp, 181-185): a perforated yellow stamp, its inner rule, the label
  // above, the code large, the place below. The stamp is the ::before, so the drop shadow on the plate
  // follows the perforation (a shadow on the masked element itself would be masked away). As wide as the
  // code needs, never wider than its column: on a phone the code is set a little smaller, so an 11-character
  // code still fits one line, and a longer one wraps in balanced halves rather than overflow.
  `${BOX}{--g:12px;position:relative;display:flex;flex-direction:column;align-items:center;gap:0;width:fit-content;min-width:12rem;max-width:100%;margin:1rem 0 .875rem .25rem;padding:calc(var(--g) / 2 + .875rem) calc(var(--g) / 2 + .875rem) calc(var(--g) / 2 + .75rem);color:var(--on-signal);text-align:center;transform:rotate(2deg);filter:var(--orn-stamp-shadow)}`,
  `${BOX}::before{content:"";position:absolute;inset:0;z-index:-1;background:var(--signal);box-shadow:inset 0 0 0 calc(var(--g) / 2 + 4px) var(--signal),inset 0 0 0 calc(var(--g) / 2 + 5.5px) currentColor;${perforated('var(--g)', '3.3px')}}`,
  `${BOX} .code-l{color:inherit;font-size:.625rem;font-weight:700;line-height:1.2;letter-spacing:.16em;text-transform:uppercase}`,
  `${BOX} b{margin:.375rem 0 .25rem;font-size:min(2.25rem,8.5vw);font-weight:700;line-height:1.05;letter-spacing:.04em;white-space:normal;overflow-wrap:anywhere;text-wrap:balance}`,
  `${BOX} .orn-place{display:block;font-family:var(--font-display);font-size:.8125rem;font-style:italic;line-height:1.1;letter-spacing:.02em}`,

  // The counter and plain PINs (board .pinstamp, 214-215): the code alone is a smaller stamp, tilted the
  // other way, beside its label. A counter names its place under the label, in the card's own ink, so the
  // stamp keeps its place beside the label at every width instead of the place line wrapping on its own.
  `${pins('')}{align-items:center;gap:.5rem .875rem;margin-top:.625rem}`,
  `${pins(' b')}{--g:9px;display:inline-block;max-width:100%;padding:calc(var(--g) / 2 + 7px) calc(var(--g) / 2 + 12px - .06em) calc(var(--g) / 2 + 6px) calc(var(--g) / 2 + 12px);color:var(--on-signal);font-size:1.5rem;font-weight:700;line-height:1;letter-spacing:.06em;white-space:normal;overflow-wrap:anywhere;text-wrap:balance;transform:rotate(-1.5deg);filter:var(--orn-stamp-shadow)}`,
  `${pins(' b::before')}{content:"";position:absolute;inset:0;z-index:-1;background:var(--signal);box-shadow:inset 0 0 0 calc(var(--g) / 2 + 3px) var(--signal),inset 0 0 0 calc(var(--g) / 2 + 4px) currentColor;${perforated('var(--g)', '2.4px')}}`,
  `${R} .code-plate[data-kind=counter] .orn-place{display:block;color:var(--ink-2);font-family:var(--font-display);font-size:.875rem;font-style:italic;line-height:1.25}`,
  `${R} .code-plate[data-kind=counter]:has(>.orn-place){display:grid;grid-template-columns:minmax(0,max-content) minmax(0,max-content);justify-content:start;row-gap:.125rem}`,
  `${R} .code-plate[data-kind=counter]:has(>.orn-place)>.code-l{grid-area:1/1;align-self:end}`,
  `${R} .code-plate[data-kind=counter]:has(>.orn-place)>b{grid-area:1/2/3/3}`,
  `${R} .code-plate[data-kind=counter]:has(>.orn-place)>.orn-place{grid-area:2/1;align-self:start}`,

  // The postmark (board .postmark, 186-199): cancellation ink, tilted -10 degrees; multiplied into the paper
  // in light, plain in dark. Decoration only, so it takes no pointer and no selection.
  `${R} .orn-postmark{display:block;position:absolute;width:var(--pm-w,9rem);height:calc(var(--pm-w,9rem) * 142 / 236);margin-top:calc(var(--pm-w,9rem) * -71 / 236);color:var(--ok);opacity:.9;transform:rotate(-10deg);mix-blend-mode:var(--orn-blend);pointer-events:none;-webkit-user-select:none;user-select:none}`,
  `${R} .orn-postmark svg{display:block;width:100%;height:100%;overflow:visible}`,
  // On a collected parcel's page: at the right end of the status line, like a postmark in an envelope's
  // corner, in room the line keeps free for it, so it never lands on Undo. Under every word on the page
  // (z-index -1, with no stacking context between it and the page), so it inks only the paper.
  `${MARKED_STATUS}{--pm-w:9rem;position:relative;padding-right:calc(var(--pm-w) + .5rem)}`,
  `${R} .status>.orn-postmark{top:50%;right:0;z-index:-1}`,
  // On the dashboard's "Marked … as collected" notice: in the notice's left part, where a notice's glyph
  // goes, clear of the Undo at the sentence's end. The cancellation lines fade out before the words start,
  // and anything left of them is under the words (the notice isolates it), so no letter is struck through.
  `${MARKED_NOTICE}{--pm-w:8rem;position:relative;isolation:isolate;padding-left:6.5rem}`,
  `${R} .notice .orn-postmark{top:50%;left:.25rem;z-index:-1;mask:linear-gradient(90deg,black 55%,transparent 88%)}`,
  // A phone: both smaller. The status line's postmark hangs into the frame's margin (never past the
  // viewport), so the line keeps room for "— marked by you ·" and Undo on one row.
  `@media(max-width:40rem){${MARKED_STATUS}{--pm-w:6rem;padding-right:calc(var(--pm-w) - 1rem)}${R} .status>.orn-postmark{right:-1.25rem}${MARKED_NOTICE}{--pm-w:6.5rem;padding-left:5.25rem}}`,

  // The empty dashboard's headline (board .empty h3, 257-262), above the sentence that says it in full.
  `${R} .orn-empty{display:block;margin:1.25rem 0 .375rem;color:var(--ink);font-family:var(--font-display);font-size:2.125rem;font-weight:400;line-height:1.1;text-wrap:balance}`,
].join('\n')
