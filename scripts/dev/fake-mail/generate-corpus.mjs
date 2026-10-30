// Generates the fake parcel-mail corpus into test/fixtures/fake-mail/ (the .eml files, corpus.json with
// each mail's expectation, and MANIFEST.md). Run from the repo root:
//   $N/node scripts/dev/fake-mail/generate-corpus.mjs
// Deterministic: re-running rewrites the same bytes.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildEml, encodeWords, s10 } from './mime.mjs'
import { dhl, dpd, gls, htmlShell, packeta, posta, ppl, shopDispatch, spaced, sps, zasilkovna } from './templates.mjs'

const OUT = 'test/fixtures/fake-mail'
mkdirSync(OUT, { recursive: true })
for (const f of readdirSync(OUT)) if (f.endsWith('.eml')) rmSync(join(OUT, f))

// ---- invented numbers (each carrier's real shape, obviously synthetic) ----
const Z = n => `Z22222222${String(n).padStart(2, '0')}`     // Z2222222201 ...
const DPD = n => `015053333333${String(n).padStart(2, '0')}` // 14 digits
const GLS = n => `904444444${String(n).padStart(2, '0')}`    // 11 digits
const SPS1 = 'SK0FAKE26TEST00001', SPS2 = 'SK0FAKE26TEST00002', SPS703 = '7035555555555501'
const EB = n => s10('EB', `666666${String(n).padStart(2, '0')}`)
const EB_BADCHECK = (() => { const ok = EB(3); return `${ok.slice(0, 10)}${(Number(ok[10]) + 1) % 10}SK` })()
const CN = s10('RB', '66666604', 'CN')
const JJD = 'JJD000777777777701', JVGL = 'JVGL07777777777701', DHL000 = '00077777777777777701', DHL_BARE = '7777777701'

const ZBOX_A = { name: 'Z-BOX Testovo, Hlavná 5 (OC Fiktív)', street: 'Hlavná 5', zip: '999 01', city: 'Testovo' }
const ZBOX_B = { name: 'Z-BOX Testovo, Nová 8 (Lidl)', street: 'Nová 8', zip: '999 01', city: 'Testovo' }
const PP_MISKA = { name: 'Potraviny u Mišky – výdajné miesto', street: 'Pekná cesta 2', zip: '999 02', city: 'Fiktívne Mesto' }
const DPD_STATION = { name: 'Pickup Station Testovo (OC Fiktív)', street: 'HLAVNÁ 5', zip: '999 01', city: 'TESTOVO' }
const GLS_BOX = { name: 'GLS BOX Testovo - Lidl (Nová 8)', street: 'Nová 8', zip: '99901', city: 'Testovo' }
const POSTA_OFFICE = { name: 'Pošta Testovo 1', street: 'Poštová 1', zip: '999 01', city: 'Testovo' }
const BALIKOBOX = { name: 'BalíkoBOX Testovo – OD Prior', street: 'Hlavná 3', zip: '999 01', city: 'Testovo' }

const PPL = n => `408888888${String(n).padStart(2, '0')}`  // 11 digits (also GLS's shape)
const PPL_SHOP = { name: 'PPL Parcelshop Testovice', street: 'Hlavní 1', zip: '999 11', city: 'Testovice' }

const ZBOX_CZ = { name: 'Z-BOX Testovice, Nádražní 3 (Penny)', street: 'Nádražní 3', zip: '999 11', city: 'Testovice' }

const PPL_FROM = 'PPL CZ <noreply@ppl.cz>'
const ZASILKOVNA_FROM = 'Zásilkovna <noreply@zasilkovna.cz>'
const PACKETA_FROM = 'Packeta Slovakia <noreply@packeta.sk>'
const DPD_FROM = '"DPD" <no_reply@dpd.sk>'
const GLS_FROM = 'noreply@gls-slovakia.sk'
const SPS_FROM = 'serv@sps-sro.sk'
const POSTA_FROM = 'Slovenská pošta <notifikacie@posta.sk>'
const DHL_FROM = 'DHL Express <noreply@dhl.com>'
const mid = (local, tag, domain) => `<${local.replace(/\D/g, '')}.${tag}@${domain}>`

/** Every mail: file, local date, what it exercises, what SHOULD happen, and how to build it. */
const mails = []
const add = (file, spec, meta) => mails.push({ file, spec, ...meta })

const pk = (file, date, subject, args, meta, extra = {}) => add(file, {
  from: PACKETA_FROM, date, subject, messageId: mid(date, `${args.number}-${args.kind}`, 'packeta.sk'), ...packeta(args), ...extra,
}, meta)

// ================================ backlog (in the label before the app was set up) ================
add('01-posta-old-stored-at-office.eml', {
  from: POSTA_FROM, date: '2026-08-28 10:05', subject: `Oznámenie o uložení zásielky ${EB(0)}`,
  messageId: mid('2026-08-28 10:05', EB(0), 'posta.sk'),
  ...posta({ lead: 'oznamujeme Vám, že zásielka adresovaná na Vaše meno je uložená na pošte.', number: EB(0), office: POSTA_OFFICE, deadline: '11.09.2026' }),
}, { exercises: 'Slovenská pošta, 48 days old at setup', expect: { parcel: `posta:${EB(0)}`, archived: true } })

pk('02-packeta-old-ready.eml', '2026-09-01 14:22', 'Zásielka je pripravená na vyzdvihnutie',
  { kind: 'ready', number: Z(9), sender: 'Knihomoľ s.r.o.', place: ZBOX_A, code: '118822', deadline: '03.09.2026' },
  { exercises: 'Packeta ready, 44 days old at setup (archive on arrival); old Z-BOX code', expect: { parcel: `packeta:${Z(9)}`, archived: true } })
pk('03-packeta-old-pickedup.eml', '2026-09-02 09:10', 'Zásielka bola vyzdvihnutá',
  { kind: 'pickedup', number: Z(9), sender: 'Knihomoľ s.r.o.' },
  { exercises: 'second old mail for the same archived parcel', expect: { parcel: `packeta:${Z(9)}`, archived: true } })

add('04-eshop-sps-old-dispatch.eml', {
  from: 'Elektro Svet <objednavky@elektrosvet.example.sk>', date: '2026-09-10 16:40',
  subject: 'Objednávka č. 2026090017 bola odoslaná', messageId: mid('2026-09-10 16:40', 'order-2026090017', 'elektrosvet.example.sk'),
  ...shopDispatch({ shop: 'Elektro Svet', order: '2026090017', carrierLine: 'Prepravca: SPS – Slovak Parcel Service (kuriér na adresu)', numberLine: `Číslo zásielky: ${SPS2}`, items: ['Rýchlovarná kanvica 1,7 l'] }),
}, { exercises: 'e-shop dispatch naming SPS, 35 days old at setup -> archived on arrival (setup run says 3 archived); revived by mail 63, so NOT archived at the end', expect: { parcel: `sps:${SPS2}`, archived: false } })

add('05-gls-delivered-25-days-old.eml', {
  from: 'GLS Slovakia <noreply@gls-group.eu>', date: '2026-09-25 13:31',
  subject: `Balík ${GLS(4)} bol doručený`, messageId: mid('2026-09-25 13:31', GLS(4), 'gls-group.eu'),
  html: gls({ kind: 'delivered', number: GLS(4), sender: 'Záhrada Plus s.r.o.' }),
}, { exercises: 'GLS from gls-group.eu (listed domain), 20 days old at setup: NOT archived, polled -> delivered', expect: { parcel: `gls:${GLS(4)}` } })

add('06-eshop-order-confirmation-names-packeta.eml', {
  from: 'Knihomoľ <info@knihomol.example.sk>', date: '2026-10-01 20:14',
  subject: 'Potvrdenie objednávky č. 2026100188', messageId: mid('2026-10-01 20:14', 'conf-2026100188', 'knihomol.example.sk'),
  text: 'Dobrý deň,\n\nďakujeme za vašu objednávku č. 2026100188.\n\nDoprava: Packeta – Z-BOX (2,49 €)\nPlatba: kartou online\nSpolu: 41,37 €\n\nO odoslaní vás budeme informovať e-mailom.\n\nKnihomoľ s.r.o., IČO 12345678\n',
}, { exercises: 'order confirmation: names Packeta, no number yet', expect: { attention: true, note: 'carrier-named; design says a dismiss click' } })

