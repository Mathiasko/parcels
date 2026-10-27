# Review of "Parcels: a design language" (round 1)

Reviewer: Alex. Reviewing: `docs/design-language.md`. No product source touched; no tests run; nothing committed.

## How I checked

- Re-computed every contrast ratio and every CVD hex / delta-E in her tables (WCAG 2.x luminance; Machado 2009 at severity 1.0; CIE76), and computed the pairs she did not tabulate.
- Read the six real pages in `/tmp/ui-before/`, and read a **copy** of `data/parcels.db` (36 parcels, their events by carrier, status and code) to see what the carriers actually give us. This changed several of my findings, because the mocks in the document use data the live system never produces.
- Rendered her sprite, badge and card anatomy in a headless browser served with the **exact** CSP header from `src/web/server.ts` (`default-src 'none'; style-src 'unsafe-inline'; form-action 'self'`), and rendered six simultaneous pickups plus the single-pickup case at a 1440-wide viewport. These are throwaway fixtures, not a re-mock of her design.

---

## 1. What genuinely works

- **Her numbers are right.** All 19 contrast figures reproduce to two decimals (ink/paper 15.86, warn/paper 4.70, warn/signal-wash 4.43, edge/surface 3.49, dark signal/paper 8.29 and so on), and all the CVD hexes and delta-Es reproduce (protan signal/warn 114, deutan 130, ok/ink-3 9 and 11). The "rules are decoration, edges are information" split, found because her first border colour measured 1.7:1, is exactly the kind of catch that separates a measured design from a pretty one. Carry on doing this.
- **"Mark the exception, not the norm" is correct for this data.** 32 of 34 history rows are archived-and-silent; a chip on each would be 32 identical grey objects. Dropping the Merchant column is even more right than she says: in the live history, merchant equals the parcel name on 29 rows and is empty on the other 5; it differs on **zero**, because the name is `label ?? merchant ?? number`.
- **Dropping blue-for-everything is right.** The current `button { background: var(--accent) }` makes every page permanently carry the one colour that should mean something. Ink-filled primary buttons are a good, sober call.
- **The status words are always present.** Word, silhouette, register, hue, in that order of trust: the right ordering, and it is why most of my CVD concerns below are survivable.
- **Cards-as-link via stretched `::after`, `min-width: 0`, names wrap but history names clamp, `tabular-nums`, `slashed-zero`, no auto-hyphenation of addresses, no cleaning of carrier text.** All correct, all things people get wrong.
- **Date-by-age.** She spotted the year-less date problem on the Attention page. Good. (I found a second, worse instance; see S6.)
- **Section 13 is honest.** Most of what I flag below she already suspects. My job is mostly to say how much worse it is.
- **`<use href>` works under the real CSP.** Verified, see section 5.

---

## 2. MUST change before implementation

### M1. The lede "Nothing needs you." is a claim the data cannot support, and "No status yet" is wrong for most of the cases it will label

