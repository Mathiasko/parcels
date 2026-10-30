// Carrier and e-shop mail templates for the fake corpus. Wording and structure follow the real,
// scrubbed fixtures in test/fixtures/mail/ and the sources in test/fixtures/fake-mail/SOURCES.md.
// Every person, address, phone, order and tracking number here is invented.

export const spaced = z => `${z.slice(0, 1)} ${z.slice(1, 4)} ${z.slice(4, 8)} ${z.slice(8)}`   // Z 222 2222 201
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A generic responsive HTML shell, the way ESP templates look: preheader, style block, tables. */
export function htmlShell({ title, preheader = '', brand = '#333', logo = 'Logo', body, footer = '' }) {
  return `<!DOCTYPE html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title>
<style>body{margin:0;padding:0;font-family:Arial,Helvetica,sans-serif}td{font-size:14px;line-height:20px}.btn{background:${brand};color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none}@media only screen and (max-width:600px){.w{width:100%!important}}</style>
</head><body>
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</span>
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f2f2f2"><tr><td align="center">
<table class="w" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff">
<tr><td style="background:${brand};padding:16px;color:#fff;font-size:20px"><img src="https://img.example.com/logo.png" alt="${esc(logo)}" width="120"></td></tr>
<tr><td style="padding:24px">${body}</td></tr>
<tr><td style="padding:16px;color:#888;font-size:11px">${footer}</td></tr>
</table></td></tr></table></body></html>`
}