add('07-newsletter-number-like.eml', {
  from: 'Dobré Ceny <newsletter@dobreceny.example.sk>', date: '2026-10-05 07:00',
  subject: 'Jesenný výpredaj -40 % len do nedele 🍂', messageId: mid('2026-10-05 07:00', 'nl-41', 'dobreceny.example.sk'),
  text: 'Jesenný výpredaj!\n\nZľavový kód: JESEN2026 platí pre objednávky nad 30 €.\nZákaznícka linka: 0905 123 456 (Po–Pi 8:00–16:00), +421 2 1234 5678\nIČO: 87654321, DIČ: 2023456789, IBAN: SK31 1200 0000 1987 4263 7541\nKatalógové číslo produktu 123456789012, EAN 8588001234567\nObjednávka č. 1052281846 z minulého týždňa? Hodnoťte ju!\n\nOdhlásenie z odberu: https://dobreceny.example.sk/unsub?u=00001111222233334444\n',
  html: htmlShell({ title: 'Výpredaj', body: '<h1>Jesenný výpredaj -40 %</h1><p>Zľavový kód: <b>JESEN2026</b></p><p>Zákaznícka linka: 0905 123 456, +421 2 1234 5678</p><p>Katalógové číslo 123456789012, EAN 8588001234567</p><p><a href="https://dobreceny.example.sk/p/12345678901234">Pozrieť</a></p>', footer: 'IČO: 87654321 · Odhlásenie z odberu' }),
}, { exercises: 'newsletter full of 8-14 digit strings, phones, EAN, IBAN; emoji subject', expect: { ignored: true } })

add('08-packeta-promo-sample-number.eml', {
  from: 'Packeta <info@packeta.sk>', date: '2026-10-08 10:00',
  subject: 'Pošlite balík už od 2,49 € – takto to funguje', messageId: mid('2026-10-08 10:00', 'promo-send', 'packeta.sk'),
  ...(() => {
    const t = 'Posielajte s Packetou výhodne.\n\n1. Vytvorte zásielku v aplikácii.\n2. Na štítku nájdete číslo zásielky v tvare Z 000 0000 000 – podľa neho ju sledujete.\n3. Odneste ju na ktorékoľvek z 3 000 výdajných miest alebo do Z-BOXu.\n\nCena od 2,49 €.\n\nPacketa Slovakia s.r.o.\n'
    return { text: t, html: htmlShell({ title: 'Packeta', brand: '#ba1b02', body: t.replace(/\n/g, '<br>') }) }
  })(),
}, { exercises: 'carrier promo whose explainer prints a SAMPLE Z-number', expect: { attention: true, note: 'carrier sent it; should NOT create parcel Z0000000000' } })

add('09-dpd-promo-newsletter.eml', {
  from: 'DPD Slovensko <novinky@dpd.sk>', date: '2026-10-12 09:30',
  subject: 'DPD Pickup: vyzdvihnite si balík kedykoľvek', messageId: mid('2026-10-12 09:30', 'nl-pickup', 'dpd.sk'),
  html: dpd({ kind: 'promo', number: '', sender: '', extra: '<tr><td><h2>Viac ako 1 500 Pickup bodov po celom Slovensku</h2><p>Stiahnite si aplikáciu myDPD a majte prehľad o všetkých zásielkach.</p></td></tr>' }),
}, { exercises: 'carrier newsletter, no parcel (the template still prints "Odosielateľ:" and "Číslo balíka:" labels with nothing)', expect: { attention: true, note: 'carrier sent it' } })

// ================================ live mail, from setup day 2026-10-15 ============================
add('10-eshop-gls-dispatch-zero-padded.eml', {
  from: 'BehajSlovensko <obchod@behajslovensko.example.sk>', date: '2026-10-15 10:12',
  subject: 'Vaša objednávka 2026-55120 je na ceste', messageId: mid('2026-10-15 10:12', 'ship-55120', 'behajslovensko.example.sk'),
  ...shopDispatch({ shop: 'BehajSlovensko', order: '2026-55120', carrierLine: 'Zásielku doručí kuriérska spoločnosť GLS.', numberLine: `Číslo balíka: 0${GLS(2)}`, items: ['Bežecké tenisky, veľ. 42', 'Ponožky 3 páry'], extra: 'V prípade otázok volajte 0911 000 111.' }),
}, { exercises: 'e-shop dispatch naming GLS with a 12-digit zero-padded number (GLS itself prints 11)', expect: { parcel: `gls:${GLS(2)}` } })

add('11-eshop-sps-dispatch-cp1250-qp.eml', {
  from: 'Elektro Svet <objednavky@elektrosvet.example.sk>', date: '2026-10-15 14:30',
  subject: 'Objednávka č. 2026104455 bola odoslaná', messageId: mid('2026-10-15 14:30', 'order-2026104455', 'elektrosvet.example.sk'),
  charset: 'windows-1250', encoding: 'quoted-printable', subjectCharset: 'windows-1250',
  ...shopDispatch({ shop: 'Elektro Svet', order: '2026104455', carrierLine: 'Prepravca: SPS – Slovak Parcel Service, doručenie do odberného miesta balíkovo', numberLine: `Číslo zásielky: ${SPS1}`, items: ['Žehlička s parou – čierna', 'Ľadová čajová kanvica'] }),
}, { exercises: 'windows-1250 quoted-printable body and subject; SPS number by shape', expect: { parcel: `sps:${SPS1}` } })

add('12-gls-transit-courier-phone-first.eml', {
  from: GLS_FROM, date: '2026-10-16 08:05',
  subject: `Váš balík ${GLS(2)} je na ceste`, messageId: mid('2026-10-16 08:05', GLS(2), 'gls-slovakia.sk'),
  html: gls({ kind: 'transit', number: GLS(2), sender: 'BehajSlovensko s.r.o.', courier: '+421 905 111 222 (Peter)', window: 'dnes medzi 13:00 a 16:00' }),
}, { exercises: 'GLS from gls-slovakia.sk (the real sender domain, not in SENDER_DOMAINS); courier phone printed before the number', expect: { parcel: `gls:${GLS(2)}` } })

add('13-eshop-packeta-dispatch-base64.eml', {
  from: 'Knihomoľ <info@knihomol.example.sk>', date: '2026-10-16 09:40',
  subject: 'Vaša objednávka č. 2026100188 bola odoslaná', messageId: mid('2026-10-16 09:40', 'ship-2026100188', 'knihomol.example.sk'),
  encoding: 'base64',
  ...shopDispatch({ shop: 'Knihomoľ', order: '2026100188', carrierLine: 'Spôsob doručenia: Packeta – Z-BOX Testovo, Hlavná 5', numberLine: `Sledovanie zásielky: ${spaced(Z(1))}`, items: ['Kniha: Dejiny Fiktívneho mesta', 'Záložka do knihy'] }),
}, { exercises: 'P1 lifecycle 1/6: e-shop dispatch (base64 utf-8), Packeta number by shape', expect: { parcel: `packeta:${Z(1)}` } })

add('14-eshop-dpd-dispatch.eml', {
  from: 'Voňavka.sk <info@vonavka.example.sk>', date: '2026-10-16 12:00',
  subject: 'Vaša zásielka bola odovzdaná kuriérovi DPD', messageId: mid('2026-10-16 12:00', 'ship-V77812', 'vonavka.example.sk'),
  ...shopDispatch({ shop: 'Voňavka.sk', order: 'V-77812', carrierLine: 'Prepravca: DPD (doručenie na adresu)', numberLine: `Číslo zásielky DPD: ${DPD(1)}`, items: ['Parfumovaná voda 50 ml', 'Vzorka zadarmo'] }),
}, { exercises: 'P4 1/3: e-shop dispatch naming DPD + labelled 14 digits', expect: { parcel: `dpd:${DPD(1)}` } })

pk('15-packeta-accepted.eml', '2026-10-16 18:20', 'Zásielka bola prijatá do prepravy',
  { kind: 'accepted', number: Z(1), sender: 'Knihomoľ s.r.o.', place: ZBOX_A, order: '2026100188' },
  { exercises: 'P1 2/6: Packeta accepted, FUTURE-tense box block', expect: { parcel: `packeta:${Z(1)}` } })

