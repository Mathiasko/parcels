import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import {
  readConfigDocument, runtimeConfigPath, validateConfig, writeConfigDocument, type Config, type ConfigDocument,
} from '../core/config.js'
import type { CarrierId } from '../core/types.js'
import type { Database } from '../db/index.js'
import { latestEvent, listEvents } from '../db/events.js'
import { deleteParcel, getParcel, listActive, type Parcel } from '../db/parcels.js'
import type { CarrierAdapter, HttpClient } from '../core/types.js'
import { createHttpClient } from '../core/http.js'
import { cachedGrid } from '../core/map-preview.js'
import { parseTile } from '../core/slippy.js'
import { readTile, tileDirFor } from '../core/tiles.js'
import { isDormant } from '../core/backoff.js'
import { runPoll } from '../core/poll.js'
import { allAdapters } from '../carriers/registry.js'
import { createNotifier } from '../notify/send.js'
import type { Notifier } from '../notify/types.js'
import { listDelivered, setLabel, setPostalCode } from '../db/parcels.js'
import { carrierHealth } from '../db/health.js'
import { getIngestStatus } from '../db/ingest-status.js'
import { getPickupCode, pickupCodesFor } from '../db/pickup-codes.js'
import { dismissMessage } from '../db/messages.js'
import { addParcel, cleanPostcode, MAX_LABEL } from './actions.js'
import { applySettings, settingsValues, submittedSettings, type SettingsValues } from './settings.js'
import { probeImap, type ImapProbeLike, type ImapProbeResult } from '../ingest/imap-probe.js'
import type { ImapConfig } from '../ingest/imap.js'
import { settingsPage, type SettingsState } from './views/settings.js'
import { CARRIER_NAME } from './views/format.js'
import {
  deliveryStats, getUnparsedMessage, listUnparsedMessages, rawResponsesFor,
} from './queries.js'
import type { Html } from './views/html.js'
import { addPage } from './views/add.js'
import { attentionPage, type AttentionError } from './views/attention.js'
import { healthPage } from './views/health.js'
import { pollerStatus } from '../core/pollwatch.js'
import { appVersion } from '../core/version.js'
import { historyPage } from './views/history.js'
import { indexPage, type RefreshNote } from './views/index.js'
import { parcelPage } from './views/parcel.js'
import { DateTime } from 'luxon'
import type { PageCtx } from './views/layout.js'

