# Findings: fake parcel-mail corpus run end to end

**Run.** 77 synthetic mails (`MANIFEST.md`) went through the real `runPoll` path (`src/core/poll.ts`): real
ingest (`ingestMessages`) with the read-only IMAP fake, real extraction, real pickup-code and pickup-point pass,
and real notification rules. The carriers were fake adapters answering from a canned world (`scripts/dev/fake-mail/world.ts`).
The clock stepped through 64 runs: the app is set up 2026-10-15 09:00, then four runs a day until 2026-10-30 21:00.
After that the real web server rendered every page, with the clock at 2026-10-30 21:30. Evidence is in `out/`:
`RESULTS.md` (per-mail expected vs actual, parcel table, run log, every notification), `parcels.json`,
`messages.json`, `notifications.json`, `poll-calls.json` and `probes.json` (targeted `extract()` probes).
HTML is in `html/`, screenshots in `shots/`. **Zero network attempts** were recorded by the guard: fetch,
http/https/tls, dns and non-loopback `net.connect` all throw.

**Totals.** 77 mails → 76 stored (one exact duplicate by Message-ID). 30 parcels: 16 in flight, 11 delivered,
1 returned, 2 archived on arrival. 12 on /attention, 1 ignored, 78 notifications, 646 carrier polls.
10 of 77 mails did not do what the corpus expected.

**After Task 13's fixes (re-run 2026-10-30, same corpus and harness):** 77 mails → 76 stored. 34 parcels: 20 in
flight, 11 delivered, 1 returned, 2 archived on arrival. 9 on /attention, 1 ignored, 77 notifications, 733 carrier
polls, 0 network attempts. **1 of 77** mails did not do what the corpus expected: `52-…` (F9, a design choice left
as it is). Fixed: F1–F7, F10, F11, F15, F16, F19, F22–F26, F28 (each finding below has its commit and regression
test). Not fixed: F17 (see its status). The rest are questionable / design choices, unchanged by ruling R19.
The three real company details the templates had carried (DPD SK's and Slovenská pošta's head-office addresses and
infolines, a DHL service number) were replaced with invented ones; the run's results did not change.

