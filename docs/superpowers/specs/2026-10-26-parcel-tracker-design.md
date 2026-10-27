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

1. A parcel appears in the app by itself, from the shipping email in the user's own mailbox (a Gmail label; nothing is forwarded).
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
| Read the main Gmail account, scoped to a label, strictly read-only | A Gmail filter labels shipping mail `parcels`; nothing is forwarded. The App Password is not scope-limited (see §8 for the accepted trade-off), so the ingest opens the mailbox read-only and never writes a flag. |
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

1. Read the `parcels` label over IMAP (read-only, no flag ever written); store messages not yet in the `messages` table; extract carrier + tracking number + merchant; insert new parcels. A failure here is recorded in `ingest_status` and never stops the carrier polling that follows.
3. Select parcels due for polling per the backoff tiers (§9); group by carrier.
4. Call each adapter. Slovenská pošta batches all its numbers into one request;
   others are per-parcel with a delay between requests.
5. Diff returned events against stored events; append new ones.
6. Emit notifications for un-notified meaningful changes.
7. Update `carrier_health`; commit; exit.

Mail is **never** marked seen (or touched at all). Each message is stored and placed in one transaction and
deduplicated on `messages.message_id`, so a crash or a failure on one message re-processes it on the next
run rather than losing a parcel.

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

### 6.3 GLS — VERIFIED (including a live 200 for a real parcel, 2026-10-27)

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
- `history[]` was **newest-first** in the one real capture (2026-10-27). The adapter does not rely on it:
  events are ordered by their own timestamp (ties keep the newest-first reading).
- **Dummy-parcel trap:** GLS sometimes answers **200 with a fabricated parcel
  carrying every event code** for invalid numbers. Reject responses whose event
  count exceeds a sane threshold (~50) rather than trusting them.
- **Error envelope, VERIFIED live.** The code is carried in **`lastError`**, not
  `exceptionCode`:
  `{"lastError":"E000","exceptionText":"Žiadne výsledky. …"}` (HTTP 404).
  A 403 body is `{"exceptionText":"Prístup zamietnutý!"}` with no `lastError`.
  A bad-input 400 is `{"fieldExceptions":[{"attribute":"zipcode","exceptionText":"…"}],"exceptionText":"…"}`.
- Error codes: `E000` expired/unknown, `E206` unknown, `E609` postcode mismatch
  (→ fall back to `rstt029`), `E800`/`E801` not in index. A 403 or an HTML body
  means **gated**, not *not found*.
