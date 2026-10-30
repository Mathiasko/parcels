# persona-sim: build report

Built by the test sub-agent on 2026-10-30, in `scripts/dev/persona-sim/` only. No existing file was
changed, nothing was built (`npm run build`, `tsc` emit, electron-builder: none), no git writes. The
simulator imports `src/` and `app/` live through vitest, so it always runs the code as it is in the
checkout.

## What was built

| File | What it is |
|---|---|
| `sim` | The command (bash wrapper: `$N/node sim.mjs`). |
| `sim.mjs` | CLI. `start` spawns the daemon detached under vitest and waits for it; every other command goes to the daemon's loopback control port (token in `state.json`). Several personas can run at once (`--as`). `stop` ends the daemon, kills the process group if it lingers, removes the temp dir (unless `--keep`) and the registry entry. |
| `daemon.run.ts` | The long-lived simulator, one vitest "test" that lasts until `sim stop` (own `vitest.config.ts`: forks pool, no cache, per-sim vite cache dir in the temp dir). Fake clock (`vi.useFakeTimers({ toFake: ['Date'] })`), temp world (config from `config.example.json` as `sim-config.json`, db, mailDir, support dir), the REAL Fastify server from `buildServer` in **app mode** (`PARCELS_HOST=app`, `app` deps: fake release check, fake staging, a main-process channel that records install/reveal) on a random loopback port (never 8787), fake calendar, recording notifier, fake carrier adapters, rolling IMAP fake (each connect sees the label as it is at that moment). Runs `runPoll` at every `POLL_SLOTS` slot from setup on, with `recordPollRun`/`recordPoll` like the poller. |
| `lib/guard.ts` | Network guard (fetch, http/https, tls, dns, `net.Socket.connect`: loopback only) and process guard (every `child_process` entry point throws), both recorded; `syncBuiltinESMExports` makes them reach ESM named imports too. Chrome and ImageMagick are run through the original `execFile`, captured before patching. |
| `lib/world.ts` | The reactive carrier world: each parcel's timeline as a function of time AND of the persona. A parcel at a pickup point stays there until `sim collect` (right code, opening hours, not on an away day); then the carrier reports it collected after a carrier-specific lag (Packeta minutes, Slovenská pošta next morning). Uncollected past its deadline it turns `returning`, then `returned`. Answers have the shape of the fake-mail harness's `world.ts` (prose-only carriers code only the newest event; GLS "ready" carries no pickup point). |
| `lib/gmail-filter.mjs` | Evaluates the repo's `gmail-filter.xml` query (Gmail rules: case/diacritics folded, whole words, phrases, `from:` by address/domain, AND/OR/parentheses). Gmail shows every mail; only what the filter matches gets `[label: parcels]` and reaches the app. |
| `lib/page-text.ts` | HTML → visible text (no head/style, `hidden`, `display:none`, `.vh` screen-reader text), then links and forms (action, method, every field with current value, buttons, `form=` buttons) with a ready-to-run `sim post` line per button. |
| `kit/dsl.mjs` | Scenario vocabulary on top of `scripts/dev/fake-mail/{mime,templates}.mjs`: Packeta (SK + a Czech Zásilkovna template), DPD door/station, GLS door/BOX/ParcelShop, SPS door/balíkovo, Slovenská pošta office/BalíkoBOX/door, DHL Express (email-only), AlzaBox (no carrier), an outgoing Packeta return, shop mail (SK, CZ, EN) and noise. Each helper writes the carrier timeline and its mails (including conditional reminders and mail that only exists after a pickup). |
| `generate.mjs` | Builds `scenarios/<p>/scenario.json`, `mails/*.eml` and an operator-only `OVERVIEW.md` (spoilers: every mail's purpose and label verdict, every parcel's code and deadline) from `scenarios/<p>.mjs`. Deterministic. |
| `scenarios/<p>.mjs` / `.md` | The 8 scenario definitions and the 8 persona sheets (brief + 7-8 jobs each, each tied to a day, each with a deadline job and a noise/false-positive job, and a day-0 setup job). |
| `README.md` | The operator guide FOR the persona agents. |
| `dry-run/` | Evidence from the zuzana dry run: the full transcript and three screenshots. |

