# Sources for the fake corpus

The best evidence of real template **structure** is the scrubbed real mail already in this repo
(`test/fixtures/mail/`): Packeta accepted / ready / Z-BOX-next-day, DPD Pickup Station (html-only base64,
and multipart/mixed with a PNG), GLS ready-for-pickup (html-only, from `noreply@gls-slovakia.sk`), SPS
(windows-1250, number in the subject, the CSS leaking into the text part), and MTBIKER's dispatch mail
naming a GLS ParcelShop. The fake templates (`scripts/dev/fake-mail/templates.mjs`) copy their layouts:
Packeta's one-digit-per-line Z-BOX code and its "Miesto, kde je/bude vaša zásielka uložená" block, DPD's
"Odosielateľ: … Číslo balíka: …" row and "Adresa samoobslužného boxu Pickup Station:" block, GLS's
"Číslo balíka:" / "Odberné miesto:" bullets with "PIN kód", SPS's "vaša zásielka cislo … je pripravená na
vyzdvihnutie v odbernom mieste BALÍKOVO … Verifikačný kód".

Public web research (2026-10-30) gave wording and process facts, but none of it gave verbatim templates;
public pages describe the notices rather than reproduce them. What each source contributed:

| Topic | Source | Used for |
|---|---|---|
| Packeta Z-BOX 6-digit code by email/app/SMS, keypads | https://touchit.sk/packeta-uz-umoznuje-vyber-zasielky-aj-bez-mobilu/636553/ , https://www.svetandroida.cz/zasilkovna-balicek-vyzvednuti-z-box-bez-mobilu , https://developers.packeta.com/z-box-keypad-available-now/ | 6-digit codes, codes with leading zeros |
| Packeta "Hlásime zmenu doručenia – Z-BOX je plný, doručujeme do iného boxu" | https://touchit.sk/packeta-zmena-dorucenia/886545/ | subject of mail 33 (pickup-point change) |
| Packeta phishing ("zásielka čaká v depe", pay a fee) | https://touchit.sk/zasielkovana-podvod/480489/ | mail 76 |
| Packeta storage time 5–7 days | https://www.noviny.sk/slovensko/1003325-vianocne-darceky-na-poslednu-chvilu-riskujete-alebo-mate-plan | deadlines |
| DPD Predict: 1-hour window on the delivery day, change via presmeruj.mojbalik.sk | https://sita.sk/dpd-prinieslo-jedinecnu-novinku-na-trhu-kurierskych-sluzieb/ , https://podnikam.sk/?p=114856 | mails 16, 23, 24 |
| DPD PIN sent by email/SMS before pickup | https://www.noviny.sk/slovensko/550962-dpd-zjednodusila-dorucovanie-zasielok-zakaznikom-staci-pin-kod , https://www.dpd.com/si/en/best-delivery-options/ | mail 43 |
| DPD Pickup network in Slovakia | https://www.teraz.sk/ekonomika/dpd-vyrazne-rozsiruje-siet-odbernych/577324-clanok.html | mail 09 (promo) |
| GLS FlexDelivery: email on dispatch, second email on arrival with the day, links to change delivery / ParcelShop / ParcelLocker | https://gls-group.com/SK/en/services-for-recipients/parcel-delivery-services/ | mails 12, 18 |
| GLS SK number lengths (aggregators disagree: 6–13 digits) | https://ship24.com/couriers/gls-tracking/gls-sk , https://www.4tracking.net/carriers/gls-slovakia | 11- and 12-digit numbers |
| SPS balíkovo = partner shops and self-service boxes; SPS often only calls on arrival | https://www.crz.gov.sk//data/att/602992_dokument1.pdf , https://eu.community.samsung.com/t5/samsung-shop/dorucovanie-zasielok-cez-sps/m-p/9630860/highlight/true | mails 28, 46 |
| Slovenská pošta electronic notice of a stored item (SMS/email, released against the tracking number + ID); "never asks for fees by email" | https://www.noviny.sk/slovensko/158215-oznamenie-o-zasielke-mozete-dostavat-na-mobil , https://spectator.sme.sk/business/c/post-office-will-send-sms-and-email-notifications , https://sita.sk/na-podvodne-maily-nereagujte-slovenska-posta-vyzyva-svojich-klientov-k-ostrazitosti/ | mails 01, 37, 64 |
| Slovenská pošta BalíkoBOX: SMS/email with access PIN, location and deadline (2–3 days) | https://sita.sk/postove-balikoboxy-rozsiruju-siet-na-slovensku-a-prinasaju-viacero-vyhod-pre-zakaznikov/ , https://touchit.sk/zlty-listok-konci-slovenska-posta-umozni-vyzdvihnut-doporucene-zasielky-aj-cez-balikobox/877295/ | mail 44 |
| Slovenská pošta delivers some inbound DHL/foreign parcels; customs-fee scams | https://www.dhl.com/sk-en/home/customer-service/dhl-ecommerce-tracking-faq.html , https://spectator.sme.sk/business/c/received-an-e-mail-from-post-office-requiring-for-customs-clearance-fee-its-a-scam | mail 57 (foreign S10 number) |
| DHL Express waybills: 10 digits typical; JD/JJD piece ids; numbers recycled | https://mydhl.express.dhl/fi/en/help-and-support/faqs/tracking-monitoring.html , https://www.ship24.com/couriers/dhl-tracking/dhl-awb-tracking | mails 35, 52 |
| DHL eCommerce parcels to SK delivered by Express One | https://www.dhl.com/sk-en/home/customer-service/dhl-ecommerce-tracking-faq.html | mail 56 (unknown carrier) |
| AlzaBox: code by SMS/email; carriers delivering into AlzaBoxes | https://cc.cz/jeden-alzabox-vladne-vsem-baliky-do-nej-uz-dorucuji-ppl-zasilkovna-ceska-posta-gls-dpd-wedo-i-dhl/ , https://www.letemsvetemapplem.eu/sk/2023/07/18/alza-cz-rozsiruje-sluzbu-do-pulnoci-objednas-rano-v-alzaboxu-mas-na-cele-cesko/ | mail 65 |
| AliExpress / Cainiao tracking formats | https://www.ship24.com/cs/obchody/aliexpress-sledovani/aliexpress-tracking-number | mail 54 |

Everything personal in the corpus is invented: names (Jana Testová, Peter Testový), towns (Testovo,
Testovice, Fiktívne Mesto), streets, phones (0905 111 222 …), orders and tracking numbers.
