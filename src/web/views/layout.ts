import { html, type Html } from './html.js'
import { STYLE } from './style.js'
import { raw } from './html.js'

const NAV = [
  ['/', 'In flight'], ['/history', 'History'], ['/attention', 'Attention'], ['/health', 'Health'], ['/add', 'Add'],
] as const

export function layout(title: string, current: string, body: Html): Html {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Parcels</title>
<style>${raw(STYLE)}</style></head>
<body><header><strong>Parcels</strong><nav>${NAV.map(([href, label]) =>
    html`<a href="${href}"${href === current ? raw(' class="current"') : ''}>${label}</a>`)}</nav></header>
<main>${body}</main></body></html>
`
}
