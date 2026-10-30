# Petra — persona test results

Screenshots: `scripts/dev/persona-sim/results/petra-shots/`

## 1. Who I am

I'm Petra, 38, a mother of two school children in Testovce. I order for the whole family in the evenings from several shops at once, and I collect parcels on the school run (15:30) or on my way back from the shop.
During the day I only react to notifications. I open the dashboard once in the evening for about five minutes. What I need to know is which parcel is for whom and where and when I have to pick it up.

## 2. Diary

**Day 0 (Sun evening).** The first-run page only asked for my postcode, which was easy. The README's "Install the app" section is long, and the macOS "Open Anyway" part made me nervous (System Settings → Privacy & Security → Open Anyway, twice). In Settings, "How to connect Gmail — three steps, about five minutes" is closed by default. Inside it there are twelve bullets in one flat list, and I can't tell where "step 1" ends. The first bullet is "Label your shipping emails." It's a heading, not something to do. I would have called my husband around "Make an App Password" / "2-Step Verification". I only got through because the sim let me pretend. After Save, "Connected, nothing to read" was reassuring and clear.

**Day 1.** The only notification all day was at 19:00: "Registered — Notino / Zásielka bola podaná odosielateľom." In the evening the dashboard showed "1 in flight. Nothing needs you." The card said "Notino · Packeta · Z5555555502". It didn't say where the parcel was going or what was in it.

**Day 2.** I got three "Registered/In transit" notifications. The Alza mail at 16:03 said my AlzaBox order was ready (code 557120, until 06.11), but I got no notification. In the evening the dashboard said "3 in flight. Nothing needs you." and Alza wasn't there. The Attention page had the Alza mail ("no tracking number found in this message"), but nothing on the dashboard or in the navigation pointed me there. I collected it at 22:00 with the code from the e-mail. The app did not help me with this parcel at all.

**Day 3.** The menu-bar number went to 3 at midday, and I got three "Ready for pickup" notifications. The Bambulka one said only "collect by Mon 9 Nov", with no place. At 15:30 I planned a round: the Z-BOX at the school (the dashboard showed the code 341208 in big type), the DPD Pickup Station at Tesco (PIN 610045, only in the e-mail), and the Balíkovo counter in Jednota (place and verification code only in the e-mail). I had to open two e-mails to plan it. I collected all three. Afterwards the app noticed on its own ("Delivered" at 16:00, menu bar 0), so I didn't have to press anything.

**Day 4.** The new Alza and Notino parcels were named just "Alza.sk" and "Notino". Because I want to know what's in them, I renamed both myself (mixer; kids' shampoo).

**Day 5.** Alza's courier parcel was "Out for delivery" at 07:00 and "Delivered" at 11:00, with no time window in the notification (GLS's e-mail had one, 9–12). The Topánočky return e-mail ("Kód na podanie: R-555505", "Číslo zásielky na vrátenie: Z 555 5555 505") wasn't labelled `parcels`. The app ignored it and nothing appeared in Attention.

**Day 6 (Sat).** There is no way to act out dropping the return in the Z-BOX. The app then showed "Registered — Z5555555505" at 11:00: no shop, no name, and nothing saying it's going *away*. It sat in the same "In flight" list as my incoming parcels ("2 in flight, 1 ready for pickup"). The Notino shampoo was ready at the GLS ParcelShop, with no place and no PIN (228801) on the card.

**Day 7 (Sun).** I went to the ParcelShop with the PIN and found it closed ("Opening hours: Mon-Sat 08:00-19:00"). The app never shows opening hours, so I wasted a trip. I'd have been angry in real life.

**Day 8.** On Monday I collected the shampoo, then the Diskont washing gel from the BalíkoBOX with PIN 450091 (not on the card, only in the e-mail). The deadline on the dashboard, "Thu 12 Nov · 3 days left", matched the e-mail. At 14:00 "Delivered — Z5555555505" appeared, which is my return arriving back at the shop. History now lists it as "Delivered 9 Nov" among my own purchases.

**Day 9.** There was a split Kocúrik order (Z-BOX part and DPD courier part), plus a second Bambulka (winter jacket, SPS courier) and a second Notino. All of them were named just by shop. On the dashboard that evening only the Z-BOX part of Kocúrik existed.

