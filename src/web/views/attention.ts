import type { Parcel } from '../../db/parcels.js'
import type { UnparsedMessage } from '../queries.js'
import { formatDateTime } from './format.js'
import { html, type Html } from './html.js'
import { layout, notice, scroller, type PageCtx } from './layout.js'
import { parcelFields, type AddValues } from './add.js'
import { parcelName } from './index.js'

export interface AttentionError { messageId: number; message: string; values: AddValues }

/** How many senders get a dismissal of their own before the list would stop being a short list. */
const SENDERS_SHOWN = 12

/**
 * The senders worth a button of their own: those with more than one message waiting, busiest first.
 * One message is not a bulk action - it already has its own Dismiss - and a sender the ingest never
 * recorded cannot be matched by the dismissal's `from_addr = ?`, so it is left out of the offer
 * rather than offered and silently not honoured.
 */
function senders(messages: UnparsedMessage[]): Array<{ from: string; count: number }> {
  const counts = new Map<string, number>()
  for (const m of messages) if (m.from) counts.set(m.from, (counts.get(m.from) ?? 0) + 1)
  return [...counts]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([from, count]) => ({ from, count }))
}

/**
 * Clearing the queue. 662 waiting emails cannot be dismissed one at a time, and on the author's
 * mailbox a handful of senders are most of them (alza 149, eobuv 92, billa 84, Steam 22), so
 * "everything" and "everything from this sender" are the two actions a person actually wants.
 *
 * It is a `<details>` disclosure for the same reason deleting a parcel is one (`parcel.ts`): with no
 * JS there is no dialog, and the thing being confirmed - the list itself - is already on screen, so a
 * confirm page would re-render what this page shows. Opening the disclosure IS the confirm step, and
 * every label states the exact number it would dismiss, because that number is the whole risk.
 *
 * Quiet register throughout, and never `--signal`: blue on this site means "this needs you", and a
 * bulk delete is the opposite of that (design-language §6.7). It sits ABOVE the items deliberately -
 * with hundreds of them, anything below the list is unreachable without endless scrolling - but
 * collapsed, so it takes one line and does not compete with Assign.
 *
 * `up_to` is the newest row the page listed, and every form is a form of its own: a second button
 * inside the assign form would submit the assign fields.
 */
function clearSection(messages: UnparsedMessage[]): Html {
  const total = messages.length
  const upTo = messages.reduce((hi, m) => Math.max(hi, m.id), 0)
  const by = senders(messages)
  const shown = by.slice(0, SENDERS_SHOWN)
  const hidden = by.length - shown.length
  const bulk = (label: Html | string, from?: string) => html`<form method="post" action="/attention/dismiss">
    <input type="hidden" name="up_to" value="${String(upTo)}">${from === undefined ? '' : html`<input type="hidden" name="from" value="${from}">`}
    <button>${label}</button></form>`

  return html`<details class="bulk">
  <summary>Clear this queue (${String(total)} email${total === 1 ? '' : 's'})</summary>
  <p>These emails yielded no parcel and never will: dismissing them takes them off this list for good, and deletes this machine's stored copy of each one to get the disk back. The mail itself stays in your mailbox, and the record that it arrived is kept, so the next mail check will not bring it back.</p>
  ${bulk(html`Dismiss all ${String(total)} email${total === 1 ? '' : 's'}`)}
  ${shown.length === 0 ? '' : html`<p class="meta">Or clear out one sender at a time:</p>
  <ul>${shown.map(s => html`<li>${bulk(html`Dismiss ${String(s.count)}`, s.from)}<span class="who">from ${s.from}</span></li>`)}</ul>
  ${hidden > 0 ? html`<p class="meta">${String(hidden)} further sender${hidden === 1 ? ' has' : 's have'} more than one email waiting; they are covered by “Dismiss all”.</p>` : ''}`}
</details>`
}

export function attentionPage(
  messages: UnparsedMessage[], dormant: Parcel[], ctx: PageCtx, error?: AttentionError,
): Html {
  return layout('Attention', '/attention', html`
<h1>Needs attention</h1>
<div class="col"><h2>Emails that did not yield a parcel</h2>
${messages.length === 0 ? html`<p class="empty">Nothing waiting.</p>` : html`<p class="meta">Assign one to a parcel, or dismiss it as junk. Dismissing takes it off this list and deletes the stored copy of the email; the mail in your mailbox is untouched.</p>
${messages.length > 1 ? clearSection(messages) : ''}
${messages.map(m => html`<div class="item">
  <h3>${m.subject ?? '(no subject)'}</h3>
  <div class="meta">${m.from ?? 'unknown sender'}${m.receivedAt ? html` · ${formatDateTime(m.receivedAt, ctx.now)}` : ''}${m.note ? html` · ${m.note}` : ''}</div>
  ${error?.messageId === m.id ? notice('warn', html`<p>${error.message}</p>`, true) : ''}
  <div class="acts"><form method="post" action="/attention/${m.id}/assign">${parcelFields(error?.messageId === m.id ? error.values : {})}
  <p><button class="pri">Assign to a parcel</button></p></form>
  <form method="post" action="/attention/${m.id}/dismiss"><button class="link">Dismiss<span class="vh"> ${m.subject ?? '(no subject)'}</span></button></form></div>
</div>`)}`}</div>
<h2>Dormant parcels</h2>
<p class="meta">No tracking event for over 30 days, so they are no longer polled.</p>
${dormant.length === 0 ? html`<p class="empty">None.</p>` : scroller('Dormant parcels', html`<table><thead><tr><th scope="col">Parcel</th><th scope="col">Number</th><th scope="col" class="d">Waiting</th></tr></thead><tbody>${dormant.map(p => html`<tr>
  <td><a href="/parcel/${p.id}">${parcelName(p)}</a></td><td><span class="mono">${p.trackingNumber}</span></td>
  <td class="d">${Math.floor((ctx.now.getTime() - p.firstSeenAt.getTime()) / 86_400_000)} days</td></tr>`)}</tbody></table>`)}`, ctx)
}