// ------------------------------------------------------------------------------------------------
// Packeta (packeta.sk). The text part mirrors the real one: table cells flattened into indented lines,
// the Z-BOX code one digit per line, the pickup block under "Miesto, kde je/bude vaša zásielka uložená".
// ------------------------------------------------------------------------------------------------
export function packeta({ kind, number, sender, place, code, deadline, cod, order, newPlace }) {
  const z = spaced(number)
  const zbox = /z-box/i.test(place?.name ?? '')
  const intro = {
    accepted: `odosielateľ\n                        ${sender}\n                    nám práve\n                    odovzdal vašu zásielku,\n                    ktorá vám bude doručená ${zbox ? 'do Z-BOXu' : 'na výdajné miesto'}.`,
    ready: `vaša zásielka od odosielateľa\n                        ${sender}\n                    je pre vás\n                    pripravená na vyzdvihnutie ${zbox ? 'v Z-BOXe' : 'na výdajnom mieste'}.`,
    reminder: `pripomíname, že vaša zásielka od odosielateľa\n                        ${sender}\n                    je pre vás\n                    stále pripravená na vyzdvihnutie ${zbox ? 'v Z-BOXe' : 'na výdajnom mieste'}. Nezabudnite si ju vyzdvihnúť do ${deadline}.`,
    pickedup: `vaša zásielka od odosielateľa ${sender} bola úspešne vyzdvihnutá. Ďakujeme, že ste si vybrali Packetu.`,
    returning: `vaša zásielka od odosielateľa ${sender} nebola vyzdvihnutá v úložnej dobe, a preto ju vraciame odosielateľovi. Ak ste zásielku platili na dobierku, nič neplatíte.`,
    redirected: `ospravedlňujeme sa, vybraný Z-BOX ${place?.name} je momentálne plný. Vašu zásielku ${z} od odosielateľa ${sender} preto doručujeme do iného boxu:\n                    ${newPlace?.name}, ${newPlace?.street}, ${newPlace?.zip} ${newPlace?.city}.\n                    O vložení zásielky vás budeme informovať.`,
  }[kind]
  const block = place && (kind === 'accepted' || kind === 'ready' || kind === 'reminder')
    ? `                Miesto, kde ${kind === 'accepted' ? 'bude' : 'je'} vaša zásielka uložená\n\n\n                            ${place.name}\n\n                                      ${place.street} ${place.zip} ${place.city}\n                                            Zobraziť na mape\n                            Po–Ne 00:00–23:59\n${deadline && kind !== 'accepted' ? `                            Na vyzdvihnutie najneskôr do ${deadline} 23:59.\n` : ''}`
    : ''
  const codeBlock = code && (kind === 'ready' || kind === 'reminder')
    ? `          Kód pre otvorenie schránky\n${[...code].map(d => `                ${d} \n`).join('\n')}`
    : ''
  const pay = cod ? `        Na úhradu pri vyzdvihnutí: ${cod}\n        Platbu kartou alebo v aplikácii.` : '        Zaplatené'
  const text = `Zásielka ${z}\n           \n                    Dobrý deň,\n                    ${intro}\n                             \n${codeBlock}\n${block}\n${kind === 'pickedup' || kind === 'returning' || kind === 'redirected' ? '' : pay}\n                                        Číslo zásielky ${z}\n                                        Sledovať zásielku\n${order ? `                                    Číslo objednávky ${order}\n` : ''}                            Najčastejšie otázky\n                            Kontaktný formulár\n                Ďakujeme, že ste si pre doručenie vašej zásielky vybrali Packetu.\n                S pozdravom\n                tím Packety\n                Tento e-mail sa generuje automaticky a nedá sa naň odpovedať.\n`
  const html = htmlShell({
    title: 'Packeta', brand: '#ba1b02', logo: 'Packeta', preheader: `Zásielka ${z}`,
    body: `<p style="font-size:12px;color:#999">Zásielka ${z}</p><p>Dobrý deň,</p><p>${esc(intro).replace(/\n\s*/g, ' ')}</p>
${code && (kind === 'ready' || kind === 'reminder') ? `<p>Kód pre otvorenie schránky</p><table><tr>${[...code].map(d => `<td style="border:1px solid #ccc;padding:8px 12px;font-size:22px">${d}</td>`).join('')}</tr></table>` : ''}
${block ? `<p><strong>Miesto, kde ${kind === 'accepted' ? 'bude' : 'je'} vaša zásielka uložená</strong></p><table><tr><td>${esc(place.name)}</td></tr><tr><td>${esc(place.street)} ${place.zip} ${esc(place.city)}</td></tr></table>${deadline && kind !== 'accepted' ? `<p>Na vyzdvihnutie najneskôr do ${deadline} 23:59.</p>` : ''}` : ''}
<p>${cod ? `Na úhradu pri vyzdvihnutí: <strong>${cod}</strong>` : 'Zaplatené'}</p>
<p>Číslo zásielky ${z}</p><p><a class="btn" href="https://tracking.packeta.com/sk/?id=${number}">Sledovať zásielku</a></p>${order ? `<p>Číslo objednávky ${order}</p>` : ''}`,
    footer: 'Ďakujeme, že ste si pre doručenie vašej zásielky vybrali Packetu. Tento e-mail sa generuje automaticky.',
  })
  return { text, html }
}

