# Parcels as a Mac app — design

Status: approved in conversation 2026-10-29, written up for review. Branch `mac-app`.

## 1. Goal

A self-contained `Parcels.app` that a friend downloads as a `.dmg`, drags into Applications and opens, with
no Terminal, git, Node or Homebrew. It runs the existing server and poller unchanged. It lives in the
menu bar, starts at login, posts native notifications, and updates itself from GitHub Releases with one
button and a restart.

**Decided:**

| Question | Answer |
|---|---|
| Audience | Friends. The app is **unsigned by Apple** for now: no Developer account, no notarization. The first open needs "Open Anyway" once. |
| Framework | **Electron**, with the server in a utility process (option A). Rejected: Electron supervising a bundled Node (two runtimes, ~200 MB), and Tauri with a Node sidecar (Rust, process supervision, download plumbing for ~50 MB saved). |
| Existing installs | **Offer to move in**: copy config and data into the app, stop and park the launchd jobs, and leave the clone untouched. |
| Presence | **Menu-bar icon plus a window**. Closing the window keeps the app running. Starts at login. |
| Updates | **The app updates itself**: Check → Update → Restart. No Squirrel, which refuses unsigned apps. |
| Signing | A **self-signed certificate** kept in the author's login keychain, so the signature stays stable across releases and Calendar and notification permissions survive updates. Releases are built on the author's Mac. |

**Out of scope:** Windows, Linux and mobile; Apple Developer signing and notarization (the design leaves
room for it); keeping the App Password in the Keychain; installing updates without a click; the
`parcels.local` hostname.

The git-clone install keeps working exactly as today. The app is a second way to run the same code, and
one test suite covers both.

## 2. Architecture

```
Parcels.app
├─ main process (app/*.ts, Electron)
│    menu-bar icon + menu, dashboard window, native notifications, login item,
│    first-run welcome (parcels:// protocol), moving in, crash restart, swap-and-relaunch
│        ▲ parentPort messages ▼
└─ server process (src/app-server.ts, Electron utilityProcess = plain Node)
     buildServer() on 127.0.0.1:<port>, hourly poll schedule, update check/download/verify
```

### 2.1 Main process (`app/`)

Small TypeScript modules, built by their own tsconfig to `dist-app/`. Every decision lives in a function
that takes its dependencies (paths, clock, spawn, fs) as arguments, so vitest can test it without
Electron. The Electron-facing glue stays thin.

- **Menu-bar icon.** A template image of the parcel glyph, with the title set to the number of parcels
  ready for pickup; an empty title means none. The menu has: *Open Parcels*, *Refresh now*,
  *Check for updates…*, *Start at login* (checkbox), and *Quit Parcels*. While the server process is
  down, the first item reads "Parcels stopped – restarting…".
- **Window.** One `BrowserWindow` loads `http://127.0.0.1:<port>/`.
  - Closing it destroys it, which frees the renderer, and hides the Dock icon (`app.dock.hide()`).
    Opening it again shows the Dock icon.
  - A navigation to any origin other than the dashboard's opens in the default browser
    (`shell.openExternal`) and is denied in the window.
  - Downloads go to `~/Downloads` without a dialog. A notification "Saved gmail-filter.xml" follows,
    and clicking it reveals the file in Finder.
- **Notifications.** `new Notification({ title, body })`. A click opens the window at the
  notification's `url` path, or `/` if it has none. A notification with the same `groupKey` as one
  still on screen replaces it.
- **Login item.** `app.setLoginItemSettings({ openAtLogin })`, on by default at first run. The menu
  checkbox reflects and toggles it. Opening at login shows no window.
- **Single instance.** `app.requestSingleInstanceLock()`. Opening the app a second time focuses the
  window.
- **Location check.** At startup, if the app is running from a disk image, from `~/Downloads` or from
  an App Translocation path, it offers `app.moveToApplicationsFolder()`. Self-update needs a stable,
  writable location.
- **Server supervision.** Starts the server process with:
  - `PARCELS_CONFIG=<support>/config.json`
  - `PARCELS_HOST=app`
  - `PARCELS_APP_VERSION`
  - `PARCELS_APP_BUNDLE=<path of Parcels.app>`
  - `PARCELS_LOG_DIR=~/Library/Logs/Parcels`

  Its stdout and stderr are appended to `server.log` in that directory, rotated at 1 MB and keeping one
  old file. If the process exits unexpectedly, it is restarted after 1 s, 2 s, 4 s and so on, up to
  60 s; the delay resets after 10 minutes of uptime. Quit sends `shutdown` and waits up to 5 s, then
  kills it.
