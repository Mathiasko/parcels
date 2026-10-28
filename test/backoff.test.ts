import { test, expect } from 'vitest'
import { isDue } from '../src/core/backoff.js'
import type { Parcel } from '../src/db/parcels.js'

const NOW = new Date('2026-10-26T09:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

const ago = (ms: number) => new Date(NOW.getTime() - ms)
const ahead = (ms: number) => new Date(NOW.getTime() + ms)

function parcel(over: Partial<Parcel> = {}): Parcel {
  return {
    id: 1, carrier: 'posta', trackingNumber: 'RA123456785SK', status: 'in_transit',
    lastAnnouncedStatus: 'unknown', pickupAnnounced: false,
    firstSeenAt: ago(60 * DAY), lastChangedAt: ago(HOUR), source: 'manual', ...over,
  }
}

test('out_for_delivery is due every run', () => {
  // idle for 20 days to prove the status alone decides it
  expect(isDue(parcel({ status: 'out_for_delivery', lastChangedAt: ago(20 * DAY) }), NOW)).toBe(true)
})

test('ready_for_pickup is due every run', () => {
  expect(isDue(parcel({ status: 'ready_for_pickup', lastChangedAt: ago(20 * DAY) }), NOW)).toBe(true)
})

test('in_transit moved within 48h is due every run', () => {
  expect(isDue(parcel({ lastChangedAt: ago(47 * HOUR) }), NOW)).toBe(true)
})

test('in_transit idle 3 days is due only when not polled for 2.5 hours', () => {
  const idle = { lastChangedAt: ago(3 * DAY) }
  expect(isDue(parcel({ ...idle, lastPolledAt: ago(HOUR) }), NOW)).toBe(false)
  expect(isDue(parcel({ ...idle, lastPolledAt: ago(2 * HOUR) }), NOW)).toBe(false)
  expect(isDue(parcel({ ...idle, lastPolledAt: ago(3 * HOUR) }), NOW)).toBe(true)
  expect(isDue(parcel(idle), NOW)).toBe(true)   // never polled
})

test('idle more than 7 days is due once a day, whenever the Mac was last awake to poll it', () => {
  const idle = { lastChangedAt: ago(8 * DAY) }
  expect(isDue(parcel({ ...idle, lastPolledAt: ago(19 * HOUR) }), NOW)).toBe(false)
  // sleeping through 07:00 must not skip the day: any run qualifies once enough time has passed
  expect(isDue(parcel({ ...idle, lastPolledAt: ago(21 * HOUR) }), NOW)).toBe(true)
  expect(isDue(parcel({ ...idle, lastPolledAt: ago(24 * HOUR) }), NOW)).toBe(true)
})

test('retained_till within 48h is due every run even when idle for weeks', () => {
  const idle = { lastChangedAt: ago(21 * DAY) }
  expect(isDue(parcel({ ...idle, retainedTill: ahead(47 * HOUR) }), NOW)).toBe(true)
  // control: a deadline further out than 48h does not override the idle tier
  const recentlyPolled = { lastPolledAt: ago(HOUR) }
  expect(isDue(parcel({ ...idle, ...recentlyPolled, retainedTill: ahead(72 * HOUR) }), NOW)).toBe(false)
})

test('delivered is never due', () => {
  expect(isDue(parcel({ status: 'delivered' }), NOW)).toBe(false)
})

test('returned is never due', () => {
  expect(isDue(parcel({ status: 'returned' }), NOW)).toBe(false)
})

test('no events for over 30 days is never due', () => {
  // lastChangedAt is only ever set when an event is seen, so undefined means "no events at all"
  const noEvents = { status: 'pre_transit' as const, lastChangedAt: undefined }
  expect(isDue(parcel({ ...noEvents, firstSeenAt: ago(31 * DAY) }), NOW)).toBe(false)
  // control: the same parcel at 29 days is merely in the once-a-day tier
  const at29 = { ...noEvents, firstSeenAt: ago(29 * DAY) }
  expect(isDue(parcel({ ...at29, lastPolledAt: ago(HOUR) }), NOW)).toBe(false)
  expect(isDue(parcel({ ...at29, lastPolledAt: ago(21 * HOUR) }), NOW)).toBe(true)
})

test('the 2.5 hour and 20 hour gaps are pinned exactly, and a failed attempt counts as a poll', () => {
  const MIN = 60_000
  const mid = { lastChangedAt: ago(3 * DAY) }
  expect(isDue(parcel({ ...mid, lastPolledAt: ago(2.5 * HOUR - 1) }), NOW)).toBe(false)
  expect(isDue(parcel({ ...mid, lastPolledAt: ago(2.5 * HOUR) }), NOW)).toBe(true)
  expect(isDue(parcel({ ...mid, lastPolledAt: ago(2.5 * HOUR + 1) }), NOW)).toBe(true)

  const slow = { lastChangedAt: ago(8 * DAY) }
  expect(isDue(parcel({ ...slow, lastPolledAt: ago(20 * HOUR - 1) }), NOW)).toBe(false)
  expect(isDue(parcel({ ...slow, lastPolledAt: ago(20 * HOUR) }), NOW)).toBe(true)
  expect(isDue(parcel({ ...slow, lastPolledAt: ago(20 * HOUR + 1) }), NOW)).toBe(true)

  // the later of lastPolledAt and lastAttemptedAt wins, in either order
  const failing = { ...slow, lastPolledAt: ago(3 * DAY) }
  expect(isDue(parcel({ ...failing, lastAttemptedAt: ago(10 * MIN) }), NOW)).toBe(false)
  expect(isDue(parcel({ ...slow, lastPolledAt: ago(10 * MIN), lastAttemptedAt: ago(3 * DAY) }), NOW)).toBe(false)
  expect(isDue(parcel({ ...failing, lastAttemptedAt: ago(21 * HOUR) }), NOW)).toBe(true)
})
