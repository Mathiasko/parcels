# Self-hosted parcel tracker — design spec

**Date:** 2026-10-26
**Status:** approved design, ready for implementation planning
**Host:** single Mac (macOS 27.0.1, Darwin 27.0.0, arm64 / M1 Pro), single user, no auth

---

## 1. Purpose

Learn that a parcel is out for delivery, or waiting in a pickup box, from a macOS
notification — without ever typing a tracking number, and without visiting a
carrier's website.

### Success criteria

1. A parcel appears in the app by itself, from a forwarded shipping email.
2. A status change produces a native macOS notification within one poll cycle of
   the carrier publishing it.
3. When a parcel is ready for pickup, the notification names **where** to collect
   it and, where the carrier supplies one, **by when**.
4. Every parcel ever tracked stays queryable — status history, carrier, and
   elapsed delivery time — in a plain SQLite file.
5. When a carrier adapter breaks, the user is told; the other adapters keep working.

### Non-goals

- Multi-user, authentication, or remote access. Localhost only.
- Shipping, label printing, or any sender-side function.
- Carriers outside the Slovak/Czech set below.
- Cloud components. Nothing runs off this Mac.
- Mobile app. Notifications are the mobile surface.

---

## 2. Scope

### Carriers

| Carrier | Status | Access route |
|---|---|---|
| Slovenská pošta | in scope | Official public REST API |
| Packeta / Zásilkovna | in scope | Keyless consumer JSON endpoint |
| GLS | in scope | Keyless `rstt029`/`rstt028` widget endpoints |
| SPS (Slovak Parcel Service) | in scope | `rest.mysps.sk` + static `Api-Key` |
| DPD SK | in scope | myDPD guest OAuth chain |
| 123Kuriér | **excluded** | Company defunct: depots closed Nov 2023, bankruptcy Feb 2025 |

### Surfaces

- **Notifications** — the primary surface, via `terminal-notifier`.
- **Local web page** — `http://localhost:<PORT>`, the read surface for the
  in-flight list, per-parcel timelines, searchable history, and the
  needs-attention queue.
- **Manual add** — fallback for parcels email ingest misses.

---

## 3. Decisions and their rationale

Decisions taken during design, recorded so they are not silently revisited.

| Decision | Rationale |
|---|---|
| Own HTTP adapters, no headless browser | All five carriers are reachable with plain `fetch`. A browser would add ~400 MB and more failure modes for no gain. |
| No third-party aggregator | Not needed; keeps parcel data local. Adapter interface stays narrow enough that an aggregator-backed adapter could be dropped in for any carrier that defeats us. |
| Runs on this Mac only | User's choice. Accepts that polling pauses during sleep, in exchange for zero hosting and zero cloud. |
| Dedicated mailbox + Gmail forward rule | App credentials are scoped to a throwaway mailbox; the main inbox is never exposed. |
| `terminal-notifier` for notifications | The only mechanism giving click-to-URL, its own app identity, and banner coalescing without a paid Apple Developer certificate. `osascript` is kept behind the same interface as a zero-dependency fallback. |
| DPD included as a normal adapter | User's explicit choice, with the fragility understood and accepted. |
| GLS open endpoint primary, official API documented as fallback | Works today with no signup. Official API (500 calls/day free) is the documented migration if GLS closes it again. |
| Hourly polling, 07:00–21:00 | See §9. **Assumption:** user initially said 08:00–18:00; widened by one hour earlier and three later to catch early out-for-delivery scans and Packeta's 21:00 external-carrier sync. Single plist edit to change. |
| SQLite, not a database server | Personal volume (tens of parcels/year). The file *is* the archive. |

---

## 4. Architecture

One Node/TypeScript project, two launchd agents, one SQLite database.

```
~/Desktop/parcels/
  src/
    poll.ts              entry: short-lived poll run
    server.ts            entry: long-lived web UI
    carriers/            one adapter per carrier + registry
    ingest/              imap.ts, extract.ts
    core/                diff.ts, backoff.ts, canonical.ts
    notify/              notifier.ts (interface), terminal-notifier.ts
    db/                  schema.sql, migrations, queries
    web/                 server-rendered pages
  test/
    fixtures/            recorded carrier responses
  data/
    parcels.db           SQLite (WAL)
    mail/                raw .eml archive
  docs/superpowers/specs/
```

### Process model

**Agent 1 — poller.** `local.parcels.poller`, `StartCalendarInterval`,
short-lived, exits after each run. Wrapped in `caffeinate -i` so the Mac cannot
sleep mid-request. **The only writer to the database.**

**Agent 2 — web UI.** `local.parcels.web`, `KeepAlive`, binds
`127.0.0.1:<PORT>`. **Read-only against the database.**

Rationale: one writer makes SQLite concurrency a non-problem; a web-layer crash
cannot stop tracking; a hung carrier request cannot take down the UI.

### Poll run sequence

1. Fetch `UNSEEN` mail from the dedicated mailbox over IMAP.
2. Extract carrier + tracking number + merchant; insert new parcels.
3. Select parcels due for polling per the backoff tiers (§9); group by carrier.
4. Call each adapter. Slovenská pošta batches all its numbers into one request;
   others are per-parcel with a delay between requests.
