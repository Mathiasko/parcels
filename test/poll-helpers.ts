import { openDb, type Database } from '../src/db/index.js'
import { insertParcel } from '../src/db/parcels.js'
import type {
  CarrierAdapter, CarrierId, FetchInput, FetchResult, HttpClient, ParcelEvent,
} from '../src/core/types.js'
import { DEFAULT_NOTIFICATIONS, type Config } from '../src/core/config.js'

/** 2026-10-26 11:00 in Europe/Bratislava (CET): slot 4. */
export const NOW = new Date('2026-10-26T10:00:00Z')

export const config: Config = { dbPath: ':memory:', port: 0, defaultPostalCode: '81101', notifier: 'auto', mapPreview: true, notifications: DEFAULT_NOTIFICATIONS, filterVersion: 1 }

export const memDb = (): Database => openDb(':memory:')

/** Inserts a parcel first seen at NOW, so the tests do not depend on the wall clock. */
export function addParcel(db: Database, carrier: CarrierId, trackingNumber: string, postalCode?: string): number {
  const id = insertParcel(db, { carrier, trackingNumber, postalCode, source: 'manual' })
  db.prepare('UPDATE parcels SET first_seen_at = ? WHERE id = ?').run(NOW.toISOString(), id)
  return id
}

/** A scan from 1-2 hours before NOW, so the parcel stays inside the "moved within 48h" tier. */
export function ev(raw: string, status: ParcelEvent['status'], hoursAgo = 1, description = raw): ParcelEvent {
  return {
    occurredAtRaw: raw, occurredAtTz: 'Europe/Bratislava', status, description,
    occurredAt: new Date(NOW.getTime() - hoursAgo * 3_600_000),
  }
}

export const okResult = (number: string, events: ParcelEvent[], extra: Partial<Extract<FetchResult, { ok: true }>> = {}): FetchResult => ({
  ok: true, number, status: events.at(-1)?.status ?? 'pre_transit', statusRaw: 'raw', events, raw: { number, events: events.length }, ...extra,
})

export const failResult = (number: string, reason: 'not_found' | 'needs_postcode' | 'gated' | 'transport'): FetchResult =>
  ({ ok: false, number, reason })

export interface StubAdapter extends CarrierAdapter { calls: FetchInput[][] }

/** Adapter whose fetch is supplied by the test; records every batch it was handed. */
export function stubAdapter(
  id: CarrierId,
  respond: (inputs: FetchInput[], http: HttpClient) => Promise<FetchResult[]> | FetchResult[],
  batchSize = 1,
): StubAdapter {
  const calls: FetchInput[][] = []
  return {
    id, batchSize, needsPostalCode: false, matches: () => false, calls,
    fetch: async (inputs, http) => { calls.push(inputs); return respond(inputs, http) },
  }
}

/** HttpClient serving one canned body; any use of the network by mistake is impossible. */
export const bodyHttp = (body = ''): HttpClient => async () => ({
  status: 200, headers: {}, text: async () => body, json: async <T>() => JSON.parse(body) as T,
})
