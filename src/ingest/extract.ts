import { simpleParser } from 'mailparser'
import type { CarrierId } from '../core/types.js'
import { normalizeNumber } from '../carriers/registry.js'
import { decodeEntities } from '../core/entities.js'

export interface Extraction {
  carrier?: CarrierId
  /** Normalised (upper case, no spaces) tracking number. */
  number?: string
  merchant?: string
  /**
   * `sender`: the carrier came from the sender's domain. `shape`: no known sender, but the carrier
   * and number agree: either the number has a distinctive carrier-specific shape, or (an e-shop's
   * dispatch mail) the text names the carrier AND a labelled number of that carrier's shape sits beside
   * it. `none`: nothing usable; the message goes to needs-attention.
   */
  confidence: 'sender' | 'shape' | 'none'
}

/**
 * Registrable sender domains, measured from the live mailbox (packeta.sk, dpd.sk, sps-sro.sk,
 * packeta.com) plus the rest of what the user's Gmail filter targets. A sender matches on the domain
 * itself or any subdomain of it.
 */
const SENDER_DOMAINS: ReadonlyArray<readonly [string, CarrierId]> = [
  ['packeta.sk', 'packeta'], ['packeta.com', 'packeta'], ['zasilkovna.cz', 'packeta'],
  ['dpd.sk', 'dpd'],
  ['sps-sro.sk', 'sps'], ['mysps.sk', 'sps'],
  ['posta.sk', 'posta'],
  ['gls-group.eu', 'gls'], ['gls-group.com', 'gls'],
]

export function carrierForAddress(address: string): CarrierId | undefined {
  const host = address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase().replace(/[>\s]+$/, '')
  if (!address.includes('@') || host === '') return undefined
  return SENDER_DOMAINS.find(([d]) => host === d || host.endsWith(`.${d}`))?.[1]
}

/**
 * Per-carrier number shapes for ingest. Deliberately NOT `adapter.matches()`, which is the manual-entry
 * validator (and check-digit strict for posta). These only have to find a candidate in prose; the carrier
 * API's `not_found` is the real validator. The lookarounds keep a match from being cut out of a longer
 * token, so a 14-digit DPD number is never read as a 12-digit GLS one (or a 13-digit run as a 12-digit one).
 */
const NUMBER: Record<CarrierId, RegExp> = {
  packeta: /(?<![A-Z0-9])Z(?:[ \u00a0\u202f]?\d){10}(?!\d)/g,   // printed as "Z 000 0000 000"
  posta: /(?<![A-Z0-9])[A-Z]{2}\d{9}SK(?![A-Z0-9])/g,
  sps: /(?<![A-Z0-9])(?:SK[A-HJ-NP-Z0-9]{5}\d{2}[A-HJ-NP-Z0-9]{9}|703\d{11}[0-4]\d)(?![A-Z0-9])/g,
  dpd: /(?<![A-Z0-9])\d{14}(?![A-Z0-9])/g,
  gls: /(?<!\d)\d{10,12}(?!\d)/g,
}

/** Shapes distinctive enough to trust without a sender hint. Bare digits (dpd, gls) are not. */
const SHAPE_ONLY: readonly CarrierId[] = ['posta', 'packeta', 'sps']

/**
 * How a mail from a non-carrier (an e-shop) names a carrier whose numbers are bare digits. Only used
 * together with a labelled number of that carrier's shape: a name alone proves nothing (an order
 * confirmation says "GLS" for the chosen delivery method), which is why both signals are required.
 * Packeta, SPS and Slovenska posta need no name here: their number shapes are distinctive by themselves.
 */
const CARRIER_NAME = {
  gls: /(?<![\p{L}\d])GLS(?![\p{L}\d])/iu,
  dpd: /(?<![\p{L}\d])DPD(?![\p{L}\d])/iu,
} as const

const MERCHANT_MAX = 80
const MAX_TEXT = 400_000
const MAX_HTML = 1_000_000

const firstNumber = (carrier: CarrierId, haystack: string): string | undefined => {
  if (carrier === 'gls') return glsNumber(haystack)
  const m = haystack.match(NUMBER[carrier])
  return m ? normalizeNumber(m[0]) : undefined
}

const GLS_LABEL = /(?:parcel|package|tracking|track|number|zásielk\w*|zasielk\w*|balík\w*|balik\w*|číslo|cislo|paket\w*)[^\n\d]{0,30}$/i
const PHONE_LABEL = /(?:tel\w*|phone|mobil\w*|call|fax|zavolajte|volajte|\+)[^\n\d]{0,15}$/i
// 10 digits is also the length of a Slovak national-format mobile number (0900123456).
const PHONE_PREFIX = /^(?:42[01]|00421|00420|09\d{8}$)/

/**
 * A GLS number is 10-12 bare digits, exactly the shape of a printed phone number (421900123456 is 12
 * digits, 0900123456 is 10), and a mail may print one first. So rank the candidates: one introduced by a "parcel number"
 * style label, then any that does not look like a phone number, then the first. The text is searched in
 * order, so within a rank the earlier one wins.
 */
