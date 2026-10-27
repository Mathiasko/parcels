import { describe, test, expect, beforeEach } from 'vitest'
import {
  normalizeNumber, canonicalNumber, detectCarrier, register, getAdapter, allAdapters, resolveCarrier,
} from '../src/carriers/registry.js'
import type { CarrierAdapter, CarrierId } from '../src/core/types.js'
import { isPollable } from '../src/core/types.js'

// Importing the registry registered the real carriers; take them before the stand-ins below replace them.
const real = allAdapters()
/** The five that are polled; dhl is email-only and has no adapter (see test/carriers/dhl.test.ts). */
const POLLED: CarrierId[] = ['dpd', 'gls', 'packeta', 'posta', 'sps']
const ALL: CarrierId[] = [...POLLED, 'dhl' as CarrierId].sort()

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
  gls: /^\d{10,12}$/,
  dpd: /^\d{14}[A-Z0-9]?$/,
  dhl: /^JJD\d{10,22}$/,
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
  test('resolveCarrier: an explicit carrier wins without a shape check; auto-detect needs exactly one match', () => {
    expect(resolveCarrier('GARBAGE', 'posta')).toEqual({ ok: true, carrier: 'posta' })
    expect(resolveCarrier('RA123456785SK')).toEqual({ ok: true, carrier: 'posta' })
    expect(resolveCarrier('GARBAGE')).toEqual({ ok: false, candidates: [] })
    register(stub('gls', /^\d{11,14}$/))   // make a bare 14-digit number ambiguous
    const r = resolveCarrier('01234567890123')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.candidates.length).toBeGreaterThan(1)
  })

  test('getAdapter returns a registered adapter and throws for an unregistered one', () => {
    expect(getAdapter('posta').id).toBe('posta')
    expect(() => getAdapter('nope' as CarrierId)).toThrow(/nope/)
    expect(allAdapters().map(a => a.id).sort()).toEqual(ALL)
  })
})

