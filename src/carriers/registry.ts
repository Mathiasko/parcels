import type { Carrier, CarrierId } from '../core/types.js'
import { dhlCarrier } from './dhl.js'
import { dpdAdapter } from './dpd.js'
import { glsAdapter } from './gls.js'
import { packetaAdapter } from './packeta.js'
import { postaAdapter } from './posta.js'
import { pplAdapter } from './ppl.js'
import { spsAdapter } from './sps.js'

const adapters = new Map<CarrierId, Carrier>()

/**
 * Most specific shape first. gls (10-12 bare digits) and dpd (14 digits) are ambiguous, so last.
 * dhl sits with the distinctive carriers: its shapes are all prefixed, and the one bare-digit form it
 * accepts is 16 digits or more, which no other carrier claims.
 *
 * ppl is registered but deliberately NOT listed. Its numbers are 11 bare digits, which is also a GLS
 * shape, and nothing in the digits tells the two apart. Listing it would turn every 11-digit number
 * into "GLS or PPL?" and make Detect refuse numbers it answers today; listing it before gls would
 * silently move GLS parcels to PPL. So Detect never returns PPL: it is chosen on Add, or comes from
 * mail that says it is PPL.
 */
const DETECT_ORDER: readonly CarrierId[] = ['posta', 'packeta', 'sps', 'dhl', 'dpd', 'gls']

export function register(a: Carrier): void {
  adapters.set(a.id, a)
}

/**
 * A registered carrier, which may be an email-only one (`isPollable` narrows it). Throws for an id
 * nobody registered: that is a missing adapter, which is a different thing from a carrier that is
 * deliberately never polled.
 */
export function getAdapter(id: CarrierId): Carrier {
  const a = adapters.get(id)
  if (!a) throw new Error(`no adapter registered for carrier "${id}"`)
  return a
}

export function allAdapters(): Carrier[] {
  return [...adapters.values()]
}

/**
 * Uppercases and strips everything that is not A-Z or 0-9 (spaces, dashes, ...).
 *
 * Deliberately carrier-BLIND, and leading zeros survive it: `detectCarrier` runs on this function's
 * output, and DHL and DPD are recognised BY their digits. See `canonicalNumber` for the rest.
 */
export function normalizeNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Carriers that zero-pad: the same shipment can be written with or without insignificant leading
 * zeros, so the two forms have to be reconciled to one.
 *
 * GLS is the one case in evidence. Parcels 39 and 40 in the author's database were one GLS shipment
 * ingested from two emails - `01928813352` from the shop and `1928813352` from GLS itself - which
 * `findParcel` read as two different parcels, and so created a second one.
 *
 * Nobody else may be in here. A leading zero is NOT generally insignificant:
 *   - DHL's eCommerce form IS its leading zeros (`^000\d{13,25}$`): strip them and the number matches
 *     no carrier at all;
 *   - DPD is fixed-width (`^\d{14}[0-9A-Z]?$`), so a stripped number is simply not a DPD number;
 *   - Packeta (`Z` + 10 digits), Posta and SPS carry letters, and their zeros sit behind them.
 * For all of those, stripping would not reconcile two spellings of one number, it would destroy one.
 */
const ZERO_PADDED: ReadonlySet<CarrierId> = new Set<CarrierId>(['gls'])

/**
 * The one spelling of a tracking number that a carrier's parcel is stored and looked up under.
 *
 * This is carrier-AWARE and therefore cannot live in `normalizeNumber`, which runs before the carrier
 * is known (detection consumes its output) and must not touch the digits detection keys on. The rule
 * is applied once, at the database boundary (`insertParcel` and `findParcel`), so every caller - mail
 * ingest, `cli add`, the web form - gets it without having to remember it.
 *
 * For a padded carrier: strip leading zeros one at a time for as long as the carrier's OWN `matches()`
 * still claims the result, which lands on the shortest form it accepts (GLS: 10 digits, so
 * `001928813352` -> `1928813352` but `0123456789` is left alone, its zero being load-bearing). Asking
 * the adapter rather than restating its regex here is what keeps the two from drifting apart.
 *
 * Two genuinely different numbers can only collide when one is the zero-padded spelling of the other,
 * which is the very ambiguity the carrier creates: GLS publishes no check digit, so `01928813352` and
 * `1928813352` are indistinguishable by any means other than asking GLS. A number the carrier does NOT
 * claim is returned verbatim - `resolveCarrier` lets the user force a carrier for a number that fails
 * the shape check, and canonicalising that would be guesswork.
 */
export function canonicalNumber(carrier: CarrierId, number: string): string {
  if (!ZERO_PADDED.has(carrier)) return number
  const matches = adapters.get(carrier)?.matches
  if (matches === undefined || !matches(number)) return number
  let n = number
  while (n.startsWith('0') && matches(n.slice(1))) n = n.slice(1)
  return n
}

/** Carriers whose `matches()` accepts the (already normalised) number, most specific first. */
export function detectCarrier(number: string): CarrierId[] {
  return DETECT_ORDER.filter(id => adapters.get(id)?.matches(number) === true)
}

export type CarrierResolution =
  | { ok: true; carrier: CarrierId }
  /** Auto-detection failed: `candidates` is empty (nothing matched) or has several entries (ambiguous). */
  | { ok: false; candidates: CarrierId[] }

/**
 * The one place a parcel's carrier is decided, shared by `cli add` and the web UI so they cannot drift.
 * An explicit choice always wins and is NOT checked against `matches()`: it is the user's escape hatch
 * when detection fails, and a real number can fail the shape check. A bad number only ever yields a
 * `not_found` that goes dormant. Only the auto-detect path is validated: exactly one carrier must match.
 */
export function resolveCarrier(number: string, explicit?: CarrierId): CarrierResolution {
  if (explicit !== undefined) return { ok: true, carrier: explicit }
  const candidates = detectCarrier(number)
  if (candidates.length === 1) return { ok: true, carrier: candidates[0]! }
  return { ok: false, candidates }
}

// Adapters do not register themselves; this is the one place that does. Order here is irrelevant:
// detectCarrier applies DETECT_ORDER.
for (const adapter of [postaAdapter, packetaAdapter, glsAdapter, spsAdapter, dpdAdapter, pplAdapter, dhlCarrier]) register(adapter)
