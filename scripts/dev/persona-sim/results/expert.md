# Parcels: expert heuristic evaluation

Evaluator: senior UX researcher, heuristic walkthrough. Scenario: `power` (Peter Mocný, Fiktívny Hrádok), 14 simulated
days. Basis: Nielsen's ten heuristics, `docs/design-language.md` (the app's own rules), and accessibility basics
(contrast in light and dark, text size, click targets, reading order at 390 px, language of the copy, error states).

Screenshots: `scripts/dev/persona-sim/results/expert-shots/`, named by page, day, width and theme (50 files, all looked at).

**How this run was done.** The simulator keys instances by persona: `--as` selects a running instance, it does not name
one, so a second `power` instance could not start while another agent's `power` run was alive. I observed that live
instance read-only (`sim text`, `sim shot`, `sim mail`, `sim status`) as it moved through days 3 to 14, then started my
own `power` instance and lived days 0 to 14 myself: the move-in submit, every day digest (notifications, menu-bar count,
mail), the grouped Z-BOX card with two codes, Mark as collected and Undo, Add to Calendar, Refresh now, Test
connection, collecting at the box, the post-office counter and the GLS ParcelShop. Every finding cites the page and
state it was seen in. States I could not reach are listed at the end of section 2. Finished with `sim stop`.

---

## 1. Strengths

- **The two-second answer is real.** `2 in flight, both ready for pickup.` / `3 in flight. Nothing needs you.` sits
  under the `h1`; cards are ordered by what the owner must do; the blue chip is the only hue on the page and marks
  exactly the parcels waiting on a person. Design-language rule 5 as written.
- **The locker code is first-class.** `Open the box with 017466` in a large monospace figure, on the first screen,
  leading zero kept (`index-day2-zbox-1280-light.png`).
- **Grouping by place.** Two Packeta parcels in one Z-BOX are one card headed by the place, each with its own code,
  its own `Add to Calendar` and its own `Mark as collected`. That is the mental model of a trip to the box.
- **Honest ledes and honest empty states.** `4 of 5 carriers reporting. Slovenská pošta has never been polled. DHL is
  not polled: its updates arrive by email.`; `Nothing in flight. Parcels appear here when a shipping email arrives, or
  when you add one.`; `Not enough deliveries yet to time any carrier`. Nothing claims "all" or "ok" without data.
- **The connection test is the best piece of setup copy in the app.** `Connected — peter.mocny@example.com — the label
  parcels has 7 messages. Signed in, the label is visible, and its emails can be read. Everything is in place: new
  shipping emails become parcels at the next hourly check.` Fact, meaning, next step, in three sentences.
- **Status survives without colour.** Word plus a distinct glyph for every state (box, three ring fills, check disc,
  dot). Dark mode re-picks every token rather than inverting; all shots stayed legible in both themes.
- **Undo where it matters.** `Marked AliExpress as collected. It is in History. [Undo]`; `Collected — marked by you ·
  Undo` on the page; Delete behind a disclosure with its consequence spelled out.
- **Add to Calendar is well designed for a no-script page:** day chips with `— last day`, three Slovak preset times,
  `Today, from 13:00` when earlier slots have passed, and the result names the calendar it used.
- **No JavaScript and it does not feel like it.** Native disclosures, forms that land at their own fragment, a 404 page
  that says why and offers one way back.
- **Plain-sentence copy** with the consequence beside the control (`Off removes the map and stops looking addresses
  up online.`; `Saved, and never shown again. Leave this blank to keep it`).
- **Card pages hold at 390 px:** nav wraps to two lines, cards stack, the code stays legible, no horizontal overflow on
  In flight, Parcel, Settings, Add.
- **Edge cases handled quietly:** the GLS number with a leading zero in the shop's mail produced one parcel, not two;
  the DPD two-box mail produced two tracked parcels that both reached Delivered.

---

## 2. Findings by screen

Severity on Nielsen's scale: 0 not a problem · 1 cosmetic · 2 minor · 3 major · 4 catastrophic.

### 2.1 In flight (dashboard)