**Day 10.** The DPD courier part appeared only at 08:00 on the day of delivery, as "Hračky Kocúrik # K-7781", a different name from the Z-BOX part. The dashboard grouped my two Z-BOX parcels under one place header, each with its own big code. That was the best thing I saw. I collected both at 15:30 (screenshots at 1280 and 390 px).

**Day 11.** Nothing happened. Good.

**Day 12.** I got an Alza e-mail at 17:33 (AlzaBox code 803366, until 16 Nov, advent calendar), but no notification and no menu-bar number. The dashboard said "Nothing in flight. Parcels appear here when a shipping email arrives" even though one had just arrived. Without the digest, I would have missed my children's advent calendar.

**Day 13.** I collected it at 15:30 with the code from the e-mail. Earlier I had tried Attention → "Assign to a parcel" with the order number. That created a made-up "GLS · 1051500013 / No updates yet" parcel, so I marked it received by hand.

**Day 14.** History shows 12 parcels. I renamed the ones that mean nothing, and I had to guess which Kocúrik part held what, because neither e-mail says. At 390 px the History table is cut off (Outcome and Date columns lost).

## 3. Jobs

1. **Day 0 — set-up. Partly (I would not finish alone).** About 6 steps in the sim; in real life more than 20 minutes, and I'd likely need help. The first-run page was easy. Hesitations: "Open Anyway" (twice), the collapsed "How to connect Gmail — three steps, about five minutes", and the unnumbered twelve bullets under it. In "Make an App Password" I'd call for help. Saving and the Gmail test gave a clear answer ("Connected, nothing to read"). Screenshot: `petra-shots/day0-settings.png`.

2. **Day 2 evening — AlzaBox. App failed; I succeeded only from the e-mail.** 2 steps (`sim mail 8`, `sim collect 557120`). The app didn't know ("3 in flight. Nothing needs you."), gave no code and no deadline, and sent no notification. The code (557120) and deadline (06.11.2026) were only in the Gmail mail. Screenshot: `petra-shots/day2-dashboard.png`.

3. **Day 3, 15:30 — school round. Partly.** The app got me the Z-BOX code, but for the other two I needed the e-mails (DPD PIN 610045; Balíkovo place "Jarná 10", until 09.11 18:00, number/code). About 8 steps (dashboard, 4 mails, 3 collects). Hesitation: the notification "Ready for pickup — Bambulka – detská móda / collect by Mon 9 Nov" with no place. Screenshot: `petra-shots/day3-dashboard.png`.

4. **Days 5–8 — return parcel. Partly.** About 5 steps. I could not act out the drop-off (`collect R-555505` → "Nothing opens and nobody has a parcel"). What confused me: the return parcel appears as "Registered — Z5555555505" with no shop and no name, in the "In flight" list next to my incoming parcels, then "Delivered 9 Nov" in History with nothing saying it's a return. The e-mail containing the return code wasn't picked up at all. Screenshot: `petra-shots/day6-dashboard.png`.

5. **Days 8–11 — Diskont deadline. Succeeded.** About 4 steps. The dashboard said "Collect by Thu 12 Nov · 3 days left", matching the e-mail ("Zásielka je uložená do: 12.11.2026 23:59"). The PIN (450091) was only in the e-mail. I collected it on day 8.

6. **Day 10 — two Z-BOX parcels and a courier. Succeeded.** About 5 steps. The dashboard grouped both Z-BOX parcels under "Z-BOX Testovce, Školská 2 (ZŠ), Testovce", each with its own big code (902114 and 117395), which was clear. At 390 px it wraps cleanly. The courier (DPD) part wasn't shown the evening before, and its name differs from the Z-BOX part. I collected both. Screenshots: `petra-shots/day10-dashboard-1280.png`, `petra-shots/day10-dashboard-390.png`.

7. **Days 12–14 — Alza again. App failed; I succeeded only from the e-mail.** About 6 steps. No notification, no menu-bar number, and the dashboard said "Nothing in flight." The deadline (16.11) and code (803366) were only in the e-mail. The "Assign to a parcel" workaround produced a useless "GLS · 1051500013" parcel. Screenshots: `petra-shots/day12-dashboard.png`, `petra-shots/day12-attention.png`.

