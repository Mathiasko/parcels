# Themes, Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Postal its ornaments, motion and icons: neutral markup hooks that Classic ignores (pixel-identical), Postal CSS that turns them into stamps, postmarks, airmail and a little motion, plus a stamp app icon and a stamp tray icon.

**Architecture:** Views emit theme-neutral hooks: `data-status` attributes, `aria-hidden` `.orn-*` elements, a second `<use>` per glyph, and one-shot `just-*` classes. The base CSS hides every `.orn-*` element and every Postal glyph alternate, so Classic renders exactly as before. Postal's ornaments and motion live in new files beside `postal.ts` and are scoped to `:root[data-theme="postal"]`. Icons are drawn by committed scripts and committed as build outputs.

**Tech Stack:** TypeScript, Fastify 5, Electron 45 / electron-builder 26, vitest, headless Chrome + ImageMagick, `iconutil`.

**Spec:** `docs/superpowers/specs/2026-10-30-themes-design.md` §3.2–3.4, §4 Phase B, §5. **Visual source (READ-ONLY):** `/Users/matuslaco/Desktop/parcels-mac-app/.superpowers/design/moodboards/1-postal-ephemera.html`. Its line index:
- perforation mask: 81–90;
- badges: 140–160;
- cards, `.datestamp`, `.btn`: 161–176;
- `.codestamp` (box code plate): 181–185;
- `.postmark`: 186–199;
- `.pinstamp` (counter PIN): 214–215;
- `.rubber` and `.failed` edge: 217–223;
- `.airmail` chevrons: 52–56;
- empty state: 257–262;
- delights: 264–300;
- motion: 305–350 (`slam`, `thud`, `deal`, `march`, `inkin`);
- SVG `<defs>`: 350–412 (`m-stamp`, glyph symbols `g-ready`/`g-out`/`g-fail`/`g-transit`/`g-done`, `postmark` 380–391, `appicon` 392–409, `tray` 410);
- example cards: 534–720.

## Global Constraints

- Node: `export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH`. Run `command node` and `command npx`.
- Never read, print, modify or commit any real `config.json`, `data/` or `~/Library/Application Support/Parcels`.
- Never use port 8787.
- Never touch `/Users/matuslaco/Desktop/parcels`, `/Applications/Parcels.app` or `/Users/matuslaco/Desktop/parcels-mac-app`. The one exception is reading the mood board.
- No test may touch the network, `~/Library`, launchctl, osascript, codesign or `open`.
- Git: add files by name; never stash, merge, push, tag or release. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Known failures: `test/web-core.test.ts` fails on `main` (ignore it). `app-update › a server that stops sending fails at the time limit` can time out under load; re-run it alone.
- **Classic stays pixel-identical.** Every hook is invisible under Classic:
  - `.orn-*` elements and `.gp` glyph alternates are `display:none` in the base CSS;
  - `data-*` attributes and `just-*` classes carry no base styling.
- **Postal-only CSS:** every selector starts with `:root[data-theme="postal"]`. The existing scope test enforces this.
- **Motion:** all motion is inside `@media (prefers-reduced-motion: no-preference)`. No JavaScript in pages.
- **Stylesheet:** it never contains `</`. Every SVG data URL goes through Postal's percent-encoder (`%`, `<`, `>`, `#`, `"`).
- **Accessibility:**
  - every decoration is `aria-hidden="true"` and repeats nothing that isn't already said in text;
  - every status keeps its word, glyph shape and colour;
  - yellow (`--signal`) is a fill only, never text;
  - contrast is ≥ 4.5:1 for text and ≥ 3:1 for glyphs and control borders.
- **Merged view files:** the view files (`index.ts`, `parcel.ts`, `settings.ts`, `format.ts`) now carry persona-followups' code. Keep `pickupCodeLabel`/`pickupCodeLine` wording ("Open the box with" / "Show this PIN at the counter:" / "PIN") exactly.

## Rulings made while planning