add('16-dpd-predict-window.eml', {
  from: DPD_FROM, date: '2026-10-17 07:30',
  subject: 'Vaša zásielka bude doručená dnes', messageId: mid('2026-10-17 07:30', DPD(1), 'dpd.sk'),
  html: dpd({ kind: 'predict', number: DPD(1), sender: 'Voňavka s.r.o. # V-77812', window: '10:15 – 11:15', courier: { name: 'Marek', phone: '+421 911 333 444' } }),
  htmlEncoding: 'base64',
}, { exercises: 'P4 2/3: DPD Predict, html only base64; courier phone and window', expect: { parcel: `dpd:${DPD(1)}` } })

add('17-dpd-delivered.eml', {
  from: DPD_FROM, date: '2026-10-17 12:10',
  subject: 'Vaša zásielka bola doručená', messageId: mid('2026-10-17 12:10', `${DPD(1)}-del`, 'dpd.sk'),
  html: dpd({ kind: 'delivered', number: DPD(1), sender: 'Voňavka s.r.o. # V-77812' }), htmlEncoding: 'base64',
}, { exercises: 'P4 3/3: DPD delivered', expect: { parcel: `dpd:${DPD(1)}` } })

add('18-gls-accepted.eml', {
  from: GLS_FROM, date: '2026-10-17 15:00',
  subject: `Balík ${GLS(1)} sme prevzali od odosielateľa`, messageId: mid('2026-10-17 15:00', GLS(1), 'gls-slovakia.sk'),
  html: gls({ kind: 'accepted', number: GLS(1), sender: 'Hračkáreň Kocúrik' }),
}, { exercises: 'P7 1/4: GLS accepted', expect: { parcel: `gls:${GLS(1)}` } })

add('19-dpd-on-the-way-to-station-long-sender.eml', {
  from: DPD_FROM, date: '2026-10-18 09:00',
  subject: 'Vaša zásielka je na ceste do Pickup Station', messageId: mid('2026-10-18 09:00', DPD(2), 'dpd.sk'),
  html: dpd({ kind: 'transit', number: DPD(2), sender: 'Najlepšie hračky, hry a potreby pre deti, záhradu, dielňu a domácnosť – oficiálny e-shop s.r.o. # OBJ-2026-000045871' }),
  htmlEncoding: 'base64',
}, { exercises: 'P5 1/4: DPD, sender name ~110 chars (merchant truncation, card layout)', expect: { parcel: `dpd:${DPD(2)}` } })

add('20-gls-ready-glsbox-pin.eml', {
  from: GLS_FROM, date: '2026-10-18 11:00',
  subject: `Balík ${GLS(1)} je pripravený k vyzdvihnutiu`, messageId: mid('2026-10-18 11:00', `${GLS(1)}-ready`, 'gls-slovakia.sk'),
  html: gls({ kind: 'ready', number: GLS(1), sender: 'Hračkáreň Kocúrik', pin: '402211', deadline: '25. 10. 2026', point: GLS_BOX }),
}, { exercises: 'P7 2/4: GLS BOX ready, PIN, "Odberné miesto:" block (carrier answer has no pickup -> mail fills it)', expect: { parcel: `gls:${GLS(1)}`, code: '402211' } })

pk('21-packeta-accepted-cod-pickup-point.eml', '2026-10-18 13:00', 'Zásielka bola prijatá do prepravy',
  { kind: 'accepted', number: Z(2), sender: 'Móda Lucia', place: PP_MISKA, cod: '34,90 €' },
  { exercises: 'P2 1/5: Packeta to a výdajné miesto (not Z-BOX), cash on delivery 34,90 €', expect: { parcel: `packeta:${Z(2)}` } })

pk('22-packeta-ready-pickup-point-cod.eml', '2026-10-19 10:00', 'Zásielka je pripravená na vyzdvihnutie',
  { kind: 'ready', number: Z(2), sender: 'Móda Lucia', place: PP_MISKA, cod: '34,90 €', deadline: '25.10.2026' },
  { exercises: 'P2 2/5: ready at výdajné miesto, COD, no locker code', expect: { parcel: `packeta:${Z(2)}` } })

add('23-dpd-predict-p6.eml', {
  from: DPD_FROM, date: '2026-10-19 07:00',
  subject: 'Vaša zásielka bude doručená dnes', messageId: mid('2026-10-19 07:00', DPD(3), 'dpd.sk'),
  html: dpd({ kind: 'predict', number: DPD(3), sender: 'Mobilonline # 88123', window: '15:30 – 16:30', courier: { name: 'Juraj', phone: '0911 444 555' } }), htmlEncoding: 'base64',
}, { exercises: 'P6 1/3: DPD Predict', expect: { parcel: `dpd:${DPD(3)}` } })

add('24-dpd-failed-attempt.eml', {
  from: DPD_FROM, date: '2026-10-19 18:00',
  subject: 'Neúspešný pokus o doručenie zásielky', messageId: mid('2026-10-19 18:00', `${DPD(3)}-fail`, 'dpd.sk'),
  html: dpd({ kind: 'failed', number: DPD(3), sender: 'Mobilonline # 88123' }), htmlEncoding: 'base64',
}, { exercises: 'P6 2/3: failed delivery attempt', expect: { parcel: `dpd:${DPD(3)}` } })

add('25-eshop-two-packeta-parcels.eml', {
  from: 'Mobilonline <objednavky@mobilonline.example.sk>', date: '2026-10-20 07:00',
  subject: 'Objednávka 88124 bola rozdelená do 2 zásielok', messageId: mid('2026-10-20 07:00', 'split-88124', 'mobilonline.example.sk'),
  ...shopDispatch({ shop: 'Mobilonline', order: '88124', carrierLine: 'Prepravca: Packeta. Z dôvodu skladovej dostupnosti sme objednávku rozdelili.', numberLine: `Zásielka 1/2: ${spaced(Z(5))} (puzdro, nabíjačka)\nZásielka 2/2: ${spaced(Z(6))} (mobilný telefón)`, items: ['Mobilný telefón', 'Puzdro', 'Nabíjačka 65 W'] }),
}, { exercises: 'one mail, TWO parcels', expect: { parcels: [`packeta:${Z(5)}`, `packeta:${Z(6)}`] } })

pk('26-packeta-ready-zbox-code-leading-zero.eml', '2026-10-20 09:00', 'Zásielka je pripravená na vyzdvihnutie',
  { kind: 'ready', number: Z(1), sender: 'Knihomoľ s.r.o.', place: ZBOX_A, code: '040712', deadline: '23.10.2026', order: '2026100188' },
  { exercises: 'P1 3/6: Z-BOX ready, opening code with a leading zero (040712)', expect: { parcel: `packeta:${Z(1)}`, code: '040712' } })

add('27-dpd-delivered-p6.eml', {
  from: DPD_FROM, date: '2026-10-20 12:00',
  subject: 'Vaša zásielka bola doručená', messageId: mid('2026-10-20 12:00', `${DPD(3)}-del`, 'dpd.sk'),
  html: dpd({ kind: 'delivered', number: DPD(3), sender: 'Mobilonline # 88123' }), htmlEncoding: 'base64',
}, { exercises: 'P6 3/3: delivered on second attempt', expect: { parcel: `dpd:${DPD(3)}` } })

add('28-sps-balikovo-cp1250-base64.eml', {
  from: SPS_FROM, date: '2026-10-20 15:00',
  subject: `Zasielka v odbernom mieste balikovo: ${SPS1}`, messageId: mid('2026-10-20 15:00', SPS1, 'sps-sro.sk'),
  charset: 'windows-1250', encoding: 'base64',
  ...sps(`vaša zásielka cislo ${SPS1} od elektrosvet.example.sk je pripravená na vyzdvihnutie v odbernom mieste BALÍKOVO Testovo (OC Fiktív) - Trafika U Ľuba, Hlavná 7, Testovo (https://www.sps-sro.sk/) do 23.10.2026 18:00. Verifikačný kód: 551902.`),
}, { exercises: 'SPS ready at balíkovo, windows-1250 base64, verification code 551902', expect: { parcel: `sps:${SPS1}`, code: '551902' } })