**What the real data says.** Of 36 parcels, 24 are Packeta and 5 are SPS, and those two carriers supply no per-event codes (and 33 of 36 parcels are `unknown` overall, 32 of them archived). The one live Packeta parcel (#35, "Bratiska") has three events before the pickup one, all `unknown`, all prose: "We are aware of your parcel…", "We have successfully received the parcel for transport…", "It's almost there! Your parcel is on its way to you." The status of a Packeta or SPS parcel is therefore routinely `unknown` while the carrier's sentence is perfectly informative, and while a carrier sentence like "delivered to the pickup point" may have arrived in a poll before the status mapping caught up.

**Case 1 (the lede lies).** The lede is computed from status: `2 in flight. Nothing needs you.` A Packeta or SPS parcel whose latest prose says it is at a pickup point, status still `unknown`, produces exactly that sentence. She calls this "the product's best moment"; it is also the product's worst possible false negative. The page is making an assertion of absence from a field that is `unknown` on 33 of 36 parcels.

**Case 2 ("No status yet" is false for the archived 32).** All 32 archived parcels have status `unknown` and **zero** events. Click one from History and the parcel page says "No status yet" in the header and "No tracking events yet." in the timeline, for a parcel from August 2023. "Yet" promises something is coming; for an archived parcel nothing ever will. Her own §13 doubts this label for "old and silent"; the real count is 32 of 34 history rows, not an edge case.

**Case 3 (two labels, one fact).** Her index-row mock for `unknown` reads `No status yet. No tracking events yet.` Two sentences in a row, the second explaining the first.

**Case 4 (label next to prose contradicts it).** An `unknown` parcel *with* events would read `No status yet. Zásielka bola doručená na výdajné miesto.` The first sentence says nothing is known; the second says it was delivered to the pickup point.

**What I would do.**
1. Make the status label depend on *why* it is unknown, not on the enum value alone:
   - no events and not archived: `Not tracked yet` (or whatever she likes; it must be the "waiting" voice);
   - archived: `Archived` (or `Not tracked`); no "yet", and the parcel page should say once "Found in old mail; never tracked." instead of two silent lines;
   - events exist but the status is uncoded: **show the carrier's most recent sentence in the status slot** and no status word. For a prose-only carrier, the sentence *is* the status. This also removes the contradiction in case 4 and uses the 2-line clamp she already designed.
2. Reword the lede so it only states what is known: `3 in flight. 1 ready for pickup.` / `2 in flight. None ready for pickup.` And when any in-flight parcel has an uncoded status and an uncoded latest event: append `1 has no status; read its latest message.` The "calm" version only shows when there is genuinely nothing unknown to qualify. The principle "the page should say no calmly" survives; the false "no" does not.
3. If you want to keep "No status yet" for the genuinely brand-new case (GLS "MTBIKER order", no events, 0 minutes old), fine; it is correct there and I would not fight over wording.

### M2. The act card is designed around data that four of five carriers never supply

**What the code and DB say.** `retainedTill` is only ever set by `posta.ts`. Packeta, GLS, DPD and SPS all have a code comment `// no retainedTill: <carrier> supplies no deadline`. In the DB: 0 of 36 parcels have `retained_till`, 0 of 36 have `pickup_lat`/`pickup_lon`, 1 has a pickup name, and that name is the whole string `Z-BOX Bratislava, Hlavna 6` (street and city columns are empty). `mapsUrl()` in `parcel.ts` returns `undefined` without coordinates.

**Case.** Her mock card shows `Collect by Sat 31 Oct · 4 days left` and `Open in Apple Maps ↗` on a **Packeta** parcel. The real card for the real parcel will have: a name, a badge, a blue panel holding one 22px line, and a footer. No deadline, no Maps link. The whole urgency system in §6.1 (relative counts, ink-weight steps, the panel flipping to `--warn-wash`) applies only to Slovenská pošta, which the live data has one test parcel of.

This is not fatal to the card, and I think it still reads fine. I rendered the one-pickup case with location only, and the panel is just a single large line on a blue wash; it works. But three things follow:

1. **For 4 of 5 carriers the only urgency signal is age** ("Ready since yesterday, 17:19"), and she has put it in the 13px ink-3 footer, the quietest spot on the card. Move it into the panel (second line, in the position the deadline would have), with a plain-language age. `Ready since yesterday` should visibly progress (`3 days`, `a week`) because that is how someone decides whether to go today. Packeta holds parcels for a limited time without telling us how long, so "no deadline" must not read as "no limit". Consider stating `No deadline given by Packeta` once as a footer fact for ready parcels. This *is* information; her "we do not print no deadline, which would read as information we have" argument goes the wrong way here, because the user will otherwise assume there is none.
2. **The Maps link must be conditional, and probably will rarely appear.** Say so in the spec, and decide what the panel looks like without it. If you want the link available for every parcel, building a search URL from the pickup name (`https://maps.apple.com/?q=<name>`) works without coordinates; flag it as a product choice.
3. **Specify the card when the location is absent.** Packeta's pickup event can arrive without parseable place text. The panel then has no content; the card should degrade to the row's two-line form with the solid badge, not to an empty blue box.

### M3. The timeline spec was never run against a real multi-event parcel, and it breaks on the one we have

Parcel #34 (DPD, "Goodcang9not seller") has 24 events. Newest first, the status sequence is:

`delivered, unknown(DODEX), ready x3, failed_attempt, out_for_delivery x3, in_transit x9, unknown x5`.

Applying §6.4 to it:

1. **Five consecutive `unknown` events, but they all carry codes** (`ENA`, `ENA`, `ORI`, `SPE`, `SPL`). Her calm "a run of plain sentences" treatment is only for code-less events. With a code, each row gets `Unrecognised status ENA` above the sentence. That is five rows, ten lines, with a label that tells a non-expert nothing and sounds like a fault, for events whose text reads "Integrovali sme Vaše údaje", "Váš balík je na ceste". Worse, the same code `SPL` ("Váš balík je na ceste") is `unknown` at Erftstadt and `in_transit` at Mörsdorf one day later; DPD's own codes do not map to statuses one-to-one. So the label is also not even consistent.
   - Fix: the code is a carrier identifier, not a diagnosis. Show it as a trailing mono `ink-3` token beside the location (`· Erftstadt · SPL`), and drop the word "Unrecognised". Whether to treat coded-unknown differently from uncoded-unknown at all is, as far as I can see, a distinction only a developer cares about.
2. **The status word lands at the bottom of each run, i.e. under the rows it labels.** "Show the word when a row's status differs from the row *older* than it", reading newest-first, puts the word on the *oldest* row of a run. For the three `ready_for_pickup` rows (21 Oct 11:55-11:58) the two upper rows get a glyph only and the word appears at the third. The eye hits glyph-only rows first, then finds the word below. In a newest-first list, put the label on the **first (newest) row of each run**, i.e. compare with the row *newer* than it, or give each run a one-line sub-header. The "mark the change" idea is sound; the anchor is on the wrong end.
3. **Her assumption "timeline arrives newest-first" is false today.** `db/events.ts:69` is `ORDER BY occurred_at, id`, which is oldest-first. The template has to reverse, and the tie-break needs `id DESC`: two DPD events (MII and MIA) share `07:42:08` to the second, and nothing about the spec says which goes first.
4. **Day headings: 9 of them for 24 events.** That is fine, but note the oldest-two events (17 and 18 Oct) are real "unknown" prose with no location; the rail still has to look right when a trailing `· location` is absent.
5. Times: all 34 events have a full timestamp in the raw column (`occurred_at_raw` contains `:` on every row), so her "date-only events" worry (§13) can be struck off for now. Keep the cheap `—` fallback.
6. Contradictory sequences exist: DPD reports `DODEX` ("returned due to expiry of the storage period", uncoded status) and then `delivered` ("You picked up your parcel") a day later. The design must not try to be smarter than the carrier here; her "faithful to inputs" stance is right. But it is a reason **not** to rely on the status word alone: put the carrier sentence first on every row, as she does.

---

## 3. SHOULD change

### S1. Underline-only links: the underline is the 1.4:1 "decoration" colour, which contradicts her own rule

§9: links get a 1px underline in `--rule-s`. Her §2.3 is explicit that `--rule-s` is "decorative, ~1.4:1; **edges are information at ≥ 3:1**." The arithmetic: `--rule-s` on paper is 1.43, on surface 1.55, on the pickup panel (`--signal-wash`) **1.35** (dark: 1.30). So the one link inside the most important panel on the index, "Open in Apple Maps", is a body-coloured string with a 1.35:1 underline. In my render it reads as a caption, not a control; only the arrow rescues it. For in-text links that are ink on ink, a 1.4:1 underline fails the "distinguishable without colour" requirement she is trying to meet (WCAG 1.4.1 asks for a 3:1 cue or a hover/focus cue, and this one has neither at rest).

**Do instead:** keep ink links and keep blue scarce, but draw the underline in `--edge` (3.23 on paper, 3.04 on the signal wash, 3.21 on the warn wash). Costs one token reference.

**The bigger affordance cost is not inline links, it is everything else that is clickable and looks like text:** nav items (ink-3, no underline), card/row titles ("the exception"), history name cells (ink, "block link"). On the real history page the 34 names are the *only* way into the parcel. With no underline, no colour, and a hover only, a first-time user learns it is a link by hovering. I would **not** reintroduce blue. I would underline the name in the history table at `--edge`, since in a dense table the name is the only link in the row, and let rows and cards keep hover plus ring (their whole-surface hover makes them read as targets).

Blue-for-status-only, as a call: I think it is right and would not spend blue on links. Where I part with her is only the 1.4:1 underline, which is a bug in the execution, not the principle.

### S2. `--warn` text fails 4.5:1 on the row hover state

Her table shows warn on paper (4.70) and warn on warn-wash (4.67) but not on `--hover`. I computed it: **4.46:1** in light mode. It matters because `returning`, `failed_attempt` and `problem` words/outlined badges are 13px/600 (not "large text"), they live on rows, and rows turn `--hover` under the pointer. 0.04 short is a trivial fix but it is a fail on her own stated rule ("body-size text ≥ 4.5:1 on every surface it can appear on").

Darkening `--warn` to about `#b83c08` gives paper 5.13, surface 5.55, hover 4.87, warn-wash 5.10, signal-wash 4.83 (so the forbidden "orange on blue" combination would even pass), and white-on-warn 5.69. It stays recognisably vermilion. Her "I wanted it to look like vermilion, not brick" is a taste call I would defer on, but not at the cost of failing the rule she wrote. A second small gap: `ink-2` (the relative count in the blue panel, older timeline rows) on `--signal-wash` is not tabulated; it is 6.95, fine.

### S3. Six pickups: it holds, but it is the wrong shape; group by location

Measured at 1440 x 900 with her anatomy: each card is **228px** (256 when the address wraps to two lines), 16px gaps. Six cards run to y = 1668 before the row list starts; the page is ~1950px tall. Three cards fit on screen; the fourth starts at y = 908. **All the non-Act parcels, including `out_for_delivery`, land below the second screenful.** `out_for_delivery` is the "be home today" state; pushing it two screens down because three packages are waiting at a locker is the wrong trade.

What breaks and what does not:
- The lede (`6 need you.`) and sort order rescue the page: the top of the list is correct. It is not "broken".
- What is silly is the **repetition**: in my fixture three of six sit at the same Z-BOX, and in the real data every pickup so far is `Z-BOX Bratislava, Hlavna 6`. The user's habitual pickup point is the one repeating 22px headline, 3x in a row, each with its own badge, panel and footer.

**Do instead:** one card **per pickup location**, with the 22px location once and the parcels listed beneath it (name, carrier, number, "ready since"), each parcel a compact line with the solid badge on the card header only. Three parcels at Hlavna 6 becomes one card of roughly 230 + 2 x 44px, and the answer is literally "go to Hlavna 6". Parcels with no parseable location (see M2) fall back to compact Act rows (solid badge, row height) so the card tier never exceeds, say, three or four blocks. That also fixes the unspecified case of two cards pushing `out_for_delivery` off screen. If she thinks grouping is too much, the minimal alternative is: first two Act parcels get cards, the rest get a compact row with the solid badge. Either needs a stated cap.

One and zero parcels are fine. One parcel: card + three rows fits at 600px. Zero: `Nothing in flight. Parcels appear here when…` is correct; just make sure the lede does not also say "0 in flight." under it.

### S4. Page width changes across pages, so the nav moves when you click it

§4.2: 42rem for most pages, **60rem** for History and Health, and the parcel page goes two-column at 64rem. She says nav, h1 and cards share one left edge. At a 1440px viewport, a centred 42rem column has its left edge at x = 384 (I measured it); at 60rem it is at x = 240. Clicking "History" from "In flight" shifts the nav by 144px; clicking back shifts it again. For an interface whose nav is words in a row, that jump is the most noticeable thing on the site.

The parcel page is worse: a 17rem details column inside a 42rem container leaves ~370px for the timeline, which is less than the single-column layout, so the two-column design only works if the container widens, and she does not say what to.

**Do instead:** pick one outer container (about 60rem) for every page, left-aligned nav and h1 inside it, and let the narrow pages simply cap their *content* at 42rem. The nav never moves.

Also note: with a 60rem table and the longest real name at 49 characters ("Pepita Group Zrt. QR kód pre vyzdvihnutie balíka:") in 15px type, the name column is roughly 650px, which fits ~90 characters. So truncation will almost never fire at the widths she designs for, and where it does, `text-overflow: ellipsis` on a `<td>` in an auto-layout table does nothing without `table-layout: fixed` or a `max-width` on the cell; she has not noticed this.

### S5. Stretched-link cards defeat copy, and copy is a core job here

A stretched `::after` covers the whole card, so:
- You cannot drag-select the pickup address ("Z-BOX Bratislava, Hlavna 6") to paste into a map or message.
- `user-select: all` on the tracking number (the "entire copy feature") does nothing on index cards or rows, since the number sits underneath the overlay.

On the parcel page it works. On the index it silently does not. Either lift the number and the location above the overlay (`position: relative; z-index: 1`, as she does for Maps), accepting that clicking them selects instead of navigating, or say plainly that copy happens on the parcel page. I'd lift both; they are the two strings you actually copy.

A related technical point: rows sit in one shared radius-12 container, which needs `overflow: hidden` for hover backgrounds to clip at the corners. That clips the 2px focus ring on the first and last rows. Use `outline-offset: -2px` inside the row container.

### S6. Date formatter: two real fixtures she missed, and the age rule needs a full-date comparison

On the Attention page the two items are `Wed 12 Nov, 20:07` and `Mon 27 Oct, 15:57`. Today is **Tue 27 Oct 2026**. She spotted the first (a 2025 date that reads as future). The second is nastier: `Mon 27 Oct` is exactly one year ago, and has the **same day-of-month and month as today**. Any implementation of "today" that compares day and month rather than the full calendar date will render a year-old email as `Today, 15:57`. Put those two in the formatter's tests verbatim.

### S7. Health lede is false for the real data

`All five carriers reporting.` The live Health page shows SPS as `no data` / `never` (no SPS parcel has ever been polled; all five SPS parcels are archived). So only four of five are reporting. And DPD's last ok is 01:08 against 03:00 for the others. Lede suggestion: `4 of 5 carriers reporting; SPS has nothing to poll.` or simply count what is failing and say nothing about "all".

A related worry about the nav dot: this is one person's Mac. If the poller is overdue because the lid was closed overnight, the vermilion Health dot will be lit on every page every morning until the next poll runs. A warn that fires on an expected, non-actionable condition trains the user to ignore it, which is exactly what she argues against for the Attention count in item 11. Give "poller overdue" a grace period of a few missed runs, or show the dot only for carrier failures.

### S8. The deadline-urgency machinery and the out-of-date page

Relative text (`Ready since yesterday`, `4 days left`, `Today, 17:19`, nav counts) is rendered at request time, with no JS to update it. A tab left open overnight tells you things that are no longer true: "tomorrow" is today, "Today" is yesterday. The user opens this page *from a notification*, so mostly it is fresh, but a stale tab is a plausible state. A `<meta http-equiv="refresh" content="900">` on the index is allowed by the CSP and costs nothing; or render the absolute date alongside the relative text in the places where wrong is costly (the deadline line). I would do the second; the first resets scroll position.

### S9. Colour-blind claims: understated for `ok` against `ink-2`

She compares `delivered` (ok) to `unknown` (ink-3): ΔE 9 and 11 under protan and deutan. True. But `in_transit` and `pre_transit` are **ink-2**, not ink-3, and both appear in the same lists as `delivered`. ok vs ink-2: **ΔE 4 protan, 1 deutan** (light); 9 and 3 in dark. Under deuteranopia those two are the same colour to within a rounding error. Her design survives (the word and glyph are always present, and she says so), but the doc should state the true worst case, and it reinforces her own rule that green must never be the only difference. It also means `delivered` green does no work for roughly 1 in 12 men, which is fine if it is understood and unfine if anyone later reduces "word always shown" (for instance in a denser table row).

Related: in my render the `delivered` and `returned` glyphs (both discs with a knocked-out mark) are nearly indistinguishable at 16px; they differ by hue that CVD erases and by the shape of the mark. She says `returned` is cramped; I'd go further and make `returned` an open ring with the arrow, so ring-versus-disc carries the difference.

### S10. History: it is a lookup tool but has lost the status column

Her instinct (one marked row in 34) is right for *this* data and wrong as a pattern. History is where the user hunts; the thing they filter on in practice is "which carrier" and "when". But with only exceptions marked, a future table with 8 returned and 10 delivered rows looks like 18 marks scattered through 34, and "archived" (grey date) vs "silent" is not learnable. I would keep her rule but write it as a contract: the third column is *Outcome*, one of `Delivered`, `Returned`, or empty; and add a count to the lede (`34 parcels: 1 delivered, 32 archived, 1 …`). Also the year grouping is a good idea; note the real distribution is 2026: 14, 2025: 18, 2023: 1 (her mock says `2026 · 12`; use the real ones in the next mock), so a one-row 2023 group exists. Fine, but do not draw a group header that costs 40px for one row without a thought.

Two items for history she knows she needs: the date header must say what the date is ("first seen in email" for archived rows, §12 item 12), and the filter labels must be visible (she covers this).

---

## 4. Matters of taste: not worth a fight

- **Calling it "a quiet instrument."** I like it. The "railway timetable" posture is right for a person who opens it for two seconds.
- **Ink focus ring instead of blue.** Her argument (blue ring on a blue wash is ~1:1) is valid, and ink works. I would have chosen the same.
- **No uppercase micro-labels.** Agree; Slovak carons make this clean.
- **Warm paper.** Taste. I'm slightly wary of the dark-mode warm greys feeling muddy, but I haven't looked at them rendered. Defer.
- **Root-size scaling at 1600/2200px.** Reasonable, though a 16" MacBook Pro in a full-width window is 1728 CSS px and will pick up the 17px root; harmless. Keep a single centred column; I agree a list of three parcels does not belong on a grid.
- **Plain English chrome.** Right call; she is honest that Slovak chrome is unplanned.
- **No icons beyond status glyphs.** Agree.
- **Two weights only.** Agree. I would not have thought to forbid 500 but I cannot name a case where she misses it.

---

## 5. Right but risky; what would make me comfortable

**Four registers instead of ten hues.** I rendered all ten indicators in a row at 16px in the light theme. At a glance it works: the solid blue badge pops, the three warn-hue glyphs form a recognisable orange family, and the grey/green rest recede. The weak pair is exactly the one she names: `in_transit` (½ ring) vs `out_for_delivery` (¾ ring). In my render they were distinguishable but only on a deliberate look; the register (blue outlined badge vs plain grey) carries them at a glance, so I am comfortable. What a non-expert has to learn is small: *rectangle with fill = needs you; everything else is quiet*. The word is always there. I do **not** think they decode a legend each time; the legend is "if it has a box, look". What would make me fully comfortable: keep the `out_for_delivery` outlined badge *really* distinct (not just a ring in blue; a visible border), and test it in dark mode.

**Two-register index.** Comfortable once M1-M2 and S3 are addressed. The sort order is right. The "jump" when a parcel changes state is a feature; I agree.

**Is "the one parcel that needs you" the right optimisation?** Yes for the index, which is what the notification lands on, and I would not change that. The "I'm looking for something" mode is not served by the index and is not meant to be; it is served by History, and that has the weak point described in S10. One gap: **there is no way to find an in-flight parcel by name** except scanning the index. With the realistic ceiling of ~10 in-flight parcels, scanning is fine. History search only covers archived/delivered/returned parcels? If it also searches in-flight, say so in the lede.

**`<use href="#g-…">` under `default-src 'none'`: confirmed working.** Reasoning: `default-src` is a fallback for fetch directives (`img-src`, `connect-src`, `font-src`, and so on). A same-document `<use href="#id">` reference is a fragment resolved inside the already-loaded document; no network request is made, so no fetch directive is consulted. If the reference pointed at an external file (`sprite.svg#id`) it *would* be a fetch and would be blocked (and cross-origin `<use>` is blocked anyway). I tested it under the real header, with fetch() from the same page blocked by the same policy in the console ("violates the following Content Security Policy directive: default-src 'none'") to prove the policy was live: the 16x16 glyphs rendered, nine `<use>` elements resolved, and nothing was logged for them. So her mechanism is safe; one caveat for the implementation: keep the sprite in the same document on every page (as she does), never in a separate file. Also, an inline `<svg width="0" height="0">` sprite works; do not use `display: none` on it if any symbol ever uses a gradient or clip-path (not the case for these ten).

**Stylesheet budget (≤7 KB).** Not plausible as specified, and the number is the wrong thing to worry about. Her tokens block, minified, is 725 bytes and the sprite is 1,981 bytes; the existing stylesheet is 3,264 bytes. My throwaway fixture, covering only tokens, one card, one row, the status classes and links, was already 2.3 KB minified. Adding the timeline rail and day headings, the year-grouped table, the nav, three button levels plus inputs, `:user-invalid`, notices in three tones, the Health board, two media queries for scaling, the two-column parcel layout, the focus system, forced-colours handling and the details/pre block, I would estimate **8 to 10 KB minified, 11 to 13 KB as formatted source**. But this is `localhost`: there is no network cost to pay, and six pages at 10 KB are nothing. The trip-wire "if it exceeds 9 KB, cut `returning`'s outlined badge" saves about 150 bytes and changes a real status register for no gain. Replace the byte budget with a complexity budget (one stylesheet, one sitting to read, no more than N component classes). The sprite *is* repeated on every page (about 2 KB), which is also irrelevant locally.

**Does anything require JS she has not noticed?** Nothing hard requires it. The honest list: (1) stale relative text, see S8; (2) `:user-invalid` on form fields needs a recent browser (Safari 16.5+, Chrome 119+), fine on a current Mac; (3) `text-overflow` on table cells needs `table-layout: fixed` (CSS, not JS); (4) `-webkit-line-clamp` is fine in current Chrome/Safari. And she should not rely on "one click away" for truncated names beyond the `title` tooltip, which does not exist on touch (not relevant here).

---

## 6. Her non-CSS list: what is missing

Her list of 12 is good. Add:

1. **Reverse the event order and add `id DESC` as tie-break** (`db/events.ts:69` returns oldest-first; see M3).
2. **A status label that depends on cause**: `unknown` plus {has events, no events, archived} (M1). This is a function of three fields, not a lookup in a map.
3. **Lede logic must account for unknowns**, and Health's lede must handle `no data` (M1, S7).
4. **Grouping Act parcels by pickup location** (S3), which needs a normalised key; today the pickup text is `pickup_name` with the full string, so equal-string grouping works for Packeta Z-BOXes but not for variants.
5. **Conditional Maps link and optional deadline** (M2); decide whether to fall back to a name-based Maps URL.
6. **Archived-parcel copy** on the parcel page and the History caption (M1, S10).
7. **A formatter test fixture list** (S6): `Mon 27 Oct` one year ago, `Wed 12 Nov`, the DST change on 25 Oct 2026 (it fell between "Mon 26 Oct 17:19" and the DPD events on 21 Oct, so day-boundary logic across a UTC offset change is not hypothetical), midnight in Europe/Bratislava vs UTC, and events in a different zone (Packeta events are stored as `Europe/Prague`).
8. **Sorting nulls** in "Act, then by last event newest first": the `unknown`/no-event parcels have no last event; say where they sort (last, by `first_seen_at`).
9. **A Health state map**: the five states in §6.9 need names that come from the data (`ok`, `no data`, `failing`, `needs attention`, `not running?`); confirm they exist or are derived (`never` polled vs `last ok` older than N).
10. **Coded-unknown display**: move the code to a trailing token (M3.1), which is a view change but one the template must be told about.
11. **The refresh result notice** already travels through the redirect as counters (`RefreshNote` in `index.ts`), so I do not think a new flash mechanism is needed; just note that the notice is now a three-tone component and the `alarm`/`ok` classes map to it.
12. **`aria-current`, `<th scope>`, `tabindex` on `<pre>`**: she has these; keep them.
13. **A decision on the Attention count** (her item 11): I agree with her. Without a Dismiss action, the two verification emails keep the badge lit permanently, so do not ship the count until Dismiss exists.

---

## 7. Summary for Angie

The document is stronger than most I see: its numbers hold and its principles are right. The weakness is that it was tuned on the happy-path examples (a Packeta parcel with a deadline and a Maps link, a timeline of tidy events), while the real data is: four of five carriers have no deadline and no coordinates; the status field is `unknown` for 33 of 36 parcels (two carriers give prose only, and 32 are old mail with no events); and the only rich timeline has five coded-unknown events in a row. Fix the three musts, run the next mock against parcel #34 and parcel #35 verbatim, and render History, Health and Attention before anyone writes the stylesheet.
