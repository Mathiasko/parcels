// The scenario kit: a small vocabulary for writing one persona's 14 days as carrier lifecycles, shop
// mail and noise. Each helper adds the carrier-side timeline (what the tracking API answers, and when)
// and the mails that go with it, rendered with the fake-mail harness's templates. Times are day-relative,
// 'D3 07:40' (Europe/Bratislava wall time; day 0 is setup day). Everything here is invented: numbers have
// the carriers' real shapes so they parse, people and shops are fictional, non-carriers use example.* domains.
//
// Mail fields: `at` (or `trigger`, for mail that only exists once the persona acts), `cond` (sent only if
// the condition still holds when it is due), `about` (operator-only note; never shown to the persona).
import { encodeWords, s10 } from '../../fake-mail/mime.mjs'
import { dhl, dpd, gls, htmlShell, packeta, posta, shopDispatch, spaced, sps } from '../../fake-mail/templates.mjs'

export { s10, spaced, htmlShell, dpd }

/** A display name with non-ASCII letters must be an RFC 2047 encoded word in a header. */
const encodeName = h => h.replace(/^"?([^"<]*?)"?\s*<([^>]+)>$/, (all, name, addr) => (/^[\x20-\x7e]*$/.test(name) ? all : `${encodeWords(name, 'utf-8', 'Q')} <${addr}>`))
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const pad = n => String(n).padStart(2, '0')

export const FROM = {
  packeta: 'Packeta Slovakia <noreply@packeta.sk>',
  zasilkovna: 'Zásilkovna <noreply@zasilkovna.cz>',
  dpd: '"DPD" <no_reply@dpd.sk>',
  gls: 'GLS Slovakia <noreply@gls-slovakia.sk>',
  sps: 'serv@sps-sro.sk',
  posta: 'Slovenská pošta <notifikacie@posta.sk>',
  dhl: 'DHL Express <noreply@dhl.com>',
}

/** Shapes per carrier, built from one persona digit so every number is visibly synthetic. */
export function numbers(d) {
  const r = n => d.repeat(n)
  return {
    Z: n => `Z${r(8)}${pad(n)}`,                         // Z + 10 digits
    DPD: n => `01505${r(7)}${pad(n)}`,                   // 14 digits
    GLS: n => `90${r(7)}${pad(n)}`,                      // 11 digits
    EB: n => s10('EB', `${r(6)}${pad(n)}`),              // S10 with a correct check digit, ...SK
    RB_CN: n => s10('RB', `${r(6)}${pad(n)}`, 'CN'),     // inbound international, ...CN
    SPS: (tag, n) => `SK0FAKE26${tag}${'0'.repeat(9 - tag.length - 2)}${pad(n)}`,
    SPS703: n => `703${r(11)}0${n % 10}`,                // 16 digits, 15th is 0-4
    JJD: n => `JJD000${r(10)}${pad(n)}`,
    LP: n => `LP00${r(10)}${pad(n)}`,                    // Cainiao: no supported carrier
  }
}

export class Scenario {
  /**
   * meta: { id, fullName, email, digit, day0 ('YYYY-MM-DD'), postcode, town, away?: number[],
   *         firstRun?: 'welcome'|'move-in', release?: { day, tag, body } }
   */
  constructor(meta) {
    this.meta = { away: [], firstRun: 'welcome', ...meta }
    this.n = numbers(meta.digit)
    this.parcels = []
    this.mails = []
    this.points = []
  }

