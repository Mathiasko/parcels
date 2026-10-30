// martin: owns a small bike-parts e-shop. Supplier parcels by GLS, DPD and SPS to the shop (~15), three
// customer returns waiting at a Packeta pickup point, and a lot of order mail: his own shop platform's
// "new order" alerts and copies of the dispatch mails it sends his customers (with THEIR tracking numbers),
// supplier confirmations and invoices, and a carrier invoice.
import { Scenario, spaced } from '../kit/dsl.mjs'

export default function martin() {
  const s = new Scenario({
    id: 'martin', fullName: 'Martin Pedálový', email: 'martin@bicyklefiktiv.example.sk', digit: '6',
    day0: '2026-11-01', postcode: '99971', town: 'Kolesovo',
  })
  const { Z, DPD, GLS, SPS, SPS703 } = s.n
  const VM = s.point({ name: 'Papiernictvo Kolesovo – výdajné miesto Packeta', street: 'Hlavná 22', zip: '999 71', city: 'Kolesovo', hours: 'shop' })
  const GLS_PS = { name: 'GLS ParcelShop Tabak Kolesovo', street: 'Staničná 3', zip: '99971', city: 'Kolesovo' }
  const VELO = 'Velo Distribúcia <expedicia@velodistribucia.example.sk>'
  const CYKLO = 'CykloParts GmbH <versand@cykloparts.example.de>'
  const RETAZE = 'Reťaze & Spol. <sklad@retaze.example.sk>'
  const BRZDY = 'Brzdy Plus <obchod@brzdyplus.example.sk>'
  const PNEU = 'Pneu Velo CZ <expedice@pneuvelo.example.cz>'
  const SHOP = 'Bicykle Fiktív – e-shop <noreply@bicyklefiktiv.example.sk>'
  const PLATFORM = 'E-shop platforma <notifikacie@eshopplatforma.example.sk>'

  const supplierSk = (at, from, shop, order, carrier, number, items, about) => s.shopSk({ at, shop, from, subject: `Objednávka ${order} bola odoslaná`, order, carrierLine: `Prepravca: ${carrier}`, numberLine: `Číslo zásielky: ${number}`, items, about })
  const cyklo = (at, order, numbers, items, about) => s.plain({ at, from: CYKLO, subject: `Versandbestätigung / Shipping confirmation ${order}`, lang: 'en', about, lines: ['Dear customer,', '', `your order ${order} has been dispatched with DPD.`, ...numbers.map((n, i) => `Parcel ${i + 1}: ${n}`), '', 'Items:', ...items.map(i => ` - ${i}`), '', 'CykloParts GmbH, Musterstraße 1, 99999 Fiktivstadt'] })
  const conf = (at, from, order) => s.plain({ at, from, subject: `Potvrdenie objednávky ${order}`, about: 'supplier order confirmation (not labelled)', lines: ['Dobrý deň,', `potvrdzujeme prijatie objednávky ${order}. Termín expedície vám oznámime.`, ''] })
  const invoice = (at, from, no) => s.plain({ at, from, subject: `Faktúra ${no}`, about: 'supplier invoice (not labelled)', lines: ['Dobrý deň,', `v prílohe posielame faktúru ${no}. Splatnosť 14 dní.`, 'IBAN: SK00 0000 0000 0000 0000 0000'] })
  const newOrder = (at, no, total) => s.plain({ at, from: PLATFORM, subject: `Nová objednávka č. ${no} (${total})`, about: 'his shop platform: new customer order (not labelled)', lines: [`Nová objednávka č. ${no}`, `Suma: ${total}`, 'Doprava: Packeta Z-BOX', 'Otvoriť v administrácii'] })
  const outgoing = (key, at, no, number, customer, town) => {
    s.plain({ at, from: SHOP, to: `Bicykle Fiktív <${s.meta.email}>`, subject: `Kópia: Vaša objednávka č. ${no} bola odoslaná`, about: `${key}: COPY of a dispatch mail to HIS customer - the parcel is going OUT (labelled)`, lines: [`Dobrý deň ${customer},`, '', `vaša objednávka č. ${no} bola odoslaná.`, `Spôsob doručenia: Packeta – Z-BOX ${town}`, `Číslo zásielky: ${spaced(number)}`, '', 'Ďakujeme za nákup!', 'Bicykle Fiktív s.r.o.'] })
    const d = s.day(at)
    s.parcel({ key, carrier: 'packeta', number, label: `OUTGOING to ${customer} (${town})`, events: [
      { at: s.plusMin(at, 60), status: 'pre_transit', text: 'Zásielka bola podaná odosielateľom.' },
      { at: `D${d + 1} 06:30`, status: 'in_transit', text: 'Zásielka je na ceste.' },
      { at: `D${d + 2} 09:15`, status: 'ready_for_pickup', text: 'Zásielka bola uložená v Z-BOXe a čaká na vyzdvihnutie.' },
      { at: `D${d + 3} 17:40`, status: 'delivered', text: 'Zásielka bola vyzdvihnutá.' },
    ] })
  }
  const ret = (key, n, customer, accepted, ready, code) => s.packeta({ key, number: Z(n), sender: customer, place: VM, code, accepted, ready, keep: 7, label: `customer return from ${customer}`, mails: { reminder: true } })

  // ---- week 1
  conf('D-2 10:00', VELO, 'VD-26-1180')
  supplierSk('D1 08:10', VELO, 'Velo Distribúcia', 'VD-26-1180', 'GLS', GLS(1), ['Plášť 29" x10', 'Duše 29" x20'], 's01 supplier GLS')
  s.gls({ key: 's01', number: GLS(1), sender: 'Velo Distribúcia s.r.o.', accepted: 'D1 09:00', delivered: 'D2 10:30' })
  cyklo('D0 15:00', 'CP-77120', [DPD(2)], ['Shimano chain CN-HG71 x20'], 's02 German supplier, English/German, DPD')
  s.dpdHome({ key: 's02', number: DPD(2), sender: 'CykloParts GmbH # CP-77120', shipped: 'D0 16:00', delivered: 'D2 13:20', window: '13:00 – 14:00' })
  newOrder('D1 09:12', '1040', '84,90 €'); newOrder('D1 14:40', '1041', '23,50 €'); newOrder('D2 08:05', '1042', '149,00 €')
  outgoing('o1', 'D2 11:00', '1040', Z(31), 'Juraj Kupujúci', 'Ružomberok-Fiktív')
  supplierSk('D2 07:30', RETAZE, 'Reťaze & Spol.', 'R-5521', 'SPS – Slovak Parcel Service', SPS('MART', 3), ['Reťaz KMC X11 x10'], 's03 supplier SPS')
  s.sps({ key: 's03', number: SPS('MART', 3), sender: 'Reťaze & Spol.', shipped: 'D2 10:00', delivered: 'D3 09:50' })
  ret('r1', 21, 'Juraj Zákaznícky', 'D1 16:00', 'D3 11:20', undefined)
  conf('D2 13:00', BRZDY, 'BP-0981')
  supplierSk('D3 08:00', BRZDY, 'Brzdy Plus', 'BP-0981', 'GLS', GLS(4), ['Brzdové doštičky x30'], 's04 supplier GLS')
  s.gls({ key: 's04', number: GLS(4), sender: 'Brzdy Plus s.r.o.', accepted: 'D3 09:00', delivered: 'D4 11:40' })
  cyklo('D3 14:00', 'CP-77158', [DPD(5), DPD(6)], ['Cassette 11-34 x5', 'Derailleur hanger x12'], 's05+s06 one supplier mail naming TWO DPD parcels')
  s.dpdHome({ key: 's05', number: DPD(5), sender: 'CykloParts GmbH # CP-77158', shipped: 'D3 15:00', delivered: 'D5 10:05', window: '10:00 – 11:00' })
  s.dpdHome({ key: 's06', number: DPD(6), sender: 'CykloParts GmbH # CP-77158', shipped: 'D3 15:00', delivered: 'D5 10:06', window: '10:00 – 11:00' })
  newOrder('D3 19:30', '1043', '312,00 €'); invoice('D4 09:00', VELO, 'VD-F-26-0457')
  supplierSk('D4 10:00', RETAZE, 'Reťaze & Spol.', 'R-5530', 'SPS – kuriér, dobierka 312,40 €', SPS703(7), ['Reťaze KMC X12 x20'], 's07 supplier SPS 703 with COD')
  s.sps({ key: 's07', number: SPS703(7), sender: 'Reťaze & Spol.', shipped: 'D4 12:00', delivered: 'D5 14:30', cod: '312,40 €' })
  outgoing('o2', 'D5 10:30', '1043', Z(32), 'Ing. Pavol Jazdný', 'Martin-Fiktív')
  s.plain({ at: 'D5 16:00', from: 'DPD SK <fakturacia@dpd.sk>', subject: 'Faktúra za prepravné služby č. 7012001 – október 2026', about: 'CARRIER invoice from dpd.sk: labelled false positive', lines: ['Dobrý deň,', 'v prílohe posielame faktúru č. 7012001 za prepravné služby v októbri 2026.', 'Zákaznícke číslo: 0150000000', 'DPD SK s.r.o.'] })
  s.plain({ at: 'D5 18:00', from: PNEU, subject: 'Objednávka PV-3310 odeslána', about: 's08 Czech supplier dispatch (labelled via "odeslana")', lines: ['Dobrý den,', 'vaše objednávka PV-3310 byla odeslána přes DPD.', `Číslo balíku: ${DPD(8)}`, '', 'Pneu Velo CZ s.r.o.'] })
  s.dpdHome({ key: 's08', number: DPD(8), sender: 'Pneu Velo CZ # PV-3310', shipped: 'D5 19:00', attempts: [{ at: 'D6 12:30', ok: false, window: '12:00 – 13:00' }, { at: 'D8 10:20', ok: true, window: '10:00 – 11:00' }] })
  // ---- week 2
  ret('r2', 22, 'Monika Vrátená', 'D5 17:00', 'D7 10:10', undefined)
  newOrder('D7 21:00', '1044', '59,90 €'); newOrder('D8 07:45', '1045', '19,90 €')
  supplierSk('D7 16:00', VELO, 'Velo Distribúcia', 'VD-26-1201', 'GLS ParcelShop Tabak Kolesovo (sklad nemá kuriéra v sobotu)', GLS(9), ['Sedlá x6'], 's09 supplier via GLS ParcelShop (pickup)')
  s.gls({ key: 's09', number: GLS(9), sender: 'Velo Distribúcia s.r.o.', accepted: 'D7 17:00', ready: 'D8 13:00', point: GLS_PS, pin: '660193', keep: 7, label: 'saddles, GLS ParcelShop' })
  outgoing('o3', 'D8 11:00', '1044', Z(33), 'Lucia Rýchla', 'Žilina-Fiktív')
  supplierSk('D8 08:30', VELO, 'Velo Distribúcia', 'VD-26-1209', 'GLS', GLS(10), ['Rám 54 cm x2'], 's10 supplier GLS')
  s.gls({ key: 's10', number: GLS(10), sender: 'Velo Distribúcia s.r.o.', accepted: 'D8 10:00', delivered: 'D9 09:40' })
  cyklo('D9 09:00', 'CP-77201', [DPD(11)], ['Brake cable x50'], 's11 German supplier DPD')
  s.dpdHome({ key: 's11', number: DPD(11), sender: 'CykloParts GmbH # CP-77201', shipped: 'D9 10:00', delivered: 'D10 11:10', window: '11:00 – 12:00' })
  conf('D9 13:00', RETAZE, 'R-5560'); invoice('D9 15:00', BRZDY, 'BP-F-0144')
  supplierSk('D10 08:00', RETAZE, 'Reťaze & Spol.', 'R-5560', 'SPS – Slovak Parcel Service', SPS('MART', 12), ['Pedále x10'], 's12 supplier SPS')
  s.sps({ key: 's12', number: SPS('MART', 12), sender: 'Reťaze & Spol.', shipped: 'D10 10:00', delivered: 'D11 10:30' })
  supplierSk('D10 09:00', BRZDY, 'Brzdy Plus', 'BP-1002', 'GLS', GLS(13), ['Kotúče 160 mm x10'], 's13 supplier GLS')
  s.gls({ key: 's13', number: GLS(13), sender: 'Brzdy Plus s.r.o.', accepted: 'D10 10:00', delivered: 'D11 14:15' })
  outgoing('o4', 'D10 10:00', '1045', Z(34), 'Peter Pomalý', 'Prešov-Fiktív')
  ret('r3', 23, 'Andrej Nespokojný', 'D9 17:00', 'D11 09:30', undefined)
  newOrder('D11 12:00', '1046', '410,00 €')
  s.plain({ at: 'D11 13:00', from: PNEU, subject: 'Objednávka PV-3355 odeslána', about: 's14 Czech supplier dispatch', lines: ['Dobrý den,', 'vaše objednávka PV-3355 byla odeslána přes DPD.', `Číslo balíku: ${DPD(14)}`, '', 'Pneu Velo CZ s.r.o.'] })
  s.dpdHome({ key: 's14', number: DPD(14), sender: 'Pneu Velo CZ # PV-3355', shipped: 'D11 14:00', delivered: 'D12 10:50', window: '10:30 – 11:30' })
  supplierSk('D11 15:00', RETAZE, 'Reťaze & Spol.', 'R-5571', 'SPS – Slovak Parcel Service', SPS('MART', 15), ['Ložiská x40'], 's15 supplier SPS')
  s.sps({ key: 's15', number: SPS('MART', 15), sender: 'Reťaze & Spol.', shipped: 'D11 17:00', delivered: 'D12 15:20' })
  newOrder('D12 18:10', '1047', '35,00 €'); newOrder('D13 10:00', '1048', '88,00 €')
  return s
}
