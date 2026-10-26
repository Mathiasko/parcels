import { DateTime } from 'luxon'
import type { CanonicalStatus } from '../../core/types.js'
import { STATUS_TITLE } from '../../notify/rules.js'
import { html, type Html } from './html.js'

export { CARRIER_NAME } from '../../notify/rules.js'

const DISPLAY_ZONE = 'Europe/Bratislava'

const at = (d: Date) => DateTime.fromJSDate(d, { zone: DISPLAY_ZONE }).setLocale('en')

export const formatDateTime = (d: Date): string => at(d).toFormat('ccc d LLL, HH:mm')
export const formatDate = (d: Date): string => at(d).toFormat('ccc d LLL yyyy')
/** The pickup deadline is a day, not a time of day. */
export const formatDay = (d: Date): string => at(d).toFormat('ccc d LLL')

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

export function statusChip(status: CanonicalStatus): Html {
  return html`<span class="chip chip-${status.replace(/_/g, '-')}">${STATUS_TITLE[status]}</span>`
}