5. Diff returned events against stored events; append new ones.
6. Emit notifications for un-notified meaningful changes.
7. Update `carrier_health`; commit; mark mail seen; exit.

Mail is marked seen **only after commit**, so a crash re-processes rather than
loses a parcel.

### Accepted consequences

- **Polling stops when the user logs out.** A user LaunchAgent lives in the
  `gui/<uid>` domain, which exists only for a logged-in GUI session. A locked
  screen is fine. The alternative — a LaunchDaemon — cannot post notifications at
  all, which would force a daemon/agent split not worth its complexity here.
- **Worst-case staleness is one sleep period, not one hour.** This Mac sleeps after
  1 minute on battery and never on AC; it has been asleep ~41% of the time since
  boot. A status change may wait until the lid opens, when launchd's coalesced
  catch-up run fires immediately.
- **launchd supplies a bare `PATH`** (`/usr/bin:/bin:/usr/sbin:/sbin`). Homebrew's
  `node` and `terminal-notifier` are not on it. All binaries are referenced by
  absolute path or via an explicit `EnvironmentVariables` block in the plist.

---

## 5. Carrier adapter contract

```ts
type CanonicalStatus =
  | 'pre_transit' | 'in_transit' | 'out_for_delivery' | 'ready_for_pickup'
  | 'delivered'   | 'failed_attempt' | 'returning' | 'returned'
  | 'problem'     | 'unknown'

interface FetchInput  { number: string; postalCode?: string }

type FetchResult =
  | { ok: true;  number: string
      status: CanonicalStatus; statusRaw: string; statusDetail?: string
      events: ParcelEvent[]
      pickup?: PickupPoint
      retainedTill?: Date
      raw: unknown }
  | { ok: false; number: string
      reason: 'not_found' | 'needs_postcode' | 'gated' | 'transport' }

interface ParcelEvent {
  occurredAtRaw: string      // carrier's original string, kept verbatim
  occurredAtTz:  string      // e.g. 'Europe/Bratislava'
  occurredAt:    Date        // normalised to UTC
  status: CanonicalStatus
  code?: string
  description: string
  location?: string
}

interface PickupPoint {
  kind: 'post_office' | 'zbox' | 'parcelshop' | 'locker' | 'unknown'
  name?: string; street?: string; city?: string; postalCode?: string
  lat?: number; lon?: number
}

interface CarrierAdapter {
  id: 'posta' | 'packeta' | 'gls' | 'sps' | 'dpd'
  matches(number: string): boolean     // shape test, manual entry only
  needsPostalCode: boolean
  batchSize: number                    // posta: 100, others: 1
  fetch(inputs: FetchInput[]): Promise<FetchResult[]>
}
```

### Universal adapter rules

1. **`not_found` is not an error.** A freshly announced parcel legitimately returns
   404 (Packeta), empty events (Slovenská pošta), or `PARCEL_NOT_FOUND` (DPD). It
   must not trip health alarms.
2. **`gated` is distinct from `not_found`, and is the key health signal.** 401 from
   SPS = key rotated. 403 or an HTML body from GLS = endpoint closed. 400/401 from
   DPD = Firebase credential moved. Each means *the adapter is broken* and the user
   is notified — rather than a parcel silently freezing forever.
3. **Canonicalise status; keep raw.** Unmapped carrier codes map to `unknown` and
   are logged, never guessed. Full raw responses are retained so a mapping error is
   fixable retroactively without re-fetching.
4. **Never key status off localised human text.** Always a code or a machine field.
5. **Treat a non-2xx body as possibly-not-JSON.** Wrap parsing; honour
   `Retry-After`; back off on 429/5xx.

---

## 6. Per-carrier specification

All endpoints below were verified live on 2026-10-26 unless marked INFERRED.
Where INFERRED, the shape comes from the carrier's own client code or official
documentation plus at least one independent implementation; each is flagged for
confirmation against the first real parcel.

### 6.1 Slovenská pošta — VERIFIED, official API

```
GET https://api.posta.sk/tracking?q={codes}&l=sk&p=1
```

- Officially documented ("Manuál pre implementáciu T&T REST API", effective
  2025-07-01, linked from posta.sk developer docs). **No API key, no account, no
  registration.** `Access-Control-Allow-Origin: *`.
- `q` takes **up to 100 comma-separated numbers** — the whole active set in one
  request per poll. `p=1` includes the `postOffice` object (needed for pickup
  location).
- **Match results by each entry's own `number` field, never by array position.**
- `status: "invalid_format"` means *malformed code*, not *not found*. A valid but
  unscanned parcel is `status: "ok"` with `events: []`. Do not collapse these.
- Error bodies may not be JSON (a missing `q` returns an Erlang tuple, not JSON).
- **`localDate` is naive Slovak local time with no offset.** Parse as
  `Europe/Bratislava`. Mis-parsing as UTC is a silent 1–2 hour DST-dependent bug.