- **Glyph alternates:** `glyph()` emits two `<use>`s, `<use class="gc" href="#g-x"/><use class="gp" href="#gp-x"/>`. The base CSS hides `.gp`; Postal hides `.gc` and shows `.gp`. CSS cannot change a `<use href>`, and an empty hidden `<use>` paints nothing, so Classic is unchanged.
- **Hidden decorations:** every decoration is a `.orn-*` element with `aria-hidden="true"`, hidden by the base CSS.
- **The `just-collected` slam:**
  - On the dashboard, the marked parcel has already left the page, so the slam lands on the existing "Marked X as collected" notice (`?collected=<id>`). That notice gains `just-collected` and a `.orn-postmark`.
  - On the parcel page, marking from that page now redirects to `/parcel/<id>?collected=1`. `just-collected` is set only while the mark is under `COLLECTED_NOTICE_MS` old, the same rule as the dashboard.
- **`just-arrived`:** on `/?run=<id>` for a finished run, a card gets `just-arrived` when one of its parcels is `ready_for_pickup`, has a code, and has `lastChangedAt` ≥ the run's start. That is "the first time a code appears", derived from data the server already has.
- **The `.orn-postmark` itself:**
  - It appears on a collected parcel's page (always) and in the dashboard's collected notice.
  - It holds the mark's date as `6·XI·26` (day · Roman month · two-digit year) and time `14:05`, both in the app's time zone.
  - Its arc text is `PARCELS ✶ COLLECTED ✶`, with no town.
- **Code plate:** `pickupCodeLine(code, kind, carrier?)` gains an optional third parameter. The `<p class="code">` gains `code-plate` and `data-kind`: `box` for `zbox`/`locker`, `counter` for `parcelshop`/`post_office`, else `plain`. A hidden `<span class="orn-place" aria-hidden="true">` holds `<Place> · <Carrier>`. Place names: zbox → `Z-BOX`, locker → `Box`, parcelshop → `ParcelShop`, post_office → `Post office`; none for `plain`.
- **Rubber stamp text:** the carrier's own words when they are at most 3 words and 24 characters (e.g. "Adresát nezastihnutý"); otherwise `Not delivered`. It is `aria-hidden`, because the sentence is already on the card.
- **Empty state:** the dashboard's empty state gains `<p class="orn-empty" aria-hidden="true">Nothing needs you</p>` before the existing `<p class="empty">`. Classic hides it; Postal shows it in DM Serif Display. Its `aria-hidden` is deliberate: the sentence below already says it.
- **Static screenshots** are shot with Chrome's `--force-prefers-reduced-motion`, so no card is caught mid-animation. Motion is shown as frozen frames (Task 4).
- **The final Classic proof** re-runs `theme-shots.sh` against the `main` f48fcac baseline (32 shots). The showcase script is also run on a temporary `main` worktree where it works unchanged; where it does not, that is ruled in the ledger.

## Review Focus

1. **Classic pixel identity under the new hooks.** Any hook whose base CSS is not `display:none`, or any changed text node in Classic, breaks it. Covered by Tasks 1–3 tests (`.orn-*` and `.gp` hidden in base) and the Task 4 re-diff.
2. **A one-shot marker that replays forever.** A bookmarked `/?run=N` or `/parcel/5?collected=1` days later must not slam or ink again. Task 3 tests the age limits.
3. **Screen readers hearing decorations.** Postmarks, rubber stamps, the place footer, the empty headline and the second glyph must all be `aria-hidden`, and the code must still read as one selectable string. Covered by Tasks 1–3 tests.
4. **Reduced motion.** With `prefers-reduced-motion: reduce` nothing moves, and the end state is what shows: the postmark visible, cards in place, the code sharp. Task 6 tests that every `animation`/`@keyframes`/`transition` in Postal is inside the no-preference block, and that the static rules give the end state.
5. **Icons at 16 px.** The tray stamp must read at 16 px on light and dark menu bars, and the app icon at 16 and 32 px must not turn to mush. Tasks 7–8 view them by eye and commit the evidence.

