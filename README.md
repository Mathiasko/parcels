# Parcel tracker

A self-hosted parcel tracker for one Mac and one user. It finds your parcels in a
Gmail label, polls the Slovak and Czech carriers for status, and tells you with a macOS
notification when something is out for delivery or waiting at a pickup point. A local web
page is the read surface. Nothing runs off this machine and nothing is forwarded anywhere.

Carriers: Slovenská pošta, Packeta, GLS, SPS, DPD SK. (123Kuriér is excluded: the company is defunct.)

The full design and its rationale are in
[`docs/superpowers/specs/2026-10-26-parcel-tracker-design.md`](docs/superpowers/specs/2026-10-26-parcel-tracker-design.md).

## Read this first: use the absolute node path

On this machine a bare `node` (or `npm`) invocation swallows the first call in each shell and
produces confusing empty failures: no output and a non-zero exit. The cause is that the zsh profile
defines `node` and `npm` as lazy-loading shell functions that start nvm on first use. Always use the
absolute path:

```sh
/Users/you/.nvm/versions/node/v24.21.0/bin/node dist/cli.js list
```

The launchd plists already name that path, because launchd supplies only
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Every `node ...` in this README means the absolute path
above. Requires Node 24 or newer.

## Install and build

```sh
npm install        # use /Users/you/.nvm/versions/node/v24.21.0/bin/npm, see above
npm run build        # tsc, then copies src/db/schema.sql into dist/
npm test             # 500+ tests, no network
npm run typecheck
```

## Configure

Copy `config.example.json` to `config.json` and fill it in. It holds a secret, so lock it down;
it is gitignored, as is all of `data/`.

```sh
cp config.example.json config.json
chmod 600 config.json
```

