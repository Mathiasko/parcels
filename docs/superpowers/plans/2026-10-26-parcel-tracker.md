# Parcel Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted parcel tracker that ingests shipping emails, polls five Slovak carriers, and posts native macOS notifications naming where and by when to collect a parcel.

**Architecture:** One Node/TypeScript project, two launchd agents (a short-lived poller that is the sole DB writer, a long-lived read-only web UI), one SQLite file. Carriers sit behind a single `CarrierAdapter` interface that receives an injected `HttpClient`, so every adapter is tested against recorded fixtures with no live network.

**Tech Stack:** Node 24.21.0 (absolute path `/Users/you/.nvm/versions/node/v24.21.0/bin/node`), TypeScript strict, `better-sqlite3`, `luxon` (IANA zone parsing of naive carrier timestamps), `imapflow` + `mailparser`, `fastify`, `vitest`, `terminal-notifier` (via Homebrew).

**Spec:** `docs/superpowers/specs/2026-10-26-parcel-tracker-design.md`

## Global Constraints

- Node >= 24; global `fetch` is used, never `node-fetch`. launchd plists reference `/Users/you/.nvm/versions/node/v24.21.0/bin/node` by absolute path — launchd supplies only `PATH=/usr/bin:/bin:/usr/sbin:/sbin`.
- TypeScript `strict: true`. ESM (`"type": "module"`).
- **No live network calls anywhere in the test suite.** Adapters receive an `HttpClient`; tests pass a stub returning fixtures from `test/fixtures/<carrier>/`.
- Naive carrier timestamps are parsed in the carrier's IANA zone, never UTC: `Europe/Bratislava` for Slovenská pošta and SPS, `Europe/Prague` for Packeta. DPD supplies `eventDateAndTimeZoneId`; GLS supplies date+time strings treated as `Europe/Bratislava`.
- **Status is never derived from localised human text** — only from machine codes or machine status fields.
- Web server binds `127.0.0.1` only. No authentication by design.
- Notification text is passed as **process arguments**, never interpolated into a shell or AppleScript string.
- launchd uses **`StartCalendarInterval`**, never `StartInterval` (which silently drops sleep-missed runs).
- Polling schedule: hourly on the hour, **07:00–21:00** (15 slots).
- Secrets live in `config.json`, `chmod 600`, gitignored. `data/` is gitignored.
- `not_found` is never an error; `gated` is always a health alarm.

## Review Focus

Input classes the spec implies but whose tests must be deliberately placed. Each has its test assigned to the task that owns the code.

1. **A tracking number pasted with spaces, dashes, or lowercase** (labels print `Z 123 4567 890`) must normalise and match, not fail detection. → Task 4.
2. **A carrier timestamp inside a DST transition** (ambiguous or non-existent local hour) must resolve to a real instant without throwing or shifting a day. → Task 3.
3. **The same shipping email forwarded twice** must not create a duplicate parcel or re-notify. → Task 17.
4. **A parcel label or merchant name containing quotes, backslashes, newlines or emoji** must reach the notifier intact without breaking or executing anything. → Task 12.
5. **A carrier returning HTTP 200 with a truncated or empty body** must become a parse failure that marks the parcel `unknown`, not a crash that aborts the whole poll run. → Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/types.ts` | All shared types: `CanonicalStatus`, `ParcelEvent`, `PickupPoint`, `FetchInput`, `FetchResult`, `CarrierAdapter`, `HttpClient` |
| `src/core/config.ts` | Load and validate `config.json`; defaults |
| `src/core/time.ts` | Naive-string → UTC `Date` in a given IANA zone |
| `src/core/dedup.ts` | `dedupHash` for events |
| `src/core/backoff.ts` | Whether a parcel is due this slot |
| `src/core/http.ts` | `HttpClient` over global `fetch`; timeout, retry, `Retry-After` |
| `src/db/schema.sql` | Tables from spec §7 |
| `src/db/index.ts` | `openDb`, migrations |
| `src/db/parcels.ts` | Parcel queries |
| `src/db/events.ts` | `appendEvents` (returns only new rows), notification bookkeeping |
| `src/db/health.ts` | `carrier_health` read/write |
| `src/carriers/registry.ts` | Adapter registry, `detectCarrier` |
| `src/carriers/posta.ts` … `dpd.ts` | One adapter each |
| `src/core/poll.ts` | The poll run orchestrator |
| `src/notify/types.ts` | `Notification`, `Notifier` |
| `src/notify/send.ts` | `terminal-notifier` / `osascript` implementations |
| `src/notify/rules.ts` | Which changes notify |
| `src/ingest/imap.ts` | Fetch UNSEEN, store `.eml` |
| `src/ingest/extract.ts` | Sender → carrier, regex → number, merchant |
| `src/web/server.ts` + `src/web/views/*.ts` | Fastify app, server-rendered pages |
| `src/poll.ts`, `src/server.ts`, `src/cli.ts` | Entry points |
| `launchd/*.plist.template`, `scripts/install-agents.sh` | Agent installation |

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/core/config.ts`, `config.example.json`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(path?: string): Config`; `interface Config { dbPath: string; port: number; defaultPostalCode: string; notifier: 'auto'|'terminal-notifier'|'osascript'; imap?: { host: string; port: number; user: string; pass: string; mailbox: string } }`

- [ ] **Step 1: Create `package.json`** — `"type": "module"`, scripts `build` (`tsc`), `test` (`vitest run`), `poll` (`node dist/poll.js`), `serve` (`node dist/server.js`), `cli` (`node dist/cli.js`). Deps: `better-sqlite3`, `luxon`, `fastify`, `imapflow`, `mailparser`. Dev deps: `typescript`, `vitest`, `@types/node`, `@types/luxon`, `@types/better-sqlite3`.
- [ ] **Step 2: Create `tsconfig.json`** — `strict: true`, `module: nodenext`, `target: es2023`, `outDir: dist`, `rootDir: src`.
- [ ] **Step 3: Create `.gitignore`** — `node_modules/`, `dist/`, `data/`, `config.json`, `*.log`.
- [ ] **Step 4: Install dependencies**

Run: `/Users/you/.nvm/versions/node/v24.21.0/bin/npm install`
Expected: exits 0; `better-sqlite3` compiles for arm64.

- [ ] **Step 5: Write the failing test** in `test/config.test.ts`

```ts
test('loadConfig applies defaults when fields are absent', () => {
  const c = loadConfig(fixturePath('minimal.json'))
  expect(c.port).toBe(8787)
  expect(c.dbPath).toBe('data/parcels.db')
  expect(c.notifier).toBe('auto')
})
test('loadConfig throws a named error when defaultPostalCode is missing', () => {
  expect(() => loadConfig(fixturePath('no-zip.json'))).toThrow(/defaultPostalCode/)
})
test('loadConfig leaves imap undefined when absent', () => {
  expect(loadConfig(fixturePath('minimal.json')).imap).toBeUndefined()
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `loadConfig`.

- [ ] **Step 7: Implement `loadConfig(path?: string): Config` in `src/core/config.ts`** — default path `config.json`; `defaultPostalCode` is the only required field. Also write `config.example.json` documenting every field.
- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: 3 passed.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/core/config.ts config.example.json test/
git commit -m "feat: project scaffold and config loader"
```

---

## Task 2: Database schema and queries

**Files:**
- Create: `src/db/schema.sql`, `src/db/index.ts`, `src/db/parcels.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1).
- Produces: `openDb(path: string): Database` (WAL mode, runs schema idempotently); `insertParcel(db, p: NewParcel): number`; `findParcel(db, carrier: CarrierId, number: string): Parcel | undefined`; `listActive(db): Parcel[]`; `updateParcelState(db, id: number, s: ParcelStateUpdate): void`; `setArchived(db, id: number, at: Date): void`. `NewParcel` = `{ carrier, trackingNumber, label?, merchant?, postalCode?, source: 'email'|'manual', sourceMessageId? }`.

- [ ] **Step 1: Write `src/db/schema.sql`** — exactly the five tables plus `raw_responses` from spec §7, including `UNIQUE (carrier, tracking_number)` and `UNIQUE (parcel_id, dedup_hash)`.
- [ ] **Step 2: Write the failing test** in `test/db.test.ts` (each test opens an in-memory DB)

```ts
test('openDb creates all tables and is idempotent', () => { /* open twice, assert no throw, assert 6 tables present */ })
test('insertParcel then findParcel round-trips', () => { /* assert carrier, trackingNumber, status defaults to 'unknown' */ })
test('inserting the same carrier+number twice throws a unique constraint', () => {
  expect(() => insertParcel(db, same)).toThrow(/UNIQUE/)
})
test('listActive excludes delivered, returned and archived parcels', () => { /* seed 4, expect 1 */ })
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL — `openDb` not defined.

