# Themes, and the Postal look

Date: 2026-10-30. Approved in chat the same day.

The visual source is the mood board `.superpowers/design/moodboards/1-postal-ephemera.html` in the
`parcels-mac-app` worktree (screenshots beside it). The current rules are in `docs/design-language.md`.

## Goal

1. Make the look swappable. A theme is one file; pages never change for a theme.
2. Ship two themes:
   - **Postal**, the new default for everyone;
   - **Classic**, today's look extracted unchanged.
3. Give the app soul. Postal brings fonts, cream paper with grain, a perforated stamp for the pickup
   code, a postmark when you mark a parcel collected, an airmail stripe on "out for delivery", and a
   small amount of motion.

## Rules kept from the design language

- **Every status has a word, a glyph shape and a colour.** Colour is never the only difference.
- **"Waiting on you" is scarce.** In Postal it is yellow, used as a fill only, never as text.
- **Light and dark both exist,** and dark is never `#000`.
- **No JavaScript in pages.** All motion is CSS.
- **Contrast:** ≥ 4.5:1 for text, ≥ 3:1 for glyphs and control borders.
- **Motion** lives inside `@media (prefers-reduced-motion: no-preference)`.

## 1. Theme engine

### 1.1 The token contract

The base stylesheet (today's `src/web/views/style.ts`, split up) uses only custom properties. Every
theme must define every one of these, in light **and** dark:

| Group | Tokens |
|---|---|
| Surfaces | `--paper`, `--surface`, `--hover`, `--rule`, `--rule-s`, `--edge` |
| Ink | `--ink`, `--ink-2`, `--ink-3` |
| Signal | `--signal` (fill), `--signal-ink` (text and glyph), `--on-signal`, `--signal-wash` |
| Warn | `--warn`, `--on-warn`, `--warn-wash` |
| Ok | `--ok`, `--ok-wash` |
| Controls | `--btn-hover` |

**`--signal-ink` is new.** Wherever the base CSS colours *text or a glyph* with the signal today
(`.t-signal`, "Collect by", links in the pickup header), it uses `--signal-ink`. Fills use `--signal`.
Classic sets `--signal-ink` equal to `--signal`, so nothing in Classic changes.

These tokens are not colours, so a theme sets each once, not per mode:
- `--font-display`, `--font-body`, `--font-mono`;
- `--radius-card`, `--radius-badge`, `--radius-btn`;
- `--shadow-card`;
- `--texture`, a `background-image` value or `none`.

### 1.2 What a theme file is

`src/web/themes/<id>.ts` exports a `Theme`:

```ts
interface Theme {
  id: 'postal' | 'classic'            // a union that grows with each theme
  name: string                        // shown in Settings
  colors: Record<ColorToken, { light: string; dark: string }>
  tokens: Record<ShapeToken, string>  // fonts, radii, shadow, texture
  fonts: FontFace[]                   // files under assets/fonts/, see 1.5
  css?: string                        // the theme's ornaments and motion, scoped to [data-theme="<id>"]
}
```

`src/web/themes/index.ts` holds the registry, `DEFAULT_THEME = 'postal'`, and
`themeCss(theme)`. That function emits:
- `:root[data-theme="<id>"]{--paper:light-dark(<light>,<dark>);…}`;
- the shape tokens;
- the `@font-face` rules;
- the theme's own CSS.

The page stylesheet is the base CSS followed by every registered theme's CSS. That costs a few KB
per extra theme, and it means switching themes needs no other change to the page.

### 1.3 Mode

- **Colours** use CSS `light-dark()`.
- **The mode** is `color-scheme`, set from the `data-mode` attribute on `<html>`:
  - `system` → `light dark`, which is today's behaviour;
  - `light` → `light`;
  - `dark` → `dark`.
- **Browsers:** `light-dark()` needs Chromium 123 or later (Electron 45 is fine) or Safari 17.5 or later. The README notes this for Terminal-install users who open the dashboard in an older browser.

### 1.4 Choosing a theme

- **Config** gains two optional keys, validated like `notifier`:
  - `"appearance": { "theme": "postal" | "classic", "mode": "system" | "light" | "dark" }`;
  - defaults are `postal` and `system`;
  - an unknown theme id is rejected with a clear message.
- **Settings** gets an **Appearance** block with two selects, Theme and Mode, saved with the form, and logged in the activity log like the other settings.
- **Layout** (`layout.ts`) renders `<html lang="en" data-theme="…" data-mode="…">`.
- **The app's own pages** (`app/pages/welcome.html`, `move-in.html`, `result.html`, filled by `app/protocol.ts`) use the same stylesheet and the same attributes, so they follow the theme too.

### 1.5 Fonts, offline

- **Postal's fonts** are DM Serif Display (400, 400 italic), Libre Franklin (variable, 400–800) and
  Courier Prime (400, 700).
- **Files:** latin and latin-ext `.woff2` subsets, committed under `assets/fonts/` with each family's
  `OFL.txt`. They come from the families' official or fontsource releases; record the source and
  version in `assets/fonts/README.md`.
- **The dashboard server** serves them at `GET /fonts/<file>.woff2` from a fixed allowlist, with
  `Cache-Control: public, max-age=31536000, immutable` and `Content-Type: font/woff2`. Any other name is a 404.
- **The app protocol** (`app/protocol.ts`) serves the same files at `parcels://welcome/fonts/<file>`, or
  whatever origin those pages use.
- **CSP:**
  - server: add `font-src 'self'` and `img-src 'self' data:`, because the grain is an inline SVG `data:` URL;
  - `PAGE_CSP`: add `font-src parcels:` and `img-src data:`;
  - nothing else is loosened.
- **Packaging:** `electron-builder.yml` includes `assets/fonts/**`, and the build-release checks
  assert the fonts are inside the packaged app.
- **Classic** keeps the system font stack and loads no fonts.

## 2. Classic: today's look, unchanged

- **What moves:** today's `STYLE` becomes the base CSS plus a Classic theme holding today's token values.
- **The bar:** with `theme: "classic"`, every page renders **pixel-identical** to `main`.
- **How it is proved:** screenshot `/`, `/history`, `/attention`, `/health`, `/settings`, `/add`, a
  parcel page, and the welcome page. Do it at 1280 and 390 px, light and dark, before and after, and
  diff them, for example with ImageMagick `compare -metric AE`. Any non-zero diff is explained or fixed.

## 3. Postal

### 3.1 Tokens (from the board)

| Token | Light | Dark |
|---|---|---|
| paper | `#f3ead7` | `#211c18` |
| surface | `#fbf6ea` | `#2c2620` |
| ink | `#1d2433` | `#f1e8d6` |
| ink-2 | `#5a4f3f` | `#c3b6a0` |
| signal (fill) | `#f6c21c` | `#f7c948` |
| signal-ink | `#7a5600` | `#f7c948` |
| on-signal | `#1d2433` | `#241a00` |
| warn | `#b3261e` | `#ff8a7a` |
| on-warn | `#fbf6ea` | `#2a0d08` |
| ok | `#23468c` | `#9db8ff` |

The remaining tokens (`hover`, `rule`, `rule-s`, `edge`, `ink-3` and the washes) are derived to fit
and must pass the contrast test (§5).

**Type:**
- display: DM Serif Display, for page titles, place names on cards, and the empty state;
- body: Libre Franklin;
- mono: Courier Prime, for codes, PINs, tracking numbers and postmark dates.

**Shape and texture:**
- card radius 6px, badge radius 3px;
- a warm, layered card shadow;
- `--texture` is the board's inline SVG fractal-noise grain, on the page background only.

### 3.2 Ornaments: neutral hooks in the markup, styled by the theme

Phase B adds these hooks to the views. Each is meaningful markup or `aria-hidden` decoration, and
Classic either ignores it or renders it as today:

| Hook | Markup | Postal renders it as |
|---|---|---|
| Code plate | the existing pickup-code line gets `class="code-plate"` with `data-kind="box|counter|plain"` | a perforated yellow stamp (CSS mask), rotated about 2°, with the label above and "Z-BOX · Packeta" below |
| Status badge | existing `.b` / `.st` with `data-status="<canonical>"` | the board's badge set: a stamp edge on ready, chevrons on out for delivery, a voided ring on failed, an envelope in transit, a postmark ring on delivered |
| Glyphs | the sprite gets the Postal glyph shapes as alternate `<symbol>`s; the theme picks them with CSS | stamp, chevrons, voided ring, envelope, postmark |
| Postmark slot | `<span class="orn-postmark" aria-hidden="true">` on a collected parcel's card and page, holding the collect date and time | a rough-inked blue postmark over the stamp |
| Airmail edge | `data-status="out_for_delivery"` on the card | a red/blue chevron top border |
| One-shot markers | the server adds `just-collected` or `just-arrived` to one card, from the existing post-redirect notice, for one render only | the motion below |
| Failed edge | `data-status="failed_attempt"` | a hatched red left edge and a rubber stamp of the carrier's reason word |

### 3.3 Motion (Postal only, CSS only, reduced-motion respected)

1. **Postmark slam** on `just-collected`: about 550 ms, the board's `slam` keyframes, and the card dips 3px.
2. **Cards deal in** on page load: a stagger of index × 60 ms, at most 6 cards, once per load.
3. **Ink settles** on the code: a 0.5 s blur-to-sharp, the first time a code appears (`just-arrived`).
4. **Airmail stripe marches** three times on an out-for-delivery card, then stops.
5. **Hover lift** on cards: translate −3px and rotate −0.8°.
6. **Button press:** 1px down.

### 3.4 Icons

- **App icon:** the board's stamp icon, a blue tile holding a perforated cream stamp with a parcel
  and a postmark. It becomes `build/icon.icns` through the existing electron-builder icon path.
  Render it at every macOS size and check it at 16, 32 and 1024 px.
- **Menu-bar icon:** a monochrome template stamp silhouette with a dashed perforation edge,
  `trayTemplate.png` and `@2x`, that still reads at 16px. The count stays text beside it, as today.
- Neither icon changes with the theme.

## 4. Phases

- **Phase A**, on branch `themes` off `main`, now:
  - the engine (1.1–1.4) and font serving with the CSP change (1.5);
  - Classic extracted and proved identical (2);
  - Postal tokens, fonts and texture (3.1), so Postal is already usable with today's markup;
  - the Settings Appearance block;
  - the README.
- **Phase B**, on branch `themes-postal`, after `persona-followups` is complete:
  - start from a merge of `persona-followups` and `themes`;
  - the ornament hooks (3.2), the motion (3.3) and the icons (3.4);
  - the design-language update.

## 5. Tests and checks

- **Contract:** every registered theme defines every colour token in light and dark, and every shape
  token. A missing one fails with the theme and token named.
- **Contrast:** for every theme and mode, compute WCAG contrast for each pair below. Shared fixture
  code is fine.

  | Minimum | Pairs |
  |---|---|
  | 4.5:1 | ink, ink-2 and ink-3 on paper, surface and hover; signal-ink on paper and surface; on-signal on signal; on-warn on warn; warn on surface; ok on surface |
  | 3:1 | edge on paper and surface |

  A failure names the pair and the ratio.
- **Config:** appearance defaults, valid values, rejected values.
- **Pages:**
  - `<html>` carries `data-theme` and `data-mode` from the config;
  - Settings shows and saves the Appearance block;
  - the font route serves allowlisted files with the right headers and 404s others;
  - the CSP headers have exactly the new directives.
- **Classic identical:** the screenshot diff in §2 (Phase A).
- **Visual:** screenshots of every page listed in §2, in Postal, both modes, at 1280 and 390, viewed
  and fixed by eye. In Phase B also the collected and out-for-delivery cards, and the motion with
  reduced motion off.
- **Existing:**
  - the full suite;
  - both typechecks;
  - the shell suites;
  - the fake-mail harness;
  - `npm run app:smoke`, which must still pass with fonts loading through the protocol.

## Out of scope

- a Slovak or Czech interface;
- the Kraft and Locker-night themes (easy later);
- styling macOS notification banners, which is not possible;
- a theme per page or per user;
- user-made themes.
