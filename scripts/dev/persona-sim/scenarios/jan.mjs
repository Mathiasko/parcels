// jan: retired, one or two parcels in 14 days. A slow Slovenská pošta parcel (cash on delivery) that the
// postman cannot deliver, so it waits at the post office until a deadline; and a DPD courier parcel.
import { Scenario } from '../kit/dsl.mjs'

export default function jan() {
  const s = new Scenario({
    id: 'jan', fullName: 'Ján Vymyslený', email: 'jan.vymysleny@example.sk', digit: '2',
    day0: '2026-11-01', postcode: '99941', town: 'Dolné Fiktívce',
  })
  const { EB, DPD } = s.n
  const POSTA = { name: 'Pošta Dolné Fiktívce', street: 'Hlavná 1', zip: '999 41', city: 'Dolné Fiktívce' }
  const KNIHY = 'Knihy Pre Vás <objednavky@knihyprevas.example.sk>'
  s.plain({ at: 'D-2 18:20', from: KNIHY, subject: 'Potvrdenie objednávky č. 2026-11873', about: 'order confirmation, no number (not labelled)', lines: ['Dobrý deň,', '', 'ďakujeme za objednávku č. 2026-11873.', 'Kniha: Atlas húb Slovenska (2. vydanie)', 'Doprava: Slovenská pošta – balík na adresu', 'Platba: dobierka 18,50 €', '', 'Knihy Pre Vás'] })
  s.shopSk({ at: 'D2 10:05', shop: 'Knihy Pre Vás', from: KNIHY, subject: 'Vaša objednávka č. 2026-11873 bola odoslaná', order: '2026-11873', carrierLine: 'Spôsob doručenia: Slovenská pošta – balík na adresu (dobierka 18,50 €)', numberLine: `Podacie číslo: ${EB(1)}`, items: ['Atlas húb Slovenska (2. vydanie)'], about: 'p1 shop dispatch with the posta number' })
  s.posta({ key: 'p1', number: EB(1), posted: 'D2 15:00', ready: 'D5 11:00', office: POSTA, keep: 7, cod: '18,50 €', reminderDaysBefore: 3,
    extraEvents: [{ at: 'D5 10:20', status: 'failed_attempt', text: 'Adresát nezastihnutý, zásielka bude uložená na pošte', location: 'Dolné Fiktívce' }], label: 'book, COD, post office (must be collected by Fri 13 Nov 18:00)' })
  s.plain({ at: 'D3 16:40', from: 'Banka Fiktívna <info@bankafiktivna.example.sk>', subject: 'Váš výpis z účtu za október 2026', about: 'bank statement (not labelled)', lines: ['Vážený klient,', 'váš výpis z účtu za október je pripravený v internetbankingu.', 'Banka Fiktívna'] })
  s.plain({ at: 'D4 19:10', from: 'Tomáško <tomasko.vnuk@example.com>', subject: 'Ahoj dedko', html: false, about: 'grandson, personal (not labelled)', lines: ['Ahoj dedko,', 'v sobotu prídeme. Mamka hovorí, že ti objednala tie kvapky z lekárne, prídu kuriérom.', 'Tomáško'] })
  s.plain({ at: 'D6 08:15', from: 'DPD <info@dpd-sk.example.net>', subject: 'Vaša zásielka čaká na doplatenie poštovného 1,50 €', about: 'PHISHING look-alike DPD (labelled)', lines: ['Dobrý deň,', 'vašu zásielku nebolo možné doručiť, pretože nebolo uhradené poštovné 1,50 €.', 'Zaplaťte do 24 hodín: https://dpd-sk.example.net/platba', 'DPD'] })
  s.shopSk({ at: 'D8 13:00', shop: 'Lekáreň Zdravie Online', from: 'Lekáreň Zdravie Online <eshop@lekarenzdravie.example.sk>', subject: 'Objednávka č. L-55102 bola odoslaná', order: 'L-55102', carrierLine: 'Prepravca: DPD (kuriér na adresu)', numberLine: `Číslo zásielky DPD: ${DPD(2)}`, items: ['Očné kvapky 10 ml', 'Vitamín D3'], about: 'p2 pharmacy dispatch (ordered by his daughter)' })
  s.dpdHome({ key: 'p2', number: DPD(2), sender: 'Lekáreň Zdravie Online # L-55102', shipped: 'D8 15:00', delivered: 'D9 10:40', window: '10:15 – 11:15', courier: { name: 'Jozef', phone: '+421 900 000 212' } })
  s.plain({ at: 'D10 07:00', from: 'Záhradkár <noviny@zahradkar.example.sk>', subject: 'Záhradkár: čo robiť v záhrade v novembri', about: 'newsletter (not labelled)', lines: ['Novembrové práce v záhrade.', 'Odhlásiť odber'] })
  return s
}