add('29-gmail-forwarded-dpd.eml', {
  from: 'Peter Testový <peter.testovy@example.com>', date: '2026-10-21 08:30',
  subject: 'Fwd: Vaša zásielka bude doručená dnes', messageId: '<CAFakeFwd0001+peter@mail.example.com>',
  text: `Prevezmeš to prosím? Ja som v práci.\n\n---------- Forwarded message ---------\nFrom: *DPD* <no_reply@dpd.sk>\nDate: Wed, Oct 21, 2026 at 7:58 AM\nSubject: Vaša zásielka bude doručená dnes\nTo: <peter.testovy@example.com>\n\n\nDobrý deň Peter Testový,\nVaša zásielka bude doručená dnes v čase 09:45 – 10:45.\nOdosielateľ: Fotoshop Testovo # F-3321   Číslo balíka: ${DPD(4)}\nKontakt na kuriéra: +421 911 777 888\n`,
  html: `<div dir="ltr">Prevezmeš to prosím? Ja som v práci.<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">DPD</strong> <span dir="auto">&lt;no_reply@dpd.sk&gt;</span><br>Date: Wed, Oct 21, 2026 at 7:58 AM<br>Subject: Vaša zásielka bude doručená dnes<br>To: &lt;peter.testovy@example.com&gt;<br></div><br><br>Dobrý deň Peter Testový,<br>Vaša zásielka bude doručená dnes v čase 09:45 – 10:45.<br>Odosielateľ: Fotoshop Testovo # F-3321 &nbsp; Číslo balíka: ${DPD(4)}</div></div>`,
}, { exercises: 'Gmail-forwarded DPD Predict (bold *DPD* sender) from a family member', expect: { parcel: `dpd:${DPD(4)}` } })

pk('30-packeta-accepted-p3.eml', '2026-10-21 10:00', 'Zásielka bola prijatá do prepravy',
  { kind: 'accepted', number: Z(3), sender: 'Záhrada Plus s.r.o.', place: ZBOX_A },
  { exercises: 'P3 1/4: accepted, destined for Z-BOX A', expect: { parcel: `packeta:${Z(3)}` } })

add('31-zasilkovna-cz-ready-iso8859-2.eml', {
  from: 'Zásilkovna <noreply@zasilkovna.cz>', date: '2026-10-21 11:00',
  subject: 'Zásilka je připravena k vyzvednutí', messageId: mid('2026-10-21 11:00', Z(4), 'zasilkovna.cz'),
  charset: 'iso-8859-2', encoding: 'quoted-printable', subjectCharset: 'iso-8859-2', subjectEnc: 'Q',
  text: `Zásilka ${spaced(Z(4))}\n\nDobrý den,\nvaše zásilka od odesílatele Čokoládovna Příkladná je pro vás připravena k vyzvednutí v Z-BOXu.\n\nKód pro otevření schránky\n9\n1\n8\n2\n7\n3\n\nMísto, kde je vaše zásilka uložena\nZ-BOX Testovice, Hlavní 12 (Albert)\nHlavní 12 999 11 Testovice\nVyzvedněte nejpozději do 24.10.2026 23:59.\n\nČíslo zásilky ${spaced(Z(4))}\nDěkujeme, že jste si pro doručení vybrali Zásilkovnu.\ntým Zásilkovny\n`,
}, { exercises: 'Czech Zásilkovna, ISO-8859-2 QP text only; Czech code phrase; Czech pickup block (Místo...)', expect: { parcel: `packeta:${Z(4)}`, code: '918273' } })

pk('32-packeta-reminder.eml', '2026-10-21 16:00', 'Pripomíname: zásielka na vás čaká v Z-BOXe',
  { kind: 'reminder', number: Z(1), sender: 'Knihomoľ s.r.o.', place: ZBOX_A, code: '040712', deadline: '23.10.2026', order: '2026100188' },
  { exercises: 'P1 4/6: reminder repeating the block and the code', expect: { parcel: `packeta:${Z(1)}` } })

pk('33-packeta-zbox-full-redirected.eml', '2026-10-22 09:00', 'Hlásime zmenu doručenia – Z-BOX je plný, doručujeme do iného boxu',
  { kind: 'redirected', number: Z(3), sender: 'Záhrada Plus s.r.o.', place: ZBOX_A, newPlace: ZBOX_B },
  { exercises: 'P3 2/4: pickup point CHANGE (box full)', expect: { parcel: `packeta:${Z(3)}` } })

pk('34-packeta-ready-new-box.eml', '2026-10-22 10:00', 'Zásielka je pripravená na vyzdvihnutie',
  { kind: 'ready', number: Z(3), sender: 'Záhrada Plus s.r.o.', place: ZBOX_B, code: '331908', deadline: '25.10.2026' },
  { exercises: 'P3 3/4: ready in the NEW box; pickup must be box B, not A', expect: { parcel: `packeta:${Z(3)}`, code: '331908' } })

add('35-dhl-express-dispatch.eml', {
  from: DHL_FROM, date: '2026-10-22 12:00',
  subject: `DHL On Demand Delivery: Your shipment ${JJD} is on its way`, messageId: mid('2026-10-22 12:00', JJD, 'dhl.com'),
  ...dhl({ lead: 'Your shipment from FAKE GADGETS LTD (United Kingdom) is on its way and will be delivered on Monday, 26 October 2026.', number: JJD, rows: [['Pieces', '1'], ['Weight', '0.8 kg'], ['Customer service', '+421 2 0000 1111']] }),
}, { exercises: 'DHL Express (email-only carrier) 1/3, English', expect: { parcel: `dhl:${JJD}` } })

pk('36-packeta-pickedup.eml', '2026-10-22 14:00', 'Zásielka bola vyzdvihnutá',
  { kind: 'pickedup', number: Z(1), sender: 'Knihomoľ s.r.o.' },
  { exercises: 'P1 5/6: collected', expect: { parcel: `packeta:${Z(1)}` } })

add('37-posta-stored-at-office-cod.eml', {
  from: POSTA_FROM, date: '2026-10-22 17:00', subject: `Oznámenie o uložení zásielky ${EB(1)}`,
  messageId: mid('2026-10-22 17:00', EB(1), 'posta.sk'),
  ...posta({ lead: 'oznamujeme Vám, že zásielka adresovaná na Vaše meno je uložená na pošte.', number: EB(1), office: POSTA_OFFICE, deadline: '05.11.2026', cod: '12,50 €' }),
}, { exercises: 'Slovenská pošta: stored at a post office, COD 12,50 €', expect: { parcel: `posta:${EB(1)}` } })

add('38-dhl-customs-duties.eml', {
  from: 'DHL Express <noreply@dhl.com>', date: '2026-10-23 08:00',
  subject: 'Clo a DPH na úhradu – zásielka DHL Express', messageId: mid('2026-10-23 08:00', `${JJD}-duty`, 'dhl.com'),
  ...dhl({ lead: 'Vaša zásielka čaká na colné odbavenie. Pred doručením je potrebné uhradiť clo a DPH vo výške 23,45 EUR. / Duties and taxes of 23.45 EUR are due before delivery.', number: JJD, rows: [['Suma na úhradu', '23,45 EUR'], ['Splatnosť', '24.10.2026']] }),
}, { exercises: 'DHL 2/3: customs amount, Slovak subject without the number', expect: { parcel: `dhl:${JJD}` } })

pk('39-packeta-last-day-reminder.eml', '2026-10-23 09:30', 'Posledný deň na vyzdvihnutie zásielky',
  { kind: 'reminder', number: Z(2), sender: 'Móda Lucia', place: PP_MISKA, cod: '34,90 €', deadline: '25.10.2026' },
  { exercises: 'P2 3/5: last-day reminder', expect: { parcel: `packeta:${Z(2)}` } })

add('40-eshop-emoji-subject-packeta.eml', {
  from: `${encodeWords('🛍️ Temu', 'utf-8', 'B')} <orders@temu.example.com>`, date: '2026-10-23 11:00',
  subject: '📦 Vaša objednávka je na ceste! 🚚✨', messageId: mid('2026-10-23 11:00', 'po-778812', 'temu.example.com'),
  ...shopDispatch({ shop: 'Temu', greeting: 'Ahoj Jana! 👋', order: 'PO-211-77881200112233', carrierLine: 'Doručí: Packeta 📍', numberLine: `Sledovacie číslo: ${Z(7)}`, items: ['LED pásik 5 m', 'Organizér na káble ×3'] }),
}, { exercises: 'emoji subject and emoji sender name (merchant), Packeta number without spaces', expect: { parcel: `packeta:${Z(7)}` } })