function glsNumber(haystack: string): string | undefined {
  const candidates = [...haystack.matchAll(NUMBER.gls)].map(m => {
    const before = haystack.slice(Math.max(0, m.index - 50), m.index)
    const phone = PHONE_LABEL.test(before) || PHONE_PREFIX.test(m[0])
    return { number: m[0], rank: GLS_LABEL.test(before) && !phone ? 0 : phone ? 2 : 1 }
  })
  const best = candidates.sort((a, b) => a.rank - b.rank)[0]   // stable: ties keep text order
  return best && normalizeNumber(best.number)
}

/** Like `NUMBER`, but the digits must be a whole token: no letter or digit may touch either end. */
const STANDALONE = {
  gls: /(?<![\p{L}\d])\d{10,12}(?![\p{L}\d])/gu,
  dpd: /(?<![\p{L}\d])\d{14}(?![\p{L}\d])/gu,
} as const

/** Words that mark a number as something other than a tracking number (the shop's own, an invoice, a phone). */
const NOT_TRACKING = /objedn|order|fakt[uú]r|invoice|variabil|referenc|tel\b|telef|phone|mobil|ičo|dič|iban/i

/**
 * The tracking number a non-carrier mail prints for a bare-digit carrier (gls, dpd), or undefined.
 * Stricter than `firstNumber`, because here nothing but the text vouches for the carrier: the number
 * must be introduced by a "parcel number" style label (never by an order/phone/invoice one), must not
 * be cut out of a longer alphanumeric token (a URL id, a message id), and must not look like a phone.
 * Two different such numbers are ambiguous, which is refused rather than guessed.
 */
function labelledNumber(carrier: 'gls' | 'dpd', haystack: string): string | undefined {
  const found = new Set<string>()
  for (const m of haystack.matchAll(STANDALONE[carrier])) {
    const before = haystack.slice(Math.max(0, m.index - 50), m.index)
    const sentence = before.split(/[.!?\n\d]/).pop() ?? ''
    if (!GLS_LABEL.test(before) || PHONE_LABEL.test(before) || PHONE_PREFIX.test(m[0]) || NOT_TRACKING.test(sentence)) continue
    found.add(normalizeNumber(m[0]))
  }
  return found.size === 1 ? [...found][0] : undefined
}

/** Carriers the text names that also have a labelled number of their bare-digit shape beside it. */
function namedBareNumbers(haystack: string): { c: CarrierId; n: string }[] {
  return (['gls', 'dpd'] as const)
    .filter(c => CARRIER_NAME[c].test(haystack))
    .flatMap(c => { const n = labelledNumber(c, haystack); return n ? [{ c, n }] : [] })
}

/**
 * Plain text from html that has no text part. mailparser only derives `text` from `html` for
 * some structures; a `multipart/mixed` html mail with an attachment (DPD's pickup-pass mails) gets none.
 * Good enough to find a number in prose; not a renderer.
 */
export function htmlToText(html: string): string {
  return decodeEntities(stripBlocks(html)
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|td|th|li|h[1-6]|table)\s*>/gi, '\n')
    .replace(/<[^<>]*>/g, ' ')   // `[^<>]`, so a stray `<` costs one character, not a scan to the end
  )
}

/**
 * Removes `<style>`, `<script>` and `<head>` blocks in one forward pass. An unclosed block swallows the
 * rest of the input, which keeps hostile mail linear (a lazy regex rescans to the end for every opener).
 */
function stripBlocks(html: string): string {
  const open = /<(style|script|head)\b/gi
  let out = ''
  let from = 0
  for (let m = open.exec(html); m; m = open.exec(html)) {
    out += html.slice(from, m.index) + ' '
    const close = new RegExp(`</${m[1]}\\s*>`, 'gi')
    close.lastIndex = m.index
    const end = close.exec(html)
    if (!end) return out
    from = end.index + end[0].length
    open.lastIndex = from
  }
  return out + html.slice(from)
}

const clean = (s: string | undefined): string | undefined => {
  const t = s?.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MERCHANT_MAX).trim()
  return t ? t : undefined
}

/**
 * Who sent the mail the user is looking at: the envelope sender, or, for a mail forwarded by hand, the
 * sender inside the `---------- Forwarded message ---------` wrapper. Gmail's plain-text wrapper
 * writes names bold as `*DPD* <no_reply@dpd.sk>`.
 */