**F1. A GLS ParcelShop pickup shows no place and no PIN, although both are in the mail.** Severity **4**.
Heuristic: *Recognition rather than recall*; *Match between system and the real world*; design language §6.1 ("the
lines that matter for its state"). Day 12 (`index-day12-gls-parcelshop-1280-light.png`): the card headed
`Železiarstvo Online` reads `GLS · 90444444410 / Balík bol doručený do GLS ParcelShopu / Collect by Fri 20 Nov · 7 days
left`, `Add to Calendar`, `Mark as collected`. No pickup point, no Maps link, no PIN. The notification at 11:00 said only
`Ready for pickup — Železiarstvo Online / collect by Fri 20 Nov`. Mail #29 from GLS holds all of it: `Pre vydanie balíka
použite PIN kód 914270`, `Odberné miesto: GLS ParcelShop Železiarstvo Klinec, Dielenská 8, 99991, Fiktívny Hrádok`,
`najneskôr dňa 20. 11. 2026`. The deadline was read out of that mail; the PIN and the shop were not. Without the PIN
the shop will not hand the parcel over, so the one card that exists to get you to the counter sends you back to Gmail.
**Recommendation:** read the GLS pickup mail as the Packeta mail is read: the ParcelShop address becomes the pickup point
(it then heads the card and gets the Maps link) and the PIN becomes the code line (`Show PIN 914270 at the counter`).

**F2. A cash-on-delivery amount never reaches the user.** Severity **3**. Heuristic: *Visibility of system status*;
*Match with the real world*. Day 6, 08:30 (`index-day6-cod-1280-light.png`): the card reads `7034444444444406 / Out for
delivery / SPS / Zásielka na doručení / Since Sat 7 Nov, 07:05`; the 08:00 notification read `Out for delivery —
7034444444444406 / Zásielka na doručení`. SPS mail #19 at 07:40 says `od Nábytok Domov bude dnes doručená kuriérom na
adresu. Suma na úhradu (dobierka): 89,90 €. Kuriér: 0900 000 404.` The person opens the door to a courier who wants
89,90 € in cash, and the app never said so, nor who the sender was, nor the courier's number. **Recommendation:** when a
labelled mail carries an amount beside "dobierka" or "na úhradu", print it on the card and in the banner (`Out for
delivery · 89,90 € cash on delivery · courier 0900 000 404`). The same mail parser should lift the sender name (F5).

**F3. Email-only (DHL) parcels never notify and never finish.** Severity **3**. Heuristic: *Visibility of system
status*; *Consistency*. Day 8: DHL mail #22 `is on its way and will be delivered on Wednesday, 11 November` arrived at
09:00; the day digest shows no DHL notification. Day 10: mail #25 `has been delivered. Signed for by: MOCNY` arrived at
12:40; again no notification. The card (`index-day10-dhl-delivered-1280-light.png`) prints `Your DHL shipment
JJD000444444444408 has been delivered / Since Wed 11 Nov, 12:40 · 1 day` and the lede says `1 has no status; read its
latest message.`: the card contradicts itself and the lede tells the user to read a sentence the card already shows. The
only exit is `Mark as received` on the parcel page, which the card does not offer. **Recommendation:** for email-only
carriers (a) send a banner whenever a new mail line is added, with the mail's subject as the text, (b) put `Mark as
received` on the card, (c) let the lede say what the sentence says (`1 says it is delivered; mark it received if you
have it.`). A keyword map (`delivered`, `doručená`) that only suggests is enough; the user confirms.

**F4. Notifications fire for every status change, including the ones that ask nothing.** Severity **2**.
Heuristic: *Aesthetic and minimalist design*; design-language rule 1 ("mark the exception, not the norm") and §1 ("spends
its voice only on the parcels that need a person"). Day 0 evening, within 30 minutes: `Registered — AliExpress`, `In
transit — Foto Hrádok`, `In transit — AliExpress`. Day 4: five banners for two DPD boxes and one GLS parcel (`Out for
delivery` ×2, `In transit`, `Delivered` ×2), two of them word-for-word identical (`Out for delivery — Dielňa Pro #
DP-2001`). Over 14 days: 33 banners, of which 12 were actionable (ready, out for delivery, reminders). **Recommendation:**
default to banners for Act states and Delivered only; make `Registered` and `In transit` opt-in in Settings; coalesce
the boxes of one order into one banner (`Out for delivery — Dielňa Pro # DP-2001, 2 boxes`).

**F5. Reminders keep nagging after a counter pickup, because the carrier closes it a day late.** Severity **2**.
Heuristic: *Visibility of system status*; *User control*. Day 8: collected `EB444444074SK` at the post-office counter at
10:00. The 15:30 banner still said `Still waiting for you · day 2 — EB444444074SK`, the menu bar showed `1` all day, and
`Delivered — EB444444074SK / Dodanie zásielky` arrived at 07:00 the next day. The README says this is why `Mark as
collected` exists, but the banner does not say so, and the person is at the kitchen table, not at the Mac.
**Recommendation:** add a `Collected` action to the reminder banner (macOS supports action buttons), and end the banner
text with `Mark it collected to stop these.`

**F6. Delivery windows and courier names in the mail are not shown.** Severity **2**. Heuristic: *Match with the real
world*. Day 4: DPD mails #13/#14 say `bude doručená dnes v čase 10:30 – 11:30. Kuriér Marek vás bude kontaktovať`; day 5
GLS mail #17 says `Doručíme ho dnes medzi 9:00 a 12:00`; day 8 DHL says `will be delivered on Wednesday, 11 November`. The
cards and banners said `Out for delivery / Kuriér doručuje` and nothing about the hour. A window is the one thing a
person plans the morning around. **Recommendation:** extract `HH:MM – HH:MM` and `medzi H:MM a H:MM` from the labelled
mail and print it on the out-for-delivery line (`Today 10:30 – 11:30`).

**F7. Two boxes of one order are two identical cards.** Severity **2**. Heuristic: *Recognition rather than recall*.
Day 3 (`index-day0-1280-light.png`): two cards both headed `Dielňa Pro # DP-2001`, same status, same sentence, differing
only in the last digit of a 14-digit mono number. DPD's mail said `rozdelená do 2 balíkov`. **Recommendation:** when
one mail yields several numbers, name them `(1 of 2)` / `(2 of 2)`, or group them under one card the way a Z-BOX groups
parcels.

**F8. The shop's name is lost when the carrier writes first; cards and banners are then headed by a bare number.**
Severity **2**. Heuristic: *Recognition rather than recall*. `EB444444074SK`, `7034444444444406`, `JJD000444444444408`
were the `h1` on the card, the page, History and in every banner (`Ready for pickup — EB444444074SK`). The SPS mail
named `Nábytok Domov`, the DHL mail named `FAKE TOOLS GMBH (Germany)`. **Recommendation:** fall back to the sender or
shop name found in the mail body (`od <name>`, `from <name>`), then to the mail's From display name; show the `Name`
field inline on a card whose name is its number.

**F9. The Refresh now result reads as a list of faults when nothing is wrong.** Severity **2**. Heuristic: *Help users
recognise errors*; *Match with the real world*. Pressing Refresh on day 2 returned `No new mail. Nothing was polled:
each parcel here is paused (its carrier is failing, or its postcode was rejected), updated by email only, or was tried
under a minute ago.` The true reason was the last clause; the sentence leads with two alarming ones. **Recommendation:**
print only the reason that applies: `No new mail. Already checked a minute ago; nothing has changed.`

**F10. After Move in, the dashboard says "Gmail is not connected yet".** Severity **2**. Heuristic: *Consistency*;
*Visibility of system status*. Day 0 after `Move in` (`index-day0-after-movein-1280-light.png`): a notice `Gmail is not
connected yet. Once it is, parcels are added by themselves… Connect it in Settings`, while the move-in page and README
promised `Nothing needs to be set up again` and Settings showed the address and `App Password (set)`. In the
simulation the connection became live at 20:30; for the 90 minutes before, the page told a migrating user their
settings were lost. **Recommendation:** when credentials exist but no poll has run yet, say `Gmail is connected; the
first check runs at 21:00` with a `Refresh now` button, and reserve the "not connected" notice for a missing password.

**F11. Card body is not a target on single-parcel cards; only the header is.** Severity **1**. Heuristic: *Consistency*.
Design language §17 admits this. At 1280 the body of `Foto Hrádok` has no hover and no link. **Recommendation:** fix the
stacking order so the whole card opens the parcel, as §6.1 specifies.

**F12. `Since Tue 3 Nov, 14:00` answers "when", not "is it stuck".** Severity **1**. The age count (`· 1 day`) appears
only after a full day. **Recommendation:** append `· today` / `· 3 hours ago` as the day count is appended; keep the
absolute date, as §3.4 requires.

**F13. Mail to banner takes up to 90 minutes.** Severity **1**. Day 2: the Packeta "ready" mail arrived 08:34; the
09:00 poll logged `mail: 1 new, 0 parcel(s) created`; the banner and the menu-bar `1` came at 10:00. The hourly cadence
is a product choice; the cost is a person who already got the Packeta push on their phone and sees `0` in the menu bar.
**Recommendation:** poll the mailbox every 15 minutes (it is cheap after the UID watermark); keep carriers hourly.

### 2.2 Parcel page

**F14. Reading order at 390 px puts Delete before the parcel's own actions.** Severity **2**. Heuristic: *Error
prevention*. At 390 px the single column is: header, pickup, timeline, Technical details, **Delete this parcel**,
`Collected it? / Mark as collected`, Name, Postcode (`parcel3-ready-390-dark.png`, `parcel9-dhl-delivered-390-light.png`).
The one irreversible action sits above the most common one. **Recommendation:** at narrow widths place the side column
(Mark as collected, Name, Postcode) under the header and keep Delete last.

**F15. The hero of an unnamed parcel is its tracking number at 28 px, and the Name field is far away.** Severity **2**.
Same root as F8. `# EB444444074SK` with `Name` in the right column at 1280 and at the bottom at 390 px.
**Recommendation:** on a parcel whose name is its number, move the Name form directly under the `h1`.

**F16. The pickup panel still wears the blue header wash that the cards gave up.** Severity **1**. Heuristic:
*Consistency*; design language §16 ("the blue header wash is gone"). `parcel3-ready-1280-light.png`: the pickup block on
the parcel page has a filled `--signal-wash` header with the chip; the same parcel's card on the dashboard has a plain
header. Two renderings of one state. **Recommendation:** use the card header on the parcel page too.

**F17. `carrier says:` is a developer phrase in a 13 px meta line and repeats the top timeline row.** Severity **1**.
`Packeta · Z4444444402 · carrier says: Zásielka bola uložená v Z-BOXe…` sits three lines above the same sentence in the
timeline on every parcel seen. **Recommendation:** drop it when it equals the newest timeline sentence.

**F18. `Technical details` hides five near-identical JSON bodies.** Severity **1**. Fine for the author; a friend
might open it looking for the PIN. Label it `What the carrier sent (for support)`.

**F19. Timeline sentences are Slovak, the chrome is English.** Severity **2**. Heuristic: *Match with the real world*.
Every page pairs `Ready for pickup` with `Zásielka bola uložená v Z-BOXe…`, `Registered` with `Údaje o zásielke boli
prijaté`. For friends in Slovakia and Czechia the English half is the larger reading load, and the design doc itself
calls Slovak chrome "a risk I did not design around". **Recommendation:** Slovak (and Czech) chrome; roughly sixty
strings, and the status words map one-to-one (`Pripravené na vyzdvihnutie`, `Na ceste`, `Doručené`).

### 2.3 History

**F20. At 390 px the table's last columns are cut off with no scroll affordance** (`history-390-dark.png`): Outcome
reads `Delive…`, `Collec…`, `Archiv…`; Date is off-screen; nothing hints that the region scrolls. Severity **2**.
Heuristic: *Visibility of system status*. **Recommendation:** below 40 rem, render each row as a two-line list item
(name + number / carrier · outcome · date), as the cards already do.

**F21. `Collected` and `Received` (user facts) share the green check with the carrier's `Delivered`.** Severity **1**.
The word carries the difference, as the design doc says; at a glance it is a column of green checks on the page where
"did the carrier actually deliver?" gets asked. Noted, not urgent.

### 2.4 Health

**F22. At 390 px the Recent runs and Recent activity tables are unreadable.** Severity **3**. Heuristic: *Aesthetic and
minimalist design*; accessibility (reading order, text size). `health-390-light.png` is 6000 px tall and every cell
wraps word by word and then letter by letter: `polle / d 1 / parc / el(s) / , 3 / new / even / t(s)`; `30 / minut / es
/ ago` (`health-390-light-crop-runs.png`). The design log claims these tables scroll inside a focusable region at 375 px;
in the render they are squeezed. **Recommendation:** below 40 rem, render runs and activity as a list, one row per
line, no table.

**F23. Twenty lines of `polled 1 parcel(s), 0 new event(s)` is a log, not a page.** Severity **2**. Heuristic:
*Aesthetic and minimalist design*; design rule 1. Twenty identical `ok` rows with `(s)` plurals sit between the carrier
board and `Update` / `Support`, which are what a friend opens Health for. **Recommendation:** collapse consecutive
identical quiet runs (`ok · 14 runs, Fri 6 Nov 07:00 to 21:00 · nothing new`), spell plurals, and move `Update` and
`Support` above the logs.

**F24. The DHL row says `not polled` and `updates arrive by email` in two sizes on two lines**
(`health-1280-light.png`). Severity **1**. One sentence: `by email · not polled`.

### 2.5 Settings

**F25. "How to connect Gmail — three steps, about five minutes" is twelve unnumbered bullets across three Google
pages.** Severity **3**. Heuristic: *Help and documentation*; *Error prevention*. Section 3 walks it. Three things are
wrong on one disclosure: the headline undersells the work; the steps are a flat bullet list with no numbers and no "you
are here"; and the step the README calls "the one that catches everyone" (`Show in IMAP`) is one bullet among twelve
with no emphasis.

**F26. The App Password field gives no feedback until you save and scroll.** Severity **2**. Heuristic: *Visibility of
system status*. The help says the save's answer "appears at the top of this page"; `Test connection` lands at `#test` at
the bottom. A friend who pasted Google's `abcd efgh ijkl mnop` with spaces has no hint whether that is fine.
**Recommendation:** `Spaces are fine` under the field; put the save's test sentence beside the field.

**F27. Nothing says "setup is done, here is what happens next".** Severity **2**. After `Save settings` the page shows
`Saved.` and the test. Nothing points to In flight or offers `Refresh now`, and an empty In flight is indistinguishable
from a failed setup. **Recommendation:** after a first successful save, a notice: `Connected. Your parcels appear on In
flight at the next check (21:00) — or [Refresh now].`

**F28. `Calendar for pickups` appears before the user knows what Add to Calendar is.** Severity **1**. Move it under
Advanced until a pickup has existed, or add one line of context.

### 2.6 Add parcel

**F29. The picker says `Detect from number` but not what to do when detection fails.** Severity **2**. Heuristic:
*Help users recognise, diagnose and recover from errors*. The README says a DHL Express number "is also GLS's shape"
and must be added with the carrier chosen; the page does not. **Recommendation:** one hint under the picker: `Not sure?
Choose the carrier. DHL Express numbers look like GLS numbers.`

**F30. Placeholder `99991 (default)` looks like a filled value** in dark mode (`add-390-dark.png`). Severity **1**.
Use `Leave empty for 99991`.

### 2.7 Attention

**F31. "Dormant parcels" is explained in the author's vocabulary.** Severity **1**. `No tracking event for over 30
days, so they are no longer polled.` → `…so the app stopped asking the carrier about them.` The page was empty for all
14 days, so the assign form and Dismiss could not be evaluated.

### 2.8 Menu bar and notifications

**F32. The menu-bar number counts pickups only; a courier at the door today does not change the icon.** Severity
**2**. Heuristic: *Visibility of system status*. Day 4 and day 6: `0` in the menu bar all day while two DPD boxes and a
cash-on-delivery SPS courier were out for delivery. **Recommendation:** keep the number for pickups, but give the glyph a
second state (the ¾ ring from the card) while something is out for delivery.

**F33. Banner text repeats the carrier's sentence instead of what to do.** Severity **1**. `Ready for pickup — Foto
Hrádok / Z-BOX Fiktívny Hrádok, Hradná 3 (Billa), Fiktívny Hrádok · collect by Tue 10 Nov` is good; `Registered —
AliExpress / Zásielka bola podaná odosielateľom.` is a banner nobody needs (see F4).

### 2.9 First-run pages

**F34. `move-in.html` is good; `result.html` is well-formed but one line short.** Severity **1**. Move in: one question,
consequence stated, way out (`Not now (quit)`), long path wraps at 390 px (`firstrun-390-light.png`). The failure page
(`Your parcels were not moved` / `{{step}} did not work.` / `{{reason}}` / `{{next}}` / `Try again` / `Quit`) names what
failed, why and what next, which is the right shape; it should also carry the README's promise `Your Terminal install is
running again as before.` The README's "Going back" is Terminal-only (`launchctl bootstrap …`), so for a non-technical
user a move-in is one-way; the move-in page should say `Going back needs Terminal.`

### 2.10 Accessibility, cross-cutting

- **Contrast:** the measured pairs in design language §2.3 hold for what was rendered. The 13 px ink-3 meta (`GLS ·
  90444444410`, help lines under fields) is the weakest text and stayed above 4.5:1 in both themes. No failure found.
- **Text size:** body 15 px, meta 13 px. 13 px carries a lot: every help line in Settings, all of Health, the tracking
  numbers. For friends over fifty, 14 px help text would be kinder. Severity **1**.
- **Click targets:** buttons 28–36 px; `Undo` and `Change` are 13 px text links with small hit areas; `Add to Calendar`
  is a 26 px disclosure. All above the 24 px floor. Severity 0.
- **Reading order at 390 px:** F14 (Delete before actions), F20 and F22 (tables).
- **Language:** F19. English chrome, Slovak carrier text, on every page.
- **Error states reached:** the 404 (`There is no such parcel. It may have been deleted, or the link is from an old
  page.`), good; the Refresh no-op notice (F9), poor. Not reachable in this scenario: a failing carrier, a rejected
  postcode, a refused calendar time, a failed Gmail test, a failed move-in.

### Not seen in this run

A deadline today or passed (the warn wash); `failed_attempt`, `problem`, `returning`; a failing carrier on Health; an
Attention item with the assign form; the Refresh spinner page (the run finished before the redirect rendered); the
Welcome page for a Mac without a Terminal install; the Gatekeeper dialogs (outside the simulator); the native banner
rendering (seen only as the day digest's text); `result.html` rendered with real values.

---

## 3. First run and setup

The path a non-technical friend walks, as the README (`install-the-app`), `app:first-run`, Settings and the two static
pages describe it, with an estimate of where people drop off. Estimates are judgement, not measurement; they assume
friends who use a Mac daily but have never opened Terminal or System Settings → Privacy & Security.

| Step | What they see | Drop-off | Why |
|---|---|---|---|
| 1. Pick the DMG | GitHub Releases with `arm64` and `x64` files; README says to open About This Mac | **15 %** | A GitHub release page is an unfamiliar surface; "arm64" means nothing. Some will download the wrong one and get "cannot be opened" with no explanation. |
| 2. Gatekeeper | `"Parcels" cannot be opened because Apple cannot check it for malicious software` → Done → System Settings → Privacy & Security → scroll → Open Anyway → password → Open Anyway again | **35 %** | Seven clicks across two apps, the first dialog says *malicious*, and the README is the only guide. The app cannot help: it is not running yet. The README text is correct and specific ("Done, not Move to Trash"), which is the best an unsigned app can do. |
| 3. Move to Applications | Native offer | 2 % | Clear. |
| 4. Welcome (postcode) or Move in | `Move your parcels into the app` with `Move in` / `Not now (quit)` | 3 % | Good page. For a friend there is no clone, so they see Welcome (not rendered here). |
| 5. Settings → "How to connect Gmail — three steps, about five minutes" | Twelve bullets: download `gmail-filter.xml`; open Gmail filter settings; Import filters; Choose File; tick "Apply new filters to existing email"; Create filters; open label settings; tick Show in IMAP; turn on 2-Step Verification; open App passwords; Create; copy; paste | **40 % cumulative** | The cliff. Gmail's filter import is a hidden feature at the bottom of a settings tab most people have never opened; "Show in IMAP" is a checkbox on a different tab; 2-Step Verification may need a phone-enrolment flow of its own; App passwords is a page Google hides unless 2SV is on and refuses on managed accounts. Each step is a page away from the app, with no way back except the browser. |
| 6. Paste the App Password, Save | `Saved.` plus the test sentence at the top | 5 % | The test sentence is excellent; it is above the fold only on a tall window. |
| 7. Wait for the first poll | Nothing until the hour, or `Refresh now` | 10 % | Nobody is told to press Refresh now. `Nothing in flight…` is calm but indistinguishable from "setup failed". |

Cumulative: roughly **one friend in three** reaches a working app unaided; the rest need the author on the phone at
step 2 or step 5. Step 2 is fixable only by signing and notarising (a one-time developer account), which is also the
only way to remove the word "malicious" from the first impression. For step 5, what the app can do:

1. **Number the steps and group them under three bold headings** (`1 · Label your mail`, `2 · Show the label to IMAP`,
   `3 · Make an App Password`), each with its own "Open Gmail here" link, so the disclosure matches its headline.
2. **Make "Show in IMAP" unmissable:** bold, and repeated under the Gmail label field as the first thing to check when
   the test says the label is empty.
3. **Replace "about five minutes" with the truth** (`about ten minutes, on three Google pages`).
4. **Put the test result next to the password field,** and make the empty-label answer say the next step: `Connected,
   nothing to read — tick "Apply new filters to existing email" and "Show in IMAP", then try again.`
5. **Finish setup with a button:** `Refresh now` on the Saved notice, and one line on what happens next.
6. **Move-in page:** say `Going back needs Terminal.` **Failure page:** add `Your Terminal install is running again as
   before.`
7. **Welcome page** (not seen): if it asks only for the postcode, it should also say that Gmail comes next and that the
   app works without it (`Add parcel`), so that a friend who gives up at step 5 still has a usable app.

---

## 4. Top 10 recommendations (impact over effort)

1. **Read the GLS ParcelShop mail for PIN and place** and print them on the card like the Packeta code (F1).
2. **Show the cash-on-delivery amount, the courier's number and the delivery window** on out-for-delivery cards and
   banners (F2, F6).
3. **Notify on email-only mail and put `Mark as received` on the card** so a DHL parcel can finish (F3).
4. **Rewrite "How to connect Gmail"** as three numbered groups with Show in IMAP in bold and an honest time (F25).
5. **Finish setup with a next step:** test result beside the field, `Refresh now` on the Saved notice; and after Move
   in, say "connected, first check at 21:00" instead of "not connected" (F26, F27, F10).
6. **Quiet the banners:** Act states and Delivered by default, `Registered`/`In transit` opt-in, one banner per order
   (F4, F7).
7. **Give the reminder banner a `Collected` action** and say that marking stops the reminders (F5).
8. **Fix Health and History below 40 rem:** lists instead of tables, no letter-wrapped cells (F22, F20).
9. **Never head a card with a bare tracking number:** use the sender name from the mail; Name field under the `h1`
   (F8, F15).
10. **Slovak and Czech chrome** for status words, nav and the sixty strings of copy (F19).