- **`stateCode` has no failure state.** The six values are `received`, `transit`,
  `notified` (ready for pickup), `delivered`, `returning`, `returned`. Delivery
  failure, loss, and damage appear **only** in the separate `detailCode` field
  (~140 values). `failed_attempt` / `problem` mapping must key off `detailCode`:
  e.g. `ANZ` addressee not reached, `P-NOL` uncollected/returned, `ZSTR` lost,
  `ZZNC` destroyed, `REKL` under complaint. Map the handful that matter; an
  **unmapped `detailCode` falls through to the `stateCode` mapping**, never to
  `unknown` — `detailCode` appears on many ordinary events, so erasing a known
  `stateCode` because its detail code is unrecognised would degrade healthy
  parcels to `unknown`.
- `retainedTill` is the authoritative pickup deadline — the only carrier that
  supplies one. Drives the 48-hour reminder. A **date-only** value means the
  parcel can still be collected during that day, so it is interpreted as the
  **end** of that day in `Europe/Bratislava`, not midnight at its start;
  midnight would fire the reminder and expiry up to 24 hours early.
- Number format: `/^[A-Z]{2}\d{9}[A-Z]{2}$/` (UPU/S10). Check digit is mod-11 on
  the 8 significant digits, weights `8,6,4,2,3,5,9,7`, `check = 11 - (sum mod 11)`
  with `10 → 0` and `11 → 5`. **The API does not enforce it** — validate locally to
  catch typos only. A non-`SK` suffix returning `ok` does *not* imply Slovenská
  pošta (it accepts inbound foreign S10 numbers).
- `events[]` field names, from the official manual corroborated by one
  independent implementation: `stateCode` (always present), `localDate`
  (ISO 8601, naive local), `detailDescription` and `detailCode` (both optional),
  `retainedTill` (optional hold-until date), and `postOffice` (optional, only
  under `p=1`) with exactly `{name, street, city, postcode, districtStamp}`.
  **Slovenská pošta supplies no coordinates** — there is no `lat`/`lon` on
  `postOffice`, so a posta pickup point never yields a map link.
- The populated `events[]` shape is INFERRED; the envelope is VERIFIED.
  **Confirm `localDate` has no offset and that `postOffice` appears under `p=1`
  against the first real parcel.**
- **Do not call `https://api.posta.sk/private/web/track`** — undocumented, `private`
  in the path, not the supported contract.

### 6.2 Packeta — VERIFIED endpoint, INFERRED success shape

```
POST https://tracking.packeta.com/api/getPacketById/{Zxxxxxxxxxx}/{locale}
```

- No body (`Content-Length: 0`), **no headers required**, no key, no cookie.
  Verified with an empty `User-Agent`.
