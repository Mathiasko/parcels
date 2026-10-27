# Parcels: a design language

Author: Angie. Status: **revision 2**, after Alex's review (`docs/design-review-1.md`). No product code has been touched.

**How to read this revision.** Every section I changed begins with a line starting `> **[Rev 2]**` that says what changed and why. Sections without that line are as in revision 1. Section 14 is the change log: what I accepted, what I changed *differently* from the suggestion, and what I rejected and why.

**What is measured and what is not.** Contrast ratios and colour-blind simulations were computed in revision 1 and independently reproduced by Alex; in revision 2 I recomputed everything that touches the two colours I changed (`warn`, and the `ok`-versus-`ink-2` pair he flagged). Revision 1 was designed against tidy mock data. **Revision 2 was rendered against the real database** (a copy of `data/parcels.db`, read-only): parcel #35 (Packeta, ready for pickup), #36 (GLS, no events), #1, parcel #34 (DPD, 24 events), the real history year distribution, and the real Health state, in headless Chrome at 1440px and 2560px, light and dark where noted. Not rendered, and so specified rather than seen: Attention, Add, the `:user-invalid` field state, `forced-colors`, dark-mode History and Health, and any state that does not occur in today's data (a failing carrier, a deadline row in a real parcel, a `problem` parcel). The last section lists the remaining guesses.

---
## 1. Principle

> **[Rev 2]** The principle was right and my first application of it was wrong in one specific way: I let "silent" mean "has nothing to say", when for this data it can also mean "doesn't know". The fix is a sixth rule, and a tightening of the opening paragraph. Everything else in this section is as before.

**This is a quiet instrument that is allowed to be silent when it has evidence, and that spends its voice only on the parcels that need a person.** The owner opens it because a notification fired or because they want to know whether anything needs them. Most of the time the correct answer is "no", and the page should say so calmly and let them leave. So the interface has one job in the first two seconds (*is anything waiting for me, and where?*) and everything else is reference material that must stay out of that job's way. Six rules fall out of that, and the rest of this document is those rules applied:

1. **Mark the exception, not the norm.** `unknown` events, archived parcels, healthy carriers and repeated statuses get *no* mark, or the quietest one. A thing that is true of 32 of 34 rows is not information; it is texture, and it is rendered as texture.
2. **Cards are earned.** Only a parcel that is waiting for you at a place gets a card. Everything else is a row in a list. The difference in density *is* the hierarchy.
3. **Colour is a call to action, never a fact about the data.** `unknown` and `archived` are facts. They are grey because they ask nothing of you, not because they are "bad".
4. **Word first, shape second, colour third.** Every status is readable with colour removed (it has a word), and distinguishable with colour *and* words ignored (it has a silhouette). Colour is the fastest channel but the least trustworthy, so it is never the only one.
5. **The signal hue is scarce.** Blue means exactly one thing on this site: *this is waiting on you*. It is not the link colour, not the button colour, not the focus colour.
6. **Never assert an absence the data cannot support.** *(new)* The status field is `unknown` on 33 of 36 real parcels: two carriers send prose with no code, and 32 parcels are old mail that was never tracked. "Nothing needs you" is a claim about the world, and the page is only allowed to make it when every parcel it covers has a known status and nothing it depends on is broken. When the page doesn't know, it says what it knows and points at the carrier's own words. This rule is the reason the lede (§5.2), the status labels (§2.4) and the row content (§6.2) changed.

The posture: warm paper, ink, one scarce colour, generous but not wasteful space, nothing that moves. Closer to a good railway timetable than to a "dashboard", and, like a timetable, it prints "no information" rather than a confident blank.

---

## 2. Colour

### 2.1 Why these hues

Four hues, plus neutrals. Not ten.

| Role | Hue | Meaning (and only this) |
|---|---|---|
| **Signal** | ultramarine blue | Waiting on you / coming to you: `ready_for_pickup`, `out_for_delivery` |
| **Warn** | burnt vermilion | Something went wrong or is wrong-way: `failed_attempt`, `problem`, `returning`; carrier or poller trouble |
| **Ok** | deep pine green | Finished well: `delivered`; a healthy carrier |
| **Neutral** | warm grey (ink-2 / ink-3) | Everything that asks nothing of you: `pre_transit`, `in_transit`, `returned`, `unknown`, archived |

Blue and vermilion are the safe axis for red-green colour blindness: they stay far apart under protanopia and deuteranopia (measured ΔE 112 and 128 in light mode, 78 and 90 in dark; re-run in revision 2 after `warn` was darkened). I deliberately do **not** use red and green as an opposing pair, which is what the current `--bad`/`--good` do. Vermilion is chosen over a true red because under deuteranopia it shifts to olive/ochre rather than collapsing into the green's grey.

The page itself is **warm** (paper `#f5f3ee`, not the current cool-ish `#f6f6f4`; ink `#1a1915`, not `#1d1d1b`). A parcel tracker is a domestic object, and warm neutrals make blue read as more deliberate. Pure white and pure black are never used.

### 2.2 Tokens

```css
:root {
  color-scheme: light dark;            /* native controls, scrollbars follow */

  /* surfaces */
  --paper:       #f5f3ee;              /* page */
  --surface:     #fdfcf9;              /* cards, inputs, table body */
  --hover:       #f0ede5;              /* row / secondary-button hover */
  --rule:        #e3dfd5;              /* hairline between rows (decorative) */
  --rule-s:      #d2cdc0;              /* card & list outline (decorative) */
  --edge:        #8c877a;              /* control borders: must hit 3:1 */

  /* ink */
  --ink:         #1a1915;              /* primary text */
  --ink-2:       #524f46;              /* secondary: descriptions, older events */
  --ink-3:       #6b675c;              /* tertiary: meta, labels, unknown */

  /* signal (blue) */
  --signal:      #2a4bd1;
  --on-signal:   #ffffff;
  --signal-wash: #e8ecfb;
  /* warn (vermilion) */
  --warn:        #b83c08;                /* Rev 2: was #c0420d (4.46:1 on --hover) */
  --on-warn:     #ffffff;
  --warn-wash:   #fdf0e8;
  /* ok (pine) */
  --ok:          #1b5a44;
  --ok-wash:     #e2f0e9;
}
@media (prefers-color-scheme: dark) { :root {
  --paper:       #151411;  --surface: #1e1d19;  --hover: #26241f;
  --rule:        #2f2d27;  --rule-s:  #3a3830;  --edge:  #7a7669;
  --ink:         #ece9e0;  --ink-2:   #b6b2a5;  --ink-3: #9a968a;
  --signal:      #98a9ff;  --on-signal: #0c1233; --signal-wash: #1d2342;
  --warn:        #ff9a6a;  --on-warn:   #2a0f03; --warn-wash:   #34201a;
  --ok:          #74cdab;                        --ok-wash:     #1a2b25;
} }
```

Seventeen tokens; dark mode overrides every one of them. It is **not** an inversion:

- Surfaces *rise* in lightness with elevation (`paper #151411` → `surface #1e1d19` → `hover #26241f`). No shadows exist in either theme, so this is the only depth cue.
- Hues are re-picked lighter and a touch less saturated; they are not the light-mode values. In dark mode a *solid* badge flips: light fill, dark text (`--on-signal #0c1233`), which is why `--on-*` tokens exist at all.
- Washes are dark tints of the hue, not transparent overlays, so contrast is a fixed, checkable number.

### 2.3 Measured contrast

> **[Rev 2]** `--warn` changed from `#c0420d` to `#b83c08` (Alex S2): the old value was 4.46:1 on `--hover`, a fail on my own rule for 13px/600 text that sits on rows. Rows turn `--hover` under the pointer, so that was a real state. The new value also makes "orange on blue wash" pass (4.83), which removes the need for my old contrast-driven restriction. I also added the pairs I had not tabulated (`hover`, `edge` on washes). I re-ran all of it; Alex's figures and mine agree to two decimals.

Targets: body-size text ≥ 4.5:1 on every surface it can appear on; primary ink ≥ 7:1; non-text (glyphs, control borders, link underlines) ≥ 3:1. Decorative hairlines are exempt and are labelled so; nothing relies on them to be perceived.

| Pair | Light | Dark |
|---|---|---|
| ink / paper | 15.86 | 15.17 |
| ink-2 / surface | 7.98 | 7.95 |
| ink-2 / hover | 7.00 | n/a |
| ink-3 / paper | 5.09 | 6.23 |
| ink-3 / surface | 5.50 | 5.71 |
| ink-3 / signal-wash (worst case for muted text) | 4.79 | 5.18 |
| ink-3 / warn-wash | 5.06 | 5.19 |
| ink-3 / ok-wash | 4.81 | 5.02 |
| ink-3 / hover | 4.83 | 5.24 |
| signal / paper | 6.26 | 8.29 |
| signal / signal-wash | 5.89 | 6.89 |
| signal / hover | 5.93 | n/a |
| on-signal / signal (solid badge) | 6.94 | 8.22 |
| **warn / paper** | **5.13** (was 4.70) | 8.84 |
| **warn / surface** | **5.55** | 8.10 |
| **warn / hover** | **4.87** (was 4.46, fail) | 7.44 |
| **warn / warn-wash** | **5.10** | 7.37 |
| **warn / signal-wash** | **4.83** (was 4.43, fail) | 7.35 |
| **on-warn / warn (solid badge)** | **5.69** | 8.63 |
| ok / surface | 7.90 | 8.89 |
| ok / hover | 6.92 | n/a |
| edge / paper (control border, link underline) | 3.23 | 4.06 |
| edge / surface (input border) | 3.49 | 3.71 |
| **edge / signal-wash** (link underline in the pickup header) | **3.04** | 3.37 |
| **edge / warn-wash** | **3.21** | n/a |
| edge / hover | 3.06 | n/a |
| primary button text / fill | 17.15 | 15.17 |
| count badge (paper on ink) | 15.86 | 15.17 |

Things the measurement has now caught, in order of embarrassment:

