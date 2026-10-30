# Theme showcase

Screenshots of every card state, for looking at a theme by eye and for diffing two commits pixel by pixel.
There are also frozen frames of each motion. It is a dev tool. It has its own vitest config, so the
repo's suite never runs it.

```bash
export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH
THEME=postal OUT=/tmp/showcase command npx vitest run --config scripts/dev/theme-showcase/vitest.config.ts
```

| Variable | Meaning |
|---|---|
| `THEME` | `postal` or `classic`, written to the config's `appearance` (mode `system`). If unset, the config has no `appearance` block, as on a commit from before themes; the page then wears the default theme. |
| `OUT` | Required. The output folder. Shots are written as `<scene>-<1280\|390>[-dark].png`, with `scenes.txt` beside them. |
| `FRAMES=1` | Also write motion frames to `<OUT>/motion/` (see below). |
| `SCENES=a,b` | Render only these scenes. |
| `KEEP=1` | Keep the work folder (`$TMPDIR/parcels-theme-showcase`), which holds the saved HTML of every scene and frame. |

Only one showcase runs at a time, because the work folder has a fixed name. That way no temp path differs
between two runs (the settings page shows the database path). A full run takes about 30 s.

## What it does

- **Seeds** throw-away databases through the real db helpers: parcels, events, pickup codes, poll runs, the
  activity log, and `markCollected`. The clock is fixed at Friday 6 November 2026, 14:15 in Bratislava,
  and `Date` is faked. Numbers, shops and places are all made up. The mail account is
  `parcels@example.invalid`.
- **Renders** each page with the real `buildServer`, using a fake calendar, a silent notifier and a dead
  `HttpClient`. Pages are fetched with `inject`, so no socket is ever opened. persona-sim's guards block
  every network API and every child process; only Chrome and ImageMagick run, through the guard's saved
  `execFile`.
- **Shoots** a saved copy of each page, with its fonts and images inlined, in headless Chrome. Chrome gets
  its own profile, a dead proxy and no resolver. Each page is shot at 1280 and 390 px, light and dark,
  with `--force-prefers-reduced-motion`. The 390 shot goes through a 390 px iframe.
- **Crops** each shot to the page's real height. The saved copy gets a 4 px magenta `html::after`, which
  sits after everything else on the page, and the shot is cut at the marker's first row. Auto-trim can't
  do this: the Postal grain has no flat colour to trim.
- **Checks** each scene:
  - the page answers 200 and contains what makes the scene that state (for example, eight cards);
  - on a build with themes (`<html data-theme>`), the Phase B hooks the scene exists to show are present;
  - no shot is blank (ImageMagick standard deviation > 0.01).

## Scenes

| Scene | URL | What it shows |
|---|---|---|
| `dash` | `/` | Eight cards: ready Z-BOX + code, ready locker + code, ready ParcelShop + PIN, ready post office + PIN (due tomorrow), ready with no pickup kind + PIN, out for delivery, failed attempt ("Adresát nezastihnutý"), in transit |
| `dash-empty` | `/` | Nothing in flight |
| `dash-collected-notice` | `/?collected=<id>` | The "Marked … as collected" notice for a mark 10 minutes old (`just-collected` with a postmark), above the eight cards |
| `dash-arrived` | `/?run=<id>` | A run that finished 2 minutes ago and moved the Z-BOX parcel to ready: its card is `just-arrived` |
| `parcel-box` | `/parcel/<zbox>` | Box code plate |
| `parcel-counter` | `/parcel/<parcelshop>` | Counter PIN plate |
| `parcel-collected` | `/parcel/<id>?collected=1` | Collected at 14:05, so the postmark reads `6·XI·26` / `14:05`, with `just-collected` |
| `parcel-failed` | `/parcel/<failed>` | Failed attempt |
| `settings` | `/settings` | Settings, with the Appearance block |
| `refreshing` | `/?run=<running>` | Frames only: a running refresh, with the spinner |

## Motion frames (`FRAMES=1`)

Each motion is written as `<OUT>/motion/<motion>-<0|50|100>.png`, at 1280 px, light, with motion
allowed. `motion/frames.txt` lists how many pixels differ between the frames. The run fails if a
motion's middle frame matches both of its ends.

How a frame is frozen. The saved page gets one extra rule:

```css
*,*::before,*::after {
  transition: none !important;
  animation-duration: 1000s !important;
  animation-delay: <-pct × 10>s !important;
  animation-iteration-count: 1 !important;
  animation-fill-mode: both !important;
  animation-play-state: paused !important;
}
```

Every animation is held at the same point. A fixed duration turns a percentage into a delay without
knowing the motion's real duration, and the authored easing still applies.

- **Keyframe motions** (`keyframes: [...]`): only the named `@keyframes` stay in the page's CSS. Every
  other animation loses its keyframes and shows its static rules, which give the end state. Two limits:
  - a stagger such as deal-in's `nth-child` delays is not shown, because every card is at the same point;
  - an infinite animation runs once.
- **State motions** (hover and press): every `:hover` or `:active` rule whose selector matches `rule` is
  copied with the pseudo-class replaced by the class `frz-on`. `target` puts that class on one element:
  the first card for hover, and the first card's "Mark as collected" button for press. The copied rule's
  declarations become a `@keyframes frz-sN { to { … } }`, which runs from the element's own resting
  style. So 0 % is at rest, 100 % is the full hover or press state, and 50 % is the linear midpoint.

The motions are listed in `MOTIONS` in `showcase.run.ts`:

| Motion | Scene | Kind |
|---|---|---|
| `slam` (postmark slam and card dip) | `parcel-collected` | `@keyframes slam`, `thud` |
| `deal-in` | `dash` | `@keyframes deal` |
| `ink-settle` | `dash-arrived` | `@keyframes inkin` |
| `airmail-march` | `dash` | `@keyframes march` |
| `hover-lift` | `dash` | `.card:hover` rules, on the first card |
| `button-press` | `dash` | `button…:active` rules, on the first "Mark as collected" |
| `proof-spin` | `refreshing` | `@keyframes spin`: the refresh spinner every theme has |
| `proof-button-hover` | `dash` | the base `button:hover` rule |

If a theme has no keyframes or rules for a motion, that motion is skipped and the skip is recorded in
`frames.txt`. Before Task 6, Classic and Postal skip the six Postal motions and show only the two
proofs.

### For Task 6

Once `POSTAL_MOTION` exists, run:

```bash
THEME=postal OUT=.superpowers/sdd/2026-10-30-themes-phase-b/shots/postal-motion FRAMES=1 \
  command npx vitest run --config scripts/dev/theme-showcase/vitest.config.ts
cat .superpowers/sdd/2026-10-30-themes-phase-b/shots/postal-motion/motion/frames.txt
```

None of the six may say `skipped`. If one does, check that its `@keyframes` names match the board's
(`slam`, `thud`, `deal`, `inkin`, `march`); if Task 6 renamed them, change `MOTIONS`. Then look at the
frames.

## Comparing two commits

- Run the showcase on both commits into two folders. On an older commit, copy this folder into a
  temporary worktree that has a `node_modules` symlink.
- Diff each pair, for example with
  `magick compare -metric AE a.png b.png null:`. The count of differing pixels is
  `magick a.png b.png -compose difference -composite -colorspace gray -threshold 0 -format '%[fx:round(mean*w*h)]' info:`.
- A commit from before themes has no `data-theme`, so its hook checks are skipped. `scenes.txt` says so.
