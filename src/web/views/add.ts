import { CARRIER_NAME } from './format.js'
import { html, type Html } from './html.js'
import { layout } from './layout.js'
import type { CarrierId } from '../../core/types.js'

export interface AddValues { number?: string; carrier?: string; label?: string; postcode?: string }

/** Carrier choice + number + label + postcode; shared by /add and each unparsed message on /attention. */
export function parcelFields(v: AddValues = {}): Html {
  return html`<label>Tracking number <input name="number" value="${v.number ?? ''}" required></label>
<label>Carrier <select name="carrier"><option value="">Detect from number</option>${(Object.keys(CARRIER_NAME) as CarrierId[]).map(id =>
    html`<option value="${id}"${v.carrier === id ? ' selected' : ''}>${CARRIER_NAME[id]}</option>`)}</select></label>
<label>Label <input name="label" value="${v.label ?? ''}"></label>
<label>Postcode <input name="postcode" value="${v.postcode ?? ''}" size="8" placeholder="default"></label>`
}

export function addPage(error?: string, values?: AddValues): Html {
  return layout('Add a parcel', '/add', html`
<h1>Add a parcel</h1>
${error ? html`<p class="notice alarm">${error}</p>` : ''}
<form class="stack" method="post" action="/add">${parcelFields(values)}
<p><button>Add parcel</button></p></form>`)
}
