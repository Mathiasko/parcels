import { describe, test, expect, beforeEach } from 'vitest'
import {
  normalizeNumber, detectCarrier, register, getAdapter, allAdapters,
} from '../src/carriers/registry.js'
import type { CarrierAdapter, CarrierId } from '../src/core/types.js'

// Importing the registry registered the five real adapters; take them before the stand-ins below replace them.
const real = allAdapters()

// Lightweight stand-ins with deliberately overlapping shapes, to exercise the ordering independent of the real regexes.
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

describe('with stand-in adapters', () => {
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
})

describe('with the real adapters', () => {
  beforeEach(() => { for (const a of real) register(a) })

  test('all five adapters are registered', () => {
    expect(allAdapters().map(a => a.id).sort()).toEqual(['dpd', 'gls', 'packeta', 'posta', 'sps'])
    expect(real.map(a => a.id).sort()).toEqual(['dpd', 'gls', 'packeta', 'posta', 'sps'])
    for (const id of ['dpd', 'gls', 'packeta', 'posta', 'sps'] as CarrierId[]) expect(getAdapter(id).id).toBe(id)
  })

  test('each real adapter claims its own number shape', () => {
    expect(detectCarrier('RA123456785SK')).toEqual(['posta'])
    expect(detectCarrier('Z1234567890')).toEqual(['packeta'])
    expect(detectCarrier('7031234567890123')).toEqual(['sps'])
    expect(detectCarrier('01234567890123')).toEqual(['dpd'])
    expect(detectCarrier('31217533227')).toEqual(['gls'])
  })

  test('detectCarrier prefers the distinctive carriers over the ambiguous ones', () => {
    // No two real shapes overlap today, so widen the ambiguous pair to claim everything and check that
    // posta, packeta and sps still come first, and that dpd precedes gls.
    register({ ...getAdapter('gls'), matches: () => true })
    register({ ...getAdapter('dpd'), matches: () => true })
    expect(detectCarrier('RA123456785SK')).toEqual(['posta', 'dpd', 'gls'])
    expect(detectCarrier('Z1234567890')).toEqual(['packeta', 'dpd', 'gls'])
    expect(detectCarrier('7031234567890123')).toEqual(['sps', 'dpd', 'gls'])
    expect(detectCarrier('HELLO')).toEqual(['dpd', 'gls'])
  })
})
