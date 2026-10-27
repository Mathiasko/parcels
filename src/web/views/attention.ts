import type { Parcel } from '../../db/parcels.js'
import type { UnparsedMessage } from '../queries.js'
import { formatDateTime } from './format.js'
import { html, type Html } from './html.js'
import { layout, notice, scroller, type PageCtx } from './layout.js'
import { parcelFields, type AddValues } from './add.js'
import { parcelName } from './index.js'

export interface AttentionError { messageId: number; message: string; values: AddValues }

export function attentionPage(
  messages: UnparsedMessage[], dormant: Parcel[], ctx: PageCtx, error?: AttentionError,
): Html {
  return layout('Attention', '/attention', html`
<h1>Needs attention</h1>
<div class="col"><h2>Emails that did not yield a parcel</h2>
${messages.length === 0 ? html`<p class="empty">Nothing waiting.</p>` : html`<p class="meta">Assign one to a parcel, or dismiss it as junk. Dismissing only takes it off this list: the email itself is kept.</p>
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