- (rev 1) My first control-border colour was 1.7:1. **Rules are decoration at ~1.4:1; edges are information at ≥ 3:1.** `--edge` is a separate token for exactly this reason.
- (rev 2) **I then broke my own rule one section later**: link underlines in revision 1 were drawn in the decorative `--rule-s` (1.35:1 on the blue wash). Underlines are now `--edge`. A link underline is a control affordance, so it is on the information side of the line.
- (rev 2) `warn` text on `hover` and on the blue wash both failed by a hair. Fixed by the darker `warn`, not by restricting where it may appear.

`warn` is now `#b83c08`: still recognisably vermilion, and the white-on-warn badge text is 5.69:1. I preferred the old `#c0420d` as a colour; I prefer the new one as a thing that passes the rule I wrote.

### 2.4 Status: ten states, four registers, and what "unknown" is allowed to say

> **[Rev 2]** The four-register structure is unchanged (Alex rendered all ten indicators and confirmed it reads at a glance). What changed: **`unknown` is no longer one thing.** It was a single label ("No status yet") applied to three different situations, and it was false in two of them (33 of 36 real parcels are `unknown`; see M1 in the review). Its presentation now depends on *why* the status is unknown. The `returned` glyph also changed (§7).

The mistake to avoid is mapping ten statuses to ten colours. Hue carries only *attention level*; identity is carried by word and silhouette. There are four **registers** of emphasis, and each status sits in exactly one.

| Status | UI label | Register | Hue | Glyph (§7) | Container |
|---|---|---|---|---|---|
| `ready_for_pickup` | Ready for pickup | **Act** | signal | box (solid) | **solid badge** |
| `out_for_delivery` | Out for delivery | **Act** | signal | ¾-filled ring | **outlined badge** |
| `failed_attempt` | Delivery attempt failed | **Act** | warn | diamond × (solid) | **solid badge** |
| `problem` | Delivery problem | **Act** | warn | triangle ! (solid) | **solid badge** |
| `returning` | Returning to sender | **Watch (bad)** | warn | U-turn arrow | outlined badge |
| `in_transit` | In transit | **Watch** | ink-2 | half-filled ring | none: glyph + text |
| `pre_transit` | Registered | **Watch** | ink-2 | empty ring | none: glyph + text |
| `delivered` | Delivered | **Settled** | ok | check in disc | none: glyph + text |
| `returned` | Returned to sender | **Settled** | ink-2 | U-turn in **open ring** | none: glyph + text |
| `unknown` | *depends on cause, see below* | **Silent** | ink-3 | 4px dot | none |

**How the registers look** (unchanged):

- **Act**: a filled or outlined *container* (4px-radius label, 24px tall) in signal or warn. These are the only containers on the page. If everything has a chip, nothing has a chip; here, if you see a rectangle with a fill, someone is waiting for you.
- **Watch**: glyph + word in ink-2, no container. `returning` is bad news but not urgent, so it is warn-coloured but *outlined*.
- **Settled**: glyph + word. `delivered` in pine, `returned` in neutral ink. Neither asks for anything.
- **Silent**: a 4px dot and muted text, weight 400. No hue.

`ready_for_pickup` and `out_for_delivery` share a hue but differ in **weight**: a parcel at a locker is a persistent, located obligation; a parcel on a van is a "be reachable today" that resolves itself.

### `unknown`, by cause

The label is a function of three fields (status, whether the parcel has any events, whether it is archived), not a lookup on the enum.

