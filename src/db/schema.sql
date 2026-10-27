CREATE TABLE IF NOT EXISTS parcels (
  id              INTEGER PRIMARY KEY,
  carrier         TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  label           TEXT,              -- user-editable display name
  merchant        TEXT,              -- parsed from email
  postal_code     TEXT,              -- for GLS/DPD; defaults from config
  status          TEXT NOT NULL,     -- CanonicalStatus
  last_announced_status TEXT NOT NULL DEFAULT 'unknown',
                                     -- the status the user was last told about. A status transition is
                                     -- `status <> last_announced_status`, so it survives a run that had
                                     -- no notifier or a failed send, and a transient 'unknown' is not one.
  pickup_announced INTEGER NOT NULL DEFAULT 0,   -- 1 once a pickup point has been announced
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
  last_polled_at  TEXT,              -- last REAL answer from the carrier (ok / not_found)
  last_attempted_at TEXT,            -- last attempt, answered or not; backoff gaps key on the later of the two
  needs_postcode  TEXT,              -- the postal code the carrier REJECTED ('' = none was stored);
                                     -- NULL means not flagged. The carrier is not queried again
                                     -- while postal_code still equals this value.
  last_changed_at TEXT,
  delivered_at    TEXT,
  source          TEXT NOT NULL,     -- 'email' | 'manual'
  source_message_id TEXT,
  archived_at     TEXT,
  UNIQUE (carrier, tracking_number)
);

CREATE TABLE IF NOT EXISTS events (
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

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  message_id   TEXT UNIQUE,
  received_at  TEXT,
  from_addr    TEXT,
  subject      TEXT,
  raw_path     TEXT,                 -- data/mail/<id>.eml
  parsed_ok    INTEGER NOT NULL,
  parse_note   TEXT,
  ignored      INTEGER NOT NULL DEFAULT 0,
                                     -- 1 when nothing in the message said it was about a parcel, so
                                     -- it is off /attention but still stored (dedupe key) and still
                                     -- reprocessable. `parse_note` says why. See ingest/extract.ts.
  parcel_id    INTEGER REFERENCES parcels(id)
);

CREATE TABLE IF NOT EXISTS carrier_health (
  carrier              TEXT PRIMARY KEY,
  last_ok_at           TEXT,
  last_error_at        TEXT,
  last_error_kind      TEXT,         -- 'gated' | 'transport' | 'parse'
  last_error_detail    TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  notified_at          TEXT
);

CREATE TABLE IF NOT EXISTS raw_responses (
  id         INTEGER PRIMARY KEY,
  parcel_id  INTEGER REFERENCES parcels(id),
  carrier    TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  body       TEXT NOT NULL
);

-- One row per parcel whose pickup-deadline reminder has been sent. Durable because the poller is a
-- short-lived process: "once per parcel" cannot live in memory. A table of its own (rather than a
-- parcels column) so an existing database gains it from the idempotent schema exec, with no migration.
CREATE TABLE IF NOT EXISTS deadline_reminders (
  parcel_id   INTEGER PRIMARY KEY REFERENCES parcels(id),
  notified_at TEXT NOT NULL
);

-- When the previous poll run completed (always one row, id = 1). Sleep-gap detection asks whether the
-- machine has woken since then; the poller is a fresh process each hour, so this must live in the DB.
CREATE TABLE IF NOT EXISTS last_poll (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  polled_at_ms INTEGER NOT NULL
);

-- Which previous poll time has already been announced as "the poller was away" (always one row, id = 1),
-- so the banner fires once per outage. A table of its own: an existing database gains it from the
-- idempotent schema exec, whereas a new column on last_poll would fail the schema check (no migrations).
CREATE TABLE IF NOT EXISTS stale_poll_notice (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  for_poll_ms INTEGER NOT NULL,
  notified_at TEXT NOT NULL
);

-- The mail ingest's own health (always one row, id = 1), mirroring last_poll. carrier_health cannot hold
-- it: that table is keyed by carrier, and the notification rules and Health page read it as carriers.
CREATE TABLE IF NOT EXISTS ingest_status (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  last_ok_at           TEXT,
  last_error_at        TEXT,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  notified_at          TEXT                  -- the current outage has been announced; cleared by the next ok
);

