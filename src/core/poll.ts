import type { Database } from '../db/index.js'
import type { Config } from './config.js'
import type {
  CarrierAdapter, CarrierId, FetchResult, HttpClient, NewEvent, ParcelEvent,
} from './types.js'
import type { Notifier } from '../notify/types.js'
import { buildNotifications } from '../notify/rules.js'
import { HttpTransportError, captureBodies } from './http.js'
import { isDue, slotFor } from './backoff.js'
import { dedupHash } from './dedup.js'
import { appendEvents, markNotified, recomputeParcelStatus } from '../db/events.js'
import { carrierHealth, recordHealth, type HealthOutcome, type HealthRow } from '../db/health.js'
import {
  listActive, markAttempted, postcodeRejected, setNeedsPostcode, updateParcelState, type Parcel,
} from '../db/parcels.js'

export interface PollDeps {
  db: Database
  http: HttpClient
  adapters: CarrierAdapter[]
  config: Config
  now: Date
  /** When present, the run's notifications are built and sent; when absent nothing is built at all. */
  notifier?: Notifier
  /**
   * Poll every active parcel regardless of its per-parcel backoff tier (set after a long sleep gap).
   * Overrides the tier ONLY: the gated-carrier throttle and the needs_postcode skip still apply, so a
   * forced refresh can never become a retry storm against a broken carrier.
   */
  forceAll?: boolean
  /** Restricts the run to these parcels (a single-parcel refresh). Every other rule still applies. */
  parcelIds?: number[]
  /** Wired by email ingest (Task 18); not consumed yet. */
  ingest?: unknown
}

export interface PollReport {
  polled: number
  newEvents: NewEvent[]
  failures: Array<{ carrier: CarrierId; reason: string }>
}

const RAW_RESPONSES_KEPT = 5

type Failure = Exclude<HealthOutcome, 'ok'>
const HOUR = 3_600_000
const GATED_MAX_WAIT = 24 * HOUR

/**
 * `thrown`: the adapter call itself threw, which no sibling chunk's success may paper over.
 * `neutral`: the carrier answered but told us nothing about its own health (needs_postcode).
 */
interface Outcome { kind: HealthOutcome | 'neutral'; detail?: string; thrown?: boolean }

/** What one adapter call produced (a result list, or the throw), plus the response bodies it read. */
type Fetched =
  | { chunk: Parcel[]; results: FetchResult[]; bodies: string[] }
  | { chunk: Parcel[]; error: { kind: Failure; detail: string }; bodies: string[] }

const describe = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

/**
 * One run: select due parcels, call each carrier's adapter, store what came back. A carrier that
 * throws, times out or returns something unstorable is recorded as a health failure and the
 * remaining carriers are still polled. Network calls finish before any carrier's writes begin,
 * and each carrier's writes commit in a single transaction.
 */
export async function runPoll(deps: PollDeps): Promise<PollReport> {
  const { db, http, now } = deps
  const slot = slotFor(now)
  const report: PollReport = { polled: 0, newEvents: [], failures: [] }

  const health = new Map(carrierHealth(db).map(h => [h.carrier, h]))
  const byCarrier = new Map<CarrierId, Parcel[]>()
  for (const p of listActive(db)) {
    if (deps.parcelIds && !deps.parcelIds.includes(p.id)) continue
    if (!deps.forceAll && !isDue(p, now, slot)) continue
    // Deterministic: the carrier rejected this exact postcode and would reject it identically for
    // ever, so do not ask. The flag is NOT cleared here: clearing at selection would unflag a
    // parcel whose carrier has no adapter or is throttled, i.e. one that never gets polled at all.
    if (postcodeRejected(p)) continue
    byCarrier.set(p.carrier, [...(byCarrier.get(p.carrier) ?? []), p])
  }

  for (const [carrier, due] of byCarrier) {
    const adapter = deps.adapters.find(a => a.id === carrier)
    if (!adapter) {
      report.failures.push({ carrier, reason: 'no adapter registered' })
      continue
    }
    // A broken adapter (gated) is probed, not polled: nothing at all while its backoff window is
    // open, then exactly one canary parcel once it has elapsed. A canary that succeeds clears the
    // streak, so the next run is a normal one; a failure widens the window.
    const throttle = gatedThrottle(health.get(carrier), now)
    if (throttle === 'wait') continue
    const parcels = throttle === 'canary' ? due.slice(0, 1) : due
    report.polled += parcels.length

    const fetched = await fetchCarrier(adapter, parcels, http)
    try {
      const applied = db.transaction(() => applyCarrier(db, carrier, fetched, now))()
      report.newEvents.push(...applied.newEvents)
      if (applied.failure) report.failures.push({ carrier, reason: applied.failure })
    } catch (err) {
      // The carrier's writes rolled back as a unit; only the attempt stamps and health are kept.
      const detail = describe(err)
      markAttempted(db, parcels.map(p => p.id), now)
      recordHealth(db, carrier, 'parse', detail, now)
      report.failures.push({ carrier, reason: `parse: ${detail}` })
    }
  }
  if (deps.notifier) await notify(deps.notifier, db, report, now, deps.config.port)
  return report
}

