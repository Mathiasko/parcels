# martin: operator overview (generated - SPOILERS, never show this to the persona agent)

Martin Pedálový, Kolesovo. Day 0 = 2026-11-01. 22 carrier parcels in the world, 79 mails (65 match gmail-filter.xml and reach the app's label, 4 only appear after a `sim collect`, 4 are conditional).

## Mails

| id | when | from | subject | label | purpose |
|---|---|---|---|---|---|
| m01 | D-2 10:00 | Velo Distribúcia <expedicia@velodistribucia.example.sk> | Potvrdenie objednávky VD-26-1180 | **no** | supplier order confirmation (not labelled) |
| m06 | D0 15:00 | CykloParts GmbH <versand@cykloparts.example.de> | Versandbestätigung / Shipping confirmation CP-77120 | yes | s02 German supplier, English/German, DPD |
| m02 | D1 08:10 | Velo Distribúcia <expedicia@velodistribucia.example.sk> | Objednávka VD-26-1180 bola odoslaná | yes | s01 supplier GLS |
| m09 | D1 09:12 | E-shop platforma <notifikacie@eshopplatforma.example.sk> | Nová objednávka č. 1040 (84,90 €) | **no** | his shop platform: new customer order (not labelled) |
| m03 | D1 09:20 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90666666601 sme prevzali od odosielateľa | yes | s01: GLS accepted |
| m10 | D1 14:40 | E-shop platforma <notifikacie@eshopplatforma.example.sk> | Nová objednávka č. 1041 (23,50 €) | **no** | his shop platform: new customer order (not labelled) |
| m15 | D1 16:08 | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola prijatá do prepravy | yes | r1: Packeta accepted |
| m04 | D2 07:10 | GLS Slovakia <noreply@gls-slovakia.sk> | Váš balík 90666666601 je na ceste | yes | s01: GLS out for delivery today |
| m07 | D2 07:25 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bude doručená dnes | yes | s02: DPD Predict for day 2 |
| m13 | D2 07:30 | Reťaze & Spol. <sklad@retaze.example.sk> | Objednávka R-5521 bola odoslaná | yes | s03 supplier SPS |
| m11 | D2 08:05 | E-shop platforma <notifikacie@eshopplatforma.example.sk> | Nová objednávka č. 1042 (149,00 €) | **no** | his shop platform: new customer order (not labelled) |
| m05 | D2 10:39 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90666666601 bol doručený | yes | s01: GLS delivered to the door |
| m12 | D2 11:00 | Bicykle Fiktív – e-shop <noreply@bicyklefiktiv.example.sk> | Kópia: Vaša objednávka č. 1040 bola odoslaná | yes | o1: COPY of a dispatch mail to HIS customer - the parcel is going OUT (labelled) |
| m20 | D2 13:00 | Brzdy Plus <obchod@brzdyplus.example.sk> | Potvrdenie objednávky BP-0981 | **no** | supplier order confirmation (not labelled) |
| m08 | D2 13:32 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bola doručená | yes | s02: delivered to the door |
| m14 | D3 07:40 | serv@sps-sro.sk | Doručenie zásielky SK0FAKE26MART00003 dnes | yes | s03: SPS courier today |
| m21 | D3 08:00 | Brzdy Plus <obchod@brzdyplus.example.sk> | Objednávka BP-0981 bola odoslaná | yes | s04 supplier GLS |
| m22 | D3 09:20 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90666666604 sme prevzali od odosielateľa | yes | s04: GLS accepted |
| m16 | D3 11:24 | Packeta Slovakia <noreply@packeta.sk> | Zásielka je pripravená na vyzdvihnutie | yes | r1: Packeta ready, until 11.11.2026 |
| m25 | D3 14:00 | CykloParts GmbH <versand@cykloparts.example.de> | Versandbestätigung / Shipping confirmation CP-77158 | yes | s05+s06 one supplier mail naming TWO DPD parcels |
| m30 | D3 19:30 | E-shop platforma <notifikacie@eshopplatforma.example.sk> | Nová objednávka č. 1043 (312,00 €) | **no** | his shop platform: new customer order (not labelled) |
| m23 | D4 07:10 | GLS Slovakia <noreply@gls-slovakia.sk> | Váš balík 90666666604 je na ceste | yes | s04: GLS out for delivery today |
| m31 | D4 09:00 | Velo Distribúcia <expedicia@velodistribucia.example.sk> | Faktúra VD-F-26-0457 | **no** | supplier invoice (not labelled) |
| m32 | D4 10:00 | Reťaze & Spol. <sklad@retaze.example.sk> | Objednávka R-5530 bola odoslaná | yes | s07 supplier SPS 703 with COD |
| m24 | D4 11:49 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90666666604 bol doručený | yes | s04: GLS delivered to the door |
| m26 | D5 07:25 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bude doručená dnes | yes | s05: DPD Predict for day 5 |
| m28 | D5 07:25 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bude doručená dnes | yes | s06: DPD Predict for day 5 |
| m33 | D5 07:40 | serv@sps-sro.sk | Doručenie zásielky 7036666666666607 dnes | yes | s07: SPS courier today |
| m27 | D5 10:17 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bola doručená | yes | s05: delivered to the door |
| m29 | D5 10:18 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bola doručená | yes | s06: delivered to the door |
| m34 | D5 10:30 | Bicykle Fiktív – e-shop <noreply@bicyklefiktiv.example.sk> | Kópia: Vaša objednávka č. 1043 bola odoslaná | yes | o2: COPY of a dispatch mail to HIS customer - the parcel is going OUT (labelled) |
| m35 | D5 16:00 | DPD SK <fakturacia@dpd.sk> | Faktúra za prepravné služby č. 7012001 – október 2026 | yes | CARRIER invoice from dpd.sk: labelled false positive |
| m41 | D5 17:08 | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola prijatá do prepravy | yes | r2: Packeta accepted |
| m36 | D5 18:00 | Pneu Velo CZ <expedice@pneuvelo.example.cz> | Objednávka PV-3310 odeslána | yes | s08 Czech supplier dispatch (labelled via "odeslana") |
| m37 | D6 07:25 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bude doručená dnes | yes | s08: DPD Predict for day 6 |
| m38 | D6 12:42 | "DPD" <no_reply@dpd.sk> | Neúspešný pokus o doručenie zásielky | yes | s08: failed attempt (nobody home) |
| m42 | D7 10:14 | Packeta Slovakia <noreply@packeta.sk> | Zásielka je pripravená na vyzdvihnutie | yes | r2: Packeta ready, until 15.11.2026 |
| m48 | D7 16:00 | Velo Distribúcia <expedicia@velodistribucia.example.sk> | Objednávka VD-26-1201 bola odoslaná | yes | s09 supplier via GLS ParcelShop (pickup) |
| m49 | D7 17:20 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90666666609 sme prevzali od odosielateľa | yes | s09: GLS accepted |
| m46 | D7 21:00 | E-shop platforma <notifikacie@eshopplatforma.example.sk> | Nová objednávka č. 1044 (59,90 €) | **no** | his shop platform: new customer order (not labelled) |
| m39 | D8 07:25 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bude doručená dnes | yes | s08: DPD Predict for day 8 |
| m47 | D8 07:45 | E-shop platforma <notifikacie@eshopplatforma.example.sk> | Nová objednávka č. 1045 (19,90 €) | **no** | his shop platform: new customer order (not labelled) |
| m54 | D8 08:30 | Velo Distribúcia <expedicia@velodistribucia.example.sk> | Objednávka VD-26-1209 bola odoslaná | yes | s10 supplier GLS |
| m55 | D8 10:20 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90666666610 sme prevzali od odosielateľa | yes | s10: GLS accepted |
| m40 | D8 10:32 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bola doručená | yes | s08: delivered to the door |
| m53 | D8 11:00 | Bicykle Fiktív – e-shop <noreply@bicyklefiktiv.example.sk> | Kópia: Vaša objednávka č. 1044 bola odoslaná | yes | o3: COPY of a dispatch mail to HIS customer - the parcel is going OUT (labelled) |
| m50 | D8 13:07 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90666666609 je pripravený k vyzdvihnutiu | yes | s09: GLS ready, PIN 660193, until 16. 11. 2026 |
| m56 | D9 07:10 | GLS Slovakia <noreply@gls-slovakia.sk> | Váš balík 90666666610 je na ceste | yes | s10: GLS out for delivery today |
| m58 | D9 09:00 | CykloParts GmbH <versand@cykloparts.example.de> | Versandbestätigung / Shipping confirmation CP-77201 | yes | s11 German supplier DPD |
| m57 | D9 09:49 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90666666610 bol doručený | yes | s10: GLS delivered to the door |
| m17 | D9 10:00 (if not collected) | Packeta Slovakia <noreply@packeta.sk> | Pripomíname: zásielka na vás čaká na výdajnom mieste | yes | r1: reminder, day before the deadline (only if not collected) |
| m61 | D9 13:00 | Reťaze & Spol. <sklad@retaze.example.sk> | Potvrdenie objednávky R-5560 | **no** | supplier order confirmation (not labelled) |
| m62 | D9 15:00 | Brzdy Plus <obchod@brzdyplus.example.sk> | Faktúra BP-F-0144 | **no** | supplier invoice (not labelled) |
| m70 | D9 17:08 | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola prijatá do prepravy | yes | r3: Packeta accepted |
| m59 | D10 07:25 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bude doručená dnes | yes | s11: DPD Predict for day 10 |
| m63 | D10 08:00 | Reťaze & Spol. <sklad@retaze.example.sk> | Objednávka R-5560 bola odoslaná | yes | s12 supplier SPS |
| m65 | D10 09:00 | Brzdy Plus <obchod@brzdyplus.example.sk> | Objednávka BP-1002 bola odoslaná | yes | s13 supplier GLS |
| m69 | D10 10:00 | Bicykle Fiktív – e-shop <noreply@bicyklefiktiv.example.sk> | Kópia: Vaša objednávka č. 1045 bola odoslaná | yes | o4: COPY of a dispatch mail to HIS customer - the parcel is going OUT (labelled) |
| m66 | D10 10:20 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90666666613 sme prevzali od odosielateľa | yes | s13: GLS accepted |
| m60 | D10 11:22 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bola doručená | yes | s11: delivered to the door |
| m67 | D11 07:10 | GLS Slovakia <noreply@gls-slovakia.sk> | Váš balík 90666666613 je na ceste | yes | s13: GLS out for delivery today |
| m64 | D11 07:40 | serv@sps-sro.sk | Doručenie zásielky SK0FAKE26MART00012 dnes | yes | s12: SPS courier today |
| m19 | D11 09:30 (if not collected) | Packeta Slovakia <noreply@packeta.sk> | Zásielka bude vrátená odosielateľovi | yes | r1: not collected in time, returning |
| m71 | D11 09:34 | Packeta Slovakia <noreply@packeta.sk> | Zásielka je pripravená na vyzdvihnutie | yes | r3: Packeta ready, until 19.11.2026 |
| m75 | D11 12:00 | E-shop platforma <notifikacie@eshopplatforma.example.sk> | Nová objednávka č. 1046 (410,00 €) | **no** | his shop platform: new customer order (not labelled) |
| m76 | D11 13:00 | Pneu Velo CZ <expedice@pneuvelo.example.cz> | Objednávka PV-3355 odeslána | yes | s14 Czech supplier dispatch |
| m68 | D11 14:24 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90666666613 bol doručený | yes | s13: GLS delivered to the door |
| m79 | D11 15:00 | Reťaze & Spol. <sklad@retaze.example.sk> | Objednávka R-5571 bola odoslaná | yes | s15 supplier SPS |
| m77 | D12 07:25 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bude doručená dnes | yes | s14: DPD Predict for day 12 |
| m80 | D12 07:40 | serv@sps-sro.sk | Doručenie zásielky SK0FAKE26MART00015 dnes | yes | s15: SPS courier today |
| m78 | D12 11:02 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bola doručená | yes | s14: delivered to the door |
| m81 | D12 18:10 | E-shop platforma <notifikacie@eshopplatforma.example.sk> | Nová objednávka č. 1047 (35,00 €) | **no** | his shop platform: new customer order (not labelled) |
| m43 | D13 10:00 (if not collected) | Packeta Slovakia <noreply@packeta.sk> | Pripomíname: zásielka na vás čaká na výdajnom mieste | yes | r2: reminder, day before the deadline (only if not collected) |
| m82 | D13 10:00 | E-shop platforma <notifikacie@eshopplatforma.example.sk> | Nová objednávka č. 1048 (88,00 €) | **no** | his shop platform: new customer order (not labelled) |
| m51 | D14 10:00 (if not collected) | GLS Slovakia <noreply@gls-slovakia.sk> | Posledná možnosť vyzdvihnúť balík 90666666609 | yes | s09: GLS last-chance reminder (only if not collected) |
| m18 | after collect r1 +6m | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola vyzdvihnutá | yes | r1: picked-up confirmation (after sim collect) |
| m44 | after collect r2 +6m | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola vyzdvihnutá | yes | r2: picked-up confirmation (after sim collect) |
| m52 | after collect s09 +8m | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90666666609 bol doručený | yes | s09: GLS collected |
| m73 | after collect r3 +6m | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola vyzdvihnutá | yes | r3: picked-up confirmation (after sim collect) |

## Parcels (carrier side)

| key | carrier | number | what | ready | where | code | deadline |
|---|---|---|---|---|---|---|---|
| s01 | gls | 90666666601 | Velo Distribúcia s.r.o. via GLS (door) | delivered |  |  |  |
| s02 | dpd | 01505666666602 | CykloParts GmbH # CP-77120 via DPD (door) | delivered |  |  |  |
| o1 | packeta | Z6666666631 | OUTGOING to Juraj Kupujúci (Ružomberok-Fiktív) | delivered |  |  |  |
| s03 | sps | SK0FAKE26MART00003 | Reťaze & Spol. via SPS (door) | delivered |  |  |  |
| r1 | packeta | Z6666666621 | customer return from Juraj Zákaznícky | D3 11:20 | Papiernictvo Kolesovo – výdajné miesto Packeta |  | D10 23:59 |
| s04 | gls | 90666666604 | Brzdy Plus s.r.o. via GLS (door) | delivered |  |  |  |
| s05 | dpd | 01505666666605 | CykloParts GmbH # CP-77158 via DPD (door) | delivered |  |  |  |
| s06 | dpd | 01505666666606 | CykloParts GmbH # CP-77158 via DPD (door) | delivered |  |  |  |
| s07 | sps | 7036666666666607 | Reťaze & Spol. via SPS (door) | delivered |  |  |  |
| o2 | packeta | Z6666666632 | OUTGOING to Ing. Pavol Jazdný (Martin-Fiktív) | delivered |  |  |  |
| s08 | dpd | 01505666666608 | Pneu Velo CZ # PV-3310 via DPD (door) | delivered |  |  |  |
| r2 | packeta | Z6666666622 | customer return from Monika Vrátená | D7 10:10 | Papiernictvo Kolesovo – výdajné miesto Packeta |  | D14 23:59 |
| s09 | gls | 90666666609 | saddles, GLS ParcelShop | D8 13:00 | GLS ParcelShop Tabak Kolesovo | 660193 | D15 23:59 |
| o3 | packeta | Z6666666633 | OUTGOING to Lucia Rýchla (Žilina-Fiktív) | delivered |  |  |  |
| s10 | gls | 90666666610 | Velo Distribúcia s.r.o. via GLS (door) | delivered |  |  |  |
| s11 | dpd | 01505666666611 | CykloParts GmbH # CP-77201 via DPD (door) | delivered |  |  |  |
| s12 | sps | SK0FAKE26MART00012 | Reťaze & Spol. via SPS (door) | delivered |  |  |  |
| s13 | gls | 90666666613 | Brzdy Plus s.r.o. via GLS (door) | delivered |  |  |  |
| o4 | packeta | Z6666666634 | OUTGOING to Peter Pomalý (Prešov-Fiktív) | delivered |  |  |  |
| r3 | packeta | Z6666666623 | customer return from Andrej Nespokojný | D11 09:30 | Papiernictvo Kolesovo – výdajné miesto Packeta |  | D18 23:59 |
| s14 | dpd | 01505666666614 | Pneu Velo CZ # PV-3355 via DPD (door) | delivered |  |  |  |
| s15 | sps | SK0FAKE26MART00015 | Reťaze & Spol. via SPS (door) | delivered |  |  |  |
