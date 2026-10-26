import type { Database } from '../db/index.js'
import type { Config } from './config.js'
import type {
  CarrierAdapter, CarrierId, FetchResult, HttpClient, ParcelEvent,
} from './types.js'
import { HttpTransportError, captureBodies } from './http.js'
import { isDue, slotFor } from './backoff.js'
import { dedupHash } from './dedup.js'
import { appendEvents, markNotified, recomputeParcelStatus } from '../db/events.js'
import { recordHealth, type HealthOutcome } from '../db/health.js'
import { listActive, updateParcelState, type Parcel } from '../db/parcels.js'

export interface PollDeps {
  db: Database
  http: HttpClient
  adapters: CarrierAdapter[]
  config: Config
  now: Date
  /** Wired by the notification rules (Task 13); not consumed yet. */
  notifier?: unknown
  /** Wired by email ingest (Task 18); not consumed yet. */
  ingest?: unknown
}

export interface PollReport {
  polled: number
  newEvents: ParcelEvent[]
  failures: Array<{ carrier: CarrierId; reason: string }>
}

const RAW_RESPONSES_KEPT = 5

type Failure = Exclude<HealthOutcome, 'ok'>
interface Outcome { kind: HealthOutcome; detail?: string }

/** What one adapter call produced: results, or the reason it threw plus the bodies it had read. */
type Fetched =
  | { chunk: Parcel[]; results: FetchResult[] }
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

  const byCarrier = new Map<CarrierId, Parcel[]>()
  for (const p of listActive(db)) {
    if (!isDue(p, now, slot)) continue
    byCarrier.set(p.carrier, [...(byCarrier.get(p.carrier) ?? []), p])
  }

  for (const [carrier, parcels] of byCarrier) {
    const adapter = deps.adapters.find(a => a.id === carrier)
    if (!adapter) {
      report.failures.push({ carrier, reason: 'no adapter registered' })
      continue
    }
    report.polled += parcels.length

    const fetched = await fetchCarrier(adapter, parcels, http)
    try {
      const applied = db.transaction(() => applyCarrier(db, carrier, fetched, now))()
      report.newEvents.push(...applied.newEvents)
      if (applied.failure) report.failures.push({ carrier, reason: applied.failure })
    } catch (err) {
      // The carrier's writes rolled back as a unit; only the health row is kept.
      const detail = describe(err)
      recordHealth(db, carrier, 'parse', detail, now)
      report.failures.push({ carrier, reason: `parse: ${detail}` })
    }
  }
  return report
}

/** Calls the adapter once per `batchSize` chunk; each call is isolated so one throw loses one chunk. */
async function fetchCarrier(adapter: CarrierAdapter, parcels: Parcel[], http: HttpClient): Promise<Fetched[]> {
  const out: Fetched[] = []
  for (const chunk of chunks(parcels, Math.max(1, adapter.batchSize))) {
    const capture = captureBodies(http)
    try {
      const inputs = chunk.map(p => ({ number: p.trackingNumber, postalCode: p.postalCode }))
      out.push({ chunk, results: await adapter.fetch(inputs, capture.http) })
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
): { newEvents: ParcelEvent[]; failure?: string } {
  const newEvents: ParcelEvent[] = []
  const outcomes: Outcome[] = []

  for (const f of fetched) {
    if ('error' in f) {
      outcomes.push(f.error)
      if (f.error.kind === 'parse') {
        for (const p of f.chunk) {
          for (const body of f.bodies) storeRaw(db, p.id, carrier, body, now)
          updateParcelState(db, p.id, { status: 'unknown', statusRaw: p.statusRaw })
        }
      }
      continue
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
      } else {
        // not_found (a freshly announced parcel) and needs_postcode are normal, not alarms.
        updateParcelState(db, p.id, {
          status: p.status, statusRaw: p.statusRaw, statusDetail: p.statusDetail, lastPolledAt: now,
        })
        outcomes.push({ kind: 'ok' })
      }
    }
  }

  const verdict = carrierVerdict(outcomes)
  recordHealth(db, carrier, verdict.kind, verdict.detail, now)
  return { newEvents, failure: verdict.kind === 'ok' ? undefined : `${verdict.kind}: ${verdict.detail}` }
}

/**
 * `gated` always wins: the adapter itself is broken. Otherwise one parcel's trouble does not
 * indict the carrier while any other parcel got a real answer; with none, the first failure does.
 */
function carrierVerdict(outcomes: Outcome[]): Outcome {
  const gated = outcomes.find(o => o.kind === 'gated')
  if (gated) return gated
  if (outcomes.some(o => o.kind === 'ok')) return { kind: 'ok' }
  return outcomes[0] ?? { kind: 'ok' }
}

function applyOk(db: Database, p: Parcel, r: Extract<FetchResult, { ok: true }>, now: Date): ParcelEvent[] {
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
  recomputeParcelStatus(db, p.id)
  storeRaw(db, p.id, p.carrier, JSON.stringify(r.raw), now)
  return inserted
}

/**
 * Every event appended in a run is marked notified here, whether or not it produces a notification
 * (the rules arrive in Task 13). A new parcel's first poll appends its entire history, and leaving
 * that unmarked would later fire a banner for every scan from weeks ago.
 */
function markAppendedNotified(db: Database, parcelId: number, appended: ParcelEvent[], now: Date): void {
  const find = db.prepare('SELECT id FROM events WHERE parcel_id = ? AND dedup_hash = ?')
  const ids = appended.map(e => (find.get(parcelId, dedupHash(e)) as { id: number }).id)
  markNotified(db, ids, now)
}

function storeRaw(db: Database, parcelId: number, carrier: CarrierId, body: string, now: Date): void {
  db.prepare('INSERT INTO raw_responses (parcel_id, carrier, fetched_at, body) VALUES (?, ?, ?, ?)')
    .run(parcelId, carrier, now.toISOString(), body)
  db.prepare(`
    DELETE FROM raw_responses
    WHERE parcel_id = ? AND id NOT IN (
      SELECT id FROM raw_responses WHERE parcel_id = ? ORDER BY id DESC LIMIT ?
    )
  `).run(parcelId, parcelId, RAW_RESPONSES_KEPT)
}

/** One line for logs: `polled 3 parcels, 2 new events, 1 carrier failed (gls: gated ...)`. */
export function summarize(report: PollReport): string {
  const failed = report.failures.length === 0
    ? ''
    : `, ${report.failures.length} carrier failure(s) (${report.failures.map(f => `${f.carrier}: ${f.reason}`).join('; ')})`
  return `polled ${report.polled} parcel(s), ${report.newEvents.length} new event(s)${failed}`
}
