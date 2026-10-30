import { beforeEach, describe, expect, test } from 'vitest'
import { allAdapters, detectCarrier, getAdapter, normalizeNumber, register, resolveCarrier } from '../../src/carriers/registry.js'
import { dhlCarrier } from '../../src/carriers/dhl.js'
import { emailOnlyCarriers, isEmailOnlyCarrier, isPollable } from '../../src/core/types.js'
import type { CarrierId } from '../../src/core/types.js'

// Importing the registry registered the real carriers; take them so a test that replaces one can put it back.
const real = allAdapters()

describe('DHL number shapes (prefixed forms only)', () => {
  beforeEach(() => { for (const c of real) register(c) })

  test.each([
    ['JJD0099990758473189', 'Express / Parcel waybill'],
    ['JJD000390005576658', 'a shorter JJD waybill'],
    ['JVGL06356000000800052612', 'DHL Parcel Europe'],
    ['3SABCD1234567890', 'DHL Parcel Benelux'],
    ['0001234567890123', 'the long leading-zero eCommerce form (16 digits)'],
  ])('%s routes to DHL alone (%s)', number => {
    expect(detectCarrier(number)).toEqual(['dhl'])
    expect(resolveCarrier(number)).toEqual({ ok: true, carrier: 'dhl' })
  })

  test('a spaced JJD number normalises and still routes to DHL', () => {
    expect(detectCarrier(normalizeNumber('JJD 0099 9907 5847 3189'))).toEqual(['dhl'])
  })

  test('a bare ten-digit number is GLS and nothing else: it is never ambiguous', () => {
    expect(detectCarrier('1234567890')).toEqual(['gls'])
    expect(resolveCarrier('1234567890')).toEqual({ ok: true, carrier: 'gls' })
    // The real GLS fixture number: twelve digits that happen to start with three zeros.
    expect(detectCarrier('000000000001')).toEqual(['gls'])
    expect(resolveCarrier('000000000001')).toEqual({ ok: true, carrier: 'gls' })
    expect(detectCarrier('0000000001')).toEqual(['gls'])
  })

  test('the lengths the other bare-digit carriers own are never claimed by DHL', () => {
    expect(detectCarrier('00012345678901')).toEqual(['dpd'])    // 14 digits is dpd's
    expect(detectCarrier('000123456789012')).toEqual(['dpd'])   // 15 digits is dpd's longer form
    expect(detectCarrier('7031234567890123')).toEqual(['sps'])  // 703-prefixed 16 digits stays sps
  })

  test('a shape that merely starts like a DHL number is not one', () => {
    for (const n of ['JJD', 'JJD123', 'XJJD0099990758473189', 'JVGL123', '3S123', '000', '0001234567890']) {
      expect(detectCarrier(n)).not.toContain('dhl')
    }
  })
})

describe('DHL is an email-only carrier, not a missing adapter', () => {
  beforeEach(() => { for (const c of real) register(c) })

  test('it is registered, so the ingest can create its parcels', () => {
    expect(getAdapter('dhl').id).toBe('dhl')
    expect(allAdapters().map(c => c.id).sort()).toEqual(['dhl', 'dpd', 'gls', 'packeta', 'posta', 'ppl', 'sps'])
  })

  test('it declares itself unpollable and has no fetch to call', () => {
    expect(isPollable(dhlCarrier)).toBe(false)
    expect('fetch' in dhlCarrier).toBe(false)
    expect(dhlCarrier.pollable).toBe(false)
  })

  test('every other registered carrier is pollable', () => {
    const notPollable = allAdapters().filter(c => !isPollable(c)).map(c => c.id)
    expect(notPollable).toEqual(['dhl'])
  })

  test('the email-only carrier list and the registered carriers cannot drift apart', () => {
    const declared = emailOnlyCarriers().sort()
    const registered = allAdapters().filter(c => !isPollable(c)).map(c => c.id).sort()
    expect(registered).toEqual(declared)
    for (const id of declared) expect(isEmailOnlyCarrier(id)).toBe(true)
    for (const id of ['posta', 'packeta', 'gls', 'sps', 'dpd'] as CarrierId[]) expect(isEmailOnlyCarrier(id)).toBe(false)
  })
})
