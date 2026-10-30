/**
 * Postal's motion (board 305-350): the postmark slam and the dip it gives its notice or status line, the
 * cards dealt in, a just-arrived code inking in, the airmail edge marching, a hovered card lifting and a
 * pressed button going down. CSS only, as the pages have no JavaScript; the one-shot moments are the
 * `just-collected` and `just-arrived` markers the server puts on the page right after the event.
 *
 * All of it is one `prefers-reduced-motion:no-preference` block, so with reduced motion nothing here
 * applies and the page is exactly the static ornaments (postal-ornaments.ts). Every keyframe ends on those
 * static values: the ornaments that rest tilted (the postmark, the PIN stamps) are animated through the
 * `translate`/`scale`/`rotate` properties, which add to their `transform` instead of replacing it, and their
 * keyframes have no 100% step, so the end is whatever the static rules say.
 */
import { AIRMAIL_REPEAT } from './postal-ornaments.js'

const R = ':root[data-theme="postal"]'
const STAMPED = '.orn-postmark.just-collected'

/** What each motion animates, after the scope. */
const CARD = '.card'
const AIRMAIL = '.card[data-status=out_for_delivery]::before'
const INKED = '.card.just-arrived .code-plate b'
const LANDED_ON = [`.notice:has(>div>${STAMPED})`, `.status:has(>${STAMPED})`]
const ANIMATED = [CARD, AIRMAIL, INKED, STAMPED, ...LANDED_ON]
/** `animation:none` on every animated element, each selector prefixed by `scope`. */
const still = (scope: string): string => `${ANIMATED.map(sel => `${scope} ${sel}`).join(',')}{animation:none}`

/** Deal-in: each card 60ms after the one before, up to the sixth; the rest come with the sixth. */
const DEAL_STEP_MS = 60
const DEAL_STAGGERED = 6

/** The airmail stripes repeat every AIRMAIL_REPEAT px along their -45deg line, so every this many px across. */
const AIRMAIL_ACROSS = `${(AIRMAIL_REPEAT * Math.SQRT2).toFixed(4)}px`

const MOTION = [
  // The slam (board `slam`): the postmark lands from above, big and blurred, overshoots and settles. Its
  // rotate adds to the resting rotate(-10deg): -26deg at the start, -9 and -10.5 on the way, as on the board.
  `@keyframes slam{0%{opacity:0;translate:-14px -34px;scale:2.3;rotate:-16deg;filter:blur(3px)}55%{opacity:.95;translate:0 0;scale:.93;rotate:1deg;filter:blur(0)}72%{scale:1.03;rotate:-.5deg}}`,
  `${R} ${STAMPED}{animation:slam .55s cubic-bezier(.3,0,.4,1) both}`,
  // On the parcel page the postmark ends near the frame's edge (on a phone it hangs into the frame's
  // margin), so its 2.3x start would reach past the viewport and give the page a sideways scroll for a
  // moment. The frame clips sideways instead: at its padding edge, past the resting postmark, and `clip`
  // makes no scroll container.
  `${R} .frame:has(.status>${STAMPED}){overflow-x:clip}`,
  // The thud (board `thud`): what the postmark lands on dips 3px as it hits. By `top` (both are
  // position:relative), not a transform: a transform, filter or opacity would make the status line a
  // stacking context and lift the parcel page's postmark (z-index -1) over the words.
  `@keyframes thud{0%,50%{top:0}58%{top:3px}74%{top:-1px}100%{top:0}}`,
  `${LANDED_ON.map(sel => `${R} ${sel}`).join(',')}{animation:thud .55s ease-out}`,

  // The deal (board `deal`): once per load, the cards slide in one after another. The hover lift below uses
  // `translate` and `rotate`, so it adds to the deal's `transform` rather than fighting it.
  `@keyframes deal{0%{opacity:0;transform:translate(-40px,-6px) rotate(-6deg)}}`,
  `${R} ${CARD}{animation:deal .5s cubic-bezier(.2,.8,.2,1) ${DEAL_STAGGERED * DEAL_STEP_MS}ms both;transition:translate .2s ease-out,rotate .2s ease-out}`,
  ...Array.from({ length: DEAL_STAGGERED }, (_, i) => `${R} .card:nth-child(${i + 1} of .card){animation-delay:${(i + 1) * DEAL_STEP_MS}ms}`),
  `@media(hover:hover){${R} .card:hover{translate:0 -3px;rotate:-.8deg}}`,

  // The ink settle (board `inkin`): a code that has just arrived inks in, a moment after its card. A PIN's
  // <b> is the stamp itself and rests with a drop shadow, which the blur is laid over rather than replacing.
  `@keyframes inkin{0%{opacity:0;filter:var(--orn-ink-filter,) blur(3px);scale:1.12}60%{opacity:1;filter:var(--orn-ink-filter,) blur(0);scale:.98}}`,
  `${R} .code-plate[data-kind=counter] b,${R} .code-plate[data-kind=plain] b{--orn-ink-filter:var(--orn-stamp-shadow)}`,
  `${R} ${INKED}{animation:inkin .5s .25s cubic-bezier(.3,0,.3,1) both}`,

  // The march (board `march`): the airmail chevrons run along the top edge three times, then stop. A -45deg
  // gradient's stripes hang from the image's bottom-right corner, so the stripe image starts one repeat
  // wider than the bar and shrinks back to it: the stripes run left by exactly one repeat, the image always
  // covers the bar (no seam, unlike shifting background-position, as the bar is no whole number of
  // repeats), and each loop ends on the static bar itself, so it stops exactly where reduced motion rests.
  `@keyframes march{from{background-size:calc(100% + ${AIRMAIL_ACROSS}) 100%}to{background-size:100% 100%}}`,
  `${R} ${AIRMAIL}{animation:march 1.6s linear 3}`,

  // The press (board .btn:active): a button goes down 1px while it is held.
  `${R} button:active{translate:0 1px}`,

  // Nothing replays on a page that reloads itself while a refresh runs (every 3 seconds): the march would
  // restart on every load and never stop, the cards would be dealt again and again. (The just-* markers
  // are never on such a page; guarded anyway.)
  still(`${R}:has(meta[http-equiv=refresh])`),
  // A print shows the page at rest, never a card or a code caught at the start of its fade-in. Last, so it
  // overrides the rules above at the same specificity.
  `@media print{${still(R)}}`,
]

export const POSTAL_MOTION = `@media(prefers-reduced-motion:no-preference){${MOTION.join('\n')}}`
