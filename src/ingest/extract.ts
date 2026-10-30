import { simpleParser, type ParsedMail } from 'mailparser'
import type { CarrierId, PickupPoint } from '../core/types.js'
import { isEmailOnlyCarrier } from '../core/types.js'
import { normalizeNumber } from '../carriers/registry.js'
import { decodeEntities } from '../core/entities.js'

export interface Extraction {
  carrier?: CarrierId
  /** Normalised (upper case, no spaces) tracking number. */
  number?: string
  /**
   * Further parcels of the same carrier the mail names beside `number`: a carrier's mail listing
   * them (`Číslo balíka: 01505…305, 01505…306`), or an e-shop's split order with one distinctive
   * number per parcel. Each becomes a parcel of its own; the message itself links to `number`'s.
   */
  moreNumbers?: string[]
  merchant?: string
  /**
   * The mail's own words, verbatim (its subject), for an email-only carrier's one event. Extracted
   * ONLY for those carriers: mail is all they ever have, and limiting it to them keeps the rule that
   * status never comes from prose (§8) where it belongs — for a polled carrier the carrier's own
   * timeline is the truth, and a subject line would only compete with it.
   */
  eventText?: string
  /**
   * `sender`: the carrier came from the sender's domain. `shape`: no known sender, but the carrier
   * and number agree: either the number has a distinctive carrier-specific shape, or (an e-shop's
   * dispatch mail) the text names the carrier AND a labelled number of that carrier's shape sits beside
   * it. `none`: nothing usable; see `evidence` for whether the message is nevertheless worth asking about.
   */
  confidence: 'sender' | 'shape' | 'none'
  /**
   * Why this message looks like it is about a parcel AT ALL, or `undefined` when nothing in it does.
   * Independent of `confidence`: `confidence` answers "can this become a parcel", `evidence` answers
   * "is this even about one". See `parcelEvidence` for the rule and for why the two are separate.
   */
  evidence?: ParcelEvidence
}

/**
 * The signals that make a message worth a human's attention when it yields no parcel, in the order
 * `parcelEvidence` tries them. Recorded in `messages.parse_note` by `ingest.ts`, so why a message was
 * shown - or was not - is answerable from the database months later.
 *
 * - `carrier-sender`: the mail came from a carrier's own domain.
 * - `carrier-named`: a carrier is named in the subject or the body.
 * - `tracking-shape`: a token of some carrier's tracking-number shape is in it.
 * - `shipping-subject`: the SUBJECT is about a shipment.
 * - `unreadable`: nothing could be read out of the message, so nothing can be concluded either.
 * - `lookalike-sender`: the sender calls itself a carrier (its display name, or a label of its
 *   domain) but does not write from that carrier's domain - see `claimsCarrier`.
 * - `too-long`: the message is longer than the caps, so its middle was never read, and neither end
 *   said anything. Like `unreadable`: nothing is known either way.
 */
export type ParcelEvidence =
  | 'carrier-sender' | 'carrier-named' | 'tracking-shape' | 'shipping-subject' | 'unreadable'
  | 'lookalike-sender' | 'too-long'

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
  // GLS Slovakia writes its own notices from gls-slovakia.sk (the scrubbed real fixture is one), and
  // only some from the group's domains.
  ['gls-group.eu', 'gls'], ['gls-group.com', 'gls'], ['gls-slovakia.sk', 'gls'],
  // DHL writes from the local market's domain, and its Parcel and Express units have brand domains of
  // their own. Listed one by one rather than as a `dhl*.` pattern on purpose: the rule is "this exact
  // registrable domain, or a subdomain of it", and a pattern would also accept `dhl.<anything>`, which
  // is a domain someone else can own. A domain not listed here costs a message in needs-attention,
  // where one click assigns it; a domain listed too loosely would hand a stranger a parcel.
  ['dhl.com', 'dhl'], ['dhl.de', 'dhl'], ['dhl.sk', 'dhl'], ['dhl.cz', 'dhl'],
  ['dhlparcel.com', 'dhl'], ['dhlparcel.sk', 'dhl'], ['dhlparcel.cz', 'dhl'], ['dhlparcel.nl', 'dhl'],
  ['dhlexpress.com', 'dhl'],
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
  // The prefixed forms, plus the 16-digits-or-more leading-zero form; see src/carriers/dhl.ts for why
  // the bare ten-digit Express form is deliberately absent.
  dhl: /(?<![A-Z0-9])(?:JJD\d{10,22}|JVGL\d{10,22}|3S[A-Z0-9]{8,18}|000\d{13,25})(?![A-Z0-9])/g,
}

/**
 * Wider shapes for when the sender already is the carrier. Slovenská pošta also writes about inbound
 * international items, whose UPU S10 numbers end in the country they were posted in (`RB…CN`,
 * `CP…DE`). Only from posta.sk: from a stranger, `NUMBER.posta`'s `SK` suffix stays the test.
 */
