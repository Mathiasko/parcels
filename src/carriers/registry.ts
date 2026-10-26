import type { CarrierAdapter, CarrierId } from '../core/types.js'

const adapters = new Map<CarrierId, CarrierAdapter>()

/** Most specific shape first. gls (11-12 bare digits) and dpd (14 digits) are ambiguous, so last. */
const DETECT_ORDER: readonly CarrierId[] = ['posta', 'packeta', 'sps', 'dpd', 'gls']

export function register(a: CarrierAdapter): void {
  adapters.set(a.id, a)
}

export function getAdapter(id: CarrierId): CarrierAdapter {
  const a = adapters.get(id)
  if (!a) throw new Error(`no adapter registered for carrier "${id}"`)
  return a
}

export function allAdapters(): CarrierAdapter[] {
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
