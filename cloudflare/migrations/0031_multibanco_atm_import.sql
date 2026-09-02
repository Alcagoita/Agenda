-- KAN-440 — first-class, official MULTIBANCO ATM source.
--
-- This is additive.  Existing Foursquare, OSM and curated rows remain
-- untouched.  The read path applies the Odivelas rollout precedence instead
-- of deleting a lower-priority source, so rollback is simply a Worker
-- rollback (and, if necessary, dropping these additive tables later).

CREATE TABLE IF NOT EXISTS multibanco_poi (
  source_id           TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  dedupe_name         TEXT NOT NULL,
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  geohash             TEXT NOT NULL,
  primary_poi_type    TEXT NOT NULL CHECK (primary_poi_type = 'atm'),
  address             TEXT NOT NULL,
  parish              TEXT,
  store_type          TEXT,
  campaign            TEXT,
  source_url          TEXT NOT NULL,
  raw_payload_json    TEXT NOT NULL,
  fetched_at          TEXT NOT NULL,
  imported_at         TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  -- The Odivelas pilot was boundary-filtered before it was imported.  This
  -- explicit flag is the initial, reversible rollout zone for precedence.
  is_demo_zone        INTEGER NOT NULL DEFAULT 0 CHECK (is_demo_zone IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_multibanco_poi_geo ON multibanco_poi (geohash);

-- The pilot created this provenance table directly in production.  Create
-- the compatible shape for fresh deployments; do not rebuild it, because it
-- is source evidence and a migration must not discard evidence.
CREATE TABLE IF NOT EXISTS multibanco_import_staging (
  source_id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL CHECK (source_name = 'multibanco'),
  municipality_relation_id INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  request_bounds_json TEXT NOT NULL,
  raw_payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  published_poi_id TEXT NOT NULL,
  published_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_multibanco_import_staging_municipality
  ON multibanco_import_staging(municipality_relation_id);

-- Move the already-reviewed Odivelas pilot into the provider's own serving
-- table without deleting its curated row.  The Worker excludes that legacy
-- `multibanco:` curated representation once this source is available.
INSERT OR IGNORE INTO multibanco_poi
  (source_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, address,
   parish, store_type, campaign, source_url, raw_payload_json, fetched_at,
   imported_at, updated_at, is_demo_zone)
SELECT c.poi_id, c.name, c.dedupe_name, c.lat, c.lng, c.geohash, 'atm', c.address,
       NULL, NULL, NULL,
       COALESCE(s.source_url, 'https://www.multibanco.pt/wp-admin/admin-ajax.php?action=sibs_get_markers'),
       COALESCE(s.raw_payload_json, '{}'),
       COALESCE(s.fetched_at, c.updated_at), c.created_at, c.updated_at,
       CASE WHEN s.municipality_relation_id = 5400891 THEN 1 ELSE 0 END
FROM curated_poi c
LEFT JOIN multibanco_import_staging s ON s.source_id = c.poi_id
WHERE c.poi_id LIKE 'multibanco:%' AND c.primary_poi_type = 'atm' AND c.status = 'active';

CREATE TABLE IF NOT EXISTS multibanco_import (
  country_code           TEXT PRIMARY KEY REFERENCES country(country_code),
  status                 TEXT NOT NULL CHECK (status IN ('none', 'mapping', 'mapped', 'failed')),
  active_run_id          TEXT,
  started_at             TEXT,
  completed_at           TEXT,
  batch_worker_id        TEXT,
  batch_lease_expires_at TEXT,
  backoff_until          TEXT,
  cancel_requested       INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  last_error             TEXT
);

CREATE TABLE IF NOT EXISTS multibanco_import_scope (
  country_code     TEXT NOT NULL REFERENCES country(country_code),
  place_id         TEXT NOT NULL REFERENCES place(place_id),
  status           TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  worker_id        TEXT,
  lease_expires_at TEXT,
  completed_at     TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  published        INTEGER NOT NULL DEFAULT 0,
  rejected         INTEGER NOT NULL DEFAULT 0,
  duplicates       INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  PRIMARY KEY (country_code, place_id)
);
CREATE INDEX IF NOT EXISTS idx_multibanco_import_scope_claim
  ON multibanco_import_scope (country_code, status, lease_expires_at);