/**
 * Delivery is best-effort: the events were marked notified when they were appended, and the rules
 * record what they announce before anything is sent, so a notifier that throws loses a banner and
 * nothing else. A run with no notifier announces nothing and loses nothing: the status changes it
 * stored are still unannounced and the next run with a notifier picks them up. It must never turn a completed poll into a failed run.
 */
async function notify(
  notifier: Notifier, db: Database, report: PollReport, now: Date, port: number,
): Promise<void> {
  try {
    for (const n of buildNotifications(db, report.newEvents, now, port)) {
      try { await notifier.send(n) } catch (err) { console.error(`notify: delivery failed: ${describe(err)}`) }
    }
  } catch (err) {
    console.error(`notify: could not build notifications: ${describe(err)}`)
  }
}

/**
 * How to treat a carrier whose last failure was `gated`. The window is min(2^(failures-1) hours,
 * 24h) from the last error (1h, 2h, 4h ... capped at a day): `wait` while it is open, `canary` once
 * it has elapsed (a window that has exactly elapsed counts), `none` for a carrier not in that state.
 */
function gatedThrottle(h: HealthRow | undefined, now: Date): 'none' | 'wait' | 'canary' {
  if (!h || h.lastErrorKind !== 'gated' || h.consecutiveFailures <= 0 || !h.lastErrorAt) return 'none'
  const wait = Math.min(2 ** (h.consecutiveFailures - 1) * HOUR, GATED_MAX_WAIT)
  return now.getTime() - h.lastErrorAt.getTime() < wait ? 'wait' : 'canary'
}

/** Calls the adapter once per `batchSize` chunk; each call is isolated so one throw loses one chunk. */
async function fetchCarrier(adapter: CarrierAdapter, parcels: Parcel[], http: HttpClient): Promise<Fetched[]> {
  const out: Fetched[] = []
  for (const chunk of chunks(parcels, Math.max(1, adapter.batchSize))) {
    const capture = captureBodies(http)
    try {
      const inputs = chunk.map(p => ({ number: p.trackingNumber, postalCode: p.postalCode }))
      out.push({ chunk, results: await adapter.fetch(inputs, capture.http), bodies: capture.bodies })
    } catch (err) {
      // Never let one carrier take the run down. A transport error means no response arrived; any
      // other throw means a response arrived that the adapter could not make sense of.
      const kind = err instanceof HttpTransportError ? 'transport' : 'parse'
      out.push({ chunk, error: { kind, detail: describe(err) }, bodies: capture.bodies })
    }
  }
  return out
}

function applyCarrier(
  db: Database, carrier: CarrierId, fetched: Fetched[], now: Date,
): { newEvents: NewEvent[]; failure?: string } {
  const newEvents: NewEvent[] = []
  const outcomes: Outcome[] = []

  for (const f of fetched) {
    markAttempted(db, f.chunk.map(p => p.id), now)
    // Every parcel here really was sent, so a rejection recorded against an older postcode is now
    // spent. A fresh `needs_postcode` answer below re-flags it with the postcode just rejected.
    for (const p of f.chunk) if (p.needsPostcode !== undefined) setNeedsPostcode(db, p.id, null)
    if ('error' in f) {
      outcomes.push({ ...f.error, thrown: true })
      for (const body of f.bodies) storeRaw(db, rawOwner(f.chunk), carrier, body, now)
      // Only a lone parcel is known to be the one that could not be read. A batch failure says
      // nothing about any single parcel, so their statuses are left exactly as they were.
      if (f.error.kind === 'parse' && f.chunk.length === 1) {
        const p = f.chunk[0]!
        updateParcelState(db, p.id, { status: 'unknown', statusRaw: p.statusRaw })
      }
      continue
    }
    // Nothing in the response was usable. The adapter swallowed the problem into per-number
    // `transport` results, so keep the body that explains it (once per chunk).
    if (f.results.every(r => !r.ok && r.reason === 'transport')) {
      for (const body of f.bodies) storeRaw(db, rawOwner(f.chunk), carrier, body, now)
    }
    const byNumber = new Map(f.results.map(r => [r.number, r]))
    for (const p of f.chunk) {
      const r = byNumber.get(p.trackingNumber)
      if (!r) {
        outcomes.push({ kind: 'transport', detail: `no result for ${p.trackingNumber}` })
      } else if (r.ok) {
        newEvents.push(...applyOk(db, p, r, now))
        outcomes.push({ kind: 'ok' })
      } else if (r.reason === 'gated' || r.reason === 'transport') {
        outcomes.push({ kind: r.reason, detail: `${r.reason} for ${p.trackingNumber}` })
      } else if (r.reason === 'needs_postcode') {
        // The parcel is not being tracked: record WHICH postcode was rejected, so it is never sent
        // again under that postcode. The carrier's own statusDetail is left alone and lastPolledAt
        // stays put, since no tracking information was actually obtained.
        setNeedsPostcode(db, p.id, p.postalCode ?? '')
        outcomes.push({ kind: 'neutral' })
      } else {
        // not_found (a freshly announced parcel) is normal, not an alarm.
        updateParcelState(db, p.id, {
          status: p.status, statusRaw: p.statusRaw, statusDetail: p.statusDetail, lastPolledAt: now,
        })
        outcomes.push({ kind: 'ok' })
      }
    }
  }

  const verdict = carrierVerdict(outcomes)
  if (!verdict) return { newEvents }   // only needs_postcode answers: no information about carrier health
  recordHealth(db, carrier, verdict.kind, verdict.detail, now)
  return { newEvents, failure: verdict.kind === 'ok' ? undefined : `${verdict.kind}: ${verdict.detail}` }
}