const SENDER_NUMBER: Partial<Record<CarrierId, RegExp>> = {
  posta: /(?<![A-Z0-9])[A-Z]{2}\d{9}[A-Z]{2}(?![A-Z0-9])/g,
}

/**
 * Shapes distinctive enough to trust without a sender hint, and the pattern that may be trusted for
 * each. Bare digits (dpd, gls) are not, and neither is DHL's `000…` form, which is why dhl appears
 * here with only its lettered prefixes: `JJD…`, `JVGL…` and `3S…` cannot be anything else, while a
 * long run of digits in a stranger's mail could be an order number or a reference.
 */
const DISTINCTIVE: Partial<Record<CarrierId, RegExp>> = {
  posta: NUMBER.posta,
  packeta: NUMBER.packeta,
  sps: NUMBER.sps,
  dhl: /(?<![A-Z0-9])(?:JJD\d{10,22}|JVGL\d{10,22}|3S[A-Z0-9]{8,18})(?![A-Z0-9])/g,
}

/**
 * How a mail from a non-carrier (an e-shop) names a carrier whose numbers are bare digits. Only used
 * together with a labelled number of that carrier's shape: a name alone proves nothing (an order
 * confirmation says "GLS" for the chosen delivery method), which is why both signals are required.
 * Packeta, SPS and Slovenska posta need no name here: their number shapes are distinctive by themselves,
 * and so are DHL's lettered prefixes - only its `000…` form needs the name beside it.
 */
const CARRIER_NAME = {
  gls: /(?<![\p{L}\d])GLS(?![\p{L}\d])/iu,
  dpd: /(?<![\p{L}\d])DPD(?![\p{L}\d])/iu,
  dhl: /(?<![\p{L}\d])DHL(?![\p{L}\d])/iu,
} as const

const MERCHANT_MAX = 80
/** A subject line kept as an event description: long enough for a real one, short enough to render. */
const EVENT_TEXT_MAX = 200
const MAX_TEXT = 400_000
const MAX_HTML = 1_000_000
/**
 * How much of the caps is spent on the END of a message that exceeds them. Order summaries and T&C
 * mails put the shipping line last, after hundreds of KB of conditions, so a head-only cut read
 * everything but the one line that mattered.
 */
const TAIL_SHARE = 8

/**
 * A number whose digits are all one digit (`Z 000 0000 000`, `RR000000000SK`): the sample a carrier
 * prints to show what its numbers look like ("číslo zásielky v tvare Z 000 0000 000"), never one it
 * issued. Taken as a parcel, it was polled forever and sat in flight as "No updates yet".
 */
const isPlaceholder = (normalized: string): boolean => /^[A-Z]*(\d)\1*[A-Z]*$/.test(normalized)

const firstNumber = (carrier: CarrierId, haystack: string): string | undefined => {
  if (carrier === 'gls') return glsNumber(haystack)
  return (haystack.match(SENDER_NUMBER[carrier] ?? NUMBER[carrier]) ?? []).map(normalizeNumber).find(n => !isPlaceholder(n))
}

/** At most this many parcels from one mail; a mail naming more is a question, not a batch to create. */
const MAX_NUMBERS = 5
/** What may separate two numbers in one list: a comma, a semicolon, "a" / "and", and whitespace. */
const LIST_GAP = /^\s*(?:[,;&]|a|and|aj)?\s*$/i

/**
 * The numbers a carrier's mail LISTS right after `first` (`01505…305, 01505…306`). Only a list counts:
 * a carrier's mail can print other number-shaped strings (a reference, an order number), and a
 * number standing anywhere else is not vouched for by the label in front of the first.
 *
 * Even in a list, GLS's `\d{10,12}` is also an order number in the next column of a flattened table
 * (`12345678901 1052281846`) or a phone on the next line. So the list ends at the first number that
 * is not the first one's length (parcels in one list share a shape), looks like a phone, or stands in
 * a sentence that names an order, an invoice or a phone (`NOT_TRACKING`).
 */
function listedAfter(carrier: CarrierId, haystack: string, first: string): string[] {
  const all = [...haystack.matchAll(SENDER_NUMBER[carrier] ?? NUMBER[carrier])]
  const at = all.findIndex(m => normalizeNumber(m[0]) === first)
  const out: string[] = []
  for (let i = at + 1; at >= 0 && i < all.length; i++) {
    const prev = all[i - 1]!
    const m = all[i]!
    if (!LIST_GAP.test(haystack.slice(prev.index + prev[0].length, m.index))) break
    const n = normalizeNumber(m[0])
    const before = haystack.slice(Math.max(0, m.index - 50), m.index)
    const sentence = before.split(/[.!?\n]/).pop() ?? ''
    if (n.length !== first.length || PHONE_PREFIX.test(n) || PHONE_LABEL.test(before) || NOT_TRACKING.test(sentence)) break
    if (n !== first && !out.includes(n) && !isPlaceholder(n)) out.push(n)
  }
  return out
}

