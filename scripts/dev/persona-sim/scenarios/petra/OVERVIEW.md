# petra: operator overview (generated - SPOILERS, never show this to the persona agent)

Petra Smyšlená, Testovce. Day 0 = 2026-11-01. 13 carrier parcels in the world, 51 mails (43 match gmail-filter.xml and reach the app's label, 8 only appear after a `sim collect`, 6 are conditional).

## Mails

| id | when | from | subject | label | purpose |
|---|---|---|---|---|---|
| m01 | D-1 21:10 | Alza.sk <objednavky@alza.example.sk> | Potvrdenie objednávky 1051500001 | **no** | Alza confirmation (not labelled) |
| m05 | D0 20:05 | Notino <objednavky@notino.example.sk> | Ďakujeme za objednávku 26-880101 | **no** | Notino confirmation (not labelled) |
| m06 | D1 11:30 | Notino <objednavky@notino.example.sk> | Vaša objednávka 26-880101 bola odoslaná | yes | p02 Notino dispatch |
| m07 | D1 19:08 | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola prijatá do prepravy | yes | p02: Packeta accepted |
| m12 | D2 09:00 | Bambulka – detská móda <obchod@bambulka.example.sk> | Objednávka č. B-2207 bola odoslaná | yes | p03 kids clothes via SPS balíkovo |
| m15 | D2 10:10 | Topánočky <info@topanocky.example.sk> | Vaša objednávka T-9001 bola odoslaná | yes | p04 kids shoes via DPD station (later returned) |
| m20 | D2 12:00 | ZŠ Testovce <skola@zstestovce.example.sk> | Rodičovské združenie vo štvrtok | **no** | school (not labelled) |
| m02 | D2 16:03 | Alza.sk <objednavky@alza.example.sk> | Objednávka 1051500001 je pripravená na vyzdvihnutie v AlzaBoxe | yes | p01: AlzaBox ready, code 557120, until 06.11.2026 (Alza's own delivery: no carrier, no tracking number) |
| m16 | D2 16:30 | "DPD" <no_reply@dpd.sk> | Vaša zásielka je na ceste do Pickup Station | yes | p04: DPD on its way to the station |
| m08 | D3 09:14 | Packeta Slovakia <noreply@packeta.sk> | Zásielka je pripravená na vyzdvihnutie | yes | p02: Packeta ready, code 341208, until 11.11.2026 |
| m17 | D3 11:36 | "DPD" <no_reply@dpd.sk> | Informácia o uložení zásielky v samoobslužnom boxe Pickup Station | yes | p04: DPD station ready, PIN 610045, until 11.11.2026 |
| m13 | D3 13:10 | serv@sps-sro.sk | Zasielka v odbernom mieste balikovo: SK0FAKE26PETR00003 | yes | p03: SPS ready at balíkovo, code 774421 |
| m24 | D4 08:30 | Alza.sk <objednavky@alza.example.sk> | Objednávka 1051500006 bola odoslaná | yes | p06 Alza via GLS courier |
| m25 | D4 10:20 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90555555506 sme prevzali od odosielateľa | yes | p06: GLS accepted |
| m28 | D4 15:00 | Notino <objednavky@notino.example.sk> | Vaša objednávka 26-880133 bola odoslaná | yes | p07 Notino #2 via GLS ParcelShop |
| m29 | D4 18:20 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90555555507 sme prevzali od odosielateľa | yes | p07: GLS accepted |
| m33 | D5 07:00 | Alza.sk <newsletter@alza.example.sk> | Black Friday v Alze začína už teraz | **no** | Alza newsletter (not labelled) |
| m26 | D5 07:10 | GLS Slovakia <noreply@gls-slovakia.sk> | Váš balík 90555555506 je na ceste | yes | p06: GLS out for delivery today |
| m03 | D5 09:00 (if not collected) | Alza.sk <objednavky@alza.example.sk> | Posledný deň na vyzdvihnutie objednávky 1051500001 | yes | p01: AlzaBox last day (only if not collected) |
| m21 | D5 09:20 | Topánočky <info@topanocky.example.sk> | Vrátenie tovaru k objednávke T-9001 | **no** | return instructions with the Packeta return number (labelled? subject has no shipping word) |
| m27 | D5 10:24 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90555555506 bol doručený | yes | p06: GLS delivered to the door |
| m22 | D6 10:05 | Packeta Slovakia <noreply@packeta.sk> | Zásielka Z 555 5555 505 bola podaná | yes | p05: return parcel handed in (persona is the SENDER) |
| m30 | D6 10:07 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90555555507 je pripravený k vyzdvihnutiu | yes | p07: GLS ready, PIN 228801, until 14. 11. 2026 |
| m34 | D7 18:00 | Diskont Online <eshop@diskont.example.sk> | Objednávka D-44120 bola odoslaná | yes | p08 posta BalíkoBOX, 3 days |
| m37 | D8 09:00 | Bambulka – detská móda <obchod@bambulka.example.sk> | Objednávka č. B-2231 bola odoslaná | yes | p09 Bambulka #2 via SPS courier |
| m35 | D8 12:25 | Slovenská pošta <notifikacie@posta.sk> | Zásielka EB555555082SK je uložená v BalíkoBOXe | yes | p08: posta stored, until 12.11.2026 23:59 |
| m23 | D8 14:06 | Packeta Slovakia <noreply@packeta.sk> | Zásielka Z 555 5555 505 bola doručená príjemcovi | yes | p05: return delivered to the shop |
| m39 | D8 20:00 | Notino <objednavky@notino.example.sk> | Vaša objednávka 26-880190 bola odoslaná | yes | p10 Notino #3 |
| m45 | D9 07:30 | Hračky Kocúrik <eshop@kocurik.example.sk> | Vaša objednávka K-7781 bola rozdelená a odoslaná | yes | p11 + p12: one mail, two carriers |
| m38 | D9 07:40 | serv@sps-sro.sk | Doručenie zásielky 7035555555555509 dnes | yes | p09: SPS courier today |
| m40 | D9 08:08 | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola prijatá do prepravy | yes | p10: Packeta accepted |
| m18 | D9 09:00 (if not collected) | "DPD" <no_reply@dpd.sk> | Informácia o uložení zásielky v samoobslužnom boxe Pickup Station | yes | p04: DPD station reminder (same subject, only if not collected) |
| m09 | D9 10:00 (if not collected) | Packeta Slovakia <noreply@packeta.sk> | Pripomíname: zásielka na vás čaká v Z-BOXe | yes | p02: reminder, day before the deadline (only if not collected) |
| m46 | D9 10:08 | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola prijatá do prepravy | yes | p11: Packeta accepted |
| m51 | D10 07:25 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bude doručená dnes | yes | p12: DPD Predict for day 10 |
| m41 | D10 08:34 | Packeta Slovakia <noreply@packeta.sk> | Zásielka je pripravená na vyzdvihnutie | yes | p10: Packeta ready, code 902114, until 18.11.2026 |
| m47 | D10 09:44 | Packeta Slovakia <noreply@packeta.sk> | Zásielka je pripravená na vyzdvihnutie | yes | p11: Packeta ready, code 117395, until 18.11.2026 |
| m36 | D10 10:00 (if not collected) | Slovenská pošta <notifikacie@posta.sk> | Pripomienka: zásielka EB555555082SK čaká na pošte | yes | p08: posta reminder 1 days before (only if not collected) |
| m52 | D10 11:17 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bola doručená | yes | p12: delivered to the door |
| m11 | D11 09:30 (if not collected) | Packeta Slovakia <noreply@packeta.sk> | Zásielka bude vrátená odosielateľovi | yes | p02: not collected in time, returning |
| m53 | D11 18:30 | Hračky Kocúrik <eshop@kocurik.example.sk> | Ako ste boli spokojná s nákupom? | **no** | review request (not labelled) |
| m31 | D12 10:00 (if not collected) | GLS Slovakia <noreply@gls-slovakia.sk> | Posledná možnosť vyzdvihnúť balík 90555555507 | yes | p07: GLS last-chance reminder (only if not collected) |
| m54 | D12 17:33 | Alza.sk <objednavky@alza.example.sk> | Objednávka 1051500013 je pripravená na vyzdvihnutie v AlzaBoxe | yes | p13: AlzaBox ready, code 803366, until 16.11.2026 (Alza's own delivery: no carrier, no tracking number) |
| m04 | after collect p01 +2m | Alza.sk <objednavky@alza.example.sk> | Objednávka 1051500001 bola vyzdvihnutá | **no** | p01: AlzaBox collected |
| m10 | after collect p02 +6m | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola vyzdvihnutá | yes | p02: picked-up confirmation (after sim collect) |
| m14 | after collect p03 +15m | serv@sps-sro.sk | Zasielka SK0FAKE26PETR00003 bola dorucena | yes | p03: SPS collected |
| m19 | after collect p04 +5m | "DPD" <no_reply@dpd.sk> | Vaša zásielka bola doručená | yes | p04: DPD collected confirmation |
| m32 | after collect p07 +8m | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90555555507 bol doručený | yes | p07: GLS collected |
| m43 | after collect p10 +6m | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola vyzdvihnutá | yes | p10: picked-up confirmation (after sim collect) |
| m49 | after collect p11 +6m | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola vyzdvihnutá | yes | p11: picked-up confirmation (after sim collect) |
| m56 | after collect p13 +2m | Alza.sk <objednavky@alza.example.sk> | Objednávka 1051500013 bola vyzdvihnutá | **no** | p13: AlzaBox collected |

## Parcels (carrier side)

| key | carrier | number | what | ready | where | code | deadline |
|---|---|---|---|---|---|---|---|
| p01 | alza | ALZA1051500001 | Alza #1 AlzaBox | D2 16:00 | AlzaBox Testovce – Tesco | 557120 | D5 23:59 |
| p02 | packeta | Z5555555502 | Notino #1 | D3 09:10 | Z-BOX Testovce, Školská 2 (ZŠ) | 341208 | D10 23:59 |
| p03 | sps | SK0FAKE26PETR00003 | Bambulka #1 (balíkovo) | D3 13:00 | BALÍKOVO Testovce – Potraviny Jednota | 774421 | D8 18:00 |
| p04 | dpd | 01505555555504 | kids shoes (to be returned) | D3 11:30 | Pickup Station Testovce (Tesco) | 610045 | D10 23:59 |
| p05 | packeta | Z5555555505 | RETURN of the shoes (Petra sends it) | delivered |  |  |  |
| p06 | gls | 90555555506 | Alza.sk via GLS (door) | delivered |  |  |  |
| p07 | gls | 90555555507 | Notino #2 (GLS ParcelShop) | D6 10:00 | GLS ParcelShop Drogéria Kvietok | 228801 | D13 23:59 |
| p08 | posta | EB555555082SK | Diskont (BalíkoBOX, 3 days) | D8 12:00 | BalíkoBOX Testovce – Pošta | 450091 | D11 23:59 |
| p09 | sps | 7035555555555509 | Bambulka via SPS (door) | delivered |  |  |  |
| p10 | packeta | Z5555555510 | Notino #3 | D10 08:30 | Z-BOX Testovce, Školská 2 (ZŠ) | 902114 | D17 23:59 |
| p11 | packeta | Z5555555511 | Kocúrik blocks (same Z-BOX, same day as p10) | D10 09:40 | Z-BOX Testovce, Školská 2 (ZŠ) | 117395 | D17 23:59 |
| p12 | dpd | 01505555555512 | Hračky Kocúrik # K-7781 via DPD (door) | delivered |  |  |  |
| p13 | alza | ALZA1051500013 | Alza #3 AlzaBox | D12 17:30 | AlzaBox Testovce – Tesco | 803366 | D15 23:59 |