-- Where the mail ingest got to in each mailbox, so a run fetches `<last_uid + 1>:*` instead of `1:*`
-- and its cost stops growing with the size of the Gmail label.
--
-- `uid_validity` is the server's promise that those UIDs still mean the same messages. It is stored
-- as TEXT because it is an unsigned 32-bit number that imapflow hands over as a BigInt, and a string
-- comparison cannot lose a digit or round one. When it differs from what the server now reports,
-- every UID here is meaningless and the mailbox is read in full again (see `fetchMessages`).
--
-- Keyed by account AND mailbox: the same label name on a different account is a different mailbox
-- with unrelated UIDs, and resuming one from the other would silently hide every message in it.
-- `last_uid` is only ever advanced by a run that read its whole range AND stored every message in it.
-- A table of its own, so an existing database gains it from the idempotent schema exec, no migration.
CREATE TABLE IF NOT EXISTS imap_state (
  account      TEXT NOT NULL,                 -- 'user host:port': whose UIDs these are
  mailbox      TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  last_uid     INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (account, mailbox)
);

-- Geocoding results, keyed by the NORMALISED query string rather than by parcel, because several
-- parcels routinely wait at the same Z-BOX or post office and must cost one lookup between them.
-- Failures are rows too: without them a query that Nominatim cannot place, or that failed in
-- transit, would be re-sent every hour for ever, which is how a polite hourly poller turns into an
-- abuser of a free service. `attempts` counts CONSECUTIVE failures (0 once found) and drives the
-- back-off; `attempted_at` is when the last attempt was made, answered or not. A table of its own,
-- so an existing database gains it from the idempotent schema exec with no migration.
CREATE TABLE IF NOT EXISTS geocode_cache (
  query        TEXT PRIMARY KEY,
  outcome      TEXT NOT NULL,                 -- 'found' | 'not_found' | 'error'
  lat          REAL,
  lon          REAL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  attempted_at TEXT NOT NULL,
  detail       TEXT                           -- why the last attempt failed; diagnostics only
);

-- The code that opens a Z-BOX arrives ONLY in the pickup email; the tracking API never carries it.
-- It is therefore read back out of the stored .eml rather than from a carrier response.
-- `code` is TEXT and nullable on purpose. Real codes carry leading zeros (004467, 007018), which an
-- integer column would silently turn into a wrong code at the locker; NULL means "looked, there is
-- none", which is the permanent and correct state for a staffed pickup point where a person hands
-- the parcel over. `checked_messages` is how many of the parcel's emails had been scanned, so a
-- rescan happens only when that count grows and a codeless parcel is not re-read from disk hourly
-- for ever. A table of its own, so an existing database gains it from the idempotent schema exec.
CREATE TABLE IF NOT EXISTS pickup_codes (
  parcel_id        INTEGER PRIMARY KEY REFERENCES parcels(id),
  code             TEXT,
  checked_messages INTEGER NOT NULL,
  checked_at       TEXT NOT NULL
);

-- Which twice-daily "it is still waiting for you" reminders have been sent, one row per parcel per
-- slot. The poller is a fresh process every run, so "already reminded this morning" cannot live in
-- memory; and the slot key carries the local date, so the rows are naturally self-expiring rather
-- than needing a sweep. A table of its own, so an existing database gains it with no migration.
CREATE TABLE IF NOT EXISTS pickup_nudges (
  parcel_id INTEGER NOT NULL REFERENCES parcels(id),
  slot_key  TEXT NOT NULL,                       -- '2026-10-27T08:00' in Europe/Bratislava
  sent_at   TEXT NOT NULL,
  PRIMARY KEY (parcel_id, slot_key)
);

-- One row per poll run, whoever started it: the hourly poller, `cli poll`, or the "Refresh now" button.
-- This is the app's activity log, which is why every entry point writes it rather than only the button.
-- The row is opened BEFORE the run (the web refresh redirects to it and shows it while it is going) and
-- completed afterwards, so `finished_at IS NULL` means "in progress" - and a process killed mid-run can
-- therefore leave a row that nothing will ever finish, which `reapStaleRuns` closes. `mail_read` and
-- `created` are NULL (not 0) when the run had no mailbox to read, because "no mail configured" and "no
-- new mail" are different answers. Bounded to the newest POLL_RUNS_KEPT rows on every insert.
-- A table of its own, so an existing database gains it from the idempotent schema exec with no migration.
CREATE TABLE IF NOT EXISTS poll_runs (
  id          INTEGER PRIMARY KEY,
  trigger     TEXT NOT NULL,                 -- 'poller' | 'cli' | 'web'
  started_at  TEXT NOT NULL,
  finished_at TEXT,                          -- NULL while the run is still going
  polled      INTEGER NOT NULL DEFAULT 0,
  new_events  INTEGER NOT NULL DEFAULT 0,
  mail_read   INTEGER,
  created     INTEGER,
  failures    INTEGER NOT NULL DEFAULT 0,    -- carriers that failed during the run
  error       TEXT,                          -- why the run itself ended, when it did not complete
  summary     TEXT                           -- the one-line log summary, verbatim
);