/**
 * A "parcel number" style label right before a number: on the number's own line, or on the line above
 * when the label ends in a colon. GLS prints `Číslo balíka:` in one table cell and the number in the
 * next, so in the text rendering the number always starts the following line.
 */
const GLS_LABEL = /(?:parcel|package|tracking|track|number|zásielk\w*|zasielk\w*|balík\w*|balik\w*|číslo|cislo|paket\w*)(?:[^\n\d]{0,30}|[^\n\d]{0,30}:[ \t]*\r?\n[ \t>]*)$/i
/**
 * `GLS_LABEL` without the bare "number" words (`číslo`, `number`): a label that says PARCEL. For the
 * evidence test with no carrier named, where `Katalógové číslo produktu 123456789012` in a newsletter
 * must not read as a parcel number - beside a named carrier, a bare `Sledovacie číslo:` still does.
 */
const PARCEL_LABEL = /(?:parcel|package|tracking|track|zásielk\w*|zasielk\w*|z[áa]silk\w*|balík\w*|balik\w*|paket\w*|sledovac\w*)(?:[^\n\d]{0,30}|[^\n\d]{0,30}:[ \t]*\r?\n[ \t>]*)$/i
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
  const candidates = [...haystack.matchAll(NUMBER.gls)].filter(m => !isPlaceholder(m[0])).map(m => {
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
  dhl: /(?<![\p{L}\d])000\d{13,25}(?![\p{L}\d])/gu,
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
function labelledNumber(carrier: keyof typeof STANDALONE, haystack: string, label = GLS_LABEL): string | undefined {
  const found = new Set<string>()
  for (const m of haystack.matchAll(STANDALONE[carrier])) {
    const before = haystack.slice(Math.max(0, m.index - 50), m.index)
    // The label may sit on the line above (`Číslo objednávky:` / number), so it is the label's own
    // line that the NOT_TRACKING words are looked for in, not the empty start of the number's line.
    const sentence = before.replace(/:[ \t]*\r?\n[ \t>]*$/, ': ').split(/[.!?\n\d]/).pop() ?? ''
    if (!label.test(before) || PHONE_LABEL.test(before) || PHONE_PREFIX.test(m[0]) || NOT_TRACKING.test(sentence) || isPlaceholder(m[0])) continue
    found.add(normalizeNumber(m[0]))
  }
  return found.size === 1 ? [...found][0] : undefined
}

/** The carriers whose numbers are bare digits, so a label or a carrier name has to vouch for them. */
const BARE_DIGIT_CARRIERS = ['gls', 'dpd', 'dhl'] as const

/** Carriers the text names that also have a labelled number of their bare-digit shape beside it. */
function namedBareNumbers(haystack: string): { c: CarrierId; n: string }[] {
  return BARE_DIGIT_CARRIERS
    .filter(c => CARRIER_NAME[c].test(haystack))
    .flatMap(c => { const n = labelledNumber(c, haystack); return n ? [{ c, n }] : [] })
}

/**
 * Every way a carrier can be NAMED in prose. The three whose numbers are bare digits come straight
 * from `CARRIER_NAME` - one definition of "this mail says GLS", shared with the e-shop parsing rule
 * above, so the two can never drift apart. The rest are added only for the evidence test, because
 * parsing never needed them: their number shapes speak for themselves.
 *
 * The additions are deliberately NOT the bare carrier word. `pošta` is the Slovak word for "mail"
 * and appears in the footer of half the mail anyone receives ("táto pošta bola odoslaná
 * automaticky"), so `Slovenská pošta` is required whole; `SPS` is a three-letter abbreviation shared
 * with schools and electronics, so it has to stand alone as a token. `Packeta` and `Zásielkovňa` are
 * brand names nothing else uses, so they stand on their own.
 */
const CARRIER_MENTION: readonly RegExp[] = [
  ...Object.values(CARRIER_NAME),
  /(?<![\p{L}\d])(?:packeta|z[áa]sielkovn\w*|z[áa]silkovn\w*)(?![\p{L}])/iu,
  // Bounded and anchored to a word start: an unbounded run here rescans the rest of a 400 KB body from
  // every `slovensk` in it, which a crafted mail turned into half a minute of a blocked event loop.
  // `\p{L}`, not `\w`: in JS `\w` is ASCII, so `Slovenská pošta` itself used never to match.
  /(?<![\p{L}\d])slovensk\p{L}{0,12}[  ]+po[šs]t/iu,
  /(?<![\p{L}\d])(?:SPS|slovak parcel service)(?![\p{L}\d])/iu,
]

/** A carrier brand as a label, or the start of one, of a domain: `packeta-sk.example.com`, `gls.example.net`. */
const CARRIER_IN_DOMAIN = /(?:^|[.-])(?:packeta|z[aá]sielkovna|z[aá]silkovna|gls|dpd|dhl)(?=[.-])/i

/**
 * Whether a sender that is NOT a carrier presents itself as one: a carrier named in its display name
 * ("Packeta" <noreply@packeta-sk.example.com>) or in its domain. Such a mail is never made a parcel,
 * because a parcel titled "Packeta" on the dashboard is the carrier vouching for it - which is what a
 * phishing mail ("uhraďte poplatok 1,99 €") wants. It waits on /attention instead, with a note saying
 * why. A carrier's genuine mail from a domain not in `SENDER_DOMAINS` costs the same one click there,
 * which is the trade `SENDER_DOMAINS` already makes. A shop that only names the carrier in its BODY
 * ("Prepravca: Packeta") is not affected: only the sender's own name is read.
 */
function claimsCarrier(origin: { from?: string; name?: string }): boolean {
  const host = origin.from?.slice(origin.from.lastIndexOf('@') + 1) ?? ''
  return CARRIER_MENTION.some(re => re.test(origin.name ?? '')) || CARRIER_IN_DOMAIN.test(host)
}

/**
 * Shipping wording in a SUBJECT line. Subject only, and that is the whole point of it: an e-shop puts
 * the shipping event in the subject ("Objednávka ... odoslaná", "Pripravené v AlzaBoxe"), while the
 * BODY of every order confirmation and every invoice from the same shop also talks about delivery -
 * Alza's invoices print "Doprava - AlzaBox" and "môžete vyzdvihnúť" in their footers. Reading the body
 * for these words would show the whole thread again, which is exactly the problem this rule exists to
 * solve.
 *
 * Word stems rather than whole words, because Slovak declines everything (zásielka / zásielky /
 * zásielku / zásielok), and with and without diacritics, because plenty of senders strip them.
 * `odber` on its own is absent on purpose: it is also how a newsletter subscription is named
 * ("odhlásenie z odberu"); the pickup sense only counts as `osobný odber` or `odberné miesto`.
 *
 * A stem that must be followed by a second word takes at most 12 letters of ending first. Unbounded,
 * every repeat of the stem in a crafted subject rescanned the rest of it (tens of seconds on one
 * message, with the web server blocked). And letters, not `\w`, which in JS is ASCII: `osobný odber`
 * and `odberné miesto`, the very phrases named above, never matched with their diacritics.
 */
const SHIPPING_SUBJECT = new RegExp([
  'z[áa]sielk\\w*', 'z[áa]silk\\w*',                        // zásielka (sk), zásilka (cz)
  'bal[ií]k(?![\\p{L}]{0,4}ek)\\w*',                         // balík, balíka; not "balíček" (a bundle)
  'doru[čc]\\w*', 'odoslan\\w*', 'expedovan\\w*', 'expedi[cč]\\w*',
  'preprav\\w*', 'prepravc\\w*', 'kuri[eé]r\\w*',
  'vyzdvih\\w*', 'prevzat\\w*', 'prevzet\\w*', 'osobn\\p{L}{0,12}[ \\u00a0]+odber\\w*',
  'sledovan\\p{L}{0,12}[ \\u00a0]+(?:z[áa]sielk|balík)\\w*', 'podac\\p{L}{0,12}[ \\u00a0]+[čc][ií]sl\\w*',
  // The pickup places, named one brand at a time rather than as a `*box` pattern: "inbox" and
  // "mailbox" are subject-line words, and an AlzaBox is not a mailbox.
  'alzabox\\w*', 'z-?box\\w*', 'bal[ií]ko(?:box|mat)\\w*', 'packomat\\w*', 'packstation\\w*',
  'parcel ?shop\\w*', 'parcel ?locker\\w*', 'pickup station', 'odbern\\p{L}{0,12}[ \\u00a0]+miest\\w*',
  'v[yý]dajn\\p{L}{0,12}[ \\u00a0]+miest\\w*',
  // English, for the shops that write in it.
  '\\btrack\\w*', 'shipment\\w*', 'shipp(?:ed|ing)', 'dispatch\\w*', 'deliver\\w*',
  'parcel\\w*', 'package\\w*', 'on its way', 'out for delivery', 'courier\\w*',
].join('|'), 'iu')

/**
 * Whether anything in this message says it is about a parcel, and which signal said so.
 *
 * This is the whole rule, in one place, because the attention page, the poll summary and the tests all
 * have to agree about it. A message with no evidence is STORED and then left alone: the row is the
 * Message-ID dedupe key and the ingest watermark depends on it, but it never becomes a question for
 * the user. Gmail labels CONVERSATIONS, not messages, so one shipping mail in an order thread drags
 * its invoices, its tax documents and its order confirmations onto the label with it; no Gmail query
 * can prevent that, and treating each of them as "no tracking number found" turned a page for real
 * problems into a page of 56 non-problems.
 *
 * The four signals, and why each is allowed to be enough on its own:
 *
 *   1. A KNOWN CARRIER SENDER. A carrier only writes about parcels. If one wrote and nothing parsed,
 *      that is a parser gap, which is precisely what the page is for. Strongest signal, and the one
 *      that must never be overridden - hence first.
 *   2. A CARRIER NAMED in the subject or the body. Weaker than the sender (an order confirmation
 *      names the delivery method), but a stranger's mail that says "GLS" is about a shipment far more
 *      often than not, and the cost of being wrong is one dismiss click.
 *   3. A TOKEN OF SOME CARRIER'S TRACKING-NUMBER SHAPE - but only the DISTINCTIVE shapes (`Z 000 0000
 *      000`, `EB629066058SK`, `SK0...`, `JJD.../3S...`), plus a bare-digit number that is LABELLED as
 *      a parcel number. The bare-digit shapes alone are deliberately not evidence: `\d{10,12}` is
 *      also the shape of Alza's own order numbers (1052281846, 1062794763), of a variable symbol and
 *      of a phone number, so accepting them would show the entire order thread all over again and
 *      give back nothing. This reuses `DISTINCTIVE` and `labelledNumber`, the same tests the parser
 *      itself trusts, rather than a second opinion about what a number looks like - except that with
 *      no carrier named the label has to say parcel (`PARCEL_LABEL`), not just "číslo".
 *   4. SHIPPING WORDING IN THE SUBJECT (see `SHIPPING_SUBJECT`). This is what catches a real pickup
 *      notice from a shop that names no carrier and prints no number at all - "Pripravené v
 *      AlzaBoxe", "Objednávka č. 1410452 pripravená na prevzatie" - which the app cannot track but
 *      the user may still want to see.
 *
 * The bias is deliberate and one-sided: a false ignore hides a real parcel, a false show costs one
 * click. So anything unreadable counts as evidence too (`extract`'s caller decides that), and all
 * four tests are ORs with no veto anywhere.
 */
function parcelEvidence(subject: string, haystack: string): ParcelEvidence | undefined {
  if (CARRIER_MENTION.some(re => re.test(haystack))) return 'carrier-named'
  // `.match` rather than `.test`: these are global regexes, and `.test` would advance their lastIndex
  // and make the next call on the same pattern start half-way through a different message.
  if (Object.values(DISTINCTIVE).some(re => haystack.match(re) !== null)) return 'tracking-shape'
  if (BARE_DIGIT_CARRIERS.some(c => labelledNumber(c, haystack, PARCEL_LABEL) !== undefined)) return 'tracking-shape'
  if (SHIPPING_SUBJECT.test(subject)) return 'shipping-subject'
  return undefined
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

const clean = (s: string | undefined, max = MERCHANT_MAX): string | undefined => {
  const t = s?.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()
  return t ? t : undefined
}

/**
 * Who sent the mail the user is looking at: the envelope sender, or, for a mail forwarded by hand, the
 * sender inside the `---------- Forwarded message ---------` wrapper. Gmail's plain-text wrapper
 * writes names bold as `*DPD* <no_reply@dpd.sk>`.
 */
function forwardedHeader(text: string): { from?: string; name?: string } | undefined {
  // Outlook writes no "Forwarded message" line, only a rule of underscores straight above the
  // `From:` line; the rule counts only when that line follows it.
  const wrapper = /^[ \t>]*-{3,}\s*(?:Forwarded message|Preposlan\S+ spr\S+|P\S*eposlan\S+ zpr\S+|Original Message)\s*-{3,}[ \t]*$/im.exec(text)
    ?? /^[ \t>]*_{10,}[ \t]*(?=\r?\n[ \t>]*(?:From|Od):)/im.exec(text)
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
  // `.{1,400}?`, not `.+?`: the result is clipped to MERCHANT_MAX anyway, and an unbounded lazy group
  // scans to the end of the body from every repeat of the opening phrase (quadratic on hostile mail).
  packeta: [
    /od odosielateľa\s+(.{1,400}?),?\s+(?:je pre vás|sme nemohli)/i, /odosielateľ\s+(.{1,400}?)\s+nám práve/i,
    // The same two sentences as Zásilkovna (packeta.cz / zasilkovna.cz) and packeta.com write them.
    /od odesílatele\s+(.{1,400}?),?\s+(?:je pro vás|jsme nemohli)/i, /odesílatel\s+(.{1,400}?)\s+nám právě/i,
    /from the sender\s+(.{1,400}?),?\s+is (?:ready|waiting)/i, /the sender\s+(.{1,400}?)\s+has just handed/i,
  ],
  dpd: [/Odosielateľ:\s*(.{1,400}?)\s+Číslo balíka/i],
  sps: [/cislo\s+\S+\s+od\s+(.{1,400}?)\s+je\s+pripravená/i],
  // GLS prints `Odosielateľ:` and the shop in a cell of its own, followed by the next row's bullet
  // image (alt text "modrá odrážka"), the "Detail zásielky" button or the pickup-point row.
  gls: [/Odosielateľ:\s*(.{1,400}?)\s+(?:modrá odrážka|Detail zásielky|Odbern[ée] miesto)/i],
}

/** `s` cut to `max` characters: its start, and its last `max / TAIL_SHARE` characters, when it is longer. */
function headAndTail(s: string, max: number): string {
  if (s.length <= max) return s
  const tail = Math.floor(max / TAIL_SHARE)
  return `${s.slice(0, max - tail - 1)}\n${s.slice(s.length - tail)}`
}

/** The html part flattened, capped (both before and after flattening) like `bodyText`. */
const htmlText = (html: string): string => headAndTail(htmlToText(headAndTail(html, MAX_HTML)), MAX_TEXT)

/**
 * The readable text of a parsed message: its text part, or its html flattened when it has none, capped
 * (both before and after flattening) so a huge message costs a bounded amount of regex work.
 */
function bodyText(mail: ParsedMail): string {
  return mail.text ? headAndTail(mail.text, MAX_TEXT) : typeof mail.html === 'string' ? htmlText(mail.html) : ''
}

/** Whether the caps cut anything out of the middle of the message. */
const isCut = (mail: ParsedMail): boolean =>
  (mail.text ?? '').length > MAX_TEXT || (typeof mail.html === 'string' && mail.html.length > MAX_HTML)

/**
 * `bodyText` of a raw message, for a reader that wants nothing else from it (the pickup-code pass reads
 * stored mail through this, so it gets the same text, and the same caps, as extraction did). Throws
 * what the parser throws.
 */
export async function mailText(raw: Buffer): Promise<string> {
  return bodyText(await simpleParser(raw))
}

/**
 * Pulls carrier, tracking number and merchant out of one raw message. Never throws: a message that
 * cannot be read is simply one with no number, which the caller sends to needs-attention.
 */
export async function extract(raw: Buffer): Promise<Extraction> {
  try {
    const mail = await simpleParser(raw)
    const subject = mail.subject ?? ''
    const text = bodyText(mail)
    // Not a single readable byte: no subject AND no body. mailparser does not throw on arbitrary
    // bytes, it just yields nothing, so this is the same case as the catch below - and a message
    // nobody could read is no grounds for deciding it is not a parcel.
    if (subject === '' && text === '') return { confidence: 'none', evidence: 'unreadable' }
    let found = extractFrom(mail, subject, text)
    // A text part that yields nothing may be a stub ("otvorte ho v prehliadači ...") standing in for
    // the html part that carries the mail. The html is read only then, so a mail whose text part
    // works is read exactly as before; it is taken if it yields a number, or evidence the text lacked.
    if (!found.number && mail.text && typeof mail.html === 'string') {
      const alt = extractFrom(mail, subject, htmlText(mail.html))
      if (alt.number || (alt.evidence && !found.evidence)) found = alt
    }
    // Too long to read whole, and nothing at either end: the middle is unknown, so it is a question.
    if (!found.evidence && isCut(mail)) return { ...found, evidence: 'too-long' }
    return found
  } catch {
    // Unparseable bytes. Not "no parcel": nothing is known either way, so it is a question, not junk.
    return { confidence: 'none', evidence: 'unreadable' }
  }
}

/** `extract` over one rendering of the body (the text part, or the html flattened). */
function extractFrom(mail: ParsedMail, subject: string, text: string): Extraction {
  const haystack = `${subject}\n${text}`.normalize('NFC')

  const envelope = mail.from?.value[0]
  const wrapper = forwardedHeader(text)
  // The envelope sender first; a hand-forward's wrapper is the fallback.
  const carrier = carrierForAddress(envelope?.address ?? '') ?? carrierForAddress(wrapper?.from ?? '')
  // A carrier's own domain outranks everything the prose could say; otherwise ask the prose.
  const evidence = carrier ? 'carrier-sender' : parcelEvidence(subject, haystack)

  if (carrier) {
    const number = firstNumber(carrier, haystack)
    if (!number) return { carrier, confidence: 'none', evidence }
    const more = listedAfter(carrier, haystack, number).slice(0, MAX_NUMBERS - 1)
    return {
      carrier, number, ...(more.length > 0 && { moreNumbers: more }),
      merchant: carrierMerchant(carrier, haystack), confidence: 'sender', evidence,
      ...(isEmailOnlyCarrier(carrier) && { eventText: clean(subject, EVENT_TEXT_MAX) }),
    }
  }

  // No hint from the sender: trust only a distinctive shape, and only if it is unambiguous.
  let found = Object.entries(DISTINCTIVE).flatMap(([c, re]) =>
    [...new Set((haystack.match(re) ?? []).map(normalizeNumber))].filter(n => !isPlaceholder(n)).map(n => ({ c: c as CarrierId, n })))
  // An e-shop's dispatch mail has no distinctive shape to go on, but it names the carrier and prints
  // a labelled number of that carrier's bare-digit shape. Both signals, or nothing.
  if (found.length === 0) found = namedBareNumbers(haystack)
  // Several distinctive numbers are a split order only when they are all ONE carrier's: each shape
  // is unambiguous on its own, so tracking every one guesses nothing. Two carriers' numbers (or more
  // than a split order plausibly has) stay a question.
  const oneCarrier = found.every(f => f.c === found[0]!.c)
  if (found.length === 0 || !oneCarrier || found.length > MAX_NUMBERS) return { confidence: 'none', ...(evidence && { evidence }) }
  const origin = wrapper ?? { from: envelope?.address, name: envelope?.name }
  // Asked only of a mail that would otherwise become a parcel: one that would not keeps the
  // evidence it has, which already puts it on /attention.
  if (claimsCarrier(origin)) return { confidence: 'none', evidence: 'lookalike-sender' }
  return {
    carrier: found[0]!.c, number: found[0]!.n, ...(found.length > 1 && { moreNumbers: found.slice(1).map(f => f.n) }),
    confidence: 'shape', ...(evidence && { evidence }),
    merchant: clean(origin.name) ?? clean(origin.from?.split('@')[1]),
    ...(isEmailOnlyCarrier(found[0]!.c) && { eventText: clean(subject, EVENT_TEXT_MAX) }),
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

/**
 * A pickup point read out of the carrier's own email, for the parcels where the carrier's API never
 * says where the parcel is. GLS is the case that forced it: a parcel handed to a Balikomat answers
 * `DELIVEREDPS` with no `parcelShop` and no `addresses` at all, so the app could say "ready for
 * pickup" and nothing else - no address, no map, no card. The mail that announced it has the address,
 * and Packeta's has the postcode its API omits.
 *
 * Every field here is one the mail printed. There is deliberately no `lat`/`lon`: some templates do
 * carry a maps link with coordinates in it, but a pin is the one thing that is wrong in a way the
 * reader cannot see, so coordinates stay the geocoder's job.
 *
 * `street`, `city` and `postalCode` are REQUIRED, which is the whole safety rule of this extractor:
 *   - a town on its own ("Bratislava 5") is not a pickup point. Writing one would assert a place the
 *     carrier never gave, and the panel and map would both point at the middle of a city.
 *   - the postcode is also the anchor the parser needs: it is what tells the street apart from the
 *     town when a template prints them on one line ("Nevädzová 6 821 01 Bratislava").
 * A block that gives less than that yields nothing at all, which leaves the parcel exactly as the
 * carrier left it.
 */
export interface MailPickupPoint {
  kind: PickupPoint['kind']
  name?: string
  street: string
  city: string
  postalCode: string
}

/**
 * The labels that introduce a pickup-point block, one per template actually seen in the user's
 * mailbox. Each is anchored the way that template anchors it, so prose that merely mentions a pickup
 * point is not mistaken for a block:
 *
 *   - GLS writes `Odberné miesto:` on a line of its own, with the block under it. The label must own
 *     its line and end in a colon, which is what keeps DPD's link text ("Zobraziť odberné miesto
 *     Pickup Station na mape") and SPS's sentence ("v odbernom mieste balíkovo Lekáreň ...") out.
 *   - Packeta heads the block `Miesto, kde je vaša zásielka uložená` (in Czech `Místo, kde je vaše
 *     zásilka uložena`). PRESENT tense only: the acceptance mail prints the same block under `Miesto,
 *     kde BUDE vaša zásielka uložená`, naming a box the parcel has not reached yet and may never reach.
 *   - DPD writes `Adresa samoobslužného boxu Pickup Station:`.
 *
 * A template nobody has a real message for is deliberately absent (DHL, SPS): a guessed label reads a
 * guessed address, and the whole point of this module is that nothing here is guessed.
 */
const PICKUP_LABELS: readonly RegExp[] = [
  /^[ \t>]*odbern[ée]\s+miesto[ \t]*:/gim,
  /miesto,?[ \t]*kde[ \t]+je[ \t]+va[šs]a[ \t]+z[áa]sielka[ \t]+ulo[žz]en[áa]/gi,
  /m[íi]sto,?[ \t]*kde[ \t]+je[ \t]+va[šs]e[ \t]+z[áa]silka[ \t]+ulo[žz]ena/gi,   // Zásilkovna's Czech
  /adresa[ \t]+samoobslu[žz]n[ée]ho[ \t]+boxu[^:\n]{0,40}:/gi,
]

/** A Slovak postcode, printed either way round the carriers print it: `82101` or `821 01`. */
const POSTCODE = /(?<!\d)(\d{3}[  ]?\d{2})(?!\d)/
/** The postcode inside its part, with whatever precedes it (a street) and follows it (a town). */
const POSTCODE_IN_PART = /^(.*?)[  ]*(?<!\d)(\d{3}[  ]?\d{2})(?!\d)[  ]*(.*)$/

/**
 * A town: a capitalised word, up to three more words after it (`Ivanka pri Dunaji`), and optionally a
 * district number (`Bratislava 5`). Nothing else - no colons, no digits in the middle, no sentences.
 * This is the last line of defence when a template prints something unexpected after the town: a
 * value that is not a town is no pickup point rather than a wrong one.
 */
const CITY = /^\p{Lu}[\p{L}'’.-]*(?:[ -]\p{L}[\p{L}'’.-]*){0,3}(?:[ ]\d{1,2})?$/u

/** What the place calls itself, where the name says it plainly. Nothing is inferred from the carrier. */
const KINDS: ReadonlyArray<readonly [RegExp, PickupPoint['kind']]> = [
  [/z-?box/i, 'zbox'],
  [/bal[ií]komat|box\b|boxu\b|automat|packomat|packstation|parcel ?locker/i, 'locker'],
  [/po[šs]t[aou]\b|post office/i, 'post_office'],
]

/**
 * How far past the label the block may reach, and how many parts of it are considered. The character
 * window is wide because Packeta's template puts ~650 characters of empty table cells between its
 * label and the address; what actually bounds the search is the PART count, since only non-empty
 * parts are counted and the parser stops as soon as it has that many.
 */
const PICKUP_REGION = 2000
const PICKUP_PARTS = 8
const PICKUP_LABELS_TRIED = 8
const NAME_MAX = 80
const STREET_MAX = 80
const CITY_MAX = 40

/**
 * The pickup point a carrier's mail prints, or undefined - which is the answer for most mail and for
 * every block that does not give a street, a town and a postcode.
 *
 * Works on the plain-text rendering (the mail's own text part, or `htmlToText`), because the two
 * differ: GLS lays the block out as `<br>`-separated lines inside one `<strong>`, so the town arrives
 * after a comma in one rendering and after a newline in the other. Both are read the same way here -
 * the lesson of the Z-BOX code, whose digits turned out to be newline-separated in the real bytes.
 */
export function pickupFromMail(text: string): MailPickupPoint | undefined {
  const haystack = text.slice(0, MAX_TEXT).normalize('NFC')
  const labels = PICKUP_LABELS
    .flatMap(re => [...haystack.matchAll(re)].map(m => m.index + m[0].length))
    .sort((a, b) => a - b)
    .slice(0, PICKUP_LABELS_TRIED)
  for (const from of labels) {
    const point = parsePickupBlock(haystack.slice(from, from + PICKUP_REGION))
    if (point) return point
  }
  return undefined
}

/**
 * One block, as the parts the templates separate it into: commas, newlines, and a run of two or more
 * spaces - which is what a collapsed table-cell boundary looks like in the text rendering, and the
 * only thing that tells `000 00 TESTVILLE   Otváracie hodiny: ...` apart from a town with two words.
 *
 * The postcode is the anchor. Everything before it in its own part is the street; everything after it
 * is the town; when its part holds nothing but the postcode (GLS prints `82101, Bratislava`), the
 * street is the part above and the town the part below. Whatever is left above that is the name - and
 * it is re-joined with the comma it was split on, so `Z-BOX Bratislava, Nevädzová 6 (OC Retro)` comes
 * back whole.
 */
function parsePickupBlock(region: string): MailPickupPoint | undefined {
  const parts: string[] = []
  for (const raw of region.split(/[,;\n\r]|[ \t ]{2,}/)) {
    const part = cleanPart(raw)
    if (part) parts.push(part)
    if (parts.length >= PICKUP_PARTS) break
  }
  const at = parts.findIndex(p => POSTCODE.test(p))
  if (at < 0) return undefined
  const m = POSTCODE_IN_PART.exec(parts[at]!)
  if (!m) return undefined

  // How many parts above the postcode belong to the address rather than to the name: none when the
  // street sits in the postcode's own part, one normally, and two when a table cell split a street
  // from its house number ("NEVÄDZOVÁ" | "6", DPD's html with no text part to fall back on).
  const bareNumber = at >= 2 && /^\d+[a-z]?$/i.test(parts[at - 1]!)
  const above = m[1] ? 0 : bareNumber ? 2 : 1
  const name = parts.slice(0, Math.max(0, at - above))
  const street = cleanPart(m[1]!) ?? (above > 0 ? parts.slice(at - above, at).join(' ') : undefined)
  const city = cleanPart(m[3]!) ?? parts[at + 1]
  if (!street || !city) return undefined
  // A street with no house number is a fragment of prose, not an address.
  if (!/\d/.test(street) || !/\p{L}/u.test(street) || street.length > STREET_MAX) return undefined
  if (city.length > CITY_MAX || !CITY.test(city)) return undefined

  const label = name.join(', ')
  return {
    kind: KINDS.find(([re]) => re.test(label))?.[1] ?? 'unknown',
    ...(label && label.length <= NAME_MAX && { name: label }),
    street,
    city,
    postalCode: m[2]!,
  }
}

/** One part of a block, with the link text, the bullets and the stray punctuation taken off. */
function cleanPart(raw: string): string | undefined {
  const out = raw
    .replace(/\[[^\]]*\]/g, ' ')                  // htmlToText's and mailparser's [https://...] link text
    .replace(/\b(?:https?|mailto):\S+/gi, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏­͏]+/g, ' ')
    .replace(/[\s ]+/g, ' ')
    .replace(/^[\s»«·•|:–-]+|[\s»«·•|:]+$/g, '')
  return out === '' ? undefined : out
}
