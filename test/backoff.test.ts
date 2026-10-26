import { test, expect } from 'vitest'
import { isDue } from '../src/core/backoff.js'
import type { Parcel } from '../src/db/parcels.js'

const NOW = new Date('2026-10-26T09:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const SLOTS = Array.from({ length: 15 }, (_, i) => i)   // 07:00..21:00
const ANY_SLOT = 5

const ago = (ms: number) => new Date(NOW.getTime() - ms)
const ahead = (ms: number) => new Date(NOW.getTime() + ms)

function parcel(over: Partial<Parcel> = {}): Parcel {
  return {
    id: 1, carrier: 'posta', trackingNumber: 'RA123456785SK', status: 'in_transit',
    firstSeenAt: ago(60 * DAY), lastChangedAt: ago(HOUR), source: 'manual', ...over,
  }
}

const dueSlots = (p: Parcel) => SLOTS.filter(s => isDue(p, NOW, s))

test('out_for_delivery is due every slot', () => {
  // idle for 20 days to prove the status alone decides it
  expect(dueSlots(parcel({ status: 'out_for_delivery', lastChangedAt: ago(20 * DAY) }))).toEqual(SLOTS)
})

test('ready_for_pickup is due every slot', () => {
  expect(dueSlots(parcel({ status: 'ready_for_pickup', lastChangedAt: ago(20 * DAY) }))).toEqual(SLOTS)
})

test('in_transit moved within 48h is due every slot', () => {
  expect(dueSlots(parcel({ lastChangedAt: ago(47 * HOUR) }))).toEqual(SLOTS)
})

test('in_transit idle 3 days is due only when not polled for 2.5 hours', () => {
  const idle = { lastChangedAt: ago(3 * DAY) }
  expect(isDue(parcel({ ...idle, lastPolledAt: ago(HOUR) }), NOW, ANY_SLOT)).toBe(false)
  expect(isDue(parcel({ ...idle, lastPolledAt: ago(2 * HOUR) }), NOW, ANY_SLOT)).toBe(false)
  expect(isDue(parcel({ ...idle, lastPolledAt: ago(3 * HOUR) }), NOW, ANY_SLOT)).toBe(true)
  expect(isDue(parcel(idle), NOW, ANY_SLOT)).toBe(true)   // never polled
})

test('idle more than 7 days is due once a day, whenever the Mac was last awake to poll it', () => {
  const idle = { lastChangedAt: ago(8 * DAY) }
  expect(isDue(parcel({ ...idle, lastPolledAt: ago(19 * HOUR) }), NOW, 0)).toBe(false)
  // sleeping through 07:00 must not skip the day: any slot qualifies once enough time has passed
  expect(isDue(parcel({ ...idle, lastPolledAt: ago(21 * HOUR) }), NOW, ANY_SLOT)).toBe(true)
  expect(isDue(parcel({ ...idle, lastPolledAt: ago(24 * HOUR) }), NOW, 14)).toBe(true)
})

test('retained_till within 48h is due every slot even when idle for weeks', () => {
  const idle = { lastChangedAt: ago(21 * DAY) }
  expect(dueSlots(parcel({ ...idle, retainedTill: ahead(47 * HOUR) }))).toEqual(SLOTS)
  // control: a deadline further out than 48h does not override the idle tier
  const recentlyPolled = { lastPolledAt: ago(HOUR) }
  expect(dueSlots(parcel({ ...idle, ...recentlyPolled, retainedTill: ahead(72 * HOUR) }))).toEqual([])
})

test('delivered is never due', () => {
  expect(dueSlots(parcel({ status: 'delivered' }))).toEqual([])
})

test('returned is never due', () => {
  expect(dueSlots(parcel({ status: 'returned' }))).toEqual([])
})

test('no events for over 30 days is never due', () => {
  // lastChangedAt is only ever set when an event is seen, so undefined means "no events at all"
  const noEvents = { status: 'pre_transit' as const, lastChangedAt: undefined }
  expect(dueSlots(parcel({ ...noEvents, firstSeenAt: ago(31 * DAY) }))).toEqual([])
  // control: the same parcel at 29 days is merely in the once-a-day tier
  const at29 = { ...noEvents, firstSeenAt: ago(29 * DAY) }
  expect(isDue(parcel({ ...at29, lastPolledAt: ago(HOUR) }), NOW, ANY_SLOT)).toBe(false)
  expect(isDue(parcel({ ...at29, lastPolledAt: ago(21 * HOUR) }), NOW, ANY_SLOT)).toBe(true)
})
