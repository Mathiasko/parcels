# Parcels: consolidated persona test

Nine synthetic users lived 14 simulated days with the app at HEAD of `mac-app` (2026-10-30): eight
personas (zuzana, jan, petra, martin, lucia, tomas, eva, power) and one heuristic expert who walked the
power scenario. This file separates product behaviour from simulator artifacts, dedupes across the nine
reports, ranks, and says what the test can and cannot tell you. Line references are into `src/` and
`app/` at HEAD; "probe" means I ran the built extractor (`dist/ingest/extract.js`) on the scenario's own
`.eml` files to check a claim.

---

## 1. Executive summary

**Scores: 5, 5, 5, 6, 6, 6, 6, 7. Mean 5.75. Keep 1, maybe 7, drop 0.** Nobody would uninstall today;
every one of them named the thing that would make them.

**What earned praise from all eight:** the Z-BOX card (big code, grouped by place), a menu-bar number
that was right whenever a polled carrier was involved, parcels that clear themselves when the carrier
reports a pickup or delivery, honest copy and empty states, Undo, Add to Calendar, no crash in 14 days.
Tomas called the README "the most honest statement of what software does with your mail I have read in
years". Power: "the Terminal install without the babysitting".

**The pattern in every diary:** Parcels is excellent for a Packeta Z-BOX and no better than Gmail at any
other counter. The facts that decide whether a trip succeeds (the PIN, the place, the cash-on-delivery
amount, opening hours, the courier's time window) are in the mail and not in the app, so seven of eight
kept Gmail open all fortnight. Zuzana's sentence to a friend sums it up: "a good number in the menu bar
for Z-BOX parcels, but for AliExpress and the post office you still dig through Gmail."

**Three trust incidents that were real product behaviour, not the simulator:**
1. Petra's two AlzaBox pickups (3- and 4-day deadlines) while the dashboard said "3 in flight. Nothing
   needs you." and later "Nothing in flight." The mail sat on /attention, which nothing points to.
2. Zuzana walked past two parcels already in her Z-BOX at 07:40 because the app noticed them at 08:00
   and 10:00: Packeta's mail had arrived at 07:14 and 07:19, but new mail does not make the app poll
   that parcel, and a weeks-old AliExpress parcel is on a slow polling tier.
3. Lucia's flatmate's parcel never existed for the app: no Zásilkovna mail is labelled by the Gmail
   filter (no `zasilkovna.cz`, no Czech words), so the Czech half of the market is invisible.

**Notification volume is the one item all eight raised.** Twice-daily "Still waiting" per parcel, plus
Registered and In transit banners, plus "Delivered" for things the user collected an hour ago, with no
setting anywhere. Jan and Eva listed it as an uninstall trigger. (Jan: 12 banners for 2 parcels, 6 of
them nags. Eva: 26 in 4 away days, 15 nags she could not act on.)

**Setup is the biggest adoption risk.** Five of eight (zuzana, jan, petra, eva, lucia) say they would not
finish Gmail + App Password alone; the expert estimates one friend in three gets to a working app
unaided. Most of the cheap fixes are copy; the expensive one is signing and notarising.

**Simulator artifacts excluded (details in §6):** power's "history lost on move-in", blank Settings and
"Gmail is not connected" right after Move in, the 51376 port, missing maps, the support bundle's
"OS: undefined", and (probably) the GLS ParcelShop card showing no place.

### Top 10, ranked by personas affected × severity, then risk to trust

| # | Item | Cat | Personas | Worst severity | Effort | Quick win |
|---|---|---|---|---|---|---|
| 1 | Pickup PIN/code shown only for Packeta Z-BOX; DPD, GLS, BalíkoBOX, Balíkovo cards have none | C | 6/8 + expert | major (expert: 4/4) | S–M | yes |
| 2 | Notification volume: nudges twice a day per parcel, every transition, no settings | B | 8/8 + expert | major (eva); uninstall trigger (jan, eva) | S | yes |
| 3 | Setup funnel: Gatekeeper, 12-bullet "three steps, five minutes", App Password, Show in IMAP | B | 8/8 + expert | blocker (5 would not finish) | S copy / M notarise | copy yes |
| 4 | "Nothing needs you" while /attention holds a pickup with a deadline; no Attention count anywhere | A | 3/8 | major (petra ×2) | S | yes |
| 5 | Cash-on-delivery amount never shown | C | 4/8 + expert | major | M | — |
| 6 | New mail about an existing parcel does not trigger a poll; slow tiers make "ready" arrive hours late | A | 3/8 + expert | major (zuzana: a second trip) | S | yes |
| 7 | Courier window, next attempt after a failed delivery, redirect link: all only in the mail | C | 5/8 + expert | major (jan, martin, eva) | M | — |
| 8 | Email-only (DHL) parcel: no banner for any mail, "delivered" never finishes it | A | 2/8 + expert | major (customs deadline passed in silence) | S banner / M finish | banner yes |
| 9 | Czech market: filter has no `zasilkovna.cz`, no PPL, no Czech words | C | 1/8 | major ×3 (lucia) | S filter / L PPL | filter yes |
| 10 | A seller's own dispatch copies become his parcels, incl. "Ready for pickup" and menu-bar 1 | A | 1/8 | major, near blocker (martin) | S doc / M rule | doc yes |

Just below: scam wording on /attention (4/8, S), parcels named by shop or bare number (6/8, S–M),
English chrome (3/8 + expert, M), "Parcel 1:" label never parsed (1/8, S), returns shown as incoming
(1/8, M), opening hours and "last day" on a closed day (4/8, L), History at 390 px (4/8 + expert, S).

---

## 2. Claims checked against the code

Each major claim the personas made, with its verdict. **Product** = the code does this (file:line).
**Sim** = the simulator caused it. **Unclear UI** = the app was right but the person could not tell.

| Claim | Verdict | Evidence |
|---|---|---|
| AliExpress "LP…" shipped mails land on /attention as "no tracking number found" | Product (gap + wrong wording) | No LP/Cainiao shape in `NUMBER` (`src/ingest/extract.ts:102-112`); probe on zuzana m01 → `confidence: none, evidence: shipping-subject`. The note "no tracking number found" (`src/ingest/ingest.ts:248`) is false for the reader: there is one, of a carrier the app does not know. |
| AlzaBox mails never become parcels | Product (by design) | No carrier, no number; the comment at `extract.ts:395-398` names this exact case. Petra's run db: message 5 `parse_note = "no tracking number found … (its subject is about a shipment)"`. |
| Pickup codes only for Packeta Z-BOX | Product (F32, left on purpose) | `PICKUP_CODE` matches only "Kód pre otvorenie schránky" (`extract.ts:616`). Both kept run dbs: `pickup_codes` rows for DPD, GLS, posta and SPS parcels have `code NULL` after 2–3 messages checked. Probe: the real GLS fixture prints "PIN kód 000000", `extractPickupCode` → undefined. |
| DHL silent, never finishes | Product (F8, left on purpose) | Email-only mail becomes an event with `status: 'unknown'` and the parcel's status is never touched (`src/ingest/ingest.ts:185-194`); `buildNotifications` only fires on a transition and excludes `unknown` (`src/notify/rules.ts:94`); `isDue` is false for email-only carriers (`src/core/backoff.ts:52`). |
| COD amount not shown | Product | No handling at all: `grep -ri dobierk src/` is empty. Probe on power m23 shows "Suma na úhradu (dobierka): 89,90 €" in the SPS mail body. |
| Shop-cc'd customer dispatch mails become the seller's parcels | Product | Filter's last clause labels any sender whose subject says odoslaná/shipped (`gmail-filter.xml`, the `hasTheWord` value). A distinctive shape is trusted from any sender and the merchant is the From display name (`extract.ts:573-591`). Probe on martin m12 → `packeta Z6666666631, merchant "Bicykle Fiktív – e-shop"`. No check of the To header, no "ignore sender" rule. |
| Gmail filter misses Czech Zásilkovna and PPL | Product | `gmail-filter.xml` has no `zasilkovna.cz`, `ppl.cz`, `ceskaposta.cz` and no zasilka/pripravena/vyzvednuti/dorucena. Lucia's overview: every one of 17 Zásilkovna mails unlabelled. Note the app itself already knows `zasilkovna.cz` as Packeta (`extract.ts:72`): if labelled, those mails would parse. The fix is one line in the filter. |
| Returns shown as incoming | Product | No notion of direction anywhere in `src/`. The shop's return-instruction mail is not labelled (subject "Vrátenie tovaru" has no filter word), so the app first sees Packeta's own "prijatá do prepravy" and tracks it like any parcel; Packeta's "doručená príjemcovi" then reads as Delivered. |
| "Still waiting" reminder volume | Product (F30, left on purpose) | `NUDGE_SLOTS` 08:00 and 15:30 (`src/notify/nudge.ts:4`); every ready parcel is a candidate every run and fires at each passed slot (`rules.ts:83-87, 104-106`); every status transition notifies (`rules.ts:94`); no setting. |
| App "3 hours behind Gmail" | Product | Hourly slots (`src/core/schedule.ts:11-28`). A parcel idle more than 2 days is polled every 2.5 h, more than 7 days once per 20 h (`backoff.ts:8-9, 48-61`). Linking new mail to an existing parcel does not make it due: `isDue` is time-only (`src/core/poll.ts:149`). The sim's IMAP shows mail the minute it arrives, so this is not a sim lag. |
| History lost on move-in | **Sim** | The sim's move-in is a stub (`scripts/dev/persona-sim/daemon.run.ts:202`: `moveIn: async () => ({ ok: true })`) on an empty db; the real move-in copies the clone's db with SQLite online backup and carries config over (`app/move-in.ts:247-259, 290-297`). The "Archived — found in old mail" parcel is the sim ingesting a 40-day-old mail into a fresh db. |
| Blank Settings / "Gmail is not connected yet" after Move in | **Sim** | `completeSetup` fills IMAP config at 20:30 (`daemon.run.ts:211-222`). After a real move-in the config is already there. |
| Dashboard port 51376, bookmark dead | **Sim** | The sim deliberately picks a port that is not 8787 (`daemon.run.ts:542-550`); the app's default is 8787 (`src/core/config.ts:92`). |
| GLS ParcelShop card has no place or address | **Probably sim** | The mail-pickup reader anchors on "Odberné miesto:" at the start of a line (`extract.ts:670-675`). The sim's GLS template puts the bullet image on that line (same layout as FINDINGS F17). Probe: sim m36 → no point; the real scrubbed fixture `test/fixtures/mail/gls-ready-for-pickup.eml` → `locker ExampleBox … Príkladová 6`. Check with one real ParcelShop mail before dismissing. The missing PIN is product either way. |
| SPS Balíkovo card has no place | Product (by design) | "A template nobody has a real message for is deliberately absent (DHL, SPS)" (`extract.ts:667`); the SPS API answers `{kind:'parcelshop'}` with nothing. |
| "Parcel 1: 01505…" in a supplier mail not read | Product (bug) | `GLS_LABEL` allows only `[^\n\d]{0,30}` between the label word and the number (`extract.ts:209`), so the "1" in "Parcel 1:" defeats it. Probe on martin m06 → `confidence: none, evidence: carrier-named`. |
| "Assign" with an Alza order number made a GLS parcel | Product | Ten digits match GLS's shape and `DETECT_ORDER` ends with gls (`src/carriers/registry.ts:16`). The picker warns of nothing (expert F29). |
| "Nothing needs you." while mail waits on /attention | Product | The all-clear counts failed/problem parcels, not waiting mail (`src/web/views/index.ts:419-436`); the nav has no count (`src/web/views/layout.ts:35`). |
| Scam mails get a soft note and an "Assign" form | Product (F7 narrowed) | Look-alike note at `ingest.ts:215-217`; a stranger naming a carrier gets only "no tracking number found … (it names a carrier)" (`ingest.ts:248`). |
| Support bundle "OS: undefined", "Electron: not reported", "server.log (not present)", "restarted 0 times" | **Probably sim** | The sim passes `env: { node, platform, arch, hostname }` and `restarts: () => 0` (`daemon.run.ts:174-177`) and its log dir is empty. Worth one look at a real bundle. |
| No map on any pickup card | **Sim** | No network, no tiles (BUILD-REPORT, known limitations). |
| Collected time stamped "22:00" | Half sim | The persona clicked after `sim day` ended, so the clock said 22:00. That the mark takes the click time rather than the pickup time is product (`user_marks`). |
| Settings prefilled with 81101 before Welcome was submitted | **Sim** | The sim serves /settings before first-run completes; the real app opens Settings after Welcome. |
| "Mark as received" vs "Mark as collected" | Unclear UI | Wording depends on whether the parcel waited at a pickup point (`src/web/views/parcel.ts:189-198`). Two personas looked for the wrong word. |
| "Still waiting · day N": N of what? | Unclear UI | Days since the parcel reached the point (`rules.ts:44-50`). Not said anywhere the reader sees. |
| "Registered", "In flight", "Attention", "Health" | Unclear UI | Jan, zuzana, eva and lucia each misread at least one of these; see B-list. |

---

## 3. Ranked findings

Counts are personas out of 8, plus the expert where applicable. Severity is the worst any persona gave
it (their scale: blocker / major / minor; the expert's 0–4). Effort is from the code: S under a day,
M a few days, L a week or more or needs data the app does not have.

### A. Bugs: the app is wrong

| # | Finding | Personas | Severity | Effort | QW |
|---|---|---|---|---|---|
| A1 | **The all-clear lies when mail waits on /attention.** "3 in flight. Nothing needs you." (petra day 2, 21:00) and "Nothing in flight. Parcels appear here when a shipping email arrives" (petra day 12, 21:00) while an AlzaBox pickup with a 4- and then a 3-day deadline sat on /attention. No count in the nav, no line in the lede. Zuzana: "I never found out from the nav bar that 4-8 mails were sitting there." | petra, zuzana, eva (3) | major | S: count undismissed attention mail in the lede ("1 email needs a look") and show the number on the Attention tab | yes |
| A2 | **New mail about a known parcel does not make the app look at it.** Zuzana day 10: Packeta mails at 07:14 and 07:19, she stood at the box at 07:40, the app said ready at 08:00 and 10:00. Day 7: mail 08:09, banner 11:00. Power: "up to 1.5 h, the same as my hourly launchd poller." Expert F13. Root cause: `isDue` is time-only and old parcels sit on 2.5 h / 20 h tiers; a Packeta "ready" mail about one of them changes nothing until its tier comes round. | zuzana, power, eva (3) + expert | major (zuzana: a second trip; the menu bar showed 0 while two parcels were in the box) | S: in `runIngest`, collect the parcel ids that this run's mail linked to and poll them in the same run, as freshly created parcels already are (`poll.ts:52-57`). Polling mail every 15 min (expert) is a separate, bigger change. | yes |
| A3 | **Email-only (DHL) parcels: every mail is silent and the parcel never finishes.** Tomas day 2: "Clo a DPH na úhradu, Splatnosť 03.11.2026" (due the same day), no banner. Day 3 and power day 10: "has been delivered" appended to the timeline, card stays at the top of In flight, lede says "1 has no status; read its latest message" under a card that already shows the message. Power's History then says "Received 12 Nov" (his click) not 11 Nov (DHL's mail). Deliberate (F8), but both personas who met it rated it major and the customs case is money with a deadline. | tomas, power (2) + expert F3 (3/4) | major | S: a banner whenever an email-only parcel gains a mail event, with the mail's subject as the text (the `eventText` is already stored). M: a keyword map (delivered/doručená) that *suggests* "Mark as received" on the card, and let the mark take the mail's date. | banner yes |
| A4 | **A numbered label hides the number.** CykloParts' "Parcel 1: 01505666666605 / Parcel 2: 01505666666606" lands on /attention as "no tracking number found (it names a carrier)"; the parcel appears a day later from DPD's own mail; the attention item then stays there stale. The "1" after "Parcel" is what breaks `GLS_LABEL`. Then "Assign to a parcel" takes one number and the mail leaves the queue, so the second box goes through /add with the name retyped. | martin (1) | major ×2 | S: allow `\s*\d{1,2}` after the label word; S: when assigning, offer every number the mail prints; M: when a parcel is created from carrier mail, auto-link earlier attention mails that print its number | yes |
| A5 | **Attention wording is false for unsupported carriers.** "no tracking number found in this message (its subject is about a shipment)" on an AliExpress mail that prints "Tracking number: LP00333333333309". Zuzana left seven of them there for 14 days because dismissing "mail with my earbuds in it" felt wrong. Same for lucia's PPL mail ("it contains something shaped like a tracking number", which she read twice). | zuzana, lucia (2) | major (zuzana: the whole AliExpress use case), minor (lucia) | S: when a number-like token follows a "tracking" label, say "has a tracking number (LP00…) of a carrier Parcels cannot track"; see C4 for actually tracking them | yes |
| A6 | **A seller's own dispatch copies are tracked as his parcels.** Martin day 4, 10:00: "Ready for pickup — Bicykle Fiktív – e-shop … Z-BOXe", blue card on top, menu-bar 1, "Still waiting" at 15:30, for a customer's parcel 100 km away. Four deletions in 14 days, one per order shipped. The mail is a "Kópia:" addressed to the customer from his own domain. Only exits: Delete (no undo), "Mark as received" (a lie), rename. | martin (1) | major, "close to blocker" | S: a sentence on the Settings guide and in the filter comment for sellers ("add `-from:yourshop.sk`"); M: an "ignore this sender" rule in Settings (one click from the parcel or attention card); M: treat a labelled mail whose To is not the account's address as not mine | doc yes |
| A7 | **A return is tracked as an incoming parcel.** Petra day 6: "Registered — Z5555555505", no shop, no name, in the same list as incoming; day 8: "Delivered — Z5555555505 · Zásielka bola doručená príjemcovi"; History: "Delivered 9 Nov" among her purchases. Packeta's mail says "pre príjemcu Topánočky s.r.o.". | petra (1); the earlier corpus run saw it too | major | M: read "pre príjemcu <name>" / recipient ≠ me from Packeta's mail, mark the parcel outgoing, title it "Return to Topánočky", keep it out of ready counts and show "Arrived at Topánočky" instead of Delivered | — |
| A8 | **"Assign" guesses GLS for an Alza order number.** Petra day 13 typed the only number the Alza mail has (1051500013); Detect made "GLS · 1051500013 / No updates yet". The picker says "Detect from number" and nothing about when detection cannot work. | petra (1) + expert F29 | major (petra), 2/4 | S: one hint under the picker; refuse Detect for a number that also matches a known shop's order-number shape | yes |
| A9 | **Duplicate-add message is wrong after delivery.** "Already tracking 090444444405 (GLS) as #6." for a parcel delivered a week earlier; echoes the leading zero the app does not store; "#6" is not a link. | power (1) | minor | S | yes |
| A10 | **Support bundle gaps** ("OS: undefined", "Electron: not reported", "server.log (not present)"), "restarted 0 times" right after a restart, no activity-log line for the update, renames and the move-in. | tomas, power (2) | minor | S if real; probably the sim's stubs (§6) | check first |

### B. Usability and comprehension

| # | Finding | Personas | Severity | Effort | QW |
|---|---|---|---|---|---|
| B1 | **Notification volume, and no way to change it.** "Still waiting for you · day N" at 08:00 and 15:30 for every ready parcel, "Registered" and "In transit" for every parcel, "Delivered" for parcels the user collected an hour before (zuzana day 4: three at 08:00; day 14: four of six), identical pairs for a split order (power), three separate nags at the same minute (petra). From ~5 updates they collapse into "N parcel updates" with a run-on body. Jan: "I could not switch them off before collecting." Eva: "15 nags in 4 days for parcels I could not reach; they buried the one that mattered (Pickup deadline approaching)." Expert: 33 banners in 14 days, 12 actionable. Tomas: "nagging, not reminding" (a nudge 90 min after the ready banner). Corpus runs with no pickups: 25 to 131 banners per persona. | all 8 + expert F4 | major (eva); uninstall trigger (jan, eva, zuzana "I'd mute it and then it's useless") | S: defaults of one reminder a day (the 08:00 slot), Registered/In transit off, no Delivered banner within an hour of the user's own Mark as collected; a Settings block with those three switches. M: one banner per pickup place ("2 parcels waiting at Z-BOX Billa") | yes |
| B2 | **English chrome over Slovak/Czech carrier text.** "Registered — Knihy Pre Vás / Podanie zásielky". Jan: "it's all in English" is in his uninstall list; "Attention", "Health", "In flight" meant nothing to him. Lucia noticed Slovak forms in Czech mail (the carrier's text, not the app's). | jan, zuzana, lucia (3) + expert F19 (2/4) | minor each; blocker-adjacent for jan's type | M: ~60 strings; status words map one-to-one | — |
| B3 | **Parcels named after the shop or a bare number.** "Knihy Pre Vás" (jan looked for the book), "Notino" ×3, "Bambulka" ×2, "Hračky Kocúrik" vs "Hračky Kocúrik # K-7781" for one order, "Velo Distribúcia" ×2, "EB444444074SK", "7034444444444406", "JJD000444444444408" as the h1 though the mail says "od Nábytok Domov" / "from FAKE TOOLS GMBH". Petra renamed 12 parcels by hand. | jan, petra, martin, lucia, eva, power (6) + expert F7/F8/F15 | minor each, but constant | S: sender-name fallbacks for SPS/posta/DHL ("od <name>", "from <name>"), order number on the card, "(1 of 2)" for a split order; M: item names from the shop mail's item list | partly |
| B4 | **The scam note does not say scam.** Packeta look-alike: "the sender calls itself Packeta but writes from packeta-sk.example.com … Assign it if you trust it." Posta customs look-alike: only "no tracking number found (it names a carrier)", the same grey line as harmless mail. Jan: "a less careful person could pay." Tomas: "it lends the mail credibility by filing it as parcel-related with an Assign form under it." | zuzana, jan, tomas, eva (4) | major (jan), minor/major (zuzana) | S: one sentence on such cards, in Slovak too: "Parcels does not know this sender. Carriers never ask for fees through a link in e-mail." Hide the Assign form behind a disclosure for look-alikes | yes |
| B5 | **Attention page jargon.** "Emails that did not yield a parcel", "Assign one to a parcel, or dismiss it as junk", "Detect from number", "Dismiss … deletes the stored copy". Jan pressed nothing; zuzana skipped it ("too much for a ten-second look"); eva: "I don't know what assign means." | jan, zuzana, eva, lucia (4) | minor | S wording | yes |
| B6 | **History (and Health) tables cut off at 390 px.** Outcome and Date fall off the right edge with no scroll hint; Health at 390 px wraps letter by letter (expert: a 6000 px page). | petra, martin, eva, power (4) + expert F20 (2), F22 (3) | minor | S: list rows below 40 rem | yes |
| B7 | **Reminders go on after a counter pickup until "Mark as collected".** Slovenská pošta reports a pickup the next morning or never; zuzana and power got "Still waiting · day 2/3" for a parcel on their desk. The README explains it; the banner does not. | zuzana, power (2) + expert F5 | minor/major | S: end the nudge text with "Collected it? Mark it in the app to stop these." M: a Collected action on the banner (Electron notification actions on macOS; check it works unsigned) | text yes |
| B8 | **"Mark as received" vs "Mark as collected"** on the same page layout, depending on state. | jan, petra (2) | minor | S: one verb, or both words on the button | yes |
| B9 | **"Still waiting · day N" does not say what N counts.** | jan, lucia (2) | minor | S: "waiting since Tue" | yes |
| B10 | **Menu-bar number counts parcels everywhere.** Zuzana at Lesná: 4, but one was at the other Z-BOX; eva in Košice: 3 she could not touch. Expert F32: a courier at the door today does not change the icon. | zuzana, eva (2) + expert | minor | M: by design; a tooltip "3 at Lesná, 1 at OC Centrum" is S | — |
| B11 | **Move-in docs leave the power user guessing** about his CLI, the 8787 bookmark, terminal-notifier and parcels.local. (The bookmark works: the app's default port is 8787.) | power (1) | major for him | S: one README paragraph | yes |
| B12 | **Settings understates what the App Password can do** ("lets this app read that label without your Google password") where the README says it can read and send as the whole account. Update page claims a signature check and never shows that it ran; the changelog says the check is new, which reads as if the installing version lacked it. No "Uninstalling" section anywhere (quit, trash, two Library folders, revoke the password, delete the filter and label). | tomas (1) | major for trust (his uninstall trigger) | S each | yes |
| B13 | **Refresh now's no-op text reads as a list of faults** ("each parcel here is paused (its carrier is failing, or its postcode was rejected) …"). Jan pressed Refresh on day 2 and got "No new mail. Nothing is in flight yet.", which was fine. | expert F9, jan | 2/4 | S | yes |
| B14 | **Parcel page at 390 px puts Delete above Mark as collected, Name and Postcode.** | expert F14, FINDINGS F35 | 2/4 | S | yes |
| B15 | **"Technical details" with five identical JSON blobs** on every parcel; "carrier says:" meta line repeats the timeline. | martin, expert F17/F18 | minor | S | yes |

### C. Missing capabilities that block day-to-day use

| # | Finding | Personas | Severity | Effort | QW |
|---|---|---|---|---|---|
| C1 | **Pickup PIN or code on the card for every carrier, not only Z-BOX.** DPD Pickup Station PIN (zuzana, petra, tomas), GLS ParcelShop/BOX PIN (zuzana, petra, martin, eva, power), BalíkoBOX PIN (zuzana, petra, eva), SPS Balíkovo verification code (petra). Tomas found the admission in the app's own run log: "1 new, 0 parcel(s) created, 0 pickup code(s) found". Every one of them opened Gmail at the counter. The `pickup_codes` pass already reads each ready parcel's mail; it just has one regex. | zuzana, petra, martin, tomas, eva, power (6) + expert F1 (4/4) | major | S–M: one regex per carrier ("PIN: 448203", "PIN kód 914270", posta's "PIN", SPS "verifikačný kód"), a `kind` so the card can say "Show PIN 914270 at the counter" instead of "Open the box with" | yes |
| C2 | **Cash-on-delivery amount** on the card and in the banner. Zuzana went to the Trafika not knowing she would pay 24,90 €; jan 18,50 € at the counter; martin needs 312,40 € in the till; power's courier wanted 89,90 €. The amount is in every one of those mails ("Na úhradu pri vyzdvihnutí", "Suma na úhradu (dobierka)", "dobierka 312,40 €"). | zuzana, jan, martin, power (4) + expert F2 (3/4) | major | M: regex per carrier for dobierka/na úhradu + amount, a column, one line on card and banner ("· 24,90 € in cash") | — |
| C3 | **Courier window, next attempt and redirect link.** "Out for delivery — Kuriér doručuje" with no hour while the DPD/GLS mail says "10:30 – 11:30" / "medzi 9:00 a 12:00" (jan: whether to skip his walk; martin: his shop was shut at noon). After "Delivery attempt failed" nothing about "nasledujúci pracovný deň" or presmeruj.mojbalik.sk (eva could have redirected from the hotel). | jan, petra, martin, eva, power (5) + expert F6 | major (jan, martin, eva) | M: extract `HH:MM – HH:MM` / `medzi H a H` and the redirect URL from the labelled mail; show on the out-for-delivery and failed cards and banners | — |
| C4 | **AlzaBox, and other "code-only" pickups the app cannot track.** Petra's most frequent shop, with the shortest deadlines, is exactly what the app skips. Same shape: AliExpress LP numbers until Packeta takes over (zuzana never learned which "AliExpress (Cainiao)" was the LED strip). | petra (2 moments), zuzana (1) | major | M: an "untracked pickup" parcel created from a shop mail that prints a code and a deadline (no polling; it counts in the menu bar; closed by hand or by the shop's "vyzdvihnutá" mail). The Alza "vyzdvihnutá" mail is not labelled today ("vyzdvihnuta" is not in the filter). | — |
| C5 | **Czech mail.** One line in the filter (`zasilkovna.cz`, `ppl.cz`, `ceskaposta.cz`, zasilka/zasilku/pripravena/vyzvednuti/dorucena/odeslano) would make Zásilkovna visible; the app already parses its mail. PPL and Česká pošta need adapters. "Gmail address" + `you@gmail.com` made lucia (a `.cz` address) and martin (Workspace) unsure the app would take them at all. | lucia (1; martin for the address) | major ×3 | S filter + a CZ variant of the guide; L for PPL/Česká pošta adapters | filter yes |
| C6 | **"Not mine / ignore this sender"** for sellers and anyone whose mailbox gets other people's dispatch mail. | martin (1) | major | M (see A6) | — |
| C7 | **Opening hours, and "last day" on an open day.** Petra wasted a Sunday trip to a ParcelShop (Mon–Sat 08–19); martin's return said "last day Sun 15 Nov" for a counter shut on Sundays and Add to Calendar pre-selected Sunday 9:00; eva's calendar offered "Today, from 13:00" on a Sunday; power's post office card gave no closing time. The app has no hours data. | petra, martin, eva, power (4) | major (petra, martin) | L: Packeta's point API may give hours; GLS prints "Otváracie hodiny:" in its mail (the real fixture does); posta has fixed hours per office. Even "closed Sun" per kind would fix the calendar defaults. | — |
| C8 | **Returns recognised as returns.** See A7. | petra (1) | major | M | — |
| C9 | **Multi-parcel orders in one form.** See A4. | martin (1) | major | S | yes |

### D. Nice-to-have ideas (one persona unless noted; each is a hypothesis until a real user asks)

- **"You'll be away when this expires."** Eva's whole worry; her thermos went back while she was in Košice and the app "knew" the deadline. Manual away dates (M) or calendar-aware (L). She also wants an "away" mode that keeps deadlines and failures and mutes nags.
- **One daily summary at a chosen hour** instead of per-event banners (zuzana, petra, eva: 3). Cheap once B1's switches exist.
- **A "today's round" view**: ready parcels grouped by place with hours, sorted by the place I pass (zuzana, petra: 2). The Z-BOX grouping already does half of it.
- **Code or PIN in the ready notification**, or a "Show code" action (petra); tomas explicitly prefers it *off* the lock screen. A setting.
- **Pickup person**: "for Klára" / "husband fetches" tag (lucia, petra: 2).
- **Contents on the card** from the shop mail's item list (eva, petra, zuzana, jan: 4, overlaps B3).
- **Business mode** (martin): Supplier/Return tags, a filter for each, only Ready/Failed/Delivered banners, CSV export, order number on the card.
- **Show the source e-mails on the parcel page** (power, FINDINGS F33), and a "see it in Gmail" link (martin).
- **DHL expected delivery date** from the mail's prose (tomas, power: 2).
- **Update page**: signature result, certificate name, SHA-256, release link (tomas). **"What Parcels sends where"** page in the app with the switches beside each (tomas).
- **A documented CLI against the app's data** (power).
- **Let the mark take a time** ("collected this morning at 09:30"), and no 07:00 banners before breakfast (jan).
- **Health**: collapse quiet runs, move Update and Support above the logs (expert F23, power).
- **First run**: offer "skip Gmail, add one parcel by hand" so a friend who gives up at the App Password still has a working app (zuzana, expert §3 point 7).

---

## 4. The setup and first-run funnel

Nobody really did it: the simulator switches setup on at 20:30 on day 0. Every judgement below is a
persona reading the first-run page, README "Install the app" and Settings and saying where they would
stop. That is still the most useful part of this test, because those pages are all a friend has.

| Step | Who stops here, and at what word | Estimated drop-off | What would cut it |
|---|---|---|---|
| **Download from GitHub Releases, pick arm64/x64** | Nobody said so, but the expert gives it 15 %: a release page is a foreign surface and "arm64" means nothing | ~15 % of non-technical friends | A single link that picks the right file, or one universal DMG |
| **Gatekeeper: "cannot check Parcels for malicious software" → Done → System Settings → Privacy & Security → Open Anyway → password → Open Anyway again** | zuzana: "I'd stop here the first time ('malicious software' = I don't want to touch it)". petra: "made me nervous". jan: did not get this far on his own. eva: "long but click-by-click". tomas: would go on but "at Open Anyway I would want a hash on the release page". martin, lucia, power: fine | expert: 35 %. Of the 8, two would stop, two would hesitate | Signing + notarising (Apple Developer account, a one-time setup and a yearly fee) removes the step and the word "malicious". Until then: publish a SHA-256 on the release, and keep the README's exact click path (it is good) |
| **Welcome page: postcode** | Everyone passed. Three wrote "999 31" with a space and wondered (it is accepted) | ~0 | "Five digits, like 81101 or 999 31" |
| **Settings → "How to connect Gmail — three steps, about five minutes": download gmail-filter.xml → Gmail settings → Filters → Import → Choose File → tick Apply to existing → Create → Labels → Show in IMAP → 2-Step Verification → App passwords → Create → copy → paste** | **zuzana**: "Tick Apply new filters to existing email", "Show in IMAP is ticked", "2-Step Verification has to be on", "16-letter password" (field says 16-character); "5 minutes becomes 30 and I never reach Paste it here". **jan**: "filter", "IMAP", "App Password", "2-Step": "I would have stopped at the first English word I did not know and phoned my daughter". **petra**: twelve flat bullets, "Label your shipping emails." reads like a heading not an action; calls her husband at "Make an App Password". **eva**: "more like 20 minutes; I'd stop at Make an App Password; not a one-sitting job before a trip". **lucia**: "where I'd call for help"; and the filter is Slovak-only. **martin**: fine, but "Gmail address / you@gmail.com" vs his Workspace domain, and the filter would label his own shop's mail. **tomas**: fine, but the credential sentence is softer than the truth. **power**: n/a (move-in) | expert: 40 % cumulative. Of the 8: **five would not finish alone** (zuzana, jan, petra, eva, lucia) | 1. Three numbered groups with bold headings, "you are here", honest time ("about ten minutes on three Google pages"). 2. **Show in IMAP** in bold and repeated under the label field (the README itself calls it "the step that catches everyone"). 3. Test result beside the password field, "Spaces are fine", and the empty-label answer naming the two ticks to check. 4. A Slovak (and Czech) version of this one page. 5. One line for Workspace and non-gmail.com addresses ("any Google account works; a company account may need the admin to allow App Passwords"). 6. For sellers: "add `-from:yourshop.sk`". 7. A printable one-pager so the daughter/colleague can do it in one visit. 8. "Skip for now, add a parcel by hand" so the app is not empty when they give up here |
| **Save → "Saved. Connected, nothing to read"** | Reassuring for petra, martin, expert ("the best piece of setup copy in the app"). Not above the fold on a short window | ~5 % | Put the test sentence next to the field |
| **Wait for the first poll** | jan day 2: "Nothing in flight" → pressed Refresh now (good). Expert F27: an empty In flight is indistinguishable from a failed setup | ~10 % | After the first successful save: "Connected. Your parcels appear at the next check (21:00) — or Refresh now." |
| **Move in (power user)** | power: the page is good; the README is excellent on launchd; nothing about the CLI, bookmark, terminal-notifier, parcels.local. "Going back" needs Terminal, which the move-in page does not say | — | One README paragraph (B11); "Going back needs Terminal" on the move-in page (expert F34) |

**By persona type:** a developer or a security-minded friend (tomas, power, martin) gets through. An
office worker who buys a lot (zuzana, eva) stops at the App Password unless someone sits beside them.
A parent with twenty minutes (petra) stops at the same place. A retiree (jan) does not start. A student
abroad (lucia) could do it but the filter would then show her almost nothing. Rough expectation for
"the author's friends": one in three unaided, as the expert says; two in three with a phone call at the
App Password; nobody after the Gatekeeper dialog without the README open beside them.

---

## 5. Verdicts

| Persona (model) | Score | Keep? | Uses today | Would uninstall for | One line to a friend |
|---|---|---|---|---|---|
| zuzana (Sonnet) | 6 | maybe | Packeta and DPD apps, Gmail search "balík", codes in phone notes | repeating the Gmail setup; a parcel missed because the app was behind; the notification spam | "Good number in the menu bar for Z-BOX parcels, but for AliExpress and the post office you still dig through Gmail." |
| jan (Haiku) | 5 | maybe, if the daughter sets it up and turns reminders down | nothing; reads the post's Slovak mails | banners twice a day; an unexplained payment mail; the App Password steps again | "It tells you when your book is at the post office, but it's all in English, pesters you twice a day, and doesn't say to bring ID and cash." |
| petra (Sonnet) | 5 | maybe | carrier apps and SMS, Gmail search "Alza"/"Notino" | one more missed AlzaBox/pickup; a parcel the menu-bar number did not count | "Great for Packeta boxes, but it silently skipped my Alza pickups, so don't rely on it yet." |
| martin (Opus) | 6 | maybe, only if his own orders stop showing up | Gmail search + GLS/DPD sites; waits for Packeta's mail for returns | a "Ready for pickup" for a customer's parcel sending him to a counter for nothing; a week of deleting his own orders | "Good at telling you when supplier stuff lands, but if you run a shop it thinks your customers' parcels are yours." |
| lucia (Haiku) | 5 | maybe | Gmail search; no carrier app | another parcel she learns about from a flatmate; a missed deadline because the app said nothing | "Handles Packeta pickups well, but misses PPL and any unlabelled Zásilkovna mail, so keep checking Gmail." |
| tomas (Fable) | 6 | maybe; yes once the credential text and the update page tell the truth; until then on a spare Mac with a second account | Gmail search, carriers' tracking pages | an update with no visible verification; the bundle or log carrying a mail address; a network destination the README does not list | "The README tells you more about what it does with your mail than Google's App Password page does; the app is quiet where it should be loud." |
| eva (Sonnet) | 6 | maybe; yes if setup were someone else's job and it learned she is away | Gmail search "balík", carrier SMS | more days of nags she cannot act on; another parcel lost while the app "knew" | "Keeps all your parcels in one place and warns you about the fake ones, but it still doesn't know you're out of town." |
| power (Opus) | 7 | **yes, probably**; keeps the clone and launchd-backup for now | the Terminal install of this tool + Gmail | an update or move that loses data (a sim artifact, see §6); no CLI path at all | "The Terminal Parcels without the babysitting; keep Gmail open for PINs and COD." |

Mean **5.75**. Keep 1, maybe 7, drop 0. The expert gave no score; their top recommendation list matches
§1's table almost one for one.

What they would all keep: the Z-BOX card and the menu-bar number. What seven of eight said in some form:
"for everything except Packeta boxes I still need Gmail."

---

## 6. Simulator artifacts excluded from the findings

These were reported by personas but come from how the simulator fakes the world. They are not in the
A–D tables.

1. **"Move-in didn't bring my parcel history"** (power, major), the three "fresh install" banners at
   20:30, the parcel "Archived — Found in old mail; never tracked", the empty medians on day 14. The
   sim's `moveIn` is `async () => ({ ok: true })` on an empty database (`daemon.run.ts:202`); the real
   one copies the clone's database with SQLite's online backup, checks its integrity and carries the
   config over (`app/move-in.ts:247-297`). Power's trust worry ("if a move eats my history, what does
   an update do?") is therefore unfounded, but a real move-in has not been exercised by this test.
2. **Blank Settings, postcode 81101 and "Gmail is not connected yet" right after Move in** (power,
   expert F10). The sim fills IMAP config at the 20:30 "setup" (`daemon.run.ts:211-222`). After a real
   move-in it is already there. Expert F10's suggestion ("Gmail is connected; first check at 21:00 —
   Refresh now") still applies to a *fresh* setup (B-list, §4).
3. **Dashboard port 51376** (power: "my 8787 bookmark is dead"). The sim avoids 8787 on purpose
   (`daemon.run.ts:542-550`). The app's default is 8787 (`src/core/config.ts:92`). The README should
   say the bookmark keeps working (B11).
4. **No map on any pickup card** (tomas, power). No network and no tiles in the sim (BUILD-REPORT,
   known limitations). Tomas's small point stands: say "map not available" rather than nothing.
5. **Support bundle "OS: undefined", "Electron: not reported", "server.log (not present)"** and
   **"restarted 0 times" after an update restart** (tomas, power). The sim's `support.env` has no OS
   field, its `restarts` is a constant 0, and its log folder is empty (`daemon.run.ts:174-177`). Check
   one real bundle before closing A10.
6. **GLS ParcelShop/BOX card with no place and no Maps link** (zuzana, petra, martin, eva, power,
   half of expert F1). Probably the sim's GLS template: it prints the bullet image on the same line as
   "Odberné miesto:", which defeats the line-start anchor (`extract.ts:670`), exactly the case FINDINGS
   F17 describes. The real scrubbed GLS fixture yields a full pickup point in the probe. **The missing
   PIN is product** (C1). Verify with one real ParcelShop mail; the fixture is a GLS BOX.
7. **Gmail labelling.** The sim re-implements Gmail's filter rules (`lib/gmail-filter.mjs`). Every
   "labelled / not labelled" verdict is as good as that re-implementation. The two findings that lean on
   it (lucia's Czech mail, martin's own-shop copies) are also derivable from the filter text, so they
   stand; exact edge cases (diacritics, whole-word matching) are not proven against Gmail.
8. **Setup is a switch.** No persona made an App Password, imported the filter or ticked Show in IMAP.
   §4 is reading comprehension, not a measured funnel.
9. **Clock within a day.** Personas who acted after `sim day` ended did so at 22:00, hence "Collected —
   Sat 7 Nov, 22:00" (zuzana) and lucia's "the app still counted the sweater as ready" after a 22:00
   pickup: no poll runs after 21:00, and Zásilkovna's pickup mail is unlabelled anyway; the next
   morning's carrier poll would have cleared it. That the mark takes the click time is product (D-list).
10. **Settings prefilled with 81101 before Welcome was submitted** (tomas, lucia). The sim serves
    /settings early; the real app opens Settings after Welcome.
11. **Always-awake Mac.** Every slot ran. Real notification counts will be lower on a laptop that sleeps,
    and B1's "one reminder on waking" logic was not exercised.
12. **The expert and power share one scenario**, and the expert observed power's live instance for days
    3–14 before running their own. Their findings on that scenario are correlated, not independent.

What is **not** an artifact, though it looked like one: the "3 hours behind Gmail" (A2) is the
product's hourly slots plus per-parcel backoff; the sim's mailbox shows mail the minute it lands.

---

## 7. Caveats, and questions for real friends

**What this test can tell you.** Where the copy loses a reader (the quotes are real strings from the
pages). Which facts the app does not surface although its stored mail has them (verified in the
code and the run databases). How the notification rules feel across 14 days of plausible mail. What a
Czech mailbox or a seller's mailbox does to the filter. Where the parser's assumptions about mail layout
are thin.

**What it cannot tell you.** Whether a real person finishes the Gmail setup, and how long it takes.
How real Gmail labels real mail. How real GLS, SPS and DPD templates render (the synthetic templates
already produced one false alarm, §6.6). How banners look and feel on a real Mac, or whether anyone
mutes them on day 3. Whether carrier APIs behave as the fake world does. How much the move-in and the
update actually keep.

**Model bias.** All nine are language models. The Opus and Fable personas (martin, power, tomas,
expert) wrote three times as many findings as the Haiku ones (jan, lucia), so "number of personas"
undercounts jan's and lucia's kind of user, who are exactly the friends most likely to drop out at
setup. Lucia wrote her diary after the run. The scenarios were authored to put COD, PINs, scams, DHL
and deadlines in front of the personas on purpose, so "8 of 8 met X" means the scenario contained X,
not that X happens weekly in real life. Severity words ("major", "blocker") are the model's judgement
of a fictional person's patience. Treat counts as a ranking signal, not a measurement.

**Questions for 2–3 real friends after one real week** (derived from the top findings):

1. *Setup, timed.* "Did you finish Gmail and the App Password on your own? At which word did you stop or
   call someone? How many minutes, and which Google page was open longest?" (B-list §4; decides whether
   to spend on notarising and on rewriting the guide.)
2. *The counter test.* "How many times this week did you open Gmail while standing at a box or a
   counter, and for what: a PIN, the shop's name, an amount, opening hours?" (C1, C2, C7.)
3. *The silent miss.* "Was there a parcel the app never showed you, or showed too late? How did you find
   out: a phone push, a flatmate, the shop's mail?" (A1, A2, C4, C5.)
4. *The mute day.* "On which day did you mute Parcels or want to? Which banners did you actually act on,
   and which did you swipe away?" (B1.)
5. *The lag.* "Did your phone's Packeta/DPD push ever beat the menu-bar number by more than an hour, and
   did you make a trip because of it?" (A2.)
6. *Money at the door.* "Did any parcel come with cash on delivery or a courier time window this week?
   Where did you learn the amount or the hour?" (C2, C3.)
7. *The scam card.* "Did anything land on Attention that asked for money? What did the app's note make
   you think the mail was?" (B4.)
8. *Language.* "Read me the status words on the dashboard in Slovak. Which ones did you have to think
   about?" (B2.) And for a seller or a Workspace account: "Did any mail you *sent* show up as a parcel?"
   (A6.)
