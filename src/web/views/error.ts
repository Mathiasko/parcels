import { html, type Html } from './html.js'
import { layout, type PageCtx } from './layout.js'

/**
 * An error, as a page of the app: the nav, a heading that says what happened in plain words, and a
 * way on. A bare "not found" or Fastify's JSON is a dead end for somebody who does not know what a
 * status code is - they are left on a blank page with nothing to click.
 *
 * Nothing technical is printed. A 500's cause goes to the server log (see `setErrorHandler`), never
 * here: it can name paths and hosts, and the reader can do nothing with it anyway.
 */
export function errorPage(title: string, says: Html | string, ctx: PageCtx): Html {
  return layout(title, '', html`
<div class="col"><h1>${title}</h1>
<p class="lede">${says}</p>
<p><a href="/">Back to the parcels in flight</a></p></div>`, ctx)
}

export const notFoundPage = (ctx: PageCtx, what: 'page' | 'parcel' | 'email' = 'page'): Html =>
  errorPage('Not found', what === 'parcel'
    ? 'There is no such parcel. It may have been deleted, or the link is from an old page.'
    : what === 'email'
      ? 'That email is no longer waiting: it was assigned or dismissed already, perhaps in another tab.'
      : 'There is nothing at this address. The link may be from an old page.', ctx)

export const serverErrorPage = (ctx: PageCtx): Html =>
  errorPage('Something went wrong', html`This page could not be shown. Trying again in a moment often works. If it keeps happening, open <a href="/health">Health</a> and gather a support bundle for whoever helps you.`, ctx)