- [ ] **Step 4: Implement `src/db/index.ts` and `src/db/parcels.ts`** with the signatures above. `openDb` sets `journal_mode = WAL` and `foreign_keys = ON`, then executes `schema.sql` (all statements `IF NOT EXISTS`).
- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/db.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add src/db test/db.test.ts && git commit -m "feat: sqlite schema and parcel queries"
```

---

## Task 3: Canonical status, timestamps, event dedup

**Files:**
- Create: `src/core/types.ts`, `src/core/time.ts`, `src/core/dedup.ts`, `src/db/events.ts`
- Test: `test/time.test.ts`, `test/events.test.ts`

**Interfaces:**
- Consumes: `openDb`, `insertParcel` (Task 2).
- Produces: all types in spec §5 verbatim; `parseNaive(raw: string, zone: string, format?: string): { at: Date; tz: string }`; `dedupHash(e: Pick<ParcelEvent,'occurredAtRaw'|'code'|'description'>): string`; `appendEvents(db, parcelId: number, events: ParcelEvent[]): ParcelEvent[]` **returning only rows newly inserted** — this is the diff engine, there is no separate differ; `latestEvent(db, parcelId): ParcelEvent | undefined`; `recomputeParcelStatus(db, parcelId): void`; `unnotifiedEvents(db): ParcelEvent[]`; `markNotified(db, eventIds: number[], at: Date): void`.

- [ ] **Step 1: Write the failing tests** in `test/time.test.ts` — **Review Focus item 2 lives here**

```ts
test('parses a naive Slovak timestamp as Europe/Bratislava, not UTC', () => {
  expect(parseNaive('2026-07-13T15:08:08', 'Europe/Bratislava').at.toISOString())
    .toBe('2026-07-13T13:08:08.000Z')   // CEST = UTC+2
})
test('parses a winter timestamp at UTC+1', () => {
  expect(parseNaive('2026-01-13T15:08:08', 'Europe/Bratislava').at.toISOString())
    .toBe('2026-01-13T14:08:08.000Z')
})
test('a non-existent local time in the spring-forward gap resolves forward, not NaN', () => {
  const r = parseNaive('2026-03-29T02:30:00', 'Europe/Bratislava')   // 02:00->03:00
  expect(Number.isNaN(r.at.getTime())).toBe(false)
})
test('an ambiguous local time in the autumn fold picks the earlier offset deterministically', () => {
  const r = parseNaive('2026-10-25T02:30:00', 'Europe/Bratislava')
  expect(r.at.toISOString()).toBe('2026-10-25T00:30:00.000Z')
})
test('parses the Packeta space-separated format in Europe/Prague', () => {
  expect(parseNaive('2026-04-29 13:12:42', 'Europe/Prague').at.toISOString())
    .toBe('2026-04-29T11:12:42.000Z')
})
test('throws on an unparseable string rather than returning Invalid Date', () => {
  expect(() => parseNaive('not a date', 'Europe/Bratislava')).toThrow()
})
```

and in `test/events.test.ts`

```ts
test('appendEvents returns the inserted events on first call', () => { /* 3 in, 3 returned */ })
test('appendEvents returns empty on a second identical call', () => { /* idempotency */ })
test('appendEvents returns only the genuinely new event when history grows', () => { /* 3 then 4 -> 1 returned */ })
test('dedupHash ignores location and status but distinguishes description', () => { /* same raw+code, different description -> different hash */ })
test('recomputeParcelStatus sets status from the newest event by occurredAt', () => { /* out-of-order insert, newest wins */ })
test('recomputeParcelStatus sets delivered_at when the newest event is delivered', () => {})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/time.test.ts test/events.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/core/types.ts`** — copy the type block from spec §5, plus `type CarrierId = 'posta'|'packeta'|'gls'|'sps'|'dpd'`. **One deliberate deviation from the spec:** `CarrierAdapter.fetch` takes the client as a second parameter — `fetch(inputs: FetchInput[], http: HttpClient): Promise<FetchResult[]>` — so adapters are testable against fixtures with no module mocking. Every adapter task uses this signature.
- [ ] **Step 4: Implement `src/core/time.ts`** using `luxon` `DateTime.fromFormat`/`fromISO` with `{ zone }`. Luxon resolves the spring gap forward and the autumn fold to the earlier offset by default; assert rather than re-implement. Throw on `!isValid`.
- [ ] **Step 5: Implement `src/core/dedup.ts`** — `sha256` of `occurredAtRaw + '|' + (code ?? '') + '|' + description`.
- [ ] **Step 6: Implement `src/db/events.ts`** — `appendEvents` uses `INSERT ... ON CONFLICT(parcel_id, dedup_hash) DO NOTHING` inside one transaction and returns the rows whose insert reported a change.
- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/time.test.ts test/events.test.ts`
Expected: 12 passed.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/core/time.ts src/core/dedup.ts src/db/events.ts test/ && git commit -m "feat: canonical types, zone-aware timestamps, idempotent event append"
```

---

## Task 4: HttpClient, adapter registry, number normalisation

**Files:**
- Create: `src/core/http.ts`, `src/carriers/registry.ts`
- Test: `test/http.test.ts`, `test/registry.test.ts`

**Interfaces:**
- Consumes: types (Task 3).
- Produces: `interface HttpResponse { status: number; headers: Record<string,string>; text(): Promise<string>; json<T>(): Promise<T> }`; `type HttpClient = (url: string, init?: RequestInit) => Promise<HttpResponse>`; `createHttpClient(opts?: { timeoutMs?: number; retries?: number }): HttpClient`; `normalizeNumber(raw: string): string`; `detectCarrier(number: string): CarrierId[]` (ordered, most specific first); `register(a: CarrierAdapter): void`; `getAdapter(id: CarrierId): CarrierAdapter`; `allAdapters(): CarrierAdapter[]`.

- [ ] **Step 1: Write the failing tests** — **Review Focus item 1 lives here**

`test/registry.test.ts`:
```ts
test('normalizeNumber strips spaces and dashes and uppercases', () => {
  expect(normalizeNumber(' z 123 4567 890 ')).toBe('Z1234567890')
  expect(normalizeNumber('ra123456785sk')).toBe('RA123456785SK')
  expect(normalizeNumber('703-1234567890-12')).toBe('703123456789012')
})
test('detectCarrier identifies a Packeta number from a spaced label form', () => {
  expect(detectCarrier(normalizeNumber('Z 123 4567 890'))).toEqual(['packeta'])
})
test('detectCarrier identifies Slovenska posta from an S10 number', () => {
  expect(detectCarrier('RA123456785SK')).toEqual(['posta'])
})
test('detectCarrier returns SPS for a 703-prefixed 16-digit number', () => {
  expect(detectCarrier('7031234567890123')).toContain('sps')
})
test('detectCarrier returns multiple candidates for a bare 14-digit number', () => {
  const c = detectCarrier('01234567890123')
  expect(c).toContain('dpd'); expect(c.length).toBeGreaterThan(0)
})
test('detectCarrier returns gls for a bare 11-digit number', () => {
  expect(detectCarrier('31217533227')).toContain('gls')
})
test('detectCarrier returns an empty array for nonsense', () => {
  expect(detectCarrier('HELLO')).toEqual([])
})
```

`test/http.test.ts` (inject a stub `fetch` via the client's options):
```ts
test('returns status and lowercased headers', async () => {})
test('retries once on 503 then succeeds', async () => {})
test('does not retry a 404', async () => {})
test('honours Retry-After on 429 by waiting the stated seconds', async () => { /* fake timers */ })
test('rejects with a transport error after the timeout', async () => {})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/http.test.ts test/registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/core/http.ts`** — wraps global `fetch` with `AbortSignal.timeout`, retries only 429/5xx/network with jitter, honours `Retry-After`. Accepts an injectable `fetchImpl` for tests.
- [ ] **Step 4: Implement `src/carriers/registry.ts`** — `normalizeNumber` strips `[^A-Z0-9]` after uppercasing. `detectCarrier` applies each adapter's `matches()`, ordering distinctive shapes (`posta`, `packeta`, `sps`) before ambiguous ones (`dpd`, `gls`). Registry starts empty; adapters self-register as later tasks add them, so the detect tests use a test-local registration helper.
- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/http.test.ts test/registry.test.ts`
Expected: 12 passed.