// ------------------------------------------------------------------------------------------------
// DPD Slovakia (dpd.sk): html only, base64, the way the real Pickup Station mails arrive.
// ------------------------------------------------------------------------------------------------
export function dpd({ kind, number, sender, window, pin, deadline, station, numbers, courier, extra = '' }) {
  const sp = '<img src="https://lib4u.dpd.sk/images/NP/spacer.gif" width="1" height="8">'
  const lead = {
    predict: `Vaša zásielka bude doručená dnes v čase <strong>${window}</strong>. Kuriér ${courier?.name ?? ''} vás bude kontaktovať na čísle, ktoré ste uviedli pri objednávke. Kontakt na kuriéra: ${courier?.phone ?? ''}.`,
    transit: 'Vaša zásielka je na ceste. Akonáhle bude pripravená v samoobslužnom boxe Pickup Station, budeme vás informovať.',
    station: 'Vaša zásielka bola uložená v samoobslužnom boxe Pickup Station a je pripravená na vyzdvihnutie.',
    stationReminder: 'Vaša zásielka stále čaká na vyzdvihnutie v samoobslužnom boxe Pickup Station. Jej úložná doba sa blíži ku koncu.',
    delivered: 'Vaša zásielka bola úspešne doručená. Ďakujeme, že ste využili služby DPD.',
    failed: 'Vašu zásielku sa dnes nepodarilo doručiť, pretože sme vás nezastihli na adrese. Ďalší pokus o doručenie uskutočníme nasledujúci pracovný deň. Termín môžete zmeniť na stránke presmeruj.mojbalik.sk.',
    multi: `Vaša objednávka bola rozdelená do ${numbers?.length} balíkov, ktoré vám doručíme spoločne.`,
    promo: '',
    receipt: '',
  }[kind]
  const nums = numbers ?? [number]
  const body = `<table width="100%"><tr><td>Dobrý deň Jana Testová, ${sp} ${lead}</td></tr>
<tr><td>${sp}</td></tr>
<tr><td><table><tr><td>Odosielateľ: ${esc(sender ?? '')}</td><td>&nbsp;&nbsp;</td><td>Číslo balíka: ${nums.join(', ')}</td></tr></table></td></tr>
${station ? `<tr><td>Adresa samoobslužného boxu Pickup Station: ${esc(station.name)},<br>${esc(station.street)},<br>${station.zip} ${esc(station.city)}</td><td>&nbsp;&nbsp;Otváracie hodiny: Pondelok - Nedeľa: 00:01 - 23:59</td></tr>` : ''}
${pin ? `<tr><td>${sp} Pre vyzdvihnutie zásielky použite PIN: <strong>${pin}</strong> ${sp} Vašu zásielku si môžete vyzdvihnúť najneskôr dňa<br>${deadline}</td></tr>` : ''}
${station ? '<tr><td><a href="https://www.dpdgroup.com/">Zobraziť odberné miesto Pickup Station na mape</a></td></tr>' : ''}
${extra}
<tr><td>Dôležitá informácia k doručeniu: Vašu zásielku môže namiesto vás prevziať aj osoba, ktorej poskytnete PIN kód.</td></tr></table>`
  return htmlShell({
    title: 'DPD', brand: '#dc0032', logo: 'DPD', preheader: lead.replace(/<[^>]+>/g, ''), body,
    footer: 'DPD SK s.r.o., Testovská 7, 999 04 Testovo. Infolinka: 02/00 00 00 00. Sledujte nás na sociálnych sieťach. Stiahnite si aplikáciu myDPD.',
  })
}

