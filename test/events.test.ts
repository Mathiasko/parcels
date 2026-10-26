import { test, expect, beforeEach } from 'vitest'
import { openDb, type Database } from '../src/db/index.js'
import { insertParcel, findParcel } from '../src/db/parcels.js'
import {
  appendEvents, latestEvent, recomputeParcelStatus, unnotifiedEvents, markNotified,
} from '../src/db/events.js'
import { dedupHash } from '../src/core/dedup.js'
import type { ParcelEvent } from '../src/core/types.js'

let db: Database
let parcelId: number
beforeEach(() => {
  db = openDb(':memory:')
  parcelId = insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z1234567890', source: 'manual' })
})

const ev = (raw: string, over: Partial<ParcelEvent> = {}): ParcelEvent => ({
  occurredAtRaw: raw,
  occurredAtTz: 'Europe/Prague',
  occurredAt: new Date(raw.replace(' ', 'T') + 'Z'),
  status: 'in_transit',
  code: 'C1',
  description: `event at ${raw}`,
  ...over,
})

const three = [
  ev('2026-04-29 08:00:00', { status: 'pre_transit' }),
  ev('2026-04-29 10:00:00'),
  ev('2026-04-29 12:00:00', { status: 'out_for_delivery' }),
]

test('appendEvents returns the inserted events on first call', () => {
  const inserted = appendEvents(db, parcelId, three)
  expect(inserted).toEqual(three)
})
test('appendEvents returns empty on a second identical call', () => {
  appendEvents(db, parcelId, three)
  expect(appendEvents(db, parcelId, three)).toEqual([])
})
test('appendEvents returns only the genuinely new event when history grows', () => {
  appendEvents(db, parcelId, three)
  const fourth = ev('2026-04-29 14:00:00', { status: 'delivered' })
  expect(appendEvents(db, parcelId, [...three, fourth])).toEqual([fourth])
})
test('dedupHash ignores location and status but distinguishes description', () => {
  const a = ev('2026-04-29 08:00:00', { location: 'Praha', status: 'in_transit' })
  const b = ev('2026-04-29 08:00:00', { location: 'Brno', status: 'problem' })
  const c = ev('2026-04-29 08:00:00', { description: 'something else entirely' })
  expect(dedupHash(a)).toBe(dedupHash(b))
  expect(dedupHash(a)).not.toBe(dedupHash(c))
})
test('recomputeParcelStatus sets status from the newest event by occurredAt', () => {
  // newest by occurredAt is inserted FIRST, so insertion order != chronological order
  appendEvents(db, parcelId, [
    ev('2026-04-29 12:00:00', { status: 'out_for_delivery' }),
    ev('2026-04-29 08:00:00', { status: 'pre_transit' }),
  ])
  recomputeParcelStatus(db, parcelId)
  expect(findParcel(db, 'packeta', 'Z1234567890')!.status).toBe('out_for_delivery')
  expect(latestEvent(db, parcelId)!.status).toBe('out_for_delivery')
})
test('recomputeParcelStatus sets delivered_at when the newest event is delivered', () => {
  appendEvents(db, parcelId, [...three, ev('2026-04-29 14:00:00', { status: 'delivered' })])
  recomputeParcelStatus(db, parcelId)
  const p = findParcel(db, 'packeta', 'Z1234567890')!
  expect(p.status).toBe('delivered')
  expect(p.deliveredAt?.toISOString()).toBe('2026-04-29T14:00:00.000Z')
})

test('latestEvent is undefined when a parcel has no events', () => {
  expect(latestEvent(db, parcelId)).toBeUndefined()
})
test('recomputeParcelStatus leaves a parcel with no events untouched', () => {
  recomputeParcelStatus(db, parcelId)
  expect(findParcel(db, 'packeta', 'Z1234567890')!.status).toBe('unknown')
})
test('stored events round-trip through latestEvent with all fields', () => {
  const e = ev('2026-04-29 08:00:00', { location: 'Praha', code: undefined })
  appendEvents(db, parcelId, [e])
  const got = latestEvent(db, parcelId)!
  expect(got).toMatchObject(e)
  expect(got.location).toBe('Praha')
  expect(got.code).toBeUndefined()
})
test('unnotifiedEvents lists events until markNotified, then not again', () => {
  appendEvents(db, parcelId, three)
  const pending = unnotifiedEvents(db)
  expect(pending).toHaveLength(3)
  markNotified(db, pending.slice(0, 2).map(e => e.id), new Date('2026-04-29T15:00:00.000Z'))
  const left = unnotifiedEvents(db)
  expect(left).toHaveLength(1)
  expect(left[0]!.id).toBe(pending[2]!.id)
})
