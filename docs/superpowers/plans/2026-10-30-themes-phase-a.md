# Themes, Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard's look swappable through one-file themes, ship Classic (today's look, pixel-identical) and Postal (new default: tokens, offline fonts, grain), and let Settings choose theme and mode.

**Architecture:** `src/web/views/style.ts` becomes token-only base CSS plus every registered theme's CSS (`themeCss`). A theme is `src/web/themes/<id>.ts`; colours are emitted as `light-dark()`, and `<html data-theme data-mode>` picks theme and `color-scheme`. Fonts are committed `woff2` files served from a fixed allowlist by the Fastify server (`/fonts/<file>`) and by the app's `parcels://` protocol.

**Tech Stack:** TypeScript, Fastify 5, Electron 45, vitest, headless Chrome + ImageMagick (screenshots, via `scripts/dev/persona-sim`).

**Spec:** `docs/superpowers/specs/2026-10-30-themes-design.md` (§1, §2, §3.1, §4 Phase A, §5). Read it before any task.

## Global Constraints

- Node: `export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH`; call `command node`, `command npx` (wrappers may exit 1 silently).
- Never read, print, modify or commit any real `config.json`, `data/`, or `~/Library/Application Support/Parcels`. Never use port 8787. Never touch `/Users/matuslaco/Desktop/parcels`, `/Users/matuslaco/Desktop/parcels-mac-app` (except reading the two reference files), `/Applications/Parcels.app`.
- No test may touch the network, `~/Library`, launchctl, osascript, codesign or `open`.
- Git: add files by name (never `-A`, `.`, `-a`); never stash, merge, push, tag. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `test/web-core.test.ts` already fails on `main` (reads the repo's real config.json): ignore it. `app-update › a server that stops sending fails at the time limit` can time out under load: re-run alone.
- `persona-followups` edits `src/web/views/settings.ts`, `index.ts`, `parcel.ts`, `src/notify/rules.ts` in parallel: in those view files make only small, self-contained insertions (one-line call sites; new code goes in new files).
- No JavaScript in pages. Motion, ornament hooks, icons, design-language rewrite are **Phase B — out of scope**.
- Colour tokens (both modes, every theme): `--paper --surface --hover --rule --rule-s --edge --ink --ink-2 --ink-3 --signal --signal-ink --on-signal --signal-wash --warn --on-warn --warn-wash --ok --ok-wash --btn-hover`. Shape tokens (once per theme): `--font-display --font-body --font-mono --radius-card --radius-badge --radius-btn --shadow-card --texture`.
- Theme ids: `'postal' | 'classic'`; default theme `postal`. Modes: `'system' | 'light' | 'dark'`; default `system`.
- Server CSP becomes exactly: `default-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`.
- `PAGE_CSP` becomes exactly: `default-src 'none'; style-src 'unsafe-inline'; font-src parcels:; img-src data:; form-action parcels:`.
- Font responses: `Content-Type: font/woff2`, `Cache-Control: public, max-age=31536000, immutable`; any name off the allowlist is a 404.
- The page stylesheet must never contain `</` (it is inlined in `<style>`, and `fillPage` refuses it).

## Rulings made while planning

- Ruling: `Config.appearance` is optional in the TypeScript type (dozens of test fixtures build `Config` literals); `validateConfig` always fills it, and readers fall back to `DEFAULT_APPEARANCE`.
- Ruling: theme ids and modes live in `src/core/appearance.ts` (core must not import `src/web`); the theme registry's ids are asserted equal to `THEME_IDS` by test.
- Ruling: `style.ts` keeps `export const STYLE` (now `BASE_CSS` + every theme's CSS), so every existing importer and every existing `STYLE` regex test keeps working.
- Ruling: the 8px boxes (`.notice`, `.guide`, `pre`, `.map-f`, `.calf form`) use `min(8px,var(--radius-card))`: Classic stays 8px, Postal follows its 6px card radius.
- Ruling: `--texture` holds the light grain; `light-dark()` takes no images, so Postal's own `css` swaps in the dark grain under `[data-mode="dark"]` and under `[data-mode="system"]` inside `@media(prefers-color-scheme:dark)`.
- Ruling: the grain SVG is percent-encoded (`<`→`%3C`, `>`→`%3E`, `#`→`%23`) so the stylesheet never contains `</`.
- Ruling: the theme font type is named `ThemeFont`, not `FontFace` (the DOM has a global `FontFace`).
- Ruling: Postal's fonts come from the fontsource npm packages (`@fontsource/dm-serif-display`, `@fontsource-variable/libre-franklin`, `@fontsource/courier-prime`), fetched with `npm pack` into a temp dir; versions recorded in `assets/fonts/README.md`; nothing is added to `package.json`.
- Ruling: the first-run pages (`parcels://welcome`, `move-in`, the result page) render with `FirstRunDeps.appearance ?? DEFAULT_APPEARANCE`; `app/main.ts` passes none (there is no config yet on a first run). The simulator passes one for the screenshot diff.
- Ruling: `parcels://` serves fonts at `/fonts/<file>` on whichever first-run host is active, GET only.
- Ruling: `npm run app:smoke` cannot open a window, so it proves the packaged server reads the fonts out of `app.asar` (`/fonts/<file>` answers 200 `font/woff2`); the protocol's font route is proved by unit test.
- Ruling: a Settings save whose form has no `theme`/`mode` field (a tab opened before the upgrade) keeps the stored values; the activity log compares effective values, so writing explicit defaults over an absent block logs nothing.
- Ruling: display weight — DM Serif Display ships only 400, so Postal's `css` sets `font-weight:400` on display elements instead of letting the browser fake a bold.

## Review Focus

1. A stylesheet containing `</` (an un-encoded SVG data URL) would end `<style>` early on every page and make `fillPage` throw on the first-run page → Task 2 and Task 6 test `STYLE` has no `</`.
2. A hand-edited config with `"appearance": null`, `"appearance": "dark"`, `{"theme":"Postal"}` or `{"mode":"auto"}` must fail with a message naming the key and the allowed values; `{}` means the defaults → Task 1 tests.
3. A Settings form posted without `theme`/`mode` (stale tab) must save, keep the stored appearance, and log no appearance change → Task 8 tests.
4. `/fonts/..%2fconfig.json`, `/fonts/OFL.txt`, `/fonts/README.md`, `/fonts/x.woff2` must be 404s that read nothing → Task 7 tests; the same for `parcels://welcome/fonts/...` → Task 7.
5. The error page rendered when the database is down (`errorCtx` fallback) must still carry the configured theme, or it renders in the default theme for someone who chose Classic → Task 3 test.

---

### Task 1: Appearance in the config

**Files:**
- Create: `src/core/appearance.ts`
- Modify: `src/core/config.ts` (interface `Config`, `validateConfig`)
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const THEME_IDS = ['postal', 'classic'] as const
  export type ThemeId = typeof THEME_IDS[number]
  export const MODES = ['system', 'light', 'dark'] as const
  export type Mode = typeof MODES[number]
  export interface Appearance { theme: ThemeId; mode: Mode }
  export const DEFAULT_APPEARANCE: Appearance = { theme: 'postal', mode: 'system' }
  // config.ts
  interface Config { …; appearance?: Appearance }   // validateConfig always sets it
  ```

- [ ] **Step 1: Write failing tests** in `test/config.test.ts`, `describe('appearance')`:
  - absent → `validateConfig({defaultPostalCode:'81101'}).appearance` equals `{theme:'postal',mode:'system'}`; `{appearance:{}}` → same.
  - `{appearance:{theme:'classic',mode:'dark'}}` → `{theme:'classic',mode:'dark'}`; `{appearance:{mode:'light'}}` → `{theme:'postal',mode:'light'}`.
  - rejects with `/"appearance" must be an object/` for `null`, `"dark"`, `[]`.
  - rejects `{theme:'Postal'}` and `{theme:'kraft'}` with a message matching `/"appearance\.theme" must be one of postal, classic/`; rejects `{mode:'auto'}` with `/"appearance\.mode" must be one of system, light, dark/`; both messages include the label (`config <label>:` like the other errors).
  - extra keys inside `appearance` are kept by `writeConfigDocument` round trip (document is not narrowed) — assert via `validateConfig` not throwing on `{theme:'classic', extra:1}`.
- [ ] **Step 2:** `command npx vitest run test/config.test.ts` → the new tests FAIL.
- [ ] **Step 3:** Implement `src/core/appearance.ts` (above) and the validation in `validateConfig`, next to the `notifier` check, same message style.
- [ ] **Step 4:** `command npx vitest run test/config.test.ts` PASS; `npm run typecheck` clean.
- [ ] **Step 5:** Commit `src/core/appearance.ts src/core/config.ts test/config.test.ts` — `feat: the config has an appearance: theme and mode`.

### Task 2: Theme engine, with Classic extracted

**Files:**
- Create: `src/web/themes/types.ts`, `src/web/themes/classic.ts`, `src/web/themes/index.ts`
- Modify: `src/web/views/style.ts`
- Test: create `test/themes.test.ts`, `test/theme-contrast.ts` (shared fixture: WCAG `contrast(a: string, b: string): number` for `#rrggbb`)

**Interfaces:**
- Consumes: `ThemeId` from Task 1.
- Produces:
  ```ts
  // types.ts
  export const COLOR_TOKENS = ['paper','surface','hover','rule','rule-s','edge','ink','ink-2','ink-3','signal','signal-ink','on-signal','signal-wash','warn','on-warn','warn-wash','ok','ok-wash','btn-hover'] as const
  export type ColorToken = typeof COLOR_TOKENS[number]
  export const SHAPE_TOKENS = ['font-display','font-body','font-mono','radius-card','radius-badge','radius-btn','shadow-card','texture'] as const
  export type ShapeToken = typeof SHAPE_TOKENS[number]
  export interface ThemeFont { family: string; file: string; style: 'normal' | 'italic'; weight: string; unicodeRange: string }
  export interface Theme { id: ThemeId; name: string; colors: Record<ColorToken,{light:string;dark:string}>; tokens: Record<ShapeToken,string>; fonts: ThemeFont[]; css?: string }
  // index.ts
  export const THEMES: readonly Theme[]          // [classic] in this task; Task 6 adds postal first
  export const DEFAULT_THEME: ThemeId = 'postal'
  export function themeCss(theme: Theme): string
  export function themeById(id: string): Theme | undefined
  // style.ts
  export const BASE_CSS: string
  export const STYLE: string                     // BASE_CSS + THEMES.map(themeCss).join('')
  ```

- [ ] **Step 1: Write failing tests** in `test/themes.test.ts`:
  - `contract`: for each theme in `THEMES`, for each `COLOR_TOKENS` and mode, value is a non-empty string; for each `SHAPE_TOKENS`, non-empty; failure message names theme and token (use `expect(value, \`${t.id} --${tok} ${mode}\`)`).
  - `contrast`: for each theme and mode, every pair of spec §5 (4.5: ink/ink-2/ink-3 on paper/surface/hover; signal-ink on paper, surface; on-signal on signal; on-warn on warn; warn on surface; ok on surface. 3.0: edge on paper, surface) meets its minimum; message `${t.id} ${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`. Colour tokens used in pairs must be `#rrggbb`.
  - `themeCss(classic)` contains `:root[data-theme="classic"]{` and `--paper:light-dark(#f5f3ee,#151411)` and `--signal-ink:light-dark(#2a4bd1,#98a9ff)` and `--texture:none`; contains no `@font-face` (Classic has no fonts).
  - `themeCss` of a theme with one `ThemeFont` emits `@font-face{font-family:"<family>";src:url(/fonts/<file>) format("woff2");font-style:…;font-weight:…;font-display:swap;unicode-range:…}` (build a throwaway theme object in the test).
  - `STYLE` contains no `</`; `BASE_CSS` contains no `#` hex colour literal outside comments (only `var(--…)`), i.e. `/:\s*#[0-9a-f]{3,6}/i` does not match after stripping `/*…*/`.
  - base mode rules: `STYLE` contains `:root{color-scheme:light dark}`, `:root[data-mode="light"]{color-scheme:light}`, `:root[data-mode="dark"]{color-scheme:dark}`; and no `prefers-color-scheme` outside theme CSS (Classic has none).
  - Existing `STYLE` regex tests in `test/web-pages.test.ts`, `test/calendar-web.test.ts`, `test/fake-mail-regressions.test.ts`, `test/refresh-async.test.ts` must stay green unchanged.
- [ ] **Step 2:** run `command npx vitest run test/themes.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement.**
  - `classic.ts`: today's values exactly (light = `:root` line 7–9 of today's `style.ts`, dark = the `prefers-color-scheme:dark` block); `signal-ink` = `signal` in both modes; tokens: `font-display` and `font-body` = `-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Helvetica Neue",sans-serif`, `font-mono` = `ui-monospace,"SF Mono",Menlo,monospace`, `radius-card` `12px`, `radius-badge` `4px`, `radius-btn` `6px`, `shadow-card` `none`, `texture` `none`; `fonts: []`; no `css`. `on-signal`/`on-warn` light `#ffffff` is fine (#fff equivalent) — keep `#fff` if the contrast fixture accepts 3-digit hex; otherwise expand both and say so.
  - `themeCss`: `:root[data-theme="<id>"]{--<tok>:light-dark(<l>,<d>);…;--<shape>:<v>;…}` + `@font-face` per font + `theme.css ?? ''`.
  - `style.ts`: delete the two `:root` token blocks; start with `:root{color-scheme:light dark}:root[data-mode="light"]{color-scheme:light}:root[data-mode="dark"]{color-scheme:dark}`. Replace in the rules, and nowhere else:
    - `body` font family → `var(--font-body)`; add `background-image:var(--texture)` to `body`.
    - `.mono` and `pre` font family → `var(--font-mono)`.
    - `font-family:var(--font-display)` added to `h1`, `.card-h h2`, `.pk-h h2,.pk-h .where`.
    - `.t-signal{color:var(--signal-ink);--bar:var(--signal-ink)}`, `.clock .due{color:var(--signal-ink)}`. Fills (`.b.solid.t-signal`, `.map-pin`) keep `--signal`.
    - `border-radius:12px` on `.card`, `.pk`, `.item`, `.bulk` → `var(--radius-card)`; add `box-shadow:var(--shadow-card)` to `.card`, `.pk`, `.item`.
    - `border-radius:4px` on `.b`, `nav .n` → `var(--radius-badge)`.
    - `border-radius:6px` on `button`, `input,select`, `.calf summary`, `.calf-b`, `.pick` → `var(--radius-btn)`.
    - `border-radius:8px` on `.notice`, `.guide`, `.calf form`, `.map-f`, `pre` → `min(8px,var(--radius-card))`.
    - Keep every comment; update the file's header comment to say the colours come from themes.
  - `STYLE = BASE_CSS + THEMES.map(themeCss).join('')`.
- [ ] **Step 4:** `command npx vitest run test/themes.test.ts test/web-pages.test.ts test/calendar-web.test.ts test/fake-mail-regressions.test.ts test/refresh-async.test.ts` PASS; `npm run typecheck` clean.
- [ ] **Step 5:** Commit the five files — `feat: themes: a token-only base stylesheet, and Classic holding today's values`.

### Task 3: Pages carry `data-theme` and `data-mode`

**Files:**
- Modify: `src/web/views/layout.ts` (`PageCtx`, `layout`), `src/web/server.ts` (`ctx`, `errorCtx`), `app/pages/welcome.html`, `app/pages/move-in.html`, `app/pages/result.html`, `app/protocol.ts` (`FirstRunDeps`, the three `fillPage` calls), `scripts/dev/persona-sim/daemon.run.ts` (its direct `fillPage(pages.result, …)` call)
- Test: `test/web-pages.test.ts` (or a new `test/appearance-web.test.ts`), `test/app/protocol.test.ts`, `test/app/first-run.test.ts`

**Interfaces:**
- Consumes: `Appearance`, `DEFAULT_APPEARANCE` (Task 1).
- Produces: `PageCtx.appearance?: Appearance`; `FirstRunDeps.appearance?: Appearance`; page templates take `{{theme}}` and `{{mode}}` values.

- [ ] **Step 1: Failing tests:**
  - server built with `config: { ...config, appearance: { theme: 'classic', mode: 'dark' } }`: `GET /`, `/settings`, `/health`, an unknown route (404 page) each start with `<html lang="en" data-theme="classic" data-mode="dark">`.
  - server with no `appearance` in config → `data-theme="postal" data-mode="system"`.
  - Review Focus 5: a server whose `ctx()` throws (close the db before the request, as existing error-page tests do) renders the error page with `data-theme="classic"` from the config.
  - `firstRunHandler` GET `parcels://welcome/` with no `appearance` → body contains `data-theme="postal" data-mode="system"`; with `appearance:{theme:'classic',mode:'light'}` → those values; move-in and the result page likewise.
- [ ] **Step 2:** run those test files → FAIL.
- [ ] **Step 3:** Implement. `layout` renders `<html lang="en" data-theme="${a.theme}" data-mode="${a.mode}">` with `a = ctx.appearance ?? DEFAULT_APPEARANCE`. `ctx()` adds `appearance: config.appearance`; `errorCtx`'s fallback adds it too. Templates: `<html lang="en" data-theme="{{theme}}" data-mode="{{mode}}">`. Protocol passes `theme`, `mode` to all three `fillPage` calls. Update the sim daemon's direct `fillPage(pages.result, …)` call to pass `theme`/`mode`.
- [ ] **Step 4:** the test files PASS; `npm run typecheck` and `command npx tsc -p tsconfig.app.json --noEmit` clean.
- [ ] **Step 5:** Commit — `feat: every page names its theme and mode on <html>`.

### Task 4: Prove Classic pixel-identical to `main`

**Files:**
- Modify: `scripts/dev/persona-sim/daemon.run.ts` (`SIM_THEME`/`SIM_MODE` env → `cfgDoc.appearance` and `config.appearance` and `FirstRunDeps.appearance`; in `shot()`, inline `url(/fonts/<file>)` as `data:font/woff2;base64,…` via `server.inject`, alongside the existing `src="/…"` inlining)
- Create: `scripts/dev/persona-sim/theme-shots.sh`
- Output (not committed): `.superpowers/sdd/2026-10-30-themes-phase-a/shots/{main,classic}/…png`, `…/shots/classic-diff.txt`

**Interfaces:**
- Produces: `scripts/dev/persona-sim/theme-shots.sh <out-dir>`: with `SIM_THEME`/`SIM_MODE` passed through, starts persona `eva`, lives days with `sim day` until day 5 (fixed count, same on both sides), takes `/`, `/history`, `/attention`, `/health`, `/settings`, `/add`, `/parcel/<n>` (n = the first parcel id the dashboard links), and `app:first-run`, each at 1280 and 390, light and `--dark`, into `<out-dir>/<slug>-<w>[-dark].png`; then `sim stop`. On `main` the env vars are simply ignored.

- [ ] **Step 1:** Write `theme-shots.sh` and the daemon changes. Self-check: `SIM_THEME=classic` run → `sim text /` html has `data-theme="classic"`.
- [ ] **Step 2: Baseline.** `git worktree add /tmp/parcels-main-baseline main`; symlink `node_modules` from this worktree; copy `theme-shots.sh` into it (untracked); run it with out-dir `…/shots/main`; then `git worktree remove --force /tmp/parcels-main-baseline` and confirm with `git worktree list`.
- [ ] **Step 3: Branch.** `SIM_THEME=classic scripts/dev/persona-sim/theme-shots.sh …/shots/classic`.
- [ ] **Step 4: Diff.** For every pair, `magick compare -metric AE <main> <classic> <diff>.png` (also compare image sizes); write one line per pair to `classic-diff.txt`: `<name> AE=<n> size=<same|WxH vs WxH>`. Expected: every AE is 0. Any non-zero: find the cause (open both PNGs and the diff), fix it in the CSS, re-run Step 3–4. A remaining non-zero must be explained in the ledger with a `Ruling:` line (e.g. a time-of-day string the simulator cannot pin).
- [ ] **Step 5:** Commit `scripts/dev/persona-sim/daemon.run.ts scripts/dev/persona-sim/theme-shots.sh` (+ any CSS fix) — `test: the persona simulator takes a theme, and theme-shots.sh shoots every page for a diff`.

### Task 5: Postal's font files

**Files:**
- Create: `assets/fonts/*.woff2` (10 files below), `assets/fonts/dm-serif-display/OFL.txt`, `assets/fonts/libre-franklin/OFL.txt`, `assets/fonts/courier-prime/OFL.txt` (or `OFL-<family>.txt` flat — implementer's choice, recorded in the README), `assets/fonts/README.md`

The files (fontsource names):
`dm-serif-display-latin-400-normal.woff2`, `dm-serif-display-latin-ext-400-normal.woff2`, `dm-serif-display-latin-400-italic.woff2`, `dm-serif-display-latin-ext-400-italic.woff2`, `libre-franklin-latin-wght-normal.woff2`, `libre-franklin-latin-ext-wght-normal.woff2`, `courier-prime-latin-400-normal.woff2`, `courier-prime-latin-ext-400-normal.woff2`, `courier-prime-latin-700-normal.woff2`, `courier-prime-latin-ext-700-normal.woff2`.

- [ ] **Step 1:** In a new empty temp dir: `command npm pack @fontsource/dm-serif-display @fontsource-variable/libre-franklin @fontsource/courier-prime`; extract each tarball into its own subdir; never run anything from inside them.
- [ ] **Step 2:** Copy the 10 files and each package's licence (OFL text) into `assets/fonts/`; check each `.woff2` starts with the bytes `wOF2`.
- [ ] **Step 3:** Write `assets/fonts/README.md`: one row per family with package name, version, upstream project, licence; the `unicode-range` strings for `latin` and `latin-ext` copied from the package CSS (Task 6 uses them).
- [ ] **Step 4:** Commit by name — `chore: Postal's fonts, latin and latin-ext woff2, with their OFL licences`.

### Task 6: Postal theme, the new default

**Files:**
- Create: `src/web/themes/postal.ts`
- Modify: `src/web/themes/index.ts` (`THEMES = [postal, classic]`)
- Test: `test/themes.test.ts`

**Interfaces:**
- Consumes: `Theme`, `ThemeFont`, `themeCss` (Task 2); font files and unicode ranges (Task 5).
- Produces: `postal: Theme` with `id: 'postal'`, `name: 'Postal'`; `THEMES` order `[postal, classic]` (Settings lists them in this order).

- [ ] **Step 1: Failing tests:**
  - registry ids equal `THEME_IDS` (as sets) and `DEFAULT_THEME === DEFAULT_APPEARANCE.theme === 'postal'`.
  - every `ThemeFont.file` of every theme exists in `assets/fonts/` and ends `.woff2`; Classic's `fonts` is empty.
  - `STYLE` still has no `</`; it contains `:root[data-theme="postal"]{`.
  - contract and contrast tests (Task 2) now also run on Postal and pass.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement `postal.ts`.** Colours (light / dark):

  | token | light | dark |
  |---|---|---|
  | paper | `#f3ead7` | `#211c18` |
  | surface | `#fbf6ea` | `#2c2620` |
  | hover | `#f1e7d2` | `#362f27` |
  | rule | `#e6dcc6` | `#3a332b` |
  | rule-s | `#d9cbb0` | `#4b4237` |
  | edge | `#857559` | `#8f826e` |
  | ink | `#1d2433` | `#f1e8d6` |
  | ink-2 | `#5a4f3f` | `#c3b6a0` |
  | ink-3 | `#6a5d48` | `#ab9d87` |
  | signal | `#f6c21c` | `#f7c948` |
  | signal-ink | `#7a5600` | `#f7c948` |
  | on-signal | `#1d2433` | `#241a00` |
  | signal-wash | `#f9e7a8` | `#3b3118` |
  | warn | `#b3261e` | `#ff8a7a` |
  | on-warn | `#fbf6ea` | `#2a0d08` |
  | warn-wash | `#f7e0d6` | `#3f241f` |
  | ok | `#23468c` | `#9db8ff` |
  | ok-wash | `#e2e6f0` | `#222a3d` |
  | btn-hover | `#2f3a52` | `#ffffff` |

  (All §5 pairs pass; computed while planning, lowest: dark ink-3 on hover 4.96, light edge on paper 3.75.)
  Tokens: `font-display` `"DM Serif Display",Georgia,serif`; `font-body` `"Libre Franklin","Helvetica Neue",sans-serif`; `font-mono` `"Courier Prime","Courier New",monospace`; `radius-card` `6px`; `radius-badge` `3px`; `radius-btn` `4px`; `shadow-card` `0 1px 0 rgba(90,70,30,.08),0 14px 26px -16px rgba(80,55,15,.45)`; `texture` = the board's light grain (`1-postal-ephemera.html` `.grain`), percent-encoded.
  Fonts: 10 `ThemeFont`s (DM Serif Display 400 normal+italic, Libre Franklin `400 800` normal, Courier Prime 400 and 700), each latin and latin-ext with its `unicodeRange`.
  `css` (all scoped `[data-theme="postal"]`): `font-weight:400` on `h1`, `.card-h h2`, `.pk-h h2`, `.pk-h .where`; dark grain per the ruling (board's `.dk.grain`), plus dark `--shadow-card` (`0 1px 0 rgba(0,0,0,.4),0 16px 30px -14px rgba(0,0,0,.7)`) the same way. Nothing else in Phase A — no ornaments, no motion.
- [ ] **Step 4:** `command npx vitest run test/themes.test.ts` PASS; full `command npx vitest run` — fix any test that asserted the default theme's absence; typecheck clean.
- [ ] **Step 5:** Commit — `feat: Postal, the new default theme: cream paper, grain, DM Serif Display, Libre Franklin, Courier Prime`.

### Task 7: Fonts served, CSP loosened by exactly two directives

**Files:**
- Create: `src/web/fonts.ts`
- Modify: `src/web/server.ts` (CSP string → exported `CSP` constant; `GET /fonts/:file`), `app/protocol.ts` (`PAGE_CSP`; GET `/fonts/<file>`), `app/main.ts` (pass the font dir), tests that hard-code the old CSP string (`test/settings-web.test.ts`, `test/web-pages.test.ts`, `test/refresh-async.test.ts`, `test/support-bundle.test.ts`, `test/update-web.test.ts`, `test/calendar-web.test.ts`, `test/map-web.test.ts` — update to the new string or the exported constant)
- Test: create `test/fonts-web.test.ts`; extend `test/app/protocol.test.ts`

**Interfaces:**
- Consumes: `THEMES` (Task 6), `repoRoot()` (`src/core/version.ts`).
- Produces:
  ```ts
  // src/web/fonts.ts
  export const FONT_FILES: ReadonlySet<string>          // every ThemeFont.file of every theme
  export const fontDir = (): string                     // join(repoRoot(), 'assets', 'fonts')
  export const FONT_HEADERS: Record<string,string>      // content-type font/woff2, cache-control public, max-age=31536000, immutable
  export function readFont(dir: string, file: string): Buffer | undefined   // undefined unless FONT_FILES.has(file) and the read succeeds
  // server.ts
  export const CSP: string; WebDeps.fontDir?: string
  // protocol.ts
  FirstRunDeps.fontDir: string
  ```

- [ ] **Step 1: Failing tests:**
  - `GET /fonts/courier-prime-latin-400-normal.woff2` → 200, `content-type` `font/woff2`, `cache-control` `public, max-age=31536000, immutable`, body equals the file bytes.
  - 404 (and no file read outside the allowlist — use a temp `fontDir` holding a planted `secret.woff2` and `OFL.txt`) for: `/fonts/secret.woff2`, `/fonts/OFL.txt`, `/fonts/README.md`, `/fonts/..%2fconfig.json`, `/fonts/%2e%2e%2fpackage.json`, `/fonts/`.
  - an allowlisted name missing from `fontDir` → 404, not 500.
  - `content-security-policy` of `/` and of a font response is exactly the Global Constraints string.
  - protocol: GET `parcels://welcome/fonts/<allowlisted>` → 200 with the same two headers and `PAGE_CSP`; `parcels://welcome/fonts/OFL.txt`, `…/fonts/..%2f…` → 404; POST to a font path → 405; on a move-in first run, `parcels://move-in/fonts/<file>` → 200 and `parcels://welcome/fonts/<file>` → 404. `PAGE_CSP` equals the Global Constraints string.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement. The server route checks `FONT_FILES.has(req.params.file)` before touching the disk. `app/main.ts` passes `fontDir: join(app.getAppPath(), 'assets', 'fonts')`.
- [ ] **Step 4:** `command npx vitest run` (whole suite) PASS; both typechecks clean.
- [ ] **Step 5:** Commit — `feat: the server and the first-run pages serve the theme fonts, and the CSPs allow exactly fonts and the grain`.

### Task 8: Packaging carries the fonts

**Files:**
- Modify: `electron-builder.yml` (`files:` gains `assets/fonts/**`), `scripts/app/build-release.sh` (`check_app` runs the font check), `scripts/app/smoke.sh` (fetch one font)
- Create: `scripts/app/check-fonts.mjs` — `node scripts/app/check-fonts.mjs <Parcels.app>`: lists `Contents/Resources/app.asar` with `@electron/asar`'s `listPackage` and exits non-zero naming each `.woff2` of the repo's `assets/fonts/` that is missing (and if there are none to check).
- Test: `test/app/check-fonts.test.ts` (build a fake `Parcels.app/Contents/Resources/app.asar` in a temp dir with `@electron/asar` `createPackage`; one complete → exit 0 and prints `ok`; one missing a font → exit 1 naming it)

- [ ] **Step 1:** failing test → **Step 2:** FAIL → **Step 3:** implement; smoke addition: after the `/gmail-filter.xml` check, `curl` `/fonts/<first .woff2 in assets/fonts>`, require `200` and `content-type: font/woff2`, print `smoke: a theme font answered 200 from app.asar`.
- [ ] **Step 4:** `command npx vitest run test/app/check-fonts.test.ts` PASS; `bash test/app/release.test.sh` PASS; `bash -n scripts/app/smoke.sh scripts/app/build-release.sh`.
- [ ] **Step 5:** Commit — `build: the app bundles the theme fonts, and the release and smoke checks prove it`.

### Task 9: Settings chooses theme and mode

**Files:**
- Create: `src/web/views/appearance.ts` (`appearanceFields(v: SettingsValues): Html`)
- Modify: `src/web/settings.ts` (`SettingsForm`, `SettingsValues`, `settingsValues`, `submittedSettings`, `applySettings`, `changedSettingFields`), `src/db/activity-log.ts` (`SETTING_FIELDS` gains `'appearance.theme'`, `'appearance.mode'`), `src/web/views/settings.ts` (ONE inserted line: `${appearanceFields(v)}` after the Parcels `fields` block, before `<details class="adv"`, plus its import), wherever setting names are rendered in the activity log if there is a label map
- Test: `test/settings-web.test.ts`, `test/activity-log.test.ts` if it enumerates fields

**Interfaces:**
- Consumes: `THEME_IDS`, `MODES`, `DEFAULT_APPEARANCE` (Task 1), `THEMES` (names, order).
- Produces: `SettingsForm.theme?`, `SettingsForm.mode?`; `SettingsValues.theme: string`, `SettingsValues.mode: string`.

Markup (exact copy): `<h2>Appearance</h2><div class="fields"><label>Theme<select name="theme">` one option per `THEMES` entry (`value=id`, label `name`) `</select></label><label>Mode<select name="mode">` options `system` "Same as the Mac", `light` "Light", `dark` "Dark" `</select><span class="meta hint">Light or dark, or follow the Mac.</span></label></div>`.

- [ ] **Step 1: Failing tests:**
  - `GET /settings` shows the block with the stored values selected (and defaults `postal`/`system` when the file has none); the block appears in both app and git modes.
  - POST with `theme=classic&mode=dark` + the other valid fields → 303; the file now has `appearance: {theme:'classic',mode:'dark'}`; the next `GET /` has `data-theme="classic" data-mode="dark"` without a restart; the activity log entry lists `appearance.theme` and `appearance.mode`.
  - POST `theme=kraft` → 400 with `The theme must be one of Postal, Classic.`; `mode=auto` → 400 `The mode must be one of Same as the Mac, Light, Dark.`; nothing written.
  - Review Focus 3: POST without `theme`/`mode` on a file with `appearance:{theme:'classic',mode:'light'}` keeps them; on a file without `appearance`, a POST of `theme=postal&mode=system` and nothing else changed logs no `appearance.*` field.
  - other keys inside a stored `appearance` object survive a save.
- [ ] **Step 2:** FAIL → **Step 3:** implement (the field values compare as effective values) → **Step 4:** `command npx vitest run test/settings-web.test.ts test/activity-log.test.ts` PASS, both typechecks clean.
- [ ] **Step 5:** Commit — `feat: Settings has an Appearance block: theme and mode, saved and logged like the rest`.

### Task 10: README

**Files:** Modify `README.md`; `config.example.json` only if it lists every optional key (follow what it does for `notifier`).

- [ ] **Step 1:** Add a short "Appearance" section (or a subsection where Settings is described): the two themes (Postal default, Classic = the original look), the mode choice, the `appearance` config keys and defaults, that fonts are bundled and nothing loads from the internet, and the browser floor for Terminal installs: `light-dark()` needs Chromium 123+ or Safari 17.5+; older browsers show the page without colours. Mention `assets/fonts/README.md` for font sources and licences.
- [ ] **Step 2:** `grep -n "appearance\|Safari 17.5" README.md` shows the new text; commit — `docs: the README explains themes, modes, and the browser they need`.

### Task 11: Postal, looked at

**Output (not committed):** `.superpowers/sdd/2026-10-30-themes-phase-a/shots/postal/…png`

- [ ] **Step 1:** `SIM_THEME=postal scripts/dev/persona-sim/theme-shots.sh …/shots/postal` (both modes, 1280 and 390, all pages of §2).
- [ ] **Step 2:** Look at every shot (Read tool). Check: fonts actually rendered (serif titles, Courier codes — not fallbacks), text readable on grain, badges/status words visible, yellow only as a fill, dark mode not muddy, nothing overflowing at 390.
- [ ] **Step 3:** Fix what is ugly or unreadable — in `postal.ts` only (tokens or its `css`), never in base CSS (that would break Classic). Re-run the Classic diff (Task 4 Step 3–4) if anything outside `postal.ts` changed. Re-shoot, re-look.
- [ ] **Step 4:** Commit any fixes — `fix: Postal …` (specific).