// ------------------------------------------------------------------------------------------------
// GLS Slovakia (gls-slovakia.sk in the real mailbox): html only, "Číslo balíka:" then the number on its
// own line, "Odberné miesto:" block with `<br>`s, PIN kód.
// ------------------------------------------------------------------------------------------------
export function gls({ kind, number, sender, pin, deadline, point, courier, window }) {
  const lead = {
    accepted: 'Váš balík sme prevzali od odosielateľa a je na ceste k vám. Predpokladaný dátum doručenia vám oznámime v ďalšom e-maile.',
    transit: `Váš balík je na ceste. Doručíme ho ${window ?? 'zajtra'}. Ak vám termín nevyhovuje, môžete ho zmeniť cez FlexDelivery.`,
    ready: `Váš balík sme práve doručili do odberného miesta. Balík si môžete vyzdvihnúť najneskôr dňa ${deadline}. Pre vydanie balíka použite PIN kód ${pin}.`,
    reminder: `Váš balík na vás stále čaká v odbernom mieste. Posledná možnosť vyzdvihnutia je ${deadline}. Pre vydanie balíka použite PIN kód ${pin}.`,
    delivered: 'Váš balík bol úspešne doručený. Ďakujeme, že ste využili služby GLS.',
  }[kind]
  const body = `<p>Dobrý deň,</p><p>${lead}</p>
${courier ? `<p>Kontakt na kuriéra: ${courier}</p>` : ''}
${pin ? `<p style="font-size:18px">PIN kód: ${pin}</p>` : ''}
<table><tr><td><img alt="modrá odrážka" src="https://picture.gls-czech.com/images/emailing/dot--sky-blue.png"> Číslo balíka:<br><strong>${number}</strong></td></tr>
<tr><td><img alt="modrá odrážka" src="https://picture.gls-czech.com/images/emailing/dot--sky-blue.png"> Odosielateľ:<br>${esc(sender)}</td></tr>
${point ? `<tr><td><img alt="modrá odrážka" src="https://picture.gls-czech.com/images/emailing/dot--sky-blue.png"> Odberné miesto:<br><strong>${esc(point.name)},<br>${esc(point.street)},<br>${point.zip}, ${esc(point.city)}</strong></td></tr>` : ''}
</table><p><a class="btn" href="https://gls-group.eu/SK/sk/sledovanie-zasielok.html?match=${number}">Detail zásielky</a></p>
<p>Nenašli ste riešenie vašej situácie? Kontaktujte prosím zákaznícky servis na adrese info@gls-slovakia.sk. Pre rýchlejšie vyriešenie vašej požiadavky uveďte číslo balíka.</p>`
  return htmlShell({ title: 'GLS', brand: '#061ab1', logo: 'logo GLS', preheader: lead, body, footer: 'Na tento e-mail, prosím, neodpovedajte, je generovaný automaticky.' })
}

// ------------------------------------------------------------------------------------------------
// SPS (sps-sro.sk): short, windows-1250, the CSS leaking into the text part exactly like the real one.
// ------------------------------------------------------------------------------------------------
export const SPS_CSS = 'body { font-family: Tahoma, Verdana, Arial, Helvetica, Chicago, Sans-serif; font-size: 12px; margin: 0px; padding: 4px; }p { text-align: justify }tr, td { font-size: 12px; }h1 {color: #ffffff; font-size: 14px; background: #455560; padding: 4px 5px; border-left: 20px solid #f89829; }'
export const SPS_FOOTER = 'Prevádzkovateľom je spoločnosť Slovak Parcel Service s.r.o., IČO: 31 329 217 (ďalej len ako "Prevádzkovateľ"). Prevádzkovateľa môžete kontaktovať na adrese Senecká cesta 1, 900 28 Ivanka pri Dunaji.\n\nS pozdravom,\nkuriérska spoločnosť\nProsím, neodpovedajte na doručenú správu e-mailom, pre kontakt použite informácie na webovej stránke.'
export function sps(sentence) {
  const text = `${SPS_CSS}\nVážený zákazník,\n${sentence}\n\n${SPS_FOOTER}\n`
  const html = `<html><head><style>${SPS_CSS}</style></head><body><div class="obsah"><h1>Slovak Parcel Service</h1><p>Vážený zákazník,</p><p>${esc(sentence)}</p><p>${esc(SPS_FOOTER).replace(/\n/g, '<br>')}</p></div></body></html>`
  return { text, html }
}

