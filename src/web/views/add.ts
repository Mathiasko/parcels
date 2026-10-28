import { CARRIER_NAME } from './format.js'
import { html, type Html } from './html.js'
import { layout, notice, type PageCtx } from './layout.js'
import type { CarrierId } from '../../core/types.js'

export interface AddValues { number?: string; carrier?: string; label?: string; postcode?: string }

/** Carrier choice + number + label + postcode; shared by /add and each unparsed message on /attention. */
export function parcelFields(v: AddValues = {}): Html {
  return html`<div class="fields">
<label>Tracking number<input name="number" value="${v.number ?? ''}" class="mono" required></label>
<label>Carrier<select name="carrier"><option value="">Detect from number</option>${(Object.keys(CARRIER_NAME) as CarrierId[]).map(id =>
    html`<option value="${id}"${v.carrier === id ? ' selected' : ''}>${CARRIER_NAME[id]}</option>`)}</select></label>
<label>Name<input name="label" value="${v.label ?? ''}" placeholder="e.g. Shoes from Zalando"></label>
<label>Postcode<input name="postcode" value="${v.postcode ?? ''}" size="8" placeholder="default"><span class="meta hint">Used by GLS and DPD.</span></label></div>`
}

export function addPage(ctx: PageCtx, error?: string, values?: AddValues): Html {
  return layout('Add a parcel', '/add', html`
<div class="col"><h1>Add a parcel</h1>
<p class="lede">Paste a tracking number. The carrier is detected from its shape unless you choose one.</p>
${error ? notice('warn', html`<p>${error}</p>`, true) : ''}
<form method="post" action="/add">${parcelFields(values)}
<p><button class="pri">Add parcel</button></p></form></div>`, ctx)
}
