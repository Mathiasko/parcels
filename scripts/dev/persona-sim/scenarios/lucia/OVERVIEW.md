# lucia: operator overview (generated - SPOILERS, never show this to the persona agent)

Lucia Vymyslená, Brno. Day 0 = 2026-11-01. 5 carrier parcels in the world, 30 mails (8 match gmail-filter.xml and reach the app's label, 4 only appear after a `sim collect`, 4 are conditional).

## Mails

| id | when | from | subject | label | purpose |
|---|---|---|---|---|---|
| m01 | D2 10:00 | Knihkupectví Příkladné <eshop@knihkupectvi.example.cz> | Vaše objednávka č. 2026-4410 byla odeslána | yes | l1 Czech shop dispatch ("odeslána": labelled) |
| m07 | D2 12:00 | Studijní oddělení <studijni@fakulta.example.cz> | Zápis na zkouškové období | **no** | university (not labelled) |
| m02 | D2 15:08 | Zásilkovna <noreply@zasilkovna.cz> | Zásilka Z 777 7777 701 je na cestě | **no** | l1: Packeta accepted |
| m14 | D3 20:00 | Elektro Brno <obchod@elektrobrno.example.cz> | Objednávka EB-77120 odeslána | yes | l5 Czech shop via PPL (unsupported carrier); 11-digit number looks GLS-shaped |
| m15 | D4 07:40 | PPL CZ <info@ppl.example.cz> | Dnes vám doručíme zásilku 40777777701 | **no** | l5 PPL courier today (not labelled: unknown carrier, Czech words) |
| m08 | D4 09:00 | Móda Bratislava <eshop@modaba.example.sk> | Objednávka č. MB-1290 bola odoslaná | yes | l2 Slovak shop to her Brno Z-BOX (Slovak dispatch labelled; carrier mails Czech) |
| m03 | D4 10:04 | Zásilkovna <noreply@zasilkovna.cz> | Zásilka je připravena k vyzvednutí | **no** | l1: Packeta ready, until 12.11.2026 |
| m16 | D4 11:50 | PPL CZ <info@ppl.example.cz> | Zásilka 40777777701 byla doručena | **no** | l5 PPL delivered (not labelled) |
| m09 | D4 18:08 | Zásilkovna <noreply@zasilkovna.cz> | Zásilka Z 777 7777 702 je na cestě | **no** | l2: Packeta accepted |
| m17 | D5 18:30 | Vinted <no-reply@vinted.example.cz> | Tvůj nákup: Zimní bunda – prodejce odeslal balíček | yes | l3 Vinted; "balíček" in the subject, so labelled; Zásilkovna number in the body |
| m18 | D6 10:08 | Zásilkovna <noreply@zasilkovna.cz> | Zásilka Z 777 7777 703 je na cestě | **no** | l3: Packeta accepted |
| m23 | D6 14:08 | Zásilkovna <noreply@zasilkovna.cz> | Zásilka Z 777 7777 704 je na cestě | **no** | l4 (flatmate): Packeta accepted |
| m29 | D7 09:00 | Zásilkovna <novinky@zasilkovna.cz> | Nové Z-BOXy ve vašem okolí | **no** | carrier promo from zasilkovna.cz (not labelled) |
| m10 | D7 09:34 | Zásilkovna <noreply@zasilkovna.cz> | Zásilka je připravena k vyzvednutí | **no** | l2: Packeta ready, code 664210, until 15.11.2026 |
| m24 | D8 11:04 | Zásilkovna <noreply@zasilkovna.cz> | Zásilka je připravena k vyzvednutí | **no** | l4 (flatmate): Packeta ready, until 16.11.2026 |
| m19 | D9 08:44 | Zásilkovna <noreply@zasilkovna.cz> | Zásilka je připravena k vyzvednutí | **no** | l3: Packeta ready, code 307714, until 17.11.2026 |
| m28 | D9 13:15 | Klára Smyšlená <klara.smyslena@example.cz> | kosmetika | **no** | l4 flatmate asks (not labelled) |
| m04 | D10 10:00 (if not collected) | Zásilkovna <noreply@zasilkovna.cz> | Připomínáme: zásilka na vás čeká | **no** | l1: reminder, day before the deadline (only if not collected) |
| m30 | D10 16:00 | Sportovní Brno <eshop@sportbrno.example.cz> | Váš balík je na cestě | yes | l6 Czech shop, "balík": labelled; GLS courier |
| m31 | D10 17:20 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90777777706 sme prevzali od odosielateľa | yes | l6: GLS accepted |
| m32 | D12 07:10 | GLS Slovakia <noreply@gls-slovakia.sk> | Váš balík 90777777706 je na ceste | yes | l6: GLS out for delivery today |
| m34 | D12 08:00 | Vinted <no-reply@vinted.example.cz> | Nezapomeň potvrdit, že je vše v pořádku | **no** | Vinted (not labelled) |
| m06 | D12 09:30 (if not collected) | Zásilkovna <noreply@zasilkovna.cz> | Zásilka bude vrácena odesílateli | **no** | l1: not collected in time, returning |
| m33 | D12 12:29 | GLS Slovakia <noreply@gls-slovakia.sk> | Balík 90777777706 bol doručený | yes | l6: GLS delivered to the door |
| m11 | D13 10:00 (if not collected) | Zásilkovna <noreply@zasilkovna.cz> | Připomínáme: zásilka na vás čeká | **no** | l2: reminder, day before the deadline (only if not collected) |
| m25 | D14 10:00 (if not collected) | Zásilkovna <noreply@zasilkovna.cz> | Připomínáme: zásilka na vás čeká | **no** | l4: reminder, day before the deadline (only if not collected) |
| m05 | after collect l1 +6m | Zásilkovna <noreply@zasilkovna.cz> | Zásilka byla vyzvednuta | **no** | l1: picked-up confirmation (after sim collect) |
| m12 | after collect l2 +6m | Zásilkovna <noreply@zasilkovna.cz> | Zásilka byla vyzvednuta | **no** | l2: picked-up confirmation (after sim collect) |
| m21 | after collect l3 +6m | Zásilkovna <noreply@zasilkovna.cz> | Zásilka byla vyzvednuta | **no** | l3: picked-up confirmation (after sim collect) |
| m26 | after collect l4 +6m | Zásilkovna <noreply@zasilkovna.cz> | Zásilka byla vyzvednuta | **no** | l4: picked-up confirmation (after sim collect) |

## Parcels (carrier side)

| key | carrier | number | what | ready | where | code | deadline |
|---|---|---|---|---|---|---|---|
| l1 | packeta | Z7777777701 | statistics textbook (výdejní místo) | D4 10:00 | Trafika U Fiktivního parku – výdejní místo |  | D11 23:59 |
| l2 | packeta | Z7777777702 | sweater (Z-BOX) | D7 09:30 | Z-BOX Brno, Smyšlená 12 (Albert) | 664210 | D14 23:59 |
| l3 | packeta | Z7777777703 | Vinted jacket (Z-BOX); only the Vinted mail reaches the label | D9 08:40 | Z-BOX Brno, Smyšlená 12 (Albert) | 307714 | D16 23:59 |
| l4 | packeta | Z7777777704 | Klára's cosmetics (Lucia's address used) (flatmate) | D8 11:00 | Trafika U Fiktivního parku – výdejní místo |  | D15 23:59 |
| l6 | gls | 90777777706 | Sportovní Brno via GLS (door) | delivered |  |  |  |