add('41-eshop-number-only-in-html.eml', {
  from: 'Hobby Dielňa <noreply@hobbydielna.example.sk>', date: '2026-10-23 13:00',
  subject: 'Objednávka odoslaná', messageId: mid('2026-10-23 13:00', 'ship-H5521', 'hobbydielna.example.sk'),
  text: 'Ak sa vám e-mail nezobrazuje správne, otvorte ho v prehliadači: https://hobbydielna.example.sk/mail/H5521\n',
  html: htmlShell({ title: 'Hobby Dielňa', body: `<p>Dobrý deň,</p><p>vaša objednávka H5521 bola odoslaná cez Packetu.</p><p>Číslo zásielky: <strong>${spaced(Z(11))}</strong></p>` }),
}, { exercises: 'number ONLY in the HTML part; the text part is a "view in browser" stub', expect: { parcel: `packeta:${Z(11)}` } })

add('42-eshop-number-only-in-subject.eml', {
  from: 'Čajovňa Lístok <predaj@listok.example.sk>', date: '2026-10-23 15:00',
  subject: `Zásielka ${spaced(Z(8))} odoslaná`, messageId: mid('2026-10-23 15:00', 'z8', 'listok.example.sk'),
  text: 'Ďakujeme.\n',
}, { exercises: 'very short mail; number ONLY in the subject', expect: { parcel: `packeta:${Z(8)}` } })

add('43-dpd-pickup-station-ready-pin.eml', {
  from: DPD_FROM, date: '2026-10-24 09:00',
  subject: 'Informácia o uložení zásielky v samoobslužnom boxe Pickup Station', messageId: mid('2026-10-24 09:00', `${DPD(2)}-ps`, 'dpd.sk'),
  html: dpd({ kind: 'station', number: DPD(2), sender: 'Najlepšie hračky, hry a potreby pre deti, záhradu, dielňu a domácnosť – oficiálny e-shop s.r.o. # OBJ-2026-000045871', station: DPD_STATION, pin: '120477', deadline: '27.10.2026' }), htmlEncoding: 'base64',
}, { exercises: 'P5 2/4: DPD Pickup Station ready, PIN 120477, address block', expect: { parcel: `dpd:${DPD(2)}`, code: '120477' } })

add('44-posta-balikobox-pin.eml', {
  from: POSTA_FROM, date: '2026-10-24 10:00', subject: `Zásielka ${EB(2)} je uložená v BalíkoBOXe`,
  messageId: mid('2026-10-24 10:00', EB(2), 'posta.sk'),
  ...posta({ lead: 'Vaša zásielka bola uložená v BalíkoBOXe. Vyzdvihnite si ju do 3 dní.', number: EB(2), office: BALIKOBOX, deadline: '27.10.2026 23:59', pin: '631285' }),
}, { exercises: 'Slovenská pošta BalíkoBOX with PIN; deadline that will PASS before the end of the run', expect: { parcel: `posta:${EB(2)}`, code: '631285' } })

add('45-dpd-two-parcels-one-mail.eml', {
  from: DPD_FROM, date: '2026-10-24 12:00',
  subject: 'Vaša zásielka (2 balíky) je na ceste', messageId: mid('2026-10-24 12:00', 'multi', 'dpd.sk'),
  html: dpd({ kind: 'multi', numbers: [DPD(5), DPD(6)], sender: 'Nábytok Domov # N-1200' }), htmlEncoding: 'base64',
}, { exercises: 'carrier mail listing TWO parcel numbers', expect: { parcels: [`dpd:${DPD(5)}`, `dpd:${DPD(6)}`] } })

add('46-sps-courier-cod-phone.eml', {
  from: SPS_FROM, date: '2026-10-24 08:00',
  subject: `Doručenie zásielky ${SPS703} dnes`, messageId: mid('2026-10-24 08:00', SPS703, 'sps-sro.sk'),
  charset: 'windows-1250', encoding: 'quoted-printable',
  ...sps(`vaša zásielka cislo ${SPS703} od Nábytok Domov bude dnes doručená kuriérom na adresu. Suma na úhradu (dobierka): 59,90 €. Kuriér: 0905 555 666.`),
}, { exercises: 'SPS 703… form in the subject, COD 59,90 €, courier phone', expect: { parcel: `sps:${SPS703}` } })

add('47-eshop-gls-phone-lookalikes.eml', {
  from: 'Záhradníctvo Rozkvet <eshop@rozkvet.example.sk>', date: '2026-10-24 16:00',
  subject: 'Vaše rastliny sú na ceste 🌱', messageId: mid('2026-10-24 16:00', 'ship-R901', 'rozkvet.example.sk'),
  text: `Dobrý deň,\n\nvaše rastliny sme zabalili a odovzdali kuriérovi GLS.\nAk máte otázky, volajte 0911 222 333 alebo +421911222333, prípadne 421911222333.\nObjednávka č. 2026102244, faktúra 2026102245.\nČíslo balíka: ${GLS(3)}\n\nS pozdravom\nZáhradníctvo Rozkvet\n`,
}, { exercises: 'GLS number after several 10-12 digit phone/order/invoice lookalikes', expect: { parcel: `gls:${GLS(3)}` } })

add('48-sps-delivered.eml', {
  from: SPS_FROM, date: '2026-10-25 09:00',
  subject: `Zasielka ${SPS1} bola dorucena`, messageId: mid('2026-10-25 09:00', `${SPS1}-del`, 'sps-sro.sk'),
  charset: 'windows-1250', encoding: 'quoted-printable',
  ...sps(`vaša zásielka cislo ${SPS1} bola vyzdvihnutá v odbernom mieste balíkovo. Ďakujeme.`),
}, { exercises: 'SPS collected (DST changeover day)', expect: { parcel: `sps:${SPS1}` } })

pk('49-packeta-returning-to-sender.eml', '2026-10-25 10:00', 'Zásielka bude vrátená odosielateľovi',
  { kind: 'returning', number: Z(2), sender: 'Móda Lucia' },
  { exercises: 'P2 4/5: not picked up -> returned to sender', expect: { parcel: `packeta:${Z(2)}` } })

add('50-dpd-station-reminder-resent.eml', {
  from: DPD_FROM, date: '2026-10-25 11:00',
  subject: 'Informácia o uložení zásielky v samoobslužnom boxe Pickup Station', messageId: mid('2026-10-25 11:00', `${DPD(2)}-ps2`, 'dpd.sk'),
  html: dpd({ kind: 'stationReminder', number: DPD(2), sender: 'Najlepšie hračky, hry a potreby pre deti, záhradu, dielňu a domácnosť – oficiálny e-shop s.r.o. # OBJ-2026-000045871', station: DPD_STATION, pin: '120477', deadline: '27.10.2026' }), htmlEncoding: 'base64',
}, { exercises: 'P5 3/4: same subject re-sent with a new Message-ID (reminder)', expect: { parcel: `dpd:${DPD(2)}` } })

add('51-dhl-express-delivered.eml', {
  from: DHL_FROM, date: '2026-10-26 14:20',
  subject: `Your DHL shipment ${JJD} has been delivered`, messageId: mid('2026-10-26 14:20', `${JJD}-del`, 'dhl.com'),
  ...dhl({ lead: 'Your shipment has been delivered. Signed for by: TESTOVA.', number: JJD }),
}, { exercises: 'DHL 3/3: delivered (email-only: status stays unknown by design)', expect: { parcel: `dhl:${JJD}` } })

add('52-dhl-express-bare-10-digit-waybill.eml', {
  from: DHL_FROM, date: '2026-10-26 09:00',
  subject: `DHL On Demand Delivery: Zásielka ${DHL_BARE} je na ceste`, messageId: mid('2026-10-26 09:00', DHL_BARE, 'dhl.com'),
  ...dhl({ lead: 'Vaša zásielka od FAKE PARTS GMBH (Nemecko) je na ceste. Predpokladané doručenie: 28. 10. 2026.', number: DHL_BARE }),
}, { exercises: 'DHL Express with the common bare 10-digit waybill', expect: { parcel: `dhl:${DHL_BARE}`, note: 'design §6.6 excludes bare 10 digits; sender is DHL though' } })

add('53-dhl-parcel-jvgl.eml', {
  from: 'DHL Parcel <noreply@dhlparcel.sk>', date: '2026-10-26 10:00',
  subject: 'Vaša zásielka DHL Parcel bude doručená zajtra', messageId: mid('2026-10-26 10:00', JVGL, 'dhlparcel.sk'),
  text: `Dobrý deň,\n\nvaša zásielka ${JVGL} od odosielateľa Fake Möbel GmbH bude doručená zajtra, 27. 10. 2026, medzi 8:00 a 17:00.\n\nDHL Parcel\n`,
}, { exercises: 'DHL Parcel Europe JVGL… form', expect: { parcel: `dhl:${JVGL}` } })

