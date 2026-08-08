-- KAN-362 — community POI corrections are staged separately from Foursquare
-- records.  A pending suggestion must never be visible to the nearby API;
-- only a moderator-created curated_poi row is eligible for search.

CREATE TABLE IF NOT EXISTS manual_poi_submission (
  submission_id       TEXT PRIMARY KEY,
  idempotency_key     TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  dedupe_name         TEXT NOT NULL,
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  poi_type            TEXT NOT NULL,
  attributes_json     TEXT NOT NULL,
  address             TEXT,
  contributor_note    TEXT,
  ip_hash             TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at        TEXT NOT NULL,
  reviewed_at         TEXT,
  reviewed_by         TEXT,
  rejection_reason    TEXT,
  approved_poi_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_manual_poi_submission_review
  ON manual_poi_submission (status, submitted_at);

-- The source is deliberately modelled separately from `poi`, whose primary
-- key is a real Foursquare id.  A manual id is therefore never presented to
-- future import/reconciliation code as if Foursquare had supplied it.
CREATE TABLE IF NOT EXISTS curated_poi (
  poi_id                     TEXT PRIMARY KEY,
  source                     TEXT NOT NULL CHECK (source IN ('community', 'manual')),
  source_submission_id       TEXT UNIQUE REFERENCES manual_poi_submission(submission_id),
  name                       TEXT NOT NULL,
  dedupe_name                TEXT NOT NULL,
  lat                        REAL NOT NULL,
  lng                        REAL NOT NULL,
  geohash                    TEXT NOT NULL,
  primary_poi_type           TEXT NOT NULL,
  address                    TEXT,
  status                     TEXT NOT NULL CHECK (status IN ('active', 'removed')),
  created_at                 TEXT NOT NULL,
  created_by                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  updated_by                 TEXT NOT NULL,
  removed_at                 TEXT,
  removed_by                 TEXT,
  removal_reason             TEXT
);

CREATE INDEX IF NOT EXISTS idx_curated_poi_geo
  ON curated_poi (geohash);
CREATE INDEX IF NOT EXISTS idx_curated_poi_name
  ON curated_poi (dedupe_name);

CREATE TABLE IF NOT EXISTS curated_poi_attribute (
  poi_id       TEXT NOT NULL REFERENCES curated_poi(poi_id),
  dimension    TEXT NOT NULL,
  value        TEXT NOT NULL,
  PRIMARY KEY (poi_id, dimension, value)
);

-- Immutable, operator-readable history for submissions and curated records.
CREATE TABLE IF NOT EXISTS manual_poi_audit (
  audit_id       TEXT PRIMARY KEY,
  target_kind    TEXT NOT NULL CHECK (target_kind IN ('submission', 'curated_poi')),
  target_id      TEXT NOT NULL,
  action         TEXT NOT NULL,
  actor          TEXT NOT NULL,
  detail_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_manual_poi_audit_target
  ON manual_poi_audit (target_kind, target_id, created_at);

-- A short fixed-window guard complements Turnstile.  It stores a hash rather
-- than the contributor's raw network address.
CREATE TABLE IF NOT EXISTS manual_poi_rate_limit (
  ip_hash            TEXT PRIMARY KEY,
  window_started_at  TEXT NOT NULL,
  request_count      INTEGER NOT NULL
);