**Severity**: High = a parcel is lost, invented, or the UI tells the user something false about it;
Medium = wrong or misleading in a way a user will meet; Low = cosmetic, or rare. **Kind**: *bug*, or
*questionable / design choice* (where the code's comments say it is deliberate, that is noted).

---

## High

### F1. GLS's own mail parses only by luck: `gls-slovakia.sk` is not a known sender, and the fallback needs the number on the label's line. *bug*
- **Status (Task 13): fixed** in `b60aae4`; regression test `test/fake-mail-regressions.test.ts` › "F1: GLS Slovakia's own mail is a carrier sender …".
- **Input:** `20-gls-ready-glsbox-pin.eml`, `61-outlook-forwarded-gls-reminder.eml`. Also the repo's REAL scrubbed fixture `test/fixtures/mail/gls-ready-for-pickup.eml`, which comes from the same domain.
- **Expected:** a mail from GLS Slovakia is `confidence: sender`, and the number is found in the body.
- **Actual:** `SENDER_DOMAINS` lists only `gls-group.eu` / `gls-group.com`, so GLS's mail takes the e-shop path (`namedBareNumbers`). That path needs `GLS_LABEL` to match `[^\n\d]{0,30}$` right before the number. GLS prints `Číslo balíka:` and puts the number on the **next line**, so the body never matches. It works only because GLS's subject happens to read `Balík <number> …`. `out/probes.json`: `real_gls_fixture_subject_without_number` → `{confidence: none}`. Mail 61 (body `Číslo balíka:\n90444444401`, no number in its subject) lands on /attention.
- **Where:** `src/ingest/extract.ts:58` (domain list), `:130` (`GLS_LABEL`, newline excluded), `:168-177`.

### F2. A GLS parcel is named after GLS's domain: "gls-slovakia.sk". *bug*
- **Status (Task 13): fixed** in `b60aae4`; regression test `test/fake-mail-regressions.test.ts` › "F2: a GLS parcel is named after the shop GLS prints …".
- **Input:** `18-…`, `20-…`, `69-gls-…` (parcel 10).
- **Expected:** the sender's shop (the mail says `Odosielateľ: Hračkáreň Kocúrik`), or the number.
- **Actual:** the card title, the parcel page heading and 13 days of notifications all say `gls-slovakia.sk`. For example: "Ready for pickup — gls-slovakia.sk", then "Still waiting for you · day 13 — gls-slovakia.sk". The shape path falls back to the sender's domain whenever the envelope has no display name, and GLS's real From header has none.
- **Where:** `src/ingest/extract.ts:408-411`. There is also no GLS entry in `MERCHANT` (`:345-351`).
- **Screenshot:** `shots/dashboard-1280.png` (third card), `shots/parcel-10-gls-90444444401-1280.png`.

### F3. Delivered and returned parcels still show the pickup deadline, in red ("deadline passed") or blue ("6 days left"). *bug*
- **Status (Task 13): fixed** in `5b3de5f`; regression test `test/fake-mail-regressions.test.ts` › "F3: a collected or returned parcel shows no "Collect by" line".
- **Input:** P1 (`36-packeta-pickedup.eml`), P2 returned (`49-…`), P3 (`70-…`), P5 (`60-…`), CZ (`62-…`), posta (`68-posta-delivered.eml`).
- **Expected:** once a parcel is collected or returned, there is no "collect by" line.
- **Actual:** the parcel page's pickup panel prints `Collect by Fri 23 Oct · deadline passed` in the warn colour on five finished parcels. On parcel 18, delivered 29 Oct, it prints `Collect by Thu 5 Nov · 6 days left` in signal blue, which tells the user to go and collect a parcel they already have. The clock is computed whenever `retainedTill` is set, not only while the parcel is ready (`p.retainedTill || ready`).
- **Where:** `src/web/views/parcel.ts:113`.
- **Screenshot:** `shots/parcel-08-packeta-Z2222222201-1280.png`, `-11-dpd-…`, `-12-packeta-…`, `-15-…`, `-16-…` (red), `shots/parcel-18-posta-EB666666011SK-1280.png` (blue).

### F4. A carrier mail that lists two parcels tracks the first and silently drops the second. *bug*
- **Status (Task 13): fixed** in `f05bba8`; regression test `test/fake-mail-regressions.test.ts` › "F4: a carrier mail listing two parcel numbers tracks both". Numbers LISTED right after the first (comma, semicolon, "a", "and") are tracked too, as `moreNumbers`.
- **Input:** `45-dpd-two-parcels-one-mail.eml` (`Číslo balíka: 01505333333305, 01505333333306`).
- **Expected:** two parcels, or at least an /attention entry for the second.
- **Actual:** parcel `01505333333305` only. `…306` appears nowhere: no parcel and no attention entry.
- **Where:** `src/ingest/extract.ts:124-128` (`firstNumber` takes `m[0]`), used at `:393`.

### F5. A number that is only in the HTML part is never seen when the text part is a "view in browser" stub. *bug*
- **Status (Task 13): fixed** in `61dd4ed`; regression test `test/fake-mail-regressions.test.ts` › "F5: a number only in the HTML part is found …".
- **Input:** `41-eshop-number-only-in-html.eml`. It is multipart/alternative: the text part is one line ("otvorte ho v prehliadači …") and the HTML part has `Číslo zásielky: Z 222 2222 211`.
- **Expected:** parcel `packeta:Z2222222211`.
- **Actual:** /attention, "its subject is about a shipment". `bodyText` uses `mail.text || html`, so a non-empty but useless text part hides the HTML.
- **Where:** `src/ingest/extract.ts:357-359`.

### F6. A carrier's promo mail creates a ghost parcel from its sample number. *bug*
- **Status (Task 13): fixed** in `b299edc`; regression test `test/fake-mail-regressions.test.ts` › "F6: a carrier's sample number … is not a parcel".
- **Input:** `08-packeta-promo-sample-number.eml`, from `info@packeta.sk`: "číslo zásielky v tvare Z 000 0000 000".
- **Expected:** /attention ("a carrier sent it"), or ignored.
- **Actual:** parcel `Z0000000000` is created. It was polled 64 times (all `not_found`) and sat in "In flight" for 16 days as `No updates yet`. The carrier-sender path accepts the first number-shaped token.
- **Where:** `src/ingest/extract.ts:392-399`.
- **Screenshot:** bottom of `shots/dashboard-1280.png`, `shots/parcel-05-packeta-Z0000000000-1280.png`.

---

## Medium

### F7. A phishing look-alike becomes a tracked parcel named "Packeta". *questionable / design choice*
- **Status (Task 13): fixed** in `6b8b08c`; regression test `test/fake-mail-regressions.test.ts` › "F7: a sender dressed up as a carrier … makes no parcel". Behaviour chosen: /attention with the note "not tracked: its sender is named like a carrier but does not write from that carrier's address" (display name or a domain label naming a carrier, sender not a carrier domain).
- **Status (final fix wave, review I4): narrowed.** A domain that *is* a carrier's brand (`packeta.cz`, `dhl.nl`, `mail.gls.fr`) is no longer a look-alike: it is tracked by its number's shape, as before Task 13. More carrier domains are listed as senders (`packeta.cz`, `packeta.hu`, `zasielkovna.sk`, `dpd.com`, `dpd.cz`, `dpdgroup.com`, `slposta.sk`). The note now reads "not tracked on its own: the sender calls itself Packeta but writes from packeta-sk.example.com, which is not one of Packeta's known addresses. Assign it if you trust it."
- **Input:** `76-phishing-lookalike-packeta.eml`, from `noreply@packeta-sk.example.com`: "uhraďte poplatok 1,99 €".
- **Expected:** /attention at most, because the sender is not a carrier.
- **Actual:** parcel `Z2222222299`, titled "Packeta" (the attacker's display name), in flight. It adds no link, but it lends the scam credibility on the dashboard. A distinctive shape is trusted from ANY sender, and the merchant comes from the display name.
- **Where:** `src/ingest/extract.ts:401-413`.
- **Screenshot:** `shots/dashboard-1280.png`, the "Packeta" card.

### F8. DHL parcels never leave "In flight", even after DHL mails "has been delivered". *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- **Input:** `35-…`, `38-…`, `51-dhl-express-delivered.eml`.
- **Actual:** the card stays in flight with "Your DHL shipment … has been delivered". Status stays `unknown` by design (§8: no status from prose). Email-only parcels are also exempt from dormancy, so they stay in flight indefinitely unless the user clicks "Mark as received". The lede then says "3 have no status; read their latest message".
- **Where:** `src/ingest/ingest.ts:156-166`, `src/core/backoff.ts:32`.
- **Screenshot:** `shots/dashboard-1280.png` (JJD…, Temu, JVGL… cards).

### F9. A DHL Express mail with the common bare 10-digit waybill is not tracked, even from dhl.com. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- **Input:** `52-dhl-express-bare-10-digit-waybill.eml`.
- **Actual:** /attention, "a carrier sent it". §6.6 excludes bare 10 digits to keep GLS auto-detection unambiguous. That ambiguity does not exist when the sender is already known to be DHL.
- **Where:** `src/ingest/extract.ts:89`, `src/carriers/dhl.ts:37-42`.

### F10. Slovenská pošta's inbound international numbers (…CN, …DE) are not recognised, even from posta.sk. *bug*
- **Status (Task 13): fixed** in `cd3c5fb`; regression test `test/fake-mail-regressions.test.ts` › "F10: Slovenská pošta's own mail about an inbound international item …". From posta.sk only; manual entry (`postaAdapter.matches`) still auto-detects …SK only.
- **Input:** `57-posta-customs-foreign-s10.eml` (`RB666666042CN`, customs 8,73 €).
- **Actual:** /attention. The posta pattern requires the `SK` suffix.
- **Where:** `src/ingest/extract.ts:83` (also `src/carriers/posta.ts:9` for manual entry).

### F11. One e-shop mail naming two Packeta parcels yields neither. *questionable / design choice*
- **Status (Task 13): fixed** in `f05bba8`; regression test `test/fake-mail-regressions.test.ts` › "F11: an e-shop mail naming two parcels of one carrier tracks both". Several distinctive numbers of ONE carrier (up to five) are each tracked; two carriers' numbers stay a question.
- **Input:** `25-eshop-two-packeta-parcels.eml`.
- **Actual:** /attention. Ambiguity is refused rather than guessed (`found.length !== 1`), but both numbers are distinctive and unambiguous on their own, so nothing would actually be guessed.
- **Where:** `src/ingest/extract.ts:407`.

### F12. "No updates yet" for a parcel the carrier has answered "not found" dozens of times. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- **Input:** parcels 5, 28, 29, 30 (`Z0000000000`: 64 × `not_found`).
- **Actual:** the dashboard says `No updates yet` and the parcel page says `Nothing from the carrier yet.` This contradicts design-language §1 rule 6 ("never assert an absence the data cannot support"; "yet" promises something). The carrier's actual answer is not shown anywhere, and the parcel goes dormant only after 30 days.
- **Where:** `src/web/views/parcel.ts:181,209`, `src/web/views/index.ts:334`.
- **Screenshot:** `shots/parcel-05-…-1280.png`, `shots/parcel-30-…-1280.png`.

### F13. A 9-day-old "Out for delivery" tops the dashboard, with no staleness hint. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- **Input:** `29-gmail-forwarded-dpd.eml` (carrier still says "Kuriér doručuje" 9 days later).
- **Actual:** it is the first card, above three pickups, including one with a passed deadline. `out_for_delivery` always outranks `ready_for_pickup` because it is "bound to TODAY", which stops being true after a day.
- **Where:** `src/web/views/index.ts:289`.
- **Screenshot:** `shots/dashboard-1280.png`.

### F14. A passed pickup deadline is never announced; the "Still waiting" nudges just continue. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- **Input:** `44-posta-balikobox-pin.eml` (BalíkoBOX, deadline 27 Oct), plus SPS1 and P3.
- **Actual:** "Pickup deadline approaching" arrives before the deadline. Afterwards come "Still waiting for you · day 5/6/7", which drop the date and never say it passed. The dashboard lede ("4 ready for pickup …") does not mention it either. Only the card's red "deadline passed" does.
- **Where:** `src/notify/rules.ts:99-119`.
- **Screenshot:** `shots/dashboard-1280.png` (BalíkoBOX card).

### F15. A very long mail with the number past the 400 KB text cap is silently ignored, not even put on /attention. *bug (rare)*
- **Status (Task 13): fixed** in `61dd4ed`; regression test `test/fake-mail-regressions.test.ts` › "F15: a very long mail is read at both ends …".
- **Input:** `59-eshop-very-long-mail.eml` (~470 KB of order text and T&C, `Číslo zásielky Packeta: Z 222 2222 210` at the end).
- **Actual:** `ignored`. The number and the carrier name are both past `MAX_TEXT`, and the subject has no shipping word. The comment's own bias is "a false ignore hides a real parcel", and this is exactly that.
- **Where:** `src/ingest/extract.ts:121,357-359`.

### F16. A newsletter goes to /attention because a catalogue number is labelled "číslo". *bug (false positive)*
- **Status (Task 13): fixed** in `0fd527d`; regression test `test/fake-mail-regressions.test.ts` › "F16: a bare "číslo" … is no sign of a parcel".
- **Input:** `07-newsletter-number-like.eml` (`Katalógové číslo produktu 123456789012`).
- **Actual:** /attention, "it contains something shaped like a tracking number". The probe shows that without that line the mail is correctly ignored. `GLS_LABEL` treats any `číslo` as a parcel label, and evidence uses `labelledNumber` even with no carrier named.
- **Where:** `src/ingest/extract.ts:130,286`.
- **Screenshot:** `shots/attention-1280.png`.

### F17. A GLS ready-for-pickup parcel ends up with no pickup place at all. *bug (fragile label anchor; see caveat)*
- **Status (Task 13): not fixed, by decision.** The real GLS template (the scrubbed fixture) puts the bullet image in its own `<td>` and `Odberné miesto:` in a `<div>` of the next cell, so both mailparser and `htmlToText` start the label on its own line, and the real fixture parses (tested). Only this corpus's template shares the cell, so the anchor is not shown fragile against real GLS wording; loosening it would weaken what keeps DPD's link text and SPS's prose out.
- **Input:** `20-gls-ready-glsbox-pin.eml`, `69-…` (carrier answer has no point, like real GLS `DELIVEREDPS`).
- **Actual:** parcel 10 has no address, no map and no "Open in Apple Maps". `pickupFromMail` → null (`probes.json: gls20_pickup`). The label must own its line (`^[ \t>]*odbern[ée]\s+miesto:`), but in this mail it shares a line with the bullet image's link text. mailparser also wraps it as `Odberné\nmiesto:`.
- **Caveat:** my template puts the bullet image in the same cell as the label. The real fixture has it in its own cell, and that one still parses, so this is a robustness finding rather than a proven production failure.
- **Where:** `src/ingest/extract.ts:497`.

### F18. Order confirmations and carrier newsletters fill /attention. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- **Input:** `06-…` (names Packeta, no number yet), `09-dpd-promo-newsletter.eml`, `56-…`, `65-alza-…`.
- **Actual:** 12 cards on /attention. About half of them are the expected noise the code comments accept ("one dismiss click").
- **Screenshot:** `shots/attention-1280.png`.

---

## Low

### F19. Czech and English carrier mail: no merchant, and no pickup block read. *bug (Slovak-only patterns)*
- **Status (Task 13): fixed** in `83fe31c`; regression test `test/fake-mail-regressions.test.ts` › "F19: Packeta's Czech and English mail name the shop …". Czech pickup label added; no English one (no mail shows packeta.com's present-tense wording).
- **Input:** `31-zasilkovna-cz-ready-iso8859-2.eml` (`od odesílatele …`, `Místo, kde je vaše zásilka uložena`), `67-packeta-com-english.eml`.
- **Actual:** the parcels are titled `Z2222222204` and `LedLight Store`; the latter name came from a later Slovak mail. The CZ parcel's pickup postcode is never filled.
- **Where:** `src/ingest/extract.ts:348,496-500`.

### F20. Slovenská pošta, SPS (carrier-sent) and DHL parcels get no merchant, so their cards are titled by tracking number. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- The posta and DHL mails do name the sender (e.g. "from FAKE GADGETS LTD"). Affected: parcels 17, 18, 21, 22, 25.
- **Where:** `src/ingest/extract.ts:345-351`.

### F21. Merchant cut mid-word at 80 characters, and DPD merchants carry the shop's order reference. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- Examples: "…domácnosť – oficiáln", "Fotoshop Testovo # F-3321", "Mobilonline # 88123", "Nábytok Domov # N-1200".
- **Where:** `src/ingest/extract.ts:118,323-326,349`.
- **Screenshot:** `shots/parcel-11-…-1280.png`, `shots/history-1280.png`.

### F22. The pickup title repeats the street. *bug (cosmetic)*
- **Status (Task 13): fixed** in `a411eaa`; regression test `test/fake-mail-regressions.test.ts` › "F22: a pickup point whose name already holds its street …".
- Example: "Z-BOX Testovo, Nová 8 (Lidl), Nová 8, Testovo"; the notifications say the same.
- **Where:** `src/db/parcels.ts:57-61` (`pickupSummary` joins name + street + city when the name already contains the street).

### F23. Postcode spelling differs by source. *bug (cosmetic)*
- **Status (Task 13): fixed** in `2e93b39`; regression test `test/fake-mail-regressions.test.ts` › "F23: a postcode read from mail is stored the way the carriers send theirs".
- A postcode read from mail is stored as `999 01`; the carrier's is `99901`.
- **Where:** `src/ingest/extract.ts:599`, `src/core/pickup-code.ts:149,156,163`.

### F24. An /attention card for a mail with an empty subject has no heading. *bug*
- **Status (Task 13): fixed** in `a411eaa`; regression test `test/fake-mail-regressions.test.ts` › "F24: an /attention card for a mail with an empty subject has a heading".
- **Input:** `58-attachment-only-scan.eml`.
- **Actual:** the empty-subject fallback never fires: `m.subject ?? '(no subject)'` does not catch `''`, which is what is stored.
- **Where:** `src/web/views/attention.ts:99,103`.
- **Screenshot:** `shots/attention-1280.png` (third card).

### F25. The timeline rail runs through the last letter of day headings ("Oct", "Sep"). *bug (cosmetic)*
- **Status (Task 13): fixed** in `a411eaa`; regression test `test/fake-mail-regressions.test.ts` › "F25: the timeline rail does not run through a day heading's text".
- The `.day::before` rail sits at a fixed x, and the heading text is wider than the time column.
- **Where:** `src/web/views/style.ts:209-211`.
- **Screenshot:** `shots/parcel-13-dpd-01505333333303-1280.png` ("Sun 18 Oct").

### F26. The Name placeholder is clipped at 1280 px ("e.g. Shoes from Zala"). *bug (cosmetic)*
- **Status (Task 13): fixed** in `a411eaa`; regression test `test/fake-mail-regressions.test.ts` › "F26: the Name field's placeholder fits the field". Placeholder now "e.g. New shoes" on the parcel page.
- **Where:** `src/web/views/parcel.ts:249`.
- **Screenshot:** any `shots/parcel-*-1280.png`.

### F27. "Postcode (used by GLS and DPD)" is offered on every parcel, including Packeta, posta, DHL, archived and delivered ones. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- **Where:** `src/web/views/parcel.ts:250`.

### F28. An unnamed parcel in a pickup card prints its number twice. *bug (cosmetic)*
- **Status (Task 13): fixed** in `a411eaa`; regression test `test/fake-mail-regressions.test.ts` › "F28: an unnamed parcel's card prints its number once".
- Example: "EB666666025SK  Slovenská pošta · EB666666025SK".
- **Where:** `src/web/views/index.ts:353` (the meta line repeats the number after a name that is already the number).
- **Screenshot:** `shots/dashboard-1280.png` (BalíkoBOX card).

### F29. Health → Recent activity speaks in internal names. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- It shows `#27 packeta: pre_transit -> ready_for_pickup (raw …)`, while every other page uses "Registered" and "Ready for pickup". Creation, archiving and revival are not logged there at all.
- **Where:** `src/db/activity-log.ts:422`.
- **Screenshot:** `shots/health-1280.png`.

### F30. Notification volume. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- 78 banners in 16 days. Every waiting parcel is nudged twice a day: GLS parcel 10 got "Still waiting" on 13 consecutive days. On setup day the user is told "Delivered — 90444444404" about a parcel delivered 20 days earlier.
- **Evidence:** `out/notifications.json`. **Where:** `src/notify/rules.ts`.

### F31. The median delivery time for pickup carriers includes the days the parcel waited in the box. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- Packeta shows "6.9 days". About 2–3 of those are the user not collecting it.
- **Where:** `src/web/queries.ts:43-66`.
- **Screenshot:** `shots/history-1280.png`.

### F32. Only Packeta Z-BOX codes are surfaced. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- The DPD Pickup Station PIN (120477), GLS BOX PIN (402211), BalíkoBOX PIN (631285), SPS "Verifikačný kód" (551902) and AlzaBox code are all in the stored mail, but the card shows no code. `probes.json: dpd43_code, posta44_code` → null.
- **Where:** `src/ingest/extract.ts:442`.

### F33. The parcel page never shows which mail(s) created or updated the parcel. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- This is the only way to understand ghost parcels like F6 and F7; the user would have to open the database.
- **Where:** `src/web/views/parcel.ts`.

### F34. Timeline status labels depend on poll timing. *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- Prose-only adapters code only the newest event. A parcel first polled after two events have happened has an unlabelled first event (parcel 16, "Zásilka byla podána."), where the same history polled step by step has every row labelled.
- **Where:** `src/carriers/packeta.ts:96-102` (and the GLS and SPS equivalents).

### F35. At 390 px, Name and Postcode come after "Delete this parcel". *questionable / design choice*
- **Status (Task 13): not changed** (questionable / design choice; R19 leaves it for the persona test and the final report).
- **Screenshot:** `shots/parcel-08-packeta-Z2222222201-390.png`.

### F36. A mis-declared charset is stored as mojibake. *not an app bug (sender's fault); noted*
- **Status (Task 13): not changed** (the sender's fault, not the app's; outside R19's scope).
- **Input:** `73-sps-delivered-misdeclared-charset.eml`.
- **Actual:** `messages.subject` = "Zásielka … doruèená". It is not displayed, because the mail linked to its parcel.
- **Evidence:** `out/messages.json`.

**Not a finding:** the first harness run's 390 px shots (`--window-size=390,…`) were clipped on the right. Headless Chrome will not make a window that narrow, which design-language §16 also notes. Rendered through a 390 px iframe, every page fits (`shots/*-390.png` are now taken that way).

---

## What worked correctly

- **No leaks, read-only mail access, robust ingest.** No network attempt at all. The IMAP fake saw only read-only calls. The watermark advanced correctly over 64 incremental runs. 0 failed messages, 0 exceptions, and every page returned 200.
- **Archiving and revival.** Mail older than 30 days at setup was archived on arrival (3 parcels). A fresh mail for an archived parcel revived it (`63-…` → SPS2 back in flight, "Returning to sender").
- **GLS zero-padded numbers.** The e-shop's 12-digit `090444444402` and GLS's `90444444402` became one parcel.
- **Duplicates.** The same Message-ID at a later UID (`77-…`) changed nothing. A reminder re-sent with a new Message-ID (`50-…`) linked to the existing parcel without creating a duplicate.
- **Forwards.** Gmail forwards in English (bold `*DPD*`) and Czech ("Přeposlaná zpráva" / "Od:") resolved to the right carrier and parcel.
- **Encodings.** windows-1250 (QP and base64), ISO-8859-2 QP, base64 UTF-8, and emoji subjects and sender names all decoded. No mojibake appears anywhere in the UI.
- **Z-BOX codes.** Codes with leading zeros were kept (`040712`, `009431`), and the Czech "Kód pro otevření schránky" was read.
- **Pickup-point change.** P3 ended at box B with the code from the new mail. Two parcels in the same Z-BOX shared one card with both codes.
- **Phone lookalikes.** Phone and order lookalikes before a GLS number were skipped (`12-…`, `47-…`).
- **Other edge cases.** A number only in the subject, and a 1-line mail, both parsed. Unknown carriers (Express One), AliExpress/Cainiao, AlzaBox and the attachment-only scan went to /attention with sensible reasons. The number-heavy newsletter would be ignored if not for F16.
- **Status order.** Status sequences rendered in order, including failed attempt → delivered, returning → returned (History says "Returned to sender") and redirected → ready.
- **Time zones.** Times across the 25 Oct DST change are correct, and day headings use Europe/Bratislava.
- **Rendering.** Dark mode is legible on every page checked, and the 390 px layout reflows without overflow.