add('54-aliexpress-cainiao-shipped.eml', {
  from: 'AliExpress <transaction@notice.aliexpress.example.com>', date: '2026-10-26 11:00',
  subject: 'Your order 8190000011112222 has been shipped', messageId: mid('2026-10-26 11:00', 'ae-shipped', 'notice.aliexpress.example.com'),
  text: 'Hi Jana,\n\nYour order 8190000011112222 has been shipped by Cainiao.\nTracking number: LP00777777777701\nEstimated delivery: Nov 8 - Nov 15\n\nAliExpress\n',
}, { exercises: 'AliExpress / Cainiao LP… number (no supported carrier yet)', expect: { attention: true } })

add('55-temu-dhl-ecommerce-000.eml', {
  from: 'Temu <orders@temu.example.com>', date: '2026-10-26 12:00',
  subject: 'Your package has been dispatched', messageId: mid('2026-10-26 12:00', 'po-dhl', 'temu.example.com'),
  text: `Hi Jana,\n\nyour package is on its way with DHL eCommerce.\nTracking number: ${DHL000}\nOrder PO-211-99999999990000\n\nTemu\n`,
}, { exercises: 'DHL eCommerce 000… form from an e-shop (needs the DHL name + label)', expect: { parcel: `dhl:${DHL000}` } })

add('56-unknown-carrier-express-one.eml', {
  from: 'Express One <noreply@expressone.sk>', date: '2026-10-26 13:00',
  subject: 'Vaša zásielka bude doručená zajtra', messageId: mid('2026-10-26 13:00', 'eo-4410000123', 'expressone.sk'),
  text: 'Dobrý deň,\n\nvaša zásielka č. 4410000123 od odosielateľa Fake Shop GmbH bude doručená zajtra.\nKuriér vás bude kontaktovať telefonicky.\n\nExpress One Slovakia, partner DHL eCommerce\n',
}, { exercises: 'unsupported carrier (Express One) whose number is GLS-shaped and which names DHL', expect: { attention: true } })

add('57-posta-customs-foreign-s10.eml', {
  from: POSTA_FROM, date: '2026-10-26 14:00', subject: `Colné konanie – zásielka ${CN}`,
  messageId: mid('2026-10-26 14:00', CN, 'posta.sk'),
  ...posta({ lead: 'Vaša zásielka zo zahraničia podlieha colnému konaniu. Clo a DPH: 8,73 €. Zásielku doručíme po úhrade.', number: CN, extra: 'Číslo colného vyhlásenia: 26SK0000000000000001\n' }),
}, { exercises: 'Slovenská pošta, inbound international S10 number ending CN (not SK); customs amount', expect: { parcel: `posta:${CN}`, note: 'posta regex only accepts …SK' } })

