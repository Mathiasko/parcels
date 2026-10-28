import type { CalendarFailureKind } from '../../core/calendar-app.js'
import type { StoredCalendarEvent } from '../../db/calendar-events.js'
import { parcelName, type Parcel } from '../../db/parcels.js'
import { formatSlot, isTime, pickupSlots, slotAllowed, slotOf, timeLabel, PICKUP_TIMES } from '../calendar-slots.js'
import { glyph } from './glyphs.js'
import { html, raw, type Html } from './html.js'
import { notice } from './layout.js'

/**
 * "Add to Calendar": a `<details>` whose summary sits where the old download link did - on the parcel's
 * own clock line - and whose form picks a day and a time and POSTs them; the server puts the event into
 * Calendar.app. No script on the page, so the disclosure is the whole of the interaction.
 */

/** Offered for every parcel waiting for collection that is not archived; the routes refuse anything else. */
export const calendarOffered = (p: Parcel): boolean => p.status === 'ready_for_pickup' && p.archivedAt === undefined

/** What the form knows beyond the parcel: the event already added, and a refused submission to show again. */
export interface CalendarFormState {
  stored?: StoredCalendarEvent
  /** The POST refused this submission: the form opens again, with this said inside it and the choice kept. */
  error?: string
  day?: string
  time?: string
}

/**
 * The form, or nothing when it is not offered (or, today after the last time with a deadline that is
 * today or past, when there is no slot left - then only an event already added is mentioned).
 *
 * Closed by default; opened by a refused submission. On a dashboard card it is lifted above the card's
 * stretched link (`.calf`, like `.got`), so opening it does not open the parcel. The submit is a quiet
 * secondary button, never `--signal`: the chip already says the parcel is waiting on you.
 *
 * The defaults: the stored event's day and time while they are still offered, else the last day (or,
 * without a deadline, the first day) and its first time still to come.
 *
 * Besides the three presets there is "Other": a radio (`time=other`) and a time field (`at`) beside it,
 * which CSS shows only while "Other" is checked; the server reads `at` only then. A time that is not a
 * preset - a custom one stored or sent - is shown as "Other" with that time filled in.
 */
export function calendarForm(p: Parcel, now: Date, state: CalendarFormState = {}, back?: 'home'): Html {
  if (!calendarOffered(p)) return html``
  const slots = pickupSlots(p.retainedTill, now)
  const name = parcelName(p)
  const stored = state.stored ? html`In Calendar: ${formatSlot(state.stored.startsAt, now)}` : undefined
  if (slots.days.length === 0) return stored ? html`<span class="calf-in">${stored}</span>` : html``

  // When today is the only day, the presets that have gone are not offered at all (after 17:00, none
  // are: only "Other"); otherwise all three are (they are shared by every day) and a past one is refused
  // by the server, which says so in the form.
  const times: readonly string[] = slots.days.length === 1 ? slots.days[0]!.times : PICKUP_TIMES
  // What to check: a refused submission as it was sent (the error beside it explains what was wrong
  // with it), else the stored event's slot while it is still offered, else the defaults.
  const sent = state.day !== undefined ? { day: state.day, time: state.time ?? '' } : undefined
  const kept = state.stored ? slotOf(state.stored.startsAt) : undefined
  const shown = (c: { day: string; time: string } | undefined) => c !== undefined && slots.days.some(d => d.date === c.day)
  const day = shown(sent) ? sent!.day : shown(kept) ? kept!.day : slots.day!
  const time = sent && sent.day === day ? sent.time
    : kept && kept.day === day && slotAllowed(slots, day, kept.time) ? kept.time
    : slots.days.find(d => d.date === day)!.first
  const other = !times.includes(time)
  const radio = (field: 'day' | 'time', value: string, label: string, checked: boolean) =>
    html`<label class="pick"><input type="radio" name="${field}" value="${value}"${checked ? raw(' checked') : ''}> ${label}</label>`

  return html`<details class="calf"${state.error !== undefined ? raw(' open') : ''}><summary><span class="calf-b">${CAL_ICON}${
    stored ? html`${stored} · <span class="calf-c">Change</span>` : 'Add to Calendar'}</span><span class="vh">: ${name}</span></summary>
<form method="post" action="/parcel/${p.id}/calendar">${back ? html`<input type="hidden" name="back" value="${back}">` : ''}${
    state.error !== undefined ? html`<p class="calf-err" role="alert">${glyph('problem')}<span>${state.error}</span></p>` : ''}
<fieldset><legend>Day</legend><div class="picks">${slots.days.map(d => radio('day', d.date, d.label, d.date === day))}</div></fieldset>
<fieldset><legend>Time</legend><div class="picks">${times.map(t => radio('time', t, timeLabel(t), t === time))}${
    radio('time', 'other', 'Other', other)}<input class="pick-t" type="time" name="at" aria-label="Other time"${
    other && isTime(time) ? html` value="${time}"` : ''}></div></fieldset>
<button>Add to Calendar<span class="vh">: ${name}</span></button>
</form></details>`
}

