# eva: operator overview (generated - SPOILERS, never show this to the persona agent)

Eva Cestovná, Fiktívne Mesto. Day 0 = 2026-11-01. 8 carrier parcels in the world, 40 mails (36 match gmail-filter.xml and reach the app's label, 5 only appear after a `sim collect`, 6 are conditional). Away days: 3, 4, 5, 6, 10, 11, 12.

## Mails

| id | when | from | subject | label | purpose |
|---|---|---|---|---|---|
| m01 | D-1 12:00 | Kancelária Plus <eshop@kancelariaplus.example.sk> | Objednávka KP-4410 bola odoslaná | yes | e1 Z-BOX, ready day 1 |
| m02 | D-1 17:08 | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola prijatá do prepravy | yes | e1: Packeta accepted |
| m03 | D1 09:04 | Packeta Slovakia <noreply@packeta.sk> | Zásielka je pripravená na vyzdvihnutie | yes | e1: Packeta ready, code 120934, until 09.11.2026 |
| m07 | D1 18:00 | Cestovka Fiktív <rezervacie@cestovka.example.sk> | Potvrdenie rezervácie: Hotel Fiktív Košice, 4.–7. 11. | **no** | travel (not labelled) |
| m08 | D1 20:00 | Diskont Online <eshop@diskont.example.sk> | Objednávka D-50071 bola odoslaná | yes | e2 BalíkoBOX ready while away (3 days) -> EXPIRES |
| m11 | D2 08:00 | Šport Fiktív <eshop@sportfiktiv.example.sk> | Objednávka S-221 bola odoslaná | yes | e3 Z-BOX ready while away, deadline day 11 (collect days 7-9) |
| m12 | D2 15:08 | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola prijatá do prepravy | yes | e3: Packeta accepted |
| m09 | D3 10:25 | Slovenská pošta <notifikacie@posta.sk> | Zásielka EB999999029SK je uložená v BalíkoBOXe | yes | e2: posta stored, until 07.11.2026 23:59 |
| m17 | D3 11:00 | Elektro Svet <objednavky@elektrosvet.example.sk> | Objednávka č. 2026110455 bola odoslaná | yes | e4 DPD courier while away: failed attempt, then delivered day 8 |
| m22 | D3 16:00 | Kozmetika Jasmín <eshop@jasmin.example.sk> | Vaša objednávka J-778 bola odoslaná | yes | e5 GLS ParcelShop ready while away, deadline day 10 (collect days 7-9) |
| m23 | D3 18:20 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90999999905 sme prevzali od odosielateľa | yes | e5: GLS accepted |
| m42 | D4 07:00 | Firma Fiktív – interné <intranet@firmafiktiv.example.sk> | Týždenný report predaja | **no** | work (not labelled) |
| m13 | D4 08:04 | Packeta Slovakia <noreply@packeta.sk> | Zásielka je pripravená na vyzdvihnutie | yes | e3: Packeta ready, code 405519, until 12.11.2026 |
| m18 | D5 07:25 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bude doručená dnes | yes | e4: DPD Predict for day 5 |
| m10 | D5 10:00 (if not collected) | Slovenská pošta <notifikacie@posta.sk> | Pripomienka: zásielka EB999999029SK čaká na pošte | yes | e2: posta reminder 1 days before (only if not collected) |
| m19 | D5 10:42 | "DPD" <no_reply@dpd.sk> | Neúspešný pokus o doručenie zásielky | yes | e4: failed attempt (nobody home) |
| m24 | D5 11:07 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90999999905 je pripravený k vyzdvihnutiu | yes | e5: GLS ready, PIN 662014, until 11. 11. 2026 |
| m27 | D6 20:00 | Cestovka Fiktív <rezervacie@cestovka.example.sk> | Ďakujeme za pobyt v Hoteli Fiktív | **no** | travel (not labelled) |
| m04 | D7 10:00 (if not collected) | Packeta Slovakia <noreply@packeta.sk> | Pripomíname: zásielka na vás čaká v Z-BOXe | yes | e1: reminder, day before the deadline (only if not collected) |
| m20 | D8 07:25 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bude doručená dnes | yes | e4: DPD Predict for day 8 |
| m29 | D8 10:00 | Knihomoľ <info@knihomol.example.sk> | Vaša objednávka č. 2026110601 bola odoslaná | yes | e6 SPS balíkovo ready day 9, deadline day 12 18:00: only day 9 works |
| m21 | D8 17:22 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bola doručená | yes | e4: delivered to the door |
| m28 | D8 18:00 | Cestovka Fiktív <rezervacie@cestovka.example.sk> | Potvrdenie rezervácie: Hotel Fiktív Žilina, 11.–13. 11. | **no** | travel (not labelled) |
| m30 | D9 09:10 | serv@sps-sro.sk | Zasielka v odbernom mieste balikovo: SK0FAKE26EVAC00006 | yes | e6: SPS ready at balíkovo, code 240117 |
| m06 | D9 09:30 (if not collected) | Packeta Slovakia <noreply@packeta.sk> | Zásielka bude vrátená odosielateľovi | yes | e1: not collected in time, returning |
| m25 | D9 10:00 (if not collected) | GLS Slovakia <noreply@gls-slovakia.sk> | Posledná možnosť vyzdvihnúť balík 90999999905 | yes | e5: GLS last-chance reminder (only if not collected) |
| m32 | D9 15:00 | Čajovňa Lístok <predaj@listok.example.sk> | Objednávka L-90 bola odoslaná | yes | e7 výdajné miesto ready while away (day 11), deadline after day 14 |
| m33 | D9 18:08 | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola prijatá do prepravy | yes | e7: Packeta accepted |
| m14 | D10 10:00 (if not collected) | Packeta Slovakia <noreply@packeta.sk> | Pripomíname: zásielka na vás čaká v Z-BOXe | yes | e3: reminder, day before the deadline (only if not collected) |
| m41 | D11 09:10 | Packeta <dorucenie@packeta-zasielky.example.com> | Vaša zásielka nemohla byť doručená – potvrďte adresu | yes | PHISHING look-alike Packeta while she is away (labelled) |
| m34 | D11 10:04 | Packeta Slovakia <noreply@packeta.sk> | Zásielka je pripravená na vyzdvihnutie | yes | e7: Packeta ready, until 19.11.2026 |
| m38 | D12 09:00 | Domov a Záhrada <eshop@domovzahrada.example.sk> | Objednávka DZ-31 bola odoslaná | yes | e8 DPD courier on Saturday day 13 (home) |
| m16 | D12 09:30 (if not collected) | Packeta Slovakia <noreply@packeta.sk> | Zásielka bude vrátená odosielateľovi | yes | e3: not collected in time, returning |
| m39 | D13 07:25 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bude doručená dnes | yes | e8: DPD Predict for day 13 |
| m40 | D13 10:32 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bola doručená | yes | e8: delivered to the door |
| m05 | after collect e1 +6m | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola vyzdvihnutá | yes | e1: picked-up confirmation (after sim collect) |
| m15 | after collect e3 +6m | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola vyzdvihnutá | yes | e3: picked-up confirmation (after sim collect) |
| m26 | after collect e5 +8m | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90999999905 bol doručený | yes | e5: GLS collected |
| m31 | after collect e6 +15m | serv@sps-sro.sk | Zasielka SK0FAKE26EVAC00006 bola dorucena | yes | e6: SPS collected |
| m36 | after collect e7 +6m | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola vyzdvihnutá | yes | e7: picked-up confirmation (after sim collect) |

## Parcels (carrier side)

| key | carrier | number | what | ready | where | code | deadline |
|---|---|---|---|---|---|---|---|
| e1 | packeta | Z9999999901 | diary (Z-BOX) | D1 09:00 | Z-BOX Fiktívne Mesto, Nábrežná 9 (Lidl) | 120934 | D8 23:59 |
| e2 | posta | EB999999029SK | thermos (BalíkoBOX, ready while away, expires) | D3 10:00 | BalíkoBOX Fiktívne Mesto – stanica | 778102 | D6 23:59 |
| e3 | packeta | Z9999999903 | gloves (Z-BOX, ready while away) | D4 08:00 | Z-BOX Fiktívne Mesto, Nábrežná 9 (Lidl) | 405519 | D11 23:59 |
| e4 | dpd | 01505999999904 | Elektro Svet # 2026110455 via DPD (door) | delivered |  |  |  |
| e5 | gls | 90999999905 | face cream (GLS ParcelShop, ready while away) | D5 11:00 | GLS ParcelShop Čistiareň Biela | 662014 | D10 23:59 |
| e6 | sps | SK0FAKE26EVAC00006 | book (SPS balíkovo, tight) | D9 09:00 | BALÍKOVO Fiktívne Mesto – Trafika na rohu | 240117 | D12 18:00 |
| e7 | packeta | Z9999999907 | tea (výdajné miesto, ready while away) | D11 10:00 | Kvetinárstvo Ruža – výdajné miesto Packeta |  | D18 23:59 |
| e8 | dpd | 01505999999908 | Domov a Zahrada # DZ-31 via DPD (door) | delivered |  |  |  |