| Field | Meaning |
|---|---|
| `defaultPostalCode` | Required. Your postcode; GLS and DPD need one to answer. Overridable per parcel. |
| `dbPath` | Default `data/parcels.db`. A relative path is resolved against the config file's directory. |
| `port` | Dashboard port, default `8787`. |
| `notifier` | `auto` (default), `terminal-notifier` or `osascript`. `auto` tries terminal-notifier and falls back to osascript. |
| `mapPreview` | `true` (default) or `false`. The pickup-point map. `false` stops all geocoding and tile fetching and removes the map from the page. See [Pickup point maps](#pickup-point-maps). |
| `imap` | Optional. Without it, no mail is read and parcels are added by hand. See below. |

```json
"imap": {
  "host": "imap.gmail.com",
  "port": 993,
  "user": "you@gmail.com",
  "pass": "<app password>",
  "mailbox": "parcels"
}
```

`mailbox` is the Gmail label name; nested labels are `parent/child`. Set `PARCELS_CONFIG` to use a
config file somewhere else.

## Mail ingest: parcels that add themselves

The app reads your **main Gmail account**, limited to one label, over IMAP with an App Password.
Nothing is forwarded and there is no second mailbox. Ingest is **strictly read-only**: it opens the
label with `EXAMINE`, fetches with `BODY.PEEK`, and never writes an IMAP flag, so your mail is not
marked as read. Messages already seen are skipped by Message-ID.

Setup, in this order:

1. **Turn on 2-step verification**, then create an App Password at
   <https://myaccount.google.com/apppasswords>. Put it in `config.json` as `imap.pass`.
   (IMAP is always on in Gmail; there is no enable toggle any more.)
2. **Create a Gmail filter** for your shipping mail whose action is **Apply the label** `parcels`.
   Do not choose forwarding. Tick **Also apply filter to matching conversations**: labels apply
   retroactively, which back-fills your history on the first run.

   **Include your e-shops in the filter, not only the carriers.** A filter that matches only carrier
   domains (`packeta.sk`, `dpd.sk`, `gls-group.eu`, ...) never labels the shop's own "your order has been
   dispatched" mail, and that mail is often the *first* notice of a parcel, days before the carrier
   writes, and sometimes the only one. Add the shops you order from as `from:` terms (for example
   `from:(packeta.sk OR dpd.sk OR gls-group.eu OR mtbiker.sk)`), or match on dispatch wording such as
   `subject:(odoslan OR dispatched OR "číslo balíka")`. The app can now use that mail: when a sender is
   not a carrier it looks for a **carrier named in the mail together with a labelled tracking number of
   that carrier's shape** (for example `Číslo balíka: 1234567890` next to "GLS"). Both are required;
   a mail that only names a carrier (an order confirmation saying the delivery method is GLS) goes to
   needs-attention, never to a parcel.
3. **Make the label visible to IMAP. This is the step that catches everyone.** Gmail hides labels
   from IMAP by default. Go to **Settings, Labels** and tick **Show in IMAP** for `parcels`.
   If you skip this the app connects fine, authenticates fine, and reports an empty folder.
4. **Write the `imap` block** in `config.json` and `chmod 600 config.json`.

Notes on behaviour:

- The first run over a long label does not poll dead parcels: a parcel whose newest mail is older
  than 30 days is created already archived (never polled, status left `unknown`) and shows up under
  History.
- Mail that cannot be parsed, or that names several different numbers, is never dropped. It lands
  on the **Needs attention** page (`/attention`), where one click assigns a carrier and number.
  Mail that is simply junk (a verification notice with no tracking number in it) can be **dismissed**
  instead: that marks it parsed with no parcel, which takes it off the page and out of future
  `reprocess` runs. The row and its `.eml` are kept either way.
- Deleting a parcel (`/parcel/:id`) removes it with its events, stored carrier responses and pickup
  reminder, but **not** the emails it came from: those are unlinked and marked parsed. The ingest
  dedupes by Message-ID, so deleting the message rows would let the next poll recreate the parcel.
- If ingest fails three runs in a row you get one notification per outage, and the Health page
  shows the last error. A revoked App Password does not fail silently.
- Raw messages are kept as `data/mail/<id>.eml` (files `0600` in a `0700` directory).
  After a parser change, `node dist/cli.js reprocess` re-runs extraction over stored messages that
  produced no parcel, without needing the mail on the server.
- An App Password is not scope-limited by Google: it can read and send as the whole account. The
  label scope is a convention this app honours, not a boundary Google enforces. The credential is
  local, `chmod 600`, never leaves the machine, and can be revoked instantly at the same page.

## Pickup point maps

A parcel that is **ready for pickup** can show a small static map of the place, with a marker on it,
next to the "Open in Apple Maps" link. It is plain `<img>` tags and CSS: no JavaScript, no map
library, and the page's Content-Security-Policy still forbids scripts and allows images only from
this server (`default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'`).

**Viewing a page never touches the internet.** Everything the map needs is fetched during a poll and
read from disk afterwards. That is the whole design, and it is what keeps the dashboard from
reporting your browsing to anyone.

### What is fetched, when, and from whom

| | Who | When | What is sent |
|---|---|---|---|
| Geocoding | [Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap; no API key) | During a poll, for a parcel that is `ready_for_pickup`, whose pickup point has a town, and that has no coordinates yet | The pickup **address only** - street, postcode, town, normalised and lower-cased. Never a tracking number, a parcel name, a merchant or anything about you. |
| Map tiles | [tile.openstreetmap.org](https://tile.openstreetmap.org) | During a poll, right after the point's coordinates are known | Nine tile coordinates at zoom 16 around the point. |

Both are free community services and both are used under their published rules: a `User-Agent` that
says what this application is, at most one Nominatim request per second, and every result cached so
nothing is ever asked twice. Volume is capped per run (at most 5 addresses and 3 points' worth of
tiles per poll), so a backlog is spread over several hours rather than sent in a burst.

Only the hourly poller does this, never the dashboard and never the "Refresh now" button: the
one-request-per-second limit can only be kept if a single process is doing the asking. A pickup point
that appears between polls therefore shows its address and maps link straight away, and gains its map
at the next poll.

Packeta already sends coordinates for some points, and those are used as they are, with no geocoding.
A pickup point with only a *name* ("Z-BOX Bratislava, Hlavna 6") and no town is never geocoded: a
name is not an address and geocoding one lands on the wrong branch of a chain. Those parcels keep the
address-search maps link and show no map.

### What is cached where

- **`data/tiles/{z}/{x}/{y}.png`** - the raster tiles, `0600` files inside `0700` directories, beside
  `data/mail/`. Served to the browser by this server at `GET /tile/:z/:x/:y.png`, which validates the
  three numbers strictly and reads nothing outside that directory. A tile is written once and never
  refetched; delete the directory to start over (the next polls refill it).
- **`geocode_cache`** in `data/parcels.db` - one row per *normalised address*, not per parcel, so
  several parcels at the same Z-BOX cost one lookup. It stores the outcome (`found`, `not_found`,
  `error`), the coordinates when found, and when the last attempt was made.
- A found point's coordinates are also copied onto the parcel (`parcels.pickup_lat` / `pickup_lon`),
  which is what upgrades the Apple Maps link from an address search to an exact pin.

Failures are cached too, deliberately: an address Nominatim cannot place is not asked about again for
30 days, and a request that failed in transit waits 1 h, then 2 h, 4 h ... up to a week. Without
that, an unplaceable address would be re-sent every single hour for ever.

If any one of the nine tiles is missing, the page draws **no map at all** rather than a map with a
hole in it. The address and its maps link are always there either way.

The map carries "© OpenStreetMap contributors", linked to the licence. That is a condition of the
licence, not decoration; do not remove it.

### Turning it off

```json
"mapPreview": false
```

in `config.json`. No geocoding, no tile fetching, no map on the page, and `GET /tile/...` answers 404.
Tiles already on disk are simply left there; `rm -rf data/tiles` if you want them gone. Nothing else
about tracking changes.

## Notifications

Notification text is always passed as process arguments, never built into a shell or AppleScript
string.

On this machine `terminal-notifier` (`/opt/homebrew/bin/terminal-notifier`, from
`brew install terminal-notifier`) is installed but **not yet authorised**: every send exits 3 with
"Notifications are not allowed for this application". With `notifier: "auto"` the app therefore
falls back to `osascript`, which works. Banners appear, but they have no app identity of their own, cannot
click through to the dashboard, and do not coalesce.

**One-time manual step to upgrade** to terminal-notifier (its own app identity, click-through to
the dashboard, banner coalescing):

1. From a real Terminal window (not from inside an agent or an editor), run
   `terminal-notifier -title x -message y` once, and approve the macOS prompt.
2. Open System Settings, Notifications, **terminal-notifier**, and set the alert style to
   **Banners** or **Alerts**.

Check the result at any time:

```sh
node dist/cli.js notify-test
```

It sends a test notification, prints which mechanism was used (`terminal-notifier` or `osascript`)
and the exit code, and exits 0 when the notifier ran (a zero exit only means the tool ran, so check
that a banner actually appeared). Once step 1 is done it will switch to
`terminal-notifier` by itself.

## Run it on a schedule (launchd)

```sh
scripts/install-agents.sh
```

This renders `launchd/*.plist.template` into `~/Library/LaunchAgents`, runs `npm run build`, and
registers both agents with `launchctl bootstrap gui/$(id -u)`. It is safe to re-run. `dist/` is
build output (it is gitignored), and the agents run it, so the installer refreshes it every time:
re-run the script after pulling changes to update what the agents run. If the build fails the
script stops before touching launchd. `--no-load` writes the plists only, without building or
touching launchd.

| Agent | What it does |
|---|---|
| `local.parcels.poller` | Runs `dist/poll.js` hourly on the hour from 07:00 to 21:00 (15 slots). |
| `local.parcels.web` | Runs `dist/server.js` and is `KeepAlive`, so it restarts if it dies. |

Things worth knowing:

- The poller uses `StartCalendarInterval`, never `StartInterval`. A `StartInterval` firing that was
  missed during sleep is silently dropped; calendar intervals run on wake and coalesce into one.
  After a long sleep the poller also does a full refresh.
- Use `launchctl bootstrap` / `bootout` / `kickstart`. `launchctl load` and `unload` are legacy.
- A user LaunchAgent does **not** run at the login window (before anyone has logged in). A locked
  screen is fine.
- Logs: `data/poll.log`, `data/poll.err.log`, `data/web.log`, `data/web.err.log`.
- Run a poll by hand: `launchctl kickstart gui/$(id -u)/local.parcels.poller`, or just
  `node dist/cli.js poll`.

## The dashboard

<http://127.0.0.1:8787> (or your `port`), and <http://parcels.local> once the hostname is installed
(below). It binds loopback only and has **no authentication, by design**: anything on this Mac can
reach it, and nothing else can.

### The parcels.local hostname

```sh
sudo scripts/install-hostname.sh              # sudo scripts/install-hostname.sh --uninstall to reverse
```

Must be run from a real Terminal, because it needs a password prompt. It is idempotent, backs up
`/etc/hosts` and `/etc/pf.conf` before its first change, marks every edit with `# >>> parcels tracker`
sentinels, validates `pf.conf` before loading it, and finishes by curling the dashboard to prove the
result. It does three root-owned things, none of which run the app itself as root:

| Piece | Why |
|---|---|
| `/etc/hosts` | Resolves `parcels.local` here, and nowhere else. Both A and AAAA, so a browser trying `::1` first does not stall. |
| `/etc/pf.anchors/parcels` | `rdr pass on lo0 ... port 80 -> port 8787`. A non-root process cannot bind a port below 1024, so the app keeps its own port and the kernel moves the packets. The redirect reads the port out of `config.json`. |
| `/Library/LaunchDaemons/local.parcels.pf.plist` | pf is off by default on macOS and does not persist across a reboot, so the rule is re-applied at boot. |

**The hostname is also an allow-list entry in the code**, in `LOCAL_HOST` (`src/web/server.ts`). The
server refuses a `Host` header it does not recognise, because with no authentication that header is
what stops a page on the open web from pointing its own domain at `127.0.0.1` and reading this server
(DNS rebinding). `parcels.local` is safe to allow precisely because it resolves only through this
machine's `/etc/hosts`: nobody else can make a browser send it. A **403 at `parcels.local` means the
running server predates that change** — `npm run build`, then restart the web agent.

| Page | Shows |
|---|---|
| `/` | Parcels in flight, with a refresh-now button. |
| `/parcel/:id` | Full event timeline, pickup location and deadline, editable label and postcode, and delete (behind a disclosure, at the bottom). |
| `/history` | Archived and delivered parcels; filter by carrier, text, date. |
| `/attention` | Unparsed mail awaiting a carrier and number, or a dismissal; dormant parcels. |
| `/health` | Per-carrier last-ok / last-error, and ingest health. |
| `/add` | Add a parcel by hand. |

### The Z-BOX opening code

A parcel waiting in a Packeta Z-BOX shows the code that opens the box. **The code is never in the
tracking API** - it arrives only in the pickup email - so it is read back out of the stored `.eml`
during a poll, from local files, with no network call. That is also why historical mail works: a
parcel whose pickup email arrived before this existed gets its code on the next poll, with no
backfill command.

- Stored as **text**: real codes carry leading zeros (`004467`), and a number would drop them.
- A **staffed** pickup point ("pripravená na výdaj") has no code, because a person hands the parcel
  over. Nothing is shown in that case - no empty state, because there is no problem to report.
- A parcel whose mail yielded no code is only rescanned when new mail arrives for it, so a codeless
  parcel is not re-read from disk every hour.
- **The code is deliberately kept out of notifications and out of `data/poll.log`.** It opens a
  physical locker, and notification banners render on the lock screen.

Adding by hand: with the carrier left on auto-detect the number must match exactly one carrier's
shape. **Choosing a carrier explicitly overrides that check**, in the web page and in the CLI alike.
It is the escape hatch for when detection fails, and real numbers can fail the shape check (an SPS
number containing I or O, for instance). The worst a bad number can do is come back `not_found`
and go dormant.

## Command line

```sh
node dist/cli.js add <number> [--carrier <id>] [--label <text>] [--zip <postcode>]
node dist/cli.js list
node dist/cli.js show <id>
node dist/cli.js poll
node dist/cli.js reprocess
node dist/cli.js probe <carrier> <number> [--zip <postcode>]
node dist/cli.js notify-test
```

Carrier ids: `posta`, `packeta`, `gls`, `sps`, `dpd`.

- `add` normalises the number and auto-detects the carrier when exactly one matches; otherwise it
  asks for `--carrier`.
- `poll` is exactly the run launchd does (both are built by the same function): read the mailbox label,
  create the parcels it names, poll active parcels, send notifications. It exits 0 even when a carrier
  is down; that is recorded as health, not as a crash.
- `probe` is the only command that hits a live carrier on purpose, and it prints the **raw
  response bodies**. It is the tool for confirming a carrier's real response shape against a
  first real parcel.
- `reprocess` re-runs extraction over stored `.eml` files after a parser change.

### Confirmations still owed (spec section 15)

The adapters were built from reconnaissance. Each carrier's real response should be confirmed
against the first real parcel, with `probe`:

```sh
node dist/cli.js probe <carrier> <number>
```

| Carrier | Status |
|---|---|
| SPS | **Confirmed live** (2026-10-27). Nothing owed. |
| Slovenská pošta | Owed: `events[]` field names; `localDate` carries no offset; `postOffice` appears under `p=1`. |
| Packeta | Owed: `item` field names and `packetStatusId` values; whether `branchAddress` is absent for courier delivery. |
| GLS | `rstt028` **confirmed live** (2026-10-27, an `INTRANSIT` parcel): a *bare* object, not wrapped in `tuStatus[]` like `rstt029`; the adapter reads both. Real numbers are 10 digits. Owed: whether `rstt029` includes `history` or only `progressBar`; which `addresses[]` entry is the parcel shop (needs a captured `INPICKUP` record). |
| DPD | Owed: the postcode-verified shape; diff of step 3 with and without `dataForVerification`. |

## Your data

Everything lives under `data/` (gitignored):

- `data/parcels.db` is **plain SQLite** (WAL mode). Query it directly, read-only is safest while
  the poller runs:

  ```sh
  sqlite3 -readonly data/parcels.db \
    "SELECT carrier, status, count(*) FROM parcels GROUP BY 1, 2 ORDER BY 1, 2"
  ```

  Tables: `parcels`, `events` (status history, UTC with the carrier's original string kept),
  `messages`, `carrier_health`, `raw_responses`, `ingest_status`, `geocode_cache`, and a few
  bookkeeping tables.
  Every parcel ever tracked stays there; archiving only hides it from the in-flight list.
- `data/mail/` holds the raw `.eml` files, `0600` inside a `0700` directory.
- `data/tiles/` holds cached OpenStreetMap map tiles, same `0600`/`0700` posture. Fetched during a
  poll, never when a page is viewed; see [Pickup point maps](#pickup-point-maps) for what leaves this
  machine and how to turn it off.
- Back up by copying `data/parcels.db` (and its `-wal`/`-shm` siblings, or use `sqlite3 .backup`).

## Troubleshooting

- **IMAP connects but finds nothing:** the label is not ticked "Show in IMAP"; see step 3 above.
- **Carrier shows `gated` on /health:** the carrier is blocking us. That is always treated as an
  alarm, unlike `not_found`, which is normal for a brand-new number and never an error.
- **No notifications:** run `node dist/cli.js notify-test` and read which mechanism it used.
- **Empty or strange output from `node`:** you used a bare `node`; use the absolute path.
