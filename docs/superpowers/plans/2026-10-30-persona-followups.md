# Persona follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pickup PINs for every carrier, quieter notifications with three switches, plainer setup copy, and Czech mail (Zásilkovna in the filter, PPL as a polled carrier).

**Architecture:** Each part extends an existing seam: `extractPickupCode` gains a list of labelled patterns; `buildNotifications` gains a `prefs` argument read from a new `notifications` config block; the settings view and its form model gain one block each; PPL is one more `CarrierAdapter` plus the same sender/name rules GLS already uses for bare digits.

**Tech Stack:** Node 24, TypeScript 7, vitest 5, better-sqlite3, fastify, luxon, mailparser.

**Spec:** `docs/superpowers/specs/2026-10-30-persona-followups-design.md` (read it with this plan).

## Global Constraints

- Node: `export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH` before every command.
- Work only in `/Users/matuslaco/Desktop/parcels-mac-app` on branch `persona-followups`.
- Never read, print or modify `config.json`, `data/`, `~/Library/Application Support/Parcels`, `/Users/matuslaco/Desktop/parcels`, `/Applications/Parcels.app`. Never use port 8787. Tests that write config use a temp path.
- No test touches the network, `~/Library`, `launchctl`, `osascript`, `codesign` or `open`.
- `git add` by file name only (never `-A`, `.`, `commit -a`); never `git stash`; no merge/push/tag/release. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Don't touch `.superpowers/design/`.
- UI copy is English, follows `docs/design-language.md`. Code style: long "why" doc comments as in the surrounding files.
- Migrations are appended to `MIGRATIONS` in `src/db/migrate.ts`; never edit a shipped one.
- Fixture mails use fake numbers and `example` domains only (`*.example.sk`, `*.example.cz`, `example.com`), except the carrier's own sender domain (`ppl.cz`, `zasilkovna.cz`).
- Known pre-existing failure, ignore: `test/web-core.test.ts`. `app-update › a server that stops sending fails at the time limit` may time out under load; re-run alone.

## Rulings (decided here; copy into the ledger)

- Ruling R1: `.gitattributes` already covers `test/fixtures/fake-mail/*.eml` and `test/fixtures/mail/*.eml` by glob, so new fixtures there need no new line. A new fixture directory would need one.
- Ruling R2: "PPL named within the same sentence as the labelled number" means: `PPL` (as a token) occurs in the text between the number and the nearest preceding blank line, looking back at most 160 characters, or on the number's own line after it. That accepts `Prepravca: PPL\nČíslo zásielky: 40888888801` and refuses a footer "PPL" paragraphs away.
- Ruling R3: from a `ppl.cz` sender the number is chosen like GLS's (`glsNumber` ranking: labelled first, phone-looking last), restricted to 11 standalone digits.
- Ruling R4: PPL status uses the spec's table, exact codes only. No "base before the dot" fallback: it would turn `Delivered.BackToSender` into `delivered`. Anything unlisted is `unknown`.
- Ruling R5: PPL failures: 401/403 or a body that is not a JSON object (HTML, garbage) → `gated` (the endpoint or key changed: an app update is needed, as GLS treats HTML); 400 with `detail: "service.TrackAndTrace.ShipmentNotFound"` → `not_found`; any other non-200 → `transport`. Naive (zone-less) ISO dates are Europe/Prague wall clock (`parseNaive`); numbers are ms epoch; ISO with offset is taken as is.
- Ruling R6: the settings form sends a hidden `notificationsForm=1` with the three checkboxes. Without that marker (an old cached page, a crafted POST) the stored `notifications` block is kept untouched. With it, an unticked box is `false`. The block is always written whole, all three keys.
- Ruling R7: `changedSettingFields` reports `notifications.progress`, `notifications.dailyReminder`, `notifications.delivered` by effective value (absent = default), and `filterVersion` by effective value (absent = 1).
- Ruling R8: the 15:30 poll slot in `POLL_SLOTS` stays (it matches the launchd template, and a deadline warning still benefits from it); only its comment changes.
- Ruling R9: the notice's `<version>` is `0.2.0`, the next release. Release notes go in `docs/release-notes/v0.2.0.md` for `release.sh --notes-file`; `package.json` is not bumped (no release in this branch).
- Ruling R10: the reminder headline is `Still waiting since Tue` when the Bratislava calendar day of `lastChangedAt` is 1-6 days before today, `Still waiting since 3 Nov` when 7 or more days before, and `Still waiting for you` when `lastChangedAt` is unknown. The message is the existing parts joined with ` · `, then ` · Collected it? Mark it in the app to stop these.`
- Ruling R11: a silenced transition (progress off, delivered off, delivered after a user mark) still runs `markAnnounced`; if no other reason to speak exists for that parcel (failed attempt, new pickup point, deadline, reminder), nothing is pushed.
- Ruling R12: the next-check sentence says `(21:00)` when the next slot is today and `(tomorrow 07:00)` otherwise, from `nextSlot(now)` with `formatClock`. It is shown in the `ok` result of the save-time connection test only.
- Ruling R13: `GET /gmail-filter.xml` writes `filterVersion: 2` only when the config file loads and its effective `filterVersion` is below 2; a failed write is swallowed (the download is still served). `POST /settings/filter-imported` does the same write and redirects to `/settings`.
- Ruling R14: new corpus mails are 78+ in `test/fixtures/fake-mail/`, generated by `scripts/dev/fake-mail/generate-corpus.mjs` (the corpus is generated; never hand-edit its `.eml`s). PPL fake numbers are `408888888NN` (11 digits); Czech Packeta parcels use `Z(...)` numbers not used elsewhere in the corpus.

