import { DateTime } from 'luxon'
import type { CanonicalStatus } from '../../core/types.js'
import { STATUS_TITLE } from '../../notify/rules.js'
import { glyph } from './glyphs.js'
import { html, type Html } from './html.js'

export { CARRIER_NAME } from '../../notify/rules.js'

const DISPLAY_ZONE = 'Europe/Bratislava'
const DAY_MS = 86_400_000

const at = (d: Date) => DateTime.fromJSDate(d, { zone: DISPLAY_ZONE }).setLocale('en')

/**
 * Dates are shown by age and never with relative words ("today", "yesterday"): the page is rendered once,
 * with no script to keep it current, so a tab left open overnight would say something false.
 *   within 7 days  `Mon 26 Oct, 17:19`   earlier this year  `12 Mar, 17:19`   an earlier year  `12 Nov 2025, 20:07`
 * The comparison is on full calendar dates in the display zone, never on day and month alone: an email from
 * exactly a year ago has today's day and month.
 */
function byAge(d: Date, now: Date, withTime: boolean): string {
  const t = at(d)
  const recent = Math.abs(now.getTime() - d.getTime()) < 7 * DAY_MS
  const sameYear = t.year === at(now).year
  const day = recent ? t.toFormat('ccc d LLL') : sameYear ? t.toFormat('d LLL') : t.toFormat('d LLL yyyy')
  return withTime ? `${day}, ${t.toFormat('HH:mm')}` : day
}
export const formatDateTime = (d: Date, now: Date): string => byAge(d, now, true)
/** A date with no time of day, for archive material. */
export const formatDate = (d: Date, now: Date): string => byAge(d, now, false)
/** The pickup deadline is a day, not a time of day, and always keeps its weekday: "Saturday" is what you plan around. */
export const formatDay = (d: Date, now: Date): string => {
  const t = at(d)
  return t.year === at(now).year ? t.toFormat('ccc d LLL') : t.toFormat('ccc d LLL yyyy')
}
/** A date inside a table group already headed by its year: day and month only. */
export const formatDayMonth = (d: Date): string => at(d).toFormat('d LLL')
export const formatClock = (d: Date): string => at(d).toFormat('HH:mm')
/** A timeline day heading: weekday and date, plus the year when it is not this year. */
export const formatDayHeading = formatDay
/** The calendar year of an instant in the display zone, for History's year groups. */
export const yearOf = (d: Date): number => at(d).year
/** A stable key for "the same calendar day" in the display zone. */
export const dayKey = (d: Date): string => at(d).toFormat('yyyy-LL-dd')
/** Whole calendar days from `from` to `to` in the display zone (negative when `to` is earlier). */
export const calendarDaysBetween = (from: Date, to: Date): number =>
  Math.round(at(to).startOf('day').diff(at(from).startOf('day'), 'days').days)

/**
 * A duration as a person would say it: whole hours under 48h ("6 hours", "43 hours"), days to one
 * decimal beyond ("2.5 days"). The switch happens once the hours would round to 48.
 */
export function formatDuration(ms: number): string {
  const hours = ms / 3_600_000
  if (hours < 1) return 'under 1 hour'
  if (Math.round(hours) < 48) {
    const h = Math.round(hours)
    return `${h} ${h === 1 ? 'hour' : 'hours'}`
  }
  return `${(hours / 24).toFixed(1)} days`
}

/**
 * An elapsed time in the largest unit that still has a whole number of it: `42 seconds`, `2 minutes`,
 * `2 hours`, `3 days`. Under a second is `just now`, because "0 seconds" reads as a stopped clock.
 *
 * Coarse on purpose: this is read while something is happening ("how long has this been going?"), where
 * the unit matters and the remainder does not. It is also the only relative wording on the site, and
 * §3.4 allows it only next to the absolute time, never instead of it.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return 'just now'
  const units: [number, string][] = [[86_400_000, 'day'], [3_600_000, 'hour'], [60_000, 'minute'], [1000, 'second']]
  for (const [size, name] of units) {
    const n = Math.floor(ms / size)
    if (n >= 1) return plural(n, name)
  }
  return 'just now'
}

/** How long ago something was, in words. A future stamp (a clock that moved) is `just now`, never negative. */
export const formatAgo = (from: Date, now: Date): string => {
  const elapsed = formatElapsed(Math.max(0, now.getTime() - from.getTime()))
  return elapsed === 'just now' ? elapsed : `${elapsed} ago`
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * Colour is an attention level, not an identity: four registers over four hues. Identity is carried by the
 * word and the silhouette, so no status is ever a coloured word alone.
 *   solid    a filled label: someone is waiting for you
 *   outline  a bordered label: soon, or bad news that is not urgent
 *   plain    glyph and word, no container
 */
type Tone = 'signal' | 'warn' | 'ok' | '2'
const REGISTER: Record<Exclude<CanonicalStatus, 'unknown'>, { tone: Tone; kind: 'solid' | 'outline' | 'plain' }> = {
  ready_for_pickup: { tone: 'signal', kind: 'solid' },
  out_for_delivery: { tone: 'signal', kind: 'outline' },
  failed_attempt: { tone: 'warn', kind: 'solid' },
  problem: { tone: 'warn', kind: 'solid' },
  returning: { tone: 'warn', kind: 'outline' },
  in_transit: { tone: '2', kind: 'plain' },
  pre_transit: { tone: '2', kind: 'plain' },
  delivered: { tone: 'ok', kind: 'plain' },
  returned: { tone: '2', kind: 'plain' },
}
export const isKnown = (s: CanonicalStatus): s is Exclude<CanonicalStatus, 'unknown'> => s in REGISTER

/** The colour class of a known status, for the glyph in a row or timeline. */
export const toneClass = (s: CanonicalStatus): string => (isKnown(s) ? `t-${REGISTER[s].tone}` : 't-3')

/** Only for statuses that are not `unknown`; what `unknown` shows depends on why (see `parcelState`). */
export function statusIndicator(status: CanonicalStatus): Html {
  if (!isKnown(status)) return quietIndicator('No status')
  const r = REGISTER[status]
  const word = STATUS_TITLE[status]
  return r.kind === 'plain'
    ? html`<span class="st t-${r.tone}">${glyph(status)}${word}</span>`
    : html`<span class="b ${r.kind} t-${r.tone}">${glyph(status)}${word}</span>`
}

/** The register's bare badge (glyph and word), used on rows and cards where the container matters. */
export const isBadge = (s: CanonicalStatus): boolean => isKnown(s) && REGISTER[s].kind !== 'plain'

/** The 4px dot and a muted word, for "No updates yet" and "Archived". No hue: the absence of a mark. */
export function quietIndicator(word: string): Html {
  return html`<span class="st t-3 quiet">${glyph('unknown')}${word}</span>`
}
