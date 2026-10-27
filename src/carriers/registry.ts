import type { Carrier, CarrierId } from '../core/types.js'
import { dhlCarrier } from './dhl.js'
import { dpdAdapter } from './dpd.js'
import { glsAdapter } from './gls.js'
import { packetaAdapter } from './packeta.js'
import { postaAdapter } from './posta.js'
import { spsAdapter } from './sps.js'

const adapters = new Map<CarrierId, Carrier>()

/**
 * Most specific shape first. gls (10-12 bare digits) and dpd (14 digits) are ambiguous, so last.
 * dhl sits with the distinctive carriers: its shapes are all prefixed, and the one bare-digit form it
 * accepts is 16 digits or more, which no other carrier claims.
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

/** Uppercases and strips everything that is not A-Z or 0-9 (spaces, dashes, ...). */
export function normalizeNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
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
for (const adapter of [postaAdapter, packetaAdapter, glsAdapter, spsAdapter, dpdAdapter, dhlCarrier]) register(adapter)