- **Sleep and wake.** On `powerMonitor` `resume`, the main process sends the server `wake`, and the
  server re-plans its next poll (§2.2).

### 2.2 Server process (`src/app-server.ts`)

Plain Node, which is what a utility process is. It imports no Electron module and talks only through
`process.parentPort`.

- It runs what `src/server.ts` does (`loadRuntimeConfig`, `initRuntime`, `openDb`, `buildServer`,
  `startServer`), with the app notifier (§2.3) passed in.
- **Poll schedule.** The launchd poller's slots (07:00–21:00 on the hour, plus 15:30) move into one
  exported constant. Both `launchd/local.parcels.poller.plist.template` and the app read it; a test
  checks the template matches the constant.
  - The app arms a timer for the next slot.
  - On `wake`, or when the timer fires late, it runs once if a slot was missed while asleep. That is
    what launchd's calendar-interval coalescing gives today.
  - Each run is today's `runPoller` body, factored so it takes an already-open database instead of
    opening and closing its own. `claimRun` already serialises it against *Refresh now*.
- **Ready count.** After startup, after every poll run and after every POST that can change a status,
  the process sends `{ type: 'ready-count', n }`.
- **Messages from main:**
  - `refresh`: the same code path as `POST /refresh`;
  - `wake`;
  - `shutdown`: close fastify, close the database, exit 0.
- If the configured port is in use, it exits with a distinct status (`EADDRINUSE` → 3). The main
  process then shows a dialog naming the port and does not restart the server in a loop.

### 2.3 Notifications: an `app` notifier

`createNotifier` gets a third mechanism, `app`, selected when `PARCELS_HOST=app`. It overrides the
config's `notifier`, which only chooses between Mac command-line tools.

- It posts `{ type: 'notify', groupKey, title, message, url }` to the parent port, and the Delivery
  reports `mechanism: 'app'`.
- `NOTIFIERS` and `Delivery['mechanism']` gain `'app'`. Validation does not accept `app` in
  `config.json`, because it is chosen by the host, never by the file.

### 2.4 Unchanged

- Calendar.app via `osascript`: it now runs as a child of Parcels.app, so macOS asks "Parcels wants to
  control Calendar".
- Apple Maps links, carriers, ingest, the database and every page's behaviour.

## 3. Where things live

| What | Git install (today) | App |
|---|---|---|
| Config | `<clone>/config.json` | `~/Library/Application Support/Parcels/config.json` (0600) |
| Database, mail, tiles, auth store | `<clone>/data/` | `~/Library/Application Support/Parcels/data/`, with the same layout, because `dbPath` stays the relative `data/parcels.db` |
| Logs | `<clone>/data/*.log` (launchd) | `~/Library/Logs/Parcels/server.log`, `main.log` |
| `gmail-filter.xml` | `<clone>/gmail-filter.xml` | bundled in the app's resources; `GET /gmail-filter.xml` resolves it through the host |

`repoRoot()` callers that mean "where the bundled files are" (`gmail-filter.xml`, `schema.sql`) go
through one `resourceRoot()` that honours the host. Callers that mean "the git checkout" (update,
support) are host-specific (§5, §6).

## 4. First launch and moving in

The main process decides before it starts the server:

1. **The support folder has `config.json`.** Start normally.
2. **No config, and `~/Library/LaunchAgents/local.parcels.web.plist` exists.** Read its
   `WorkingDirectory` to find the clone, then show the **Move in** page.
3. **No config, no old install.** Show the **Welcome** page.

Both pages are static HTML in the app bundle, served through a `parcels://` protocol handler. Their
forms POST to `parcels://` and the handler acts. As on the dashboard, the pages use no JavaScript, and
they share its stylesheet.

**Welcome** asks for the default postcode, five digits validated exactly as `setup.sh` does. It
writes the same minimal `config.json` that `setup.sh` writes, through the existing `writeConfig`.
Then it starts the server and loads `/settings`, where the "How to connect Gmail" guide is open
because no mail is configured.

**Move in** says: *"Parcels is already installed in `<clone>`. Move your parcels, settings and Gmail
connection into the app? The folder is left as it is."* There are two buttons: **Move in** and
**Not now (quit)**. Running both side by side is not offered: they would share port 8787 and read the
same mailbox twice. The move:

1. `launchctl bootout gui/<uid>/local.parcels.poller` and the same for `local.parcels.web`. A job
   that is not loaded counts as success.