// ------------------------------------------------------------------------------------------------
// Slovenská pošta (posta.sk) e-notification: "Oznámenie o uložení zásielky".
// ------------------------------------------------------------------------------------------------
export function posta({ lead, number, office, deadline, cod, pin, extra = '' }) {
  const text = `Slovenská pošta, a. s.\n\nVážená pani / Vážený pán,\n\n${lead}\n\nPodacie číslo: ${number}\n${office ? `Miesto uloženia: ${office.name}\n${office.street}, ${office.zip} ${office.city}\n` : ''}${deadline ? `Zásielka je uložená do: ${deadline}\n` : ''}${cod ? `Suma na úhradu (dobierka): ${cod}\n` : ''}${pin ? `PIN kód na otvorenie schránky: ${pin}\n` : ''}${extra}\nPri preberaní zásielky na pošte predložte doklad totožnosti a uveďte podacie číslo zásielky.\nSlovenská pošta nikdy nežiada platbu poplatkov e-mailom ani SMS správou.\n\nTáto správa bola vygenerovaná automaticky, neodpovedajte na ňu.\nSlovenská pošta, a. s., Poštová 9, 999 99 Testovo\n`
  const html = htmlShell({
    title: 'Slovenská pošta', brand: '#f0b400', logo: 'Slovenská pošta', preheader: lead,
    body: `<p>Vážená pani / Vážený pán,</p><p>${esc(lead)}</p><table>
<tr><td>Podacie číslo:</td><td><strong>${number}</strong></td></tr>
${office ? `<tr><td>Miesto uloženia:</td><td>${esc(office.name)}<br>${esc(office.street)}, ${office.zip} ${esc(office.city)}</td></tr>` : ''}
${deadline ? `<tr><td>Zásielka je uložená do:</td><td>${deadline}</td></tr>` : ''}
${cod ? `<tr><td>Suma na úhradu (dobierka):</td><td>${cod}</td></tr>` : ''}
${pin ? `<tr><td>PIN kód na otvorenie schránky:</td><td><strong>${pin}</strong></td></tr>` : ''}</table>${extra ? `<p>${esc(extra)}</p>` : ''}
<p>Pri preberaní zásielky na pošte predložte doklad totožnosti a uveďte podacie číslo zásielky.</p>`,
    footer: 'Slovenská pošta, a. s., Poštová 9, 999 99 Testovo. Táto správa bola vygenerovaná automaticky.',
  })
  return { text, html }
}

// ------------------------------------------------------------------------------------------------
// DHL Express (dhl.com): English On Demand Delivery mails.
// ------------------------------------------------------------------------------------------------
export function dhl({ lead, number, rows = [] }) {
  const text = `DHL Express\n\n${lead}\n\nWaybill number: ${number}\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nTrack your shipment: https://www.dhl.com/sk-en/home/tracking.html?tracking-id=${number}\n\nThis is an automatically generated email. Please do not reply.\nDHL Express (Slovakia), spol. s r. o.\n`
  const html = htmlShell({
    title: 'DHL Express', brand: '#ffcc00', logo: 'DHL', preheader: lead,
    body: `<p>${esc(lead)}</p><table><tr><td>Waybill number</td><td><strong>${number}</strong></td></tr>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table><p><a class="btn" href="https://www.dhl.com/sk-en/home/tracking.html?tracking-id=${number}">Track shipment</a></p>`,
    footer: 'This is an automatically generated email. Please do not reply. DHL Express (Slovakia), spol. s r. o.',
  })
  return { text, html }
}

/** A Slovak e-shop's "your order was dispatched" mail. */
export function shopDispatch({ shop, greeting = 'Dobrý deň,', order, carrierLine, numberLine, items = [], extra = '', footer = '' }) {
  const text = `${greeting}\n\nvaša objednávka č. ${order} bola práve odoslaná.\n${carrierLine}\n${numberLine}\n\nObsah zásielky:\n${items.map(i => ` - ${i}`).join('\n')}\n${extra}\n\nĎakujeme za nákup!\nTím ${shop}\n${footer}\n`
  const html = htmlShell({
    title: shop, brand: '#2b7a3d', logo: shop, preheader: `Objednávka ${order} je na ceste`,
    body: `<p>${esc(greeting)}</p><p>vaša objednávka č. <strong>${order}</strong> bola práve odoslaná.</p><p>${esc(carrierLine)}</p><p>${esc(numberLine)}</p><table>${items.map(i => `<tr><td>${esc(i)}</td></tr>`).join('')}</table>${extra ? `<p>${esc(extra)}</p>` : ''}`,
    footer: `Ďakujeme za nákup! Tím ${esc(shop)}. ${esc(footer)}`,
  })
  return { text, html }
}
