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
- If ingest fails three runs in a row you get one notification per outage, and the Health page
  shows the last error. A revoked App Password does not fail silently.
- Raw messages are kept as `data/mail/<id>.eml` (files `0600` in a `0700` directory).
  After a parser change, `node dist/cli.js reprocess` re-runs extraction over stored messages that
  produced no parcel, without needing the mail on the server.
- An App Password is not scope-limited by Google: it can read and send as the whole account. The
  label scope is a convention this app honours, not a boundary Google enforces. The credential is
  local, `chmod 600`, never leaves the machine, and can be revoked instantly at the same page.

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
npm run build
scripts/install-agents.sh
```

This renders `launchd/*.plist.template` into `~/Library/LaunchAgents` and registers both agents
with `launchctl bootstrap gui/$(id -u)`. It is safe to re-run. It refuses to register an agent
whose `dist/` entry point does not exist yet, so build first. `--no-load` writes the plists without
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

<http://127.0.0.1:8787> (or your `port`). It binds loopback only and has **no authentication, by
design**: anything on this Mac can reach it, and nothing else can.

| Page | Shows |
|---|---|
| `/` | Parcels in flight, with a refresh-now button. |
| `/parcel/:id` | Full event timeline, pickup location and deadline, editable label and postcode. |
| `/history` | Archived and delivered parcels; filter by carrier, text, date. |
| `/attention` | Unparsed mail awaiting a carrier and number; dormant parcels. |
| `/health` | Per-carrier last-ok / last-error, and ingest health. |
| `/add` | Add a parcel by hand. |

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
- `poll` polls the active parcels and sends notifications. It exits 0 even when a carrier is down;
  that is recorded as health, not as a crash. **It does not read the mailbox**: mail ingest runs only
  in the scheduled entry point, `node dist/poll.js` (which is what launchd runs).
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
| GLS | Owed: whether `rstt029` includes `history` or only `progressBar`; which `addresses[]` entry is the parcel shop (needs a captured `INPICKUP` record). |
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
  `messages`, `carrier_health`, `raw_responses`, `ingest_status`, and a few bookkeeping tables.
  Every parcel ever tracked stays there; archiving only hides it from the in-flight list.
- `data/mail/` holds the raw `.eml` files, `0600` inside a `0700` directory.
- Back up by copying `data/parcels.db` (and its `-wal`/`-shm` siblings, or use `sqlite3 .backup`).

## Troubleshooting

- **IMAP connects but finds nothing:** the label is not ticked "Show in IMAP"; see step 3 above.
- **Carrier shows `gated` on /health:** the carrier is blocking us. That is always treated as an
  alarm, unlike `not_found`, which is normal for a brand-new number and never an error.
- **No notifications:** run `node dist/cli.js notify-test` and read which mechanism it used.
- **Empty or strange output from `node`:** you used a bare `node`; use the absolute path.
