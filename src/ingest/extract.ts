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
   * `sender`: the carrier came from the sender's domain. `shape`: no known sender, but the number has
   * a distinctive carrier-specific shape. `none`: nothing usable; the message goes to needs-attention.
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

/**
 * Plain text from html, for mail that has no text part. mailparser only derives `text` from `html` for
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
    const found = SHAPE_ONLY.flatMap(c => [...new Set((haystack.match(NUMBER[c]) ?? []).map(normalizeNumber))].map(n => ({ c, n })))
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
