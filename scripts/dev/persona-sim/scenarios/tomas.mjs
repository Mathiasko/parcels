// tomas: works in IT security. A light parcel load (~5); his interest is the setup, what the app can read
// and send, where it keeps data, and how it updates: a new release appears on day 6.
import { Scenario, spaced } from '../kit/dsl.mjs'

export default function tomas() {
  const s = new Scenario({
    id: 'tomas', fullName: 'Tomáš Bezpečný', email: 'tomas.bezpecny@example.sk', digit: '8',
    day0: '2026-11-01', postcode: '99981', town: 'Fiktívna Ves',
    release: { at: 'D6 07:00', tag: 'v0.2.0', body: '- Faster mail ingest\n- The GLS ParcelShop address is shown on the parcel page\n- Security: an update not signed with the release certificate is refused' },
  })
  const { Z, DPD, GLS, EB, JJD } = s.n
  const ZB = s.point({ name: 'Z-BOX Fiktívna Ves, Jarná 1 (COOP)', street: 'Jarná 1', zip: '999 81', city: 'Fiktívna Ves' })
  const DPD_PS = { name: 'DPD Pickup Fiktívna Ves – Kvetinárstvo', street: 'Kvetná 7', zip: '999 81', city: 'Fiktívna Ves' }
  s.dhlExpress({ key: 't1', number: JJD(1), sender: 'FAKE SECURITY KEYS LTD (United Kingdom)', shipped: 'D1 10:00', etaText: 'Wednesday, 4 November 2026', duty: { at: 'D2 08:30', amount: '23,10 EUR', due: '03.11.2026' }, delivered: 'D3 13:05', signedBy: 'BEZPECNY', label: 'hardware keys from the UK (DHL Express, email only)' })
  s.shopSk({ at: 'D2 14:00', shop: 'Kľúčovňa', from: 'Kľúčovňa <eshop@klucovna.example.sk>', subject: 'Objednávka K-3001 bola odoslaná', order: 'K-3001', carrierLine: 'Doprava: Packeta – Z-BOX Fiktívna Ves, Jarná 1 (COOP)', numberLine: `Číslo zásielky: ${spaced(Z(2))}`, items: ['Kryt na webkameru x3'], about: 't2 Packeta Z-BOX' })
  s.packeta({ key: 't2', number: Z(2), sender: 'Kľúčovňa s.r.o.', place: ZB, code: '551208', accepted: 'D2 18:00', ready: 'D4 08:10', label: 'webcam covers (Z-BOX)' })
  s.plain({ at: 'D3 09:00', from: 'GitHub <noreply@github.example.com>', subject: '[fake-org/infra] Dependabot alert: 3 vulnerable dependencies', html: false, about: 'work noise (not labelled)', lines: ['3 new alerts in fake-org/infra.'] })
  s.plain({ at: 'D5 07:30', from: 'Packeta <bezpecnost@packeta-overenie.example.com>', subject: 'Overte svoju zásielku – posledná výzva', about: 'PHISHING look-alike (labelled)', lines: ['Dobrý deň,', 'vaša zásielka nemohla byť doručená. Overte adresu a uhraďte 0,99 €: https://packeta-overenie.example.com/', 'Packeta'] })
  s.shopSk({ at: 'D6 10:00', shop: 'Elektro Svet', from: 'Elektro Svet <objednavky@elektrosvet.example.sk>', subject: 'Objednávka č. 2026110301 bola odoslaná', order: '2026110301', carrierLine: 'Prepravca: GLS (kuriér na adresu)', numberLine: `Číslo balíka: ${GLS(3)}`, items: ['USB hub', 'Ethernet kábel 5 m'], about: 't3 GLS courier' })
  s.gls({ key: 't3', number: GLS(3), sender: 'Elektro Svet', accepted: 'D6 12:00', delivered: 'D7 11:30' })
  s.shopSk({ at: 'D8 09:00', shop: 'Počítače Fiktív', from: 'Počítače Fiktív <eshop@pocitacefiktiv.example.sk>', subject: 'Vaša objednávka P-8812 bola odoslaná', order: 'P-8812', carrierLine: 'Prepravca: DPD Pickup – Kvetinárstvo, Kvetná 7', numberLine: `Číslo zásielky DPD: ${DPD(4)}`, items: ['SSD 1 TB'], about: 't4 DPD Pickup point' })
  s.dpdStation({ key: 't4', number: DPD(4), sender: 'Pocitace Fiktiv s.r.o. # P-8812', shipped: 'D8 11:00', ready: 'D9 14:00', station: DPD_PS, pin: '300417', keep: 7, label: 'SSD (DPD Pickup point)' })
  s.postaHome({ key: 't5', number: EB(5), posted: 'D10 09:00', delivered: 'D11 11:00', label: 'small item, posta to the door' })
  s.shopSk({ at: 'D10 09:30', shop: 'Zámky Online', from: 'Zámky Online <eshop@zamkyonline.example.sk>', subject: 'Objednávka Z-120 bola odoslaná', order: 'Z-120', carrierLine: 'Slovenská pošta – doporučene na adresu', numberLine: `Podacie číslo: ${EB(5)}`, items: ['Lockpick set (tréningový)'], about: 't5 posta dispatch' })
  s.plain({ at: 'D12 08:00', from: 'Security Weekly <newsletter@secweekly.example.com>', subject: 'This week: supply-chain attacks on auto-updaters', lang: 'en', html: false, about: 'newsletter (not labelled)', lines: ['This week: supply-chain attacks on auto-updaters.'] })
  return s
}