8. **Day 14 — History. Partly.** About 10 steps (12 renames and checks). I can tell the *shop* from the card name only when it's unique: Notino ×3, Bambulka ×2 and Kocúrik ×2 look identical, and the return is an unnamed number. Renaming works and then shows the shop as small grey text next to the name. It saved me time only on the parts where the app worked (Z-BOX codes, collected status). Screenshots: `petra-shots/day14-history.png`, `petra-shots/day14-history-renamed.png`, `petra-shots/day14-history-390.png`.

## 4. Problems

### The app did something wrong

- **Alza AlzaBox e-mails are never turned into a parcel (major, twice).**
  - Day 2, 16:03, "Objednávka 1051500001 je pripravená na vyzdvihnutie v AlzaBoxe": no notification, no menu-bar number, and the dashboard said "3 in flight. Nothing needs you."
  - Day 12, 17:33: same, and the dashboard said "Nothing in flight." Alza is my most frequent shop, and the app misses exactly the parcels with the earliest deadlines (4 days, 3 days).
  - The only trace is Attention ("no tracking number found in this message"), and nothing on the dashboard says an e-mail is waiting there.
- **Dashboard says "Nothing needs you." while Attention has items (major).** Day 2, 21:00 and day 12, 21:00. The nav shows no count or badge, so I'd never open Attention.
- **"Assign to a parcel" can't help for Alza (major).** Day 13: with the only number in the mail (the order number 1051500013), it created "GLS · 1051500013 / No updates yet" with no code or deadline. It also guessed the wrong carrier.
- **PIN/code missing from the dashboard for some carriers (major).** Day 3: DPD Pickup Station card has no PIN (610045, only in mail #12). Day 3: Balíkovo card has no verification code. Day 6/8: the GLS (228801) and BalíkoBOX (450091) cards have no PIN either. Only Packeta's Z-BOX shows its code. That's one carrier out of five.
- **Notification with no place (major).** Day 3, 13:00, "Ready for pickup — Bambulka – detská móda / collect by Mon 9 Nov". The place (Balíkovo, Potraviny Jednota, Jarná 10) is missing. Day 6, 10:00, "Ready for pickup — Notino šampón pre deti / collect by Sat 14 Nov": no place either (GLS ParcelShop Drogéria Kvietok).
- **Deadline loses its time (minor).** Balíkovo mail says "do 09.11.2026 18:00"; the dashboard says only "Collect by Mon 9 Nov".
- **No opening hours (major — cost a trip).** Day 7, 15:30: ParcelShop "is closed now (Sun 15:30). Opening hours: Mon-Sat 08:00-19:00". The app shows hours nowhere.
- **Return parcel treated like an incoming one (major).**
  - Day 5: the return e-mail (R-555505 / Z 555 5555 505) wasn't labelled and was ignored.
  - Day 6, 11:00: "Registered — Z5555555505", no shop, no name, nothing about it being a return. Day 6 dashboard: "2 in flight, 1 ready for pickup", with the return in the same list.
  - Day 8, 14:00: "Delivered — Z5555555505 / Zásielka bola doručená príjemcovi." In History it reads "Delivered 9 Nov", like a purchase of mine. Nothing connects it to the shoes ("Topánočky", delivered 4 Nov).
- **Split orders get inconsistent names (minor/major).** Day 9–10: one Kocúrik order (K-7781) became "Hračky Kocúrik" (Packeta part) and "Hračky Kocúrik # K-7781" (DPD part). The DPD part only appeared on day 10 at 08:00, although the e-mail (day 9, 07:30) announced it.
- **Sharing several notifications at once (minor).** Day 3, 15:30: three separate "Still waiting for you · day 1" notifications at the same minute. Day 10, 15:30: two.
- **History at 390 px (minor).** The Outcome and Date columns are cut off (`petra-shots/day14-history-390.png`). The window at 1280 is fine.
- **Day 14 (minor).** The e-mail with the courier time window (GLS 9–12 on day 5; DPD 10:30–11:30 on day 10) never reached a notification; "Out for delivery" had no time.

### The app did it right but I didn't understand

- **"How to connect Gmail — three steps"** (day 0, Settings): collapsed, and twelve flat bullets. I expected three numbered steps. The first one, "Label your shipping emails.", reads like a heading, not an action. (major for set-up; I'd ask for help at "App Password".)
- **Gatekeeper "Open Anyway"** (day 0, README step 4): scary, though it's explained; I'd hesitate.
- **"Mark as received" vs "Mark as collected"** (day 1 vs day 3): two phrases for similar things, and I never had to use either because the app noticed pickups itself. Slightly puzzling (minor).
- **"collect by Wed 18 Nov · 7 days left" vs "Collect by Thu 12 Nov"** (day 10 vs day 8): fine, but I couldn't tell at a glance that Balíkovo gives 6 days, Z-BOX 7, BalíkoBOX 3. The "N days left" helps (minor).
- **404 text** "That email is no longer waiting: it was assigned or dismissed already, perhaps in another tab." (day 12). It was my own typo in the id, but the wording is confusing (minor).

## 5. Missing features that block my day-to-day use

- **Day 2, 16:03 and day 12, 17:33, at the AlzaBox e-mails:** I needed a notification and a dashboard entry for "Alza says your order is in the AlzaBox: code 557120, collect by 6 Nov". Both times I got nothing.
- **Day 3, 15:30, planning the school round:** I needed the code/PIN, the place and the opening hours on every card, for every carrier (DPD, Balíkovo, GLS, BalíkoBOX), not only Z-BOX. Without them the app doesn't replace opening Gmail.
- **Day 3, 13:00, the Bambulka notification, and day 6, 10:00, the Notino one:** I needed the place in every "Ready for pickup" notification, because during the day I only look at notifications.
- **Day 7, 15:30, at the ParcelShop:** I needed the opening hours (or a "closed today" warning) before leaving the house.
- **Day 4 / day 9 / day 14, at the cards named "Notino", "Bambulka", "Hračky Kocúrik":** I needed the contents (from the shop e-mail: "Šampón pre deti", "Zimná bunda, detská 116", "Bábika s kočíkom") shown automatically, and a way to say whom it's for (which child, which present). Ideally the app would suggest the name.
- **Day 6, 11:00, at "Registered — Z5555555505":** I needed returns recognised as returns: named after the shop, marked "going back", kept out of "ready to collect" and out of the "delivered" count.

## 6. Other ideas

- **Notification with a "Show code" action or the code in the text, only for boxes.** Day 3, 15:30, at the school gate: I'd want the code without opening the app (the e-mail has it).
- **One summary notification at 15:30 instead of one per parcel.** Day 3 (three) and day 10 (two).
- **A "today's round" view grouped by place, with opening hours.** Inspired by day 3's three stops. The Z-BOX grouping on day 10 was already great, so extend it.
- **Flag parcels for a pickup person (husband).** Day 10: "Hračky Kocúrik" and "Notino" were both for me; some days my husband fetches.
- **Add a calendar entry automatically on the deadline day.** Day 12: the Alza deadline fell on a Monday and I'd never remember it.
- **Show the courier's time window in the notification.** Day 5 (GLS 9–12) and day 10 (DPD 10:30–11:30).
- **A "Dismiss all" prompt for old Attention items.** Day 12: the day-2 Alza mail was still sitting there.

## 7. Verdict

- **What I use today:** carrier notifications from several apps and texts (Packeta, DPD), plus searching Gmail for "Alza" or "Notino" when I can't find a code.
- **Is Parcels better?** Yes for exactly one thing: the Z-BOX card, grouped by place with big codes (days 3 and 10), and the automatic "Delivered" so I never press anything. For Alza, DPD, GLS, Balíkovo and BalíkoBOX I still had to open the mails, so it's no better than Gmail there.
- **Would I still use it after this week?** Maybe. The two Alza misses cost me trust: the app said "Nothing needs you." / "Nothing in flight" while a parcel with a 3-day deadline waited. If it can't be trusted to tell me, I'd keep checking Gmail anyway.
- **What would make me uninstall it:** one more missed AlzaBox/pickup, or finding out that a parcel I relied on the menu-bar number for wasn't counted.
- **Score:** 5/10.
- **To a friend:** "It's great for Packeta boxes, but it silently skipped my Alza pickups, so don't rely on it yet."
