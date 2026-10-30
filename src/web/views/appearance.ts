import { MODES } from '../../core/appearance.js'
import { MODE_LABEL, type SettingsValues } from '../settings.js'
import { THEMES } from '../themes/index.js'
import { html, raw, type Html } from './html.js'

// The same shape as the option helper in settings.ts, kept here so that file stays untouched.
const option = (value: string, label: string, current: string): Html =>
  html`<option value="${value}"${value === current ? raw(' selected') : ''}>${label}</option>`

/** The Appearance block of the settings form: which theme, and whether it follows the Mac's light/dark setting. */
export function appearanceFields(v: SettingsValues): Html {
  return html`<h2>Appearance</h2><div class="fields"><label>Theme<select name="theme">${
    THEMES.map(t => option(t.id, t.name, v.theme))}</select></label><label>Mode<select name="mode">${
    MODES.map(m => option(m, MODE_LABEL[m], v.mode))}</select><span class="meta hint">Light or dark, or follow the Mac.</span></label></div>`
}
