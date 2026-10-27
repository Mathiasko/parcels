import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import type { Config } from '../core/config.js'
import type { CarrierId } from '../core/types.js'
import type { Database } from '../db/index.js'
import { latestEvent, listEvents } from '../db/events.js'
import { getParcel, listActive } from '../db/parcels.js'
import type { CarrierAdapter, HttpClient } from '../core/types.js'
import { createHttpClient } from '../core/http.js'
import { isDormant } from '../core/backoff.js'
import { runPoll } from '../core/poll.js'
import { allAdapters } from '../carriers/registry.js'
import { createNotifier } from '../notify/send.js'
import type { Notifier } from '../notify/types.js'
import { listDelivered, setLabel, setPostalCode } from '../db/parcels.js'
import { carrierHealth } from '../db/health.js'
import { getIngestStatus } from '../db/ingest-status.js'
import { addParcel, cleanPostcode, MAX_LABEL } from './actions.js'
import { CARRIER_NAME } from './views/format.js'
import {
  deliveryStats, getUnparsedMessage, listUnparsedMessages, rawResponsesFor,
} from './queries.js'
import type { Html } from './views/html.js'
import { addPage } from './views/add.js'
import { attentionPage, type AttentionError } from './views/attention.js'
import { healthPage } from './views/health.js'
import { pollerStatus } from '../core/pollwatch.js'
import { historyPage } from './views/history.js'
import { indexPage, type RefreshNote } from './views/index.js'
import { parcelPage } from './views/parcel.js'
import { DateTime } from 'luxon'
import type { PageCtx } from './views/layout.js'

export interface WebDeps {
  db: Database
  config: Config
  /** The remaining dependencies exist so tests can run a refresh without the network or a real banner. */
  http?: HttpClient
  adapters?: CarrierAdapter[]
  notifier?: Notifier
  now?: () => Date
}

/**
 * The server has no authentication, so the bind address is the whole security boundary: loopback
 * only, never configurable, never `0.0.0.0`. `startServer` is the only place a socket is opened.
 */
export const BIND_HOST = '127.0.0.1'

export async function startServer(app: FastifyInstance, port: number): Promise<void> {
  await app.listen({ host: BIND_HOST, port })
}

/** A parcel tried within this long is left alone by the global refresh (a double click, or the hourly poll just ran). */
const MIN_REFRESH_GAP_MS = 60_000

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

const send = (reply: FastifyReply, page: Html, status = 200) =>
  reply.code(status).type('text/html; charset=utf-8').send(page.toString())

/** A repeated query key (`?q=a&q=b`) arrives as an array; only the first value is ever meaningful. */
const one = (v: unknown): string | undefined => {
  const first = Array.isArray(v) ? v[0] : v
  return typeof first === 'string' ? first : undefined
}

/** Parses `?refreshed=N&failures=M&busy=1` (set by the refresh redirect) back into a note. */
export function refreshNote(query: Record<string, unknown>): RefreshNote | undefined {
  if (one(query.busy) === '1') return { polled: 0, failures: 0, busy: true }
  const polled = one(query.refreshed)
  if (polled === undefined) return undefined
  const n = (v: string | undefined) => (v !== undefined && /^\d{1,6}$/.test(v) ? Number(v) : 0)
  return { polled: n(polled), failures: n(one(query.failures)), busy: false }
}

