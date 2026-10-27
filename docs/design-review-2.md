# Review of the built redesign (round 2)

Reviewer: Alex. Reviewing: the running build at `127.0.0.1:8787` against `docs/design-language.md` (rev 2, section 14 read first). No product source modified, no tests run, nothing committed. My tab is closed; the server is untouched.

## How I checked

- Opened my own tab and walked `/`, `/parcel/34`, `/parcel/36`, `/parcel/1`, `/history` (plain, with `q`, `carrier`, date filters, and a zero-result filter), `/health`, `/attention`, `/add`.
- Widths: 375, 800, 1024 (exactly the 64rem breakpoint), 1440 (the tool's real viewport is 1440 CSS px, screenshots are scaled), 2560. Light and dark.
- Interacted rather than read: Tab-walked the index and read the computed focus ring; opened the raw-response `<details>` on #34; clicked the stretched link; clicked and selected a tracking number; drove a `:user-invalid` state on `/add`; compared nav box positions across all pages.
- Measured contrast on the built elements (not the spec's tables), and read `src/web/views/*.ts` to explain what I saw.
- The live data has no unclassified-prose row, no `failed_attempt`, no `out_for_delivery`, no deadline. To see those I injected throwaway DOM into my own tab, with the page's own classes and sprite. Nothing persisted and I did not click Refresh, Save or Add (they write to the real DB).
- Caveat: full-page screenshots time out at 2560 and sometimes on scrolled pages, so the 2560 check is geometry only (frame centred at x=731..1829, 18px root, no overflow), not a visual.

## 1. What genuinely works

- **The lede is now honest, and you can see why.** `1 ready for pickup. 3 in flight.` is the first thing under the heading, and it is the right first thing. I read `indexLede` as well: the "has no status; read its latest message" clause and the gated "Nothing needs you." are implemented as specified, with the failing-carrier clause. The false-negative I called the worst failure of round 1 cannot happen from an uncoded prose status any more.
- **The pickup card is the right shape for the data.** One blue header with the place at 22px, the parcel beneath it, `Since Mon 26 Oct, 17:19`, and a footer that says `Packeta gives no pickup deadline.` There is no empty "Collect by" slot and no dead Maps link, and the card does not look like it is missing something. Dropping the name-search Maps fallback (`mapsUrl` returns nothing without coordinates, with a comment saying why) is a better call than the "Search in Maps" label she specified: a link that is a guess is worse than no link.
- **Selection survives the stretched link.** `elementFromPoint` at the centre of each tracking number returns the number itself (`position: relative; z-index: 1`), `user-select: all` is on, and a real click selected `Z1234567890` and stayed on `/`. Clicking the empty part of the MTBIKER row went to `/parcel/36`. This was my S5 and it is fixed properly.
- **The timeline on #34 holds.** Newest first, with the run head on the newest row of each run so the status word sits above what it labels. The two DPD tie-break pairs come out in the right order (`MIA`/Out for delivery above `MII`; `DEHDY`/Ready above `DODEI`). The `Sun 25 Oct` heading is correct for the 00:05 CEST event that is 22:05 UTC on the 24th, so the zone handling is right, and the DST change inside the range causes no visible fault. Five coded-unknown rows read as plain sentences with a dot and no "Unrecognised ENA". The two oldest rows with no location look right. The rail runs through day headings. The timeline ends at y=1433 (page 1528px); the delivered answer is in the first screen.
- **The frame is stable.** Nav `Parcels / In flight / History / Attention / Health` sits at x=232 on every page at 1440, and `Add parcel` right-aligns at 904 on every page. The two-column parcel layout fits at exactly 1024 with no overflow (timeline 24..696, details 728..1000) and collapses to one column below. My S4 is fixed.
- **Four registers do teach themselves.** On the real index the only filled rectangle is the one that needs you, and that is the whole legend. Injecting a solid warn badge, an outlined signal badge, an unclassified prose row, a `No updates yet` row and a plain `In transit` row into one list, the hierarchy read correctly at a glance: badge rows first, then the dot-plus-full-ink prose row, then grey. The bare dot reads as a bullet beside `No updates yet`, not as an error. I never read it as "broken".
- **Colour-free carrying is real.** `Delivered` (disc + word), `In transit` (half ring + word), `Registered` (ring + word) and Health `ok` / `no data` are all distinguishable with the hue removed. The word is always there.
- **Focus is visible and consistent.** A 2px ink ring, drawn inset on the pickup line and on rows (`outline-offset: -2px`, so the card's `overflow: hidden` does not clip it), 2px outside elsewhere. Visible in both schemes; it is the light ink in dark mode.
- **Contrast in the built page matches the spec.** Measured on rendered elements: nav inactive 5.09, lede 7.38, table header 5.09, status word `Delivered` 7.30, placeholder 5.50. No surprises, so her measurement habit survived contact with the stylesheet.
- **Dark mode is good.** Index, #34 and History in dark: surfaces step up in lightness, the blue badge flips to light fill with dark text, `Delivery attempt failed` is a legible orange, nothing is muddy. I had said I was wary of the warm greys in dark; I withdraw that.
- **History does its job.** Real 33 rows (the doc's 34 never reconciled; the page says `33 finished parcels: 1 delivered, 32 archived`, which is right), year groups `2026 · 14`, `2025 · 18`, `2023 · 1`, names underlined at `--edge`, the Outcome column holding exactly one `Delivered`, dates that read `25 Oct` under a year heading. The filter works, the lede recounts under a filter (`5 matching parcels: 5 archived`), the empty state is a sentence. No horizontal overflow at 1440.
- **Archive and empty states say the true thing.** `/parcel/36` says `No updates yet` / `Nothing from the carrier yet.`; the lede counts it as in flight without blocking. Raw `<details>` opens to a 320px scroll box with `tabindex="0"`, no page overflow.
- **Attention shows the year** (`12 Nov 2025`, `27 Oct 2025`), so the one-year-ago-same-day trap is gone.

## 2. Must change

### M1. The lede can still say "Nothing needs you." next to a row that says "Postcode needed"

**Where:** `/`, when an in-flight parcel has a rejected postcode (the `/parcel/36` state you pointed me at, with a GLS or DPD parcel whose carrier refused the postcode).

**The problem.** The row and the parcel page correctly show `Postcode needed: set one ... to resume full tracking.` (warn-coloured), and `core/poll.ts` line 98 then skips that parcel on every poll because `postcodeRejected(p)` holds. But `indexLede` counts only `ready_for_pickup`, `out_for_delivery`, `failed_attempt`, `problem`, uncoded-with-events, and failing carriers. A parcel with a rejected postcode is none of those, so with otherwise-quiet parcels the lede prints `2 in flight. Nothing needs you.` directly above a warn line telling the owner it needs them, and the parcel's status is frozen, because it is no longer polled.

This is the same defect class as round 1's M1, and she added rule 6 specifically to prevent it ("nothing a page depends on is broken"). It is not visible in today's data (#36 has postcode 81101 and is not flagged), which is why it is easy to miss. I read the code rather than seeing it in the browser, so treat the render as predicted, not observed.

**Do instead.** In `indexLede`, count `postcodeRejected(e.parcel)` and say it: `2 in flight. 1 needs a postcode.` Do not emit "Nothing needs you." while that count is non-zero. A one-line clause plus a guard on the all-clear.

Nothing else I found is a must. The three round-1 musts are fixed (section 3). This one is the gap left at the edge of one of them.

## 3. The three round-1 musts

| # | Verdict | Evidence |
|---|---|---|
| (a) Lede and `unknown` labels | **Fixed**, with one gap (M1 above) | Live: `1 ready for pickup. 3 in flight.` Labels by cause: `No updates yet` on GLS (index row and parcel header), `Archived` copy defined, prose sentence promoted to the status slot (seen in the injected row). The page never prints "No status yet". |
| (b) Pickup panel | **Fixed** | One card per place, `Since` line, no-deadline sentence, no map link without coordinates, focus ring inside the card. The one-parcel case is 173px tall and looks complete. At 375px the header wraps (badge under the place) and nothing breaks. |
| (c) Timeline on #34 | **Fixed** | Oldest-first reversed, `id DESC` tie-break, heads on the newest row of a run, coded-unknown runs as plain sentences, zone-correct day headings. Two residual issues below (S1, S2). |

## 4. Should change

### S1. Day headings are `aria-hidden`, so a screen reader hears 23 bare clock times with no dates

**Where:** `/parcel/34`, source `views/parcel.ts`: `<li class="day" aria-hidden="true">`. The `<time>` elements carry the full ISO date in `datetime` but only `20:50` as text, and assistive tech reads the text. Nine days of events become `20:50 ... 00:05 ... 13:58 ...` with no day, and the DST day (`Sun 25 Oct`) is exactly where that matters.

**Do instead.** Remove `aria-hidden` from the day `<li>` so the heading is read before the rows under it. If she wants the headings out of the list semantics, put the day as visually-hidden text inside each row's `<time>` instead.

### S2. In the timeline, an unknown row and a "continuation of this run" row are the same dot

**Where:** `/parcel/34`, top of the page. `Delivered` head, then the 00:05 row `Zásielka bola vrátená v dôsledku vypršania doby uloženia zásielky` as a plain dot. It is the contradictory pair (returned for expiry, then collected), and it is the one row the reader must not misread. Visually it is indistinguishable from the other dot rows, which are same-status continuations (e.g. the three `Ready for pickup` rows). So it reads as if it belonged to the Delivered run. The same applies at the bottom: the two `Integrovali sme Vaše údaje` rows, which are unknown, sit directly under an `In transit` run as dots and read as part of it.

Her design is right not to editorialise (I agree: print what the carrier said, in order). The fault is that two different facts use one glyph.

**Do instead.** Give continuation rows a rail-attached dot (as now) and give unknown rows a hollow 4px ring, or the reverse. One shape difference in the glyph column, still no hue, and the contradictory pair becomes legible as "a row that is not part of the run above". If she would rather not, accept it: this is a should, not a blocker, and the sentences are still all there.

### S3. History's "Delivered from" label is wrong for the filter it controls

**Where:** `/history`. The date inputs are labelled `Delivered from` / `to`. They filter archived rows too: `?from=2026-06-01&to=2026-12-31` returned 6 parcels: 1 delivered and 5 archived (the dates are first-seen dates). So the label promises a delivery filter and quietly delivers a "date" filter.

**Do instead.** Label them `Date from` / `to`, matching the `Date` column and the caption. One string.

### S4. Identical names in History cannot be told apart

**Where:** `/history`. `Vinted` appears 5 times (`?q=vinted` gives 5 rows), `zajo.design.s.r.o.shop` 3, `iFix s.r.o.` 2, `Zlaté Zrnko` 2. The rows differ only by a date column that, for archived mail, is the day it was first seen in email. With no tracking number, nobody can say which `Vinted` was the jacket. This is the table's real job (find a parcel) and it fails on the most common case in the real data.

**Do instead.** Show the tracking number as a trailing `ink-3` mono token on the same line when it is not the name: `Vinted  Z1748571211`. It costs no height and she already has the `.mono` style. This is the one place I would carry an identifier on a row, and it is the opposite of the codes-on-timeline question in section 5.

### S5. Below roughly 465px the nav and the History table overflow

**Where:** 375px. The nav is `flex-wrap: nowrap`; `In flight` wraps to two lines and `Add parcel` lands at x=398..441, beyond the 375 viewport, so every page gets a horizontal scroll (page width 438 to 472 depending on page) and the primary action is off-screen. `/history` table runs to x=472. The doc says "narrow (< 40rem): nothing is hidden"; at phone width, it is.

I do not think this matters on a localhost Mac tool, which is why it is not a must. But it is a cheap fix: `flex-wrap: wrap` plus `white-space: nowrap` on the links, and an `overflow-x: auto` wrapper on the two tables. Do it or delete the claim from the doc.

### S6. `:user-invalid` is a hue-only cue

**Where:** `/add`, clear the Tracking number field and tab away. The input's only change is `border-color: #b83c08` at 1px, against a `#8c877a` 1px border. There is no icon, text or weight change, so someone who cannot tell the two apart sees nothing. The browser's own bubble appears on submit, but the field itself is the standing state.

**Do instead.** Add `border-width: 2px` (compensate padding by 1px to avoid a shift) or a `box-shadow: inset 0 0 0 1px var(--warn)`. A non-colour change in the same rule.

### S7. Reserve the bold width for the current nav item

**Where:** every page. The current item is bold, so it widens by 3 to 4px and moves every item to its right: `History` is at x=392 on the parcel pages and at 395 on `/`; `Attention` is 465 or 468; `Health` 552 or 555 or 556. Her goal ("the nav never moves") is met to within 4px, not exactly, and a 4px nudge between pages is just visible when you flip quickly. No JS needed: `a::after { content: attr(data-t); font-weight: 600; height: 0; visibility: hidden; display: block }` reserves the bold width, or set a `min-width`. Low priority; I mention it because she made a point of measuring the left edge.

## 5. Her rejections (section 14): was she right?

**Yes on all five.**

1. **No carrier codes on timeline rows.** Right. I looked at the 23-row page cold and the prose is the content; a trailing `HUS` / `SPL` / `ENA` would be noise on every row. The `title` on the row covers the developer. One cost she did not mention: `title` on the `<li>` gives it the accessible name `carrier code DODEY` in the tree. Put the `title` on a `<span>` inside the row (or on the `<time>`), so it is not a listitem name. Trivial. I conceded codes, and I still do.
2. **Not folding duplicate events.** Right, now that I can see it. The four `HUS` rows at Dolny Hricov (20:01, 20:03, 20:05, 21:20) read as a heartbeat with times, which is the information ("it kept being re-sorted"). Folding would have lost it and cost a grouping rule. The place the duplication does show is the `Ready for pickup` head followed by an identical sentence at the same minute (13:58). That is the carrier's doing, and it is only one row.
3. **No colour on pickup age.** Right. `Since Mon 26 Oct, 17:19` carrying no urgency colour is correct: there is no known limit, and the page says so in the footer. When a day has passed it adds `· 1 day` in bold, which is the right weight of nudge.
4. **No meta-refresh.** Right. Absolute dates sit next to every relative count (`Since Mon 26 Oct, 17:19`; times with day headings), so a stale tab is dated, not wrong. I would have lost scroll position on the long page for nothing.
5. **Not recolouring `ok`.** Right. The Health page is six `ok` rows with a disc, the word and a green tint, and `no data` with a ring. The redundancy rule carries it and nothing depends on the green. (See T3: I think Health overuses the mark, which is a different point.)

Where she held position against me and I now say she was **wrong**: nowhere. Where she took my point and I now say it went slightly too far: Health `ok` ×6 (T3).

## 6. Taste: I will not fight over these

- **T1.** The row heading includes the carrier and tracking number (`MTBIKER order 1948688 GLS · 1234567890`), so the heading's accessible name is long. Reading order is fine; I would have put the meta outside the `<h3>`. Skip it.
- **T2.** In one-column layout (800px) the main column is 752px but the nav is capped at 672, so `Refresh this parcel` right-aligns 80px past `Add parcel`, and the Label/Postcode inputs stretch to full width. It looks fine; it just does not line up. Cap the one-column parcel page at 42rem for consistency, or leave it.
- **T3.** Health: the exception (`no data` on SPS) is the quietest row on the page and six healthy rows carry a green disc. That inverts her rule 1 ("mark the exception, not the norm"), and the lede line carries the real signal. I would drop the mark from `ok` (word only) and keep it for `no data` and anything failing. Defensible as is.
- **T4.** `/parcel/1` and `/parcel/34` print `carrier says: ok` / `carrier says: DELIVERED` in the meta line. It is raw data, and the `DELIVERED` echo is redundant beside the status badge. Harmless.
- **T5.** The Median table repeats `— no deliveries yet` four times for one real row (`DPD 8.0 days n = 1 of 1`); the "no deliveries yet" text sits ~2px above the baseline of its row label. Collapse the empty carriers into one line, or leave it.
- **T6.** The postcode placeholder `default` looks like a real value in ink-3; `Optional` would read better. Label input on parcels with a label is pre-filled with the name and visibly truncated (`MTBIKER order 19486`), fine.
- **T7.** No `forced-colors` rules in the stylesheet (the badge has a transparent border for it, but nothing else). Irrelevant on macOS; note for completeness.
- **T8.** No skip link. With five nav links I would not add one.
- **T9.** Spec says unknown-with-events rows have no word; I saw (injected) that the sentence in full ink with a dot is a good treatment and I would not touch it.

## 7. The two-second question

Cold, on the live index: a blue card with a place and the words `Ready for pickup`, under `1 ready for pickup. 3 in flight.`, and two quiet rows. The answer to "does anything need me?" is there before I read a second sentence. With the injected busy list, the badge rows outranked the prose row, which outranked the grey ones, without my having been told what the badges meant.

Is a bare dot "nothing yet" or "broken"? Nothing yet. Next to `No updates yet` it is unmistakable, and in the timeline it reads as a bullet. I never mistook it for a fault.

## Verdict

This is good enough to ship. The three round-1 musts are fixed in the running page, her rejections hold up, and the stylesheet, at 11.3 KB, is not a concern. One thing must change, and it is small: the lede has to count rejected postcodes (M1), because it can otherwise print "Nothing needs you." beside a warning that says the opposite, and it is the same class of bug she set out to remove. The rest (S1 to S7) is cheap polish, led by S1 (a screen reader loses every date in the timeline) and S4 (History cannot tell five `Vinted`s apart).