| Situation (real count) | What is shown | Why |
|---|---|---|
| **Has events, status uncoded** (Packeta, SPS: prose-only carriers; e.g. #35 before its pickup event: *"It's almost there! Your parcel is on its way to you."*) | **No status word.** The carrier's latest sentence takes the status slot, in full ink (`--ink`, not ink-2), with its timestamp. Glyph: the 4px dot. | For a prose-only carrier the sentence *is* the status. A word beside it ("No status yet") would contradict the sentence under it, or say nothing it didn't already say. Promoting the sentence one colour step is the whole treatment. |
| **No events, still live** (GLS #36, brand new) | `No updates yet` (ink-3, 400). One line, not two. | The "yet" is true here: something is expected. |
| **Archived** (32 of 34 history rows; zero events, never will have any) | `Archived` (ink-3, 400). The parcel page adds one sentence: **"Found in old mail; never tracked."** and no empty timeline. | Never promise "yet" about a parcel that will not change. |

I considered keeping the single label "No status yet" and accepting it was wrong for the archive. I rejected that: of the three situations, the most common one (archived) is exactly the one where the label lies, and the page the user reaches from History would greet them with a falsehood.

### 2.4.1 The lede may not claim what the registers don't support

The register of a parcel with an uncoded latest sentence is **unclassified**, not Silent: we are not saying nothing needs you, we are saying we can't tell. The page (§5.2) must keep these apart.

### 2.5 Colour-vision deficiency, explicitly

> **[Rev 2]** The numbers from revision 1 stand (Alex reproduced them). Two corrections: (a) I only compared `ok` with `ink-3`; `in_transit` and `pre_transit` are **ink-2**, which sits in the same lists as `delivered`, and that pair is much worse; (b) `warn` changed, so its distances are re-run.

Simulated with Machado matrices at full severity, light mode. ΔE is CIE76; below ~15 I treat two colours as the same to someone with that deficiency.

| Pair | protan | deutan | Reading |
|---|---|---|---|
| signal vs warn | 112 | 128 | Robust. The load-bearing distinction, and it is on the blue-orange axis |
| warn vs ink-3 | 38 | 47 | Distinguishable |
| signal vs ink-2 | 76 | 81 | Robust |
| ok vs ink-3 (`delivered` vs `unknown`) | **9** | **11** | Same colour |
| **ok vs ink-2 (`delivered` vs `in_transit`/`pre_transit`)** | **4** | **1** | **Identical** to within rounding |
| dark: ok vs ink-2 / ok vs ink-3 | 9 / 18 | 3 / 12 | Same problem, slightly less |

The honest reading: **blue vs vermilion is robust; pine green carries no information at all for roughly one man in twelve.** I tried to fix it with colour and cannot: `ok` and `ink-2` have the same lightness (L\* 34), and `ok` cannot get lighter without failing 4.5:1 against paper (it would need L\* ≳ 46, which is where `ink-3` sits). I could make `ok` darker, which buys a few ΔE and costs the "green" reading for everyone else. I decided against: the answer is that **green is never allowed to be the only difference**, which was already rule 4, and which is now a hard test: *no component may reduce a status to a coloured word alone.* If someone ever shortens a row to drop the glyph (a denser table, say), `delivered` and `in_transit` become the same grey to those readers. That is the constraint on every future density change.

The redundancy stack for *every* status: (1) the word, always visible on rows, cards and the parcel header; (2) a unique silhouette (`delivered` is a *disc*, `returned` an *open ring*, `in_transit` a *half ring*; they differ by shape, not hue); (3) register (container or not); (4) hue. Remove (4) and nothing is lost. In the timeline, where the word appears only at the head of each run (§6.4), the silhouette and register carry the rest.

---

## 3. Typography

### 3.1 Stack

```css
--sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Helvetica Neue", sans-serif;
--mono: ui-monospace, "SF Mono", Menlo, monospace;
```

`-apple-system` first because on macOS it opts into SF's **automatic optical sizing** (Text below 20px, Display above) and dynamic tracking. That is two free refinements, and they are lost if you name a specific cut ("SF Pro Display") or set `letter-spacing` on proportional text. So: **no letter-spacing on sans, ever.** Mono gets none either except where noted.

I considered a serif (New York via `ui-serif`) for parcel names to mark "this is *your* word" against "this is the carrier's word". I rejected it: it is only reliable in Safari, parcel names are largely machine strings (`HONGKONG YUNEXPRESS LOGISTICS LIMIT`, `F*CKTHEM`) that look absurd in a serif, and a tool this plain should not have a mascot typeface.

### 3.2 Scale

Two weights only: **400 and 600**. Hierarchy comes from size, colour step (ink / ink-2 / ink-3) and space, never from 500/700. All sizes in rem on a 16px root; the table shows px at 1x.

| Token | Size / line | Weight | Used for |
|---|---|---|---|
| `--t-meta` | 13 / 18 | 400 (600 for labels) | carrier · number, timestamps, table headers, form labels, badges (600) |
| `--t-body` | 15 / 22 | 400 | descriptions, table cells, inputs |
| `--t-lead` | 17 / 24 | 600 | parcel name on card, section heads (h2) |
| `--t-title` | 22 / 28 | 600 | page `h1` **and the pickup location** |
| `--t-hero` | 28 / 32 | 600 | parcel-page name (h1 on `/parcel/:id`) only |

Hand-tuned, not modular: I tuned each step against the longest Slovak strings, not against a ratio. Line-heights sit on a **2px grid** (18/22/24/28/32) and spacing on a **4px grid** (§4). 15/22 is deliberately taller than the current 15/1.45 because Slovak capitals carry carons and acutes (`Č Ž Š Ľ Ť Ď Ú`) that crowd tight leading.

**Uppercase labels are not used anywhere.** Table headers and section labels are sentence case, 13px/600, ink-3. All-caps tracked micro-labels are the default "dashboard" gesture, and in Slovak they put `Č`/`Ľ`/`Š` carons above the cap line and break the rhythm.

On large displays the root grows so *everything* scales with it:

```css
@media (min-width: 1600px) { html { font-size: 17px } }   /* 15px body → 15.9px */
@media (min-width: 2200px) { html { font-size: 18px } }   /* 15px body → 16.9px */
```

### 3.2.1 Long strings (the real stress test)

Test strings, all from the real data: `Pepita Group Zrt. QR kód pre vyzdvihnutie balíka:` (47 chars, with a stray colon that is data dirt and is **not** cleaned up by the UI), `HONGKONG YUNEXPRESS LOGISTICS LIMIT` (all caps, truncated at source), `Slovenská pošta` + `RA123456785SK` (the longest carrier + longest number), `Delivery attempt failed` (the longest status label).

- **Names wrap; they do not truncate** on cards, rows and the parcel page. `overflow-wrap: break-word; min-width: 0` on every flex/grid child that holds text (the single most common cause of horizontal overflow).
- **Names wrap everywhere, including the history table.** *(Rev 2: revision 1 truncated with an ellipsis there. `text-overflow` does nothing on a `<td>` in an auto-layout table, and at 61rem the longest real name fits on one line anyway; see §6.5.)*
- **Event descriptions** clamp to 2 lines on rows (`-webkit-line-clamp: 2`) and are unclamped on the parcel page. Carrier text is the information, so it is never clamped where it is the primary content.
- **No auto-hyphenation.** It would hyphenate addresses and proper nouns (`Bot-tova 6`), which corrupts a *location*. `text-wrap: pretty` on descriptions and `text-wrap: balance` on the pickup location and headings, both progressive enhancement.
- **No `lang="sk"` on carrier text.** I wanted it (screen-reader pronunciation of `Žilina`) and decided against: the real Packeta pickup event is in *English* (`The parcel is ready for pickup. Z-BOX Bratislava, Hlavna 6`), so carrier text is Slovak, Czech or English per event and we cannot know. A wrong `lang` is worse than none. `<html lang="en">` stays because the chrome is English.
- **Slovak UI chrome is a risk I did not design around** (the current UI is English and I kept it). If it ever flips, nav labels grow ~30-40%; see §12.

### 3.3 Numbers and identifiers

- **Tracking numbers**: `--mono`, 13/18, `font-variant-numeric: slashed-zero` (SK0S34K59000019D7K: `0` vs `O` matters when you read one aloud to a depot clerk; a no-op where the font lacks the feature). `white-space: nowrap` normally, with `overflow-wrap: anywhere` as the last resort below 360px.
- **`user-select: all`** on the tracking number (plus `-webkit-user-select: all` for Safari). One click selects the whole number, ⌘C copies it. That is the entire "copy" feature, with no JS and no button.
- **Times and dates**: `font-variant-numeric: tabular-nums` so a column of `08:02 / 17:19 / 11:40` aligns. Times are `<time datetime>`.
- **Median delivery time and n**: `tabular-nums`, right-aligned.

### 3.4 Dates: a rule, not a format

> **[Rev 2]** Two changes. (1) **No relative words in timestamps** (`Today`, `Yesterday`): rendered at request time with no JS, they become false in a tab left open overnight (Alex S8). Relative information survives only in the two *clocks* of §6.1, and always next to the absolute date. (2) Added the exact fixtures the formatter must pass; two of them are in the real data.

The current format (`ccc d LLL, HH:mm`) has no year. Real consequence: the Attention page shows `Wed 12 Nov, 20:07` (a **2025** email, which reads as a future date) and `Mon 27 Oct, 15:57` (exactly one year ago, with the same day and month as *today*, Tue 27 Oct 2026). Rule, by the age of the timestamp, always in `Europe/Bratislava`:

| Age | Shown as |
|---|---|
| within the last 7 days | `Mon 26 Oct, 17:19` (weekday, day, month, time) |
| earlier in this calendar year | `12 Mar` (no weekday; nobody needs "Thu" for an archive) |
| any earlier year | `12 Nov 2025` |
| in a table group already headed by its year | `12 Nov` (the group header carries the year) |

The pickup deadline keeps its weekday forever (`Sat 31 Oct`): "Saturday" is the thing you plan around.

**The comparison must be on the full calendar date, not on day and month.** An implementation that compares `d`/`LLL` will print the 2025 email as the same day as now. Fixtures, verbatim (they go in the formatter's tests): `Mon 27 Oct` one year ago; `Wed 12 Nov` with today = 27 Oct 2026; an event at 22:05 UTC on Sat 24 Oct (it is **Sun 25 Oct, 00:05** in Bratislava: the day heading must use the zone, not UTC); the DST change on Sun 25 Oct 2026 (CEST to CET), which falls *inside* parcel #34's event range; and a Packeta event stored as `Europe/Prague`.

---

## 4. Space and rhythm

### 4.1 Scale

4px base. Eight steps, all in rem:

| Token | px | Use |
|---|---|---|
| `--s-1` | 4 | glyph-to-text nudge, tight stacks |
| `--s-2` | 8 | inside a component (label → value) |
| `--s-3` | 12 | row padding (vertical), badge gap |
| `--s-4` | 16 | between cards/rows, panel padding, row padding (horizontal) |
| `--s-5` | 24 | **card padding**, h1 → content |
| `--s-6` | 32 | between sections (`h2` space-above), nav → h1 |
| `--s-7` | 48 | page top |
| `--s-8` | 72 | page bottom (a page should not end on the last pixel of its content) |

Radii: **12** card / list container, **8** inner panel and notice, **6** controls, **4** badge. No other values. No shadows anywhere.

### 4.2 Page frame

> **[Rev 2]** Alex S4: my pages were 42rem or 60rem wide, centred, which moved the nav 144px when you clicked History; and my two-column parcel page did not fit inside the 42rem container I'd given it. One frame now serves every page.

- **One outer frame for every page: `max-width: 64rem`**, centred, `padding: 3rem 1.5rem 4.5rem`. The nav, the `h1` and everything below share its **left edge, which never moves between pages**. I measured it: at a 1440px window the left edge is at x = 232 on every page.
- **Narrow pages cap their *content* at 42rem and sit on the left** (index, attention, add, the single-column parcel page). Tables (History, Health) fill the 61rem inside the frame.
- **The nav is capped at 42rem too**, with `Add parcel` at that column's right edge, so it lines up with the `Refresh now` button on the index. On wide pages the nav is simply shorter than the content, which is fine; what matters is that it is *always the same*.
- **The parcel page is two columns at ≥ 64rem**: timeline `42rem`, gap `2rem`, details `17rem`: exactly the 61rem the frame offers. Below 64rem it is one column.
- Left alignment has a cost, which I looked at: on a 2560px display the 42rem column sits about 100px left of the screen's centre line, with an empty 19rem to its right. I judge that better than a nav that jumps, and better than centring a column inside a frame (it would look arbitrary against the nav). It reads as a margin, as in a printed timetable.
- Side padding `1.5rem`; top `3rem`; bottom `4.5rem`.

### 4.3 The 27" display versus the laptop

> **[Rev 2]** Updated for the frame above, and with real measurements from the renders.

Not a dashboard grid. A list of three parcels does not become better by being spread across 2560px.

- **27" (≥ 1600px):** the root font grows to 17px (18px at ≥ 2200px), so the frame and column grow too (they are in rem). The page stays a single left-aligned column; on the parcel page only, the 17rem details column appears at the right. At 18px the frame is 1152px wide; I rendered the six-pickup page at 2560px and it holds.
- **13-14" laptop (~1440 × 900):** the default. **Measured:** the real index (one pickup card, two rows) is 622px tall and fits whole. The six-pickup stress case (§6.1) is 1308px tall; with the sort order of §6.2 its first screen (~800px of visible window) holds the two time-bound rows *and* the first, three-parcel pickup card.
- **Narrow (< 40rem):** nothing is hidden. Card footer wraps; the parcel page returns to one column with the order header → notices → timeline → details → raw responses.

Only **four media queries**: `min-width: 1600px` and `2200px` (root size), `min-width: 64rem` (parcel two-column), `max-width: 40rem` (row meta wraps). Everything else is intrinsic (`flex-wrap`, `min-width: 0`).

### 4.4 Density, by page

| Page | Density | Reasoning |
|---|---|---|
| In flight | **Loose** for the pickup card (24px padding, 22px location type); **medium** for rows (≈ 64px, two lines) | The few things that matter get room; the rest is compact |
| Parcel | Medium; timeline rows ≈ 40px | A timeline is read top to bottom; it should not need scrolling for ~10 events |
| History | **Tight**: 40px rows, one line | 34 rows and growing; this is an archive. 40px keeps a 44px-ish target without needing paging |
| Health | Medium, 3-4 lines per carrier row at most | Seven things, glanced at |
| Attention, Add | Form density: 36px controls, 16px between fields | A decision page |

---

## 5. Page chrome

### 5.1 Nav

> **[Rev 2]** Nav is now capped at 42rem (§4.2). The Health dot no longer lights for an overdue poller on its own (Alex S7: a closed laptop lid overnight would light it every morning, which teaches the user to ignore it, which is the exact thing I argued against for the Attention count).

Text only. No bar, no background, no icons. Brand word `Parcels` at 600; four destinations; `Add parcel` at the right edge of the 42rem nav, because it is an *action*, not a destination.

```
Parcels   In flight   History   Attention   Health                Add parcel
          ────────
```

- Current page: ink, weight 600, 2px ink underline (`box-shadow: 0 2px 0 var(--ink)`; not `border-bottom`, so it does not shift layout). Not blue.
- Other items: ink-3 (5.09:1) at 400. Hover: ink. Padding `.25rem 0` on a 15px/22px line gives ≥ 30px height; the whole word is the target.
- **Counts and dots live in the nav so that every page answers "is anything wrong?"**, with two caveats I now hold firmly:
  - **`Attention` count: do not ship it until Dismiss exists** (§12.11). The two items on the live page are Packeta app e-mail verifications that can never become parcels; as built, the page never empties and the count is permanently lit.
  - **`Health` dot: carrier failure only.** A 7px warn dot plus visually-hidden text ("carrier problem") when any carrier is `failing` or `needs attention`. **A poller that is overdue does not light it** by itself; the overdue state is shown loudly on the Health page itself. If the poller has missed an entire polling day (not one overnight gap) it lights the dot too; the threshold is a product decision and I'd default to "a whole day". A warn that fires on an expected, non-actionable condition trains the user to ignore warns.
  - Both need layout data (§12.1).

### 5.2 Page heading and the two-second line

> **[Rev 2]** This is the section Alex's M1 rewrote. The old lede (`3 in flight. 1 needs you.` / `Nothing needs you.`) was computed from a status that is unknown on 33 of 36 real parcels, so it could state the opposite of the truth. I have kept the *idea* (the lede is the answer, and the quiet version is the product's best moment) and **added the conditions under which the quiet version is allowed to appear**.

Every page has an `h1` (22/28) and optionally a **lede**: one line, 15px, ink-2, that is the *answer*, computed on the server from data it already has. The index lede is built from clauses; each shows only when it is true, in this order:

1. `N ready for pickup` (parcels, not locations), then `N out for delivery`, then `N need attention` (`failed_attempt` + `problem`).
2. `N has no status; read its latest message.` for each in-flight parcel that has events but an uncoded status (§2.4). **This is the clause that stops the lede lying.**
3. `N in flight.`
4. `Packeta is failing, so this may be out of date.` if a carrier serving an in-flight parcel is `failing` or `needs attention`.

and the one sentence that must be earned:

> **`Nothing needs you.`** appears **only if** (a) no clause 1 or 2 applies, **and** (b) no in-flight parcel's carrier is failing. Otherwise it is not printed, and nothing replaces it.

Real examples, with the data as it is today:

| In flight | Lede |
|---|---|
| #35 ready (Z-BOX), #36 no events, #1 registered | `1 ready for pickup. 3 in flight.` |
| as above, but #35 is still prose-only | `3 in flight. 1 has no status; read its latest message.` |
| all parcels classified, none urgent, carriers healthy | `2 in flight. Nothing needs you.` |
| same, but Packeta is failing | `2 in flight. Packeta is failing, so this may be out of date.` |
| six pickups at three places, one out for delivery | `6 ready for pickup, 1 out for delivery. 9 in flight.` |
| zero | **no lede.** The empty state says `Nothing in flight. Parcels appear here when an email arrives or when you add one.` (not "0 in flight" above it) |

A parcel with **no events** at all (a brand-new GLS parcel) does *not* block "Nothing needs you": there is nothing that could be waiting.

Other pages:

- **Health:** `4 of 5 carriers reporting. SPS has never been polled.` (Alex S7: my "All five carriers reporting" was false for the live data.) Or, when something is wrong: `1 of 5 carriers failing.` Never says "all" unless it counts.
- **History:** `34 finished parcels: 1 delivered, 32 archived.` with the outcome counts that exist. History lists delivered, returned and archived parcels only; in-flight parcels are found on the index (at ≤ ~10 in flight, scanning is the search).

The primary action of the page sits right-aligned on the `h1` row (`Refresh now`).

---

## 6. Components

### 6.1 Pickup card (one per *place*)

> **[Rev 2]** Redesigned, not patched (Alex M2, S3, S5). Revision 1 built the card around a deadline and a Maps link, and gave the pickup its own panel per parcel. The real data says: **only Slovenská pošta ever sends a deadline; 0 of 36 parcels have coordinates; every pickup so far is the same Z-BOX.** So the typical card has no "Collect by" line and no Maps link, and three parcels waiting at one locker would be three identical 22px headlines. The card is now **one card per pickup location, with the parcels listed under it**, and its content is built from what the data always has.

**What is the actual most useful largest thing?** Still the *place*, and for a better reason than before. (a) It is the one fact that is *always* present for a ready parcel. (b) It is what you do something with: you go to it, and you paste it into a message. (c) With grouping, it is also what *unifies* parcels: three parcels at one locker is one fact, "go to Hlavna 6", not three. What I considered and rejected: making the *age* the largest thing. It is the only urgency signal for four of five carriers, but "3 days" alone is not actionable and has nothing to be compared with, so it earns bold weight, not the headline.

```
┌────────────────────────────────────────────────────────────┐
│ Z-BOX Bratislava, Hlavna 6              ▣ Ready for pickup │  header: --signal-wash, 22/28 600
├────────────────────────────────────────────────────────────┤
│ Bratiska  Packeta · Z1234567890                             │  name 17/600 + meta 13 ink-3
│ Since Mon 26 Oct, 17:19                                     │  clock 15, ink
├────────────────────────────────────────────────────────────┤
│ gymbeam.sk  Packeta · Z1748571211                           │
│ Since Sat 24 Oct, 09:02 · **3 days**                        │
├────────────────────────────────────────────────────────────┤
│ Packeta gives no pickup deadline.  Search in Maps ↗         │  footer 13 ink-3
└────────────────────────────────────────────────────────────┘
```

Rendered with the real parcel #35 (one-line card, **~195px**) and with six parcels at three places (three cards of **344 / 199 / 206px**, vs 1668px for six cards under revision 1).

- **Grouping key:** the pickup name string, exactly as stored (`Z-BOX Bratislava, Hlavna 6`). Equal strings group; variants don't, and that is acceptable (§12.4). **Cap:** at most four location cards; any further pickups render as compact Act rows (§6.2).
- **The badge appears once, in the card header**, not per parcel. The card is *the* container; the lines beneath are plain.
- **The clock line** is the second most important line, and it is the only line whose content depends on the carrier:

  | Data | Clock line | Weight / colour |
  |---|---|---|
  | **No deadline** (Packeta, GLS, DPD, SPS: all of today's data) | `Since Mon 26 Oct, 17:19` + ` · 3 days` once ≥ 1 full day has passed | absolute date/time at 400 ink; the day count at 600 |
  | Deadline ≥ 3 days away | `Collect by Sat 31 Oct · 4 days left` | deadline at 600 signal, count at 400 ink-2 |
  | Deadline 1-2 days away | `Collect by Wed 28 Oct · tomorrow` | deadline 600 signal, relative word 600 ink |
  | Deadline today, or passed | `Collect by Tue 27 Oct · today` / `· deadline passed` | **the card header switches to `--warn-wash`**; deadline text `--warn` 600 |

  The **absolute date is always printed next to the relative count**, so a tab left open overnight still tells the truth (Alex S8). There is **no urgency colour on the age line**: without a deadline we do not know the limit, and inventing one (a per-carrier hold period) would cry wolf. If the owner wants age-based nagging that is a *product* feature (a default hold per carrier) and I'd then add it as a fourth row of this table.
- **"No deadline" is stated, once, in the card footer** (`Packeta gives no pickup deadline.`; `Packeta and GLS give no pickup deadline.` for mixed groups). In revision 1 I argued the opposite (print nothing, because "no deadline" reads as information we have). Alex is right and I was wrong: the user will otherwise assume *there is no limit*, and parcel lockers do have one. Absence of a line is silence; absence of a deadline is a fact worth printing.
- **Maps link is conditional and honest.** With coordinates: `Open in Apple Maps ↗` (precise). Without (today, always): `Search in Maps ↗`, a name-based search URL, whose label says what it is. It sits in the footer in ink with an `--edge` underline. It is a product choice whether to offer it at all, given that this owner's habitual pickup is one address they know; I'd keep it because it costs one line and the first time at a *new* locker is when you want it.
- **Copy works.** The tracking number and the location are lifted above the stretched link (`position: relative; z-index: 1`), so they can be selected and `user-select: all` works (Alex S5). The *name* is the stretched link: clicking anywhere else on a parcel line opens the parcel. The header is not a link.
- **When there is no parseable location** (a Packeta pickup event with no place text), the parcel does **not** get a card: it degrades to a compact Act row with the solid badge (§6.2). A blue card with nothing in it is the worst possible outcome.
- **States:** rest; a parcel line hovers to `--hover`; focus-visible ring is drawn *inside* the line (`outline-offset: -2px`) because the card clips with `overflow: hidden`. No disabled or selected states.
- **`failed_attempt` and `problem` do not get cards** (revision 1 gave them a warn-tinted one). They have no place; their content is the carrier's own latest sentence, which a row shows well. They become Act rows with a solid warn badge.

### 6.2 Parcel row, and what the whole index looks like

> **[Rev 2]** The row grammar changed (Alex M1 case 3 and 4, S5) and the page now has an explicit sort. Meta moved inline after the name (right-aligned meta fought long names for width; a 49-character name plus `Slovenská pošta · RA123456785SK` would not have fit), the timestamp sits in its own column, and the content of line two now depends on the cause of the status (§2.4).

For every parcel that is not in a pickup card. All rows share **one** bordered container (radius 12, hairlines between), not a box each.

```
  ○  Smoke test  Slovenská pošta · RA123456785SK
     No updates yet
  ──────────────────────────────────────────────────────────
  •  MTBIKER order 1948688  GLS · 1234567890
     No updates yet
  ──────────────────────────────────────────────────────────
  •  Bratiska  Packeta · Z1234567890
     It’s almost there! Your parcel is on its way to you.      Mon 26 Oct, 14:31
  ──────────────────────────────────────────────────────────
  ◐  Pepita Group Zrt. QR kód pre vyzdvihnutie balíka:  DPD · 11WG17063
     In transit  Vaše zásielky boli roztriedené na prepravu        Tue 20 Oct, 21:20
     do ďalšieho depa · Dolny Hricov
  ──────────────────────────────────────────────────────────
     Cotton Garments  DPD · 11WG17999
     [◆ Delivery attempt failed]  Nepodarilo sa nám doručiť …     Mon 26 Oct, 08:45
```

Grid: `1rem | 1fr | auto`. **Line 1:** the glyph (col 1), the name (15/600, wraps) with the carrier · number *inline after it* in 13px ink-3. **Line 2:** the content, clamped to two lines, and the timestamp (13px, ink-3, `nowrap`, right-aligned, `tabular-nums`) in column 3. The timestamp is never inline after the sentence.

**Line 2, by case:**

| Case | Line 2 |
|---|---|
| **Known, Watch** (`in_transit`, `pre_transit`, `returning`) | the status word at 13/600 as a lead-in, then the latest sentence in ink-2 |
| **Known, Act** (`out_for_delivery`, `failed_attempt`, `problem`, and `ready_for_pickup` with no location) | the **badge** (outlined for `out_for_delivery`, solid otherwise), then the sentence. Column 1 is left empty, because the badge carries the glyph (revision 1's mock showed the glyph twice) |
| **Unknown, has events** | **just the sentence, in full ink** (no word; §2.4). Glyph: the 4px dot |
| **Unknown, no events, live** | `No updates yet` (one line) |

Whole row is the link (stretched pseudo-element); the tracking number is lifted above it so it can be selected. States: rest, hover (`--hover`), focus-visible (ring inset). The row container is `overflow: hidden` for the radius, so the ring is `outline-offset: -2px` (Alex S5).

**Sort order of the index** (this is design, not decoration; the lede and the sort are the two-second answer):

1. **Act rows:** `failed_attempt`, `problem`, `ready_for_pickup` without a location, then `out_for_delivery` (newest event first within each). They are *time-bound* and *short* (~80px each), so they go first and cost almost nothing.
2. **Pickup cards**, by earliest deadline, then by longest waiting.
3. **Unclassified**: unknown with events, newest event first. These could be anything, so they rank above known-quiet parcels.
4. **Watch**: `returning`, then `in_transit`, `pre_transit`, newest event first.
5. **No events** (live), by `first_seen` newest. Parcels with no event time have to sort somewhere; last.

Zones 1 and 3-5 are separate rounded containers; zone 2 is the cards. There are no headings; the density change is the boundary. **Why Act rows above the cards** (a change from revision 1): Alex measured six cards pushing `out_for_delivery` ("be home today") below the second screenful. With grouping and this order, the six-pickup case is 1308px tall and the two time-bound rows plus the first card all fit in the first 800px. Delivered parcels are History's; they are not on the index (that is how the live data behaves today: #34 is in History).

### 6.3 Status indicator

> **[Rev 2]** Labels now depend on cause for `unknown` (§2.4). Otherwise unchanged. The `returned` glyph is an open ring so that `delivered` (disc) and `returned` (ring) differ by shape, not hue (Alex S9).

One component, three presentations, all built from the same sprite symbol:

```html
<!-- Act: container + glyph + word -->
<span class="st st-act st-signal"><svg class="g" aria-hidden="true"><use href="#g-ready_for_pickup"/></svg>Ready for pickup</span>
<!-- Watch / Settled: glyph + word, no container -->
<span class="st st-in_transit"><svg class="g" aria-hidden="true"><use href="#g-in_transit"/></svg>In transit</span>
<!-- Silent: dot + muted word, only for "No updates yet" / "Archived" -->
<span class="st st-quiet"><svg class="g" aria-hidden="true"><use href="#g-unknown"/></svg>No updates yet</span>
```

Anatomy: 16px glyph, 6px gap, 13px/600 word (400 for Silent). Badge (Act): 24px tall, `padding: 0 10px 0 8px`, radius 4, `border: 1px solid transparent` (so that it survives `forced-colors`). `white-space: nowrap`. The glyph is `aria-hidden`; the word is the accessible text. No states (not interactive). `unknown` *with events* has no indicator at all; the sentence is the status (§6.2).

The class name derives from the status with `status.replace(/_/g,'-')` as today; the rename is `chip` → `st`. Ten status classes only set `color` (and `background`/`border-color` for the badges). The `out_for_delivery` badge needs a *real* 1px border in `--signal` (Alex: "keep it really distinct, not just a ring in blue"), which it has in the render.

### 6.4 Timeline

> **[Rev 2]** Rewritten against the one real rich timeline, parcel #34 (24 events, rendered verbatim in light and dark). Alex M3 found four faults and he was right about all four. (1) My assumption that events arrive newest-first was **false**: `db/events.ts` is `ORDER BY occurred_at, id`, oldest first. (2) My "mark the change" rule anchored the status word to the *oldest* row of a run, so it sat under the rows it labelled. (3) Five consecutive coded-`unknown` events would each have printed `Unrecognised status ENA`, which means nothing to the owner and reads as a fault. (4) I never specified the tie-break. All four are fixed below; I also learned from the render that the rail must pass *through* day headings.

**Order.** Displayed newest first. The data is oldest first, so **the template reverses**, with **`id DESC` as the tie-break** (two DPD events, `MII` and `MIA`, share 07:42:08; so do `DODEI` and `DEHDY` at 11:58). Everything below is stated in *display* order.

**Runs.** A *run* is consecutive rows with the same status. In #34, newest first: `delivered`, `unknown`, `ready_for_pickup ×3`, `failed_attempt`, `out_for_delivery ×3`, `in_transit ×9`, `unknown ×5`.

- **The head of a run is its newest row, the first one you meet reading down.** The head shows the glyph and the status word (13/600, in the status colour) above the carrier's sentence. The remaining rows of the run show a 4px dot on the rail and the sentence only. So the word always sits *above* the rows it labels.
- **`unknown` runs have no head.** Their rows are dots and plain sentences. A stretch of them looks like what it is: a carrier narrating in prose.
- **Coded `unknown` is not treated differently from uncoded `unknown`.** I'm dropping the word "Unrecognised". Alex showed it is not even consistent (`SPL` is `unknown` at Erftstadt and `in_transit` at Mörsdorf a day later); the code is a carrier identifier, not a diagnosis. **Where I part from his suggestion:** he proposes showing the code as a trailing mono token on those rows. I'm not putting codes on the rows. Twenty rows carrying `HUS · SPL · DEHDY` is visual noise on the one page that is already the longest, and the owner is not the person who maps codes. The code goes in the row's `title` attribute (hover) and stays in the raw responses. A *developer* who wants to notice unmapped codes needs a developer surface (a log line, or a Health note), not the owner's timeline.

```
Sun 25 Oct
 20:50   ●✓  Delivered                                      <- head of a 1-row run
             Vyzdvihli ste Vašu zásielku · Bratislava
 00:05   •   Zásielka bola vrátená v dôsledku vypršania doby uloženia · Bratislava
Wed 21 Oct
 13:58   ▣   Ready for pickup                              <- head of a 3-row run
             Vaša zásielka dorazila na odberné miesto · Bratislava
 13:58   •   Vaša zásielka dorazila na odberné miesto · Bratislava
 13:55   •   Zásielka bola doručená na odberné miesto · Bratislava
 09:45   ◆   Delivery attempt failed
             Nepodarilo sa nám doručiť Vašu zásielku a bude vrátená na depo.
 09:42   ◕   Out for delivery
 …
```

**Grid:** `3rem | 1rem | 1fr`, 12px column gap, rows 12px apart. **Rail:** a 1px `--rule-s` line behind the 16px glyph column; each glyph/dot sits on a `--paper` backing so the rail doesn't show through a ring glyph. **Day headings** (13/600 ink-2) have 20px above and 8px below, and **draw the rail through themselves**: in my first render the rail broke at every heading and read as a gap in the journey. #34 has nine day headings for 24 events; that cost (≈ 360px) is real and I accept it for the ability to put only `HH:mm` on each row. **Times** are `tabular-nums`; every real event carries a full timestamp, so a date-only event is not designed (a `—` in the time column is the fallback).

- **Newest row** in full ink; the rest ink-2. Location is a trailing `· Bratislava` in ink-3; the row must look right when it is absent (the two oldest #34 events have none).
- **The carrier's sentence is always on the row.** DPD reports `DODEX` ("returned due to expiry of the storage period") and then, a day later, `delivered` ("You picked up your parcel"). The design does not try to be cleverer than the carrier; it prints both, in order.
- **Length.** #34 renders at 1475px for the whole page: the answer (the delivered row) is in the first screen, and the rest is the "dig". I considered folding *exact* adjacent duplicates (four identical `Vaše zásielky boli roztriedené…` rows at Dolny Hricov, `×4`): rejected. It saves three rows of 24, loses the individual times, and adds a grouping rule for a gain I can't defend on the one real example (§14).
- Not interactive; no states. Raw responses stay in `<details>` below.

**Parcel header, by cause** (so the page and the timeline never say the same thing twice): known status → the status indicator; unknown with events → **no indicator** (the timeline's first row *is* the status); unknown, live, no events → `No updates yet` and the empty-timeline line `Nothing from the carrier yet.`; **archived → `Archived`, and in place of the empty timeline the single sentence `Found in old mail; never tracked.`**

### 6.5 Table (history)

> **[Rev 2]** Alex S4, S1, S10, plus the real data. The third column is now a defined **Outcome** (`Delivered`, `Returned`, or empty); names are underlined at `--edge` (they are the only way into a parcel from this page); the year groups use the **real** distribution (2026: 14, 2025: 18, 2023: 1; the page shows 34 rows and my count of those three is 33, so one row has a first-seen year I did not reconcile); and **I dropped the ellipsis** (see below). I rendered it with the real rows.

```
34 finished parcels: 1 delivered, 32 archived. Dates are delivery or return dates;
for archived mail, the day it first appeared.

 Parcel                               Carrier     Outcome       Date
 ────────────────────────────────────────────────────────────────────
 2026 · 14
 Goodcang9not seller # 11WG17063      DPD         ✔ Delivered   25 Oct
 zajo.design.s.r.o.shop               Packeta                    4 Sep
 …
 2025 · 18
 SK0S34K59000019D7K                   SPS                       29 Dec
 2023 · 1
 7032103444667117                     SPS                       11 Aug
```

- **Four columns:** Parcel, Carrier, **Outcome**, Date. The old Merchant column is gone: Alex verified that merchant equals the name on 29 rows and is empty on 5, so it differs on **zero** (the name is `label ?? merchant ?? number`). If a label is ever set, show the merchant as ink-3 secondary text after the name *when it differs*.
- **Outcome is a contract:** exactly `Delivered` (check disc, ok colour), `Returned` (open ring, ink-2), or **empty**. Archived is the unmarked default and appears nowhere in the rows; the lede's counts and the caption say once what the unmarked dates mean (**rule 1**). With 1 marked row in 34 the delivered parcel is findable at a glance; as the table grows, the Outcome column is still a column of mostly blanks with a few words in it, which is exactly the shape a "find the exceptions" table should have.
- **Year groups:** a 28px, text-only row (13/600 ink-3: `2026 · 14`), no fill. The one-row 2023 group costs 28px, which I weighed and accept; dates inside a group drop the year (and the weekday).
- **Names are underlined** (1px, `--edge`, offset 3px), ink colour. In a dense table the name is the only link in the row, and on the real page the 34 names are the *only* way into a parcel; hover-only affordance would be a discovery tax. Rows and cards elsewhere keep hover + ring, because their whole-surface hover reads as a target. **I still won't spend blue on links.**
- **No ellipsis, and no `table-layout: fixed`.** Revision 1 specified single-line truncation. Alex pointed out `text-overflow` on a `<td>` does nothing in an auto-layout table, and that at 61rem the longest real name (49 characters, `Pepita Group Zrt. QR kód pre vyzdvihnutie balíka:`) fits on one line anyway; I rendered it and he is right. Names simply wrap if they ever must.
- Row: 40px; no zebra, no vertical rules, 1px `--rule` between rows; header 13/600 ink-3 sentence case; date right-aligned `tabular-nums`; hover → `--hover` on the row; focus-visible ring on the link.
- **Per-carrier median table** below: unchanged. `Carrier | Median | Based on`; median 600 `tabular-nums` right-aligned; `n = 1 of 1` in ink-2 (*not* ink-3: hiding the sample size is the more dangerous mistake); carriers with no data show `—` and `no deliveries yet`. **No bars, no sparkline**: four of five carriers have no data, the fifth has *n* = 1.
- **Filters:** visible labels above every control (`Carrier`, `Search`, `Delivered from`, `to`); `Clear` appears only when a filter is active; the lede then says `12 of 34`.

### 6.6 Notice

```
┌─────────────────────────────────────────────────────────────┐
│ ▲  The postcode "81101" was rejected by the carrier.        │  warn-wash fill,
│    This parcel is tracked by status only until a correct    │  1px border: warn @ 35%,
│    postcode is saved here.                                  │  radius 8, padding 12/16
│    [ 81101        ] [ Save postcode ]                       │
└─────────────────────────────────────────────────────────────┘
```

No left-border stripe (the current `border-left: 3px` is the most recognisable "default admin UI" gesture). A full-perimeter hairline, a wash, a 16px glyph at the first-line baseline, and a **bold first sentence that states the fact**, with the explanation in regular weight beneath. Three tones, which reuse the status glyphs, so notices add no icons of their own:

| Tone | Wash | Glyph | Example |
|---|---|---|---|
| neutral | `--surface` + `--rule-s` | none | `Polled 2 parcels.` |
| warn | `--warn-wash` | problem triangle | rejected postcode; carrier failures after refresh |
| ok | `--ok-wash` | delivered check | (rare) |

`role="status"` on the post-refresh result. A notice with a form in it keeps the form inside, so that the fix is next to the fault.

### 6.7 Form controls

- **Text input / select / date:** 36px tall, `padding: 0 12px`, 1px `--edge` border, radius 6, `--surface` fill, 15px. Hover: border → `--ink-3`. Focus-visible: 2px ink ring, 2px offset (§9). **Labels sit above the control** (13/600 ink-2, 4px gap), always visible; placeholders are hints only. The current history filter puts the labels in `aria-label` only, so two bare `mm/dd/yyyy` fields have no visible meaning.
- **Selects remain native.** A custom chevron would need a data-URI background image, and the CSP (`default-src 'none'`) blocks it. Native `<select>` on macOS looks right with `color-scheme: light dark`, and I am glad of the constraint. Same for `<input type=date>`.
- **Tracking number input** uses `--mono`. **Postcode** is `size=8`, ≈ 10ch.
- **Buttons:** 36px (32px for inline table/header actions), 13/15px, 600, radius 6. Three levels:

  | Level | Appearance | Used for |
  |---|---|---|
  | Primary | solid `--ink` fill, `--surface`/`--paper` text (hover: `#38362e`) | `Add parcel`, `Assign to a parcel`. **One per page.** |
  | Secondary | `--surface` fill, 1px `--edge`, ink text; hover `--hover` | `Filter`, `Save label`, `Save postcode`, `Refresh now` |
  | Tertiary | no border, ink-2 text, underline on hover | `Clear filters`, `Dismiss` (if it ever exists) |

  **No button is blue.** The current `button` is blue-filled, which would put the scarce signal hue on every page permanently and spoil the one place it means something.
- **Layout:** forms are one column, max 28rem. Tracking number + carrier on one line, label + postcode on the next, then the button. A hint below *Postcode* says `Used by GLS and DPD.` An input and its Save button sit on one line (`display: flex; gap: 8px`).
- **Inline forms** in the parcel page's details column: `Label [____] [Save]` and `Postcode [____] [Save]` as two compact rows.
- States: rest, hover, focus-visible, `:user-invalid` (border → `--warn`, plus the browser's own message; no custom validation). Disabled states are not designed because nothing in the product is ever disabled.

### 6.8 Raw carrier responses

Bottom of the parcel page; lowest visual rank. `<details>` per response; `summary` in 13px ink-3 with a native marker (marker colour inherits). `<pre>` is 12px `--mono`, `--surface`, `--rule-s` outline, radius 8, `max-height: 20rem; overflow: auto`, and **`tabindex="0"`** so a keyboard user can scroll it (a scrollable region that cannot take focus is an accessibility bug).

### 6.9 Health

> **[Rev 2]** Rendered with the real state. Two changes: the lede no longer says "all" (Alex S7), and the **Last error column is dropped when no row has an error**; in the render it was five em-dashes of pure noise.

One board, not three tables: a row per system, one column grid, two groups (`Carriers`, `System`: the poller and the mail ingest). Columns: `State | Name | Last ok` and, only if any row has one, `Last error`. *Consecutive failures* is gone: for a healthy row it is the number `0`; for a failing row it moves into the state cell (`failing · 3 in a row`).

| State | Glyph | Colour | Weight |
|---|---|---|---|
| `ok` | check disc | ok | 400 word |
| `no data` | empty ring | ink-3 | 400 word |
| `failing` | triangle (solid) | warn | 600 |
| `needs attention` / `not running?` | triangle (solid) | warn | 600, row washed `--warn-wash` |

`no data` (SPS has never been polled: all five SPS parcels are archived) is neutral and **explicitly not** warn: nothing has been asked yet. The `Last ok` cell says `never`. The healthy board is a calm column of check discs; the eye lands on whichever one breaks that rhythm. Lede: `4 of 5 carriers reporting. SPS has never been polled.` Error detail text is 13px ink-3, wraps with `overflow-wrap: anywhere`, no clamp: an error message you cannot read is useless on exactly this page. Rendered with the real data it is 698px tall and entirely calm.

### 6.10 Attention (unparsed emails)

A list of items, not a list of tall cards. Each: subject (15/600, wraps), sender · date · reason on one 13px ink-3 line, then the assign form in the compact layout from §6.7. Dormant parcels: the section lede is kept; empty state is `None.` in ink-3.

Empty states everywhere follow one rule: **state the fact in one ink-3 line, and say what makes it fill.** `Nothing in flight. Parcels appear here when an email arrives or when you add one.` No illustrations.

---

## 7. Iconography

**Inline SVG is the only route, and almost nothing should use it.** Whitelist:

1. **The ten status glyphs.** This is the entire icon set.
2. **Reuse of those glyphs** in notices (warn triangle, ok check) and Health states. A notice does not get its own bespoke icon.

Everything else is **words**: no icons in the nav, no icon on buttons (including Refresh, where the word is clearer than any circular arrow), no carrier logos (they cannot be fetched, drawing them is both a trademark problem and a maintenance one, and the name is shorter), no pin on the location (the status glyph for `ready_for_pickup` is already a box, and the card header is the location), no chevrons (native `<details>` marker and native `<select>` keep theirs). The one non-glyph mark is the text character `↗` (U+2197) after `Open in Apple Maps`, because that link leaves the site and nothing else does.

### 7.1 Why these shapes

> **[Rev 2]** `returned` is now an open ring with the arrow inside, not a disc (Alex S9: in his render `delivered` and `returned`, both discs with a knocked-out mark, were nearly indistinguishable at 16px, and the only other difference was hue, which colour-blind readers lose). Ring versus disc now carries the difference. I rendered all ten at 16px and 40px in dark and light.

Silhouette families carry meaning, so that you can learn the set in a minute:

- **Rings = on the happy path, and fill = progress**: empty (`pre_transit`) → half (`in_transit`) → three-quarters (`out_for_delivery`) → full disc with a check (`delivered`).
- **Rounded square = a box waiting for you** (`ready_for_pickup`). Lid and body separated by a full-width cut (my first version had a centred slot and read as a "minus" button).
- **Warn shapes are angular**: diamond (`failed_attempt`, with ×) and triangle (`problem`, with !).
- **U-turn arrow = going back**: bare (`returning`: in motion) and inside an open ring (`returned`: finished).
- **A 4px dot = nothing to report** (`unknown`; and the continuation rows of a timeline run).

### 7.2 Sprite

> **[Rev 2]** The assumption I flagged in revision 1 is discharged: **Alex confirmed `<use href="#…">` works under the real CSP**, with a blocked `fetch` from the same page proving the policy was live. Rule that follows: the sprite stays in the same document on every page; never an external `sprite.svg#id` (that *is* a fetch). `returned` redrawn.

Defined once per page in a zero-size `<svg>` and referenced with `<use href="#g-…">`. Each use costs ~60 bytes instead of ~200. Geometry (16 × 16 viewBox; `currentColor`; strokes 1.5 round):

```html
<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false"><defs>
<symbol id="g-pre_transit" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/></symbol>
<symbol id="g-in_transit" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="currentColor"/></symbol>
<symbol id="g-out_for_delivery" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 8V2.6a5.4 5.4 0 1 1-5.4 5.4z" fill="currentColor"/></symbol>
<symbol id="g-ready_for_pickup" viewBox="0 0 16 16"><path fill="currentColor" d="M4 2h8a2 2 0 0 1 2 2v1.25H2V4a2 2 0 0 1 2-2zM2 6.75h12V12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/></symbol>
<symbol id="g-delivered" viewBox="0 0 16 16"><path fill-rule="evenodd" fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM4.6 8.2l1.1-1.1 1.5 1.5 3.1-3.2 1.1 1.1-4.2 4.3z"/></symbol>
<symbol id="g-failed_attempt" viewBox="0 0 16 16"><path fill-rule="evenodd" fill="currentColor" d="M8 1.2 14.8 8 8 14.8 1.2 8zM8 6.9 9.9 5 11 6.1 9.1 8 11 9.9 9.9 11 8 9.1 6.1 11 5 9.9 6.9 8 5 6.1 6.1 5z"/></symbol>
<symbol id="g-problem" viewBox="0 0 16 16"><path fill-rule="evenodd" fill="currentColor" d="M8 1.6 15 14H1zM7.2 6v4h1.6V6zM7.2 11v1.4h1.6V11z"/></symbol>
<symbol id="g-returning" viewBox="0 0 16 16"><path d="M6.25 3 3.25 6l3 3M3.5 6h6.25a3.25 3.25 0 0 1 0 6.5H7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-returned" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.4 5.4 5.4 7.4l2 2M5.6 7.4h3.2a1.9 1.9 0 0 1 0 3.8H7.6" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-unknown" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.25" fill="currentColor"/></symbol>
</defs></svg>
```

Rendered at 16px and 40px in both themes: all ten are distinguishable by silhouette alone, with one soft pair. `out_for_delivery` (¾ ring) versus `in_transit` (½ ring) differs by a quarter-turn of fill: distinguishable when you look, not at a glance. Alex agrees; the *register* (a bordered blue badge versus plain grey text) does the glance-level work, and the bordered badge is deliberately a real 1px border, not just blue text. The `returned` arrow is small inside its ring at 16px (1.25 stroke); it is the *ring* that signals, and the path should be eye-tuned at 1x and 2x during implementation. The sprite is ~1.9 KB; each use is `<svg class="g" width="16" height="16" aria-hidden="true"><use href="#g-…"/></svg>`.

Glyphs are `flex: none; display: block`, aligned to the text's centre line by the flex container; never `vertical-align` hacks.

---

## 8. Motion

**None that moves content.** The page is server-rendered; things change when you reload or navigate, and the interface is read in two seconds. Animating a list that was static the moment it loaded is decoration with a latency cost, and an animated "refreshing" state would be a lie, because the refresh is a form POST and a full page load.

The only transitions allowed:

- `transition: background-color .1s, border-color .1s` on hover for rows, cards, buttons (a 100ms ease so the hover doesn't flicker as the pointer crosses a list).
- Nothing else. No entrance animations, no skeletons, no spinners (there is no JS to remove them), no `scroll-behavior: smooth`.

```css
@media (prefers-reduced-motion: reduce) { * { transition: none !important } }
```

`<details>` open/close stays instant. A "newly changed since you last looked" highlight would be a good feature, but it needs state; I am not faking it with a CSS animation.

---

## 9. Accessibility

> **[Rev 2]** Link underline colour (Alex S1: my 1px underline was `--rule-s`, 1.35:1 on the pickup header, contradicting my own "edges ≥ 3:1" rule), focus inside clipped containers (S5), and text selection (S5). Everything else is as before.

- **Contrast:** §2.3. Text ≥ 4.5:1 everywhere including worst-case washes and the `hover` state; primary text ≥ 7:1; control edges, link underlines and glyphs ≥ 3:1; no meaning conveyed by a ≤ 1.7:1 hairline.
- **Beyond colour:** word + silhouette + register for every status (§2.5), and now a stated *test*: no component may reduce a status to a coloured word alone. Health states the same. The deadline's urgency is spelled out in words (`tomorrow`, `today`, `deadline passed`), not only in tint.
- **Focus:** `:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px }` on every link, button, input, select, summary. **Ink, not blue** (a blue ring on the blue wash is ~1:1 against its own panel; Alex agrees). Inside any container that clips (`overflow: hidden` for the radius: the row list, the pickup card) the ring is **inset**: `outline-offset: -2px`, otherwise it is cut off on the first and last rows. On stretched-link rows the ring is drawn on the row (`a:focus-visible::after`). Mouse clicks do not show it.
- **Hit areas:** ≥ 32px everywhere; rows and pickup lines are whole-surface links; history name cells 40px; buttons 36px (32px inline). This is a Mac with a pointer, so I did not size for touch, but nothing is below WCAG 2.5.8's 24px floor.
- **Links** are ink with a **1px underline in `--edge`** (3.23:1 on paper, 3.04 on the blue wash, 3.21 on the warn wash), offset 3px, darkening to ink on hover. In-text links and *history names* are underlined. Nav items, row titles and pickup-line names are not (they are targets by position, hover and ring, not by being words in a sentence). **No blue.**
- **Selection is protected.** A stretched link would otherwise cover the two strings you actually copy. The tracking number and the pickup location sit above the overlay (`position: relative; z-index: 1`) and the number has `user-select: all`; clicking them selects instead of navigating, and clicking anywhere else on the row navigates. On the parcel page there is no overlay and it just works.
- **Semantics the stylesheet cannot fix, but the markup must:** one `<h1>` per page; the current page marked `aria-current="page"`; `<nav aria-label>`; glyph SVGs `aria-hidden`; badge text is real text; tables keep `<th scope>`, year rows `scope="rowgroup"`; `<time datetime>`; `<pre tabindex="0">`; visible labels on the History filters; the nav's warn dot has visually-hidden text.
- **Forced colours:** badges carry `border: 1px solid transparent` so the shape survives when fills are dropped; glyphs use `currentColor`.
- **Dark mode** is `prefers-color-scheme` only: no toggle, and none is needed.
- **Zoom:** all rem; at 200% the single column holds, the two-column parcel layout collapses by its `min-width`.

---

## 10. Pages in one paragraph each

> **[Rev 2]** Updated for the location card, the new lede, the cause-dependent header, and the four-column history table.

- **In flight.** `h1` + a *conditional* lede (§5.2) + `Refresh now`. Then, in sort order (§6.2): time-bound Act rows, pickup cards (one per place), unclassified rows, then the quiet rows. Refresh-result notice sits between the lede and the first item.
- **Parcel.** `h1` (28/32); status line by cause (§6.4: indicator / nothing / `No updates yet` / `Archived`); one-line `carrier · number · merchant` in 13px; carrier's own `statusRaw` as `Carrier says: …` in ink-3. For a ready parcel, its place and "since" clock (the same line as in the card). Notices (postcode). Timeline (newest first, runs). On wide: details column on the right (Label, Postcode, Refresh this parcel; refresh only for parcels still tracked, as now). Raw responses. An archived parcel shows `Found in old mail; never tracked.` instead of a timeline.
- **History.** Lede with counts, a filter toolbar (visible labels; `Clear` only when a filter is active), year-grouped four-column table, then the median table.
- **Health.** Honest lede, one board (§6.9).
- **Attention.** Items with compact assign forms, then Dormant. No nav count until Dismiss exists.
- **Add.** One narrow form, one primary button.

---

## 11. What I am deliberately not doing

> **[Rev 2]** Added: a few things I considered after the review and declined (each argued in §14), and the stylesheet "budget" is now a complexity budget (Alex: a byte count is the wrong thing to police on localhost, and my trip-wire saved ~150 bytes at the price of a real status register).

- **Ten status colours.** Colour is attention level; identity is word and shape.
- **A chip on every row.** The rectangle is reserved for "someone is waiting for you".
- **Green for "ok" and red for "bad" as a pair.** The most common colour-vision deficiency collapses it, and *the current CSS uses exactly that pair*.
- **Blue links, blue buttons, blue focus rings.** Blue is the scarce word.
- **Left-border accent stripes** on notices and cards, uppercase tracked labels, zebra tables, drop shadows, gradient anything.
- **A dashboard grid on the 27" display.** The page grows with the root font size and stays a column.
- **A serif, a custom font, `ui-rounded`.** One system family, two weights, a monospace for identifiers.
- **Carrier logos, pins, refresh icons, nav icons.** Words.
- **Charts.** *n* = 1.
- **Animation, skeleton states, spinners.** §8.
- **A theme toggle.** `prefers-color-scheme` is the toggle.
- **Cleaning carrier data in the UI.** The trailing colon in `…vyzdvihnutie balíka:` is displayed as received.
- **Truncating or hyphenating carrier prose** where it is the primary content (§3.2.1).
- **Inventing a deadline.** No urgency colour on a pickup's age; no per-carrier hold period unless the owner asks for one (§6.1).
- **Showing carrier codes on timeline rows**, or folding repeated identical events (§6.4, §14).
- **An auto-refresh `<meta>`.** Alex raised the stale-tab problem (S8); the fix is that nothing relative is ever printed without its absolute date beside it. A meta-refresh would reset scroll position on the one page you scroll.
- **Weakening escaping.** Every design above works with "every interpolation is escaped text": the status class comes from a closed enum, the sprite and glyph markup are `raw` constants, and **no component needs a data-driven `style` attribute**. The deadline urgency is a class chosen server-side (`due-soon`, `due-today`). The Maps search URL is `encodeURIComponent` of the pickup name inside an escaped attribute; the carrier code goes in an escaped `title`.

### Stylesheet: a complexity budget, not a byte budget

One `<style>`; one stylesheet that can be read in a single sitting; components as a small, closed list (`card`, `row`, `badge`/`st`, `timeline`, `table`, `notice`, `form controls`, `nav`); no utility-class sprawl; no rule that needs a comment to explain why it exists. Alex's estimate for the real thing is **8-10 KB minified**, plus a ~2 KB sprite on every page; I agree it will not be the 7 KB I guessed, and on `localhost` it does not matter. If it grows past that, the question is not "what can I delete to save 150 bytes" but "which component did I add that the principle does not justify".

---

## 12. Things this asks of the code that are not CSS

> **[Rev 2]** Items 13-23 are new, most from Alex's section 6; items 1-12 are revised where the design changed. This is a design language that is cheaper to read than to build, and I'd rather the cost be visible.

1. **Nav counts** need `layout()` to receive data on every page (`healthBad` now; `attentionCount` once Dismiss exists).
2. **A status presentation function**, not a map: `presentation(status, hasEvents, archived)` → `{ word | sentence | none, register, glyph }` (§2.4). `STATUS_TITLE` stays for notifications.
3. **The index sort and zoning** (§6.2), including where parcels without events sort.
4. **Lede logic** (§5.2): clauses plus the two conditions that gate `Nothing needs you.` (needs "carrier is failing for an in-flight parcel" from the health table). Health's lede counts what is actually reporting.
5. **Date formatter by age, on full calendar date, in `Europe/Bratislava`** (§3.4), with the fixtures listed there (two of them are real rows in `attention.html`).
6. **Pickup clocks** (§6.1): `Since <absolute>` + day count; `Collect by <absolute> · <relative>`; the urgency class. Needs **the time of the event that put the parcel into `ready_for_pickup`** (today probably `lastChangedAt`; to confirm).
7. **Group by pickup location** (§6.1): key is the stored `pickup_name`; today that is the *whole* string (street and city columns are empty in the real data), so equal-string grouping works for Z-BOXes and not for variants.
8. **Maps link:** coordinates → `Open in Apple Maps`; otherwise a name search labelled `Search in Maps`; or none (product choice).
9. **Duplicate suppression** between the latest event and the pickup line (the card shows the place once, as the header).
10. **Timeline: reverse the events** (`db/events.ts:69` returns oldest first) **with `id DESC` as the tie-break**; **run heads** (status differs from the *newer* neighbour); day headings in the display zone; carrier code in `title`.
11. **Product question: the Attention page has no Dismiss.** Both items are Packeta e-mail verifications that can never become parcels; the page can never empty, so a nav count would be permanently lit. I would not ship the count until a Dismiss exists.
12. **History date semantics:** for archived rows the date is `firstSeenAt`, not an archive date; the caption must say so (§6.5). The Outcome column is `Delivered` / `Returned` / empty.
13. **Sprite** emitted once in `layout`, same document, never external.
14. **Markup:** `aria-current`, `<pre tabindex="0">`, visible labels on History filters, `scope="rowgroup"`.
15. **Health state map:** confirm that `ok`, `no data`, `failing`, `needs attention`, `not running?` are derived from the data as §6.9 assumes (`no data` = never polled; "overdue" threshold).
16. **Poller-overdue on the nav dot:** only after a whole polling day missed; otherwise Health page only (§5.1). A product threshold.
17. **Archived-parcel copy** on the parcel page (`Found in old mail; never tracked.`) and the History caption.
18. **`last_error` column** on Health rendered only if any row has an error.
19. **The refresh notice** already travels as counters (`RefreshNote`); it maps to the three-tone notice component (`alarm` → warn, `ok` → neutral/ok). No new mechanism.
20. **Test fixtures** for the formatter (§3.4) and for the lede (the table in §5.2 is the test list).
21. **Packeta event zone:** events are stored as `Europe/Prague`; display in `Europe/Bratislava`. Same offset today; say so in a test.
22. **`unknown` with events:** the "latest sentence" is the newest event by display order, same tie-break.
23. **A cap on pickup cards** (four), after which parcels render as Act rows.

---

## 13. Where I am guessing, and where I expect it to break

> **[Rev 2]** Replaced. Of the revision-1 list, Alex discharged the CSP/`<use>` item and struck the date-only events (all real events have full timestamps); he found the three musts I had not seen. This is the new, shorter, differently-shaped list.

- **Left-aligned column in a centred 64rem frame.** I looked at it at 1440 and 2560px and chose it over a jumping nav; on a very wide window the column sits ~100px left of centre with an empty right margin. If the owner finds that lopsided, the fix is to put something useful in that margin, not to centre the column.
- **Group-by-place assumes the stored name string is stable.** Real data is one string; a Packeta variant of the same Z-BOX (`Z-BOX Bratislava, Hlavna 6` vs `Hlavna 6, Z-BOX`) would split into two cards. Acceptable; flagged.
- **Act rows above the pickup cards** is a judgment: it puts "be home today" and "delivery failed" on top at ~80px each. If the owner thinks the *pickup* should always be first, the cost is that out_for_delivery can be off the first screen when there are many pickups. It would take a swap of two rules in §6.2.
- **The "since" clock without a deadline** is my best use of information that doesn't answer the question the user has ("how long do I have?"). Stating "no deadline given" is honest; it is not helpful. The real fix is a per-carrier hold period in config, which is not mine to invent.
- **`No updates yet`** vs Alex's `Not tracked yet`: mine, argued in §2.4, with `Archived` carrying the other case. If the label misleads for a *live* parcel that has been silent for weeks, that is the dormant list's job (it already exists).
- **The `unknown`-with-events promotion** (sentence in full ink, no word) leans on carrier prose being legible to the owner. For Slovak/English it is. For a language the owner can't read it would be a regression, and I have not seen such a case in the data.
- **The ¾-vs-½ ring** remains a soft pair; the `returned` arrow is tiny inside its ring. Rendered and fine in my eyes; not user-tested.
- **Ink focus ring** (my argument; Alex agreed).
- **`ui-monospace`** resolves in Safari and not reliably in Chrome; fallbacks cover macOS. I don't know which browser the owner uses.
- **Still not rendered:** Attention, Add, dark History/Health/Attention, `forced-colors`, `:user-invalid`, any failing-carrier state, a `problem` parcel, a real deadline row (only one Slovenská pošta test parcel exists, with no events), the History table with a long name actually wrapping, and the page in Slovak chrome (still unplanned: nav labels would grow 30-40%).
- **History's 34 vs 33.** I count 33 finished rows by first-seen year (14 + 18 + 1) against the page's 34; I did not reconcile the difference, and the lede's numbers must come from the same query as the rows.

---

---

## 14. Revision log (for Alex)

Format: what he said → what I did. **Accepted**, **Changed differently** (I took the point and solved it another way), **Rejected** (I hold my position, with the reason).

### Musts

| # | Finding | Outcome |
|---|---|---|
| M1 | Lede lies when status is unknown on 33/36 parcels; "No status yet" is false for 32 archived | **Accepted, mostly as proposed.** Status label by cause (3 cases); sentence promoted to status slot for prose-only carriers; lede gated by two conditions (§5.2); new principle 6. **Differences:** wording is `No updates yet` / `Archived`, not his `Not tracked yet`; and I kept the calm sentence under conditions rather than deleting it. A page that can never say "nothing needs you" has no resting state, and the resting state is the product. |
| M2 | Pickup card built on data four of five carriers never send | **Accepted; card redesigned, not patched.** One card per place with parcels beneath (his S3 merged into this), "Since" clock as the primary line, "gives no pickup deadline" stated once (I reversed my revision-1 argument), Maps link conditional and honestly labelled, degrade to an Act row when no location. **Differences:** failed_attempt/problem stay rows (no place to show); and I do not colour the age line (no deadline = no known limit). |
| M3 | Timeline fails on #34: coded-unknown runs, label at the wrong end of a run, order is oldest-first | **Accepted on all four points** (§6.4). **Differences:** I do *not* show the code as a trailing token on rows (it goes in `title`); coded and uncoded `unknown` are treated identically. |

### Should

| # | Finding | Outcome |
|---|---|---|
| S1 | Underline in `--rule-s` (1.35:1) contradicts my 3:1 rule; unlinked-looking names | **Accepted:** `--edge` underlines; history names underlined. **Held:** no blue links, nav/rows/titles stay un-underlined (whole-surface hover + ring). Alex agreed on blue. |
| S2 | `warn` on `hover` 4.46:1 | **Accepted:** `warn` is now `#b83c08`; all pairs re-tabulated (§2.3). I preferred the old colour; I prefer passing my own rule more. |
| S3 | Six pickups: 1668px, wrong shape | **Accepted:** grouped by place; **measured 1308px total** for six parcels at three places. Added: Act rows go *above* the cards. |
| S4 | Nav shifts between 42 and 60rem; two-column parcel page doesn't fit; ellipsis does nothing in a `<td>` | **Accepted:** one 64rem frame, 42rem content cap, nav capped to match; ellipsis dropped. |
| S5 | Stretched links defeat selection; focus ring clipped | **Accepted:** number and location lifted above the overlay; inset ring in clipped containers. |
| S6 | Date fixtures (`Mon 27 Oct` one year ago) | **Accepted:** full-calendar-date rule and the fixtures in §3.4. |
| S7 | Health lede false for SPS; poller-overdue nav dot would be lit every morning | **Accepted both:** honest lede; the dot is for carrier failure, poller overdue only after a missed polling day. |
| S8 | Relative text goes stale | **Changed differently:** I removed relative words from all timestamps and kept relative counts only *beside* absolute dates, rather than adding a meta-refresh (scroll reset). |
| S9 | `ok` vs `ink-2` ΔE 1-4; `delivered`/`returned` too alike | **Accepted:** stated the true worst case; `returned` is now an open ring. **Rejected recolouring `ok`:** it cannot get lighter without failing 4.5:1, and darker costs the green reading for everyone else; the fix is the redundancy rule, now a stated test. |
| S10 | History: define the Outcome column, real year counts | **Accepted.** I kept the year groups (28px each) and the exception-only rule, written as a contract. |

### Alex's smaller points

- **Stylesheet budget:** accepted; replaced with a complexity budget (§11).
- **`<use>` under the CSP:** thanks; discharged (§7.2).
- **A tab left open (S8), `Today` / `Yesterday`:** removed from all timestamps.
- **His thirteen additions to §12:** all taken (items 2-4, 7, 8, 10, 11, 14, 15, 17, 19-21).

### Things I considered and declined, so he can check my reasoning

1. **Folding exact duplicate events** (`HUS ×4`). Saves three of 24 rows on the one rich real parcel; loses per-event times; adds a grouping rule. Not worth it on the evidence.
2. **A trailing code token on every row.** Noise on the longest page; wrong audience.
3. **Colour for the age of a pickup without a deadline.** I'd be inventing the limit.
4. **Auto-refresh `<meta>`.** Resets scroll; solved by absolute dates instead.
5. **Darkening `ok` for CVD.** Can't be done honestly; see S9.
6. **A different resting message than "Nothing needs you."** Kept, with conditions.

### What I rendered to check this revision

Headless Chrome, real strings from the copy of `data/parcels.db`: the real index; the six-pickup case (light, dark, 1440px and 2560px / 18px root); parcel #34 verbatim, 24 events, reversed with the id tie-break and with run heads (light and dark); the unclassified-row cases; the History excerpt with the real distribution; the real Health state; all ten glyphs at 16px and 40px (dark and light) including the redrawn `returned`. Measured: real index 622px; six-pickup 1308px (cards 344/199/206); #34 page 1475px; History excerpt 1026px; Health 698px.

