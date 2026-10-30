# jan: operator overview (generated - SPOILERS, never show this to the persona agent)

Ján Vymyslený, Dolné Fiktívce. Day 0 = 2026-11-01. 2 carrier parcels in the world, 11 mails (7 match gmail-filter.xml and reach the app's label, 0 only appear after a `sim collect`, 1 are conditional).

## Mails

| id | when | from | subject | label | purpose |
|---|---|---|---|---|---|
| m01 | D-2 18:20 | Knihy Pre Vás <objednavky@knihyprevas.example.sk> | Potvrdenie objednávky č. 2026-11873 | **no** | order confirmation, no number (not labelled) |
| m02 | D2 10:05 | Knihy Pre Vás <objednavky@knihyprevas.example.sk> | Vaša objednávka č. 2026-11873 bola odoslaná | yes | p1 shop dispatch with the posta number |
| m05 | D3 16:40 | Banka Fiktívna <info@bankafiktivna.example.sk> | Váš výpis z účtu za október 2026 | **no** | bank statement (not labelled) |
| m06 | D4 19:10 | Tomáško <tomasko.vnuk@example.com> | Ahoj dedko | **no** | grandson, personal (not labelled) |
| m03 | D5 11:25 | Slovenská pošta <notifikacie@posta.sk> | Oznámenie o uložení zásielky EB222222013SK | yes | p1: posta stored, until 13.11.2026, COD 18,50 € |
| m07 | D6 08:15 | DPD <info@dpd-sk.example.net> | Vaša zásielka čaká na doplatenie poštovného 1,50 € | yes | PHISHING look-alike DPD (labelled) |
| m08 | D8 13:00 | Lekáreň Zdravie Online <eshop@lekarenzdravie.example.sk> | Objednávka č. L-55102 bola odoslaná | yes | p2 pharmacy dispatch (ordered by his daughter) |
| m09 | D9 07:25 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bude doručená dnes | yes | p2: DPD Predict for day 9 |
| m04 | D9 10:00 (if not collected) | Slovenská pošta <notifikacie@posta.sk> | Pripomienka: zásielka EB222222013SK čaká na pošte | yes | p1: posta reminder 3 days before (only if not collected) |
| m10 | D9 10:52 | "DPD" <no_reply@dpd.sk> | Vaša zásielka bola doručená | yes | p2: delivered to the door |
| m11 | D10 07:00 | Záhradkár <noviny@zahradkar.example.sk> | Záhradkár: čo robiť v záhrade v novembri | **no** | newsletter (not labelled) |

## Parcels (carrier side)

| key | carrier | number | what | ready | where | code | deadline |
|---|---|---|---|---|---|---|---|
| p1 | posta | EB222222013SK | book, COD, post office (must be collected by Fri 13 Nov 18:00) | D5 11:00 | Pošta Dolné Fiktívce |  | D12 18:00 |
| p2 | dpd | 01505222222202 | Lekáreň Zdravie Online # L-55102 via DPD (door) | delivered |  |  |  |
