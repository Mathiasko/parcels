// power: has run the Terminal (git clone + launchd) install for months and now moves into the Mac app.
// ~10 parcels of mixed carriers, including a DHL Express parcel (email-only) and a mail naming two parcels.
import { FROM, Scenario, dpd, spaced } from '../kit/dsl.mjs'

export default function power() {
  const s = new Scenario({
    id: 'power', fullName: 'Peter Mocný', email: 'peter.mocny@example.com', digit: '4',
    day0: '2026-11-01', postcode: '99991', town: 'Fiktívny Hrádok', firstRun: 'move-in', clone: '/Users/peter/parcels',
  })
  const { Z, DPD, GLS, EB, SPS703, JJD } = s.n
  const ZB = s.point({ name: 'Z-BOX Fiktívny Hrádok, Hradná 3 (Billa)', street: 'Hradná 3', zip: '999 91', city: 'Fiktívny Hrádok' })
  const POSTA = { name: 'Pošta Fiktívny Hrádok', street: 'Námestie 1', zip: '999 91', city: 'Fiktívny Hrádok' }
  const GLS_PS = { name: 'GLS ParcelShop Železiarstvo Klinec', street: 'Dielenská 8', zip: '99991', city: 'Fiktívny Hrádok' }
  // ---- history from the Terminal install (already in the label)
  s.plain({ at: 'D-40 10:00', from: 'Packeta Slovakia <noreply@packeta.sk>', subject: 'Zásielka bola vyzdvihnutá', about: 'old: collected 40 days ago', lines: [`Zásielka ${spaced(Z(90))}`, '', 'Dobrý deň,', 'vaša zásielka od odosielateľa Knihomoľ s.r.o. bola úspešne vyzdvihnutá.', 'tím Packety'] })
  s.shopSk({ at: 'D-3 09:00', shop: 'Foto Hrádok', from: 'Foto Hrádok <eshop@fotohradok.example.sk>', subject: 'Objednávka FH-551 bola odoslaná', order: 'FH-551', carrierLine: 'Doprava: Packeta – Z-BOX Fiktívny Hrádok, Hradná 3 (Billa)', numberLine: `Číslo zásielky: ${spaced(Z(1))}`, items: ['Pamäťová karta 128 GB'], about: 'w1 in flight at move-in' })
  s.packeta({ key: 'w1', number: Z(1), sender: 'Foto Hrádok', place: ZB, code: '818203', accepted: 'D-2 16:00', ready: 'D2 08:30', label: 'memory card (Z-BOX)' })
  s.shopEn({ at: 'D-6 04:00', from: 'AliExpress <transaction@notice.aliexpress.example.com>', subject: 'Your order 8194444400000002 has been shipped', hi: 'Peter', order: '8194444400000002', carrier: 'Cainiao → Packeta', number: Z(2), items: ['Soldering tips x10'], eta: 'Nov 3 - Nov 10', about: 'w2 AliExpress with a Packeta number' })
  s.packeta({ key: 'w2', number: Z(2), sender: 'AliExpress (Cainiao)', place: ZB, code: '017466', accepted: 'D0 09:00', ready: 'D2 10:15', label: 'soldering tips (same Z-BOX as w1)' })
  // ---- the 14 days
  s.mail({ at: 'D2 15:00', from: FROM.dpd, subject: 'Vaša zásielka (2 balíky) je na ceste', tag: 'multi', about: 'w3+w4: carrier mail naming TWO parcels', html: dpd({ kind: 'multi', numbers: [DPD(3), DPD(4)], sender: 'Dielňa Pro # DP-2001' }), htmlEncoding: 'base64' })
  s.dpdHome({ key: 'w3', number: DPD(3), sender: 'Dielňa Pro # DP-2001', shipped: 'D2 14:00', delivered: 'D4 11:00', window: '10:30 – 11:30' })
  s.dpdHome({ key: 'w4', number: DPD(4), sender: 'Dielňa Pro # DP-2001', shipped: 'D2 14:00', delivered: 'D4 11:01', window: '10:30 – 11:30' })
  s.shopSk({ at: 'D3 10:00', shop: 'Elektro Svet', from: 'Elektro Svet <objednavky@elektrosvet.example.sk>', subject: 'Objednávka č. 2026110777 bola odoslaná', order: '2026110777', carrierLine: 'Prepravca: GLS (kuriér na adresu)', numberLine: `Číslo balíka: 0${GLS(5)}`, items: ['Multimeter'], about: 'w5 GLS, zero-padded number in the shop mail' })
  s.gls({ key: 'w5', number: GLS(5), sender: 'Elektro Svet', accepted: 'D3 12:00', delivered: 'D5 09:45' })
  s.sps({ key: 'w6', number: SPS703(6), sender: 'Nábytok Domov', shipped: 'D5 10:00', delivered: 'D6 13:30', cod: '89,90 €', phone: '0900 000 404' })
  s.posta({ key: 'w7', number: EB(7), posted: 'D5 08:00', ready: 'D7 10:30', office: POSTA, keep: 10, label: 'registered letter-parcel at the post office' })
  s.dhlExpress({ key: 'w8', number: JJD(8), sender: 'FAKE TOOLS GMBH (Germany)', shipped: 'D8 09:00', etaText: 'Wednesday, 11 November 2026', delivered: 'D10 12:40', signedBy: 'MOCNY', label: 'tools from Germany (DHL Express, email only)' })
  s.shopSk({ at: 'D9 11:00', shop: 'Foto Hrádok', from: 'Foto Hrádok <eshop@fotohradok.example.sk>', subject: 'Objednávka FH-580 bola odoslaná', order: 'FH-580', carrierLine: 'Doprava: Packeta – Z-BOX Fiktívny Hrádok, Hradná 3 (Billa)', numberLine: `Číslo zásielky: ${spaced(Z(9))}`, items: ['Statív'], about: 'w9 Z-BOX' })
  s.packeta({ key: 'w9', number: Z(9), sender: 'Foto Hrádok', place: ZB, code: '302958', accepted: 'D9 17:00', ready: 'D11 08:20', label: 'tripod (Z-BOX)' })
  s.shopSk({ at: 'D10 13:00', shop: 'Železiarstvo Online', from: 'Železiarstvo Online <eshop@zeleziarstvo.example.sk>', subject: 'Objednávka ZO-12 bola odoslaná', order: 'ZO-12', carrierLine: 'Doprava: GLS ParcelShop Železiarstvo Klinec', numberLine: `Číslo balíka: ${GLS(10)}`, items: ['Vrtáky sada'], about: 'w10 GLS ParcelShop' })
  s.gls({ key: 'w10', number: GLS(10), sender: 'Železiarstvo Online', accepted: 'D10 15:00', ready: 'D12 10:30', point: GLS_PS, pin: '914270', keep: 7, label: 'drill bits (GLS ParcelShop)' })
  s.plain({ at: 'D6 09:00', from: 'Hacker News Digest <digest@hn.example.com>', subject: 'Top stories this week', lang: 'en', html: false, about: 'newsletter (not labelled)', lines: ['Top stories.'] })
  return s
}