- **Must be POST.** `GET` returns 405.
- 404 = unknown or not yet scanned (a normal early state).
- `item.packetStatusId` is a **string**. Known values: `997` to-be-processed,
  `1` waiting, `31` on the way, `2` ready for pickup, `3` delivered, `21` lost.
  **This list is incomplete** — map unknown ids to `unknown` and log the raw value;
  display `item.packetStatus` (the carrier's own sentence) alongside.
- **Do not cross-map with Packeta's merchant `statusCode` vocabulary.** They
  collide: `3` is *delivered* here but *prepared for departure* there; `31` is *on
  the way* vs *courier code added*; `21` is *lost* vs *cancelled but consigned*.
- `trackingDetails[]` entries carry **only `text` and `time`** — no per-event code,
  no separate location field. Treat as display-only; derive status from
  `packetStatusId`. Order is not guaranteed; sort by `time`.
- `time` is naive `YYYY-MM-DD HH:MM:SS` — parse as `Europe/Prague`.
- `item` field names, from two independent implementations, one of which reports
  live confirmation against real delivered parcels: `barcode`, `packetStatusId`
  (string), `packetStatus` (the carrier's own sentence), `sender`,
  `branchAddress`, `courierId`, and `trackingDetails[]` of `{text, time}`.
  **`branchAddress` is a plain string**, not an object — e.g.
  `"Z-BOX Example Street 1"`. There is **no** delivered-at field, **no** ETA,
  **no** weight, and the recipient is never named.
- `item.sender` carries the shipper's name, which is a free source for a parcel's
  merchant label on manually-added parcels. Not wired up in v1.
- Pickup location: `item.branchAddress` (includes Z-BOX). No deadline available —
  omit rather than invent. Since the address is one unstructured string with
  inconsistent formatting, do **not** attempt to parse street/city out of it;
  both existing third-party clients tried and gave up.
- Number format: `/^Z\d{10}$/` after stripping non-alphanumerics (labels print
  `Z 123 4567 890`). **No check digit exists**, so the shape test cannot catch a
  typo; a 404 is the definitive check.
- **Fallback if the JSON closes:** the tracking page is Nuxt **server-rendered**
  and embeds the same payload in `__NUXT_DATA__`. VERIFIED.
- Packeta syncs state with external carriers **only three times a day: 07:00,
  13:00, 21:00 CEST.** Polling more often will not produce fresher data for
  handed-off parcels.
- Merchant API is **not usable**: credentials are bound to a sender/e-shop
  contract and scope to that sender's own packets. No recipient-side credential
  exists.

### 6.3 GLS — VERIFIED (including a live 200)

```
GET https://gls-group.com/app/service/open/rest/SK/sk/rstt029?match={numbers}&caller=witt002&millis={ms}
GET https://gls-group.com/app/service/open/rest/SK/sk/rstt028/{number}?postalCode={zip}&caller=witt002&millis={ms}
```

- Keyless, cookieless, **no headers required** (verified with no UA/Accept/Referer).
- `rstt029` = status overview, **no postcode needed**. `rstt028/{number}` = full
  record **including `history[]`**, requires the delivery postcode.
- **`rstt001` is dead** (303 → a registration page). Every blog post and library
  citing it is stale. `rstt030`/`rstt031` return 403 for Slovakia;
  `rstt005`/`rstt006` need a `subsessionid` only emailed links have.
- `{CC}/{lang}` is a **display switch, not a data partition** — the SK path returns
  parcels from other countries with Slovak status text.
- Status from `progressBar.statusInfo` (locale-independent): `PREADVICE`,
  `PROCESSING`, `INTRANSIT`, `MULTIPACK`, `INWAREHOUSE`, `INDELIVERY`,
  `DELIVEREDPS`, `INPICKUP`, `DELIVERED`, `NOTDELIVERED`, `NOTPICKEDUP`,
  `RETURNED`, `CANCELLED`, `UNAVAILABLE`. **Never** key off `evtDscr` text.
- `history[]` is **newest-first**.
- **Dummy-parcel trap:** GLS sometimes answers **200 with a fabricated parcel
  carrying every event code** for invalid numbers. Reject responses whose event
  count exceeds a sane threshold (~50) rather than trusting them.
- Error codes: `E000` expired/unknown, `E206` unknown, `E609` postcode mismatch
  (→ fall back to `rstt029`), `E800`/`E801` not in index. A 403 or an HTML body
  means **gated**, not *not found*.
- Pickup location: `parcelShop` plus `addresses[]` with `latitude`/`longitude`.
- Number format: 11 digits, optionally a 12th check digit; also 12-digit and
  8-char alphanumeric Track ID forms. Check digit: weights `3,1,3,1…` from the
  right, `10 - ((sum + 1) mod 10)`, `10 → 0`. A bare 11-digit number is **not
  distinctive** — do not infer GLS from it alone.
- Reusable test numbers: `312175332275` (live 200 confirmed), `UF662377471` (GLS
  Italy, full delivered history).
- Documented fallback if closed again: `https://api.gls-group.eu/public/v1/tracking/references/{ids}`,
  HTTP Basic, self-service signup at `dev-portal.gls-group.net`, 500 calls/day
  free. *Unverified whether a non-merchant can register.*

### 6.4 SPS — VERIFIED endpoint, INFERRED success shape

```
POST https://rest.mysps.sk/tracking/getShipmentTrackAndTrace
Api-Key: <static key from the public JS bundle>
Content-Type: application/json
{"shipmentNr": "703..."}
```

- The `Api-Key` header is **required and enforced** (401 without it) but is a
  build-time constant shipped in public JS — no account needed.
  **Scrape it at startup** from the current content-hashed
  `https://mysps.sk/assets/index-*.js` (read `https://mysps.sk/` first to find the
  filename), with the known literal as fallback. **Treat 401 as rotation → `gated`.**
- Strip dashes from the number before sending.
- **The response code lives in the body, not the status line**: a not-found is
  HTTP 200 with `{"status":false,"code":404,...}`.
- Status from `data.shipmentStatus`: `receivedInfo`, `takenByCarrier`, `inTransit`,
  `delivering`, `placedInParcelShop`, `delivered`, `undelivered`. Per-event
  `states[].statusDescr` is free-text Slovak from their upstream system and is not
  enumerated anywhere — display only.
- Also useful: numeric `statusCodeX`, where `40` = delivered.
- Supporting endpoints, same host and header: `GET /tracking/validate-shipment-num/{n}`
  (cheap existence check), `GET /packageRegexes/get` (live accepted-number regexes),
  `GET /lang/get/sk` (status → Slovak label map).
- Number format for routing: **`/^703\d{11}[0-4]\d$/` only.** SPS's own regex list
  includes UPS (`1Z…`) and DHL (`JJD14902…`) patterns because it carries inbound
  partner parcels — using the full list would misroute UPS and DHL numbers to SPS.
- No check digit identified. Client-side length gate is `>= 14`.
- Pickup location: `placedInParcelShop` status indicates it; the address is not in
  the tracking payload. Pickup-point directory is public at
  `https://balikomat.sps-sro.sk/alternativneMiesta.xml` — resolve name → address
  from there if needed.
- `data.states[]` success shape is INFERRED from their React render code.
  **Confirm against the first real `703…` number; log the raw JSON that first time.**
- Avoid the `backend.sps-sro.sk/api/tracking/*` family — two of its three
  endpoints currently return 500/502.

### 6.5 DPD SK — VERIFIED live, highest fragility

Three-step chain; steps 1–2 are cacheable.

```
1. POST https://firebaseinstallations.googleapis.com/v1/projects/consignee-portal/installations
   POST https://firebaseremoteconfig.googleapis.com/v1/projects/959401347543/namespaces/firebase:fetch
   → entries.basic_dpd_token

2. POST https://www.dpdgroup.com/concept/webservice/oauth/token?grant_type=client_credentials
   Authorization: Basic <basic_dpd_token>
   → access_token (expires_in ~18986s ≈ 5h)

3. POST https://www.dpdgroup.com/concept/webservice/v10/parcels/details/{14-digit}
        ?parcelType=INCOMING&businessUnit=DPD-SK&lang=sk
        &continueWithoutVerification=false&dataForVerification={postcode}
   Authorization: Bearer <access_token>
   (empty body)
```

- **Must be POST with an empty body.** `GET` returns 405.
- **Cache the OAuth token** (~5h). Re-running the chain per lookup is wasteful and
  the behaviour most likely to attract rate limiting.
- **Implement the Firebase step; do not hardcode the Basic credential.** It lives in
  Firebase Remote Config and DPD can rotate it at will. Hardcoding is the single
  most likely cause of silent future breakage. Refetch on 400/401.
- **Send the postcode.** Without it you get `parcelHistory` only — milestones with
  no city. With it you additionally get `parcelEvents[]` (scan code, depot, city,
  PUDO id, proof-of-delivery URL), sender/receiver, weight, and the pickup pass.
- Not found: HTTP 400 (or 404) with `exceptionType: "PARCEL_NOT_FOUND"`. A 400 with
  `PROVIDE_ZIP_CODE` means the postcode was rejected — **retry once without it**
  rather than treating the parcel as missing. 503 means DPD is down, not an answer.
- Milestones (`description`): `ORDER_CREATED`, `PARCEL_HANDED`, `IN_TRANSIT`,
  `AT_DELIVERY_CENTER`, `PARCEL_OUT_FOR_DELIVERY`, `AVAILABLE_FOR_COLLECTION`,
  `UNSUCCESSFUL_DELIVERY_ATTEMPT`, `RETURN_TO_SENDER`, `DELIVERED`, `OTHER`.
  Prefer `parcelEvents[].eventType` scan codes where present.
- Three mapping traps: `UNSUCCESSFUL_DELIVERY_ATTEMPT` is a retry, **not terminal**
  — keep the parcel active. `PARCEL_HANDED` is re-dated when another country's DPD
  unit takes over, so appearing *after* later milestones means hand-off, not
  acceptance. `ORI`/`SPL` occur on both sides of the origin depot and name no
  stage. Notice-only codes that must **not** set status: `SPE`, `MSDLO`, `MSDLX`,
  `MIDLI`, `MIA`, `MII`, `ENA`.
- `eventDateAndTimeZoneId` is present (e.g. `Europe/Bratislava`) — use it.
- Number format: `/^\d{14}([0-9A-Z])?$/`. Check character is ISO/IEC 7064
  MOD 37,36 over the 14 digits. **A bare 14-digit number cannot be attributed to
  DPD** — the shape is shared with other DPD networks, BRT, SEUR, Ciblex and DHL
  eCommerce UK, and a parcel keeps the depot prefix of the network that sent it.
  Resolve by probing, or by a matching 15th check character.
- The HTML tracking page is **Cloudflare-challenged** (403, `cf-mitigated: challenge`)
  and the old `tracking.dpd.de/rest/plc/...` path is **dead**. There is **no
  fallback** if Cloudflare extends to the API path.
- `dpdgroup.com/robots.txt` is a blanket `Disallow: /`. Accepted by the user as a
  deliberate decision (§3); mitigated by conservative polling and backoff.
- INFERRED and unconfirmed: the postcode-verified response shape and the scan-code
  vocabulary. **Re-run step 3 with and without `dataForVerification` against the
  first real SK parcel and diff.**

### 6.6 robots.txt summary

| Host | Directive | Handling |
|---|---|---|
| `posta.sk` / `api.posta.sk` | empty `Disallow:` / none | unrestricted |
| `tracking.packeta.com` | empty (1 byte) | unrestricted |
| `gls-group.eu/.com` | only `/survey/` | unrestricted |
| `rest.mysps.sk` | `Disallow: /` | on-demand + aggressive caching, no tight loops |
| `www.dpdgroup.com` | `Disallow: /` | as above; user-accepted decision |

For the two `Disallow: /` hosts: user-initiated lookups of one's own parcels at
tens-per-year volume is not crawling, but the directive is a standing reason to
poll conservatively, cache hard, and never retry-storm.

---

## 7. Data model

SQLite, WAL mode. One writer (the poller), one reader (the web UI).

```sql
CREATE TABLE parcels (
  id              INTEGER PRIMARY KEY,
  carrier         TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  label           TEXT,              -- user-editable display name
  merchant        TEXT,              -- parsed from email
  postal_code     TEXT,              -- for GLS/DPD; defaults from config
  status          TEXT NOT NULL,     -- CanonicalStatus
  status_raw      TEXT,
  status_detail   TEXT,              -- e.g. posta detailCode
  pickup_kind     TEXT,
  pickup_name     TEXT,
  pickup_street   TEXT,
  pickup_city     TEXT,
  pickup_zip      TEXT,
  pickup_lat      REAL,
  pickup_lon      REAL,
  retained_till   TEXT,              -- pickup deadline, where supplied
  first_seen_at   TEXT NOT NULL,
  last_polled_at  TEXT,
  last_changed_at TEXT,
  delivered_at    TEXT,
  source          TEXT NOT NULL,     -- 'email' | 'manual'
  source_message_id TEXT,
  archived_at     TEXT,
  UNIQUE (carrier, tracking_number)
);

CREATE TABLE events (
  id              INTEGER PRIMARY KEY,
  parcel_id       INTEGER NOT NULL REFERENCES parcels(id),
  occurred_at     TEXT NOT NULL,     -- UTC ISO
  occurred_at_raw TEXT NOT NULL,     -- carrier's original string, verbatim
  occurred_at_tz  TEXT NOT NULL,     -- zone it was interpreted in
  status          TEXT NOT NULL,
  code            TEXT,
  description     TEXT,
  location        TEXT,
  dedup_hash      TEXT NOT NULL,
  first_seen_at   TEXT NOT NULL,
  notified_at     TEXT,
  UNIQUE (parcel_id, dedup_hash)
);

CREATE TABLE messages (
  id           INTEGER PRIMARY KEY,
  message_id   TEXT UNIQUE,
  received_at  TEXT,
  from_addr    TEXT,
  subject      TEXT,
  raw_path     TEXT,                 -- data/mail/<id>.eml
  parsed_ok    INTEGER NOT NULL,
  parse_note   TEXT,
  parcel_id    INTEGER REFERENCES parcels(id)
);

CREATE TABLE carrier_health (
  carrier              TEXT PRIMARY KEY,
  last_ok_at           TEXT,
  last_error_at        TEXT,
  last_error_kind      TEXT,         -- 'gated' | 'transport' | 'parse'
  last_error_detail    TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  notified_at          TEXT
);

CREATE TABLE raw_responses (
  id         INTEGER PRIMARY KEY,
  parcel_id  INTEGER REFERENCES parcels(id),
  carrier    TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  body       TEXT NOT NULL
);
```

### Invariants

1. **`UNIQUE (parcel_id, dedup_hash)` makes polling idempotent.** Carriers return
   full history on every call. `dedup_hash = sha256(occurred_at_raw, code,
   description)`. Re-polling inserts nothing, so the coalesced catch-up run after a
   long sleep is safe to run arbitrarily often.
2. **`events.notified_at` makes notification exactly-once.** A notification is sent
   only where it is null, and it is set in the same transaction. A crash between
   poll and notify re-notifies at most genuinely un-announced events.
3. **Events are append-only.** `parcels.status` comes from the adapter's
   authoritative top-level `status`, **not** from the newest event. Deriving it
   from events breaks for carriers whose events are prose-only and carry no
   per-event code (Packeta, SPS): their stored events can never be restamped, so
   a status change that arrives without a new event would be reverted on every
   poll, leaving a row whose status contradicts its own `status_raw` and pickup
   point. It also blocks the retroactive mapping fix that rule 3 of §5 promises.
   `delivered_at` is still taken from the newest event's timestamp when the
   authoritative status is `delivered`.
4. **`raw_responses` is bounded** — keep the last N per parcel, prune older.
5. **Timestamps:** `occurred_at` is UTC; `occurred_at_raw` and `occurred_at_tz` are
   retained so a parsing error is diagnosable rather than a silent DST drift.

---

## 8. Email ingest

### Setup (user-performed, documented in the README)

1. Create a dedicated mailbox, e.g. `parcels@<domain>`.
2. Add a Gmail filter forwarding shipping-looking mail to it.
3. Put IMAP host, user, and password in a local config file, `chmod 600`, gitignored.

### Pipeline

1. Connect over IMAP TLS; fetch `UNSEEN`.
2. Write each raw message to `data/mail/<id>.eml`; insert a `messages` row.
3. **Stage 1 — carrier from sender domain.** This is what rescues carrier
   detection: a bare 14-digit number is ambiguous, but mail from `dpd.sk` is not.
   Because Gmail forwarding wraps the original, the original sender must be read
   from the forwarded headers, not the envelope sender.
4. **Stage 2 — number by carrier-specific regex**, plus merchant name from the
   forwarded subject/sender (so a card reads "Alza", not a number).
5. Insert the parcel; link it to the message.
6. Mark the message seen **only after commit**.

### Behaviours

- **Nothing is silently dropped.** Unparsed mail lands in a **needs-attention**
  list in the web UI with the subject and sender shown, where carrier and number
  are assigned in one click. Shipping-email formats change constantly; silent
  failure would make misses invisible and undermine the whole premise.
- **Ambiguity is resolved by probing, not guessing.** If a number matches several
  carriers and the sender gives no hint, try each candidate — `not_found` is a
  cheap definitive negative.
- **A message can be reprocessed** from its stored `.eml` after a parser fix,
  without needing the mail to still exist upstream.
- **Email is untrusted input.** Subjects and sender names reach the notification
  layer. They are passed as **process arguments**, never interpolated into a shell
  or AppleScript string; control characters are stripped and lengths capped. Links
  in mail are never fetched. Message size is capped; attachments are ignored.

---

## 9. Scheduling and polling policy

### launchd

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.parcels.poller.plist
launchctl print     gui/$(id -u)/local.parcels.poller
launchctl kickstart -k gui/$(id -u)/local.parcels.poller
launchctl bootout   gui/$(id -u)/local.parcels.poller
```

- Domain is **`gui/<uid>`**, not `user/<uid>`. `launchctl load`/`unload` are legacy;
  use `bootstrap`/`bootout`.
- Plists must be user-owned and `chmod 644`.
- **`StartCalendarInterval`, never `StartInterval`.** Per `man launchd.plist`:
  `StartInterval` silently drops a firing missed during sleep, whereas
  `StartCalendarInterval` starts the job on the next wake and coalesces multiple
  missed intervals into one event. With this Mac asleep ~41% of the time, that is
  decisive. It also rules out `cron`, which skips sleep-missed invocations.
- `ThrottleInterval` defaults to 10s — relevant only when testing with
  `kickstart -k` repeatedly.
- Each run is wrapped in `caffeinate -i`.
- Optional refinement: compare `CLOCK_UPTIME_RAW` (excludes sleep) against
  `CLOCK_MONOTONIC` to measure how long the Mac slept since the last poll, and
  force a full refresh after a long gap.

### Schedule

Hourly on the hour, **07:00–21:00** — 15 `StartCalendarInterval` dictionaries.
Rationale: out-for-delivery scans land before 08:00; Packeta's external-carrier
sync runs at 07:00/13:00/21:00 CEST, and the 21:00 one is where evening Z-BOX
deposits appear — the most actionable notification the app produces.

### Per-parcel backoff

| Parcel state | Polled |
|---|---|
| `out_for_delivery` or `ready_for_pickup` | every slot |
| In transit, moved within 48h | every slot |
| In transit, no movement 2–7 days | every 3rd slot |
| No movement > 7 days | once a day |
| `retained_till` within 48h | every slot, regardless of movement |
| `delivered` / `returned` | never again |
| No events at all, > 30 days | mark dormant, stop polling |

Plus a **refresh-now** button in the web UI for on-demand fetching — which is also
how the two `Disallow: /` carriers stay polite.

---

## 10. Notifications

`terminal-notifier` (one `brew install`; signed and notarized, so it satisfies the
AMFI requirement that rejects ad-hoc-signed bundles). Behind a `Notifier`
interface, with an `osascript` implementation retained as a zero-dependency
fallback.

```sh
terminal-notifier -title "Ready for pickup — Alza" \
  -message "Z-BOX Hlavná 12, Žilina · collect by Fri 31 Oct" \
  -open "http://localhost:<PORT>/parcel/42" \
  -group "parcel-42" -sound Ping
```

### Fires on

- A canonical status transition.
- First appearance of a pickup location.
- A failed delivery attempt.
- A pickup deadline within 48 hours (once per parcel).
- An adapter entering `gated` (once per carrier until it recovers).

### Stays quiet on

- New events that do not change the canonical status. A parcel crossing four
  depots overnight is one "in transit", not four banners.
- Notice-only carrier codes (§6.5).

### Rules

- `-group parcel-<id>` so a parcel's new banner **replaces** its old one.
- If a single run would emit more than 4 notifications (typical after a long
  sleep), send **one summary** instead.
- All text is passed as process arguments — never interpolated into a shell or
  AppleScript string.
- `terminal-notifier` and `osascript` both exit 0 whether or not delivery
  succeeded; there is no error channel. Delivery is best-effort by design.

### Known macOS limits (verified)

- A plain CLI binary **cannot** post via the UserNotifications framework
  (`bundleProxyForCurrentProcess is nil`), and an ad-hoc-signed `.app` is rejected
  by AMFI. Real first-party notifications would need a paid Apple Developer
  certificate — out of scope.
- The `osascript` fallback posts as **"Script Editor"**, cannot click through to a
  URL, and cannot coalesce (anonymous identifier). Hence `terminal-notifier`.
- Focus/DND state is not readable (TCC-protected). Assume it is unknown.
- Notifications posted while the screen is locked are retained on the lock screen
  and in Notification Center.

---

## 11. Web UI

Server-rendered pages, no build step, no frontend framework. Bound to
`127.0.0.1`.

| Route | Content |
|---|---|
| `/` | In-flight parcels as cards: label, carrier, status, last event, pickup location and deadline when present. Refresh-now button. |
| `/parcel/:id` | Full event timeline, pickup details with an Apple Maps link where coordinates exist, raw-response viewer, editable label and postcode. |
| `/history` | Searchable archive: filter by carrier, merchant, date range; per-carrier median delivery time. |
| `/attention` | Unparsed emails awaiting carrier/number assignment; dormant parcels. |
| `/health` | Per-carrier last-ok, last-error, consecutive failures. |
| `/add` | Manual parcel entry: number, carrier (auto-detected or chosen), label, postcode. |

---

## 12. Error handling and health

| Condition | Handling |
|---|---|
| `not_found` | Normal. Increment an attempt counter; no alarm. Dormant after 30 days. |
| `needs_postcode` | Prompt in the UI; GLS falls back to `rstt029` for status only. |
| `gated` | `consecutive_failures++`; notify once per carrier; keep other carriers running. |
| `transport` (timeout, 5xx, 429) | Exponential backoff with jitter; honour `Retry-After`; no notification until 3 consecutive runs fail. |
| Parse failure | Store the raw response, mark the parcel `unknown`, log; do not crash the run. |
| One carrier failing | Never aborts the run. Each adapter is isolated; failures are per-carrier. |
| Unmapped status code | Map to `unknown`, log the raw value, display the carrier's own text. |

---

## 13. Security and privacy

- Localhost only; no authentication by design, nothing listens externally.
- IMAP credentials in a `chmod 600` config file, gitignored. Scoped to a dedicated
  mailbox, never the main inbox.
- Email content is untrusted: arguments not interpolation, control characters
  stripped, sizes capped, links never fetched.
- Parcel data never leaves the machine. No aggregator, no telemetry.
- The DPD Basic credential and the SPS `Api-Key` are public values from
  client-side code, not secrets — but they are fetched at runtime, not committed.
- `data/` and any config file are gitignored.

---

## 14. Testing strategy

- **Adapter tests against recorded fixtures.** Live error payloads for all five
  carriers are already captured, plus real GLS test numbers
  (`312175332275`, `UF662377471`). Each adapter is tested for: success parse,
  `not_found`, `gated`, malformed/non-JSON body, and unmapped status code.
- **Status mapping tests** per carrier, including the specific traps: Slovenská
  pošta `detailCode` → `failed_attempt`/`problem`; Packeta's colliding `3`/`31`/`21`;
  DPD's `UNSUCCESSFUL_DELIVERY_ATTEMPT` staying active and its notice-only codes;
  GLS's dummy-parcel rejection.
- **Timezone tests** proving naive carrier timestamps are interpreted in the
  carrier's zone, across a DST boundary.
- **Idempotency test:** polling the same fixture twice inserts events once and
  notifies once.
- **Diff/notification tests:** status transition fires; same-status new event does
  not; summary replaces >4 individual notifications.
- **Email extraction tests** over saved `.eml` samples, including a forwarded
  message where the original sender is in the wrapper, and an unparseable message
  landing in needs-attention.
- **Injection test:** a parcel label containing quotes, backslashes, and newlines
  passes through the notifier without breaking or executing.
- No live carrier calls in the test suite. A separate, manually-run
  `npm run probe -- <carrier> <number>` script exercises real endpoints and prints
  the raw response — the tool for the first-real-parcel confirmations in §15.

---

## 15. Assumptions and open items

Assumptions, correctable at review:

1. Polling window **07:00–21:00** hourly (user initially suggested 08:00–18:00).
2. Personal volume: tens of parcels per year, a handful in flight.
3. Manual add remains available as a fallback; "zero manual entry" is the default,
   not a prohibition.
4. `delivered` and `returned` are terminal; parcels with no events for 30 days go
   dormant.
5. One default postal code (the user's own) for GLS/DPD, overridable per parcel.

Confirmations owed against the first real parcel of each carrier, via
`npm run probe`:

| Carrier | To confirm |
|---|---|
| Slovenská pošta | `events[]` field names; `localDate` has no offset; `postOffice` appears under `p=1` |
| Packeta | `item` field names and `packetStatusId` values; whether `branchAddress` is absent for courier delivery |
| GLS | whether `rstt029` includes `history` or only `progressBar` |
| SPS | `data.states[]` field names; whether events carry a location field |
| DPD | the postcode-verified shape; diff of step 3 with and without `dataForVerification` |

Deferred, explicitly out of v1:

- GLS official API migration (documented in §6.3, not implemented).
- Menu bar item and Raycast extension (considered, not chosen).
- A signed `.app` for first-party notifications (needs a paid certificate).
- Any carrier beyond the five in scope.

---

## 16. Phasing

| Phase | Deliverable |
|---|---|
| 0 | **Done.** Carrier reconnaissance — findings are §6. |
| 1 | DB schema, canonical status model, adapter interface, Slovenská pošta adapter (official API, batched), manual add, CLI listing. Proves the core loop end to end. |
| 2 | Remaining four adapters with fixtures and mapping tests; carrier health. |
| 3 | launchd poller, backoff tiers, `terminal-notifier` notifications with coalescing and summaries. First real notification. |
| 4 | Web UI: in-flight, parcel timeline, history, health, refresh-now. |
| 5 | IMAP ingest, extraction, needs-attention queue, reprocessing. Closes the "zero manual entry" goal. |

Phase 1 is deliberately one carrier only — the one with a documented API — so the
core loop is proven against the most reliable surface before the fragile adapters
are added.
