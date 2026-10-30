// petra: orders for the family. Alza (AlzaBox and courier), Notino, kids' clothes and toys; several parcels
// on the same day from different shops; one pair of shoes goes back (a return she sends).
import { Scenario, spaced } from '../kit/dsl.mjs'

export default function petra() {
  const s = new Scenario({
    id: 'petra', fullName: 'Petra Smyšlená', email: 'petra.smyslena@example.sk', digit: '5',
    day0: '2026-11-01', postcode: '99951', town: 'Testovce',
  })
  const { Z, DPD, GLS, EB, SPS, SPS703 } = s.n
  const ZB = s.point({ name: 'Z-BOX Testovce, Školská 2 (ZŠ)', street: 'Školská 2', zip: '999 51', city: 'Testovce' })
  const ALZABOX = { name: 'AlzaBox Testovce – Tesco' }
  const DPD_PS = { name: 'Pickup Station Testovce (Tesco)', street: 'Obchodná 1', zip: '999 51', city: 'Testovce' }
  const GLS_PS = { name: 'GLS ParcelShop Drogéria Kvietok', street: 'Mierová 4', zip: '99951', city: 'Testovce' }
  const BALIKOBOX = { name: 'BalíkoBOX Testovce – Pošta', street: 'Poštová 2', zip: '999 51', city: 'Testovce' }
  const BALIKOVO = { name: 'BALÍKOVO Testovce – Potraviny Jednota', street: 'Jarná 10', city: 'Testovce' }
  const NOTINO = 'Notino <objednavky@notino.example.sk>'
  const ALZA = 'Alza.sk <objednavky@alza.example.sk>'
  const BAMB = 'Bambulka – detská móda <obchod@bambulka.example.sk>'
  const KOC = 'Hračky Kocúrik <eshop@kocurik.example.sk>'

  s.plain({ at: 'D-1 21:10', from: ALZA, subject: 'Potvrdenie objednávky 1051500001', about: 'Alza confirmation (not labelled)', lines: ['Dobrý deň,', 'prijali sme vašu objednávku 1051500001.', 'Spôsob doručenia: AlzaBox Testovce – Tesco', 'Alza.sk'] })
  s.alzaBox({ key: 'p01', order: '1051500001', ready: 'D2 16:00', box: ALZABOX, code: '557120', keep: 3, items: 'Detská zubná kefka, Batérie AA', label: 'Alza #1 AlzaBox' })
  s.plain({ at: 'D0 20:05', from: NOTINO, subject: 'Ďakujeme za objednávku 26-880101', about: 'Notino confirmation (not labelled)', lines: ['Dobrý deň,', 'ďakujeme za objednávku 26-880101. O odoslaní vás budeme informovať.', 'Notino'] })
  s.shopSk({ at: 'D1 11:30', shop: 'Notino', from: NOTINO, subject: 'Vaša objednávka 26-880101 bola odoslaná', order: '26-880101', carrierLine: 'Doprava: Packeta – Z-BOX Testovce, Školská 2 (ZŠ)', numberLine: `Číslo zásielky: ${spaced(Z(2))}`, items: ['Krém na ruky 75 ml', 'Parfumovaná voda 30 ml'], about: 'p02 Notino dispatch' })
  s.packeta({ key: 'p02', number: Z(2), sender: 'Notino', place: ZB, code: '341208', accepted: 'D1 19:00', ready: 'D3 09:10', label: 'Notino #1' })
  s.shopSk({ at: 'D2 09:00', shop: 'Bambulka', from: BAMB, subject: 'Objednávka č. B-2207 bola odoslaná', order: 'B-2207', carrierLine: 'Prepravca: SPS – Slovak Parcel Service, výdaj na odbernom mieste BALÍKOVO', numberLine: `Číslo zásielky: ${SPS('PETR', 3)}`, items: ['Zimná čiapka, detská', 'Pančucháče 2 ks'], about: 'p03 kids clothes via SPS balíkovo' })
  s.sps({ key: 'p03', number: SPS('PETR', 3), sender: 'bambulka.example.sk', shipped: 'D2 15:00', ready: 'D3 13:00', place: BALIKOVO, code: '774421', keep: 5, label: 'Bambulka #1 (balíkovo)' })
  s.shopSk({ at: 'D2 10:10', shop: 'Topánočky', from: 'Topánočky <info@topanocky.example.sk>', subject: 'Vaša objednávka T-9001 bola odoslaná', order: 'T-9001', carrierLine: 'Doprava: DPD Pickup Station Testovce (Tesco)', numberLine: `Číslo balíka: ${DPD(4)}`, items: ['Zimné topánky, detské, veľ. 31'], about: 'p04 kids shoes via DPD station (later returned)' })
  s.dpdStation({ key: 'p04', number: DPD(4), sender: 'Topánočky s.r.o. # T-9001', shipped: 'D2 16:00', ready: 'D3 11:30', station: DPD_PS, pin: '610045', keep: 7, label: 'kids shoes (to be returned)' })
  s.plain({ at: 'D2 12:00', from: 'ZŠ Testovce <skola@zstestovce.example.sk>', subject: 'Rodičovské združenie vo štvrtok', about: 'school (not labelled)', lines: ['Vážení rodičia,', 'rodičovské združenie bude vo štvrtok o 16:30.', 'ZŠ Testovce'] })
  s.plain({ at: 'D5 09:20', from: 'Topánočky <info@topanocky.example.sk>', subject: 'Vrátenie tovaru k objednávke T-9001', about: 'return instructions with the Packeta return number (labelled? subject has no shipping word)', lines: ['Dobrý deň,', 'vrátenie tovaru sme zaevidovali. Zásielku podajte do 14 dní v ktoromkoľvek Z-BOXe alebo výdajnom mieste Packeta.', `Kód na podanie: R-${Z(5).slice(-6)}`, `Číslo zásielky na vrátenie: ${spaced(Z(5))}`, '', 'Topánočky'] })
  s.packetaReturn({ key: 'p05', number: Z(5), to: 'Topánočky s.r.o.', posted: 'D6 10:00', delivered: 'D8 14:00', dropAt: 'Z-BOX Testovce, Školská 2 (ZŠ)', label: 'RETURN of the shoes (Petra sends it)' })
  s.shopSk({ at: 'D4 08:30', shop: 'Alza.sk', from: ALZA, subject: 'Objednávka 1051500006 bola odoslaná', order: '1051500006', carrierLine: 'Dopravca: GLS (kuriér na adresu)', numberLine: `Číslo balíka: ${GLS(6)}`, items: ['Mixér ponorný', 'Detský pohár 3 ks'], about: 'p06 Alza via GLS courier' })
  s.gls({ key: 'p06', number: GLS(6), sender: 'Alza.sk', accepted: 'D4 10:00', delivered: 'D5 10:15' })
  s.shopSk({ at: 'D4 15:00', shop: 'Notino', from: NOTINO, subject: 'Vaša objednávka 26-880133 bola odoslaná', order: '26-880133', carrierLine: 'Doprava: GLS ParcelShop Drogéria Kvietok', numberLine: `Číslo balíka: ${GLS(7)}`, items: ['Šampón pre deti'], about: 'p07 Notino #2 via GLS ParcelShop' })
  s.gls({ key: 'p07', number: GLS(7), sender: 'Notino', accepted: 'D4 18:00', ready: 'D6 10:00', point: GLS_PS, pin: '228801', keep: 7, label: 'Notino #2 (GLS ParcelShop)' })
  s.plain({ at: 'D5 07:00', from: 'Alza.sk <newsletter@alza.example.sk>', subject: 'Black Friday v Alze začína už teraz', about: 'Alza newsletter (not labelled)', lines: ['Zľavy až 50 %.', 'Odhlásiť'] })
  s.shopSk({ at: 'D7 18:00', shop: 'Diskont Online', from: 'Diskont Online <eshop@diskont.example.sk>', subject: 'Objednávka D-44120 bola odoslaná', order: 'D-44120', carrierLine: 'Spôsob doručenia: Slovenská pošta – BalíkoBOX', numberLine: `Podacie číslo: ${EB(8)}`, items: ['Pracie gély 3 ks'], about: 'p08 posta BalíkoBOX, 3 days' })
  s.posta({ key: 'p08', number: EB(8), posted: 'D7 20:00', ready: 'D8 12:00', office: BALIKOBOX, box: { pin: '450091' }, keep: 3, reminderDaysBefore: 1, label: 'Diskont (BalíkoBOX, 3 days)' })
  s.shopSk({ at: 'D8 09:00', shop: 'Bambulka', from: BAMB, subject: 'Objednávka č. B-2231 bola odoslaná', order: 'B-2231', carrierLine: 'Prepravca: SPS – kuriér na adresu', numberLine: `Číslo zásielky: ${SPS703(9)}`, items: ['Zimná bunda, detská 116'], about: 'p09 Bambulka #2 via SPS courier' })
  s.sps({ key: 'p09', number: SPS703(9), sender: 'Bambulka', shipped: 'D8 14:00', delivered: 'D9 13:40' })
  s.shopSk({ at: 'D8 20:00', shop: 'Notino', from: NOTINO, subject: 'Vaša objednávka 26-880190 bola odoslaná', order: '26-880190', carrierLine: 'Doprava: Packeta – Z-BOX Testovce, Školská 2 (ZŠ)', numberLine: `Číslo zásielky: ${spaced(Z(10))}`, items: ['Telové mlieko'], about: 'p10 Notino #3' })
  s.packeta({ key: 'p10', number: Z(10), sender: 'Notino', place: ZB, code: '902114', accepted: 'D9 08:00', ready: 'D10 08:30', label: 'Notino #3' })
  s.shopSk({ at: 'D9 07:30', shop: 'Hračky Kocúrik', from: KOC, subject: 'Vaša objednávka K-7781 bola rozdelená a odoslaná', order: 'K-7781', carrierLine: 'Časť 1: Packeta Z-BOX Testovce, Školská 2 (ZŠ); časť 2: DPD kuriér na adresu', numberLine: `Packeta: ${spaced(Z(11))}\nDPD: ${DPD(12)}`, items: ['Stavebnica Kocky 500 ks', 'Bábika s kočíkom'], about: 'p11 + p12: one mail, two carriers' })
  s.packeta({ key: 'p11', number: Z(11), sender: 'Hračky Kocúrik', place: ZB, code: '117395', accepted: 'D9 10:00', ready: 'D10 09:40', label: 'Kocúrik blocks (same Z-BOX, same day as p10)' })
  s.dpdHome({ key: 'p12', number: DPD(12), sender: 'Hračky Kocúrik # K-7781', shipped: 'D9 09:00', delivered: 'D10 11:05', window: '10:30 – 11:30' })
  s.plain({ at: 'D11 18:30', from: 'Hračky Kocúrik <eshop@kocurik.example.sk>', subject: 'Ako ste boli spokojná s nákupom?', about: 'review request (not labelled)', lines: ['Ohodnoťte nákup K-7781 a získajte 5 % zľavu.'] })
  s.alzaBox({ key: 'p13', order: '1051500013', ready: 'D12 17:30', box: ALZABOX, code: '803366', keep: 3, items: 'Adventný kalendár 2 ks', label: 'Alza #3 AlzaBox' })
  return s
}