export function buildServer(deps: WebDeps): FastifyInstance {
  const { db, config } = deps
  const app = Fastify({ logger: false })
  const now = () => (deps.now ?? (() => new Date()))()
  /** What every page needs besides its own data: the clock, and carrier health (for the lede and the nav dot). */
  const ctx = (): PageCtx => ({ now: now(), health: carrierHealth(db) })

  // Without authentication, a page the user happens to visit must not be able to drive this server:
  // a foreign Host header is a DNS-rebinding attempt, and a cross-site POST is a forged form. The Origin
  // of a write must be THIS server (same host and port), not merely some loopback address: another dev
  // server on localhost is just as foreign.
  app.addHook('onRequest', async (req, reply) => {
    // Second layer behind the structural escaping: even injected markup could load nothing and run nothing.
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
    reply.header('X-Content-Type-Options', 'nosniff')
    const host = req.headers.host ?? ''
    const refuse = () => reply.code(403).type('text/plain').send('forbidden')
    if (!LOCAL_HOST.test(host)) return refuse()
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const site = req.headers['sec-fetch-site']
      if (site !== undefined && site !== 'same-origin' && site !== 'none') return refuse()
      const origin = req.headers.origin
      if (origin !== undefined) {
        let originHost: string | undefined
        try { originHost = new URL(origin).host } catch { /* "null" and other unparseable origins are refused */ }
        if (originHost === undefined || originHost.toLowerCase() !== host.toLowerCase()) return refuse()
      }
    }
  })

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500
    // The logger is off, so without this a 500 under launchd leaves nothing in web.err.log to diagnose.
    if (status >= 500) console.error(`${new Date().toISOString()} ${req.method} ${req.url}:`, err)
    reply.code(status).type('text/plain').send(status >= 500 ? 'internal error' : (err as Error).message)
  })

  app.get('/', async (req, reply) => {
    const entries = listActive(db).map(parcel => ({ parcel, last: latestEvent(db, parcel.id) }))
    return send(reply, indexPage(entries, ctx(), refreshNote(req.query as Record<string, unknown>)))
  })

  app.get<{ Params: { id: string } }>('/parcel/:id', async (req, reply) => {
    const parcel = /^\d+$/.test(req.params.id) ? getParcel(db, Number(req.params.id)) : undefined
    if (!parcel) return reply.code(404).type('text/plain').send('no such parcel')
    return send(reply, parcelPage(
      parcel, listEvents(db, parcel.id), rawResponsesFor(db, parcel.id, parcel.carrier), ctx(),
      refreshNote(req.query as Record<string, unknown>),
    ))
  })

  const notFound = (reply: FastifyReply) => reply.code(404).type('text/plain').send('not found')
  const form = (req: { body: unknown }): Record<string, string> => (req.body ?? {}) as Record<string, string>
  const text = (v: string | undefined) => (v ?? '').trim()
  const parcelFor = (id: string) => (/^\d+$/.test(id) ? getParcel(db, Number(id)) : undefined)

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)))
  })

  app.get('/history', async (req, reply) => {
    const query = req.query as Record<string, unknown>
    const carrier = one(query.carrier)
    const filters = {
      carrier: carrier !== undefined && carrier in CARRIER_NAME ? (carrier as CarrierId) : undefined,
      q: one(query.q)?.trim().slice(0, 100) || undefined,
      from: one(query.from) || undefined,
      to: one(query.to) || undefined,
    }
    const day = (v: string | undefined, end: boolean) => {
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined
      const d = DateTime.fromISO(v, { zone: 'Europe/Bratislava' })
      return d.isValid ? (end ? d.endOf('day') : d.startOf('day')).toJSDate() : undefined
    }
    const parcels = listDelivered(db, {
      carrier: filters.carrier, q: filters.q, from: day(filters.from, false), to: day(filters.to, true),
    })
    return send(reply, historyPage(parcels, deliveryStats(db), filters, ctx()))
  })

  app.get('/health', async (_req, reply) => {
    const c = ctx()
    return send(reply, healthPage(c.health, { configured: config.imap !== undefined, status: getIngestStatus(db) }, pollerStatus(db, c.now), c))
  })

  const attention = (reply: FastifyReply, error?: AttentionError, status = 200) =>
    send(reply, attentionPage(
      listUnparsedMessages(db), listActive(db).filter(p => isDormant(p, now())), ctx(), error,
    ), status)
  app.get('/attention', async (_req, reply) => attention(reply))

  app.get('/add', async (_req, reply) => send(reply, addPage(ctx())))

  app.post('/add', async (req, reply) => {
    const f = form(req)
    const values = { number: text(f.number), carrier: text(f.carrier), label: text(f.label), postcode: text(f.postcode) }
    const result = addParcel(db, config, { ...values, source: 'manual' })
    if (result.ok) return reply.redirect(`/parcel/${result.id}`, 303)
    return send(reply, addPage(ctx(), result.message, values), result.status)
  })

  app.post<{ Params: { messageId: string } }>('/attention/:messageId/assign', async (req, reply) => {
    const messageId = Number(req.params.messageId)
    const message = Number.isInteger(messageId) ? getUnparsedMessage(db, messageId) : undefined
    if (!message) return notFound(reply)
    const f = form(req)
    const values = { number: text(f.number), carrier: text(f.carrier), label: text(f.label), postcode: text(f.postcode) }
    const link = (parcelId: number) => db.prepare('UPDATE messages SET parsed_ok = 1, parcel_id = ? WHERE id = ?').run(parcelId, messageId)
    const result = db.transaction(() => {
      const r = addParcel(db, config, { ...values, source: 'email', sourceMessageId: message.messageId })
      // The email is about a parcel we already track: resolve it against that parcel rather than leave it waiting.
      if (r.ok) link(r.id)
      else if (r.status === 409) link(r.existingId)
      return r
    })()
    if (result.ok) return reply.redirect(`/parcel/${result.id}`, 303)
    if (result.status === 409) return reply.redirect(`/parcel/${result.existingId}`, 303)
    return attention(reply, { messageId, message: result.message, values }, result.status)
  })

  app.post<{ Params: { id: string } }>('/parcel/:id/label', async (req, reply) => {
    const parcel = parcelFor(req.params.id)
    if (!parcel) return notFound(reply)
    setLabel(db, parcel.id, text(form(req).label).slice(0, MAX_LABEL))
    return reply.redirect(`/parcel/${parcel.id}`, 303)
  })

  app.post<{ Params: { id: string } }>('/parcel/:id/postcode', async (req, reply) => {
    const parcel = parcelFor(req.params.id)
    if (!parcel) return notFound(reply)
    setPostalCode(db, parcel.id, cleanPostcode(form(req).postcode))
    return reply.redirect(`/parcel/${parcel.id}`, 303)
  })

  // A real poll, run from this process. The click is the user saying "now", so the per-parcel backoff tier is
  // skipped (`forceAll`), but only for the parcels they pointed at: `forceAll` skips `isDue` entirely, which
  // would also wake dormant parcels, so the set is chosen here. The gated-carrier throttle and the
  // needs_postcode skip are applied by `runPoll` regardless, so clicking cannot hammer a broken carrier.
  // A notifier is passed so a status change found here is announced, not consumed.
  let refreshing = false
  app.post('/refresh', async (req, reply) => {
    const target = text(form(req).parcel)
    let back = '/'
    let parcelIds: number[]
    if (target !== '') {
      const parcel = parcelFor(target)
      if (!parcel) return notFound(reply)
      parcelIds = [parcel.id]
      back = `/parcel/${parcel.id}`
    } else {
      const t = now().getTime()
      parcelIds = listActive(db)
        .filter(p => !isDormant(p, now()) && (p.lastAttemptedAt === undefined || t - p.lastAttemptedAt.getTime() > MIN_REFRESH_GAP_MS))
        .map(p => p.id)
    }
    if (refreshing) return reply.redirect(`${back}?busy=1`, 303)   // a double click must not poll twice
    refreshing = true
    try {
      const report = await runPoll({
        db, config, parcelIds, forceAll: true,
        http: deps.http ?? createHttpClient(),
        adapters: deps.adapters ?? allAdapters(),
        notifier: deps.notifier ?? createNotifier(config.notifier),
        now: now(),
      })
      return reply.redirect(`${back}?refreshed=${report.polled}&failures=${report.failures.length}`, 303)
    } finally {
      refreshing = false
    }
  })

  return app
}
