import type { EmailOnlyCarrier } from '../core/types.js'

/**
 * DHL, tracked from mail alone (design spec §6.6 and §6.7).
 *
 * There is no `fetch` here, and that is the whole point. DHL's "Shipment Tracking — Unified" API
 * needs a `DHL-API-Key`, and the user's developer app is in `revoked` status, so no key exists to
 * use. Scraping is excluded on the record: `https://www.dhl.com/utapi` answers an automated request
 * with a page reading *"Automated extraction of information by bots, website scraping etc. is
 * prohibited"* — a stated prohibition plus an implemented block. So this carrier is an
 * `EmailOnlyCarrier`: never polled, never counted as a broken carrier, and tracked from DHL's own
 * dispatch and pickup mail, which the ingest already reads.
 *
 * If a key is ever issued, this file gains a real adapter and the carrier stops being email-only;
 * nothing else about the parcel changes.
 */

/**
 * Prefixed forms ONLY — the decision recorded in §6.6.
 *
 * A DHL Express number is ten plain digits and GLS already claims `^\d{10,12}$`. Accepting the bare
 * Express form would make every ten-digit number ambiguous and break auto-detection for the GLS
 * parcels that work today, so a bare Express number has to be added with the carrier chosen
 * explicitly (`cli add --carrier dhl`, or the picker on `/add`) — and mail ingest disambiguates by
 * sender domain anyway, which is how most parcels arrive.
 *
 *   JJD…    Express and Parcel waybills
 *   JVGL…   DHL Parcel Europe
 *   3S…     DHL Parcel Benelux (letters and digits after the prefix)
 *   000…    the long leading-zero eCommerce/Parcel form
 *
 * The `000…` floor of 16 digits is load-bearing, not cosmetic: it clears GLS (10-12 digits) and both
 * of DPD's lengths (`^\d{14}[0-9A-Z]?$`, so 14 and 15), which is what keeps every number those two
 * own out of DHL's hands. No check digit is published for any of these forms, so a typo is only
 * caught by a human reading the parcel's mail.
 */
const NUMBER_SHAPES = [
  /^JJD\d{10,22}$/,
  /^JVGL\d{10,22}$/,
  /^3S[A-Z0-9]{8,18}$/,
  /^000\d{13,25}$/,
]

export const dhlCarrier: EmailOnlyCarrier = {
  id: 'dhl',
  pollable: false,
  matches: number => NUMBER_SHAPES.some(shape => shape.test(number)),
}
