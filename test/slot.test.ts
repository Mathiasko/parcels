import { test, expect } from 'vitest'
import { slotFor } from '../src/core/backoff.js'

test('slotFor numbers the 07:00-21:00 Europe/Bratislava window 0..14', () => {
  expect(slotFor(new Date('2026-07-13T05:00:00Z'))).toBe(0)    // 07:00 CEST
  expect(slotFor(new Date('2026-07-13T19:00:00Z'))).toBe(14)   // 21:00 CEST
  expect(slotFor(new Date('2026-12-14T06:00:00Z'))).toBe(0)    // 07:00 CET: same slot, different UTC hour
})

test('slotFor clamps runs outside the window instead of inventing slots', () => {
  expect(slotFor(new Date('2026-12-14T02:30:00Z'))).toBe(0)    // 03:30 local
  expect(slotFor(new Date('2026-12-14T21:30:00Z'))).toBe(14)   // 22:30 local
})