Commands: `start`, `day [--until HH:MM]`, `status`, `text <page>`, `post <action> k=v…`, `shot <page>
[--width 1280|390] [--dark] [--out f]`, `mail [n]`, `collect <code|number>`, `stop [--keep]`, plus an
operator-only `selftest` (not in the persona README). Pages: any dashboard path; `app:first-run`
(`app:welcome` / `app:move-in`, served by the real `firstRunHandler` from `app/protocol.ts` with the real
templates in `app/pages/`, posting works and writes the postcode), `app:result` (the move-in failure page,
rendered with sample text and labelled as such); `readme` and `readme:<section>` (sections of the repo's
README, e.g. `readme:install-the-app`). Day 0 starts at 19:00; the first `sim day` completes setup at 20:30
(IMAP config filled in with the persona's address, first poll ingests the backlog that the filter's
"apply to existing" labels) and also lives day 1. A day ends at 22:00; the digest samples the menu-bar
count (`readyCount`, the tray's own query) at 08:00, 13:00 and 21:00.

## Dry run: zuzana, all 14 days

Full transcript: `dry-run/zuzana-transcript.txt`. What was checked, and how it came out:

| Check | Result |
|---|---|
| every command | `start` (≈2 s), `text` (first-run, README, /settings, /, /attention, /parcel/2, /health), `post` (welcome postcode, /settings with Gmail + App Password → "Saved. Connected", /settings/test, /parcel/10/collected, /refresh), `day` ×15 and `day --until` ×7, `collect` ×14 (one deliberately with a bare number at a Z-BOX: refused), `mail`, `mail 24`, `shot` ×3 (1280, 390, 1280 dark; plus 4 more in an earlier session incl. `app:first-run` at 390 and `/settings --dark`), `status`, `stop`: all worked. (`shot` and `mail 24` ran outside the logged transcript.) |
| digests | Correct against the scenario's timelines: backlog ingested at setup, readiness, deadlines ("collect by Tue 10 Nov" = ready day 2 + 7 days), picked-up mail after each `sim collect`, delivered courier parcels, Gmail labels as the filter decides. |
| notifications | 134 in the dry run's digests (109 in the later no-pickup run): Registered / In transit / Ready / Still waiting nudges at 08:00 and 15:30 / Delivered / Returning), each with time, title, body and click target. |
| `sim post` mark collected | Day 6: posta parcel collected at the counter 09:30, then `sim post /parcel/10/collected back=home` → 303 to `/?collected=10`, "Marked RB333333049CN as collected", **Menu-bar icon: 3 → 2**. |
| reactive world | Z-BOX codes open boxes, a bare number does not; counter hours enforced; COD stated; the 3-day BalíkoBOX parcel left uncollected went `Returning to sender` on day 13. |
| screenshots | `dry-run/zuzana-day6-dashboard-1280.png`, `…-390.png` (true 390 px frame, via the harness's saved-HTML iframe trick; images inlined), `…-1280-dark.png`. All rendered. |
| network | 0 attempts in every run. `sim selftest` shows fetch to tracking.packeta.com, `net.connect` to imap.gmail.com:993, `spawn osascript` and `execFile /bin/launchctl` all refused. Chrome runs with background networking off, a dead proxy for non-loopback and a resolver that resolves nothing but loopback. |
| osascript / processes | 0 attempts (calendar is the fake; notifier records). |
| `sim stop` | Daemon gone, no Chrome left, temp dir and registry removed, every time (checked after each of the ≈20 runs). |

Day 2 digest:

```
══ Day 2 · Tuesday 3 November 2026 ══
Menu-bar icon (parcels ready to collect): morning 08:00 → 0 · midday 13:00 → 2 · evening 21:00 → 2
Notifications (8):
  07:00  [Parcels] In transit — Temu
         Zásielka je na ceste.
         (clicking it opens /parcel/4)
  08:00  [Parcels] Registered — Temu
         Údaje o balíku boli zaregistrované
         (clicking it opens /parcel/5)
  10:00  [Parcels] Ready for pickup — SHEIN
         Z-BOX Fiktívna Bystrica, Lesná 4 (Billa), Fiktívna Bystrica · collect by Tue 10 Nov
         (clicking it opens /parcel/2)
  10:00  [Parcels] Ready for pickup — AliExpress (Cainiao)
         Z-BOX Fiktívna Bystrica, Lesná 4 (Billa), Fiktívna Bystrica · collect by Tue 10 Nov
         (clicking it opens /parcel/3)
  15:30  [Parcels] Still waiting for you · day 1 — SHEIN
         Z-BOX Fiktívna Bystrica, Lesná 4 (Billa), Fiktívna Bystrica · collect by Tue 10 Nov
         (clicking it opens /parcel/2)
  15:30  [Parcels] Still waiting for you · day 1 — AliExpress (Cainiao)
         Z-BOX Fiktívna Bystrica, Lesná 4 (Billa), Fiktívna Bystrica · collect by Tue 10 Nov
         (clicking it opens /parcel/3)
  19:00  [Parcels] In transit — Temu
         Balík je na ceste
         (clicking it opens /parcel/5)
  19:00  [Parcels] Registered — SHEIN
         Zásielka bola podaná odosielateľom.
         (clicking it opens /parcel/6)
New mail in Gmail (7):
  #12 07:15  Temu <orders@temu.example.com>   [label: parcels]
      📦 Zásielka zadarmo! Doprava zdarma na všetko
      Doprava zadarmo na všetky objednávky tento týždeň! Kupón: TEMU-FREE-SHIP Platí do nedele.
  #13 08:20  GLS Slovakia <noreply@gls-slovakia.sk>   [label: parcels]
      Balík 90333333305 sme prevzali od odosielateľa
      Váš balík sme prevzali od odosielateľa a je na ceste k vám. Predpokladaný dátum doručenia vám oznámime v ďalšom e-maile.…
  #14 08:54  Packeta Slovakia <noreply@packeta.sk>   [label: parcels]
      Zásielka je pripravená na vyzdvihnutie
      Zásielka Z 333 3333 301 Dobrý deň, vaša zásielka od odosielateľa AliExpress (Cainiao) je pre vás pripravená na vyzdvihnu…
  #15 09:39  Packeta Slovakia <noreply@packeta.sk>   [label: parcels]
      Zásielka je pripravená na vyzdvihnutie
      Zásielka Z 333 3333 302 Dobrý deň, vaša zásielka od odosielateľa SHEIN je pre vás pripravená na vyzdvihnutie v Z-BOXe. K…
  #16 11:00  SHEIN <noreply@shein.example.com>   [label: parcels]
      Your SHEIN order GSH33000006 has been shipped!
      Hi ZUZANA, Good news! Your order GSH33000006 has been shipped. Carrier: Packeta Tracking number: Z3333333306 Estimated d…
  #17 18:40  Packeta <info@packeta-sk.example.com>   [label: parcels]
      Vaša zásielka čaká – uhraďte poplatok 1,99 €
      Dobrý deň, vaša zásielka Z 333 3333 399 čaká v depe. Pre doručenie uhraďte poplatok 1,99 € na https://packeta-sk.example…
  #18 19:08  Packeta Slovakia <noreply@packeta.sk>   [label: parcels]
      Zásielka bola prijatá do prepravy
      Zásielka Z 333 3333 306 Dobrý deň, odosielateľ SHEIN nám práve odovzdal vašu zásielku, ktorá vám bude doručená do Z-BOXu…
```

Day 4 at 07:40 by the Z-BOX, and what the rest of the day then showed:

```
$ sim collect 530912
07:40  Z-BOX Fiktívna Bystrica, Lesná 4 (Billa): you enter 530912, a compartment opens - parcel collected.

$ sim collect Z3333333301
07:40  Z-BOX Fiktívna Bystrica, Lesná 4 (Billa): the box asks for the opening code; the parcel number alone does not open it.

$ sim collect 204417
07:40  Z-BOX Fiktívna Bystrica, Lesná 4 (Billa): you enter 204417, a compartment opens - parcel collected.

$ sim collect 118274
07:40  Z-BOX Fiktívna Bystrica, Lesná 4 (Billa): you enter 118274, a compartment opens - parcel collected.

$ sim day
══ Day 4 · Thursday 5 November 2026 ══
Menu-bar icon (parcels ready to collect): morning 08:00 → 1 · midday 13:00 → 1 · evening 21:00 → 1
Notifications (7):
  08:00  [Parcels] Still waiting for you · day 2 — AliExpress (Cainiao)
         Z-BOX Fiktívna Bystrica, Námestie SNP 1 (OC Centrum), Fiktívna Bystrica · collect by Wed 11 Nov
         (clicking it opens /parcel/1)
  08:00  [Parcels] Delivered — SHEIN
         Zásielka bola vyzdvihnutá.
         (clicking it opens /parcel/2)
  08:00  [Parcels] Delivered — AliExpress (Cainiao)
         Zásielka bola vyzdvihnutá.
         (clicking it opens /parcel/3)
  08:00  [Parcels] Delivered — Temu
         Zásielka bola vyzdvihnutá.
         (clicking it opens /parcel/4)
  15:30  [Parcels] Still waiting for you · day 2 — AliExpress (Cainiao)
         Z-BOX Fiktívna Bystrica, Námestie SNP 1 (OC Centrum), Fiktívna Bystrica · collect by Wed 11 Nov
         (clicking it opens /parcel/1)
  16:00  [Parcels] Registered — Móda Fiktívna
         Zásielka bola podaná odosielateľom.
         (clicking it opens /parcel/8)
  20:00  [Parcels] Registered — Temu
         Zásielka bola podaná odosielateľom.
         (clicking it opens /parcel/7)
```

Day 13 (the uncollected BalíkoBOX parcel goes back; nudges for what still waits):

```
══ Day 13 · Saturday 14 November 2026 ══
Menu-bar icon (parcels ready to collect): morning 08:00 → 3 · midday 13:00 → 4 · evening 21:00 → 4
Notifications (12):
  07:00  [Parcels] Returning to sender — EB333333168SK
         Vrátenie zásielky odosielateľovi
         (clicking it opens /parcel/18)
  07:00  [Parcels] In transit — SHEIN
         Zásielka je na ceste.
         (clicking it opens /parcel/23)
  08:00  [Parcels] Still waiting for you · day 2 — Temu
         Z-BOX Fiktívna Bystrica, Lesná 4 (Billa), Fiktívna Bystrica · collect by Fri 20 Nov
         (clicking it opens /parcel/15)
  08:00  [Parcels] Still waiting for you · day 3 — AliExpress (Cainiao)
         Z-BOX Fiktívna Bystrica, Lesná 4 (Billa), Fiktívna Bystrica · collect by Thu 19 Nov
         (clicking it opens /parcel/19)
  08:00  [Parcels] Still waiting for you · day 2 — SHEIN
         Z-BOX Fiktívna Bystrica, Lesná 4 (Billa), Fiktívna Bystrica · collect by Fri 20 Nov
         (clicking it opens /parcel/20)
  09:00  [Parcels] Ready for pickup — SHEIN
         Z-BOX Fiktívna Bystrica, Lesná 4 (Billa), Fiktívna Bystrica · collect by Sat 21 Nov
         (clicking it opens /parcel/21)
  15:00  [Parcels] Registered — AliExpress (Cainiao)
         Zásielka bola podaná odosielateľom.
         (clicking it opens /parcel/24)
  15:30  [Parcels] Still waiting for you · day 2 — Temu
         Z-BOX Fiktívna Bystrica, Lesná 4 (Billa), Fiktívna Bystrica · collect by Fri 20 Nov
         (clicking it opens /parcel/15)
  15:30  [Parcels] Still waiting for you · day 3 — AliExpress (Cainiao)
         Z-BOX Fiktívna Bystrica, Lesná 4 (Billa), Fiktívna Bystrica · collect by Thu 19 Nov
         (clicking it opens /parcel/19)
  15:30  [Parcels] Still waiting for you · day 2 — SHEIN
         Z-BOX Fiktívna Bystrica, Lesná 4 (Billa), Fiktívna Bystrica · collect by Fri 20 Nov
         (clicking it opens /parcel/20)
  15:30  [Parcels] Still waiting for you · day 1 — SHEIN
         Z-BOX Fiktívna Bystrica, Lesná 4 (Billa), Fiktívna Bystrica · collect by Sat 21 Nov
         (clicking it opens /parcel/21)
  18:00  [Parcels] Registered — Temu
         Zásielka bola podaná odosielateľom.
         (clicking it opens /parcel/22)
```

Marking the post-office parcel collected (day 6):

```
$ sim post /parcel/10/collected back=home
→ HTTP 303, the browser goes to /?collected=10

PAGE /?collected=10  (HTTP 200)

[Parcels → /] [In flight → /] [History → /history] [Attention → /attention] [Health → /health] [Settings → /settings] [Add parcel → /add]
# In flight
{form 1} [button: Refresh now]
6 in flight, 2 ready for pickup and 1 out for delivery.
Marked RB333333049CN as collected. It is in [History → /history] .
{form 2} [button: Undo]
```

Also exercised outside zuzana: power's move-in page and `sim post app:move-in action=move`; lucia adding
her flatmate's parcel through `/add` and collecting it by number at the counter; petra's AlzaBox code;
martin's customer return by number; tomas's full update path (release v0.2.0 appears day 6 → Health
offers it → Update now → "ready" → Restart → the server restarts as 0.2.0 → "Updated to 0.2.0 · up to date").

## The other seven: 14 days each, days only

All eight were run `start` + 15 × `day` + `status` + `stop`, four at a time in parallel: 0 simulator
errors, 0 network attempts, 0 processes, clean stop. Notifications seen over 14 days without any pickups:
jan 25, tomas 42, lucia 57, power 89, eva 102, petra 105, zuzana 109, martin 131 (nobody collected in
these runs, so the twice-daily nudges pile up).

Each job on each sheet was checked against the scenario's timeline: the day it names has the event, the
deadline it asks about falls where the sheet implies (eva's SPS parcel can only be collected on day 9,
the GLS one by day 9, the thermos expires while she is away; jan's book waits until Fri 13 Nov 18:00;
petra's BalíkoBOX parcel 3 days; martin's first return by day 10; lucia's textbook by day 11; tomas's SSD by
day 16), and the information exists somewhere the persona can see it (digest, mail, a page).

## Scenario sizes

| persona | carrier parcels | at a pickup point | mails | labelled (reach the app) | inbox only | only after a pickup | conditional | noise / false-positive mails |
|---|---|---|---|---|---|---|---|---|
| zuzana | 24 (+1 AliExpress LP never reaching a carrier) | 21 | 112 | 104 | 8 | 19 | 16 | 33 |
| jan | 2 | 1 | 11 | 7 | 4 | 0 | 1 | 3 |
| petra | 13 (12 in, 1 return out) | 9 | 51 | 43 | 8 | 8 | 6 | 12 |
| martin | 22 (15 supplier, 3 returns, 4 outgoing) | 4 | 79 | 65 | 14 | 4 | 4 | 14 |
| lucia | 5 (+1 PPL, no supported carrier) | 4 | 30 | 8 | 22 | 4 | 4 | 5 |
| tomas | 5 | 2 | 21 | 19 | 2 | 2 | 2 | 5 |
| eva | 8 | 6 | 40 | 36 | 4 | 5 | 6 | 6 |
| power | 10 | 5 | 36 | 35 | 1 | 4 | 5 | 6 |

"Only after a pickup" mails exist only if the persona collects; "conditional" ones (reminders, returns)
only if they have not. All numbers are synthetic but parse (Packeta `Z<digit×8>NN`, DPD `01505…`, GLS
`90…`, SPS `SK0FAKE26<TAG>…` and `703…`, posta S10 with correct check digits incl. one `…CN`, DHL `JJD000…`);
every person is invented; non-carriers use example.* domains.

## Things the dry runs already show (for the operator, not the personas)

- The Gmail filter labels **no** Czech Zásilkovna mail (`zasilkovna.cz` is not in its `from:` list and
  Czech words such as *zásilka*, *vyzvednutí* are not in its subject list). lucia's app sees only shop mail
  that happens to say *odeslána*, *balík* or *balíček*; her flatmate's parcel never reaches it.
- martin: copies of his own shop's dispatch mails make his customers' parcels his ("Ready for pickup —
  Bicykle Fiktív – e-shop", with no pickup place); DPD's invoice from `dpd.sk` lands on /attention.
- petra's outgoing return is tracked like an incoming parcel and ends as "Delivered".
- Notification volume: the 08:00 / 15:30 nudges repeat for every waiting parcel (zuzana's day 13: 12
  banners).
- A Slovenská pošta parcel with a foreign number is titled by its number (`RB333333049CN`).

## Known limitations

- The Mac is always awake: every slot runs (no sleep, no missed-slot catch-up, no launch-at-login).
- Only Date is faked: Node timers run in real time, so nothing that waits on a real timer (debounces,
  timeouts) is simulated.
- "Setup done" is a switch, not a simulation: the App Password, the filter import, "Show in IMAP" and
  "Apply to existing" are assumed right. The filter cannot be edited, so a persona who would add a shop's
  domain cannot test that.
- No phone: notifications are the Mac's; the dashboard is reached only through `sim text`/`sim shot`.
  External links (Gmail settings, Apple Maps, GitHub) cannot be opened.
- The carrier world is scripted per scenario; the persona's pickups are the only reactive part. Courier
  deliveries happen when the script says (eva's away days are scripted as failed attempts), and an
  unknown number is simply "not found".
- Map tiles: no geocoding or tile fetches (no network), so pages show no map image.
- `Add to Calendar` goes to the fake calendar (always succeeds, writes nothing). "Show in Finder" and the
  app's restart are narrated, not performed. The update "download" is a fake staging that always succeeds.
- `sim text` is a text rendering; CSS-only effects other than the common hidden classes are not applied
  (both widths are available as screenshots).
- The zuzana transcript in `dry-run/` predates two later fixes: links inside headings (each dashboard
  card's name → `/parcel/N`) now appear in `sim text`, and the "Technical details" JSON on a parcel page
  now looks like a carrier reply instead of `{"fake":true,…}`. The `To:` header of generated mail is now
  RFC 2047-encoded (it showed `Fikt�vna` in that transcript).
- The persona agents run vitest from `node_modules` and use Chrome; if another agent's half-finished
  edit breaks `src/`, `sim start` fails with the error in `<dir>/daemon.log` (printed by `start`).
