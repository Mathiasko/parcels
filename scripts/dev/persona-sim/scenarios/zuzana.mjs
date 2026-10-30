// zuzana: heavy AliExpress / Temu / Shein buyer, ~25 parcels in 14 days, Packeta Z-BOX by her block,
// slow cross-border parcels, marketplace noise and two look-alike scams.
import { Scenario, spaced } from '../kit/dsl.mjs'

export default function zuzana() {
  const s = new Scenario({
    id: 'zuzana', fullName: 'Zuzana Fiktívna', email: 'zuzana.fiktivna@example.com', digit: '3',
    day0: '2026-11-01', postcode: '99931', town: 'Fiktívna Bystrica',
  })
  const { Z, DPD, GLS, EB, RB_CN, SPS, LP } = s.n
  const ZH = s.point({ name: 'Z-BOX Fiktívna Bystrica, Lesná 4 (Billa)', street: 'Lesná 4', zip: '999 31', city: 'Fiktívna Bystrica' })
  const ZW = s.point({ name: 'Z-BOX Fiktívna Bystrica, Námestie SNP 1 (OC Centrum)', street: 'Námestie SNP 1', zip: '999 31', city: 'Fiktívna Bystrica' })
  const VM = s.point({ name: 'Trafika Pod Lipou – výdajné miesto', street: 'Lipová 12', zip: '999 32', city: 'Fiktívna Bystrica', hours: 'shop' })
  const DPD_PS = { name: 'Pickup Station Fiktívna Bystrica (Kaufland)', street: 'Okružná 2', zip: '999 31', city: 'Fiktívna Bystrica' }
  const GLS_PS = { name: 'GLS ParcelShop Papiernictvo Ceruzka', street: 'Školská 9', zip: '99931', city: 'Fiktívna Bystrica' }
  const POSTA = { name: 'Pošta Fiktívna Bystrica 1', street: 'Poštová 3', zip: '999 31', city: 'Fiktívna Bystrica' }
  const BALIKOBOX = { name: 'BalíkoBOX Fiktívna Bystrica – Lidl', street: 'Cesta k Lidlu 1', zip: '999 31', city: 'Fiktívna Bystrica' }

  const AE = 'AliExpress <transaction@notice.aliexpress.example.com>'
  const TEMU = 'Temu <orders@temu.example.com>'
  const SHEIN = 'SHEIN <noreply@shein.example.com>'
  const ae = (at, order, number, items, about, carrier = 'Cainiao Super Economy Global') => s.shopEn({ at, from: AE, subject: `Your order ${order} has been shipped`, hi: 'Zuzana', order, carrier, number, items, eta: 'Nov 18 - Dec 2', about })
  const temu = (at, order, number, items, about, carrier = 'Packeta', extra = []) => s.shopEn({ at, from: TEMU, subject: '📦 Your Temu order has shipped', hi: 'Zuzana', order, carrier, number, items, eta: '3-6 business days', about, extra })
  const shein = (at, order, number, items, about, carrier = 'Packeta') => s.shopEn({ at, from: SHEIN, subject: `Your SHEIN order ${order} has been shipped!`, hi: 'ZUZANA', order, carrier, number, items, eta: '5-8 days', about })

  // ---- in flight before setup (backlog: the filter is imported with "apply to existing")
  ae('D-12 03:10', '8193333300000001', LP(1), ['Phone case, transparent', 'Screen protector x2'], 'p01 AliExpress shipped (Cainiao LP number only, no supported carrier)')
  s.packeta({ key: 'p01', number: Z(1), sender: 'AliExpress (Cainiao)', place: ZH, code: '204417', accepted: 'D-1 15:00', ready: 'D2 08:50', label: 'AliExpress phone case' })
  shein('D-2 10:15', 'GSH33000001', spaced(Z(2)), ['Knit sweater, beige, M', 'Socks 5 pairs'], 'p02 Shein dispatch with the Packeta number')
  s.packeta({ key: 'p02', number: Z(2), sender: 'SHEIN', place: ZH, code: '530912', accepted: 'D0 11:00', ready: 'D2 09:35', label: 'Shein sweater', mails: { accepted: false } })
  ae('D-20 02:40', '8193333300000004', LP(4), ['Silicone baking mat'], 'p04 AliExpress shipped (LP only); later Slovenská pošta, foreign RB…CN number')
  s.posta({ key: 'p04', number: RB_CN(4), posted: 'D-8 06:00', postedAt: 'Shanghai CN', ready: 'D5 10:10', office: POSTA, keep: 7, reminderDaysBefore: 2, label: 'AliExpress baking mat (posta, foreign number)' })
  ae('D-16 05:00', '8193333300000025', LP(25), ['LED strip 5 m'], 'p25 AliExpress shipped, still crossing Europe at day 14 (never arrives in the 14 days)')
  s.plain({ at: 'D-3 12:00', from: AE, subject: 'Your package has arrived in the destination country', lang: 'en', about: 'p25 marketplace progress mail (LP only, not labelled)', lines: ['Hi Zuzana,', '', `Your package ${LP(25)} has arrived in the destination country and is waiting for customs clearance.`, 'Order 8193333300000025', '', 'AliExpress'] })
  s.packeta({ key: 'p23', number: Z(23), sender: 'AliExpress (Cainiao)', place: ZW, code: '771530', accepted: 'D-2 09:00', ready: 'D3 12:40', keep: 7, label: 'AliExpress hair clips, work Z-BOX' })

  // ---- week 1
  temu('D1 09:05', 'PO-211-33000003', Z(3), ['Kitchen organiser x3', 'Cable ties'], 'p03 Temu dispatch with Z number (no spaces)')
  s.packeta({ key: 'p03', number: Z(3), sender: 'TEMU', place: ZH, code: '118274', accepted: 'D1 18:00', ready: 'D4 06:55', label: 'Temu kitchen organisers' })
  s.plain({ at: 'D1 12:30', from: TEMU, subject: '🎁 Zuzana, your free gift is waiting – 3 days left!', lang: 'en', about: 'Temu marketing (not labelled)', lines: ['Lightning deals up to -90 %', 'Your free gift is waiting in the app.', 'Unsubscribe'] })
  s.plain({ at: 'D2 07:15', from: TEMU, subject: '📦 Zásielka zadarmo! Doprava zdarma na všetko', about: 'Temu marketing with the word "zásielka" in the subject: labelled false positive, no number', lines: ['Doprava zadarmo na všetky objednávky tento týždeň!', 'Kupón: TEMU-FREE-SHIP', 'Platí do nedele.'] })
  temu('D1 21:30', 'PO-211-33000005', GLS(5), ['Phone holder for the car'], 'p05 Temu via GLS to the door', 'GLS')
  s.gls({ key: 'p05', number: GLS(5), sender: 'TEMU', accepted: 'D2 08:00', delivered: 'D3 11:20', transitWindow: 'dnes medzi 10:00 a 13:00' })
  shein('D2 11:00', 'GSH33000006', Z(6), ['Dress, black, S'], 'p06 Shein to the WORK Z-BOX (she chose it by mistake)')
  s.packeta({ key: 'p06', number: Z(6), sender: 'SHEIN', place: ZW, code: '662018', accepted: 'D2 19:00', ready: 'D5 12:00', label: 'Shein dress, work Z-BOX' })
  s.plain({ at: 'D2 18:40', from: 'Packeta <info@packeta-sk.example.com>', subject: 'Vaša zásielka čaká – uhraďte poplatok 1,99 €', about: 'PHISHING look-alike Packeta (labelled)', lines: ['Dobrý deň,', `vaša zásielka ${spaced(Z(99))} čaká v depe. Pre doručenie uhraďte poplatok 1,99 € na https://packeta-sk.example.com/pay do 24 hodín.`, 'Packeta'] })
  s.mail({ at: 'D3 08:00', from: 'Móda Fiktívna <obchod@modafiktivna.example.sk>', subject: 'Potvrdenie objednávky č. 2026-3307', tag: 'conf-3307', about: 'order confirmation, names Packeta, no number (not labelled)', text: 'Dobrý deň,\n\nďakujeme za objednávku č. 2026-3307.\nDoprava: Packeta – výdajné miesto Trafika Pod Lipou\nPlatba: na dobierku 24,90 €\n\nMóda Fiktívna\n' })
  s.shopSk({ at: 'D4 14:00', shop: 'Móda Fiktívna', from: 'Móda Fiktívna <obchod@modafiktivna.example.sk>', subject: 'Objednávka č. 2026-3307 bola odoslaná', order: '2026-3307', carrierLine: 'Spôsob doručenia: Packeta – výdajné miesto Trafika Pod Lipou', numberLine: `Číslo zásielky: ${spaced(Z(7))}`, items: ['Zimná bunda, veľ. M'], extra: 'Na úhradu pri prevzatí: 24,90 €', about: 'p07 Slovak shop dispatch, COD at a výdajné miesto' })
  s.packeta({ key: 'p07', number: Z(7), sender: 'Móda Fiktívna', place: VM, accepted: 'D4 16:00', ready: 'D6 10:00', cod: '24,90 €', label: 'winter jacket, COD at the Trafika', mails: { accepted: false } })
  ae('D3 04:20', '8193333300000009', LP(9), ['Bluetooth earbuds'], 'p09 AliExpress shipped (LP)')
  s.packeta({ key: 'p09', number: Z(9), sender: 'AliExpress (Cainiao)', place: ZH, code: '009115', accepted: 'D7 13:00', ready: 'D10 07:10', label: 'AliExpress earbuds' })
  temu('D4 10:10', 'PO-211-33000008', spaced(Z(8)), ['Bath mat', 'Shower curtain hooks'], 'p08 Temu dispatch')
  s.packeta({ key: 'p08', number: Z(8), sender: 'TEMU', place: ZH, code: '381640', accepted: 'D4 20:00', ready: 'D7 08:05', label: 'Temu bath mat' })
  temu('D4 22:00', 'PO-211-33000024', DPD(24), ['Desk lamp'], 'p24 Temu via DPD to the door (Saturday)', 'DPD')
  s.dpdHome({ key: 'p24', number: DPD(24), sender: 'TEMU # PO-211-33000024', shipped: 'D5 09:00', delivered: 'D6 10:40', window: '10:00 – 11:00' })
  s.plain({ at: 'D5 09:30', from: 'Slovenská pošta <info@posta-sk.example.net>', subject: 'Zásielka zadržaná na colnici – doplatok 2,40 €', about: 'PHISHING look-alike Slovenská pošta (labelled)', lines: ['Vážený zákazník,', 'vaša zásielka zo zahraničia bola zadržaná na colnici. Uhraďte colný poplatok 2,40 € do 48 hodín: https://posta-sk.example.net/clo', 'Slovenská pošta'] })
  shein('D5 15:00', 'GSH33000010', DPD(10), ['Boots, size 38'], 'p10 Shein via DPD Pickup Station', 'DPD')
  s.dpdStation({ key: 'p10', number: DPD(10), sender: 'SHEIN # GSH33000010', shipped: 'D6 08:00', ready: 'D8 14:10', station: DPD_PS, pin: '448203', keep: 5, label: 'Shein boots, DPD station' })
  s.plain({ at: 'D6 08:00', from: SHEIN, subject: 'New in: winter collection ❄️ up to 70 % off', lang: 'en', about: 'Shein newsletter (not labelled)', lines: ['New in this week.', 'Extra 15 % with code WINTER15', 'Unsubscribe'] })
  s.plain({ at: 'D6 19:00', from: AE, subject: 'Order confirmed: 8193333300000012', lang: 'en', about: 'AliExpress order confirmation (not labelled)', lines: ['Hi Zuzana,', 'Thanks for your order 8193333300000012.', 'We will let you know when it ships.'] })

  // ---- week 2
  temu('D7 10:00', 'PO-211-33000011', Z(11), ['Wall stickers'], 'p11 Temu dispatch')
  s.packeta({ key: 'p11', number: Z(11), sender: 'TEMU', place: ZH, code: '650077', accepted: 'D7 18:30', ready: 'D9 08:20', label: 'Temu wall stickers' })
  ae('D7 23:50', '8193333300000016', LP(16), ['USB-C cable x2'], 'p16 AliExpress shipped (LP); arrives via posta BalíkoBOX')
  s.posta({ key: 'p16', number: EB(16), posted: 'D8 06:00', ready: 'D9 11:30', office: BALIKOBOX, box: { pin: '902614' }, keep: 3, reminderDaysBefore: 1, label: 'AliExpress cables, BalíkoBOX (3 days)' })
  s.plain({ at: 'D8 07:30', from: TEMU, subject: 'Your package has a surprise inside 👀', lang: 'en', about: 'Temu marketing (not labelled)', lines: ['Open the app to reveal your surprise.', 'Unsubscribe'] })
  temu('D8 09:40', 'PO-211-33000013', null, ['Storage boxes x4', 'Label maker'], 'p13+p14: one Temu mail naming TWO Packeta parcels', 'Packeta', ['', 'Your order ships in 2 parcels:', `Parcel 1/2: ${spaced(Z(13))} (storage boxes)`, `Parcel 2/2: ${spaced(Z(14))} (label maker)`])
  s.packeta({ key: 'p13', number: Z(13), sender: 'TEMU', place: ZH, code: '227401', accepted: 'D8 19:00', ready: 'D10 07:15', label: 'Temu storage boxes (1/2)' })
  s.packeta({ key: 'p14', number: Z(14), sender: 'TEMU', place: ZH, code: '845530', accepted: 'D8 19:05', ready: 'D12 09:00', label: 'Temu label maker (2/2)' })
  ae('D8 03:00', '8193333300000012', LP(12), ['Necklace'], 'p12 AliExpress shipped (LP)')
  s.packeta({ key: 'p12', number: Z(12), sender: 'AliExpress (Cainiao)', place: ZH, code: '316652', accepted: 'D9 12:00', ready: 'D11 07:30', label: 'AliExpress necklace' })
  temu('D9 10:00', 'PO-211-33000017', GLS(17), ['Yoga mat'], 'p17 Temu via GLS ParcelShop', 'GLS')
  s.gls({ key: 'p17', number: GLS(17), sender: 'TEMU', accepted: 'D9 18:00', ready: 'D11 13:00', point: GLS_PS, pin: '573019', keep: 7, label: 'Temu yoga mat, GLS ParcelShop' })
  shein('D10 11:20', 'GSH33000015', Z(15), ['Scarf', 'Gloves'], 'p15 Shein dispatch')
  s.packeta({ key: 'p15', number: Z(15), sender: 'SHEIN', place: ZH, code: '470381', accepted: 'D10 20:00', ready: 'D12 08:45', label: 'Shein scarf' })
  ae('D9 05:10', '8193333300000018', SPS('ZUZA', 18), ['Wireless charger'], 'p18 AliExpress handed to SPS (number in the mail), courier to the door', 'Cainiao → SPS Slovak Parcel Service')
  s.sps({ key: 'p18', number: SPS('ZUZA', 18), sender: 'Cainiao', shipped: 'D10 14:00', delivered: 'D12 15:10' })
  s.plain({ at: 'D10 13:00', from: AE, subject: '11.11 is coming: coupons inside 🎉', lang: 'en', about: 'AliExpress marketing (not labelled)', lines: ['Get ready for 11.11.', 'Coupons up to 30 EUR.'] })
  shein('D11 10:30', 'GSH33000019', Z(19), ['Pyjamas'], 'p19 Shein dispatch')
  s.packeta({ key: 'p19', number: Z(19), sender: 'SHEIN', place: ZH, code: '138826', accepted: 'D11 19:00', ready: 'D13 08:10', label: 'Shein pyjamas' })
  ae('D11 02:00', '8193333300000020', LP(20), ['Keyboard wrist rest'], 'p20 AliExpress shipped (LP)')
  s.packeta({ key: 'p20', number: Z(20), sender: 'AliExpress (Cainiao)', place: ZH, code: '502281', accepted: 'D13 14:00', ready: 'D16 08:00', label: 'AliExpress wrist rest (not ready by day 14)' })
  temu('D12 09:00', 'PO-211-33000021', Z(21), ['Christmas lights'], 'p21 Temu dispatch, still in transit at day 14')
  s.packeta({ key: 'p21', number: Z(21), sender: 'TEMU', place: ZH, code: '613390', accepted: 'D13 18:00', ready: 'D15 08:00', label: 'Temu lights (not ready by day 14)' })
  shein('D12 12:00', 'GSH33000022', Z(22), ['Hoodie'], 'p22 Shein dispatch')
  s.packeta({ key: 'p22', number: Z(22), sender: 'SHEIN', place: ZH, code: '084462', accepted: 'D12 19:00', ready: 'D14 09:20', label: 'Shein hoodie' })
  s.plain({ at: 'D12 20:00', from: 'Packeta Slovakia <info@packeta.sk>', subject: 'Posielajte s Packetou výhodne – od 2,49 €', about: 'real Packeta promo (from packeta.sk: labelled), shows a sample number', lines: ['Posielajte s Packetou výhodne.', 'Na štítku nájdete číslo zásielky v tvare Z 000 0000 000 – podľa neho ju sledujete.', 'Cena od 2,49 €.'] })
  s.plain({ at: 'D13 09:00', from: TEMU, subject: 'How was your order? Rate it and get 500 credits', lang: 'en', about: 'Temu review request (not labelled)', lines: ['Rate your recent order PO-211-33000003.', 'Unsubscribe'] })
  return s
}
