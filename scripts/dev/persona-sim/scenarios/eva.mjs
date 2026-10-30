// eva: a travelling sales rep, away from home on days 3-6 and 10-12. ~8 parcels: two become ready while
// she is away, one of which runs out of pickup time before she is back; others must be fitted in between.
import { Scenario, spaced } from '../kit/dsl.mjs'

export default function eva() {
  const s = new Scenario({
    id: 'eva', fullName: 'Eva Cestovná', email: 'eva.cestovna@example.sk', digit: '9',
    day0: '2026-11-01', postcode: '99961', town: 'Fiktívne Mesto', away: [3, 4, 5, 6, 10, 11, 12],
  })
  const { Z, DPD, GLS, EB, SPS } = s.n
  const ZB = s.point({ name: 'Z-BOX Fiktívne Mesto, Nábrežná 9 (Lidl)', street: 'Nábrežná 9', zip: '999 61', city: 'Fiktívne Mesto' })
  const VM = s.point({ name: 'Kvetinárstvo Ruža – výdajné miesto Packeta', street: 'Ružová 2', zip: '999 61', city: 'Fiktívne Mesto', hours: 'shop' })
  const BALIKOBOX = { name: 'BalíkoBOX Fiktívne Mesto – stanica', street: 'Staničná 1', zip: '999 61', city: 'Fiktívne Mesto' }
  const GLS_PS = { name: 'GLS ParcelShop Čistiareň Biela', street: 'Krátka 5', zip: '99961', city: 'Fiktívne Mesto' }
  const BALIKOVO = { name: 'BALÍKOVO Fiktívne Mesto – Trafika na rohu', street: 'Rohová 1', city: 'Fiktívne Mesto' }
  const TRAVEL = (at, subject, lines) => s.plain({ at, from: 'Cestovka Fiktív <rezervacie@cestovka.example.sk>', subject, about: 'travel (not labelled)', lines })

  s.shopSk({ at: 'D-1 12:00', shop: 'Kancelária Plus', from: 'Kancelária Plus <eshop@kancelariaplus.example.sk>', subject: 'Objednávka KP-4410 bola odoslaná', order: 'KP-4410', carrierLine: 'Doprava: Packeta – Z-BOX Fiktívne Mesto, Nábrežná 9 (Lidl)', numberLine: `Číslo zásielky: ${spaced(Z(1))}`, items: ['Diár 2027', 'Perá x10'], about: 'e1 Z-BOX, ready day 1' })
  s.packeta({ key: 'e1', number: Z(1), sender: 'Kancelária Plus', place: ZB, code: '120934', accepted: 'D-1 17:00', ready: 'D1 09:00', label: 'diary (Z-BOX)' })
  TRAVEL('D1 18:00', 'Potvrdenie rezervácie: Hotel Fiktív Košice, 4.–7. 11.', ['Vaša rezervácia je potvrdená.', 'Príchod: streda 4. 11.'])
  s.shopSk({ at: 'D1 20:00', shop: 'Diskont Online', from: 'Diskont Online <eshop@diskont.example.sk>', subject: 'Objednávka D-50071 bola odoslaná', order: 'D-50071', carrierLine: 'Slovenská pošta – BalíkoBOX Fiktívne Mesto – stanica', numberLine: `Podacie číslo: ${EB(2)}`, items: ['Termoska 1 l'], about: 'e2 BalíkoBOX ready while away (3 days) -> EXPIRES' })
  s.posta({ key: 'e2', number: EB(2), posted: 'D2 06:00', ready: 'D3 10:00', office: BALIKOBOX, box: { pin: '778102' }, keep: 3, reminderDaysBefore: 1, label: 'thermos (BalíkoBOX, ready while away, expires)' })
  s.shopSk({ at: 'D2 08:00', shop: 'Šport Fiktív', from: 'Šport Fiktív <eshop@sportfiktiv.example.sk>', subject: 'Objednávka S-221 bola odoslaná', order: 'S-221', carrierLine: 'Doprava: Packeta – Z-BOX Fiktívne Mesto, Nábrežná 9 (Lidl)', numberLine: `Číslo zásielky: ${spaced(Z(3))}`, items: ['Bežecké rukavice'], about: 'e3 Z-BOX ready while away, deadline day 11 (collect days 7-9)' })
  s.packeta({ key: 'e3', number: Z(3), sender: 'Šport Fiktív', place: ZB, code: '405519', accepted: 'D2 15:00', ready: 'D4 08:00', keep: 7, label: 'gloves (Z-BOX, ready while away)' })
  s.shopSk({ at: 'D3 11:00', shop: 'Elektro Svet', from: 'Elektro Svet <objednavky@elektrosvet.example.sk>', subject: 'Objednávka č. 2026110455 bola odoslaná', order: '2026110455', carrierLine: 'Prepravca: DPD (kuriér na adresu)', numberLine: `Číslo zásielky DPD: ${DPD(4)}`, items: ['Nabíjačka do auta'], about: 'e4 DPD courier while away: failed attempt, then delivered day 8' })
  s.dpdHome({ key: 'e4', number: DPD(4), sender: 'Elektro Svet # 2026110455', shipped: 'D3 14:00', attempts: [{ at: 'D5 10:30', ok: false, window: '10:00 – 11:00' }, { at: 'D8 17:10', ok: true, window: '17:00 – 18:00' }] })
  s.shopSk({ at: 'D3 16:00', shop: 'Kozmetika Jasmín', from: 'Kozmetika Jasmín <eshop@jasmin.example.sk>', subject: 'Vaša objednávka J-778 bola odoslaná', order: 'J-778', carrierLine: 'Doprava: GLS ParcelShop Čistiareň Biela', numberLine: `Číslo balíka: ${GLS(5)}`, items: ['Krém na tvár'], about: 'e5 GLS ParcelShop ready while away, deadline day 10 (collect days 7-9)' })
  s.gls({ key: 'e5', number: GLS(5), sender: 'Kozmetika Jasmín', accepted: 'D3 18:00', ready: 'D5 11:00', point: GLS_PS, pin: '662014', keep: 5, label: 'face cream (GLS ParcelShop, ready while away)' })
  TRAVEL('D6 20:00', 'Ďakujeme za pobyt v Hoteli Fiktív', ['Ohodnoťte svoj pobyt.'])
  TRAVEL('D8 18:00', 'Potvrdenie rezervácie: Hotel Fiktív Žilina, 11.–13. 11.', ['Vaša rezervácia je potvrdená.', 'Príchod: streda 11. 11.'])
  s.shopSk({ at: 'D8 10:00', shop: 'Knihomoľ', from: 'Knihomoľ <info@knihomol.example.sk>', subject: 'Vaša objednávka č. 2026110601 bola odoslaná', order: '2026110601', carrierLine: 'Prepravca: SPS – výdaj na odbernom mieste BALÍKOVO', numberLine: `Číslo zásielky: ${SPS('EVAC', 6)}`, items: ['Kniha: Cestovateľ'], about: 'e6 SPS balíkovo ready day 9, deadline day 12 18:00: only day 9 works' })
  s.sps({ key: 'e6', number: SPS('EVAC', 6), sender: 'knihomol.example.sk', shipped: 'D8 12:00', ready: 'D9 09:00', place: BALIKOVO, code: '240117', keep: 3, label: 'book (SPS balíkovo, tight)' })
  s.shopSk({ at: 'D9 15:00', shop: 'Čajovňa Lístok', from: 'Čajovňa Lístok <predaj@listok.example.sk>', subject: 'Objednávka L-90 bola odoslaná', order: 'L-90', carrierLine: 'Doprava: Packeta – výdajné miesto Kvetinárstvo Ruža', numberLine: `Číslo zásielky: ${spaced(Z(7))}`, items: ['Zelený čaj 100 g'], about: 'e7 výdajné miesto ready while away (day 11), deadline after day 14' })
  s.packeta({ key: 'e7', number: Z(7), sender: 'Čajovňa Lístok', place: VM, accepted: 'D9 18:00', ready: 'D11 10:00', keep: 7, label: 'tea (výdajné miesto, ready while away)' })
  s.shopSk({ at: 'D12 09:00', shop: 'Domov a Záhrada', from: 'Domov a Záhrada <eshop@domovzahrada.example.sk>', subject: 'Objednávka DZ-31 bola odoslaná', order: 'DZ-31', carrierLine: 'Prepravca: DPD (kuriér na adresu)', numberLine: `Číslo zásielky DPD: ${DPD(8)}`, items: ['Vankúš'], about: 'e8 DPD courier on Saturday day 13 (home)' })
  s.dpdHome({ key: 'e8', number: DPD(8), sender: 'Domov a Zahrada # DZ-31', shipped: 'D12 11:00', delivered: 'D13 10:20', window: '10:00 – 11:00' })
  s.plain({ at: 'D11 09:10', from: 'Packeta <dorucenie@packeta-zasielky.example.com>', subject: 'Vaša zásielka nemohla byť doručená – potvrďte adresu', about: 'PHISHING look-alike Packeta while she is away (labelled)', lines: ['Dobrý deň,', `vaša zásielka ${spaced(Z(97))} nemohla byť doručená pre neúplnú adresu.`, 'Potvrďte adresu a uhraďte 0,49 € do 12 hodín: https://packeta-zasielky.example.com/', 'Packeta'] })
  s.plain({ at: 'D4 07:00', from: 'Firma Fiktív – interné <intranet@firmafiktiv.example.sk>', subject: 'Týždenný report predaja', html: false, about: 'work (not labelled)', lines: ['Report v prílohe.'] })
  return s
}