add('58-attachment-only-scan.eml', {
  from: 'Jana Testová <jana.testova@example.com>', date: '2026-10-26 15:00', subject: '', rawSubject: '',
  messageId: '<scan-20261026150000@phone.example.com>',
  attachments: [{ type: 'application/pdf', filename: `stitok_${Z(12)}.pdf`, body: Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% fake label ${Z(12)}\ntrailer<</Root 1 0 R>>\n%%EOF\n`) }],
}, { exercises: 'attachment-only mail, empty subject, number only in the PDF file name', expect: { attention: true } })

add('59-eshop-very-long-mail.eml', {
  from: 'Mega Obchod <objednavky@megaobchod.example.sk>', date: '2026-10-27 09:00',
  subject: 'Súhrn objednávky a obchodné podmienky', messageId: mid('2026-10-27 09:00', 'long', 'megaobchod.example.sk'),
  text: `Dobrý deň,\n\nposielame súhrn vašej objednávky č. 777001 a aktuálne obchodné podmienky.\n\n${Array.from({ length: 1500 }, (_, i) => `${i + 1}. Článok ${i + 1}: Predávajúci a kupujúci sa dohodli, že tovar bude dodaný v lehote uvedenej pri produkte, pričom ${'riziko škody na tovare prechádza na kupujúceho jeho prevzatím. '.repeat(4)}`).join('\n')}\n\nVaša objednávka bola medzitým odoslaná. Číslo zásielky Packeta: ${spaced(Z(10))}\n`,
}, { exercises: 'very long mail (~470 KB text) with the number at the very end', expect: { parcel: `packeta:${Z(10)}` } })

add('60-dpd-pickup-station-collected.eml', {
  from: DPD_FROM, date: '2026-10-27 10:00',
  subject: 'Vaša zásielka bola doručená', messageId: mid('2026-10-27 10:00', `${DPD(2)}-del`, 'dpd.sk'),
  html: dpd({ kind: 'delivered', number: DPD(2), sender: 'Najlepšie hračky, hry a potreby pre deti, záhradu, dielňu a domácnosť – oficiálny e-shop s.r.o. # OBJ-2026-000045871' }), htmlEncoding: 'base64',
}, { exercises: 'P5 4/4: collected from the station', expect: { parcel: `dpd:${DPD(2)}` } })

add('61-outlook-forwarded-gls-reminder.eml', {
  from: 'Peter Testový <peter.testovy@work.example.com>', date: '2026-10-27 11:00',
  subject: 'FW: Balík čaká na vyzdvihnutie', messageId: '<AM0PR00MB0000FAKE0001@AM0PR00MB0000.example.com>',
  text: `Toto je tvoj?\n\n________________________________\nFrom: GLS Slovakia <noreply@gls-group.eu>\nSent: Tuesday, October 27, 2026 10:40\nTo: Peter Testový <peter.testovy@work.example.com>\nSubject: Balík čaká na vyzdvihnutie\n\nDobrý deň,\nváš balík na vás stále čaká v odbernom mieste GLS BOX Testovo - Lidl (Nová 8).\nČíslo balíka:\n${GLS(1)}\nPIN kód: 402211\n`,
}, { exercises: 'Outlook-style forward (underscore rule, no "Forwarded message" line); merchant should not become the forwarder', expect: { parcel: `gls:${GLS(1)}` } })

add('62-gmail-cz-forwarded-zasilkovna-pickedup.eml', {
  from: 'Peter Testový <peter.testovy@example.com>', date: '2026-10-27 12:00',
  subject: 'Fwd: Zásilka byla vyzvednuta', messageId: '<CAFakeFwd0002+peter@mail.example.com>',
  text: `\n---------- Přeposlaná zpráva ---------\nOd: Zásilkovna <noreply@zasilkovna.cz>\nDate: út 27. 10. 2026 v 11:58\nSubject: Zásilka byla vyzvednuta\nTo: <peter.testovy@example.com>\n\n\nDobrý den,\nvaše zásilka ${spaced(Z(4))} od odesílatele Čokoládovna Příkladná byla úspěšně vyzvednuta.\n`,
}, { exercises: 'Czech Gmail forward ("Přeposlaná zpráva", "Od:")', expect: { parcel: `packeta:${Z(4)}` } })

add('63-sps-old-parcel-returning-revive.eml', {
  from: SPS_FROM, date: '2026-10-28 09:00',
  subject: `Zasielka ${SPS2} sa vracia odosielatelovi`, messageId: mid('2026-10-28 09:00', SPS2, 'sps-sro.sk'),
  charset: 'windows-1250', encoding: 'quoted-printable',
  ...sps(`vaša zásielka cislo ${SPS2} sa na žiadosť odosielateľa vracia späť odosielateľovi.`),
}, { exercises: 'fresh mail for the ARCHIVED-on-arrival SPS parcel (mail 04): must revive it', expect: { parcel: `sps:${SPS2}`, archived: false } })

add('64-posta-reminder.eml', {
  from: POSTA_FROM, date: '2026-10-28 10:00', subject: `Pripomienka: zásielka ${EB(1)} čaká na pošte`,
  messageId: mid('2026-10-28 10:00', `${EB(1)}-rem`, 'posta.sk'),
  ...posta({ lead: 'pripomíname Vám, že zásielka adresovaná na Vaše meno je stále uložená na pošte.', number: EB(1), office: POSTA_OFFICE, deadline: '05.11.2026', cod: '12,50 €' }),
}, { exercises: 'posta reminder', expect: { parcel: `posta:${EB(1)}` } })

add('65-alza-alzabox-no-carrier.eml', {
  from: 'Alza.sk <objednavky@alza.example.sk>', date: '2026-10-28 11:00',
  subject: 'Objednávka 1052281846 je pripravená v AlzaBoxe', messageId: mid('2026-10-28 11:00', 'alzabox', 'alza.example.sk'),
  text: 'Dobrý deň,\n\nvaša objednávka 1052281846 je pripravená na vyzdvihnutie v AlzaBoxe Testovo – Hlavná 5.\nKód pre vyzdvihnutie: 778812\nVyzdvihnite si ju do 31.10.2026.\n\nAlza.sk\n',
}, { exercises: 'Alza own delivery to AlzaBox: no carrier, no tracking number, pickup code', expect: { attention: true } })

add('66-gls-delivered-p8.eml', {
  from: GLS_FROM, date: '2026-10-28 13:00',
  subject: `Balík ${GLS(2)} bol doručený`, messageId: mid('2026-10-28 13:00', `${GLS(2)}-del`, 'gls-slovakia.sk'),
  html: gls({ kind: 'delivered', number: GLS(2), sender: 'BehajSlovensko s.r.o.' }),
}, { exercises: 'GLS delivered for the zero-padded parcel (mail 10/12) -> one parcel', expect: { parcel: `gls:${GLS(2)}` } })

add('67-packeta-com-english.eml', {
  from: 'Packeta <noreply@packeta.com>', date: '2026-10-28 15:00',
  subject: 'Your parcel is on its way', messageId: mid('2026-10-28 15:00', Z(13), 'packeta.com'),
  text: `Parcel ${spaced(Z(13))}\n\nHello,\nthe sender LedLight Store has just handed over your parcel, which will be delivered to the Z-BOX.\n\nPlace where your parcel will be stored\nZ-BOX Testovo, Nová 8 (Lidl)\nNová 8 999 01 Testovo\n\nPacketa\n`,
}, { exercises: 'Packeta in English (packeta.com); English merchant phrase', expect: { parcel: `packeta:${Z(13)}` } })

add('68-posta-delivered.eml', {
  from: POSTA_FROM, date: '2026-10-29 09:00', subject: `Zásielka ${EB(1)} bola doručená`,
  messageId: mid('2026-10-29 09:00', `${EB(1)}-del`, 'posta.sk'),
  ...posta({ lead: 'Vaša zásielka bola prevzatá na pošte. Ďakujeme.', number: EB(1) }),
}, { exercises: 'posta delivered', expect: { parcel: `posta:${EB(1)}` } })

add('69-gls-last-chance-reminder.eml', {
  from: GLS_FROM, date: '2026-10-29 10:00',
  subject: `Posledná možnosť vyzdvihnúť balík ${GLS(1)}`, messageId: mid('2026-10-29 10:00', `${GLS(1)}-rem`, 'gls-slovakia.sk'),
  html: gls({ kind: 'reminder', number: GLS(1), sender: 'Hračkáreň Kocúrik', pin: '402211', deadline: '31. 10. 2026', point: GLS_BOX }),
}, { exercises: 'P7 4/4: GLS reminder, still waiting at the end', expect: { parcel: `gls:${GLS(1)}` } })

pk('70-packeta-pickedup-p3.eml', '2026-10-29 11:00', 'Zásielka bola vyzdvihnutá',
  { kind: 'pickedup', number: Z(3), sender: 'Záhrada Plus s.r.o.' },
  { exercises: 'P3 4/4: collected', expect: { parcel: `packeta:${Z(3)}` } })

add('71-eshop-posta-bad-check-digit.eml', {
  from: 'Knihomoľ <info@knihomol.example.sk>', date: '2026-10-29 12:00',
  subject: 'Vaša objednávka č. 2026100201 bola odoslaná', messageId: mid('2026-10-29 12:00', 'ship-2026100201', 'knihomol.example.sk'),
  ...shopDispatch({ shop: 'Knihomoľ', order: '2026100201', carrierLine: 'Spôsob doručenia: Slovenská pošta – balík na adresu', numberLine: `Podacie číslo: ${EB_BADCHECK}`, items: ['Kalendár 2027'] }),
}, { exercises: 'Slovenská pošta number with a WRONG S10 check digit (typo by the shop)', expect: { parcel: `posta:${EB_BADCHECK}`, note: 'manual /add would refuse it' } })

add('72-packeta-very-short.eml', {
  from: PACKETA_FROM, date: '2026-10-29 14:00', subject: spaced(Z(14)),
  messageId: mid('2026-10-29 14:00', Z(14), 'packeta.sk'), text: spaced(Z(14)),
}, { exercises: 'very short mail: subject and body are just the number', expect: { parcel: `packeta:${Z(14)}` } })

add('73-sps-delivered-misdeclared-charset.eml', {
  from: SPS_FROM, date: '2026-10-30 10:00',
  rawSubject: encodeWords(`Zásielka ${SPS703} doručená`, 'windows-1250', 'Q').replace(/windows-1250/g, 'iso-8859-1'),
  subject: '', messageId: mid('2026-10-30 10:00', `${SPS703}-del`, 'sps-sro.sk'),
  charset: 'iso-8859-1', bytesCharset: 'windows-1250', encoding: 'quoted-printable',
  text: `Vážený zákazník,\nvaša zásielka cislo ${SPS703} od Nábytok Domov bola doručená. Ďakujeme, že ste využili služby SPS.\n`,
}, { exercises: 'body bytes windows-1250 but declared iso-8859-1 (mojibake source)', expect: { parcel: `sps:${SPS703}` } })

pk('74-packeta-ready-shared-zbox-a.eml', '2026-10-30 12:00', 'Zásielka je pripravená na vyzdvihnutie',
  { kind: 'ready', number: Z(7), sender: 'Temu', place: ZBOX_B, code: '552019', deadline: '01.11.2026' },
  { exercises: 'two parcels ready in the SAME Z-BOX (with 75): one shared card, two codes', expect: { parcel: `packeta:${Z(7)}`, code: '552019' } })
pk('75-packeta-ready-shared-zbox-b.eml', '2026-10-30 13:00', 'Zásielka je pripravená na vyzdvihnutie',
  { kind: 'ready', number: Z(13), sender: 'LedLight Store', place: ZBOX_B, code: '009431', deadline: '01.11.2026' },
  { exercises: 'second parcel in the same Z-BOX; code with two leading zeros', expect: { parcel: `packeta:${Z(13)}`, code: '009431' } })

add('76-phishing-lookalike-packeta.eml', {
  from: 'Packeta <noreply@packeta-sk.example.com>', date: '2026-10-30 15:00',
  subject: 'Vaša zásielka čaká – uhraďte poplatok 1,99 €', messageId: mid('2026-10-30 15:00', 'phish', 'packeta-sk.example.com'),
  text: `Dobrý deň,\nvaša zásielka ${spaced(Z(99))} čaká v depe. Pre doručenie uhraďte poplatok 1,99 € na https://packeta-sk.example.com/pay\n`,
}, { exercises: 'phishing lookalike domain with a Z-number', expect: { attention: true, note: 'creating a parcel from a phishing mail is questionable' } })

// Re-delivery of mail 20's exact bytes at a later UID (label removed and re-applied): same Message-ID.
const twenty = mails.find(m => m.file.startsWith('20-'))
add('77-gls-ready-duplicate-same-message-id.eml', twenty.spec,
  { exercises: 'exact duplicate of mail 20 (same Message-ID) arriving later at a new UID', expect: { parcel: `gls:${GLS(1)}`, duplicateOf: '20' }, arrival: '2026-10-25 11:05', copyOf: twenty.file })

// CZ Zásilkovna lifecycle (Z(15)): accepted -> ready in a Z-BOX (code 305118) -> picked up; Z(16) is a second parcel that
// is never collected and goes back to the sender (a returned parcel was never "picked up", so it needs its own number).
const zk = (file, date, subject, args, meta, extra = {}) => add(file, {
  from: ZASILKOVNA_FROM, date, subject, messageId: mid(date, `${args.number}-${args.kind}`, 'zasilkovna.cz'), ...zasilkovna(args), ...extra,
}, meta)

zk('78-zasilkovna-cz-accepted.eml', '2026-10-24 10:00', 'Zásilka byla podána',
  { kind: 'accepted', number: Z(15), sender: 'Papírnictví Vzorové', place: ZBOX_CZ },
  { exercises: 'CZ Zásilkovna 1/3: accepted ("byla podána"), FUTURE-tense box block ("kde bude")', expect: { parcel: `packeta:${Z(15)}` } })
zk('79-zasilkovna-cz-ready-zbox-code.eml', '2026-10-26 14:00', 'Zásilka je připravena k vyzvednutí',
  { kind: 'ready', number: Z(15), sender: 'Papírnictví Vzorové', place: ZBOX_CZ, code: '305118', deadline: '29.10.2026' },
  { exercises: 'CZ Zásilkovna 2/3: ready in a Z-BOX; "Kód pro otevření schránky" (305118), present-tense "Místo, kde je..." block, ISO-8859-2 QP', expect: { parcel: `packeta:${Z(15)}`, code: '305118' } },
  { charset: 'iso-8859-2', encoding: 'quoted-printable', subjectCharset: 'iso-8859-2', subjectEnc: 'Q' })
zk('80-zasilkovna-cz-pickedup.eml', '2026-10-28 16:00', 'Zásilka byla vyzvednuta',
  { kind: 'pickedup', number: Z(15), sender: 'Papírnictví Vzorové' },
  { exercises: 'CZ Zásilkovna 3/3: picked up ("vyzvednuta")', expect: { parcel: `packeta:${Z(15)}` } })
zk('81-zasilkovna-cz-returning.eml', '2026-10-29 09:00', 'Zásilku vracíme odesílateli',
  { kind: 'returning', number: Z(16), sender: 'Cyklo Fiktivní s.r.o.' },
  { exercises: 'CZ Zásilkovna, a second parcel not collected in time: "vracíme odesílateli"', expect: { parcel: `packeta:${Z(16)}` } })

// PPL (PPL(1) 40888888801: accepted -> ready at a ParcelShop with a PIN -> collected in the world; PPL(2) is a shop
// dispatch that names PPL beside a labelled number; PPL(3) is a stranger's mail with a labelled 11-digit number and
// no carrier named). The number's shape is also GLS's, so only a ppl.cz sender or PPL named beside it makes it PPL.
add('82-ppl-accepted.eml', {
  from: PPL_FROM, date: '2026-10-27 10:00', subject: `Zásilka ${PPL(1)} je na cestě`,
  messageId: mid('2026-10-27 10:00', `${PPL(1)}-acc`, 'ppl.cz'),
  ...ppl({ kind: 'accepted', number: PPL(1), sender: 'Hobby Dům Vzorový' }),
}, { exercises: 'PPL 1/2: from ppl.cz, 11 bare digits under "Číslo zásilky:" (GLS\'s shape, PPL by sender)', expect: { parcel: `ppl:${PPL(1)}` } })
add('83-ppl-ready-parcelshop-pin.eml', {
  from: PPL_FROM, date: '2026-10-28 14:00', subject: 'Zásilka je připravena k vyzvednutí v PPL Parcelshop',
  messageId: mid('2026-10-28 14:00', `${PPL(1)}-rdy`, 'ppl.cz'),
  ...ppl({ kind: 'ready', number: PPL(1), sender: 'Hobby Dům Vzorový', place: PPL_SHOP, pin: '402211', deadline: '04.11.2026' }),
}, { exercises: 'PPL 2/2: ready at a ParcelShop; "PIN pro vyzvednutí:" (402211), pickup block under the Zásilkovna-style "Místo, kde je vaše zásilka uložena" label', expect: { parcel: `ppl:${PPL(1)}`, code: '402211' } })
add('84-eshop-cz-dispatch-names-ppl.eml', {
  from: 'Cyklo Fiktivní <objednavky@cyklofiktivni.example.cz>', date: '2026-10-29 11:00',
  subject: 'Objednávka č. 2026102904 byla odeslána', messageId: mid('2026-10-29 11:00', 'ship-2026102904', 'cyklofiktivni.example.cz'),
  text: `Dobrý den,\n\nvaše objednávka č. 2026102904 byla právě odeslána.\nDopravce: PPL\nČíslo zásilky: ${PPL(2)}\n\nObsah zásilky:\n - Sada řetězových článků\n\nDěkujeme za nákup!\nTým Cyklo Fiktivní\n`,
}, { exercises: 'Czech e-shop dispatch: "Dopravce: PPL" on the line above a labelled 11-digit number -> PPL by the shop naming it beside the number', expect: { parcel: `ppl:${PPL(2)}` } })
add('85-eshop-cz-11-digit-no-carrier.eml', {
  from: 'Dílna Vzorová <info@dilnavzorova.example.cz>', date: '2026-10-29 17:00',
  subject: 'Potvrzení objednávky č. 2026102911', messageId: mid('2026-10-29 17:00', 'conf-2026102911', 'dilnavzorova.example.cz'),
  text: `Dobrý den,\n\nděkujeme za vaši objednávku č. 2026102911. Zboží vám pošleme kurýrem.\nČíslo zásilky: ${PPL(3)}\n\nDílna Vzorová s.r.o.\n`,
}, { exercises: 'a stranger\'s mail with a labelled 11-digit number and no carrier named: never a PPL parcel (11 digits alone is no evidence); the extractor sends it to /attention ("something shaped like a tracking number") rather than guessing GLS or PPL', expect: { attention: true } })

// ---- write ----
const corpus = []
const built = new Map()
for (const m of mails) {
  const buf = m.copyOf ? built.get(m.copyOf) : buildEml(m.spec)
  built.set(m.file, buf)
  writeFileSync(join(OUT, m.file), buf)
  corpus.push({ file: m.file, date: m.spec.date, arrival: m.arrival ?? m.spec.date, exercises: m.exercises, expect: m.expect, bytes: buf.length })
}
writeFileSync(join(OUT, 'corpus.json'), `${JSON.stringify(corpus, null, 2)}\n`)
const exp = e => e.parcels ? `parcels ${e.parcels.join(' + ')}` : e.parcel ? `parcel \`${e.parcel}\`${e.archived ? ' (archived)' : ''}${e.code ? `, code ${e.code}` : ''}` : e.ignored ? 'ignored (not on /attention)' : 'needs-attention'
writeFileSync(join(OUT, 'MANIFEST.md'), `# Fake parcel-mail corpus

${corpus.length} synthetic messages: every name, address, phone, order and tracking number is invented. Numbers
have each carrier's real shape so they parse (Packeta \`Z22222222NN\`, DPD \`015053333333NN\`, GLS \`904444444NN\`, PPL \`408888888NN\`,
SPS \`SK0FAKE26TEST0000N\` / \`7035555555555501\`, Slovenská pošta \`EB666666NN?SK\` with a correct S10 check digit
unless stated, DHL \`JJD0007…\`, \`JVGL07…\`, \`0007…\`). Non-carrier senders use example.com / example.sk; carrier
domains appear only in From headers. Generated by \`scripts/dev/fake-mail/generate-corpus.mjs\`; templates follow
the scrubbed real mail in \`test/fixtures/mail/\` and the wording in SOURCES.md.

Dates are Europe/Bratislava. The harness treats **2026-10-15 09:00** as the day the app was set up: everything older
arrives in that first run (so mail older than 30 days archives on arrival), then mail arrives in four slots a day
up to 2026-10-30. \`corpus.json\` holds the same list in machine form with each mail's expectation.

Lifecycles: **P1** Packeta Z-BOX (13 → 15 → 26 → 32 → 36), **P2** Packeta výdajné miesto + COD, returned
(21 → 22 → 39 → 49), **P3** Packeta Z-BOX full → redirected (30 → 33 → 34 → 70), **P4** DPD Predict
(14 → 16 → 17), **P5** DPD Pickup Station (19 → 43 → 50 → 60), **P6** DPD failed attempt (23 → 24 → 27),
**P7** GLS BOX (18 → 20 → 61 → 69, + duplicate 77), **P8** GLS zero-padded (10 → 12 → 66), **SPS** (11 → 28 → 48),
**SPS 703** (46 → 73), **SPS revive** (04 → 63), **posta** (37 → 64 → 68), **DHL Express** (35 → 38 → 51),
**CZ Zásilkovna** (31 → 62; 78 → 79 → 80, and 81 returning), **shared Z-BOX** (40/67 → 74/75).

| File | Date | Exercises | Expected |
|---|---|---|---|
${corpus.map(c => `| \`${c.file}\` | ${c.arrival} | ${c.exercises.replace(/\|/g, '/')} | ${exp(c.expect)}${c.expect.note ? ` — ${c.expect.note}` : ''} |`).join('\n')}
`)
console.log(`wrote ${corpus.length} messages`)
