import type { Config } from '../core/config.js'
import type { CarrierId } from '../core/types.js'
import { detectCarrier, getAdapter, normalizeNumber } from '../carriers/registry.js'
import type { Database } from '../db/index.js'
import { findParcel, insertParcel } from '../db/parcels.js'
import { CARRIER_NAME } from './views/format.js'

export interface AddRequest {
  number: string
  carrier?: string
  label?: string
  postcode?: string
  source: 'manual' | 'email'
  sourceMessageId?: string
}

export type AddResult =
  | { ok: true; id: number }
  | { ok: false; status: 400; message: string }
  /** The parcel is already tracked; `existingId` lets a caller link to it instead of failing. */
  | { ok: false; status: 409; message: string; existingId: number }

const CARRIER_IDS = Object.keys(CARRIER_NAME) as CarrierId[]
const isCarrierId = (s: string): s is CarrierId => (CARRIER_IDS as string[]).includes(s)

/** Field limits, shared by every route that stores user-typed text. */
export const MAX_LABEL = 200
const MAX_NUMBER = 40
const MAX_POSTCODE = 12

/** Whitespace is never part of a postcode ("811 01" -> "81101"). */
export const cleanPostcode = (s: string | undefined): string => (s ?? '').replace(/\s+/g, '').slice(0, MAX_POSTCODE)

/**
 * Adds a parcel the way `cli add` does: normalised number, carrier auto-detected unless chosen, the
 * configured default postcode when none is given. Failures are values with a readable message.
 */
export function addParcel(db: Database, config: Config, req: AddRequest): AddResult {
  // Bound the input before normalising it: a huge paste is never a tracking number.
  const number = req.number.length > 4 * MAX_NUMBER ? '' : normalizeNumber(req.number)
  if (number === '') return { ok: false, status: 400, message: 'Enter a tracking number.' }
  if (number.length > MAX_NUMBER) return { ok: false, status: 400, message: 'That tracking number is too long.' }

  let carrier: CarrierId
  if (req.carrier) {
    if (!isCarrierId(req.carrier)) return { ok: false, status: 400, message: 'Unknown carrier. Choose one from the list.' }
    carrier = req.carrier
    // A chosen carrier still has to be one the number could belong to; otherwise garbage is stored and then polled.
    if (!getAdapter(carrier).matches(number)) {
      return { ok: false, status: 400, message: `${number} does not look like a ${CARRIER_NAME[carrier]} tracking number.` }
    }
  } else {
    const candidates = detectCarrier(number)
    if (candidates.length === 0) {
      return { ok: false, status: 400, message: `Could not tell which carrier ${number} belongs to. Choose one from the list.` }
    }
    if (candidates.length > 1) {
      return { ok: false, status: 400, message: `${number} could be ${candidates.map(c => CARRIER_NAME[c]).join(' or ')}. Choose one from the list.` }
    }
    carrier = candidates[0]!
  }

  const existing = findParcel(db, carrier, number)
  if (existing) {
    return { ok: false, status: 409, existingId: existing.id, message: `Already tracking ${number} (${CARRIER_NAME[carrier]}) as #${existing.id}.` }
  }
  const id = insertParcel(db, {
    carrier,
    trackingNumber: number,
    label: req.label?.slice(0, MAX_LABEL) || undefined,
    postalCode: cleanPostcode(req.postcode) || config.defaultPostalCode,
    source: req.source,
    sourceMessageId: req.sourceMessageId,
  })
  return { ok: true, id }
}