2. Copies the database with SQLite's online backup (`db.backup()`), never a raw file copy, so a WAL in
   flight is included. Then it copies `data/mail/`, `data/tiles/`, the DPD auth store and `config.json`
   with modes preserved (0700 for directories, 0600 for files). If `config.json` has an absolute
   `dbPath`, it is rewritten to the relative default.
3. Opens the copied database (`PRAGMA integrity_check`) and loads the copied config. Only if both pass
   does it move the two plists into `<clone>/launchd-backup/`, so launchd never starts them again.
4. On any failure before step 3 completes, the support folder is deleted and the plists are reloaded
   with `launchctl bootstrap`. The page shows the error, and the old install runs on as before.

Going back is documented in the README: quit the app, then run `scripts/install-agents.sh` in the
clone.

## 5. Updates and releases

### 5.1 Releasing (author's Mac)

- **One time:** `scripts/app/make-signing-cert.sh` creates a self-signed code-signing identity,
  "Parcels Signing", in the login keychain, valid for 10 years. It prints the certificate's SHA-256,
  which is committed as `app/signing-cert.sha256`.
- **Each release:** `npm run release`.
  1. It refuses a dirty tree, or a version that already has a tag.
  2. It builds `dist/` and `dist-app/`, then runs electron-builder for `arm64` and `x64`. Each gets
     better-sqlite3's Electron prebuild for its architecture.
  3. It signs with "Parcels Signing" (hardened runtime off, no notarization).
  4. It produces `Parcels-<v>-arm64.zip`, `Parcels-<v>-x64.zip`, `Parcels-<v>-arm64.dmg`,
     `Parcels-<v>-x64.dmg` and `SHA256SUMS`.
  5. It tags `v<v>` and runs `gh release create v<v>` with those files, using notes from a
     `--notes-file`. It asks before publishing.

### 5.2 Updating (in the app)

The Health page's update section keeps its states (`current`, `behind`, `blocked`, running and done),
with a different engine behind the same seam: `UpdateCheck` / `ScriptRunner` become an `Updater`
interface with a git implementation (today's code) and an app implementation.

- **Check.** `GET https://api.github.com/repos/Mathiasko/parcels/releases/latest`. It compares
  semver with `PARCELS_APP_VERSION`, and the release notes become the "what's new" list. A check runs
  at most once a day by itself, as today, and is never an install.
- **Update** (POST), in the server process:
  1. Download `Parcels-<v>-<arch>.zip` and `SHA256SUMS` into `<support>/updates/<v>/`.
  2. Verify the zip's SHA-256 against `SHA256SUMS`.
  3. Unpack with `ditto -x -k` into a staging folder on the same volume as the app bundle.
  4. `codesign --verify --deep --strict` the staged app, then check that its leaf certificate's
     SHA-256 equals the running app's own. **A failure at any step deletes the staging folder and
     shows the reason; nothing is swapped.**
  5. The page then shows **Restart to update**.
- **Restart** (POST). The server sends `{ type: 'install', staged }`. The main process writes a small
  swap script to the support folder and starts it detached. It quits, and the script:
  1. waits for the app's PID to exit;
  2. renames the old bundle to `Parcels.app.old-<v>`;
  3. moves the staged bundle into place;
  4. removes the `.old` copy;
  5. runs `open` on the app.

  If step 3 fails, it renames the old bundle back, opens it, and leaves a marker. The app then reveals
  the staged copy in Finder with "Drag this Parcels into Applications to finish updating".
- **After restart.** The Health page shows "Updated to <v>", as the git update does now.
- **No quarantine.** The app's own download does not get the quarantine attribute (no
  `LSFileQuarantineEnabled`), so Gatekeeper does not re-prompt after an update.

### 5.3 Verify first (spike before building on it)

These are unknowns that only a real build answers. They are the first task of the plan, and the
design changes if any fails:

1. better-sqlite3's Electron prebuild loads in the utility process on arm64.
2. A self-signed build keeps a Calendar Automation grant, and notification permission, across a
   rebuild signed with the same certificate.
3. The swap in §5.2 succeeds on this Mac under macOS's App Management protection, or fails cleanly
   into the Finder fallback.
4. Notifications from an unsigned or self-signed Electron app appear, under the name "Parcels".

## 6. App mode in the web app (`PARCELS_HOST=app`)

One `host()` function (`'git' | 'app'`) is read where the wording or the source differs:

