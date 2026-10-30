# tomas: operator overview (generated - SPOILERS, never show this to the persona agent)

Tomáš Bezpečný, Fiktívna Ves. Day 0 = 2026-11-01. 5 carrier parcels in the world, 21 mails (19 match gmail-filter.xml and reach the app's label, 2 only appear after a `sim collect`, 2 are conditional). A new app release (v0.2.0) appears D6 07:00.

## Mails

| id | when | from | subject | label | purpose |
|---|---|---|---|---|---|
| m01 | D1 10:00 | DHL Express <noreply@dhl.com> | DHL On Demand Delivery: Your shipment JJD000888888888801 is on its way | yes | t1: DHL dispatched |
| m02 | D2 08:30 | DHL Express <noreply@dhl.com> | Clo a DPH na úhradu – zásielka DHL Express | yes | t1: customs 23,10 EUR |
| m04 | D2 14:00 | Kľúčovňa <eshop@klucovna.example.sk> | Objednávka K-3001 bola odoslaná | yes | t2 Packeta Z-BOX |
| m05 | D2 18:08 | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola prijatá do prepravy | yes | t2: Packeta accepted |
| m10 | D3 09:00 | GitHub <noreply@github.example.com> | [fake-org/infra] Dependabot alert: 3 vulnerable dependencies | **no** | work noise (not labelled) |
| m03 | D3 13:05 | DHL Express <noreply@dhl.com> | Your DHL shipment JJD000888888888801 has been delivered | yes | t1: DHL delivered |
| m06 | D4 08:14 | Packeta Slovakia <noreply@packeta.sk> | Zásielka je pripravená na vyzdvihnutie | yes | t2: Packeta ready, code 551208, until 12.11.2026 |
| m11 | D5 07:30 | Packeta <bezpecnost@packeta-overenie.example.com> | Overte svoju zásielku – posledná výzva | yes | PHISHING look-alike (labelled) |
| m12 | D6 10:00 | Elektro Svet <objednavky@elektrosvet.example.sk> | Objednávka č. 2026110301 bola odoslaná | yes | t3 GLS courier |
| m13 | D6 12:20 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90888888803 sme prevzali od odosielateľa | yes | t3: GLS accepted |
| m14 | D7 07:10 | GLS Slovakia <noreply@gls-slovakia.sk> | Váš balík 90888888803 je na ceste | yes | t3: GLS out for delivery today |
| m15 | D7 11:39 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90888888803 bol doručený | yes | t3: GLS delivered to the door |
| m16 | D8 09:00 | Počítače Fiktív <eshop@pocitacefiktiv.example.sk> | Vaša objednávka P-8812 bola odoslaná | yes | t4 DPD Pickup point |
| m17 | D8 11:30 | "DPD" <no_reply@dpd.sk> | Vaša zásielka je na ceste do Pickup Station | yes | t4: DPD on its way to the station |
| m18 | D9 14:06 | "DPD" <no_reply@dpd.sk> | Informácia o uložení zásielky v samoobslužnom boxe Pickup Station | yes | t4: DPD station ready, PIN 300417, until 17.11.2026 |
| m21 | D10 09:30 | Zámky Online <eshop@zamkyonline.example.sk> | Objednávka Z-120 bola odoslaná | yes | t5 posta dispatch |
| m07 | D10 10:00 (if not collected) | Packeta Slovakia <noreply@packeta.sk> | Pripomíname: zásielka na vás čaká v Z-BOXe | yes | t2: reminder, day before the deadline (only if not collected) |
| m22 | D12 08:00 | Security Weekly <newsletter@secweekly.example.com> | This week: supply-chain attacks on auto-updaters | **no** | newsletter (not labelled) |
| m09 | D12 09:30 (if not collected) | Packeta Slovakia <noreply@packeta.sk> | Zásielka bude vrátená odosielateľovi | yes | t2: not collected in time, returning |
| m08 | after collect t2 +6m | Packeta Slovakia <noreply@packeta.sk> | Zásielka bola vyzdvihnutá | yes | t2: picked-up confirmation (after sim collect) |
| m20 | after collect t4 +5m | "DPD" <no_reply@dpd.sk> | Vaša zásielka bola doručená | yes | t4: DPD collected confirmation |

## Parcels (carrier side)

| key | carrier | number | what | ready | where | code | deadline |
|---|---|---|---|---|---|---|---|
| t1 | dhl | JJD000888888888801 | hardware keys from the UK (DHL Express, email only) | email only |  |  |  |
| t2 | packeta | Z8888888802 | webcam covers (Z-BOX) | D4 08:10 | Z-BOX Fiktívna Ves, Jarná 1 (COOP) | 551208 | D11 23:59 |
| t3 | gls | 90888888803 | Elektro Svet via GLS (door) | delivered |  |  |  |
| t4 | dpd | 01505888888804 | SSD (DPD Pickup point) | D9 14:00 | DPD Pickup Fiktívna Ves – Kvetinárstvo | 300417 | D16 23:59 |
| t5 | posta | EB888888055SK | small item, posta to the door | delivered |  |  |  |