---

### Task 1: Glyph alternates and `data-status`

**Files:**
- Modify: `src/web/views/glyphs.ts`, `src/web/views/format.ts` (`statusIndicator`, `userMarkIndicator`, `quietIndicator`), `src/web/views/index.ts` (`card()`: one attribute), `src/web/views/style.ts` (one base rule: `.gp{display:none}`)
- Test: `test/postal-hooks.test.ts` (new)

**Interfaces — Produces:**
- `glyph(name)` returns `<svg class="g" …><use class="gc" href="#g-<id>"/><use class="gp" href="#gp-<id>"/></svg>`.
- `SPRITE` adds `<symbol id="gp-<name>">` for every `GlyphName`, plus any `<mask>` those need, inside its `<defs>`.
- `.b` and `.st` spans carry `data-status="<canonical status>"`. User marks carry `data-status="collected"` or `"received"`; quiet ones carry `data-status="unknown"`.
- `<article class="card" data-status="<chip status>">`, where a placed card is `ready_for_pickup`.

Postal shapes (from board symbols 365–379, redrawn to a 16×16 viewBox; give each id its own mask):
- `ready_for_pickup`: the stamp;
- `out_for_delivery`: chevrons;
- `failed_attempt`: the voided ring;
- `in_transit`: the envelope;
- `delivered`: the postmark ring.

The other statuses (`pre_transit`, `problem`, `returning`, `returned`, `unknown`) use their Classic shape under the `gp-` id.

- [ ] **Step 1: Failing tests.**
  - Every `glyph(x)` has both `use.gc` → `#g-x` and `use.gp` → `#gp-x`.
  - `SPRITE` defines `gp-` for all ten names.
  - `statusIndicator('failed_attempt')` contains `data-status="failed_attempt"`.
  - A dashboard card for a ready parcel has `data-status="ready_for_pickup"`.
  - `STYLE` has `.gp{display:none}` outside any theme scope.
  - Postal's CSS (once Task 5 exists) will swap them. For now assert that Classic's `themeCss` does not mention `.gp`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run focused and full suites and both typechecks → PASS.
- [ ] **Step 5:** Commit — `feat: views carry data-status and a Postal glyph alternate, hidden under Classic`.

### Task 2: Code plate, rubber stamp, empty headline

**Files:**
- Modify: `src/web/views/index.ts`:
  - `pickupCodeLine(code, kind, carrier?)`;
  - `cardEntry` passes `p.carrier`;
  - the failed-card rubber;
  - the empty-state headline.
- Modify: `src/web/views/parcel.ts` (pass the carrier to `pickupCodeLine`), `src/web/views/style.ts` (base `.orn-place,.orn-rubber,.orn-empty{display:none}`; better as one `[class^="orn-"],[class*=" orn-"]{display:none}` rule, which also covers Task 3).
- Create: `src/web/views/ornaments.ts`. It holds `codeKind(kind)`, `placeName(kind)`, `rubberText(description)` and `postmarkDate(at, zone)` (Task 3 uses the last one), so the view files only gain call sites.
- Test: `test/postal-hooks.test.ts`.

**Interfaces — Produces:**
- `codeKind(k: PickupPoint['kind'] | undefined): 'box' | 'counter' | 'plain'`
- `placeName(k): string | undefined`
- `rubberText(description: string): string`
- `pickupCodeLine(code, kind, carrier?)` emits `<p class="code code-plate" data-kind="…"><span class="code-l">…</span> <b class="mono sel">CODE</b><span class="orn-place" aria-hidden="true">Z-BOX · Packeta</span></p>`. `orn-place` is omitted for `plain` or when no carrier is passed.
- A failed card (`data-status="failed_attempt"`) gets `<span class="orn-rubber" aria-hidden="true">TEXT</span>` as the last child of its `.card-h`.
- Empty dashboard: `<p class="orn-empty" aria-hidden="true">Nothing needs you</p>` immediately before the existing `<p class="empty">`.