- **Health:**
  - the app's status (version, uptime, server restarts since launch, last poll, next slot) replaces the
    launchd agents table;
  - the update section uses the app updater (§5.2);
  - the support bundle reports the app version, the Electron version, uptime, restarts, `sw_vers`, and
    the tail of `~/Library/Logs/Parcels/server.log` instead of launchd and the clone's logs.
    `launchdAgents()` and the log paths move behind a `SupportEnv` the host provides.
- **Settings:** "Advanced" stops naming `config.json` paths in the clone, `launchctl` and
  `scripts/`. It says where the app keeps its files, with a *Show in Finder* link handled by the app.
  The notifier choice is hidden.
- **CLI:** `dist/cli.js` stays a git-install tool. Nothing in app mode tells the user to run it.

## 7. Repository layout

```
app/                    Electron main process (new): main.ts, tray.ts, window.ts, supervise.ts,
                        first-run.ts, move-in.ts, swap.ts, location.ts, pages/ (welcome, move-in HTML)
src/app-server.ts       server-process entry (new)
src/core/host.ts        host(), resourceRoot() (new)
src/core/schedule.ts    the poll slots (new; the plist template is checked against it)
src/core/app-update.ts  the app updater (new); src/core/update.ts becomes the git updater
scripts/app/            make-signing-cert.sh, release.sh (new)
electron-builder.yml    (new)
test/app/*.test.ts      main-process logic, with fakes (new)
```

New dev dependencies: `electron` and `electron-builder`. No new runtime dependencies in the server.

## 8. Testing

- **Unit (vitest)**, no Electron and no real launchd:
  - first-run decision;
  - move-in on temporary folders, with fake `launchctl` and a real SQLite backup and integrity check,
    including the failure-and-rollback path;
  - schedule (next slot, a missed slot after sleep, template parity);
  - restart backoff;
  - the app notifier messages;
  - app updater: semver, release parsing, a SHA mismatch, a certificate mismatch, unpack failure, and
    swap-script generation;
  - location detection;
  - `host()` wording on Health and Settings, and the support bundle in app mode.
- **Smoke:** `npm run app:smoke` launches the packaged app with a temporary `HOME`, waits for
  `GET /health` to return 200 on a random port, sends Quit, and asserts a clean exit.
- **By hand, before calling it done:**
  - screenshots of the menu, the window, Welcome and Move in;
  - a real update from build A to build B served by a local fake release server (the release URL is
    overridable only in development builds);
  - a move-in rehearsal against a **copy** of a git install with **fake** plists, never the author's
    live install, which the author moves in themselves.
- The existing 1465 tests and both shell suites keep passing. The git install's behaviour does not
  change.

## 9. Risks

- **macOS tightens rules for unsigned apps.** If App Management blocks the swap, the Finder fallback
  still works. If Gatekeeper changes "Open Anyway", the fix is the Apple Developer account, a build
  setting.
- **Electron Node and the repo's Node.** Electron's bundled Node must be ≥ 24, the repo's engine
  floor. Pin an Electron version whose Node meets it.
- **Two copies running.** The single-instance lock covers the app. The Move in page, and the port
  check in §2.2, cover the git install.

## 10. Spike findings (2026-10-29)

A throwaway Electron 45.1.0 / electron-builder 26.18.0 app ("ParcelsSpike", arm64) was built from
its own `spike/` folder, signed with "Parcels Signing", and run from `/Applications`. Go: nothing
below forces a change to §2 or §5; three build details do.

1. **better-sqlite3 in the utility process: works.** better-sqlite3 13 is an N-API addon that ships
   its own `prebuilds/darwin-arm64.node` (and `darwin-x64.node`) inside the npm package. The same
   file loads in Node 24.21 (ABI 137) and in Electron 45.1.0 (Node 24.22.1, ABI 150): the utility
   process posted `{ '1': 1 }` (SQLite 3.53.4), loading
   `app.asar/node_modules/better-sqlite3/prebuilds/darwin-arm64.node` (served from
   `app.asar.unpacked`). There is no "Electron prebuild" to fetch, and no Electron-ABI rebuild.
   - electron-builder's default `npmRebuild: true` runs `@electron/rebuild` **in place** on the
     project's `node_modules`. For better-sqlite3 13 it is a no-op: `binding.gyp` builds nothing
     when a prebuild exists, so it only adds `build/` (Makefiles, stamps, `.forge-meta`) and leaves
     `prebuilds/*.node` byte-identical. The repo's `node_modules` stays usable by vitest either way
     (R4 holds), but the release build should set **`npmRebuild: false`**: it is not needed.
   - The Electron binary also loads the repo's own, unmodified `node_modules/better-sqlite3`.
