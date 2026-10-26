import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import type { Config } from '../core/config.js'
import type { Database } from '../db/index.js'
import { latestEvent, listEvents } from '../db/events.js'
import { getParcel, listActive } from '../db/parcels.js'
import type { Html } from './views/html.js'
import { indexPage, type RefreshNote } from './views/index.js'
import { parcelPage } from './views/parcel.js'
import { rawResponsesFor } from './queries.js'

export interface WebDeps {
  db: Database
  config: Config
}

/**
 * The server has no authentication, so the bind address is the whole security boundary: loopback
 * only, never configurable, never `0.0.0.0`. `startServer` is the only place a socket is opened.
 */
export const BIND_HOST = '127.0.0.1'

export async function startServer(app: FastifyInstance, port: number): Promise<void> {
  await app.listen({ host: BIND_HOST, port })
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

const send = (reply: FastifyReply, page: Html, status = 200) =>
  reply.code(status).type('text/html; charset=utf-8').send(page.toString())

/** Parses `?refreshed=N&failures=M&busy=1` (set by the refresh redirect) back into a note. */
export function refreshNote(query: Record<string, string | undefined>): RefreshNote | undefined {
  if (query.busy === '1') return { polled: 0, failures: 0, busy: true }
  if (query.refreshed === undefined) return undefined
  const n = (v: string | undefined) => (v && /^\d{1,6}$/.test(v) ? Number(v) : 0)
  return { polled: n(query.refreshed), failures: n(query.failures), busy: false }
}

export function buildServer(deps: WebDeps): FastifyInstance {
  const { db } = deps
  const app = Fastify({ logger: false })

  // Without authentication, a page the user happens to visit must not be able to drive this server:
  // a foreign Host header is a DNS-rebinding attempt, and a cross-origin POST is a forged form.
  app.addHook('onRequest', async (req, reply) => {
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return reply.code(403).type('text/plain').send('forbidden')
    const origin = req.headers.origin
    if (req.method === 'POST' && origin !== undefined) {
      let host = ''
      try { host = new URL(origin).host } catch { /* an unparseable origin is refused below */ }
      if (!LOCAL_HOST.test(host)) return reply.code(403).type('text/plain').send('forbidden')
    }
  })

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500
    reply.code(status).type('text/plain').send(status >= 500 ? 'internal error' : (err as Error).message)
  })

  app.get('/', async (req, reply) => {
    const entries = listActive(db).map(parcel => ({ parcel, last: latestEvent(db, parcel.id) }))
    return send(reply, indexPage(entries, refreshNote(req.query as Record<string, string>)))
  })

  app.get<{ Params: { id: string } }>('/parcel/:id', async (req, reply) => {
    const parcel = /^\d+$/.test(req.params.id) ? getParcel(db, Number(req.params.id)) : undefined
    if (!parcel) return reply.code(404).type('text/plain').send('no such parcel')
    return send(reply, parcelPage(
      parcel, listEvents(db, parcel.id), rawResponsesFor(db, parcel.id, parcel.carrier),
      refreshNote(req.query as Record<string, string>),
    ))
  })

  return app
}