export interface WebDeps {
  db: Database
  config: Config
  /**
   * The config file `config` was loaded from: the settings page reads it back and writes it. Defaults
   * to the file the runtime entry points load, which is the right answer for a real server - but a
   * test that posts to `/settings` must pass a temp path, or it would write the user's own config.
   */
  configPath?: string
  /** The remaining dependencies exist so tests can run a refresh without the network or a real banner. */
  http?: HttpClient
  adapters?: CarrierAdapter[]
  notifier?: Notifier
  now?: () => Date
  /** The map-tile cache; defaults to `data/tiles` beside the database, as the poller writes it. */
  tileDir?: string
  /** The IMAP client the connection test uses; injected so tests never touch the network. */
  imapClient?: (config: ImapConfig) => ImapProbeLike
  /**
   * What `/health` reports as the running version. Defaults to this checkout, resolved once (see
   * core/version.ts); injected by tests, which must not depend on the commit they happen to run at.
   */
  version?: string
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

/**
 * The Host header is part of the security boundary, not decoration: refusing a foreign one is what stops a
 * page on the open web from resolving its own domain to 127.0.0.1 and reading this unauthenticated server
 * (DNS rebinding). `parcels.local` is allowed because it is not a name anyone else can make a browser send
 * here: it resolves only through this machine's /etc/hosts, so reaching the server under it means the user
 * typed it. Keep this list exhaustive and anchored - a bare suffix match would let `parcels.local.evil.example` in.
 */
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|parcels\.local)(:\d+)?$/i

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
  const { db } = deps
  /**
   * What this process is running on. `deps.config` is what it STARTED on, and the settings page can
   * change the file underneath it, so this is a holder rather than a constant: a successful save
   * replaces it, and every route that reads config (the default postcode on /add, the map preview,
   * whether /health says mail is configured) follows the new file without a restart. `port` and
   * `dbPath` are never replaced - the socket is open and the database is open - which is exactly why
   * the page shows those two read-only.
   */
  let config = deps.config
  const configPath = deps.configPath ?? runtimeConfigPath()
  const tileDir = deps.tileDir ?? tileDirFor(config.dbPath)
  const app = Fastify({ logger: false })
  // Resolved once here, never per request: it reads package.json and spawns git.
  const version = deps.version ?? appVersion()
  const now = () => (deps.now ?? (() => new Date()))()
  /** What every page needs besides its own data: the clock, and carrier health (for the lede and the nav dot). */
  const ctx = (): PageCtx => ({ now: now(), health: carrierHealth(db), pollerOverdue: pollerStatus(db, now()).overdue })

  // Without authentication, a page the user happens to visit must not be able to drive this server:
  // a foreign Host header is a DNS-rebinding attempt, and a cross-site POST is a forged form. The Origin
  // of a write must be THIS server (same host and port), not merely some loopback address: another dev
  // server on localhost is just as foreign.
  app.addHook('onRequest', async (req, reply) => {
    // Second layer behind the structural escaping: even injected markup could load nothing and run nothing.
    // `img-src 'self'` is the one addition the map preview needs, and it is the narrowest one that
    // works: the tiles are served by this server from its own on-disk cache, so no third-party origin
    // appears here and the page still cannot load or run anything from anywhere else.
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'")
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
    const active = listActive(db)
    // One query for every code on the page, rather than one per parcel inside the card renderer.
    const codes = pickupCodesFor(db, active.filter(p => p.status === 'ready_for_pickup').map(p => p.id))
    const entries = active.map(parcel => ({ parcel, last: latestEvent(db, parcel.id), code: codes.get(parcel.id) }))
    return send(reply, indexPage(entries, ctx(), refreshNote(req.query as Record<string, unknown>)))
  })

  /**
   * The tile grid to draw for a parcel, or nothing. Three conditions, all of them cheap: the preview is
   * on, the parcel is waiting for collection, and its point has coordinates. Then nine `existsSync`
   * calls decide whether a complete map can be drawn. No network, ever: the cache was filled by a poll.
   */
  const mapFor = (parcel: Parcel) => {
    const { lat, lon } = parcel.pickup ?? {}
    if (!config.mapPreview || parcel.status !== 'ready_for_pickup') return undefined
    if (lat === undefined || lon === undefined) return undefined
    return cachedGrid(tileDir, lat, lon)
  }

  app.get<{ Params: { id: string } }>('/parcel/:id', async (req, reply) => {
    const parcel = /^\d+$/.test(req.params.id) ? getParcel(db, Number(req.params.id)) : undefined
    if (!parcel) return reply.code(404).type('text/plain').send('no such parcel')
    return send(reply, parcelPage(
      parcel, listEvents(db, parcel.id), rawResponsesFor(db, parcel.id, parcel.carrier), ctx(),
      refreshNote(req.query as Record<string, unknown>), mapFor(parcel),
      parcel.status === 'ready_for_pickup' ? getPickupCode(db, parcel.id) : undefined,
    ))
  })

  /**
   * One cached map tile, read from `data/tiles` and nothing else.
   *
   * The three parameters arrive as arbitrary strings - Fastify percent-decodes them, so `..%2f..%2f`
   * reaches this handler as a real `../../` - and the only defence that matters is that they are
   * never used as strings. `parseTile` either returns three integers in range or nothing, and the
   * path is assembled from those integers, so there is no spelling of this URL that names a file
   * outside the cache. A tile that is not cached is a 404; this route never fetches anything.
   */
  app.get<{ Params: { z: string; x: string; y: string } }>('/tile/:z/:x/:y.png', async (req, reply) => {
    if (!config.mapPreview) return notFound(reply)
    const tile = parseTile(req.params.z, req.params.x, req.params.y)
    const bytes = tile && readTile(tileDir, tile)
    if (!bytes) return notFound(reply)
    // A given z/x/y is the same picture for months, and it is already on local disk; a day of browser
    // caching saves the re-request without ever making the page depend on a remote service.
    return reply.code(200).type('image/png').header('cache-control', 'private, max-age=86400').send(bytes)
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
    return send(reply, healthPage(c.health, { configured: config.imap !== undefined, status: getIngestStatus(db) }, pollerStatus(db, c.now), c, version))
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

  /**
   * The config file as it is on disk, with the reason it would not load if it would not. Read per
   * request, deliberately: `deps.config` is what this process started with, and after a save (here,
   * in another tab, or by hand) that is no longer what the file says. The file is a few hundred bytes
   * and settings requests are rare, so reading it is cheaper than any scheme for keeping a copy true.
   */
  const current = (): { doc: ConfigDocument; valid?: Config; error?: string } => {
    const doc = readConfigDocument(configPath)
    try {
      return { doc, valid: validateConfig(doc, configPath) }
    } catch (err) {
      return { doc, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const settings = (
    reply: FastifyReply, file: { doc: ConfigDocument; error?: string },
    state: SettingsState = {}, values?: SettingsValues, status = 200,
  ) => send(reply, settingsPage(
    values ?? settingsValues(file.doc),
    { port: config.port, dbPath: config.dbPath, configPath },
    ctx(), { ...state, configError: file.error },
  ), status)

  app.get('/settings', async (req, reply) =>
    settings(reply, current(), { saved: one((req.query as Record<string, unknown>).saved) === '1' }))

  app.post('/settings', async (req, reply) => {
    const f = form(req)
    const file = current()
    const result = applySettings(file.doc, f)
    if (!result.ok) return settings(reply, file, { error: result.message }, submittedSettings(f, file.doc), 400)
    // Validated against loadConfig's own rules and written atomically at 0600 (writeConfigDocument):
    // a file this app could not load would stop the poller AND this server at their next start.
    const saved = writeConfigDocument(configPath, result.doc)
    // `port` and `dbPath` are bound to the open socket and the open database, so they stay as they are.
    config = { ...saved, port: config.port, dbPath: config.dbPath }
    return reply.redirect('/settings?saved=1', 303)
  })

  /**
   * The connection test. POST, not GET, because it opens a TLS connection to the mail server, and a
   * page must not do that because it was prefetched or reloaded.
   *
   * It tests the settings as SAVED, not as typed, so the answer is about the configuration the poller
   * will use. `probeImap` opens the mailbox read-only, never rejects, and keeps the App Password out
   * of its result, so a failure is an answer on the page and not a 500 with a credential in the log.
   */
  app.post('/settings/test', async (_req, reply) => {
    const file = current()
    if (!file.valid) return settings(reply, file)   // the page explains why the file will not load
    const imap = file.valid.imap
    const test: ImapProbeResult = await probeImap({ config: imap, client: imap && deps.imapClient?.(imap) })
    return settings(reply, file, { test })
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

  // Junk mail with no tracking number is not a parcel and never will be, so it must be possible to
  // take it off the list. `getUnparsedMessage` is the same guard the assign route uses, so a stale page
  // or a double submit is a 404 rather than a second write. No confirm step: nothing is destroyed here.
  app.post<{ Params: { messageId: string } }>('/attention/:messageId/dismiss', async (req, reply) => {
    const messageId = Number(req.params.messageId)
    const message = Number.isInteger(messageId) ? getUnparsedMessage(db, messageId) : undefined
    if (!message) return notFound(reply)
    dismissMessage(db, messageId)
    return reply.redirect('/attention', 303)
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

  // Irreversible, so the confirm step is the `<details>` disclosure on the parcel page itself (there is no
  // JS for a dialog, and a separate confirm page would be a second route showing what the page already
  // shows). The page it redirects to cannot be this parcel's: it no longer exists.
  app.post<{ Params: { id: string } }>('/parcel/:id/delete', async (req, reply) => {
    const parcel = parcelFor(req.params.id)
    if (!parcel) return notFound(reply)
    deleteParcel(db, parcel.id)
    return reply.redirect('/', 303)
  })

  // A real poll, run from this process. The click is the user saying "now", so the per-parcel backoff tier is
  // skipped (`forceAll`), but only for the parcels they pointed at: `forceAll` skips `isDue` entirely, which
  // would also wake dormant parcels, so the set is chosen here. The gated-carrier throttle and the
  // needs_postcode skip are applied by `runPoll` regardless, so clicking cannot hammer a broken carrier.
  // A notifier is passed so a status change found here is announced, not consumed.
  //
  // No `mapPreview` here, deliberately: geocoding is rate-limited to one request per second and that
  // limit can only be held if ONE process does it. The hourly poller is that process. A click would
  // also have to wait out those politeness gaps before the redirect. So a pickup point found by a
  // manual refresh gets its map at the next hourly poll, and shows the address link until then.
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
