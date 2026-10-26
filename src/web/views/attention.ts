import type { Parcel } from '../../db/parcels.js'
import type { UnparsedMessage } from '../queries.js'
import { formatDateTime } from './format.js'
import { html, type Html } from './html.js'
import { layout } from './layout.js'
import { parcelFields, type AddValues } from './add.js'
import { parcelName } from './index.js'

export interface AttentionError { messageId: number; message: string; values: AddValues }

export function attentionPage(
  messages: UnparsedMessage[], dormant: Parcel[], now: Date, error?: AttentionError,
): Html {
  return layout('Attention', '/attention', html`
<h1>Needs attention</h1>
<h2>Emails that did not yield a parcel</h2>
${messages.length === 0 ? html`<p class="muted">Nothing waiting.</p>` : messages.map(m => html`<div class="card">
  <div><strong>${m.subject ?? '(no subject)'}</strong></div>
  <div class="small muted">${m.from ?? 'unknown sender'}${m.receivedAt ? html` · ${formatDateTime(m.receivedAt)}` : ''}${m.note ? html` · ${m.note}` : ''}</div>
  ${error?.messageId === m.id ? html`<p class="notice alarm">${error.message}</p>` : ''}
  <form class="stack" method="post" action="/attention/${m.id}/assign">${parcelFields(error?.messageId === m.id ? error.values : {})}
  <p><button>Assign to a parcel</button></p></form>
</div>`)}
<h2>Dormant parcels</h2>
<p class="muted small">No tracking event for over 30 days, so they are no longer polled.</p>
${dormant.length === 0 ? html`<p class="muted">None.</p>` : html`<table><tr><th>Parcel</th><th>Number</th><th>Waiting</th></tr>${dormant.map(p => html`<tr>
  <td><a href="/parcel/${p.id}">${parcelName(p)}</a></td><td>${p.trackingNumber}</td>
  <td>${Math.floor((now.getTime() - p.firstSeenAt.getTime()) / 86_400_000)} days</td></tr>`)}</table>`}`)
}
