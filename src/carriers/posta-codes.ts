import type { CanonicalStatus } from '../core/types.js'

/** `stateCode` values from the Slovenská pošta T&T manual. None of them means failure or loss. */
const STATE_CODES = new Map<string, CanonicalStatus>(Object.entries({
  received: 'pre_transit',
  transit: 'in_transit',
  notified: 'ready_for_pickup',
  delivered: 'delivered',
  returning: 'returning',
  returned: 'returned',
}))

/**
 * `detailCode` overrides. Failure, loss and damage exist only here, never in `stateCode`.
 * Only the handful that change the canonical status are listed; every other detail code
 * falls through to the `stateCode` mapping.
 */
const DETAIL_CODES = new Map<string, CanonicalStatus>(Object.entries({
  ANZ: 'failed_attempt',      // addressee not reached
  'P-NOL': 'returning',       // uncollected, going back to sender
  ZSTR: 'problem',            // lost
  ZZNC: 'problem',            // destroyed
  REKL: 'problem',            // under complaint
  ZNP1: 'ready_for_pickup',
  OKP: 'delivered',
  OKB: 'delivered',
}))

export function mapPostaStatus(stateCode: string | undefined, detailCode: string | undefined): CanonicalStatus {
  const override = detailCode === undefined ? undefined : DETAIL_CODES.get(detailCode)
  if (override) return override
  const mapped = stateCode === undefined ? undefined : STATE_CODES.get(stateCode)
  if (mapped) return mapped
  console.warn(`posta: unmapped stateCode ${JSON.stringify(stateCode)}, treating as unknown`)
  return 'unknown'
}
