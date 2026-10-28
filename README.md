# Parcel tracker

A self-hosted parcel tracker for one Mac and one user. It finds your parcels in a
Gmail label, polls the Slovak and Czech carriers for status, and tells you with a macOS
notification when something is out for delivery or waiting at a pickup point. A local web
page is the read surface. Nothing runs off this machine and nothing is forwarded anywhere.

Carriers: Slovenská pošta, Packeta, GLS, SPS, DPD SK, and DHL — which is
[tracked from its mail alone](#dhl-and-other-email-only-carriers) rather than polled.
(123Kuriér is excluded: the company is defunct.)

The full design and its rationale are in
[`docs/superpowers/specs/2026-10-26-parcel-tracker-design.md`](docs/superpowers/specs/2026-10-26-parcel-tracker-design.md).

## Install

On a fresh Mac, from a real Terminal window:

```sh
git clone https://github.com/Mathiasko/parcels.git && cd parcels
scripts/setup.sh
```

`setup.sh` is idempotent, needs **no sudo**, and never overwrites an existing `config.json`, so
re-running it is always safe. `scripts/setup.sh --config-only` writes just the config and stops.

### What the script checks, and what it will install

| | |
|---|---|
| **macOS** | Required. The scheduler is launchd and the notifications are macOS notifications; there is no other-platform path. Refuses to continue. |
| **Node 24+, with npm** | The only thing the app needs that macOS does not ship. If it is missing or too old and Homebrew is present, the script **offers to run `brew install node`**. |
| **git** | Reported, never required. The app runs fine without it; only `scripts/update.sh` needs it, to pull. Install with `xcode-select --install`, or `brew install git`. |
| **terminal-notifier** | Optional. The script **offers to install it** via Homebrew. Without it, notifications fall back to `osascript`: they appear, but with no app identity and no click-through. |
| **Homebrew** | Reported, never installed. See below. |
| **A compiler** | Not needed. `better-sqlite3` ships prebuilt macOS binaries for Intel and Apple Silicon. |

Both prompts can be answered without a terminal: `PARCELS_INSTALL_NODE=1` and
`PARCELS_INSTALL_EXTRAS=1`.

**The script will not install Homebrew**, and this is deliberate rather than an omission. Installing
it creates `/opt/homebrew`, edits your shell profile and asks for sudo — a system-wide change that an
installer someone handed you has no business making on its own. It prints the command instead:

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

A test asserts the script only ever *prints* that line, never runs it.

### What no script can do for you

These need a browser, a GUI prompt or a password, and the script lists them when it finishes.

1. **Gmail credentials.** On the dashboard open `/settings`, paste an App Password from
   <https://myaccount.google.com/apppasswords> (2-step verification must be on first), Save, then
   press **Test mail connection**. That answer is the only thing that proves ingest works — a wrong
   password or a label hidden from IMAP otherwise looks exactly like "no new mail".
2. **The Gmail filter.** Import [`gmail-filter.xml`](gmail-filter.xml) (Settings → Filters and
   Blocked Addresses → Import filters) and tick **Also apply filter to matching conversations**:
   import alone labels nothing that has already arrived. Then Settings → Labels → tick **Show in
   IMAP** for the `parcels` label. Add your own shops' domains to the filter while you are there.
3. **The hostname** (optional), which edits `/etc/hosts` and `pf` and so needs a password:

   ```sh
   sudo scripts/install-hostname.sh
   ```

   That gives you <http://parcels.local:8787> instead of a port number.
4. **Notification approval** (optional, one-time). From a real Terminal window run
   `terminal-notifier -title x -message y` and approve the macOS prompt. Check which mechanism is
   live with `node dist/cli.js notify-test`.

Updating an installed copy:

```sh
scripts/update.sh --check     # is anything new? changes nothing
scripts/update.sh             # fast-forward, npm ci, rebuild, reload the agents
```

It refuses to run on a dirty working tree (naming the files) and refuses a divergent branch rather
than merging it; see [Updating](#updating-and-schema-changes). `/health` shows which version and
commit is actually running.

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

## Build and test by hand

`scripts/setup.sh` does the first three of these for you; these are the individual steps, for
development.

```sh
npm install        # use /Users/you/.nvm/versions/node/v24.21.0/bin/npm, see above
npm run build        # tsc, then copies src/db/schema.sql into dist/
npm test             # 780+ tests, no network, no launchd, no real config.json
npm run typecheck
```

The shell scripts are tested too: `test/install-agents.test.sh` renders the plists into a temp
directory, and `test/setup.test.sh` exercises `setup.sh` and `update.sh` against a temp config and a
throwaway clone. Both run under `npm test` through a small `.test.ts` wrapper so they cannot rot.

## Configure

`scripts/setup.sh` writes a `config.json` for you if there is none, asking only for the postcode and
leaving the mail account to `/settings`. By hand it is a copy of the example. Either way the file
holds a secret, so lock it down; it is gitignored, as is all of `data/`.

```sh
cp config.example.json config.json
chmod 600 config.json
```

(Delete the `imap` block from the copy until you have real credentials: an `imap` block full of
placeholders makes the poller fail against Gmail every hour. No block at all is the clean "no mail
account configured" state, and it is what `setup.sh` writes.)

After that first file exists, **`/settings` edits it for you** — the postcode, the notifier, the map
preview and the whole `imap` block, with a **Test mail connection** button that says in one line
whether mail ingest actually works. Saving validates the result with the same rules `loadConfig`
applies and writes the file atomically at `0600`, keeping any key it does not recognise, so the page
cannot leave behind a `config.json` that stops the app from starting. `port` and `dbPath` are shown
there read-only: the server is already listening and the database is already open, so those two still
need an edit by hand and a restart.

The web server reflects a save at once. The poller is a separate process that re-reads `config.json`
at the start of every run, so a change reaches mail ingest and the carriers at the next hourly poll.

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

It is also **incremental**: see [Only the new mail is read](#only-the-new-mail-is-read).

**Set it up on `/settings`, and prove it with the Test mail connection button.** Every way this can
go wrong is otherwise silent: an App Password that was revoked surfaces three polls later on
`/health`, a label that is not ticked "Show in IMAP" is indistinguishable from "no new mail", and a
filter that labels nothing looks exactly like an empty label. The button turns all of that into one
sentence. It connects with the settings as **saved** (not as typed), opens the mailbox with
`EXAMINE`, counts what is in it, and answers with one of:

| Answer | Means |
|---|---|
| `Connected — you@gmail.com, the label parcels has 79 messages` | Everything works. Ingest has all it needs. |
| `Connected, nothing to read — the label exists, and it is empty` | Not a fault. The filter (step 2) is not matching anything yet. |
| `Authentication failed` | The App Password is wrong or revoked. Make a new one; the page links to it. |
| `The mailbox parcels is not there` | Step 3 was skipped: the label is not shown in IMAP (or the name is misspelled). |
| `Could not reach imap.gmail.com on port 993` | Network, DNS or TLS. Nothing was authenticated, so the password is not in question. |
| `No mail account is configured` | There is no `imap` block. Not an error: parcels are added by hand. |

The App Password is **write-only** on that page: it is never rendered back into the HTML, never put
in a URL, and is stripped out of any error text before it is shown. The field shows `(set)` or
`(not set)`, and submitting it empty keeps the stored one, so the other fields can be edited without
retyping it.

Setup, in this order:

1. **Turn on 2-step verification**, then create an App Password at
   <https://myaccount.google.com/apppasswords>. Paste it into the App Password field on `/settings`
   (or write it into `config.json` as `imap.pass`).
   (IMAP is always on in Gmail; there is no enable toggle any more.)
2. **Import [`gmail-filter.xml`](gmail-filter.xml)**, the filter that fills the label. In Gmail:
   **Settings, Filters and Blocked Addresses, Import filters**, choose the file, and **tick "Also
   apply filter to matching conversations"** before you confirm it. Import by itself labels nothing
   that has *already* arrived — labels do apply retroactively, but only if you tick that box, and an
   empty label looks exactly like a broken connection. The filter's only action is **Apply the label**
   `parcels`; it never forwards anything.

   **The whole query is in ONE field, and it has to stay that way.** Gmail's filter *form* has
   separate From / Subject / Has-the-words boxes and it **ANDs them together**, so a filter built as
   `From: (the carrier domains)` plus `Subject: (odoslaná)` matches **nothing at all** — no single
   message satisfies both — and it fails exactly like a filter that is simply not matching yet. The
   shipped file is one OR-expression in `hasTheWord`, with no `from:` or `subject:` operator inside
   it: bare terms match anywhere in the message, the sender address included. If you edit it in the
   Gmail UI afterwards, keep every term in **Has the words**. `test/gmail-filter.test.ts` pins this.

   **Add your own shops' domains**, because the filter covers e-shop dispatch wording but cannot
   know where you shop. A filter matching only carrier domains (`packeta.sk`, `dpd.sk`,
   `gls-group.eu`, ...) never labels the shop's own "your order has been dispatched" mail, and that
   mail is often the *first* notice of a parcel, days before the carrier writes, and sometimes the
   only one. Gmail ignores diacritics (`odoslana` matches `odoslaná`) but does **not** stem, so the
   word forms are listed one by one (`odoslana`, `odoslane`, `expedovana`, `expedovane`, ...); add
   forms, and `mtbiker.sk`-style domains, in the same `OR` chain.

   The app can use that shop mail: when a sender is not a carrier it looks for a **carrier named in
   the mail together with a labelled tracking number of that carrier's shape** (for example
   `Číslo balíka: 1234567890` next to "GLS"). Both are required; a mail that only names a carrier (an
   order confirmation saying the delivery method is GLS) goes to needs-attention, never to a parcel.

   The filter deliberately has **no "never send it to Spam" action**. "Your parcel is waiting" is one
   of the most-copied phishing templates in this region, and exempting a query this broad from the
   spam filter would be a bad trade. Mail this labels that is not a parcel is stored and then left
   alone; see [What reaches the attention page](#what-reaches-the-attention-page).
3. **Make the label visible to IMAP. This is the step that catches everyone.** Gmail hides labels
   from IMAP by default. Go to **Settings, Labels** and tick **Show in IMAP** for `parcels`.
   If you skip this the app connects fine, authenticates fine, and reports an empty folder — which
   is exactly what `Test mail connection` tells you apart from a real one.
4. **Save the mail connection** on `/settings` (host `imap.gmail.com`, port 993, your address, the
   label name), then **press Test mail connection** and read the answer. The file is written `0600`
   for you. Writing the `imap` block into `config.json` by hand and `chmod 600 config.json` does the
   same thing, with nothing to confirm that it worked.

Notes on behaviour:

- The first run over a long label does not poll dead parcels: a parcel whose newest mail is older
  than 30 days is created already archived (never polled, status left `unknown`) and shows up under
  History.
- Mail that cannot be parsed, or that names several different numbers, is never dropped. If anything
  in it says it is about a parcel it lands on the **Needs attention** page (`/attention`), where one
  click assigns a carrier and number; if nothing does, it is stored and ignored. See
  [What reaches the attention page](#what-reaches-the-attention-page). Mail on the page that is
  simply junk (a verification notice with no tracking number in it) can be **dismissed**, one at a
  time or in bulk: see [Clearing the attention queue](#clearing-the-attention-queue).
- Deleting a parcel (`/parcel/:id`) removes it with its events, stored carrier responses and pickup
  reminder, but **not** the emails it came from: those are unlinked and marked parsed. The ingest
  dedupes by Message-ID, so deleting the message rows would let the next poll recreate the parcel.
- If ingest fails three runs in a row you get one notification per outage, and the Health page
  shows the last error. A revoked App Password does not fail silently.
- Raw messages are kept as `data/mail/<id>.eml` (files `0600` in a `0700` directory), except for
  dismissed ones, whose copy is deleted (see [Clearing the attention queue](#clearing-the-attention-queue)).
  After a parser change, `node dist/cli.js reprocess` re-runs extraction over stored messages that
  produced no parcel, without needing the mail on the server.
- An App Password is not scope-limited by Google: it can read and send as the whole account. The
  label scope is a convention this app honours, not a boundary Google enforces. The credential is
  local, `chmod 600`, never leaves the machine, and can be revoked instantly at the same page.

### Only the new mail is read

Each run remembers the **highest UID** it read in the mailbox and fetches `<lastUid+1>:*` next time,
instead of enveloping the whole label and discarding what it already knew. The cost of a run is then
what arrived since the last one, not what the label holds: on a label of 783 messages this turned a
whole-dashboard refresh from about **165 seconds into well under a second** when there is no new mail.
The state lives in the `imap_state` table, one row per account and mailbox.

The things that keep that safe, each of which has a test:

- **UIDVALIDITY.** A stored UID means nothing unless the server still reports the same `UIDVALIDITY`
  for that mailbox — that value *is* the server's promise that the numbering has not been reused. If
  it changed, every stored UID is meaningless and the mailbox is **read in full** and the watermark
  replaced. If the server does not report one at all, no watermark is ever stored and every run is a
  full read, exactly as before.
- **One account, one mailbox.** The row is keyed by `user host:port` *and* mailbox name. The same
  label name reached through a different login is a different mailbox with unrelated UIDs.
- **Message-ID dedupe is unchanged.** The range is an optimisation on top of it, not a replacement:
  `messages.message_id` is still `UNIQUE`, and a message inside the range that is already stored
  costs one envelope and no body download.
- **Retroactively labelled mail still arrives.** Gmail assigns a message a *new, higher* UID when a
  label is applied to it, so three-year-old mail that has just been labelled appears **above** the
  watermark. (That is also what makes the Gmail filter's "apply to matching conversations" work.)
- **The watermark only moves on a run that finished.** A run that threw mid-fetch, that lost the
  connection while downloading a body, or in which any message failed to store (a full disk, an
  unwritable `data/mail`) leaves it where it was, so the next run fetches that mail again. A message
  that failed to store has no row and is not "already seen"; skipping it would lose it silently.
- **Nothing new is never an error.** When `UIDNEXT` (or an `EXISTS` of 0) already proves there is
  nothing above the watermark, no `FETCH` is issued at all — which is the only behaviour that is the
  same on every server, because `<lastUid+1>:*` is a *range* and some servers answer it with their
  highest message while others refuse it outright. Both are handled anyway: anything at or below the
  watermark is dropped, and a server that refuses an empty set with `BAD Invalid messageset` is read
  as "no new mail". Any other failure, or a failure after real messages have arrived, is still a
  failure — a dead connection must never read as an empty mailbox.

To force a full re-read (there is no command for it; this is not something that should be needed):

```sh
sqlite3 data/parcels.db "DELETE FROM imap_state"
```

### What reaches the attention page

A message reaches `/attention` only when there is **evidence that it is about a parcel**. Everything
else is stored and ignored: no row is deleted, nothing is dropped, only the *visibility* changes.

This is not a nicety. **Gmail labels conversations, not messages.** A shop sends one thread per
order and only one message in it is about shipping, so one match drags the whole thread onto the
label:

```
Alza order 562638869                 MTBIKER order 1410452
  "Už to chystáme"                     "Objednávka ... pripravená na prevzatie"   <- real
  "Pripravené v AlzaBoxe"   <- real    "Objednávka č. 1410452"
  "Ďakujeme za objednávku"             "Daňový doklad k platbe"
  "Informácie o objednávke"            "Faktúra k objednávke"
```

No Gmail query can prevent that — it is a property of how labels work — and three rounds of
tightening the filter did not: the last one still delivered 56 of 58 new messages to the attention
page. An invoice on a page that exists to surface real problems is not a problem to solve, it is a
question the user cannot answer.

Any **one** of these is enough to make a message a question (`parcelEvidence` in
`src/ingest/extract.ts` is the single definition; the page, the poll summary and the tests all read
it):

| Signal | Example |
| --- | --- |
| A known **carrier sender** | anything from `packeta.sk`, `dpd.sk`, `gls-group.eu`, ... |
| A **carrier named** in the subject or body | "Doručí GLS", "Odoslané cez Packeta" |
| A **distinctive tracking-number shape**, or a bare-digit number *labelled* as a parcel number | `Z 000 0000 001`, `EB629066058SK`, `JJD...`, `Číslo zásielky: 1930144672` |
| **Shipping wording in the SUBJECT** | "Objednávka ... odoslaná", "Pripravené v AlzaBoxe", "Your parcel is on its way" |
| The message **could not be read at all** | empty or malformed bytes |

Two deliberate exclusions, each of which would otherwise undo the whole thing:

- **Bare digits alone are not a tracking number.** `\d{10,12}` is also the shape of Alza's own order
  numbers (`1052281846`), of a variable symbol and of a phone number. A bare-digit number counts
  only when a "parcel number" style label introduces it, or when the mail also names the carrier.
- **Shipping wording counts in the subject only, never in the body.** Alza prints "Doprava -
  AlzaBox" and "môžete vyzdvihnúť" in the footer of every mail it sends, invoices included.

The bias is one-sided on purpose: a false ignore hides a real parcel, a false show costs one dismiss
click. So anything unreadable is shown, an over-size message (which has no body to judge) is shown,
and all of the signals are ORs with no veto anywhere.

**Why a message was ignored is recorded**, so "where did my email go" is answerable without the
mailbox:

```sh
sqlite3 -readonly data/parcels.db \
  "SELECT received_at, from_addr, subject, ignored, parse_note FROM messages
   WHERE subject LIKE '%faktúra%' ORDER BY id DESC LIMIT 20"
```

`ignored = 1` with `parse_note` "ignored: no sign of a parcel in this message" means it was never a
question. `ignored = 0` with "no tracking number found in this message (**it names a carrier**)"
means it was one, and says which signal made it so.

An ignored message is **still reprocessed**. That is the difference between ignoring and dismissing:
`reprocess` selects on `parsed_ok = 0 AND parcel_id IS NULL` and does not look at `ignored`, so an
ignored message comes straight back as a parcel the first time a parser can read it, while a
dismissed one (`parsed_ok = 1`) never does. Ignoring is a decision about what to *show*, taken with
today's parser — not a decision about the message.

The poll log says how many were ignored, so the number is visible rather than silently swallowed:

```
polled 3 parcel(s), 1 new event(s), mail: 58 new, 2 parcel(s) created, 1 need attention, 55 ignored (no sign of a parcel)
```

Upgrading an existing database leaves every stored message at `ignored = 0`, so nothing disappears
from the page behind your back. Run `node dist/cli.js reprocess` once to apply the rule to the mail
already on disk.

### Clearing the attention queue

`/attention` holds the mail that yielded no parcel, and on a long-lived label that is mostly
newsletters the filter caught — hundreds of them. Each item has its own **Dismiss**, and above the
list there is a collapsed **Clear this queue (N emails)** disclosure holding two bulk actions:

- **Dismiss all N emails.**
- **Dismiss *n* from `sender`**, for each sender with more than one message waiting, busiest first.
  Most of the queue is usually a handful of senders, so this is the one people actually want. The
  match is the **exact sender address**, never the domain: `gmail.com` can hold two unrelated people.

Opening the disclosure *is* the confirm step (the site has no JavaScript, so there is no dialog), and
every label states the exact number it would dismiss. A bulk action covers **only the messages the
page listed**: mail ingested between the page being drawn and the button being pressed gets a higher
row id and survives.

Dismissing is `parsed_ok = 1` with no parcel, which takes a message off the page and out of every
future `reprocess` run. (An *ignored* message is the other thing entirely: `parsed_ok = 0` with
`ignored = 1`, off the page and out of both dismissals but still reprocessed. A bulk "Dismiss all N"
clears exactly the N you were looking at and never touches mail you were never shown.) The row itself is **never deleted** — it is the Message-ID dedupe key, and
without it the next mail check would ingest the same junk again — but the stored `data/mail/<id>.eml`
**is** deleted and `raw_path` cleared, because nothing will ever read it again. That is where the
disk goes: on the author's machine 132 MB of the 139 MB in `data/mail` belonged to mail waiting on
`/attention`. The mail itself stays in your Gmail label; only this machine's copy goes.

## DHL, and other email-only carriers

DHL is tracked from its own mail and is **never polled**. Its tracking API needs a key, and the
developer app for it is in `revoked` status, so there is no key to use; scraping is excluded because
`dhl.com` answers automated requests with a stated prohibition and an active block. What the app can
do is read DHL's dispatch and pickup mail, which it already receives.

What that means for you:

- A DHL parcel appears when a DHL mail (or a shop's dispatch mail that names DHL) arrives, and its
  timeline is the **mail's own words**, with no status word beside them — status never comes from
  prose. Each later mail about that parcel adds a line.
- It has **no "Refresh this parcel" button**, because there is nobody to ask. The dashboard's
  **Refresh now** does help: it reads the mailbox, which is exactly how a DHL parcel updates.
- It never goes dormant and never appears as stale or broken. On `/health` it is listed as
  `by email · not polled`, and it is left out of the "N of M carriers reporting" count — a carrier
  nobody asks can be neither ok nor failing.
- Auto-detection accepts only the **prefixed** number forms: `JJD…`, `JVGL…`, `3S…` and the long
  `000…` form (16 digits or more). A DHL Express number is ten plain digits, which is also GLS's
  shape, so accepting it would make every ten-digit number ambiguous and break GLS detection; add
  such a parcel with the carrier chosen explicitly (`--carrier dhl`, or the picker on `/add`).

This is also the honest fallback for any carrier whose key is missing, revoked or out of quota, and
for any shop nobody writes an adapter for.

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

## Updating, and schema changes

```sh
scripts/update.sh --check     # reports whether an update is available; changes nothing else
scripts/update.sh             # git pull --ff-only, npm ci, rebuild, re-bootstrap both agents
```

It prints the version and commit before and after, and says plainly when there was nothing to
update (in which case it builds nothing and does not touch launchd). It is **safe by default**, which
means it refuses rather than guesses:

| It stops when | Because |
|---|---|
| the working tree is dirty | An update must not be the thing that eats a local edit. It names the files. |
| the branch has diverged from its upstream | It only ever fast-forwards. A merge commit made by an update script is one nobody reviewed. |
| the branch tracks nothing, or the directory is not a checkout | There is nowhere to pull from. An unpacked tarball is replaced by hand, keeping `config.json` and `data/`. |

`config.json`, `data/` and `dist/` are gitignored, so none of them can make the tree dirty and none
of them is touched by a pull. **There is no migration step to run**: the schema migrates itself when
the database is next opened, which the poller and the web server do on start.

`--check` is the only part that reaches the network, and all it does is `git fetch` — remote-tracking
refs move, the working tree and the branch do not.

The version and commit that are actually running are shown at the bottom of `/health`, so a bug
report can say which code it is about. It reads `package.json` and `git rev-parse` once at startup,
and says `unknown` rather than failing if the checkout is not a repo.

### Schema changes

The database is versioned with `PRAGMA user_version`, and `src/db/migrate.ts` holds an ordered,
append-only list of migrations.

- A new **table** needs no migration: `schema.sql` is applied with `CREATE TABLE IF NOT EXISTS` on
  every open, so an existing database gains it for free.
- A new **column**, a changed constraint or a data fix-up needs **both**: the column in `schema.sql`
  (so a fresh database is born correct) *and* a migration (so an existing one catches up). Write one
  without the other and the next open fails, naming the column.
- A fresh database is stamped at the latest version and runs nothing, because `schema.sql` already
  describes the newest shape and replaying history over it would fail on the first duplicate column.
- A database created before migrations existed has no stamp, and is treated as the baseline.
- Each migration runs in its own transaction: a failure leaves the database at the last version that
  did succeed, never half-way through one.

Never edit or renumber a migration that has shipped. Somebody's database has already recorded that
it ran, and changing it alters what their database contains without telling them.

The one amendment that rule allows is an **activity-log line**: migrations 2 and 3 now record what they
rewrote (see [The activity log](#the-activity-log-what-changed-and-what-you-did)). That changes no data
and no outcome - it adds a diagnostics row describing the change the migration was already making - so
a database that ran one of them before the log existed simply has no line, and there is nothing it got
wrong and nothing to backfill.

## Run it on a schedule (launchd)

```sh
scripts/install-agents.sh
```

This renders `launchd/*.plist.template` into `~/Library/LaunchAgents`, runs `npm run build`, and
registers both agents with `launchctl bootstrap gui/$(id -u)`. It is safe to re-run. `dist/` is
build output (it is gitignored), and the agents run it, so the installer refreshes it every time.
`scripts/setup.sh` and `scripts/update.sh` both end by running this; running it directly is for when
you have changed the code yourself. If the build fails the script stops before touching launchd.
`--no-load` writes the plists only, without building or touching launchd.

Which `node` goes into the plists is discovered, not hard-coded — `scripts/lib/node.sh`, shared with
`setup.sh` and `update.sh` so the Node that installs the dependencies is the Node the agents run.
`PARCELS_NODE=/path/to/node` overrides it.

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

<http://127.0.0.1:8787> (or your `port`), and <http://parcels.local:8787> once the hostname is installed
(below). It binds loopback only and has **no authentication, by design**: anything on this Mac can
reach it, and nothing else can.

### The parcels.local hostname

```sh
sudo scripts/install-hostname.sh              # --uninstall to reverse
```

Must be run from a real Terminal, because it needs a password prompt. It edits **`/etc/hosts` and
nothing else**, backing it up first, marking its lines with `# >>> parcels tracker` sentinels, and
finishing by curling the dashboard to prove the result. The URL becomes
<http://parcels.local:8787>.

Both address families are written, and that matters more than it looks. macOS resolves a `.local`
name through mDNS as well as `/etc/hosts`, and with only an A record it waits about five seconds for
an AAAA answer that never comes — on every connection. With `::1` present the v6 attempt is refused
instantly (nothing listens there; the server binds `127.0.0.1` only) and the client falls straight
back to v4. Measured here: **5.01s to connect v4-only, 0.005s with both**.

**It no longer redirects port 80.** An earlier version used a `pf` rule so the URL could omit the
port, since a process without root cannot bind a port below 1024. That rule
(`rdr pass on lo0 ... -> 127.0.0.1 port 8787`) also made pf swallow **direct** connections to 8787:
the documented fallback URL stopped accepting connections at all — not refused, dropped, so clients
hung until they timed out. Putting a trivial server on 8787 with the app stopped reproduced it
exactly, which is what proved the packet filter was at fault rather than the application. Re-running
the script removes that setup, including the boot job, wherever an older version installed it.

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
| `/attention` | Unparsed mail that looks like a parcel, awaiting a carrier and number or a dismissal; dormant parcels. Mail with no sign of a parcel is stored but not listed — see [What reaches the attention page](#what-reaches-the-attention-page). |
| `/health` | Per-carrier last-ok / last-error, ingest health, the recent-runs log, and the running version and commit. |
| `/add` | Add a parcel by hand. |
| `/settings` | The editable half of `config.json`, and the mail connection test. |

### Refresh now, and the recent-runs log

**The button does not hold the page open.** A refresh polls the carriers *and* reads the mailbox, and a
first run downloads a whole mailbox, so it can take minutes. `POST /refresh` therefore opens a row in
`poll_runs`, starts the run in the background and redirects immediately to `/?run=<id>` (or back to the
parcel, for a single-parcel refresh). That page shows a spinner, says what the run is doing and how long
it has been going, and **re-requests itself every 3 seconds** with `<meta http-equiv="refresh">` until
the run finishes - at which point the meta tag is gone and the usual result banner is there instead.

There is still **no JavaScript anywhere**: a meta refresh is markup, not script, so the CSP
(`default-src 'none'`) is untouched. The spinner is CSS, it is deliberately *not* the signal blue (blue
means "this needs you", and a run that is working needs nothing), and under
`prefers-reduced-motion: reduce` it stops and stays a still ring.

Two things keep that reload loop finite:

- **A double click starts no second run.** The in-memory `refreshing` guard still holds, and the second
  click is answered with the run already in flight, so it lands on the spinner rather than on an error.
- **A killed process does not leave it "running" for ever.** The row records when the run started, and
  any run still unfinished after `RUN_STALE_MS` (10 minutes, `src/db/poll-runs.ts`) is closed as failed
  by the next page view - `/`, `/parcel/:id` and `/health` all reap before they read. That is also the
  cap on the reloading: a page only asks again while a run is genuinely in progress. A long run that
  *does* finish after being reaped corrects its own row, so the guess never outlives the answer.

A background run that throws is recorded as a failed run and logged; it never takes the server down.

**The log is of the app's activity, not of button presses**: the hourly poller, `cli poll` and the web
refresh all write a row, so `/health` → *Recent runs* answers "is it working?" rather than "did my click
work?". Each row carries when the run started (absolute time and relative age), what started it, and the
same one-line summary that goes to `data/poll.log` - or, for a run that failed, the error, washed warn so
it cannot be skimmed past. The table is **bounded to the newest 50 rows**, trimmed on every insert, like
`raw_responses`.

### The activity log: what changed, and what you did

*Recent runs* answers "is the poller working?". It cannot answer **"where did my parcel go?"** - and
that is the question a real fault asks. A GLS parcel once left the dashboard silently: it was marked
`delivered` while it was in fact sitting in a locker, because `DELIVEREDPS` ("handed to a ParcelShop")
was mapped to `delivered`. That was only diagnosed by reading the live database within hours, and the
evidence was already perishing - the status is overwritten by the next poll, and `raw_responses` keeps
five bodies per parcel. A day later, on somebody else's machine, there would have been nothing to find.

So **every change to a parcel's status, and everything you do here, is recorded**, in one table
(`activity_log`) shown on `/health` → *Recent activity* and carried in the support bundle. The line
that would have made that incident self-diagnosing reads:

```
2026-10-28T09:00:00.000Z  poller  14  #36 gls: ready_for_pickup -> delivered (raw DELIVEREDPS)
```

- **The transition, not the state.** A status is logged only when it really moved. The poller rewrites
  every parcel's row every hour, and logging the unchanged ones would bury the handful that matter.
- **Who caused it.** A change found by the hourly poller says `Poller`, one found by **Refresh now**
  says `In the app`, one made by `cli poll` says `Command line`, and one made by a schema upgrade says
  `Upgrade` - with the `poll_runs` row it happened in, where there was one, so the change and the run
  that caused it can be read side by side. Migration 3 merged two parcels on the author's machine and
  said nothing; it is a line now.
- **What you did.** Dismissing mail (how many, and whether it was one sender or the whole queue),
  deleting a parcel (and the status it was in), assigning an email to a parcel, saving settings, and
  pressing refresh. "Where did my parcel go" is answerable with *you deleted it on Tuesday*: the log
  holds **no foreign key** to `parcels`, precisely so that it outlives the row it talks about.
- **Nothing in it is private.** Ids, counts, carriers, canonical statuses and words from this app's own
  vocabulary - never a tracking number, parcel name, shop, address, locker code, mail subject or mail
  address. A bulk dismissal records *that* it was one sender and **not which one**: a sender is a mail
  address, it says who you correspond with, and the count is what answers the question. Settings
  records **which fields changed and never their values**, which is why `imap.pass` is a safe thing to
  see on that page. The carrier's raw status string is the one free-form field, because `DELIVEREDPS`
  is the whole point of the log; where it leaves the machine it goes through an allow-list that admits
  a code and refuses a sentence, since a carrier's sentence can name the place a parcel is waiting.
- **It can never break anything.** Writing it is wrapped, the way the mail-ingest status is: a
  diagnostics row that cannot be stored is logged to stderr and dropped. No poll and no button press
  has ever failed because of it.
- **Bounded to the newest 2000 entries**, trimmed on every insert. Far more than the 50 poll runs,
  because a run row is written every hour whether or not anything happened while these are written
  only when something did - on the author's machine about a hundred a week, so roughly five months of
  history, in under half a megabyte.

### Reminders while a parcel is waiting

A parcel left at a pickup point is mentioned again **twice a day, at 08:00 and 15:30** local, until
it is collected or its status changes. The banner says where it is waiting, and the deadline if the
carrier gave one.

- The poller's launchd schedule carries a **15:30 slot** on top of the hourly runs for exactly this
  reason; without it the afternoon reminder would arrive at 16:00, since every other run is on the
  hour. Re-run `scripts/install-agents.sh` after changing the slots.
- Only the **newest passed slot** can fire. A Mac asleep all day wakes to one reminder, not to the
  whole day's slots at once, and a slot that was missed cannot fire retroactively.
- A transition banner counts: a parcel that became ready at 10:00 already told you, so the 08:00 slot
  it fell inside is marked spent rather than repeating an hour later. The 15:30 one still arrives.
- Sent slots are keyed by local date, so the rows expire by themselves and yesterday can never
  suppress today.

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

Carrier ids: `posta`, `packeta`, `gls`, `sps`, `dpd`, `dhl`.

- `add` normalises the number and auto-detects the carrier when exactly one matches; otherwise it
  asks for `--carrier`.
- `poll` is exactly the run launchd does (both are built by the same function): read the mailbox label,
  create the parcels it names, poll active parcels, send notifications. It exits 0 even when a carrier
  is down; that is recorded as health, not as a crash.
- `probe` is the only command that hits a live carrier on purpose, and it prints the **raw
  response bodies**. It is the tool for confirming a carrier's real response shape against a
  first real parcel. It refuses `dhl`: an email-only carrier is never asked anything, so there is
  no request to show.
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
| DHL | Not polled at all (email only), so nothing is owed here. If a key is ever issued, three things need a real parcel: the not-found shape, whether DHL Parcel SK/CZ is in the API at all, and how a pickup looks — the canonical vocabulary has no pickup state. |

## Your data

Everything lives under `data/` (gitignored):

- `data/parcels.db` is **plain SQLite** (WAL mode). Query it directly, read-only is safest while
  the poller runs:

  ```sh
  sqlite3 -readonly data/parcels.db \
    "SELECT carrier, status, count(*) FROM parcels GROUP BY 1, 2 ORDER BY 1, 2"
  ```

  Tables: `parcels`, `events` (status history, UTC with the carrier's original string kept),
  `messages`, `carrier_health`, `raw_responses`, `ingest_status`, `geocode_cache`, `poll_runs` (the
  run log behind `/health` → *Recent runs*, newest 50), `activity_log` (every status change and every
  action you took, newest 2000; see [The activity log](#the-activity-log-what-changed-and-what-you-did)),
  `imap_state` (how far each mailbox has been read; see
  [Only the new mail is read](#only-the-new-mail-is-read)), and a few bookkeeping tables.
  Every parcel ever tracked stays there; archiving only hides it from the in-flight list.
- `data/mail/` holds the raw `.eml` files, `0600` inside a `0700` directory. A dismissed message's
  file is deleted, so this directory holds mail that became a parcel, mail still waiting on
  `/attention`, and ignored mail — whose copy is kept deliberately, because that is what lets
  `reprocess` turn it into a parcel later.
- `data/tiles/` holds cached OpenStreetMap map tiles, same `0600`/`0700` posture. Fetched during a
  poll, never when a page is viewed; see [Pickup point maps](#pickup-point-maps) for what leaves this
  machine and how to turn it off.
- Back up by copying `data/parcels.db` (and its `-wal`/`-shm` siblings, or use `sqlite3 .backup`).

## Troubleshooting

- **Anything to do with mail:** press **Test mail connection** on `/settings` first. It names the
  failure (password, label not shown in IMAP, host unreachable, label empty) instead of leaving you
  to guess from an empty in-flight list.
- **IMAP connects but finds nothing:** the label is not ticked "Show in IMAP"; see step 3 above.
- **"Is it missing mail that is in the label?"** Unlikely but checkable: `sqlite3 data/parcels.db
  "SELECT * FROM imap_state"` shows how far each mailbox has been read, and
  `DELETE FROM imap_state` makes the next run read the label in full. A changed `UIDVALIDITY` already
  triggers that by itself; see [Only the new mail is read](#only-the-new-mail-is-read).
- **`/settings` says the config file cannot be loaded:** `config.json` was hand-edited into something
  `loadConfig` rejects, and the poller is failing on it too. The page names the field; correcting it
  there and saving writes a file that loads.
- **Carrier shows `gated` on /health:** the carrier is blocking us. That is always treated as an
  alarm, unlike `not_found`, which is normal for a brand-new number and never an error.
- **No notifications:** run `node dist/cli.js notify-test` and read which mechanism it used.
- **Empty or strange output from `node`:** you used a bare `node`; use the absolute path.
- **"Did the refresh do anything?"** `/health` → *Recent runs*. Every poll is there, whatever started
  it, with what it did or why it failed. A row that says `failed` is the answer; a row that says
  `running` and is more than ten minutes old cannot happen - it is closed as failed on sight.
- **"Where did my parcel go?"** `/health` → *Recent activity*. Every status change and every action
  taken on these pages is there, newest first, with what caused it - including the deletion of a
  parcel, which the log deliberately outlives. It is also the first place to look when a parcel reads
  as `delivered` and is not: the line carries the carrier's own raw status string beside the
  transition, which is exactly what diagnosed the `DELIVEREDPS` fault.
- **"Which version is this?"** The bottom of `/health`. If it says `unknown`, `package.json` could
  not be read; if it shows no commit, the directory is not a git checkout.
- **`update.sh` refuses to run:** read the first line. A dirty tree lists the files; a divergent
  branch is yours to resolve (`git log --oneline --left-right main...@{u}`). Neither is a bug.