describe('with the real adapters', () => {
  beforeEach(() => { for (const a of real) register(a) })

  test('all six carriers are registered: five polled adapters and one email-only', () => {
    expect(allAdapters().map(a => a.id).sort()).toEqual(ALL)
    expect(real.map(a => a.id).sort()).toEqual(ALL)
    for (const id of ALL) expect(getAdapter(id).id).toBe(id)
    expect(allAdapters().filter(isPollable).map(a => a.id).sort()).toEqual(POLLED)
  })

  test('each real adapter claims its own number shape', () => {
    expect(detectCarrier('JJD0099990758473189')).toEqual(['dhl'])
    expect(detectCarrier('RA123456785SK')).toEqual(['posta'])
    expect(detectCarrier('Z1234567890')).toEqual(['packeta'])
    expect(detectCarrier('7031234567890123')).toEqual(['sps'])
    expect(detectCarrier('SK0TEST6000000000X')).toEqual(['sps'])
    expect(detectCarrier('01234567890123')).toEqual(['dpd'])
    expect(detectCarrier('31217533227')).toEqual(['gls'])
  })

  test('a 10-digit number (the live GLS parcel length) is gls and nothing else; 9 and 13 are nobody', () => {
    expect(detectCarrier('1234567890')).toEqual(['gls'])
    expect(resolveCarrier('1234567890')).toEqual({ ok: true, carrier: 'gls' })
    expect(detectCarrier('123456789')).toEqual([])
    expect(detectCarrier('1234567890123')).toEqual([])
    expect(detectCarrier('12345678901234')).toEqual(['dpd'])   // 14 digits stays dpd's, not gls's
    expect(detectCarrier('Z1234567890')).toEqual(['packeta'])   // Z + 10 is not read as 10 bare digits
  })

  test('the SK-prefixed SPS form and the S10 Slovenska posta form never collide', () => {
    expect(detectCarrier('SK0TEST6000000000X')).toEqual(['sps'])
    expect(detectCarrier('RA123456785SK')).toEqual(['posta'])
    expect(detectCarrier(normalizeNumber('sk0tes t600 0000000x'))).toEqual(['sps'])
  })

  // --- canonicalNumber: the leading-zero reconciliation ------------------------------------------

  test('the two forms of the real GLS shipment canonicalise to one number', () => {
    // Straight out of the author's database: one shipment, ingested from two different emails, once
    // zero-padded to 11 digits by the shop's mail and once bare at 10 by GLS's own.
    expect(canonicalNumber('gls', '01928813352')).toBe('1928813352')
    expect(canonicalNumber('gls', '1928813352')).toBe('1928813352')
    expect(canonicalNumber('gls', '001928813352')).toBe('1928813352')
  })

  test('canonicalNumber stops at the shortest form the carrier itself still accepts', () => {
    // 10 digits is GLS's floor: stripping this zero would leave 9 digits, which GLS does not claim,
    // so the zero is part of the number and stays.
    expect(canonicalNumber('gls', '0123456789')).toBe('0123456789')
    expect(canonicalNumber('gls', '0012345678')).toBe('0012345678')
    expect(canonicalNumber('gls', '000000000001')).toBe('0000000001')
  })

  test('a leading zero stays significant for every carrier that counts digits', () => {
    // DHL's eCommerce form IS its leading zeros (`^000\d{13,25}$`) and DPD's shape is fixed-width,
    // so stripping there would not reconcile two numbers, it would destroy one.
    expect(canonicalNumber('dhl', '0001234567890123')).toBe('0001234567890123')
    expect(canonicalNumber('dpd', '01505515835276')).toBe('01505515835276')
    // The two that would really collapse if the rule were let loose on every carrier: DPD's shape
    // takes 14 digits OR 15, so stripping a 15-digit number lands on a DIFFERENT, equally valid DPD
    // number; and `000` + 13-to-25 digits does the same for DHL whenever the fourth digit is a zero.
    expect(canonicalNumber('dpd', '015055158352761')).toBe('015055158352761')
    expect(canonicalNumber('dhl', '0000123456789012345')).toBe('0000123456789012345')
    expect(canonicalNumber('packeta', 'Z0000000001')).toBe('Z0000000001')
    expect(canonicalNumber('posta', 'RA123456785SK')).toBe('RA123456785SK')
    expect(canonicalNumber('sps', '7031234567890123')).toBe('7031234567890123')
    expect(canonicalNumber('sps', 'SK0TEST6000000000X')).toBe('SK0TEST6000000000X')
  })

  test('canonicalNumber collapses no two numbers that genuinely differ, for any carrier', () => {
    const numbers: [CarrierId, string][] = [
      ['gls', '1928813352'], ['gls', '1234567890'], ['gls', '1234567891'], ['gls', '31217533227'],
      ['gls', '123456789012'], ['gls', '0123456789'], ['gls', '0012345678'], ['gls', '000000000001'],
      ['dpd', '01505515835276'], ['dpd', '11505515835276'], ['dpd', '00000000000008'],
      ['dpd', '015055158352761'], ['dpd', '15055158352761'],
      ['packeta', 'Z0000000001'], ['packeta', 'Z1234567890'],
      ['posta', 'RA123456785SK'], ['posta', 'RA987654326SK'],
      ['sps', '7031234567890123'], ['sps', 'SK0TEST6000000000X'],
      ['dhl', '0001234567890123'], ['dhl', '0001234567890124'], ['dhl', 'JJD0099990758473189'],
      ['dhl', '0000123456789012345'], ['dhl', '000123456789012345'],
    ]
    const seen = new Map<string, string>()
    for (const [carrier, n] of numbers) {
      const key = `${carrier} ${canonicalNumber(carrier, n)}`
      expect(seen.get(key) ?? n).toBe(n)   // nothing else has already canonicalised to this
      seen.set(key, n)
    }
    expect(seen.size).toBe(numbers.length)
  })

  test('a number the carrier does not claim is left verbatim: an explicit carrier is not shape-checked', () => {
    // `resolveCarrier` lets the user force a carrier for a number that fails `matches`. Canonicalising
    // such a number would be guesswork, so it is stored and looked up exactly as typed.
    expect(canonicalNumber('gls', '0GARBAGE')).toBe('0GARBAGE')
    expect(canonicalNumber('gls', '0123456789012345')).toBe('0123456789012345')
    // The one that matters: 13 digits is not a GLS number, but strip a zero and 12 digits is. Rewriting
    // a forced number the carrier never claimed could hand it the identity of a real GLS parcel.
    expect(canonicalNumber('gls', '0123456789012')).toBe('0123456789012')
    expect(canonicalNumber('gls', '')).toBe('')
  })

  test('normalizeNumber keeps leading zeros: the carrier is not known yet when it runs', () => {
    // Detection runs on normalizeNumber's output, and DHL and DPD are recognised BY their digit count.
    expect(normalizeNumber('0 1928 8133 52')).toBe('01928813352')
    expect(detectCarrier(normalizeNumber('000 1234 5678 90123'))).toEqual(['dhl'])
    expect(detectCarrier(normalizeNumber('0150 5515 8352 76'))).toEqual(['dpd'])
  })

  test('detectCarrier prefers the distinctive carriers over the ambiguous ones', () => {
    // No two real shapes overlap today, so widen the ambiguous pair to claim everything and check that
    // posta, packeta and sps still come first, and that dpd precedes gls.
    register({ ...(getAdapter('gls') as CarrierAdapter), matches: () => true })
    register({ ...(getAdapter('dpd') as CarrierAdapter), matches: () => true })
    expect(detectCarrier('RA123456785SK')).toEqual(['posta', 'dpd', 'gls'])
    expect(detectCarrier('Z1234567890')).toEqual(['packeta', 'dpd', 'gls'])
    expect(detectCarrier('7031234567890123')).toEqual(['sps', 'dpd', 'gls'])
    expect(detectCarrier('HELLO')).toEqual(['dpd', 'gls'])
  })
})
