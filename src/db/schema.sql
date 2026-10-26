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