/** A calendar page with a plus, for the summary: the one control on the clock line, so it gets a picture. */
const CAL_ICON = raw('<svg class="g" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.75 6.5h10.5M5.5 1.75v2.5M10.5 1.75v2.5M8 8.25v3.5M6.25 10h3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>')

/**
 * What one press of "Add to Calendar" came to, kept by the server for the page the POST redirects to.
 * The URL carries only which outcome to show, never what it says.
 */
export type CalendarOutcome =
  | { ok: true; parcelId: number; calendar: string; startsAt: Date; replaced: boolean }
  | { ok: false; parcelId: number; kind: CalendarFailureKind; detail?: string; calendar?: string; day: string; time: string }

const SETTINGS = html`<a href="/settings#calendar">Settings</a>`
const AUTOMATION = 'System Settings → Privacy & Security → Automation → node → Calendar'

/** Each failure, as the fact in bold and what to do next beneath it. */
function failure(o: Extract<CalendarOutcome, { ok: false }>, name: string): Html {
  const which = o.calendar ?? ''
  switch (o.kind) {
    case 'denied':
      return html`<p><strong>Calendar did not let this app add ${name}.</strong></p>
<p>macOS asks once whether node may control Calendar, and the answer was no. Turn it on in ${AUTOMATION}, then add it again.</p>`
    case 'timeout':
      return html`<p><strong>Calendar did not answer in time, so ${name} was not added.</strong></p>
<p>The first time, macOS asks whether node may control Calendar: if that question is waiting, answer it and add it again.</p>`
    case 'no_calendar':
      return html`<p><strong>There is no calendar to add ${name} to.</strong></p>
<p>Calendar has no calendar this app can write to. Make one in Calendar (File → New Calendar), then add it again.</p>`
    case 'not_found':
      return html`<p><strong>There is no calendar named “${which}”.</strong></p>
<p>${name} was not added. Choose another calendar for pickups in ${SETTINGS}.</p>`
    case 'ambiguous':
      return html`<p><strong>More than one calendar is named “${which}”.</strong></p>
<p>${name} was not added, because it could go into either. Rename one of them in Calendar, or choose another in ${SETTINGS}.</p>`
    case 'read_only':
      return html`<p><strong>The calendar “${which}” is read-only.</strong></p>
<p>${name} was not added. Choose a calendar you can write to in ${SETTINGS}.</p>`
    case 'not_running':   // listing only; adding launches Calendar itself. Said plainly all the same.
    case 'other':
      return html`<p><strong>${name} could not be added to Calendar.</strong></p>${
        o.detail ? html`<p class="meta">Calendar said: ${o.detail}</p>` : ''}`
  }
}

/**
 * The notice after a press: where the event went, or why it did not and the way round it. Every failure
 * offers the same event as a file, which Safari opens straight into Calendar's own Add dialog.
 */
export function calendarNotice(o: CalendarOutcome | undefined, p: Parcel | undefined, now: Date): Html {
  if (!o || !p) return html``
  const name = parcelName(p)
  if (o.ok) {
    return notice('neutral', html`<p>Added <strong>${name}</strong> to Calendar “${o.calendar}”: ${formatSlot(o.startsAt, now)}${
      o.replaced ? ', in place of the one added before' : ''}.</p><p class="meta">With an alert at that time. Not the calendar you wanted? Choose it in ${SETTINGS}.</p>`, true)
  }
  return notice('warn', html`${failure(o, name)}
<p><a href="/parcel/${p.id}/calendar.ics?day=${o.day}&amp;time=${o.time}">Download the event instead</a> <span class="meta">— the same event as a file, for Calendar to open.</span></p>`, true)
}
