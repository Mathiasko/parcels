import { CARRIER_NAME } from './format.js'
import { html, raw, type Html } from './html.js'
import { layout, notice, type PageCtx } from './layout.js'
import type { CarrierId } from '../../core/types.js'

export interface AddValues { number?: string; carrier?: string; label?: string; postcode?: string }

export interface FieldOptions {
  /** The configured default postcode, shown as the postcode box's placeholder so "blank" has a meaning. */
  defaultPostcode?: string
  /** Put the cursor in the tracking number box. Only on /add: /attention has a form per email. */
  autofocus?: boolean
}

/**
 * Carrier choice + number + name + postcode; shared by /add and each unparsed message on /attention.
 *
 * The tracking number is pasted or typed off a label: capitals, no spellcheck squiggles, and no
 * autofill offering yesterday's number. The postcode box shows the real default it falls back to,
 * because a placeholder that says "default" leaves the reader to guess what that is.
 */
export function parcelFields(v: AddValues = {}, o: FieldOptions = {}): Html {
  return html`<div class="fields">
<label>Tracking number<input name="number" value="${v.number ?? ''}" class="mono" required${o.autofocus ? raw(' autofocus') : ''} autocapitalize="characters" spellcheck="false" autocomplete="off"></label>
<label>Carrier<select name="carrier"><option value="">Detect from number</option>${(Object.keys(CARRIER_NAME) as CarrierId[]).map(id =>
    html`<option value="${id}"${v.carrier === id ? ' selected' : ''}>${CARRIER_NAME[id]}</option>`)}</select></label>
<label>Name<input name="label" value="${v.label ?? ''}" placeholder="e.g. Shoes from Zalando"></label>
<label>Postcode<input name="postcode" value="${v.postcode ?? ''}" size="8" inputmode="numeric"${o.defaultPostcode ? html` placeholder="${o.defaultPostcode} (default)"` : ''}><span class="meta hint">Used by GLS and DPD.</span></label></div>`
}

export function addPage(ctx: PageCtx, error?: string, values?: AddValues, defaultPostcode?: string): Html {
  return layout('Add parcel', '/add', html`
<div class="col"><h1>Add parcel</h1>
<p class="lede">Paste a tracking number. The carrier is detected from its shape unless you choose one.</p>
${error ? notice('warn', html`<p>${error}</p>`, true) : ''}
<form method="post" action="/add">${parcelFields(values, { defaultPostcode, autofocus: true })}
<p><button class="pri">Add parcel</button></p></form></div>`, ctx)
}