## Review Focus

- A GLS mail or an e-shop mail naming GLS whose 11-digit number would now also fit PPL: must stay GLS, never become two parcels or an /attention question. Tested in Task 13.
- A "PIN" that is a phone number, an order number, or a card PIN in a bank/promo mail: never shown as a pickup code. Tested in Task 1 (negatives incl. "PIN" + phone on one line, "PIN kód" with no digits).
- Turning `progress` on later must not release a backlog of old transit banners. Tested in Task 5.
- Downloading the filter on a broken (unloadable) config file must not 500 or rewrite the file. Tested in Task 11.
- A PPL answer with `events: null`, an event without `eventDate`, or `accessPoint: null`: no throw, sensible result. Tested in Task 12.

---

## Part 1: pickup codes

### Task 1: labelled PIN patterns in `extractPickupCode`

**Files:**
- Modify: `src/ingest/extract.ts` (`PICKUP_CODE`, `extractPickupCode`, its doc comment)
- Test: `test/pickup-code.test.ts`

**Interfaces:**
- Produces: `extractPickupCode(text: string): string | undefined` (signature unchanged).

- [ ] **Step 1: Write the failing tests** in `test/pickup-code.test.ts`, a new `describe('pickup PINs for every carrier', …)`. Read the corpus mails with `mailText(readFileSync(...))` (`mailText` is exported from `extract.ts`) so the test uses the same text the pass reads.
  - `20-gls-ready-glsbox-pin` → `'402211'`; `43-dpd-pickup-station-ready-pin` → `'120477'`; `44-posta-balikobox-pin` → `'631285'`; `28-sps-balikovo-cp1250-base64` → `'551902'`; `26-packeta-ready-zbox-code-leading-zero` → `'040712'`; `31-zasilkovna-cz-ready-iso8859-2` → `'918273'`.
  - real `test/fixtures/mail/gls-ready-for-pickup.eml` and `test/fixtures/mail/dpd-pickup-station.eml` → the PIN each prints (read the text first; assert the exact digits found there). If either prints no PIN, assert `undefined` and say so in the test name.
  - PPL ParcelShop sample (inline string): `'Dobrý den,\nzásilka 40888888801 je připravena k vyzvednutí na PPL Parcelshop Testovice, Hlavní 1.\nPIN pro vyzvednutí: 402211\nVyzvedněte ji do 5. 11. 2026.'` → `'402211'`.
  - Czech posta-style `'PIN kód pro otevření schránky: 7 7 3 1 2 0'` → `'773120'`.
  - Negatives → `undefined`: `'Zákaznícka linka 0905 123 456'`; `'Číslo zásielky: 90444444401'`; `'PIN: 0905123456 (telefón kuriéra)'`; `'Objednávka č. 123456, PIN kód 4711 nájdete v objednávke'`; `'Nový PIN kód k vašej karte získate v aplikácii!'`; `'PIN: 123'`; `'PIN: 12345678901'`; `'Vašu zásielku môže prevziať aj osoba, ktorej poskytnete PIN kód.'`.
- [ ] **Step 2: Run** `npx vitest run test/pickup-code.test.ts` — expect the new positives (except Z-BOX ones) to FAIL.
- [ ] **Step 3: Implement.** Replace `PICKUP_CODE` with `PICKUP_CODES: readonly RegExp[]`, most specific first, each `label + [\s:]* + ((?:\d[ \t ]*){4,10})(?![ \t ]*\d)`, case-insensitive, run on the whitespace-collapsed text as today:
  1. the existing Z-BOX "Kód pre/pro otvorenie/otevření schránky";
  2. `PIN[ \t]*k[oó]d` optionally followed by `na otvorenie schr[aá]nky` / `pro otev[řr]en[ií] schr[aá]nky` / `pre vydanie`-style words up to a colon — i.e. `PIN k[oó]d(?:[^\d:.]{0,40}:)?`;
  3. `PIN(?: pro vyzvednut[ií]| pre vyzdvihnutie)?[ \t]*:` and `PIN (?:na otvorenie schr[aá]nky|pro otev[řr]en[ií](?: schr[aá]nky)?)`;
  4. `(?:verifika[čc]n[ýy]|overovac[ií]) k[oó]d[\s:]*`.
  Each match is refused when the sentence it stands in (split on `.!?` and the original line breaks — so search the collapsed text but check the original line containing the match) matches `NOT_TRACKING`; then the next match of the same pattern, then the next pattern. Keep the 4-10 digit check. Update the doc comment: what each label is, why most-specific-first, why the line veto.