  // ---------------------------------------------------------------- time
  /** 'D3 07:40' -> 'YYYY-MM-DD HH:MM' (local). */
  local(at) {
    const m = /^D(-?\d+) (\d{2}):(\d{2})$/.exec(at)
    if (!m) throw new Error(`bad time ${at}`)
    const [y, mo, d] = this.meta.day0.split('-').map(Number)
    const t = new Date(Date.UTC(y, mo - 1, d + Number(m[1])))
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${m[2]}:${m[3]}`
  }
  day(at) { return Number(/^D(-?\d+)/.exec(at)[1]) }
  hm(at) { return at.split(' ')[1] }
  plusMin(at, min) {
    let day = this.day(at)
    let [h, m] = this.hm(at).split(':').map(Number)
    let t = h * 60 + m + min
    while (t >= 1440) { t -= 1440; day++ }
    while (t < 0) { t += 1440; day-- }
    return `D${day} ${pad(Math.floor(t / 60))}:${pad(t % 60)}`
  }
  at(day, hm) { return `D${day} ${hm}` }
  /** 'DD.MM.YYYY' for day n. */
  dmy(day, sep = '.') {
    const [y, mo, d] = this.local(`D${day} 00:00`).split(' ')[0].split('-')
    return sep === '. ' ? `${Number(d)}. ${Number(mo)}. ${y}` : `${d}${sep}${mo}${sep}${y}`
  }

  // ---------------------------------------------------------------- primitives
  point(p) { this.points.push(p); return p }

  mail(m) {
    const id = `m${pad(this.mails.length + 1)}`
    const domain = /@([^>\s]+)/.exec(m.from)?.[1] ?? 'example.com'
    const spec = {
      from: m.from, subject: m.subject, to: encodeName(m.to ?? `${this.meta.fullName} <${this.meta.email}>`),
      messageId: m.messageId ?? `<${this.meta.id}.${id}.${(m.tag ?? 'mail').replace(/[^\w.-]/g, '')}@${domain}>`,
      ...(m.text !== undefined && { text: m.text }), ...(m.html !== undefined && { html: m.html }),
      ...(m.htmlEncoding && { htmlEncoding: m.htmlEncoding }), ...(m.encoding && { encoding: m.encoding }),
      ...(m.charset && { charset: m.charset }), ...(m.subjectCharset && { subjectCharset: m.subjectCharset }),
      ...(m.attachments && { attachments: m.attachments }),
      deliveredTo: this.meta.email,
    }
    this.mails.push({ id, ...(m.at && { at: m.at }), ...(m.trigger && { trigger: m.trigger }), ...(m.cond && { cond: m.cond }), about: m.about ?? '', spec })
    return id
  }

  parcel(p) { this.parcels.push({ owner: 'me', ...p }); return p }

  // ---------------------------------------------------------------- generic shop and noise mail
  /** Slovak e-shop "dispatched" mail (templates.mjs shopDispatch). */
  shopSk({ at, shop, from, subject, order, carrierLine, numberLine, items = [], extra = '', greeting, about }) {
    return this.mail({ at, from, subject, tag: `ship-${order}`, about, ...shopDispatch({ shop, order, carrierLine, numberLine, items, extra, ...(greeting && { greeting }) }) })
  }

  /** Any plain mail: lines of text, and an html version made from them. */
  plain({ at, cond, trigger, from, subject, lines, html = true, brand = '#444', about, tag, lang = 'sk', to }) {
    const text = `${lines.join('\n')}\n`
    return this.mail({
      at, cond, trigger, from, subject, tag, about, text, to,
      ...(html && { html: htmlShell({ title: subject, brand, logo: /^"?([^"<]+)/.exec(from)[1].trim(), body: lines.map(l => (l ? `<p>${esc(l)}</p>` : '')).join(''), footer: lang === 'en' ? 'You received this e-mail because you have an account with us.' : 'Tento e-mail bol vygenerovaný automaticky.' }) }),
    })
  }

  /** English marketplace dispatch (AliExpress / Temu / Shein). */
  shopEn({ at, from, subject, hi, order, carrier, number, items = [], eta, about, extra = [] }) {
    return this.plain({
      at, from, subject, about, lang: 'en', tag: `en-${order}`,
      lines: [`Hi ${hi},`, '', `Good news! Your order ${order} has been shipped.`, carrier ? `Carrier: ${carrier}` : '', number ? `Tracking number: ${number}` : '', eta ? `Estimated delivery: ${eta}` : '', '', 'Items:', ...items.map(i => ` - ${i}`), ...extra, '', 'Track your order in the app.', ''],
    })
  }

  /** Czech e-shop "odeslána" mail. */
  shopCz({ at, shop, from, subject, order, carrierLine, numberLine, items = [], about }) {
    return this.plain({
      at, from, subject, about, tag: `cz-${order}`,
      lines: ['Dobrý den,', '', `vaše objednávka č. ${order} byla právě odeslána.`, carrierLine, numberLine, '', 'Obsah zásilky:', ...items.map(i => ` - ${i}`), '', 'Děkujeme za nákup!', `Tým ${shop}`],
    })
  }

  // ---------------------------------------------------------------- Packeta / Zásilkovna
  /**
   * o: { key, number, sender, place, code?, accepted, transit?, ready, keep=7, cod?, order?, lang='sk',
   *      mails?: { accepted, ready, reminder, pickedup, returning } (default all true), owner?, label }
   * Deadline is the `keep`-th day after `ready`, 23:59. Pick-up is the persona's: `sim collect`.
   */
  packeta(o) {
    const cz = o.lang === 'cz'
    const zbox = /z-box/i.test(o.place.name)
    const T = cz
      ? { pre: 'Zásilka byla podána.', transit: 'Zásilka je na cestě.', ready: zbox ? 'Zásilka je připravena k vyzvednutí v Z-BOXu.' : 'Zásilka je připravena k vyzvednutí na výdejním místě.', picked: 'Zásilka byla vyzvednuta.', returning: 'Zásilka nebyla vyzvednuta v úložní době, vracíme ji odesílateli.', returned: 'Zásilka byla vrácena odesílateli.' }
      : { pre: 'Zásielka bola podaná odosielateľom.', transit: 'Zásielka je na ceste.', ready: zbox ? 'Zásielka bola uložená v Z-BOXe a čaká na vyzdvihnutie.' : 'Zásielka bola doručená na výdajné miesto.', picked: 'Zásielka bola vyzdvihnutá.', returning: 'Zásielka nebola vyzdvihnutá v úložnej dobe, vraciame ju odosielateľovi.', returned: 'Zásielka bola vrátená odosielateľovi.' }
    const keep = o.keep ?? 7
    const deadlineDay = this.day(o.ready) + keep
    const deadline = this.dmy(deadlineDay)
    const transit = o.transit ?? this.plusMin(o.accepted, 12 * 60)
    this.parcel({
      key: o.key, carrier: 'packeta', number: o.number, label: o.label ?? `${o.sender} via Packeta`, owner: o.owner,
      events: [{ at: o.accepted, status: 'pre_transit', text: T.pre }, { at: transit, status: 'in_transit', text: T.transit }],
      ready: { at: o.ready, text: T.ready, pickup: { kind: zbox ? 'zbox' : 'parcelshop', name: o.place.name, street: o.place.street, city: o.place.city }, till: `D${deadlineDay} 23:59`, code: o.code, hours: o.place.hours ?? (zbox ? '24/7' : 'shop'), where: o.place.name },
      collect: { lagMin: 3, text: T.picked },
      expire: { returningText: T.returning, returnedText: T.returned },
      ...(o.cod && { cod: o.cod }),
    })
    const want = { accepted: true, ready: true, reminder: true, pickedup: true, returning: true, ...o.mails }
    const z = spaced(o.number)
    const from = cz ? FROM.zasilkovna : FROM.packeta
    const mk = (kind, extra) => cz ? czPacketa({ kind, number: o.number, sender: o.sender, place: o.place, code: o.code, deadline, cod: o.cod }) : packeta({ kind, number: o.number, sender: o.sender, place: o.place, code: o.code, deadline, cod: o.cod, order: o.order, ...extra })
    const subj = cz
      ? { accepted: `Zásilka ${z} je na cestě`, ready: 'Zásilka je připravena k vyzvednutí', reminder: 'Připomínáme: zásilka na vás čeká', pickedup: 'Zásilka byla vyzvednuta', returning: 'Zásilka bude vrácena odesílateli' }
      : { accepted: 'Zásielka bola prijatá do prepravy', ready: 'Zásielka je pripravená na vyzdvihnutie', reminder: `Pripomíname: zásielka na vás čaká ${zbox ? 'v Z-BOXe' : 'na výdajnom mieste'}`, pickedup: 'Zásielka bola vyzdvihnutá', returning: 'Zásielka bude vrátená odosielateľovi' }
    const owner = o.owner === 'flatmate' ? ' (flatmate)' : ''
    if (want.accepted) this.mail({ at: this.plusMin(o.accepted, 8), from, subject: subj.accepted, tag: `${o.number}-acc`, about: `${o.key}${owner}: Packeta accepted`, ...mk('accepted') })
    if (want.ready) this.mail({ at: this.plusMin(o.ready, 4), from, subject: subj.ready, tag: `${o.number}-ready`, about: `${o.key}${owner}: Packeta ready${o.code ? `, code ${o.code}` : ''}, until ${deadline}`, ...mk('ready') })
    if (want.reminder) this.mail({ at: `D${deadlineDay - 1} 10:00`, cond: { notCollected: o.key }, from, subject: subj.reminder, tag: `${o.number}-rem`, about: `${o.key}: reminder, day before the deadline (only if not collected)`, ...mk('reminder') })
    if (want.pickedup) this.mail({ trigger: { afterCollect: o.key, min: 6 }, from, subject: subj.pickedup, tag: `${o.number}-picked`, about: `${o.key}: picked-up confirmation (after sim collect)`, ...mk('pickedup') })
    if (want.returning) this.mail({ at: `D${deadlineDay + 1} 09:30`, cond: { notCollected: o.key }, from, subject: subj.returning, tag: `${o.number}-ret`, about: `${o.key}: not collected in time, returning`, ...mk('returning') })
    return o
  }

  // ---------------------------------------------------------------- DPD
  /** Courier to the door. o: { key, number, sender, shipped, predict, window, delivered | attempts:[{at,ok}], courier } */
  dpdHome(o) {
    const events = [{ at: o.shipped, status: 'pre_transit', text: 'Údaje o zásielke boli prijaté', location: o.from ?? 'Bratislava' },
      { at: this.plusMin(o.shipped, 9 * 60), status: 'in_transit', text: 'Zásielka na ceste', location: 'Senec Hub' }]
    const courier = o.courier ?? { name: 'Marek', phone: '+421 900 000 101' }
    const visits = o.attempts ?? [{ at: o.delivered, ok: true }]
    for (const v of visits) {
      const outAt = `D${this.day(v.at)} 06:50`
      events.push({ at: outAt, status: 'out_for_delivery', text: 'Kuriér doručuje', location: this.meta.town })
      events.push(v.ok ? { at: v.at, status: 'delivered', text: 'Doručené', location: this.meta.town } : { at: v.at, status: 'failed_attempt', text: 'Adresát nezastihnutý', location: this.meta.town })
      this.mail({ at: `D${this.day(v.at)} 07:25`, from: FROM.dpd, subject: 'Vaša zásielka bude doručená dnes', tag: `${o.number}-pred-${this.day(v.at)}`, about: `${o.key}: DPD Predict for day ${this.day(v.at)}`, html: dpd({ kind: 'predict', number: o.number, sender: o.sender, window: v.window ?? o.window, courier }), htmlEncoding: 'base64' })
      this.mail({ at: this.plusMin(v.at, 12), from: FROM.dpd, subject: v.ok ? 'Vaša zásielka bola doručená' : 'Neúspešný pokus o doručenie zásielky', tag: `${o.number}-${v.ok ? 'del' : 'fail'}-${this.day(v.at)}`, about: `${o.key}: ${v.ok ? 'delivered to the door' : 'failed attempt (nobody home)'}`, html: dpd({ kind: v.ok ? 'delivered' : 'failed', number: o.number, sender: o.sender }), htmlEncoding: 'base64' })
    }
    this.parcel({ key: o.key, carrier: 'dpd', number: o.number, label: o.label ?? `${o.sender} via DPD (door)`, events, ...(o.tail && { tail: o.tail }) })
    return o
  }

  /** DPD Pickup Station / Pickup point. o: { key, number, sender, shipped, ready, station, pin, keep=7, mails? } */
  dpdStation(o) {
    const keep = o.keep ?? 7
    const dd = this.day(o.ready) + keep
    const deadline = this.dmy(dd)
    this.parcel({
      key: o.key, carrier: 'dpd', number: o.number, label: o.label ?? `${o.sender} via DPD Pickup`, owner: o.owner,
      events: [{ at: o.shipped, status: 'pre_transit', text: 'Údaje o zásielke boli prijaté', location: 'Bratislava' }, { at: this.plusMin(o.shipped, 10 * 60), status: 'in_transit', text: 'Zásielka na ceste', location: 'Senec Hub' }],
      ready: { at: o.ready, text: 'Uložené v Pickup Station', location: o.station.city, pickup: { kind: 'locker', name: o.station.name, street: o.station.street, city: o.station.city, postalCode: o.station.zip.replace(/\s/g, '') }, till: `D${dd} 23:59`, code: o.pin, hours: '24/7', where: o.station.name },
      collect: { lagMin: 2, text: 'Vyzdvihnuté v Pickup Station', location: o.station.city },
      expire: { returningText: 'Zásielka sa vracia odosielateľovi', returnedText: 'Zásielka vrátená odosielateľovi' },
    })
    const want = { transit: true, station: true, reminder: true, delivered: true, ...o.mails }
    if (want.transit) this.mail({ at: this.plusMin(o.shipped, 30), from: FROM.dpd, subject: 'Vaša zásielka je na ceste do Pickup Station', tag: `${o.number}-tr`, about: `${o.key}: DPD on its way to the station`, html: dpd({ kind: 'transit', number: o.number, sender: o.sender }), htmlEncoding: 'base64' })
    if (want.station) this.mail({ at: this.plusMin(o.ready, 6), from: FROM.dpd, subject: 'Informácia o uložení zásielky v samoobslužnom boxe Pickup Station', tag: `${o.number}-ps`, about: `${o.key}: DPD station ready, PIN ${o.pin}, until ${deadline}`, html: dpd({ kind: 'station', number: o.number, sender: o.sender, station: o.station, pin: o.pin, deadline }), htmlEncoding: 'base64' })
    if (want.reminder) this.mail({ at: `D${dd - 1} 09:00`, cond: { notCollected: o.key }, from: FROM.dpd, subject: 'Informácia o uložení zásielky v samoobslužnom boxe Pickup Station', tag: `${o.number}-ps2`, about: `${o.key}: DPD station reminder (same subject, only if not collected)`, html: dpd({ kind: 'stationReminder', number: o.number, sender: o.sender, station: o.station, pin: o.pin, deadline }), htmlEncoding: 'base64' })
    if (want.delivered) this.mail({ trigger: { afterCollect: o.key, min: 5 }, from: FROM.dpd, subject: 'Vaša zásielka bola doručená', tag: `${o.number}-del`, about: `${o.key}: DPD collected confirmation`, html: dpd({ kind: 'delivered', number: o.number, sender: o.sender }), htmlEncoding: 'base64' })
    return o
  }

  // ---------------------------------------------------------------- GLS
  /** o: { key, number, sender, accepted, delivered | (ready, point, pin, keep), transitWindow, courier } */
  gls(o) {
    const events = [{ at: o.accepted, status: 'pre_transit', text: 'Údaje o balíku boli zaregistrované' },
      { at: this.plusMin(o.accepted, 11 * 60), status: 'in_transit', text: 'Balík je na ceste', location: 'Sered' }]
    const send = (at, kind, subject, extra, about, tag, more = {}) => this.mail({ at, from: FROM.gls, subject, tag: `${o.number}-${tag}`, about: `${o.key}: ${about}`, html: gls({ kind, number: o.number, sender: o.sender, ...extra }), ...more })
    send(this.plusMin(o.accepted, 20), 'accepted', `Balík ${o.number} sme prevzali od odosielateľa`, {}, 'GLS accepted', 'acc')
    if (o.delivered) {
      events.push({ at: `D${this.day(o.delivered)} 06:40`, status: 'out_for_delivery', text: 'Balík je na doručení' })
      events.push({ at: o.delivered, status: 'delivered', text: 'Balík bol doručený' })
      send(`D${this.day(o.delivered)} 07:10`, 'transit', `Váš balík ${o.number} je na ceste`, { window: o.transitWindow ?? 'dnes medzi 9:00 a 12:00', courier: o.courier }, 'GLS out for delivery today', 'tr')
      send(this.plusMin(o.delivered, 9), 'delivered', `Balík ${o.number} bol doručený`, {}, 'GLS delivered to the door', 'del')
      this.parcel({ key: o.key, carrier: 'gls', number: o.number, label: o.label ?? `${o.sender} via GLS (door)`, events })
      return o
    }
    const keep = o.keep ?? 7
    const dd = this.day(o.ready) + keep
    const deadline = this.dmy(dd, '. ')
    const box = /box/i.test(o.point.name)
    this.parcel({
      key: o.key, carrier: 'gls', number: o.number, label: o.label ?? `${o.sender} via GLS ${box ? 'BOX' : 'ParcelShop'}`, owner: o.owner, events,
      // GLS's API answers "ready" without a pickup point (DELIVEREDPS), as world.ts models it.
      ready: { at: o.ready, text: box ? 'Balík bol doručený do GLS BOXu' : 'Balík bol doručený do GLS ParcelShopu', till: `D${dd} 23:59`, code: o.pin, hours: box ? '24/7' : 'shop', where: o.point.name, noPickupInApi: true },
      collect: { lagMin: 4, text: 'Balík bol vyzdvihnutý' },
      expire: { returningText: 'Balík sa vracia odosielateľovi', returnedText: 'Balík bol vrátený odosielateľovi' },
    })
    send(this.plusMin(o.ready, 7), 'ready', `Balík ${o.number} je pripravený k vyzdvihnutiu`, { pin: o.pin, deadline, point: o.point }, `GLS ready, PIN ${o.pin}, until ${deadline}`, 'ready')
    send(`D${dd - 1} 10:00`, 'reminder', `Posledná možnosť vyzdvihnúť balík ${o.number}`, { pin: o.pin, deadline, point: o.point }, 'GLS last-chance reminder (only if not collected)', 'rem', { cond: { notCollected: o.key } })
    this.mail({ trigger: { afterCollect: o.key, min: 8 }, from: FROM.gls, subject: `Balík ${o.number} bol doručený`, tag: `${o.number}-del`, about: `${o.key}: GLS collected`, html: gls({ kind: 'delivered', number: o.number, sender: o.sender }) })
    return o
  }

  // ---------------------------------------------------------------- SPS
  /** o: { key, number, sender, shipped, delivered | (ready, place, code, keep), cod?, phone? } */
  sps(o) {
    const events = [{ at: o.shipped, status: 'pre_transit', text: 'Zásielka prevzatá od odosielateľa' }, { at: this.plusMin(o.shipped, 13 * 60), status: 'in_transit', text: 'Zásielka na triediacom centre' }]
    const cp = { charset: 'windows-1250', encoding: 'quoted-printable' }
    if (o.delivered) {
      events.push({ at: `D${this.day(o.delivered)} 07:05`, status: 'out_for_delivery', text: 'Zásielka na doručení' }, { at: o.delivered, status: 'delivered', text: 'Zásielka doručená' })
      this.mail({ at: `D${this.day(o.delivered)} 07:40`, from: FROM.sps, subject: `Doručenie zásielky ${o.number} dnes`, tag: `${o.number}-today`, about: `${o.key}: SPS courier today`, ...cp, ...sps(`vaša zásielka cislo ${o.number} od ${o.sender} bude dnes doručená kuriérom na adresu.${o.cod ? ` Suma na úhradu (dobierka): ${o.cod}.` : ''} Kuriér: ${o.phone ?? '0900 000 202'}.`) })
      this.parcel({ key: o.key, carrier: 'sps', number: o.number, label: o.label ?? `${o.sender} via SPS (door)`, events })
      return o
    }
    const keep = o.keep ?? 5
    const dd = this.day(o.ready) + keep
    this.parcel({
      key: o.key, carrier: 'sps', number: o.number, label: o.label ?? `${o.sender} via SPS balíkovo`, events,
      ready: { at: o.ready, text: 'Zásielka v odbernom mieste', pickup: { kind: 'parcelshop' }, till: `D${dd} 18:00`, code: o.code, hours: 'shop', where: o.place.name },
      collect: { lagMin: 10, text: 'Zásielka vydaná príjemcovi' },
      expire: { returningText: 'Zásielka sa vracia odosielateľovi', returnedText: 'Zásielka vrátená odosielateľovi' },
    })
    this.mail({ at: this.plusMin(o.ready, 10), from: FROM.sps, subject: `Zasielka v odbernom mieste balikovo: ${o.number}`, tag: `${o.number}-ready`, about: `${o.key}: SPS ready at balíkovo, code ${o.code}`, charset: 'windows-1250', encoding: 'base64', ...sps(`vaša zásielka cislo ${o.number} od ${o.sender} je pripravená na vyzdvihnutie v odbernom mieste ${o.place.name}, ${o.place.street}, ${o.place.city} (https://www.sps-sro.sk/) do ${this.dmy(dd)} 18:00. Verifikačný kód: ${o.code}.`) })
    this.mail({ trigger: { afterCollect: o.key, min: 15 }, from: FROM.sps, subject: `Zasielka ${o.number} bola dorucena`, tag: `${o.number}-del`, about: `${o.key}: SPS collected`, ...cp, ...sps(`vaša zásielka cislo ${o.number} bola vyzdvihnutá v odbernom mieste balíkovo. Ďakujeme.`) })
    return o
  }

  // ---------------------------------------------------------------- Slovenská pošta
  /** o: { key, number, posted, ready, office, keep=10, cod?, box?: { pin }, reminderDaysBefore=3, lead? } */
  posta(o) {
    const keep = o.keep ?? 10
    const dd = this.day(o.ready) + keep
    const box = !!o.box
    const deadline = box ? `${this.dmy(dd)} 23:59` : this.dmy(dd)
    this.parcel({
      key: o.key, carrier: 'posta', number: o.number, label: o.label ?? `Slovenská pošta ${box ? 'BalíkoBOX' : 'office'}`,
      events: [{ at: o.posted, status: 'pre_transit', text: 'Podanie zásielky', location: o.postedAt ?? 'Bratislava 1' }, { at: this.plusMin(o.posted, 14 * 60), status: 'in_transit', text: 'Zásielka na ceste', location: 'SPU Bratislava' }, ...(o.extraEvents ?? [])],
      ready: { at: o.ready, text: box ? 'Uloženie zásielky v BalíkoBOXe' : 'Uloženie zásielky na pošte', location: o.office.city, pickup: { kind: box ? 'locker' : 'post_office', name: o.office.name, street: o.office.street, city: o.office.city, postalCode: o.office.zip.replace(/\s/g, '') }, till: `D${dd} ${box ? '23:59' : '18:00'}`, code: box ? o.box.pin : undefined, hours: box ? '24/7' : 'post', where: o.office.name, needsId: !box },
      collect: { lagMin: box ? 20 : 24 * 60 - 300, text: 'Dodanie zásielky', location: o.office.city },   // the post office reports the hand-over the next morning
      expire: { returningText: 'Vrátenie zásielky odosielateľovi', returnedText: 'Zásielka vrátená odosielateľovi', returnAfterH: box ? 6 : 30 },
      ...(o.cod && { cod: o.cod }),
    })
    const lead = o.lead ?? (box ? `Vaša zásielka bola uložená v BalíkoBOXe. Vyzdvihnite si ju do ${keep} dní.` : 'oznamujeme Vám, že zásielka adresovaná na Vaše meno je uložená na pošte.')
    this.mail({ at: this.plusMin(o.ready, 25), from: FROM.posta, subject: box ? `Zásielka ${o.number} je uložená v BalíkoBOXe` : `Oznámenie o uložení zásielky ${o.number}`, tag: `${o.number}-ready`, about: `${o.key}: posta stored, until ${deadline}${o.cod ? `, COD ${o.cod}` : ''}`, ...posta({ lead, number: o.number, office: o.office, deadline, cod: o.cod, pin: o.box?.pin }) })
    const rb = o.reminderDaysBefore ?? 3
    if (rb) this.mail({ at: `D${dd - rb} 10:00`, cond: { notCollected: o.key }, from: FROM.posta, subject: `Pripomienka: zásielka ${o.number} čaká na pošte`, tag: `${o.number}-rem`, about: `${o.key}: posta reminder ${rb} days before (only if not collected)`, ...posta({ lead: 'pripomíname Vám, že zásielka adresovaná na Vaše meno je stále uložená. Ak si ju nevyzdvihnete v úložnej lehote, vrátime ju odosielateľovi.', number: o.number, office: o.office, deadline, cod: o.cod, pin: o.box?.pin }) })
    return o
  }

  /** Posta letter-carrier delivery to the door (no pickup). o: { key, number, posted, delivered } */
  postaHome(o) {
    this.parcel({ key: o.key, carrier: 'posta', number: o.number, label: o.label ?? 'Slovenská pošta (door)', events: [
      { at: o.posted, status: 'pre_transit', text: 'Podanie zásielky', location: 'Bratislava 1' },
      { at: this.plusMin(o.posted, 14 * 60), status: 'in_transit', text: 'Zásielka na ceste', location: 'SPU Bratislava' },
      { at: `D${this.day(o.delivered)} 07:30`, status: 'out_for_delivery', text: 'Zásielka v doručovaní', location: this.meta.town },
      { at: o.delivered, status: 'delivered', text: 'Dodanie zásielky', location: this.meta.town },
    ] })
    return o
  }

  // ---------------------------------------------------------------- DHL Express (email-only carrier: no API)
  dhlExpress(o) {
    this.mail({ at: o.shipped, from: FROM.dhl, subject: `DHL On Demand Delivery: Your shipment ${o.number} is on its way`, tag: `${o.number}-ship`, about: `${o.key}: DHL dispatched`, ...dhl({ lead: `Your shipment from ${o.sender} is on its way and will be delivered on ${o.etaText}.`, number: o.number, rows: [['Pieces', String(o.pieces ?? 1)], ['Weight', o.weight ?? '1.2 kg'], ['Customer service', '+421 900 000 303']] }) })
    if (o.duty) this.mail({ at: o.duty.at, from: FROM.dhl, subject: 'Clo a DPH na úhradu – zásielka DHL Express', tag: `${o.number}-duty`, about: `${o.key}: customs ${o.duty.amount}`, ...dhl({ lead: `Vaša zásielka čaká na colné odbavenie. Pred doručením je potrebné uhradiť clo a DPH vo výške ${o.duty.amount}. / Duties and taxes of ${o.duty.amount} are due before delivery.`, number: o.number, rows: [['Suma na úhradu', o.duty.amount], ['Splatnosť', o.duty.due]] }) })
    if (o.delivered) this.mail({ at: o.delivered, from: FROM.dhl, subject: `Your DHL shipment ${o.number} has been delivered`, tag: `${o.number}-del`, about: `${o.key}: DHL delivered`, ...dhl({ lead: `Your shipment has been delivered. Signed for by: ${o.signedBy ?? 'RECIPIENT'}.`, number: o.number }) })
    this.parcel({ key: o.key, carrier: 'dhl', number: o.number, label: o.label ?? `${o.sender} via DHL Express`, events: [], emailOnly: true })
    return o
  }

  // ---------------------------------------------------------------- Alza's own AlzaBox (no carrier, no tracking API)
  /** o: { key, order, ready, box: {name}, code, keep=3, amount? } */
  alzaBox(o) {
    const keep = o.keep ?? 3
    const dd = this.day(o.ready) + keep
    const FROM_ALZA = 'Alza.sk <objednavky@alza.example.sk>'
    this.parcel({ key: o.key, carrier: 'alza', number: `ALZA${o.order}`, label: o.label ?? `Alza order ${o.order} in AlzaBox`, emailOnly: true, events: [],
      ready: { at: o.ready, text: 'AlzaBox', till: `D${dd} 23:59`, code: o.code, hours: '24/7', where: o.box.name },
      collect: { lagMin: 1, text: 'Vyzdvihnuté' } })
    this.plain({ at: this.plusMin(o.ready, 3), from: FROM_ALZA, subject: `Objednávka ${o.order} je pripravená na vyzdvihnutie v AlzaBoxe`, tag: `alza-${o.order}-ready`, brand: '#1a73e8', about: `${o.key}: AlzaBox ready, code ${o.code}, until ${this.dmy(dd)} (Alza's own delivery: no carrier, no tracking number)`,
      lines: ['Dobrý deň,', '', `vaša objednávka ${o.order} je pripravená na vyzdvihnutie v ${o.box.name}.`, `Kód pre vyzdvihnutie: ${o.code}`, `Vyzdvihnite si ju do ${this.dmy(dd)}.`, o.items ? `Obsah: ${o.items}` : '', '', 'Alza.sk'] })
    this.plain({ at: `D${dd} 09:00`, cond: { notCollected: o.key }, from: FROM_ALZA, subject: `Posledný deň na vyzdvihnutie objednávky ${o.order}`, tag: `alza-${o.order}-last`, brand: '#1a73e8', about: `${o.key}: AlzaBox last day (only if not collected)`,
      lines: ['Dobrý deň,', '', `dnes je posledný deň, kedy si môžete vyzdvihnúť objednávku ${o.order} v ${o.box.name}.`, `Kód pre vyzdvihnutie: ${o.code}`, '', 'Alza.sk'] })
    this.plain({ trigger: { afterCollect: o.key, min: 2 }, from: FROM_ALZA, subject: `Objednávka ${o.order} bola vyzdvihnutá`, tag: `alza-${o.order}-done`, brand: '#1a73e8', about: `${o.key}: AlzaBox collected`,
      lines: ['Dobrý deň,', '', `ďakujeme, objednávku ${o.order} ste si vyzdvihli.`, 'Ohodnoťte svoj nákup a získajte AlzaKredit.', '', 'Alza.sk'] })
    return o
  }

  /** A parcel the persona SENDS (a return), tracked by Packeta: o: { key, number, to, posted, delivered, dropAt } */
  packetaReturn(o) {
    this.parcel({ key: o.key, carrier: 'packeta', number: o.number, label: o.label ?? `return to ${o.to} (outgoing)`, events: [
      { at: o.posted, status: 'pre_transit', text: 'Zásielka bola podaná odosielateľom.' },
      { at: this.plusMin(o.posted, 10 * 60), status: 'in_transit', text: 'Zásielka je na ceste.' },
      { at: o.delivered, status: 'delivered', text: 'Zásielka bola doručená príjemcovi.' },
    ] })
    const z = spaced(o.number)
    this.plain({ at: this.plusMin(o.posted, 5), from: FROM.packeta, subject: `Zásielka ${z} bola podaná`, tag: `${o.number}-sent`, brand: '#ba1b02', about: `${o.key}: return parcel handed in (persona is the SENDER)`,
      lines: [`Zásielka ${z}`, '', 'Dobrý deň,', `vaša zásielka pre príjemcu ${o.to} bola podaná ${o.dropAt ? `v ${o.dropAt}` : ''} a je na ceste.`, '', `Číslo zásielky ${z}`, 'tím Packety'] })
    this.plain({ at: this.plusMin(o.delivered, 6), from: FROM.packeta, subject: `Zásielka ${z} bola doručená príjemcovi`, tag: `${o.number}-deliv`, brand: '#ba1b02', about: `${o.key}: return delivered to the shop`,
      lines: [`Zásielka ${z}`, '', 'Dobrý deň,', `vaša zásielka pre príjemcu ${o.to} bola úspešne doručená.`, '', 'tím Packety'] })
    return o
  }

  toJSON() {
    return { meta: this.meta, points: this.points, parcels: this.parcels, mails: this.mails }
  }
}

/** Czech Zásilkovna mail, modelled on test/fixtures/fake-mail mail 31 (text) with an html part. */
function czPacketa({ kind, number, sender, place, code, deadline, cod }) {
  const z = spaced(number)
  const zbox = /z-box/i.test(place?.name ?? '')
  const lead = {
    accepted: `odesílatel ${sender} nám právě předal vaši zásilku, která vám bude doručena ${zbox ? 'do Z-BOXu' : 'na výdejní místo'}.`,
    ready: `vaše zásilka od odesílatele ${sender} je pro vás připravena k vyzvednutí ${zbox ? 'v Z-BOXu' : 'na výdejním místě'}.`,
    reminder: `připomínáme, že vaše zásilka od odesílatele ${sender} na vás stále čeká. Vyzvedněte si ji nejpozději do ${deadline}.`,
    pickedup: `vaše zásilka ${z} od odesílatele ${sender} byla úspěšně vyzvednuta.`,
    returning: `vaše zásilka od odesílatele ${sender} nebyla vyzvednuta v úložní době, a proto ji vracíme odesílateli.`,
  }[kind]
  const codeBlock = code && (kind === 'ready' || kind === 'reminder') ? `\nKód pro otevření schránky\n${[...code].join('\n')}\n` : ''
  const block = place && ['accepted', 'ready', 'reminder'].includes(kind)
    ? `\nMísto, kde ${kind === 'accepted' ? 'bude' : 'je'} vaše zásilka uložena\n${place.name}\n${place.street} ${place.zip} ${place.city}\n${kind !== 'accepted' ? `Vyzvedněte nejpozději do ${deadline} 23:59.\n` : ''}`
    : ''
  const pay = kind === 'pickedup' || kind === 'returning' ? '' : cod ? `\nK úhradě při převzetí: ${cod}\n` : '\nZaplaceno\n'
  const text = `Zásilka ${z}\n\nDobrý den,\n${lead}\n${codeBlock}${block}${pay}\nČíslo zásilky ${z}\nDěkujeme, že jste si pro doručení vybrali Zásilkovnu.\ntým Zásilkovny\n`
  const html = htmlShell({ title: 'Zásilkovna', brand: '#ba1b02', logo: 'Zásilkovna', preheader: `Zásilka ${z}`, body: text.split('\n').map(l => (l ? `<p>${esc(l)}</p>` : '')).join(''), footer: 'Tento e-mail je generován automaticky, neodpovídejte na něj.' })
  return { text, html }
}
