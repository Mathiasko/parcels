import type { CanonicalStatus } from '../core/types.js'

/**
 * `description` of `status` and `parcelHistory[]`: ten coarse milestones. `OTHER` is DPD's catch-all and
 * says nothing about the stage, so it is deliberately absent and maps to `unknown` like any new value.
 * `PARCEL_HANDED` is listed as the acceptance it normally is; `resolveMilestone` demotes it to a hand-off
 * when it turns up after the parcel was already moving.
 */
const MILESTONES = new Map<string, CanonicalStatus>(Object.entries({
  ORDER_CREATED: 'pre_transit',
  PARCEL_HANDED: 'pre_transit',
  IN_TRANSIT: 'in_transit',
  AT_DELIVERY_CENTER: 'in_transit',
  PARCEL_OUT_FOR_DELIVERY: 'out_for_delivery',
  AVAILABLE_FOR_COLLECTION: 'ready_for_pickup',
  // A retry, not a terminal state: the parcel stays active and is never `returned`.
  UNSUCCESSFUL_DELIVERY_ATTEMPT: 'failed_attempt',
  RETURN_TO_SENDER: 'returning',
  DELIVERED: 'delivered',
}))

/** Milestones that can only be reached after DPD already has the parcel. */
const AFTER_ACCEPTANCE = new Set([
  'IN_TRANSIT', 'AT_DELIVERY_CENTER', 'PARCEL_OUT_FOR_DELIVERY', 'AVAILABLE_FOR_COLLECTION',
  'UNSUCCESSFUL_DELIVERY_ATTEMPT', 'RETURN_TO_SENDER', 'DELIVERED',
])

/**
 * `parcelEvents[].eventType`: Geopost scan codes, preferred over the milestones where present.
 * Anything unlisted is `unknown` and logged. `ORI` and `SPL` are deliberately not here: see STAGELESS_CODES.
 */
const SCAN_CODES = new Map<string, CanonicalStatus>(Object.entries({
  // registered, then accepted by DPD
  CNP: 'pre_transit', ORDER_CREATED: 'pre_transit',
  PKY: 'pre_transit', DOPKY: 'pre_transit',
  // in transit
  ORS: 'in_transit', SPX: 'in_transit', LHI: 'in_transit',
  HUI: 'in_transit', HUS: 'in_transit', DLI: 'in_transit', DLS: 'in_transit', DLQ: 'in_transit',
  CCO: 'in_transit', DODEH: 'in_transit',
  DLO: 'out_for_delivery',
  DEHD: 'ready_for_pickup', DEHDY: 'ready_for_pickup', DODEI: 'ready_for_pickup', DOMSDLO: 'ready_for_pickup',
  DEY: 'delivered', DEYY: 'delivered', DODEY: 'delivered', DODEYY: 'delivered',
  DEX: 'failed_attempt', DEXD: 'failed_attempt', DLR: 'failed_attempt', DLW: 'failed_attempt',
}))

/**
 * Scan codes that are notices, not movements (a delivery estimate, DPD-internal data exchange, ...).
 * They must never set the parcel's status.
 */
const NOTICE_CODES = new Set(['SPE', 'MSDLO', 'MSDLX', 'MIDLI', 'MIA', 'MII', 'ENA'])

/**
 * `ORI` and `SPL` occur on both sides of the origin depot, so they name no stage: seen before acceptance
 * they must not read as in_transit. They are handled like notices.
 */
const STAGELESS_CODES = new Set(['ORI', 'SPL'])

/** Codes that carry the status already in force instead of setting one. */
export const isNoticeCode = (code: string): boolean => NOTICE_CODES.has(code) || STAGELESS_CODES.has(code)

/** `undefined` for a code that is not a known scan code (the caller logs it). Notices are not looked up here. */
export const scanCodeStatus = (code: string): CanonicalStatus | undefined => SCAN_CODES.get(code)

/**
 * Status of a milestone. `earlier` holds the milestone descriptions DPD dated BEFORE this one: a
 * `PARCEL_HANDED` that follows later-stage milestones is another country's DPD unit taking the parcel
 * over (the milestone is re-dated), so the parcel is in transit rather than newly accepted.
 * `undefined` for an unknown description (the caller logs it).
 */
export function resolveMilestone(description: string, earlier: readonly string[]): CanonicalStatus | undefined {
  if (description === 'PARCEL_HANDED' && earlier.some(d => AFTER_ACCEPTANCE.has(d))) return 'in_transit'
  return MILESTONES.get(description)
}