- [ ] **Step 1: Failing tests.**
  - `codeKind`: `zbox`/`locker` → `box`; `parcelshop`/`post_office` → `counter`; `undefined`/other → `plain`.
  - The label words are unchanged for each kind.
  - The code is still one `<b class="mono sel">` text node.
  - `rubberText('Adresát nezastihnutý')` → `Adresát nezastihnutý`; a 30-character or 4-word sentence → `Not delivered`; an empty sentence → `Not delivered`.
  - Every `orn-` element in rendered pages carries `aria-hidden="true"`; one test scans `/`, a failed parcel's card and the empty dashboard.
  - The base CSS hides `orn-`.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS, full suite, both typechecks.
- [ ] **Step 5:** Commit — `feat: code plate, rubber stamp and empty headline hooks, hidden under Classic`.

### Task 3: Postmark slot and the one-shot markers

**Files:**
- Modify:
  - `src/web/views/ornaments.ts`: `postmarkDate`, plus `postmark(at: Date, zone, oneShot: boolean): Html`;
  - `src/web/views/parcel.ts`: the collected parcel's postmark, near the status line or the pickup panel;
  - `src/web/views/index.ts`: `collectedNotice` gains the postmark and `just-collected`; `card()` gains `just-arrived`;
  - `src/web/views/layout.ts`: `notice()` may take an extra class;
  - `src/web/server.ts`: the parcel-page redirect becomes `?collected=1`; compute `justCollected` and `justArrived`;
  - `src/web/views/glyphs.ts` or `ornaments.ts`: the `postmark` ring symbol in the sprite (board 380–391).
- Test: `test/postal-hooks.test.ts`, `test/web-pages.test.ts` (redirect expectations).

**Interfaces — Produces:**
- `postmarkDate(at: Date): { date: string; time: string }` → `{ date: '6·XI·26', time: '14:05' }`, in the app's zone (reuse the zone helper the views already use).
- `postmark(at, oneShot)` →
  ```html
  <span class="orn-postmark[ just-collected]" aria-hidden="true">
    <svg viewBox="0 0 236 142"><use href="#postmark-ring"/><text …>DATE</text><text …>TIME</text></svg>
  </span>
  ```
- `indexPage` options gain `justArrived?: ReadonlySet<number>` (parcel ids). Its card gets ` just-arrived` when any member's id is in the set.
- `parcelPage` options gain `justCollected?: boolean`.

- [ ] **Step 1: Failing tests.**
  - `postmarkDate(new Date('2026-11-06T13:05:00Z'))` → `{ date: '6·XI·26', time: '14:05' }` (Europe/Bratislava, CET).
  - Marking from the parcel page → 303 to `/parcel/<id>?collected=1`.
  - That page has `orn-postmark just-collected`.
  - The same URL 61 minutes later has `orn-postmark` without `just-collected`.
  - A collected parcel's page always has `orn-postmark`.
  - A parcel not collected has none.
  - `/?collected=<id>` (recent) has `notice … just-collected` containing an `orn-postmark`.
  - `/?run=<finished run>` where a parcel turned ready with a code after the run started → its card has `just-arrived`. A parcel that turned ready before the run started has no `just-arrived`. `/?run=<running>` has none. `/?run=<unknown>` has none.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS, full suite, both typechecks.
- [ ] **Step 5:** Commit — `feat: postmark slot and one-shot just-collected / just-arrived markers`.

### Task 4: Showcase shots, frozen motion frames, and the Classic re-diff