- **Response shapes, CONFIRMED against a real in-transit parcel (2026-10-27, `cli probe`).**
  `rstt029` wraps its item(s) in `tuStatus[]`; **`rstt028` does not: it returns a bare object**
  `{referenceNo, postalCode, status, date, infos[], references[], progressBar, history[], tuNo, owners[],
  natSysOwnerCode, deliveryOwnerCode, emailNotificationCard}` with no `tuStatus` wrapper. The adapter
  normalises both to one internal item in `ask()`. (The earlier belief that `rstt028` was wrapped came from
  GLS's own minified client and was INFERRED; it was wrong.) Confirmed field detail:
  - `tuNo` and `referenceNo` are the parcel number. **A real GLS number is 10 digits** (`1234567890`);
    the shape check is `^\d{10,12}$`.
  - `progressBar.statusInfo` (`INTRANSIT` in the capture) is the status source;
    `progressBar.statusBar[]` is `{status, imageStatus, statusText, imageText}`.
  - `history[]` entries are `{date:"2026-10-27", time:"02:18:05", evtDscr, evtNo:"0.0", address:{city}}`:
    **`date` and `time` are separate fields**, joined by the adapter and read as `Europe/Bratislava`.
    **`address.city` can hold a country name** (`"Slovakia"`), not a city.
  - `references[]` is `{type, name, value}` with `type` `UNITNO` (the parcel number) and **`CUSTREF` (the
    e-shop's own order number)**. `infos[]` is `{type:"WEIGHT", name, value:"0.2 kg"}`.
    `natSysOwnerCode`/`deliveryOwnerCode` are e.g. `"SK01"`.
  - **Text fields contain HTML numeric entities** (`&#268;`, `&#237;`, ...); the adapter decodes them
    (`src/core/entities.ts`) for event descriptions, locations and pickup fields.
  - Known opportunity, deliberately NOT built: `CUSTREF` is a ready-made merchant/order label for a parcel
    found by number alone. `FetchResult` has no field for it (it survives only in the stored `raw`), and
    adding one touches the live poll/DB path.
  - Fields still only INFERRED from the client code, unconfirmed by a capture: `tuOwnerCode`,
    `signature{}`, `infoText`, `arrivalTime{}`, `addresses[]{type,name,blockNo1,postalCode,city,countryCode,
    country,latitude,longitude}`, `parcelShop{parcelShopID,...}`, `dateTimes[]`.
- **GLS's detail index is unreliable for freshly created parcels (observed live, 2026-10-27).** The same
  number returned a full `INTRANSIT` record, and **45 minutes later `E800` ("no results")**. This is why
  GLS's own dispatch mail says the status is updated "within 24-48 hours". The `not_found` mapping for
  `E000`/`E206`/`E800`/`E801` is therefore correct, and it is quiet by design: it must **not** be
  "fixed" into an alarm or a `transport` failure. A parcel that flips to `not_found` right after a good
  answer is GLS's index lagging, not the app breaking, and it recovers on a later poll.
- **No postal code available → degrade, do not refuse.** `rstt029` needs no
  postcode, so a GLS parcel without one still yields an authoritative status; only
  `history[]` is unavailable. Returning `needs_postcode` would be worse than
  useless: the orchestrator stops polling such a parcel entirely, so the app would
  refuse to track a parcel it can in fact track. Same for an `E609` mismatch —
  fall back to `rstt029` and keep the parcel live. **No v1 adapter returns
  `needs_postcode`**; the `FetchResult` variant and its orchestrator machinery are
  retained for a carrier that genuinely cannot answer without one.
- Pickup location: `parcelShop` plus `addresses[]` with `latitude`/`longitude`.
- Number format: **10, 11 or 12 digits** (the first real parcel, 2026-10-27, is 10); also 8-char
  alphanumeric Track ID forms. An 11-digit number optionally carries a 12th check digit (weights `3,1,3,1…`
  from the right, `10 - ((sum + 1) mod 10)`, `10 → 0`). A bare 10-12 digit number is **not distinctive**
  (a phone number is the same shape) — do not infer GLS from it alone. No other carrier's shape overlaps
  (Packeta needs a `Z`, DPD is 14 digits, Pošta and SPS are alphanumeric), so a 10-digit number detects as
  GLS and nothing else.
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
- Number format for routing: **two SPS-native forms**, both required.
  `/^703\d{11}[0-4]\d$/` **and** `/^SK[A-HJ-NP-Z0-9]{5}\d{2}[A-HJ-NP-Z0-9]{9}$/`
  (`SK` + 16 characters, 18 total). **VERIFIED 2026-10-27:** the real tracking
  number in the user's own SPS mail is `SK0TEST6000000000X`, which the live API
  answers in full — so an adapter matching only the `703` family rejects the
  format this user actually receives. Still **exclude** the UPS (`1Z…`) and DHL
  (`JJD14902…`) entries from SPS's published list, which exist only because SPS
  carries inbound partner parcels and would misroute other carriers' parcels.
- No check digit identified. Client-side length gate is `>= 14`.
- Pickup location: `placedInParcelShop` status indicates it; the address is not in
  the tracking payload. Pickup-point directory is public at
  `https://balikomat.sps-sro.sk/alternativneMiesta.xml` — resolve name → address
  from there if needed.
- **Response envelope and field names.** Every response is HTTP 200 with the real
  code in the body. Not found, VERIFIED live:
  `{"status":false,"code":404,"message":"Error getShipmentTrackAndTrace","data":{"errorData":""}}`.
  Missing key, VERIFIED live: HTTP **401** `{"status":false,"code":401,"message":"Unauthorized"}`.
  Success, INFERRED from their React render code:
  `{"status":true,"code":200,"message":"Success","data":{"shipmentStatus":"inTransit","showParcelShopStatus":false,"states":[{"time":"…","statusDescr":"…"}],"actions":{}}}`.
  Each `states[]` entry carries **only `time` and `statusDescr`** — no code, and no
  location field the mySPS UI displays. The known `Api-Key` literal is
  `6VS314WZ+YtFPrYqqV2EZAoxKJNIyr13JGKTWjlOy6jz5zWKr-C8ZnpCJ7ChvZfW`; the API base
  is published in `https://mysps.sk/static/script.js` as `api: 'https://rest.mysps.sk/'`.
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

**Exact request detail for the Firebase step, VERIFIED live.** Both Firebase calls
carry these headers: `X-Goog-Api-Key: AIzaSyDHMkUNUyUwFrQzKJhdC_J-L7QEwNUzwrc`,
`X-Android-Package: com.dpdgroup.chatbot.lemny.prod`,
`X-Android-Cert: 3872ACD98DE975F69C68CAF5119A5A1B2024B873`,
`Content-Type: application/json`. The Remote Config call additionally needs
`X-Goog-Firebase-Installations-Auth: <authToken from step 1>` and this body:

```json
{"appId":"1:959401347543:android:8d1a84133332291109e392",
 "appInstanceId":"<fid>","appInstanceIdToken":"<authToken>",
 "languageCode":"sk-SK","countryCode":"SK","platformVersion":"36",
 "appVersion":"3.79.14","packageName":"com.dpdgroup.chatbot.lemny.prod",
 "sdkVersion":"22.1.2","analyticsUserProperties":{}}
```

It returns `entries.basic_dpd_token`, whose observed value base64-decodes to
`myDPD Mobile App:<secret>`. Steps 2 and 3 carry
`User-Agent: myDPD/3.79.14 (Android)`, `Accept: application/json` and
`Content-Type: application/json`.

- **Must be POST with an empty body.** `GET` returns 405.
- **Cache the OAuth token** (~5h). Re-running the chain per lookup is wasteful and
  the behaviour most likely to attract rate limiting.
- **Implement the Firebase step; do not hardcode the Basic credential.** It lives in
  Firebase Remote Config and DPD can rotate it at will. Hardcoding is the single
  most likely cause of silent future breakage. Refetch on 400/401.
- **Send the postcode when you have one; degrade when you do not.** With no
  postcode, set `continueWithoutVerification=true` and accept `parcelHistory`
  only — milestones without cities. **Never return `needs_postcode`**: the
  orchestrator would stop polling the parcel entirely, and DPD can report on it
  perfectly well without one. Same for a `PROVIDE_ZIP_CODE` rejection. Without a
  postcode you get `parcelHistory` only — milestones with
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

### 6.6 DHL — RECONNOITRED 2026-10-27, API access REFUSED 2026-10-28

**The keyed API is not available to a personal applicant.** The request for
*Shipment Tracking - Unified* (Production Europe, 250/day) was rejected outright:

> "Sorry, access to the API you requested is rejected. For successful approval, please
> submit your request using a business-domain email address."

So the gate is the applicant's email domain, not the app, the volume or the use case.
A gmail.com address cannot get a key; reapplying from a domain the applicant owns can.
Until then DHL is tracked by mail alone (§6.7), which is built and working — and that
path stays the right fallback afterwards anyway, for a key that is revoked or past its
250 calls.

Two products are wanted, Express and Parcel. One adapter covers both: DHL's
"Shipment Tracking — Unified" API is explicitly cross-service and routes the number
itself when `service` is omitted.

**Scraping is excluded, on the record.** `https://www.dhl.com/utapi` answers an
automated request with an HTTP page reading: *"Automated extraction of information
by bots, website scraping etc. is prohibited. If you require direct system
integration, kindly visit https://developer.dhl.com/ for API access options."*
That is a stated prohibition plus an implemented block, and it is the reason this
carrier needs a key when the other five do not. Do not add a scraping fallback.

| | |
|---|---|
| Endpoint | `GET https://api-eu.dhl.com/track/shipments?trackingNumber=…` |
| Auth | `DHL-API-Key: <key>` header |
| Batching | **None.** One tracking number per call, so `batchSize` is 1 and each parcel costs one call per poll. |
| Rate limit | 250 calls/day, ~1 call per 5s on initial access; `429` over. Stated inconsistently across DHL's own language pages — read the real figure off the app's details. |
| Budget | 16 poll slots/day → ~15 DHL lookups per run before the daily cap. Ample for personal use; must be throttled and counted. |
| `service` | Optional. Values seen: `express`, `ecommerce`, `ecommerce-europe`, `parcel-de`, `parcel-nl`, `parcel-pl`, `parcel-uk`, `svb`, `sameday`. **No `parcel-sk` or `parcel-cz` exists.** |

**Response shape — CONFIRMED** against the documented `demo-key`, which returns a
canned payload regardless of the number (good for field names, useless for
not-found):

```
shipments[].id, .service
  .status.{timestamp, statusCode, status, description, location.address.*}
  .events[].{timestamp, statusCode, status, description, location.address.*}
  .details.{product.productName, weight, references[]}
  .origin|.destination .address.{countryCode, postalCode, addressLocality}
```

`statusCode` is a small canonical set — `pre-transit`, `transit`, `delivered`,
`unknown`, and `failure` per the docs — which maps onto `CanonicalStatus` more
cleanly than any of the other five carriers.

**401 — CONFIRMED:** `{"status":401,"title":"Unauthorized","detail":"…"}`. A revoked
or mistyped key must surface as a carrier alarm, never as `not_found`: the
difference between "your key is dead" and "no such parcel" is the whole value of
the Health page.

#### Decisions

**Routing: prefixed forms only.** DHL Express numbers are ten plain digits, and
GLS already matches `^\d{10,12}$`. Accepting bare ten-digit numbers would make
every such number ambiguous and break auto-detection for GLS parcels that work
today. `matches()` therefore accepts only `JJD…`, `JVGL…`, `3S…` and `000…`.
A bare Express number needs the carrier chosen explicitly — the escape hatch the
CLI and `/add` already provide — and mail ingest disambiguates by sender domain
regardless, which is how most parcels arrive.

**Timestamps.** `2026-10-27T10:37:00`, naive, no offset — and unlike the other five
carriers, DHL events happen worldwide, so fixing the zone to `Europe/Bratislava`
would be wrong rather than merely imprecise. Each event carries
`location.address.countryCode`; derive the zone from it where possible and record
what was assumed in `occurredAtTz`, as every other adapter does.

#### Owed, and only a real parcel can settle them

1. The not-found shape. `demo-key` ignores the number, so this is unknown.
2. Whether DHL Parcel Slovakia/Czech is in this API at all. There is no
   `parcel-sk`; it may fall under `ecommerce-europe`, or may be absent.
3. **How a pickup looks.** The canonical vocabulary has no pickup state: the demo
   payload expresses a locker delivery as `statusCode: delivered` with
   `description: "DELIVERED - PARCEL LOCKER"`. Pickup points, the locker code and
   the twice-daily reminders are this app's best features, and for DHL there is
   currently nothing structured to hang them on. Inferring from description text
   is how the Senec bug happened; do not guess it from the docs.

### 6.7 Email-only carriers

A carrier can be useful without being pollable. The ingest already turns mail into
parcels, and DHL's dispatch and delivery mails carry status in prose.

This needs one real change: ingest currently **refuses to create a parcel for a
carrier with no adapter registered** (`found <carrier> number … but no adapter
registered`). An email-only carrier must therefore be a first-class state rather
than an absence — never polled, never counted as a carrier failure, never left to
go dormant and look broken, and labelled in the UI as *updates arrive by email*.

This is the no-key path for DHL, and the honest fallback whenever a key is
missing, revoked, or past its daily cap. It is also what any future shop or
courier with no adapter would use.

### 6.8 robots.txt summary

| Host | Directive | Handling |
|---|---|---|
| `posta.sk` / `api.posta.sk` | empty `Disallow:` / none | unrestricted |
| `tracking.packeta.com` | empty (1 byte) | unrestricted |
| `gls-group.eu/.com` | only `/survey/` | unrestricted |
| `rest.mysps.sk` | `Disallow: /` | on-demand + aggressive caching, no tight loops |
| `www.dpdgroup.com` | `Disallow: /` | as above; user-accepted decision |
| `www.dhl.com` | n/a — an explicit in-page prohibition and an active block | **excluded**; the keyed API is the only route (see 6.6) |

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
  last_announced_status TEXT NOT NULL DEFAULT 'unknown',  -- status the user was last notified of
  pickup_announced INTEGER NOT NULL DEFAULT 0,            -- 1 once a pickup point was announced
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

CREATE TABLE deadline_reminders (   -- one row per parcel whose pickup-deadline reminder was sent
  parcel_id   INTEGER PRIMARY KEY REFERENCES parcels(id),
  notified_at TEXT NOT NULL
);
```

### Invariants

0. **Notification state is durable.** A status transition is `status <>
   last_announced_status`, a first pickup point is `pickup_announced = 0`, a deadline
   reminder is a row in `deadline_reminders`, and a carrier alarm is
   `carrier_health.notified_at` (cleared by the carrier's next `ok`). Every
   **status-based** fact is durable, so a run with no notifier, or a failed send, loses
   nothing it has not already recorded as sent. **One exception:** a *repeat* failed
   delivery attempt (status unchanged, a new failed-attempt event) is derived from the
   run's in-memory events and is not durable — a no-notifier caller would lose that one
   banner. Making it durable would need another column and an existing-database break,
   which is not worth it for a repeat of an already-announced condition.

   Stamping happens **before** the send, inside the deciding transaction, so delivery is
   **at-most-once**: a crash between stamp and send drops that banner rather than
   repeating it later. That is deliberate — per §10 delivery is best-effort, and a
   duplicated "delivered" banner is worse than a missed one.

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

**Decision (2026-10-26, revised): read the user's main Gmail account directly,
scoped to a label. No dedicated mailbox, no forwarding.**

1. In Gmail, create a filter whose action is **Apply the label `parcels`** to
   shipping mail. Nothing is forwarded and nothing leaves the account.
2. Create an **App Password** (`myaccount.google.com/apppasswords`; requires 2FA).
   IMAP is on by default on Gmail — the old enable toggle no longer exists.
3. Put the IMAP settings in `config.json`, `chmod 600`, gitignored, with
   `mailbox` set to the label name (`parcels`). Gmail exposes labels as IMAP
   folders by name; nested labels use `parent/child`.

**The ingest MUST be strictly read-only. It must never write IMAP flags.**
The original design fetched `UNSEEN` and set `\Seen` after a successful commit,
which is harmless against a throwaway mailbox but would **silently mark the
user's own email as read** on their main account. Instead, fetch the label's
messages and deduplicate on the `messages` table's `UNIQUE message_id`. The
mailbox is never mutated.

**Accepted trade-off:** an App Password is not scope-limited — it grants full
IMAP read and SMTP send on the whole account, so the label scope is a convention
the app honours rather than a boundary Google enforces. Mitigations: the
credential is local, `chmod 600`, gitignored, used by an app that never listens
externally, and revocable instantly. `gmail.readonly` OAuth would be properly
scoped, but it is a *restricted* scope, so an unverified personal app stays in
"Testing" status where **Google expires refresh tokens every 7 days** — which
defeats an unattended poller. The theoretically safer option is the practically
worse one here.

**Consequence for extraction:** because nothing is forwarded, the original
`From` header is always intact, so carrier detection reads it directly. The
`---------- Forwarded message ----------` wrapper only appears for mail the user
forwards by hand, so wrapper parsing becomes a fallback rather than the primary
path. Both shapes must be handled and tested.

### Pipeline

1. Connect over IMAP TLS; open the label **read-only** (`EXAMINE`); read the envelopes of the whole
   label, then download (`BODY.PEEK`) only messages whose Message-ID is not already in `messages`.
   Messages over the size cap are recorded without being downloaded.
2. For each new message, in one transaction: write the raw message to
   `data/mail/<id>.eml` (directory 0700, files 0600) and insert a `messages` row.
3. **Stage 1 — carrier from sender domain** (the registrable domain of `From`, any subdomain). This is
   what rescues carrier detection: a bare 14-digit number is ambiguous, but mail from `dpd.sk` is not.
   For a hand-forwarded message the sender inside the forwarded wrapper is the fallback.
4. **Stage 2 — number by carrier-specific regex** over the subject and body (SPS puts it in the
   subject), plus merchant name where the mail states it (so a card reads "Alza", not a number). With no
   sender hint, only a distinctive shape (posta, Packeta, SPS) with exactly one candidate is accepted.
5. Insert the parcel and link it to the message; a message about a parcel that already exists is just
   linked. **A parcel whose newest mail in the batch is older than 30 days is created already archived**
   (never polled, first-seen set to the mail's date, status left `unknown`), so the first run over a
   multi-year label does not poll dead parcels. Age uses the later of the `Date` header and `INTERNALDATE`.
6. Nothing is written back to the mailbox. The mail is never marked seen.

### Behaviours

- **Nothing is silently dropped.** Unparsed mail lands in a **needs-attention**
  list in the web UI with the subject and sender shown, where carrier and number
  are assigned in one click. Shipping-email formats change constantly; silent
  failure would make misses invisible and undermine the whole premise.
- **Ambiguity goes to needs-attention, not to probing.** (The original design probed each candidate
  carrier, since `not_found` is a cheap negative; that is **not implemented**.) A number is accepted
  without a sender hint only if its shape is distinctive and unambiguous; bare 11-14 digit numbers and
  mail naming several different numbers go to the needs-attention list, where one click assigns them.
- **E-shop dispatch mail is accepted on two signals together.** An e-shop's "your order has been dispatched"
  mail is often the first notice of a parcel, days before the carrier writes. When the sender is not a
  carrier and no distinctive shape is present, a mail that **names GLS or DPD AND prints a labelled
  tracking number of that carrier's bare-digit shape** (e.g. `Číslo zásielky je 1234567890`) is extracted
  with confidence `shape`. The number must be a whole token, introduced by a tracking label, not behind an
  order/invoice/phone word, and not phone-shaped; two different such numbers are ambiguous. A carrier name
  alone (an order confirmation saying the delivery method is GLS) or a number alone stays `none` and goes
  to needs-attention. Verified on a real pair from one shop for one order: the dispatch mail extracts, the
  order confirmation does not. This only helps if the Gmail filter labels the shop's mail (README step 2).
  Mail from a carrier domain that yields no number (e.g. Packeta's app-verification mail) lands there
  too and never creates a parcel.
- **The ingest has its own health.** The `ingest_status` row (last ok, last error, consecutive failures)
  is shown on the Health page, and after three consecutive failed runs one notification is sent per
  outage (held back if every carrier also failed in that run, i.e. the Mac is offline). A revoked App
  Password therefore does not fail silently.
- **A message can be reprocessed** from its stored `.eml` after a parser fix,
  without needing the mail to still exist upstream: `cli reprocess` re-runs extraction over every stored
  message that no parcel was made from.
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
- **Sleep detection: use `sysctl -n kern.waketime`.** It returns the exact
  timestamp of the last wake (`{ sec = … } Mon Oct 26 18:47:34 2026`), which is
  cheap, exact and purpose-built. If the last wake is later than the last recorded
  poll, the Mac slept in between.
  **Do not use `process.hrtime.bigint()`** — VERIFIED on this machine that it
  *includes* time asleep: it read 434.56h, identical to `os.uptime()` and to wall
  time since boot, so a monotonic-clock delta always measures ~zero sleep. The
  `CLOCK_UPTIME_RAW` trick from the reconnaissance works only from C, not through
  any Node API.
- A long gap forces a full refresh of all active parcels, overriding the
  **per-parcel tier backoff only**. It must **never** override the gated-carrier
  throttle or the `needs_postcode` skip — doing so would resurrect the retry storm
  those mechanisms exist to prevent. Since overnight sleep is normal, "long gap" in
  practice means "the first run after you open the lid", typically once a morning.

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
- IMAP credentials (a Gmail App Password for the user's main account) in a `chmod 600` config file,
  gitignored. The app reads only the `parcels` label, **read-only** (no flag, move or delete is ever
  issued), but an App Password is not scope-limited, so the label scope is a convention the app honours,
  not a boundary Google enforces; see §8 for the accepted trade-off. Stored raw mail (`data/mail/`)
  contains personal mail and pickup PINs: directory 0700, files 0600, gitignored.
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
- **Email extraction tests** over redacted `.eml` fixtures built from the real mailbox (committed with
  all personal data replaced), plus hand-written ones for carriers with no real sample: sender-domain
  routing (and its spoof cases), a hand-forwarded message where the original sender is in the wrapper,
  a carrier mail with no parcel landing in needs-attention, the 30-day archive boundary, and a fake IMAP
  client that fails the test on any flag, move or delete call.
- **Injection test:** a parcel label containing quotes, backslashes, and newlines
  passes through the notifier without breaking or executing.
- No live carrier calls in the test suite. A separate, manually-run
  `node dist/cli.js probe <carrier> <number>` command exercises real endpoints and prints
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
`node dist/cli.js probe <carrier> <number>`:

| Carrier | To confirm |
|---|---|
| Slovenská pošta | `events[]` field names; `localDate` has no offset; `postOffice` appears under `p=1` |
| Packeta | `item` field names and `packetStatusId` values; whether `branchAddress` is absent for courier delivery |
| GLS | ~~`rstt028` shape~~ — **CONFIRMED 2026-10-27** against a real in-transit parcel, see §6.3 (bare object, 10-digit numbers, separate `date`/`time`, `CUSTREF`, HTML entities). Still owed: whether `rstt029` includes `history` or only `progressBar`; which `addresses[]` entry is the parcel shop (the adapter picks the first with coordinates, since `type` values are undocumented) — needs a captured `INPICKUP` record |
| SPS | ~~`data.states[]` field names~~ — **CONFIRMED 2026-10-27** against real parcel `SK0TEST6000000000X`: `states[]` carries `time` (`yyyy-MM-dd HH:mm:ss`, naive `Europe/Bratislava`) and `statusDescr` (free-text Slovak, e.g. "Definícia dát", "Prvá registrácia", "Uložený v balíkomate", "Doručenie"). **No location field.** Per-event status is correctly `unknown` except the terminal one, since SPS emits no per-event codes. |
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