- [ ] **Step 6: Commit**

```bash
git add src/core/http.ts src/carriers/registry.ts test/ && git commit -m "feat: http client with backoff, carrier registry and number normalisation"
```

---

## Task 5: Slovenská pošta adapter

**Files:**
- Create: `src/carriers/posta.ts`, `src/carriers/posta-codes.ts`
- Test: `test/carriers/posta.test.ts`, `test/fixtures/posta/*.json`

**Interfaces:**
- Consumes: `CarrierAdapter`, `HttpClient`, `parseNaive` (Tasks 3–4).
- Produces: `postaAdapter: CarrierAdapter` with `id: 'posta'`, `batchSize: 100`, `needsPostalCode: false`.

Spec reference: §6.1. `GET https://api.posta.sk/tracking?q={comma-separated}&l=sk&p=1`.

- [ ] **Step 1: Create fixtures** in `test/fixtures/posta/` — `ok-empty.json` (`{"results":[{"events":[],"number":"RA123456785SK","status":"ok"}],"status":"ok"}`, captured live), `invalid-format.json`, `delivered.json` (the manual's three-event example), `batch-mixed.json` (one ok, one invalid, returned **out of request order**), `held.json` (a `notified` event with `postOffice` and `retainedTill`), `failed.json` (`stateCode: "transit"` with `detailCode: "ANZ"`), `truncated.txt` (an unterminated JSON string).
- [ ] **Step 2: Write the failing tests**

```ts
test('batches all numbers into a single request with q comma-separated', async () => { /* assert one call, q contains both */ })
test('matches results by their own number field, not array position', async () => {
  // batch-mixed.json returns them reversed; assert each result maps to the right input
})
test('status ok with empty events maps to pre_transit, not not_found', async () => {})
test('invalid_format maps to a not_found result, not a gated one', async () => {})
test('delivered fixture maps stateCode delivered to delivered and parses three events', async () => {})
test('event timestamps are interpreted as Europe/Bratislava', async () => {
  // 2016-07-13T15:08:08 -> 13:08:08Z
})
test('detailCode ANZ under stateCode transit maps to failed_attempt', async () => {})
test('detailCode ZSTR maps to problem', async () => {})
test('an unmapped detailCode leaves the stateCode mapping intact and does not throw', async () => {})
test('held fixture extracts the post office as a pickup point and retainedTill as the deadline', async () => {
  expect(r.pickup?.kind).toBe('post_office'); expect(r.retainedTill).toBeInstanceOf(Date)
})
test('a 200 with a truncated body yields a transport-or-parse failure, never a throw', async () => {})
test('matches() accepts RA123456785SK and rejects a bare 10-digit number', () => {})
test('matches() rejects a valid S10 number with a non-SK suffix', () => {})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/carriers/posta.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write `src/carriers/posta-codes.ts`** — `stateCode` → `CanonicalStatus` for the six values from spec §6.1, plus a `detailCode` override map covering at least `ANZ`→`failed_attempt`, `P-NOL`→`returning`, `ZSTR`→`problem`, `ZZNC`→`problem`, `REKL`→`problem`, `ZNP1`→`ready_for_pickup`, `OKP`/`OKB`→`delivered`. Unknown detail codes fall through to the `stateCode` mapping.
- [ ] **Step 5: Implement `postaAdapter` in `src/carriers/posta.ts`** — one request per batch of up to 100; map by `number`; treat `invalid_format` as `not_found`; wrap JSON parsing so a non-JSON body returns `{ ok: false, reason: 'transport' }`.
- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/carriers/posta.test.ts`
Expected: 13 passed.

- [ ] **Step 7: Commit**

```bash
git add src/carriers/posta.ts src/carriers/posta-codes.ts test/ && git commit -m "feat: Slovenska posta adapter with detailCode mapping"
```

---

## Task 6: Poll orchestrator and backoff

**Files:**
- Create: `src/core/backoff.ts`, `src/core/poll.ts`, `src/db/health.ts`, `src/poll.ts`
- Test: `test/backoff.test.ts`, `test/poll.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: `isDue(p: Parcel, now: Date, slot: number): boolean`; `runPoll(deps: PollDeps): Promise<PollReport>` where `PollDeps = { db, http, adapters, config, now, notifier?, ingest? }` and `PollReport = { polled: number; newEvents: ParcelEvent[]; failures: Array<{carrier: CarrierId; reason: string}> }`; `recordHealth(db, carrier, outcome: 'ok'|'gated'|'transport'|'parse', detail?: string): void`; `carrierHealth(db): HealthRow[]`.

- [ ] **Step 1: Write the failing tests** — **Review Focus item 5 lives here**

`test/backoff.test.ts` — one test per row of the spec §9 table:
```ts
test('out_for_delivery is due every slot', () => {})
test('ready_for_pickup is due every slot', () => {})
test('in_transit moved within 48h is due every slot', () => {})
test('in_transit idle 3 days is due only on every third slot', () => {})
test('idle more than 7 days is due once a day, at the first slot', () => {})
test('retained_till within 48h is due every slot even when idle for weeks', () => {})
test('delivered is never due', () => {})
test('returned is never due', () => {})
test('no events for over 30 days is never due', () => {})
```

`test/poll.test.ts`:
```ts
test('polls only due parcels and groups them per carrier into one batched call', async () => {})
test('appends new events and leaves existing ones untouched on a second run', async () => {})
test('a gated result records carrier health as gated and does not alter the parcel status', async () => {})
test('a not_found result records health as ok and does not alarm', async () => {})
test('one carrier throwing does not prevent the other carriers from being polled', async () => {
  // Review Focus 5: a truncated body / thrown parse error is contained
})
test('a parse failure marks the parcel unknown and stores the raw response', async () => {})
test('consecutive_failures resets to zero after a successful poll', async () => {})
test('the run commits even when every carrier fails', async () => {})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/backoff.test.ts test/poll.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/core/backoff.ts`** with `isDue`. Slot index is the hour's position in the 07:00–21:00 window.
- [ ] **Step 4: Implement `src/db/health.ts`.**
- [ ] **Step 5: Implement `runPoll` in `src/core/poll.ts`** — select due parcels, group by carrier, chunk by `adapter.batchSize`, `await` each adapter inside its own `try/catch` so one failure is contained, append events, recompute status, store raw responses (pruned to the last 5 per parcel), record health. One SQLite transaction per carrier.
- [ ] **Step 6: Implement `src/poll.ts`** — entry point: load config, open DB, build deps, run, log a one-line summary, exit non-zero only on a fatal startup error.
- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/backoff.test.ts test/poll.test.ts`
Expected: 17 passed.

- [ ] **Step 8: Commit**

```bash
git add src/core/backoff.ts src/core/poll.ts src/db/health.ts src/poll.ts test/ && git commit -m "feat: poll orchestrator with per-parcel backoff and isolated carrier failures"
```

---

## Task 7: CLI

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces: commands `add <number> [--carrier] [--label] [--zip]`, `list`, `show <id>`, `poll`, `probe <carrier> <number> [--zip]`, `notify-test` (sends one fixed notification through the configured notifier; used by Task 19 step 4).

- [ ] **Step 1: Write the failing tests**

```ts
test('add normalises the number and auto-detects an unambiguous carrier', async () => {})
test('add requires --carrier when detection is ambiguous and exits with a clear message', async () => {})
test('add rejects a duplicate carrier+number with a friendly message, not a stack trace', async () => {})
test('add defaults the postal code from config', async () => {})
test('list prints one line per active parcel with label, carrier and status', async () => {})
test('show prints the event timeline oldest-first', async () => {})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/cli.ts`** using `node:util parseArgs`. `probe` is the only command that touches the live network; it prints the raw response verbatim — this is the tool for the spec §15 first-real-parcel confirmations.
- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Verify the whole suite and build**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli.test.ts && git commit -m "feat: cli with add, list, show, poll and probe"
```

---

## Tasks 8–11: the four remaining adapters

Each follows the Task 5 shape: fixtures first, then mapping tests, then the adapter. All four are independent of each other and depend only on Tasks 3–4.

### Task 8: Packeta adapter

**Files:** Create `src/carriers/packeta.ts`; Test `test/carriers/packeta.test.ts`, `test/fixtures/packeta/*.json`

**Interfaces:** Produces `packetaAdapter: CarrierAdapter` (`batchSize: 1`, `needsPostalCode: false`).

Spec reference §6.2. `POST https://tracking.packeta.com/api/getPacketById/{Z…}/en`, empty body.

- [ ] **Step 1: Create fixtures** — `delivered.json` (the §6.2 `item` example), `ready-for-pickup.json` (`packetStatusId: "2"` with a Z-BOX `branchAddress`), `not-found.json` (`{"error":"notFound","message":{"name":"FetchError"}}`, status 404, captured live), `unknown-status.json` (`packetStatusId: "4242"`), `unordered-events.json`.
- [ ] **Step 2: Write the failing tests**

```ts
test('issues a POST with an empty body and no required headers', async () => {})
test('a GET is never issued', async () => {})
test('404 maps to not_found, not gated', async () => {})
test('packetStatusId 3 maps to delivered', async () => {})
test('packetStatusId 2 maps to ready_for_pickup and extracts branchAddress as a zbox pickup point', async () => {})
test('packetStatusId 997 maps to pre_transit and 21 maps to problem', async () => {})
test('an unknown packetStatusId maps to unknown and preserves packetStatus text as statusRaw', async () => {})
test('event times are parsed as Europe/Prague', async () => {})
test('events are sorted oldest-first regardless of response order', async () => {})
test('no retainedTill is produced, since Packeta supplies no deadline', async () => {})
test('matches() accepts Z1234567890 and rejects a bare 10-digit number', () => {})
```

- [ ] **Step 3: Run to verify failure, 4: implement, 5: run to verify pass** (`npx vitest run test/carriers/packeta.test.ts`, expected 11 passed)
- [ ] **Step 6: Commit** — `git commit -m "feat: Packeta adapter"`

### Task 9: GLS adapter

**Files:** Create `src/carriers/gls.ts`; Test `test/carriers/gls.test.ts`, `test/fixtures/gls/*.json`

**Interfaces:** Produces `glsAdapter: CarrierAdapter` (`batchSize: 1`, `needsPostalCode: true`).

Spec reference §6.3. `rstt029?match=` for status; `rstt028/{number}?postalCode=` for history.

- [ ] **Step 1: Create fixtures** — `rstt029-delivered.json` (the live-captured `{"tuStatus":[{"tuNo":"31217533227","progressBar":{"statusInfo":"DELIVERED",…}}]}`), `rstt028-detail.json` (full record with newest-first `history[]`, `parcelShop`, lat/long), `e000.json`, `e609-postcode-mismatch.json`, `dummy-parcel.json` (200 with 60+ events), `gated.html` (an HTML body with status 200).
- [ ] **Step 2: Write the failing tests**

```ts
test('calls rstt028 with the postal code when one is supplied', async () => {})
test('falls back to rstt029 for status only when E609 postcode mismatch is returned', async () => {})
test('returns needs_postcode when no postal code is available', async () => {})
test('maps progressBar.statusInfo DELIVERED to delivered', async () => {})
test('maps INDELIVERY to out_for_delivery and DELIVEREDPS to delivered', async () => {})
test('maps NOTDELIVERED to failed_attempt and NOTPICKEDUP to problem', async () => {})
test('never derives status from the localised evtDscr text', async () => { /* Slovak text + contradicting statusInfo -> statusInfo wins */ })
test('rejects a 200 carrying more than 50 events as a gated dummy response', async () => {})
test('treats an HTML body with status 200 as gated, not as a parse failure', async () => {})
test('a 403 maps to gated, not not_found', async () => {})
test('history is reversed to oldest-first', async () => {})
test('extracts parcelShop with latitude and longitude as a parcelshop pickup point', async () => {})
test('matches() accepts 11 and 12 digit numbers', () => {})
```

- [ ] **Step 3–5: run/implement/run** (expected 13 passed)
- [ ] **Step 6: Commit** — `git commit -m "feat: GLS adapter with dummy-parcel guard and postcode fallback"`

### Task 10: SPS adapter

**Files:** Create `src/carriers/sps.ts`; Test `test/carriers/sps.test.ts`, `test/fixtures/sps/*`

**Interfaces:** Produces `spsAdapter: CarrierAdapter` (`batchSize: 1`, `needsPostalCode: false`); `resolveApiKey(http: HttpClient): Promise<string>`.

Spec reference §6.4. `POST https://rest.mysps.sk/tracking/getShipmentTrackAndTrace` with an `Api-Key` header.

- [ ] **Step 1: Create fixtures** — `index.html` (containing `assets/index-ABC123.js`), `bundle.js` (containing the `Api-Key` literal), `not-found.json` (**HTTP 200** with `{"status":false,"code":404,…}`, captured live), `in-transit.json`, `parcelshop.json` (`shipmentStatus: "placedInParcelShop"`), `unauthorized.json` (HTTP 401).
- [ ] **Step 2: Write the failing tests**

```ts
test('resolveApiKey scrapes the hashed bundle name from the index page then the key from the bundle', async () => {})
test('resolveApiKey falls back to the known literal when scraping fails', async () => {})
test('strips dashes from the number before sending', async () => {})
test('HTTP 200 with body code 404 maps to not_found', async () => {})
test('HTTP 401 maps to gated, signalling key rotation', async () => {})
test('maps shipmentStatus delivered, inTransit, delivering and undelivered correctly', async () => {})
test('placedInParcelShop maps to ready_for_pickup', async () => {})
test('states entries are parsed as Europe/Bratislava and sorted oldest-first', async () => {})
test('a missing states array yields a status with zero events rather than throwing', async () => {})
test('matches() accepts 703-prefixed numbers and rejects a UPS 1Z number', () => {
  expect(spsAdapter.matches('1Z999AA10123456784')).toBe(false)
})
```

- [ ] **Step 3–5: run/implement/run** (expected 10 passed)
- [ ] **Step 6: Commit** — `git commit -m "feat: SPS adapter with api key resolution"`

### Task 11: DPD adapter

**Files:** Create `src/carriers/dpd.ts`, `src/carriers/dpd-codes.ts`; Test `test/carriers/dpd.test.ts`, `test/fixtures/dpd/*.json`

**Interfaces:** Produces `dpdAdapter: CarrierAdapter` (`batchSize: 1`, `needsPostalCode: true`); `getAccessToken(http: HttpClient, cache: TokenCache): Promise<string>`; `interface TokenCache { get(): {token: string, expiresAt: number} | undefined; set(t: string, expiresAt: number): void }`.

Spec reference §6.5. Firebase → OAuth → details, all POST.

- [ ] **Step 1: Create fixtures** — `firebase-installations.json`, `firebase-config.json` (with `entries.basic_dpd_token`), `oauth-token.json` (`expires_in: 18986`), `prealert.json` (the live-captured `ORDER_CREATED` response), `delivered-verified.json` (with `parcelEvents[]`, pickup pass, `eventDateAndTimeZoneId`), `not-found.json` (HTTP 400, `exceptionType: "PARCEL_NOT_FOUND"`), `provide-zip.json` (HTTP 400, `PROVIDE_ZIP_CODE`), `unauthorized.json` (HTTP 401).
- [ ] **Step 2: Write the failing tests**

```ts
test('performs the firebase then oauth then details chain on a cold cache', async () => { /* assert 4 calls in order */ })
test('reuses a cached token and skips firebase and oauth entirely', async () => { /* assert 1 call */ })
test('refetches the chain when the cached token is expired', async () => {})
test('refetches the chain on a 401 and retries the details call once', async () => {})
test('the details call is a POST with an empty body', async () => {})
test('sends dataForVerification when a postal code is available', async () => {})
test('a 400 PROVIDE_ZIP_CODE retries once without the postcode', async () => {})
test('a 400 PARCEL_NOT_FOUND maps to not_found', async () => {})
test('a 503 maps to transport, not not_found', async () => {})
test('UNSUCCESSFUL_DELIVERY_ATTEMPT maps to failed_attempt and keeps the parcel active', async () => {
  expect(r.status).toBe('failed_attempt')   // never 'returned'
})
test('PARCEL_HANDED appearing after later milestones is treated as in_transit, not acceptance', async () => {})
test('notice-only codes SPE, MSDLO, MIDLI and ENA never set the parcel status', async () => {})
test('uses eventDateAndTimeZoneId for event timestamps', async () => {})
test('extracts the pickup pass and PUDO details as a pickup point', async () => {})
test('AVAILABLE_FOR_COLLECTION maps to ready_for_pickup', async () => {})
```

- [ ] **Step 3: Run to verify failure**
- [ ] **Step 4: Write `src/carriers/dpd-codes.ts`** — milestone map plus the scan-code groupings and the notice-only exclusion set from spec §6.5.
- [ ] **Step 5: Implement the adapter**, with the token cache persisted in a small table or a file under `data/`.
- [ ] **Step 6: Run to verify pass** (expected 15 passed)
- [ ] **Step 7: Commit** — `git commit -m "feat: DPD adapter with cached oauth chain"`

### Task 11b: Register all adapters

- [ ] **Step 1: Write the failing test** in `test/registry.test.ts`

```ts
test('all five adapters are registered', () => { expect(allAdapters().map(a => a.id).sort())
  .toEqual(['dpd','gls','packeta','posta','sps']) })
