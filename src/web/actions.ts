import type { Config } from '../core/config.js'
import type { CarrierId } from '../core/types.js'
import { normalizeNumber, resolveCarrier } from '../carriers/registry.js'
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

/**
 * Why a request was refused, as data rather than prose: `message` is worded for the web form, and
 * `cli add` words the same refusal for a terminal from this. Same decision, each surface its own words.
 */
export type AddProblem =
  | { kind: 'no_number' }
  | { kind: 'too_long' }
  | { kind: 'unknown_carrier' }
  /** Auto-detection found no carrier, or more than one (`candidates`), for the normalised `number`. */
  | { kind: 'carrier_unclear'; number: string; candidates: CarrierId[] }

export type AddResult =
  | { ok: true; id: number }
  | { ok: false; status: 400; message: string; problem: AddProblem }
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
 * Adds a parcel: normalised number, carrier auto-detected unless chosen, the configured default
 * postcode when none is given, every field bounded. The web form and `cli add` both call this, so the
 * two cannot drift. Failures are values with a readable message (and the `problem` behind it).
 */
export function addParcel(db: Database, config: Config, req: AddRequest): AddResult {
  // Bound the input before normalising it: a huge paste is never a tracking number.
  const number = req.number.length > 4 * MAX_NUMBER ? '' : normalizeNumber(req.number)
  if (number === '') return { ok: false, status: 400, message: 'Enter a tracking number.', problem: { kind: 'no_number' } }
  if (number.length > MAX_NUMBER) {
    return { ok: false, status: 400, message: 'That tracking number is too long.', problem: { kind: 'too_long' } }
  }

  let chosen: CarrierId | undefined
  if (req.carrier) {
    if (!isCarrierId(req.carrier)) {
      return { ok: false, status: 400, message: 'Unknown carrier. Choose one from the list.', problem: { kind: 'unknown_carrier' } }
    }
    chosen = req.carrier
  }
  // An explicit carrier overrides the shape check (as in `cli add --carrier`); only auto-detect is validated.
  const resolved = resolveCarrier(number, chosen)
  if (!resolved.ok) {
    const { candidates } = resolved
    const message = candidates.length === 0
      ? `Could not tell which carrier ${number} belongs to. Choose one from the list.`
      : `${number} could be ${candidates.map(c => CARRIER_NAME[c]).join(' or ')}. Choose one from the list.`
    return { ok: false, status: 400, message, problem: { kind: 'carrier_unclear', number, candidates } }
  }
  const carrier = resolved.carrier

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