- [ ] **Step 4: Run** `npx vitest run test/pickup-code.test.ts test/ingest-extract.test.ts test/fake-mail-regressions.test.ts` — PASS.
- [ ] **Step 5: Commit** `src/ingest/extract.ts test/pickup-code.test.ts` — `feat: pickup PINs for GLS, DPD, pošta, SPS and PPL, not only the Z-BOX`.

### Task 2: rescan migration and report wording

**Files:**
- Modify: `src/db/migrate.ts` (append migration), `src/core/pickup-code.ts` (`PickupCodeReport.found` comment and the file's "Z-BOX" wording where it means any code)
- Test: `test/migrate.test.ts`, `test/pickup-code.test.ts`

**Interfaces:**
- Produces: migration `{ version: latest+1, name: 'pickup codes: read waiting parcels again with the new PIN patterns' }` running `UPDATE pickup_codes SET checked_messages = -1 WHERE code IS NULL`.

- [ ] **Step 1: Failing tests.** In `test/migrate.test.ts` (follow its existing pattern for running one migration on a db stamped one version below): two `pickup_codes` rows, `(1, NULL, 3, …)` and `(2, '118822', 3, …)`; after migrating, row 1 has `checked_messages = -1`, row 2 is unchanged. In `test/pickup-code.test.ts`: a ready GLS parcel whose stored mail is fixture 20, with a `pickup_codes` row `(code NULL, checked_messages = 1)` → `runPickupCodes` finds nothing (watermark) before the migration and `'402211'` after it.
- [ ] **Step 2: Run** them — FAIL.
- [ ] **Step 3: Implement** the migration with a doc comment (why: the watermark would otherwise keep every already-waiting parcel from ever being read with the new patterns; rows with a code are left alone because a found code is final).
- [ ] **Step 4: Run** `npx vitest run test/migrate.test.ts test/pickup-code.test.ts test/db.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat: parcels already waiting are read once more for a PIN`.

### Task 3: card wording per pickup kind, README

**Files:**
- Modify: `src/web/views/index.ts` (`pickupCodeLine`, `Entry.code` comment, caller), `src/web/views/parcel.ts` (caller), `README.md` ("### The Z-BOX opening code" → "### Pickup codes and PINs")
- Test: `test/pickup-code.test.ts` (or `test/web-pages.test.ts`, whichever already holds the card tests)

**Interfaces:**
- Produces: `pickupCodeLine(code: string | undefined, kind: PickupPoint['kind'] | undefined): Html`.

- [ ] **Step 1: Failing tests**, one per kind, on the returned HTML string:
  - `zbox` and `locker` → contains `Open the box with` and `<b class="mono sel">631285</b>`;
  - `parcelshop` and `post_office` → `Show this PIN at the counter:` and the code in the same `<b>`;
  - `unknown` and `undefined` → `PIN` label and the code, and neither of the other two phrases;
  - `pickupCodeLine(undefined, 'zbox')` → empty.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; callers pass `p.pickup?.kind`. Keep the markup `<p class="code"><span class="code-l">…</span> <b class="mono sel">…</b></p>`.
- [ ] **Step 4: README**: rename the section, say which carriers' mail carries a code (Packeta Z-BOX, GLS BOX/ParcelShop, DPD Pickup Station, pošta BalíkoBOX, SPS balíkovo verification code, PPL ParcelShop/Parcelbox), that it is read from mail only, never shown in a banner, and how the card words it.
- [ ] **Step 5: Run** `npx vitest run test/pickup-code.test.ts test/web-pages.test.ts` — PASS. Existing tests asserting `Open the box with` on a Z-BOX parcel still pass.
- [ ] **Step 6: Commit** — `feat: the card says how to use the code: open the box, or show the PIN at the counter`.

## Part 2: notifications

### Task 4: `notifications` config block

**Files:**
- Modify: `src/core/config.ts`, `config.example.json`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `export interface NotificationPrefs { progress: boolean; dailyReminder: boolean; delivered: boolean }`, `export const DEFAULT_NOTIFICATIONS: NotificationPrefs = { progress: false, dailyReminder: true, delivered: true }`, `Config.notifications: NotificationPrefs` (always filled).

- [ ] **Step 1: Failing tests:** absent → defaults; `{ progress: true }` → `{ progress: true, dailyReminder: true, delivered: true }`; `{ delivered: 'no' }` throws `/"notifications.delivered" must be true or false/`; `{ sound: true }` throws `/"notifications.sound" is not a setting/`; `notifications: []` and `notifications: 1` throw `/"notifications" must be an object/`.
- [ ] **Step 2: Run** `npx vitest run test/config.test.ts` — FAIL.
- [ ] **Step 3: Implement** in `validateConfig`; add `"notifications": { "progress": false, "dailyReminder": true, "delivered": true }` to `config.example.json`.
- [ ] **Step 4: Run** `npx vitest run test/config.test.ts test/config-write.test.ts test/settings-web.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat: a notifications block in the config, quiet by default`.

### Task 5: the progress and delivered switches in the rules

**Files:**
- Modify: `src/notify/rules.ts` (`buildNotifications`), `src/core/poll.ts` (`notify` passes `deps.config.notifications`)
- Test: `test/notify-rules.test.ts`

**Interfaces:**
- Consumes: `NotificationPrefs`, `DEFAULT_NOTIFICATIONS` (Task 4).
- Produces: `buildNotifications(db, newEvents, now, port, prefs: NotificationPrefs = DEFAULT_NOTIFICATIONS): Notification[]`.

- [ ] **Step 1: Failing tests** (use the file's existing parcel/db helpers):
  - transition to `in_transit` with defaults → no notification, and `last_announced_status` is now `in_transit`; then `prefs.progress = true` on the next run → still nothing (no backlog); a later transition to `out_for_delivery` → announced.
  - `pre_transit` / `in_transit` with `progress: true` → announced (`Registered —`, `In transit —`).
  - `delivered` with defaults → announced; with `delivered: false` → silent and recorded; with defaults but a `user_marks` row for the parcel (use `markCollected` or whatever `src/core/collected.ts` exposes) → silent and recorded.
  - unchanged: `ready_for_pickup`, `failed_attempt`, `returning` still announced with `progress: false`.
- [ ] **Step 2: Run** `npx vitest run test/notify-rules.test.ts` — FAIL.
- [ ] **Step 3: Implement** per Ruling R11: compute `silenced`; a silenced transition does not count toward the push decision or headline; when nothing else applies call `markAnnounced(db, id, p.status, p.pickup !== undefined)` and `continue`. `user_marks` check via a prepared `SELECT 1 FROM user_marks WHERE parcel_id = ?`. Update the function's doc comment.
- [ ] **Step 4: Run** `npx vitest run test/notify-rules.test.ts test/poll.test.ts test/notify-send.test.ts test/collected.test.ts` — PASS (update existing tests that expected transit banners under defaults to pass `progress: true` or to expect silence, whichever the test is about).
- [ ] **Step 5: Commit** — `feat: transit updates are quiet by default; Delivered is quiet once you have said you have it`.

### Task 6: one reminder a day, not on the ready day, new wording

**Files:**
- Modify: `src/notify/nudge.ts` (`NUDGE_SLOTS` = 08:00 only), `src/notify/rules.ts` (`waitingDay` → `waitingSince`, nudge rules), `src/core/schedule.ts` (comment only, Ruling R8), `README.md` ("## Notifications", "### Reminders while a parcel is waiting")
- Test: `test/notify-rules.test.ts`

**Interfaces:**
- Consumes: `prefs.dailyReminder` (Task 5's parameter).

- [ ] **Step 1: Failing tests** (times are Europe/Bratislava; build `now` with luxon or the file's helper):
  - ready since Tue 2026-11-03 10:00 (`lastChangedAt`): run at 2026-11-03 15:40 → no reminder (and the ready banner, if not yet announced, is the only one); run 2026-11-04 08:05 → title `Still waiting since Tue — <name>`, message ends ` · Collected it? Mark it in the app to stop these.`; run 2026-11-04 15:35 → nothing.
  - ready since 2026-10-27 → reminder on 2026-11-04 08:05 says `Still waiting since 27 Oct`.
  - `dailyReminder: false` at 2026-11-04 08:05 → nothing; then `dailyReminder: true` at 09:00 the same day → still nothing (slot marked); 2026-11-05 08:05 → one reminder.
  - `passedSlots` returns at most one key per day.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per Ruling R10. "Ready day" = Bratislava calendar day of `lastChangedAt` equals today's: no nudge, but slots are still marked. `dailyReminder` off: nudge not sent, slots still marked.
- [ ] **Step 4: README** — rewrite both sections: which updates banner by default, the three switches on Settings, one reminder at 08:00 from the day after it arrived, the new wording, the PIN never in a banner.
- [ ] **Step 5: Run** `npx vitest run test/notify-rules.test.ts test/schedule.test.ts test/poll.test.ts` — PASS.
- [ ] **Step 6: Commit** — `feat: one reminder a day at 08:00, from the day after a parcel arrives`.

### Task 7: the Notifications block on Settings

**Files:**
- Modify: `src/web/settings.ts` (`SettingsForm`, `SettingsValues`, `settingsValues`, `submittedSettings`, `applySettings`, `changedSettingFields`), `src/db/activity-log.ts` (`SETTING_FIELDS` gains the three names), `src/web/views/settings.ts` (block between "Parcels" and Advanced)
- Test: `test/settings-web.test.ts`

**Interfaces:**
- Produces: `SettingsForm.notificationsForm?: string; notifyProgress?: string; notifyDailyReminder?: string; notifyDelivered?: string`; `SettingsValues.notifications: NotificationPrefs`.

- [ ] **Step 1: Failing tests:** the page renders `<h2>Notifications</h2>` and three checkboxes named `notifyProgress`, `notifyDailyReminder`, `notifyDelivered` with the spec's labels ("Registered and in-transit updates", "A daily reminder while a parcel waits for you", "Delivered"), checked per the stored values (defaults when absent), plus `<input type="hidden" name="notificationsForm" value="1">`; posting with marker and only `notifyDelivered=on` writes `notifications: { progress: false, dailyReminder: false, delivered: true }`; posting without the marker leaves a stored `{ progress: true, … }` untouched; the activity log records `notifications.dailyReminder` when only it changed, and nothing for a save that keeps the defaults on a file with no block.
- [ ] **Step 2: Run** `npx vitest run test/settings-web.test.ts` — FAIL.
- [ ] **Step 3: Implement** per Rulings R6, R7. Use `<label class="check">` markup consistent with `style.ts`; if no checkbox style exists, add a minimal one there using existing tokens.
- [ ] **Step 4: Run** `npx vitest run test/settings-web.test.ts test/activity-log.test.ts test/config-write.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat: three notification switches on Settings`.

## Part 3: setup wording

### Task 8: the Gmail guide, rewritten

**Files:**
- Modify: `src/web/views/settings.ts` (`gmailGuide`, App Password hint, label hint), `src/web/style.ts` only if needed
- Test: `test/settings-web.test.ts`

- [ ] **Step 1: Failing tests** on the rendered page with no imap block:
  - summary contains `about ten minutes, on three Google pages`; three `<li>` headings `Label your parcel mail in Gmail`, `Make an App Password`, `Paste it here`;
  - contains `a Gmail rule that files mail under a label` and `the way apps like this one read mail`;
  - `<strong>Show in IMAP</strong>` appears in step 1 and in the label field's hint;
  - contains, verbatim, `An App Password can read and send mail as your whole account. Parcels only reads the <span class="mono">parcels</span> label and never sends mail. You can revoke it any time at` + link to `myaccount.google.com/apppasswords`; the hint still says `16-character` and says `Spaces are fine`;
  - contains `Company (Google Workspace) accounts work too; your admin may have to allow App Passwords.` and `Sell online? Add <span class="mono">-from:yourshop.sk</span> to the filter so your customers’ dispatch copies are not tracked as your parcels.` (match the apostrophe style the file already uses);
  - `<a href="/add">Skip for now — add a parcel by hand</a>` present with no imap block, absent with one.
- [ ] **Step 2: Run** — FAIL (update the existing tests that pin the old copy in the same commit).
- [ ] **Step 3: Implement.** Keep every existing link and button name; keep "Apply new filters to existing email"; the guide stays open until mail is configured.
- [ ] **Step 4: Run** `npx vitest run test/settings-web.test.ts test/web-pages.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat: a setup guide a friend can follow alone`.

### Task 9: the next-check sentence, the welcome page, README install and uninstall

**Files:**
- Modify: `src/web/views/settings.ts` (`testResult` `ok` branch gains the sentence; `SettingsState.nextCheck?: Date`), `src/web/server.ts` (GET `/settings` passes `nextCheck: nextSlot(now())` when rendering a save's test), `app/pages/welcome.html`, `README.md` ("## Install the app" wording, new "## Uninstalling")
- Test: `test/settings-web.test.ts`, `test/app/first-run.test.ts` if it pins the welcome text

- [ ] **Step 1: Failing tests:** after a save whose probe returns `ok` with messages (use the existing fake `imapClient` pattern in the test file) at a `now` of 14:20 local, the page contains `Your parcels appear at the next check (15:00) — or press Refresh now.`; at 22:00 it contains `(tomorrow 07:00)`; the `Test again` result (not a save) does not contain it. Welcome page contains `Next: connect Gmail (about ten minutes), or skip it and add parcels by hand.`
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per Ruling R12 (use `formatClock` from `views/format.ts`, and compare days the way `views/health.ts` does). "Refresh now" names the dashboard button; link it to `/` if the dashboard has no anchor for it.
- [ ] **Step 4: README** — "Install the app" follows the new guide's three groups; add "## Uninstalling" with the spec's five steps verbatim in order.
- [ ] **Step 5: Run** `npx vitest run test/settings-web.test.ts test/app/` — PASS.
- [ ] **Step 6: Commit** — `feat: say when parcels will appear; welcome page and README match; how to uninstall`.

## Part 4a: the filter and Zásilkovna

### Task 10: `gmail-filter.xml` for Czech mail

**Files:**
- Modify: `gmail-filter.xml`
- Test: `test/gmail-filter.test.ts`

- [ ] **Step 1: Failing test:** `hasTheWord`'s `from:(…)` carrier list contains `zasilkovna.cz` and `ppl.cz`; BOTH `subject:(…)` lists contain each of `zasilka`, `zasilku`, `zasilky`, `pripravena`, `vyzvednuti`, `"k vyzvednuti"`, `"vydejni misto"`, `"vydejnim miste"`, `dorucime`; the comment contains `-from:yourshop.sk`. The existing tests (one field, well-formed, xmllint) still pass.
- [ ] **Step 2: Run** `npx vitest run test/gmail-filter.test.ts` — FAIL.
- [ ] **Step 3: Implement**; bump the entry `<id>`s to `parcels-2` and `<updated>` to `2026-10-30T00:00:00Z`.
- [ ] **Step 4: Run** — PASS; also `npx vitest run scripts/dev/persona-sim` is NOT run (not part of the suite); check `scripts/dev/persona-sim/lib/gmail-filter.mjs` still parses the file by running `node -e "import('./scripts/dev/persona-sim/lib/gmail-filter.mjs').then(m=>console.log(Object.keys(m)))"`.
- [ ] **Step 5: Commit** — `feat: the Gmail filter labels Czech mail: Zásilkovna, PPL and Czech subjects`.

### Task 11: `filterVersion` and the re-import notice

**Files:**
- Modify: `src/core/config.ts` (`filterVersion`), `src/web/settings.ts` (`SettingsValues.filterVersion: number`), `src/web/views/settings.ts` (notice), `src/web/server.ts` (`POST /settings/filter-imported`, `GET /gmail-filter.xml` write), `src/db/activity-log.ts` (`filterVersion` in `SETTING_FIELDS`)
- Create: `docs/release-notes/v0.2.0.md`
- Test: `test/settings-web.test.ts`, `test/config.test.ts`

**Interfaces:**
- Produces: `Config.filterVersion: number` (absent → 1; must be a positive integer, else `/"filterVersion" must be a whole number from 1/`); `export const CURRENT_FILTER_VERSION = 2` in `src/core/config.ts`.

- [ ] **Step 1: Failing tests:**
  - config: absent → 1; `2` → 2; `0`, `1.5`, `"2"` throw.
  - Settings with an imap block and no `filterVersion` shows `Set up before 0.2.0? Import the filter again and delete the old one, so Czech mail is labelled too.` and a button `Done, I imported it again` in a form posting to `/settings/filter-imported`; with `filterVersion: 2` or no imap block it is absent.
  - `POST /settings/filter-imported` → 303 to `/settings`, file now has `filterVersion: 2`, every other key (incl. `imap.pass`) unchanged.
  - `GET /gmail-filter.xml` on a file with no `filterVersion` → 200 XML and the file now has `filterVersion: 2`; on a file that fails `validateConfig` → 200 XML and the file bytes are unchanged.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per Ruling R13; the release-notes file holds the same sentence plus one line each for parts 1-4.
- [ ] **Step 4: Run** `npx vitest run test/settings-web.test.ts test/config.test.ts test/config-write.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat: tell existing users to import the new filter once`.

### Task 12: Czech Zásilkovna mail in the corpus, and what the extractor misses

**Files:**
- Modify: `scripts/dev/fake-mail/generate-corpus.mjs` (mails 78-81), `scripts/dev/fake-mail/templates.mjs` (a Czech variant of `packeta()` if the existing one cannot write Czech; model on mails 31 and 62), `scripts/dev/fake-mail/world.ts` (carrier answers for the new Z number), `src/ingest/extract.ts` (only what the tests prove missing)
- Regenerated: `test/fixtures/fake-mail/*.eml`, `corpus.json`, `MANIFEST.md`
- Test: `test/fake-mail-regressions.test.ts`

- [ ] **Step 1: Add the four mails** from `Zásilkovna <noreply@zasilkovna.cz>`, one new `Z(n)` number: 78 accepted (`Zásilka … byla podána` / `přijata`, future-tense box block), 79 ready (`Zásilka je připravena k vyzvednutí`, Z-BOX line `Kód pro otevření schránky` with code `305118`, present-tense `Místo, kde je vaše zásilka uložena` block), 80 picked up (`vyzvednuta`), 81 returning (`vracíme odesílateli`). Expectations: `parcel: packeta:<Z>`, 79 with `code: '305118'`. Also add `code` expectations to 20 (`402211`), 43 (`120477`), 44 (`631285`), 28 (`551902`). Run `node scripts/dev/fake-mail/generate-corpus.mjs`; `git diff --stat test/fixtures/fake-mail` must show only the new files plus `corpus.json`/`MANIFEST.md` (the generator is deterministic).
- [ ] **Step 2: Failing tests** in a new `describe('Czech Zásilkovna mail', …)` in `test/fake-mail-regressions.test.ts`: each of 78-81 extracts `{ carrier: 'packeta', number: <Z>, confidence: 'sender' }` and the merchant the mail names; 79's `pickupFromMail` gives the Z-BOX street, `999 11`-style postcode and town; 79's `extractPickupCode` gives `'305118'`; 78's box block is NOT taken as a pickup point (future tense).
- [ ] **Step 3: Run** — fix whatever fails in `extract.ts` (merchant phrasing, labels), with a comment per fix.
- [ ] **Step 4: Run** `npx vitest run test/fake-mail-regressions.test.ts test/ingest-extract.test.ts test/pickup-code.test.ts` — PASS.
- [ ] **Step 5: Commit** the generator files, the new `.eml`s, `corpus.json`, `MANIFEST.md`, `world.ts`, test, and `extract.ts` if changed — `test: Czech Zásilkovna mail, accepted to returning`.

## Part 4b: PPL

### Task 13: the PPL carrier and its adapter

**Files:**
- Create: `src/carriers/ppl.ts`, `test/carriers/ppl.test.ts`, `test/fixtures/ppl/*.json` (synthetic bodies)
- Modify: `src/core/types.ts` (`CarrierId` gains `'ppl'`), `src/notify/rules.ts` (`CARRIER_NAME.ppl = 'PPL'`), `src/carriers/registry.ts` (register; NOT in `DETECT_ORDER`, with a comment why), `src/core/support.ts` (shape comment: `ppl ^\d{11}$`, already covered by `\d{10,}`), `src/ingest/extract.ts` (`NUMBER.ppl = /(?<!\d)\d{11}(?!\d)/g` so the `Record<CarrierId, RegExp>` compiles; the sender/name rules are Task 14), `scripts/dev/fake-mail/world.ts` (`ZONE.ppl = 'Europe/Prague'`), any other `Record<CarrierId, …>` the typecheck names, `README.md` (carrier table row: PPL, polled, "not yet checked against a real parcel")
- Test: `test/carriers/ppl.test.ts`, `test/registry.test.ts`

**Interfaces:**
- Produces: `export const pplAdapter: CarrierAdapter` with `id: 'ppl'`, `matches: n => /^\d{11}$/.test(n)`, `needsPostalCode: false`, `batchSize: 1`; `export const PPL_STATUS: ReadonlyMap<string, CanonicalStatus>`.

- [ ] **Step 1: Failing tests** (stub `HttpClient`, record calls; no network):
  - request: one `POST` to `https://api.dhl.com/ecs/ppl/webapi/TrackAndTrace/40888888801` with headers `dhl-api-key: 7HH634Q79Zpge4xEGeFAHXAnUMRxv0XQ`, `Content-Type: application/json`, body `'{}'`.
  - one test per code in the spec's table (`WaitingForShipment`→`pre_transit`, `PickedUpFromSender`/`ShipmentInTransport`/`PreparingForDelivery`→`in_transit`, `LoadingForDelivery`/`OutForDelivery`→`out_for_delivery`, `DeliveredToPickupPoint`/`Delivered.Parcelshop`→`ready_for_pickup`, `Delivered`→`delivered`, `NotDelivered`→`failed_attempt`, `BackToSender`→`returning`), via `phase`; `phase: null` falls back to `lastEventCode`; `Delivered.BackToSender` and `Foo` → `unknown`, `statusRaw` the code.
  - events: `[{ code, eventDate, eventText }]` → `ParcelEvent`s with `status` from `code`, `code`, `description = eventText ?? code`, date from ms epoch (`1793865600000`), ISO with `Z`, and naive ISO (Europe/Prague); an event without `eventDate` is skipped; `events: null` → `[]`.
  - pickup: `accessPoint: { parcelshopName: 'PPL Parcelshop Testovice' }` → `{ kind: 'parcelshop', name: … }`; `'PPL Parcelbox Testovice'` → `kind: 'locker'`; `accessPoint: null` → no pickup. No `retainedTill`.
  - failures (Ruling R5): 400 `{"detail":"service.TrackAndTrace.ShipmentNotFound"}` → `not_found`; 400 other detail → `transport`; 500 → `transport`; 403 → `gated`; 200 `<html>…` → `gated`; a thrown `HttpTransportError` → `transport` (whichever the other adapters do: check `gls.ts`).
  - registry: `detectCarrier('40888888801')` is `['gls']`; `resolveCarrier('40888888801', 'ppl')` is `{ ok: true, carrier: 'ppl' }`; `canonicalNumber('ppl', '04088888880')` is unchanged.
  - add page: the carrier `<select>` lists `<option value="ppl">PPL</option>`.
- [ ] **Step 2: Run** `npx vitest run test/carriers/ppl.test.ts test/registry.test.ts` — FAIL.
- [ ] **Step 3: Implement** `src/carriers/ppl.ts` following `sps.ts`/`gls.ts` style. File comment: endpoint, key ("the key PPL's public tracking site uses", as observed 2026-10-30), the source of the response shape (`ha-parcel-integrations/ha-ppl-cz`, `custom_components/ppl_cz/tracking/*.py`) and the not-found probe of 2026-10-30, and in bold-equivalent words **not yet checked against a real parcel**. Status from codes only, never from `eventText`.
- [ ] **Step 4: Run** `npm run typecheck`, `npx tsc -p tsconfig.app.json --noEmit`, then `npx vitest run test/carriers test/registry.test.ts test/web-pages.test.ts test/support-bundle.test.ts test/poll.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat: PPL, polled from the tracking API PPL's own site uses (not yet checked against a real parcel)`.

### Task 14: recognising PPL in mail

**Files:**
- Modify: `src/ingest/extract.ts` (`SENDER_DOMAINS` gains `['ppl.cz','ppl']`; `firstNumber` for `ppl` per Ruling R3; `CARRIER_NAME.ppl = /(?<![\p{L}\d])PPL(?![\p{L}\d])/iu`; `STANDALONE.ppl = /(?<![\p{L}\d])\d{11}(?![\p{L}\d])/gu`; `BARE_DIGIT_CARRIERS` gains `'ppl'`; `namedBareNumbers` applies Ruling R2 for `ppl`; `CARRIER_IN_DOMAIN`, `BRAND_DOMAIN` gain `ppl`; `BRAND_CARRIER.ppl = 'ppl'`), `README.md` ("Czech mail" paragraph under Mail ingest)
- Test: `test/ingest-extract.test.ts`

**Interfaces:**
- Consumes: `CarrierId 'ppl'`, `NUMBER.ppl` (Task 13).

- [ ] **Step 1: Failing tests** (build mails with the file's existing raw-mail helper):
  - from `PPL CZ <noreply@ppl.cz>`, `Číslo zásilky: 40888888801` and a courier phone `+420 777 123 456` printed first → `{ carrier: 'ppl', number: '40888888801', confidence: 'sender' }`;
  - from `info@obchod.example.cz`, `Číslo zásilky: 40888888801`, no "PPL" → not `ppl` (no parcel; `confidence: 'none'`);
  - same shop, `Dopravce: PPL\nČíslo zásilky: 40888888801` → `{ carrier: 'ppl', confidence: 'shape' }`;
  - same shop, `PPL` only in a footer three paragraphs below the number → not `ppl`;
  - a GLS mail from `noreply@gls-slovakia.sk` with `90444444401` → still `gls`; an e-shop mail naming GLS with a labelled 11-digit number → `gls`;
  - `detectCarrier('40888888801')` → `['gls']` (Detect on 11 digits stays GLS);
  - a sender `noreply@ppl-cz.example.com` with display name `PPL` → `lookalike-sender`, `claimed.carrier === 'ppl'`; `noreply@ppl.de` (brand domain) is not a look-alike.
- [ ] **Step 2: Run** `npx vitest run test/ingest-extract.test.ts` — FAIL.
- [ ] **Step 3: Implement**, with the usual why-comments (why 11 digits are never PPL by shape alone; why the name must be close).
- [ ] **Step 4: Run** `npx vitest run test/ingest-extract.test.ts test/fake-mail-regressions.test.ts test/email-only.test.ts test/ingest-evidence.test.ts` — PASS.
- [ ] **Step 5: README** "Czech mail" paragraph: Zásilkovna is Packeta, PPL is tracked from `ppl.cz` mail or a shop mail naming PPL beside the number, never by shape alone, plus the filter re-import note.
- [ ] **Step 6: Commit** — `feat: PPL mail becomes a parcel, from ppl.cz or a shop that names PPL beside the number`.

### Task 15: PPL in the fake-mail corpus, harness run

**Files:**
- Modify: `scripts/dev/fake-mail/generate-corpus.mjs` (mails 82-85), `scripts/dev/fake-mail/templates.mjs` (`ppl()` template), `scripts/dev/fake-mail/world.ts` (PPL answers), `scripts/dev/fake-mail/README.md` (counts if it states them), `test/fixtures/fake-mail/FINDINGS.md` only if a finding changes
- Regenerated: corpus `.eml`s, `corpus.json`, `MANIFEST.md`

- [ ] **Step 1: Add** 82 `ppl.cz` accepted/in transit (`408888888 01`), 83 `ppl.cz` ready at a PPL ParcelShop with `PIN pro vyzvednutí: 402211` (expect `code: '402211'`), 84 e-shop dispatch `Dopravce: PPL` + labelled `40888888802` (expect `parcel: ppl:40888888802`), 85 a stranger's mail with a labelled 11-digit number and no carrier named (expect not a PPL parcel: `ignored` or `attention`, whichever the extractor's evidence rule gives — run it and pin the actual if it is sane). World answers for both PPL numbers over the run's timeline (pre_transit → in_transit → ready_for_pickup with `PPL Parcelshop Testovice` → delivered).
- [ ] **Step 2: Run** the generator, then `SHOTS=0 npx vitest run --config scripts/dev/fake-mail/vitest.config.ts scripts/dev/fake-mail/harness.run.ts` and the probes run. Expected: `expectation mismatches: 1` (F9, `52-…`). Read `test/fixtures/fake-mail/out/RESULTS.md` for 78-85.
- [ ] **Step 3: Run** `npx vitest run test/fake-mail-regressions.test.ts` — PASS.
- [ ] **Step 4: Commit** the generator files, new `.eml`s, `corpus.json`, `MANIFEST.md` — `test: PPL mail in the fake-mail corpus`.

## Final checks (controller, after all tasks)

- `npx vitest run` (ignore `test/web-core.test.ts`; re-run the app-update timeout alone if it appears)
- `npm run typecheck` and `npx tsc -p tsconfig.app.json --noEmit`
- `bash test/app/release.test.sh` and every other `test/**/*.test.sh` (`test/app/*.test.sh`, `test/install-agents.test.sh`, `test/install-hostname.test.sh`, `test/setup.test.sh`, `test/update-run.test.sh`)
- fake-mail harness (Task 15 command) — 1 mismatch, F9
- `npm run app:smoke`
- Fable whole-branch review of `git diff main...persona-followups`; fix confirmed findings
- leak check over `git diff main...persona-followups`: no real e-mail addresses (only `example` domains and carrier no-reply senders), no `matuslaco` outside pre-existing paths, only fake tracking numbers