test('detectCarrier prefers the distinctive carriers over the ambiguous ones', () => {})
```

- [ ] **Step 2–4: run/implement/run** — register all five in `src/carriers/registry.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat: register all five carrier adapters"`

---

## Task 12: Notifier

**Files:**
- Create: `src/notify/types.ts`, `src/notify/send.ts`
- Test: `test/notify-send.test.ts`

**Interfaces:**
- Produces: `interface Notification { groupKey: string; title: string; message: string; url?: string }`; `interface Notifier { send(n: Notification): Promise<void> }`; `createNotifier(mode: Config['notifier'], spawn?: SpawnFn): Notifier`.

- [ ] **Step 1: Write the failing tests** — **Review Focus item 4 lives here**

```ts
test('terminal-notifier receives title, message, group and open as separate argv entries', async () => {
  // assert args array, never a single shell string
})
test('a message containing double quotes, backslashes and newlines is passed through unmodified in argv', async () => {
  const n = { title: 'A "quoted" \\ parcel', message: 'line1\nline2 $(whoami) `id`', groupKey: 'p1' }
  // assert the argv entry equals the original string; assert no shell metacharacter interpretation
})
test('an emoji in the label survives intact', async () => {})
test('control characters are stripped and the message is truncated to the cap', async () => {})
test('auto mode selects terminal-notifier when it is on the path', async () => {})
test('auto mode falls back to osascript when terminal-notifier is absent', async () => {})
test('the osascript fallback escapes quotes and backslashes in the AppleScript string literal', async () => {})
test('send resolves even when the notifier process exits non-zero', async () => {})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement `src/notify/send.ts`** — `child_process.spawn` with an **argv array**, never `shell: true` and never string interpolation. `terminal-notifier` is located by absolute path (`/opt/homebrew/bin/terminal-notifier`) with a `PATH` lookup fallback. The `osascript` path must escape `"` and `\` for the AppleScript literal. Strip `[\x00-\x08\x0B\x0C\x0E-\x1F]`, cap at 200 chars.
- [ ] **Step 4: Run to verify pass** (expected 8 passed)
- [ ] **Step 5: Install the dependency**

