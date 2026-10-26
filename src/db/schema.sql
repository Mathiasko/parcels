CREATE TABLE IF NOT EXISTS parcels (
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
  last_polled_at  TEXT,              -- last REAL answer from the carrier (ok / not_found)
  last_attempted_at TEXT,            -- last attempt, answered or not; backoff gaps key on the later of the two
  needs_postcode  INTEGER NOT NULL DEFAULT 0,  -- carrier cannot be queried until postal_code is set
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