function forwardedHeader(text: string): { from?: string; name?: string } | undefined {
  const wrapper = /^[ \t>]*-{3,}\s*(?:Forwarded message|Preposlan\S+ spr\S+|P\S*eposlan\S+ zpr\S+|Original Message)\s*-{3,}[ \t]*$/im.exec(text)
  if (!wrapper) return undefined
  const block = text.slice(wrapper.index + wrapper[0].length).split(/\r?\n[ \t>]*\r?\n/, 2).slice(0, 2).join('\n')
  const line = /^[ \t>]*(?:From|Od):[ \t]*(.+)$/im.exec(block)?.[1]
  if (!line) return undefined
  const address = /<([^>\s]+@[^>\s]+)>/.exec(line)?.[1] ?? /([^\s<>*]+@[^\s<>*]+)/.exec(line)?.[1]
  const name = line.replace(/<[^>]*>/, '').replace(/[*"]/g, '').trim()
  return { from: address, name: name || undefined }
}

/** Per-carrier "sent by" phrasing, for a card that reads "Alza" rather than a number. Merchant only; never status. */
const MERCHANT: Partial<Record<CarrierId, RegExp[]>> = {
  packeta: [/od odosielateľa\s+(.+?),?\s+(?:je pre vás|sme nemohli)/i, /odosielateľ\s+(.+?)\s+nám práve/i],
  dpd: [/Odosielateľ:\s*(.+?)\s+Číslo balíka/i],
  sps: [/cislo\s+\S+\s+od\s+(.+?)\s+je\s+pripravená/i],
}

/**
 * Pulls carrier, tracking number and merchant out of one raw message. Never throws: a message that
 * cannot be read is simply one with no number, which the caller sends to needs-attention.
 */
export async function extract(raw: Buffer): Promise<Extraction> {
  try {
    const mail = await simpleParser(raw)
    const subject = mail.subject ?? ''
    const text = (mail.text || (typeof mail.html === 'string' ? htmlToText(mail.html.slice(0, MAX_HTML)) : '')).slice(0, MAX_TEXT)
    const haystack = `${subject}\n${text}`.normalize('NFC')

    const envelope = mail.from?.value[0]
    const wrapper = forwardedHeader(text)
    // The envelope sender first; a hand-forward's wrapper is the fallback.
    const carrier = carrierForAddress(envelope?.address ?? '') ?? carrierForAddress(wrapper?.from ?? '')

    if (carrier) {
      const number = firstNumber(carrier, haystack)
      if (!number) return { carrier, confidence: 'none' }
      return { carrier, number, merchant: carrierMerchant(carrier, haystack), confidence: 'sender' }
    }

    // No hint from the sender: trust only a distinctive shape, and only if it is unambiguous.
    let found = SHAPE_ONLY.flatMap(c => [...new Set((haystack.match(NUMBER[c]) ?? []).map(normalizeNumber))].map(n => ({ c, n })))
    // An e-shop's dispatch mail has no distinctive shape to go on, but it names the carrier and prints
    // a labelled number of that carrier's bare-digit shape. Both signals, or nothing.
    if (found.length === 0) found = namedBareNumbers(haystack)
    if (found.length !== 1) return { confidence: 'none' }
    const origin = wrapper ?? { from: envelope?.address, name: envelope?.name }
    return {
      carrier: found[0]!.c, number: found[0]!.n, confidence: 'shape',
      merchant: clean(origin.name) ?? clean(origin.from?.split('@')[1]),
    }
  } catch {
    return { confidence: 'none' }
  }
}

function carrierMerchant(carrier: CarrierId, haystack: string): string | undefined {
  const flat = haystack.replace(/\s+/g, ' ')
  for (const re of MERCHANT[carrier] ?? []) {
    const m = re.exec(flat)
    if (m?.[1]) return clean(m[1])
  }
  return undefined
}

/**
 * The code that opens a Z-BOX. Packeta puts it in the pickup email only - the tracking API never
 * carries it - laid out one digit per cell, so the digits arrive separated:
 *
 *     Kód pre otvorenie schránky 7 9 9 8 7 4 Miesto, kde je vaša zásielka uložená ...
 *
 * The same phrase appears a second time further down, inside the instructions ("...otvorenie
 * schránky ALEBO stiahnutá aktuálna verzia aplikácie Packeta"), with no digits after it. That is why
 * the digits must follow immediately: anchoring on the phrase alone matches the wrong occurrence.
 *
 * Returned as a string because real codes carry leading zeros (004467, 007018); a number would drop
 * them silently and send the reader to the locker with a code one digit short.
 */
const PICKUP_CODE = /k[oó]d p(?:re|ro) ot(?:vorenie|evřen[ieí]|evren[ieí]) schr[aá]nky[\s:]*((?:\d[ \t ]*){4,10})(?![ \t ]*\d)/i

export function extractPickupCode(text: string): string | undefined {
  // Collapse whitespace first. The digits sit one per table cell, so in the plain-text rendering they
  // are separated by NEWLINES as often as by spaces, and the phrase itself can wrap mid-sentence.
  const m = PICKUP_CODE.exec(text.replace(/\s+/g, ' '))
  if (!m) return undefined
  const digits = m[1]!.replace(/\D/g, '')
  return digits.length >= 4 && digits.length <= 10 ? digits : undefined
}