Run: `brew install terminal-notifier`
Expected: installed; `/opt/homebrew/bin/terminal-notifier` exists.

- [ ] **Step 6: Commit** — `git commit -m "feat: notifier with argv-safe terminal-notifier and osascript fallback"`

---

## Task 13: Notification rules

**Files:**
- Create: `src/notify/rules.ts`
- Modify: `src/core/poll.ts` (call the rules, mark events notified)
- Test: `test/notify-rules.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6, 12.
- Produces: `buildNotifications(db, newEvents: ParcelEvent[], now: Date, port: number): Notification[]` in `src/notify/rules.ts`. `markNotified(db, eventIds: number[], at: Date): void` belongs to `src/db/events.ts` (Task 3) and is only consumed here.

- [ ] **Step 1: Write the failing tests**

```ts
test('a status transition produces one notification', () => {})
test('new events that do not change the canonical status produce none', () => {
  // four depot scans overnight -> 0 notifications
})
test('the first appearance of a pickup location notifies with the address in the message', () => {
  expect(n.message).toContain('Z-BOX')
})
test('a retainedTill within 48h notifies once and never again for the same parcel', () => {})
test('a failed delivery attempt notifies', () => {})
test('a carrier entering gated notifies once and not again until it recovers', () => {})
test('groupKey is parcel-<id> so a later banner replaces the earlier one', () => {})
test('url points at http://127.0.0.1:<port>/parcel/<id>', () => {})
test('more than four notifications in one run collapse into a single summary', () => {
  expect(out).toHaveLength(1); expect(out[0].title).toMatch(/\d+ parcel updates/)
})
test('already-notified events are never notified again', () => {})
test('ready_for_pickup without a deadline omits the collect-by clause entirely', () => {
  expect(n.message).not.toMatch(/collect by/i)
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement `src/notify/rules.ts`** per spec §10 — fires on status transition, first pickup location, failed attempt, deadline within 48h, adapter gated; quiet on same-status events and the notice-only codes.
- [ ] **Step 4: Wire into `runPoll`** — build notifications, send them, `markNotified` inside the same transaction.
- [ ] **Step 5: Run to verify pass** (expected 11 passed)
- [ ] **Step 6: Commit** — `git commit -m "feat: notification rules with coalescing and exactly-once delivery"`

---

## Task 14: launchd agents

**Files:**
- Create: `launchd/local.parcels.poller.plist.template`, `launchd/local.parcels.web.plist.template`, `scripts/install-agents.sh`, `src/core/sleepgap.ts`
- Test: `test/sleepgap.test.ts`, `test/install-agents.test.sh`

**Interfaces:**
- Produces: `sleptSinceMs(prevWallMs: number, prevUptimeMs: number): number`.

- [ ] **Step 1: Write the poller plist template** — `Label`, `ProgramArguments` = `[/usr/bin/caffeinate, -i, /Users/you/.nvm/versions/node/v24.21.0/bin/node, <ABS_DIR>/dist/poll.js]`, **`StartCalendarInterval` as an array of 15 dicts** for `Minute: 0` at `Hour` 7 through 21, `StandardOutPath`/`StandardErrorPath` under `data/`, `EnvironmentVariables` with an explicit `PATH`.
- [ ] **Step 2: Write the web plist template** — `KeepAlive: true`, `RunAtLoad: true`, same node path, `dist/server.js`.
- [ ] **Step 3: Write the failing test** in `test/sleepgap.test.ts`

```ts
test('reports roughly zero sleep when wall and uptime advance together', () => {})
test('reports the difference when wall advances more than uptime', () => {
  expect(sleptSinceMs(wall0 + 3_600_000, up0 + 600_000)).toBeCloseTo(3_000_000, -4)
})
test('never reports negative sleep', () => {})
```

- [ ] **Step 4: Run to verify failure, then implement `src/core/sleepgap.ts`** using `Date.now()` against `process.hrtime.bigint()`-derived uptime, persisting the previous pair in the DB. A gap over 6 hours forces a full refresh of all active parcels regardless of backoff tier.
- [ ] **Step 5: Write `scripts/install-agents.sh`** — substitutes the absolute project dir into both templates, writes them to `~/Library/LaunchAgents/`, `chmod 644`, then `launchctl bootout` (ignoring failure) followed by `launchctl bootstrap gui/$(id -u) <plist>`. Must use `bootstrap`, never `load`.
- [ ] **Step 6: Verify the plists are valid and the agents register**

Run: `plutil -lint ~/Library/LaunchAgents/local.parcels.*.plist && launchctl print gui/$(id -u)/local.parcels.poller | head -20`
Expected: both lint OK; `launchctl print` shows the poller with `type = LaunchAgent`.

- [ ] **Step 7: Force one real run and confirm it completes**

Run: `launchctl kickstart -k gui/$(id -u)/local.parcels.poller && sleep 5 && tail -20 data/poll.log`
Expected: a one-line summary, exit 0, no stack trace.

- [ ] **Step 8: Commit** — `git commit -m "feat: launchd agents with StartCalendarInterval and sleep-gap detection"`

---

## Task 15: Web UI — in-flight and parcel detail

**Files:**
- Create: `src/web/server.ts`, `src/web/views/layout.ts`, `src/web/views/index.ts`, `src/web/views/parcel.ts`, `src/web/static/style.css`, `src/server.ts`
- Test: `test/web-core.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 6.
- Produces: `buildServer(deps: { db, config }): FastifyInstance`.

- [ ] **Step 1: Write the failing tests** (use `fastify.inject`, no real socket)

```ts
test('GET / lists active parcels with label, carrier and status', async () => {})
test('GET / shows the pickup location and deadline when a parcel is ready for pickup', async () => {})
test('GET / renders an empty state when there are no active parcels', async () => {})
test('GET /parcel/:id renders the event timeline oldest-first', async () => {})
test('GET /parcel/:id returns 404 for an unknown id', async () => {})
test('GET /parcel/:id includes an Apple Maps link when the pickup point has coordinates', async () => {})
test('GET /parcel/:id omits the maps link when coordinates are absent', async () => {})
test('a parcel label containing HTML is escaped, not rendered as markup', async () => {
  expect(body).not.toContain('<script>')
})
test('the server binds 127.0.0.1 only', () => {})
```

- [ ] **Step 2: Run to verify failure, 3: implement, 4: run to verify pass** (expected 9 passed). Views are template functions returning HTML strings with a shared `escapeHtml`.
- [ ] **Step 5: Commit** — `git commit -m "feat: web ui in-flight list and parcel detail"`

---

## Task 16: Web UI — history, health, attention, actions

**Files:**
- Create: `src/web/views/history.ts`, `src/web/views/health.ts`, `src/web/views/attention.ts`
- Modify: `src/web/server.ts`
- Test: `test/web-pages.test.ts`

**Interfaces:**
- Consumes: Task 15, `carrierHealth` (Task 6).
- Produces: routes `/history`, `/health`, `/attention`, `POST /refresh`, `POST /parcel/:id/label`, `POST /add`, `POST /attention/:messageId/assign`.

- [ ] **Step 1: Write the failing tests**

```ts
test('GET /history lists delivered parcels newest-first', async () => {})
test('GET /history?carrier=posta filters by carrier', async () => {})
test('GET /history?q=alza matches the merchant and the label', async () => {})
test('GET /history reports a median delivery time per carrier', async () => {})
test('GET /health shows each carrier with last-ok and consecutive failures', async () => {})
test('GET /health marks a carrier with a gated error as needing attention', async () => {})
test('GET /attention lists unparsed messages with subject and sender', async () => {})
test('POST /add creates a parcel and redirects to its detail page', async () => {})
test('POST /add rejects a duplicate with a 409 and a readable message', async () => {})
test('POST /parcel/:id/label updates the label', async () => {})
test('POST /refresh triggers a poll of the given parcel only', async () => {})
```

- [ ] **Step 2: Run to verify failure, 3: implement, 4: run to verify pass** (expected 11 passed)
- [ ] **Step 5: Commit** — `git commit -m "feat: web ui history, health, attention and actions"`

---

## Task 17: IMAP ingest

**Files:**
- Create: `src/ingest/imap.ts`, `src/db/messages.ts`
- Test: `test/ingest-imap.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `fetchUnseen(deps: { config, client?: ImapLike }): Promise<RawMessage[]>` where `RawMessage = { messageId: string; from: string; subject: string; receivedAt: Date; raw: Buffer }`; `storeMessage(db, m: RawMessage, dir: string): number`; `markSeen(client, uids: number[]): Promise<void>`.

- [ ] **Step 1: Write the failing tests** — **Review Focus item 3 lives here**. Inject a fake IMAP client; no network.

```ts
test('fetches only UNSEEN messages from the configured mailbox', async () => {})
test('writes the raw eml to disk and records its path', async () => {})
test('storeMessage is idempotent on message-id: a second store returns the same row', async () => {
  // Review Focus 3: the same email forwarded twice
})
test('messages are marked seen only after the transaction commits', async () => {
  // simulate a throw mid-transaction; assert markSeen was never called
})
test('a message exceeding the size cap is recorded as unparsed rather than stored whole', async () => {})
test('fetchUnseen resolves to an empty array when the mailbox is empty', async () => {})
test('an IMAP connection failure is reported without aborting the poll run', async () => {})
```

- [ ] **Step 2: Run to verify failure, 3: implement using `imapflow`, 4: run to verify pass** (expected 7 passed)
- [ ] **Step 5: Commit** — `git commit -m "feat: imap ingest with idempotent message storage"`

---

## Task 18: Email extraction

**Files:**
- Create: `src/ingest/extract.ts`
- Modify: `src/core/poll.ts` (ingest step before polling)
- Test: `test/ingest-extract.test.ts`, `test/fixtures/mail/*.eml`

**Interfaces:**
- Consumes: Tasks 4, 17.
- Produces: `extract(raw: Buffer): Promise<Extraction>` where `Extraction = { carrier?: CarrierId; number?: string; merchant?: string; confidence: 'sender'|'shape'|'none' }`; `ingestMessages(db, deps): Promise<{ created: number; needsAttention: number }>`.

- [ ] **Step 1: Create `.eml` fixtures** — a Packeta notification; a Slovenská pošta notification; a **Gmail-forwarded** DPD mail where the original sender is only in the forwarded headers; an e-shop dispatch mail naming GLS and a number; a newsletter containing a number-like string but no carrier; a mail with no number at all; a duplicate of the Packeta one.
- [ ] **Step 2: Write the failing tests**

```ts
test('identifies the carrier from the sender domain', async () => {})
test('reads the original sender from a Gmail-forwarded wrapper, not the envelope', async () => {
  expect((await extract(fwd)).carrier).toBe('dpd')
})
test('extracts the tracking number with the carrier-specific regex', async () => {})
test('extracts the merchant from the forwarded subject', async () => {})
test('falls back to shape detection when the sender gives no hint', async () => {
  expect(e.confidence).toBe('shape')
})
test('a newsletter with a number-like string but no carrier yields confidence none', async () => {})
test('a mail with no number yields confidence none and lands in needs-attention', async () => {})
test('ingestMessages creates one parcel per new message and links it', async () => {})
test('ingestMessages does not create a second parcel for a re-forwarded duplicate', async () => {})
test('unparsed mail is recorded with parsed_ok = 0 and never silently dropped', async () => {})
test('a stored message can be reprocessed from disk after a parser change', async () => {})
```

- [ ] **Step 3: Run to verify failure, 4: implement, 5: run to verify pass** (expected 11 passed)
- [ ] **Step 6: Wire `ingestMessages` into `runPoll`** as step 1, guarded so an IMAP failure records health and lets carrier polling proceed.
- [ ] **Step 7: Full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 8: Commit** — `git commit -m "feat: email extraction with sender-based carrier detection"`

---

## Task 19: README and end-to-end smoke

**Files:**
- Create: `README.md`
- Test: manual verification steps below.

- [ ] **Step 1: Write `README.md`** — the Gmail forward-rule setup, `config.json` fields, `brew install terminal-notifier`, `scripts/install-agents.sh`, the `probe` command for the spec §15 confirmations, and how to query `data/parcels.db` directly.
- [ ] **Step 2: Add a parcel manually and confirm it appears**

Run: `node dist/cli.js add RA123456785SK --label "Smoke test" && node dist/cli.js list`
Expected: one row listed.

- [ ] **Step 3: Run a real poll against the live API and confirm no crash**

Run: `node dist/poll.js && tail -5 data/poll.log`
Expected: a summary line; the fake number resolves to `pre_transit` or `not_found`; exit 0.

- [ ] **Step 4: Confirm a real notification is delivered**

Run: `node dist/cli.js notify-test`
Expected: a visible banner titled "Parcel Tracker" that opens the dashboard when clicked.

- [ ] **Step 5: Confirm the web UI serves**

Run: `curl -s localhost:8787 | head -20`
Expected: HTML listing the smoke-test parcel.

- [ ] **Step 6: Commit** — `git commit -m "docs: readme and setup guide"`