2. **Grants surviving a rebuild: evidence good, hand check owed.** Three builds signed with the same
   identity have the identical designated requirement
   `identifier "local.parcelsspike.app" and certificate leaf = H"0ef12a68…8ddc"` (leaf SHA-1). TCC
   keys Automation and notification grants on it, so they should survive an update. Only a
   regenerated certificate changes it. The user still has to click once to confirm (Calendar, then
   rebuild, then no second prompt).
3. **The swap: works.** From inside the running 0.0.2 app: `ditto -x -k` the 0.0.3 zip into
   `~/Library/Application Support/<app>/updates/0.0.3/`, `codesign --verify --deep --strict` (pass),
   no quarantine attribute on the unpacked app, then a detached `/bin/sh` script waited for the PID,
   renamed `/Applications/ParcelsSpike.app` to `.old-0.0.2`, moved the staged app in, removed the old
   one and `open`ed it. 0.0.3 started 3 s later. No App Management prompt, no
   `Operation not permitted`. A forced step-3 failure renamed the old bundle back, reopened it and
   left the marker, as §5.2 says. `~/Applications` was not needed.
4. **Notifications: no error.** `Notification.isSupported()` is `true`; `new Notification(...).show()`
   does not throw and emits `show`; `failed` never fired. Whether the banner shows under the app's
   name, and the permission prompt, are part of the hand check (2).
5. **A file inside app.asar from the utility process: works.** `fs.readFileSync` of
   `app.asar/dist/db/schema.sql` returned its text. Keep `asar: true`.

**Builder settings that worked** (arm64, 0.0.1–0.0.3):

- `asar: true`, `asarUnpack: ["**/*.node"]`, `mac.hardenedRuntime: false`, `mac.notarize: false`,
  `mac.gatekeeperAssess: false`, `mac.extendInfo.NSAppleEventsUsageDescription` set.
- **`mac.identity: null` plus an `afterPack` hook that signs.** electron-builder only accepts
  identities that `security find-identity -v` lists, i.e. trusted ones, and skips signing with
  "Identity name is specified, but no valid identity with this name in the keychain". "Parcels
  Signing" is untrusted (`CSSMERR_TP_NOT_TRUSTED`), and `codesign` signs with it without complaint,
  so the hook calls `@electron/osx-sign`'s `signAsync({ app, identity: 'Parcels Signing',
  identityValidation: false, platform: 'darwin', preAutoEntitlements: false, optionsForFile: () =>
  ({ hardenedRuntime: false, timestamp: 'none' }) })`. The zip target is then built from the signed
  app. (`mac.sign` does not help: it is only called after an identity is found.) Trusting the
  certificate with `security add-trusted-cert` needs the user's password in a GUI, so it is not done.
- **`timestamp: 'none'`.** Apple's timestamp server failed mid-build ("The timestamp service is not
  available."), and a self-signed app gains nothing from a timestamp.
- `npmRebuild: false` (see 1).

**What changes in the design and plan:**

- The release script signs through the `afterPack` hook above, not through electron-builder's
  `identity`, and checks the result with `codesign --verify --deep --strict` and the leaf hash.
  `app/signing-cert.sha256` is lowercase hex, equal to `shasum -a 256` of the `c0` that
  `codesign -d --extract-certificates` writes.
- **`ELECTRON_RUN_AS_NODE`.** With it set (some terminals and Electron-based tools set it), the app
  binary runs as plain Node and exits; `open` passes the caller's environment on. Set the fuse
  `electronFuses: { runAsNode: false }` (the app only uses `utilityProcess`, which the fuse does not
  affect; not tried in the spike), and the swap script's `open` should use
  `env -u ELECTRON_RUN_AS_NODE`.
- **Size.** arm64 zip 127 MB (126,994,688 bytes); unpacked app 284 MB, of which 252 MB is Electron's
  frameworks. electron-builder unpacks the whole better-sqlite3 package (26 MB: SQLite's C source and
  eight platforms' prebuilds). Excluding `node_modules/better-sqlite3/{deps,src}/**` and the
  non-darwin prebuilds in `files` saves about 24 MB per architecture.
- **Build time.** About 4 minutes per architecture, mostly `@electron/osx-sign` signing every file.
- The git install's `npm ci` now also installs electron-builder's tree (Electron's binary is fetched
  lazily, on first use, so not by `npm ci`).
