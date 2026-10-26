import { test, expect, beforeEach } from 'vitest'
import {
  normalizeNumber, detectCarrier, register, getAdapter, allAdapters,
} from '../src/carriers/registry.js'
import type { CarrierAdapter, CarrierId } from '../src/core/types.js'

// Lightweight local stand-ins: the real adapters (and their real regexes) arrive in later tasks.
const stub = (id: CarrierId, shape: RegExp): CarrierAdapter => ({
  id,
  matches: n => shape.test(n),
  needsPostalCode: false,
  batchSize: 1,
  fetch: async () => [],
})

const shapes: Record<CarrierId, RegExp> = {
  posta: /^[A-Z]{2}\d{9}SK$/,
  packeta: /^Z\d{10}$/,
  sps: /^703\d{11}[0-4]\d$/,
  gls: /^\d{11,12}$/,
  dpd: /^\d{14}[A-Z0-9]?$/,
}

beforeEach(() => {
  // register in deliberately scrambled order to prove detectCarrier does its own ordering
  for (const id of ['dpd', 'gls', 'sps', 'packeta', 'posta'] as CarrierId[]) register(stub(id, shapes[id]))
})

test('normalizeNumber strips spaces and dashes and uppercases', () => {
  expect(normalizeNumber(' z 123 4567 890 ')).toBe('Z1234567890')
  expect(normalizeNumber('ra123456785sk')).toBe('RA123456785SK')
  expect(normalizeNumber('703-1234567890-12')).toBe('703123456789012')
})
test('detectCarrier identifies a Packeta number from a spaced label form', () => {
  expect(detectCarrier(normalizeNumber('Z 123 4567 890'))).toEqual(['packeta'])
})
test('detectCarrier identifies Slovenska posta from an S10 number', () => {
  expect(detectCarrier('RA123456785SK')).toEqual(['posta'])
})
test('detectCarrier returns SPS for a 703-prefixed 16-digit number', () => {
  expect(detectCarrier('7031234567890123')).toContain('sps')
})
test('detectCarrier returns multiple candidates for a bare 14-digit number', () => {
  // gls is loosened here so both ambiguous carriers claim the number
  register(stub('gls', /^\d{11,14}$/))
  expect(detectCarrier('01234567890123')).toEqual(['dpd', 'gls'])
})
test('detectCarrier returns gls for a bare 11-digit number', () => {
  expect(detectCarrier('31217533227')).toContain('gls')
})
test('detectCarrier returns an empty array for nonsense', () => {
  expect(detectCarrier('HELLO')).toEqual([])
})

test('detectCarrier orders distinctive carriers before ambiguous ones', () => {
  // a greedy gls shape overlaps sps on a 703… number; sps is distinctive so it must come first
  register(stub('gls', /^\d+$/))
  expect(detectCarrier('7031234567890123')).toEqual(['sps', 'gls'])
})
test('getAdapter returns a registered adapter and throws for an unregistered one', () => {
  expect(getAdapter('posta').id).toBe('posta')
  expect(() => getAdapter('nope' as CarrierId)).toThrow(/nope/)
  expect(allAdapters().map(a => a.id).sort()).toEqual(['dpd', 'gls', 'packeta', 'posta', 'sps'])
})
