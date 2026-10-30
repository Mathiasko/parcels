// lucia: a Slovak student in Brno. Czech shops and Czech wording, Zásilkovna Z-BOX and výdejní místo,
// a PPL parcel, a Vinted parcel, irregular orders - and a parcel for her flatmate Klára, who used Lucia's
// e-mail address, so Lucia gets the carrier's mail but never saw an order.
import { Scenario, spaced, htmlShell } from '../kit/dsl.mjs'

export default function lucia() {
  const s = new Scenario({
    id: 'lucia', fullName: 'Lucia Vymyslená', email: 'lucia.vymyslena@example.cz', digit: '7',
    day0: '2026-11-01', postcode: '99950', town: 'Brno',
  })
  const { Z, GLS } = s.n
  const ZB = s.point({ name: 'Z-BOX Brno, Smyšlená 12 (Albert)', street: 'Smyšlená 12', zip: '999 50', city: 'Brno' })
  const VM = s.point({ name: 'Trafika U Fiktivního parku – výdejní místo', street: 'Parková 3', zip: '999 50', city: 'Brno', hours: 'shop' })
  s.shopCz({ at: 'D2 10:00', shop: 'Knihkupectví Příkladné', from: 'Knihkupectví Příkladné <eshop@knihkupectvi.example.cz>', subject: 'Vaše objednávka č. 2026-4410 byla odeslána', order: '2026-4410', carrierLine: 'Doprava: Zásilkovna – výdejní místo Trafika U Fiktivního parku', numberLine: `Číslo zásilky: ${spaced(Z(1))}`, items: ['Učebnice: Úvod do statistiky'], about: 'l1 Czech shop dispatch ("odeslána": labelled)' })
  s.packeta({ key: 'l1', number: Z(1), sender: 'Knihkupectví Příkladné', place: VM, accepted: 'D2 15:00', ready: 'D4 10:00', keep: 7, lang: 'cz', label: 'statistics textbook (výdejní místo)' })
  s.plain({ at: 'D2 12:00', from: 'Studijní oddělení <studijni@fakulta.example.cz>', subject: 'Zápis na zkouškové období', html: false, about: 'university (not labelled)', lines: ['Vážení studenti,', 'zápis termínů zkoušek se otevírá 16. 11.', 'Studijní oddělení'] })
  s.shopSk({ at: 'D4 09:00', shop: 'Móda Bratislava', from: 'Móda Bratislava <eshop@modaba.example.sk>', subject: 'Objednávka č. MB-1290 bola odoslaná', order: 'MB-1290', carrierLine: 'Doprava: Packeta – Z-BOX Brno, Smyšlená 12 (Albert)', numberLine: `Číslo zásielky: ${spaced(Z(2))}`, items: ['Sveter, veľ. S'], about: 'l2 Slovak shop to her Brno Z-BOX (Slovak dispatch labelled; carrier mails Czech)' })
  s.packeta({ key: 'l2', number: Z(2), sender: 'Móda Bratislava', place: ZB, code: '664210', accepted: 'D4 18:00', ready: 'D7 09:30', keep: 7, lang: 'cz', label: 'sweater (Z-BOX)' })
  s.plain({ at: 'D3 20:00', from: 'Elektro Brno <obchod@elektrobrno.example.cz>', subject: 'Objednávka EB-77120 odeslána', about: 'l5 Czech shop via PPL (unsupported carrier); 11-digit number looks GLS-shaped', lines: ['Dobrý den,', 'vaše objednávka EB-77120 byla předána dopravci PPL.', 'Číslo zásilky PPL: 40777777701', 'Doručení: zítra 8:00–17:00 na adresu', '', 'Elektro Brno'] })
  s.plain({ at: 'D4 07:40', from: 'PPL CZ <info@ppl.example.cz>', subject: 'Dnes vám doručíme zásilku 40777777701', about: 'l5 PPL courier today (not labelled: unknown carrier, Czech words)', lines: ['Dobrý den,', 'zásilku 40777777701 od Elektro Brno vám doručíme dnes mezi 10:00 a 13:00.', 'PPL CZ'] })
  s.plain({ at: 'D4 11:50', from: 'PPL CZ <info@ppl.example.cz>', subject: 'Zásilka 40777777701 byla doručena', about: 'l5 PPL delivered (not labelled)', lines: ['Dobrý den,', 'zásilka 40777777701 byla doručena.', 'PPL CZ'] })
  s.plain({ at: 'D5 18:30', from: 'Vinted <no-reply@vinted.example.cz>', subject: 'Tvůj nákup: Zimní bunda – prodejce odeslal balíček', about: 'l3 Vinted; "balíček" in the subject, so labelled; Zásilkovna number in the body', lines: ['Ahoj Lucie,', 'prodejce odeslal tvůj balíček.', `Sledovací číslo Zásilkovny: ${spaced(Z(3))}`, 'Vinted'] })
  s.packeta({ key: 'l3', number: Z(3), sender: 'Vinted Go', place: ZB, code: '307714', accepted: 'D6 10:00', ready: 'D9 08:40', keep: 7, lang: 'cz', label: 'Vinted jacket (Z-BOX); only the Vinted mail reaches the label' })
  s.packeta({ key: 'l4', number: Z(4), sender: 'Kosmetika Bella', place: VM, accepted: 'D6 14:00', ready: 'D8 11:00', keep: 7, lang: 'cz', owner: 'flatmate', label: "Klára's cosmetics (Lucia's address used)" })
  s.plain({ at: 'D9 13:15', from: 'Klára Smyšlená <klara.smyslena@example.cz>', subject: 'kosmetika', html: false, about: "l4 flatmate asks (not labelled)", lines: ['Lucko, dala jsem omylem tvůj mail u objednávky kosmetiky z Belly :( nepřišlo ti něco ze Zásilkovny? Můžeš mi to prosím vyzvednout, jsem do pátku doma v Olomouci. Díky! K.'] })
  s.plain({ at: 'D7 09:00', from: 'Zásilkovna <novinky@zasilkovna.cz>', subject: 'Nové Z-BOXy ve vašem okolí', about: 'carrier promo from zasilkovna.cz (not labelled)', lines: ['V Brně přibylo 12 nových Z-BOXů.', 'Zásilkovna'] })
  s.plain({ at: 'D10 16:00', from: 'Sportovní Brno <eshop@sportbrno.example.cz>', subject: 'Váš balík je na cestě', about: 'l6 Czech shop, "balík": labelled; GLS courier', lines: ['Dobrý den,', 'váš balík s objednávkou SB-2051 je na cestě přes GLS.', `Číslo balíku: ${GLS(6)}`, 'Sportovní Brno'] })
  s.gls({ key: 'l6', number: GLS(6), sender: 'Sportovní Brno', accepted: 'D10 17:00', delivered: 'D12 12:20', transitWindow: 'dnes medzi 11:00 a 14:00' })
  s.plain({ at: 'D12 08:00', from: 'Vinted <no-reply@vinted.example.cz>', subject: 'Nezapomeň potvrdit, že je vše v pořádku', about: 'Vinted (not labelled)', lines: ['Potvrď převzetí balíčku do 2 dnů.'] })
  return s
}