**Files:**
- Modify: `scripts/dev/persona-sim/daemon.run.ts`. In `shot()`, add Chrome `--force-prefers-reduced-motion` unless `SIM_MOTION=1`.
- Create: `scripts/dev/theme-showcase/showcase.run.ts`, `scripts/dev/theme-showcase/vitest.config.ts` (copy fake-mail's pattern, so the repo suite never runs it), `scripts/dev/theme-showcase/README.md`.

**Interfaces — Produces:** `THEME=postal|classic OUT=<dir> command npx vitest run --config scripts/dev/theme-showcase/vitest.config.ts`. It:
- seeds a temp DB with the real db functions;
- starts the real `buildServer` on a free loopback port, never 8787, with fake calendar and notifier and no network;
- shoots each scene at 1280 and 390, light and dark, as `<scene>-<w>[-dark].png`, with reduced motion.

Scenes:
- `dash`: a dashboard with ready Z-BOX + code, ready locker + code, ready ParcelShop + PIN, ready post office + PIN, ready with no kind + PIN, out for delivery, failed attempt ("Adresát nezastihnutý"), in transit;
- `dash-empty`;
- `dash-collected-notice`: `/?collected=<id>`;
- `dash-arrived`: `/?run=<id>`;
- `parcel-box`, `parcel-counter`, `parcel-collected`, `parcel-failed`;
- `settings`.

With `FRAMES=1` it also writes motion frames for six motions, each at 0 %, 50 % and 100 %:
- postmark slam + card dip;
- deal-in;
- ink settle;
- airmail march;
- hover lift;
- button press.

How the frames are frozen: the saved HTML gets a `<style>` with `animation-play-state:paused!important` and per-element negative `animation-delay`. Hover and press are shown by injecting the `:hover`/`:active` rules as a class. Frames go to `<OUT>/motion/<motion>-<pct>.png`.

- [ ] **Step 1:** Write the showcase script. Self-check that every scene renders, and that each `.png` is not blank (ImageMagick `-format %[fx:standard_deviation]`).
- [ ] **Step 2: Classic re-diff after the hooks.**
  - `SIM_THEME=classic scripts/dev/persona-sim/theme-shots.sh .superpowers/sdd/2026-10-30-themes-phase-b/shots/classic-hooks`.
  - Diff against `.superpowers/sdd/2026-10-30-themes-phase-b/shots/main-f48fcac`. Expected: 28 at AE=0; the 4 settings shots AE=0 above the Appearance block (rows 0..1248 at 1280, 0..1415 at 390).
  - Copy the showcase into a temporary `git worktree add --detach /tmp/parcels-main-showcase main`, with a node_modules symlink. Run it there with no THEME, and here with `THEME=classic`. Diff each scene and remove the worktree.
  - Every non-zero diff must be explained (a scene main cannot render, e.g. `?collected=1` on the parcel page) or fixed.
  - Write `classic-diff-hooks.txt`.
- [ ] **Step 3:** Commit the scripts — `test: a theme showcase of every card state, with frozen motion frames`.

### Task 5: Postal ornaments (static)

**Files:**
- Create: `src/web/themes/postal-ornaments.ts`, exporting `POSTAL_ORNAMENTS: string`. Import it into `postal.ts`'s `css`.
- Test: `test/themes.test.ts`.

What to style, all scoped to Postal (board lines in the header):
- **Glyph swap:** `.gc{display:none}`, `.gp{display:inline}`.
- **Box code plate** (`.code-plate[data-kind=box]`): the board's `.codestamp`.
  - A perforated yellow stamp with a CSS radial-gradient mask (the holes are real).
  - The inner rule, rotated about 2°.
  - Label above, the code in Courier Prime 700 large, and `.orn-place` below in DM Serif italic.
  - A drop shadow on a wrapper is fine, provided the markup is unchanged (use `filter:drop-shadow` on the plate itself).
- **Counter PIN** (`[data-kind=counter]`): the board's `.pinstamp`, smaller.
- **Plain PIN** (`[data-kind=plain]`): the pinstamp without the place line.
- **Badges** by `data-status` (board 140–160):
  - ready: a solid yellow badge with a stamp (perforated) edge;
  - out for delivery: an outlined signal-ink badge with chevrons;
  - failed: solid warn with the voided ring;
  - in transit: plain ink-2 with the envelope;
  - delivered/collected: ok with the postmark ring.
  - Keep each status's word; the colour and the shape both change.
- **Airmail edge:** `.card[data-status=out_for_delivery]` gets a red/blue chevron top border (board `.airmail`, 52–56).
- **Failed edge:** `.card[data-status=failed_attempt]` gets the hatched warn left edge and `.orn-rubber` shown as the board's `.rubber` (rotated, grain mask), placed so it never covers the chip or the text. At 390 px, put it in the header's flow, not over the sentence.
- **Postmark:** `.orn-postmark` shown in ok ink, about 0.9 opacity, rotated −10°.
  - Positioned over the collected parcel's status area and over the notice's left part.
  - `mix-blend-mode:multiply` in light; normal in dark.
  - It must not cover the Undo button.
- **Empty headline:** `.orn-empty` in DM Serif Display, about 2.125rem, weight 400. The board has an `em` in ok colour, which there is no markup for — skip it.
- **Contrast:**
  - The code on yellow uses `--on-signal` (passes 9.36).
  - The rubber in warn on surface passes 6.06.
  - The postmark is decoration (aria-hidden); no minimum applies.
  - The place footer text on yellow is `--on-signal`.

- [ ] **Step 1: Failing tests.**
  - `POSTAL_ORNAMENTS` selectors are all postal-scoped.
  - No `</`, raw `<` or `#` in any data URL; every data URL decodes.
  - It contains the glyph swap.
  - It contains no `@keyframes`/`animation` (those are Task 6).
- [ ] **Step 2:** FAIL → **Step 3:** implement.
  - Shoot `THEME=postal` showcase plus `SIM_THEME=postal theme-shots.sh` into `.superpowers/sdd/2026-10-30-themes-phase-b/shots/postal-static/` and look at the cropped shots.
  - Fix anything ugly at 1280 and 390, light and dark.
- [ ] **Step 4:** PASS, full suite, typechecks.
- [ ] **Step 5:** Commit — `feat: Postal ornaments: stamp code plates, the badge set, airmail and failed edges, the postmark, the empty headline`.

### Task 6: Postal motion

**Files:**
- Create: `src/web/themes/postal-motion.ts`, exporting `POSTAL_MOTION`, one `@media (prefers-reduced-motion: no-preference){…}` block. Import it into `postal.ts`.
- Test: `test/themes.test.ts`.

Motions (board 305–350):
1. **Slam:** `.orn-postmark.just-collected` gets the board's `slam` keyframes, about 550 ms. The containing card, notice or `.pk` dips 3 px (`thud`), via `:has(.orn-postmark.just-collected)`.
2. **Deal-in:** `.card` gets `deal` at 0.5 s, stagger `nth-child(n)` × 60 ms for n ≤ 6, then 6 × 60 ms for the rest. Once per load (`both`, no repeat).
3. **Ink settle:** `.card.just-arrived .code-plate b` gets the board's `inkin`, 0.5 s.
4. **Airmail march:** the out-for-delivery edge animates `background-position` (`march`) `3` iterations, then stops.
5. **Hover lift:** `.card:hover` translates −3 px and rotates −0.8°, with a transition of about 0.2 s. Use the `translate`/`rotate` properties so it does not fight `deal`'s `transform`.
6. **Button press:** `button:active` translates 1 px down.

The reduced-motion end state is the static rules from Task 5: the postmark visible at its final opacity, everything in place.

- [ ] **Step 1: Failing tests.**
  - Every `@keyframes`, `animation` and `transition` in Postal's CSS sits inside the no-preference block. Parse the string: nothing outside it may match `/animation|@keyframes|transition/`.
  - All six names (`slam`, `thud`, `deal`, `inkin`, `march`) exist, and `march` has iteration count 3.
  - All selectors are postal-scoped.
  - Classic's CSS is unchanged; compare its themeCss to a snapshot taken before this task.
- [ ] **Step 2:** FAIL → **Step 3:** implement. Run the showcase with `FRAMES=1` into `.superpowers/sdd/2026-10-30-themes-phase-b/shots/motion/` and look at the frames.
- [ ] **Step 4:** PASS, full suite, typechecks.
- [ ] **Step 5:** Commit — `feat: Postal motion: postmark slam, deal-in, ink settle, airmail march, hover lift, button press`.

### Task 7: The stamp app icon

**Files:**
- Create:
  - `assets/icon/app-icon.svg`: the board's `appicon` (392–409) as a standalone SVG, 1024 viewBox, with the macOS icon grid's rounded-square margin;
  - `scripts/app/make-app-icon.mjs`: renders the SVG with headless Chrome (`--default-background-color=00000000`, transparent) at 16, 32, 64, 128, 256, 512 and 1024. It writes an `icon.iconset` (`icon_16x16.png`, `@2x`, …) in a temp dir and runs `iconutil -c icns` into `build/icon.icns`;
  - `build/icon.icns`, which is committed.
- Modify:
  - `electron-builder.yml`: `mac.icon: build/icon.icns`, explicitly, and `directories.buildResources: build` if needed;
  - `scripts/app/smoke.sh`: assert `$resources/icon.icns` exists and is not Electron's default (compare its size or sha against `build/icon.icns`);
  - `scripts/app/build-release.sh` `check_app`: the same assertion;
  - `test/app/release.test.sh` stubs, if they need it.
- Test: a vitest test that `build/icon.icns` exists, starts with `icns`, and contains the 16, 32 and 1024 representations (parse the icns TOC: `is32`/`icp4`, `ic05`/`icp5`, `ic10`).

- [ ] **Steps:** failing test → implement → run `node scripts/app/make-app-icon.mjs` → look at the 16, 32 and 1024 PNGs by eye (Read tool). At 16 px the stamp and its edge must still read; simplify the small sizes (no postmark text) if they turn to mush. Copy the three PNGs to `.superpowers/sdd/2026-10-30-themes-phase-b/shots/icon/` → tests pass → `bash test/app/release.test.sh` passes → commit — `feat: the stamp app icon`.

### Task 8: The stamp tray icon

**Files:**
- Modify: `scripts/app/make-tray-icon.py`. Redraw the glyph as a monochrome stamp silhouette with a dashed perforation edge on the 16 grid (board `tray`, line 410). Its alpha is the drawing; it is a template image. The count stays text beside it, unchanged in `app/tray.ts`.
- Regenerate: `app/assets/trayTemplate.png`, `app/assets/trayTemplate@2x.png`.

- [ ] **Steps:**
  - Run the script.
  - Composite each PNG on a light (`#ececec`) and a dark (`#2b2b2b`) background at 1× and 8× zoom, with ImageMagick, into `.superpowers/sdd/2026-10-30-themes-phase-b/shots/tray/`, and look at them.
  - Iterate until the stamp reads at 16 px.
  - Any test that checks the tray PNG dimensions keeps passing.
  - Commit — `feat: the stamp tray icon`.

### Task 9: Design language

**Files:** Modify `docs/design-language.md`.

- [ ] Add one short section, "Themes and Postal", without rewriting the rest. It covers:
  - the token contract and that a theme is one file;
  - Classic = this document's look;
  - Postal's mapping (yellow fill only, signal-ink for text, red/blue axis);
  - the hooks (`data-status`, `.orn-*`, `.gp`, `just-*`) and the rule that the base hides them;
  - the motion list and the reduced-motion rule;
  - the icons.

  Point to the spec for detail, then commit — `docs: the design language names themes and Postal`.

### Task 10: Postal, looked at (controller)

- [ ] Shoot every page with `SIM_THEME=postal theme-shots.sh`, and the showcase with `THEME=postal`, both modes, 1280 and 390, into `shots/postal-final/`.
- [ ] Look at every shot and at the motion frames, and fix what is ugly through a fix implementer (Postal files only).
- [ ] Final Classic re-diff exactly as in Task 4 Step 2 → `classic-diff-final.txt`.