/**
 * `gated` always wins: the adapter itself is broken. Next, any adapter call that threw: a sibling
 * chunk succeeding does not make that carrier healthy. Otherwise one parcel's trouble does not
 * indict the carrier while any other parcel got a real answer; with none, the first failure does.
 */
function carrierVerdict(outcomes: Outcome[]): (Outcome & { kind: HealthOutcome }) | undefined {
  const informative = outcomes.filter((o): o is Outcome & { kind: HealthOutcome } => o.kind !== 'neutral')
  const gated = informative.find(o => o.kind === 'gated')
  if (gated) return gated
  const thrown = informative.find(o => o.thrown)
  if (thrown) return thrown
  if (informative.some(o => o.kind === 'ok')) return { kind: 'ok' }
  return informative[0]
}

function applyOk(db: Database, p: Parcel, r: Extract<FetchResult, { ok: true }>, now: Date): NewEvent[] {
  const inserted = appendEvents(db, p.id, r.events)
  markAppendedNotified(db, p.id, inserted, now)

  let movedAt = p.lastChangedAt
  for (const e of inserted) if (!movedAt || e.occurredAt > movedAt) movedAt = e.occurredAt
  updateParcelState(db, p.id, {
    status: r.status,
    statusRaw: r.statusRaw,
    statusDetail: r.statusDetail,
    pickup: r.pickup,
    retainedTill: r.retainedTill,
    lastPolledAt: now,
    lastChangedAt: movedAt !== p.lastChangedAt ? movedAt : undefined,
  })
  recomputeParcelStatus(db, p.id, r.status, now)
  storeRaw(db, p.id, p.carrier, JSON.stringify(r.raw), now)
  return inserted.map(e => ({ ...e, parcelId: p.id }))
}

/**
 * Every event appended in a run is marked notified here, before any notifier runs, whether or not it
 * produces a notification (the rules work from the run's `newEvents`, never from the table). A new
 * parcel's first poll appends its entire history, and leaving that unmarked would later fire a banner
 * for every scan from weeks ago.
 */
function markAppendedNotified(db: Database, parcelId: number, appended: ParcelEvent[], now: Date): void {
  const find = db.prepare('SELECT id FROM events WHERE parcel_id = ? AND dedup_hash = ?')
  const ids = appended.map(e => (find.get(parcelId, dedupHash(e)) as { id: number }).id)
  markNotified(db, ids, now)
}

/** A body from a multi-parcel chunk belongs to no single parcel, so it is stored with a null parcel. */
const rawOwner = (chunk: Parcel[]): number | null => (chunk.length === 1 ? chunk[0]!.id : null)

function storeRaw(db: Database, parcelId: number | null, carrier: CarrierId, body: string, now: Date): void {
  db.prepare('INSERT INTO raw_responses (parcel_id, carrier, fetched_at, body) VALUES (?, ?, ?, ?)')
    .run(parcelId, carrier, now.toISOString(), body)
  // Last N per parcel; the parcel-less bodies are bounded the same way, per carrier.
  db.prepare(`
    DELETE FROM raw_responses
    WHERE carrier = ? AND parcel_id IS ? AND id NOT IN (
      SELECT id FROM raw_responses WHERE carrier = ? AND parcel_id IS ? ORDER BY id DESC LIMIT ?
    )
  `).run(carrier, parcelId, carrier, parcelId, RAW_RESPONSES_KEPT)
}

/** One line for logs: `polled 3 parcels, 2 new events, 1 carrier failed (gls: gated ...)`. */
export function summarize(report: PollReport): string {
  const failed = report.failures.length === 0
    ? ''
    : `, ${report.failures.length} carrier failure(s) (${report.failures.map(f => `${f.carrier}: ${f.reason}`).join('; ')})`
  return `polled ${report.polled} parcel(s), ${report.newEvents.length} new event(s)${failed}`
}
