-- KAN-355. Renamed from `city` (KAN-329/346) — "Place" is the app's own
-- word for any settlement (city, town, village; "Places I know", "Teach it
-- a new place"), and it's what this table has always modeled. Full
-- reasoning: docs/poi-coverage-model.md.
--
-- One row per settlement, in the shared brush-poi-registry database
-- alongside `poi` (schema.sql), `country` (country_schema.sql) and
-- `build_log` (build_log_schema.sql).
--
-- Its one job: telling a true zero from an unmapped one. Only queried on a
-- zero result (docs/poi-coverage-model.md's zero check) — that's what keeps
-- it cheap, and why no pre-computed coverage geometry is needed beyond the
-- extent actually ingested.

CREATE TABLE IF NOT EXISTS place (
  place_id         TEXT PRIMARY KEY,   -- Nominatim `osm_type:osm_id` for the settlement — stable, and exactly what coordinate resolution returns. No slug.
  country_code     TEXT REFERENCES country(country_code),
  name             TEXT NOT NULL,
  place_kind       TEXT,               -- city/town/village/administrative from Nominatim — reporting only, never logic
  status           TEXT NOT NULL CHECK (status IN ('none', 'mapping', 'mapped')),
  -- The extent actually ingested — set by the worker (KAN-354) once mapped,
  -- NULL until then. Not a boundary chosen in advance (that was the old
  -- center_lat/center_lng/radius_km model, and inventing a circle for every
  -- settlement on earth was the mess this table removes).
  min_lat          REAL,
  max_lat          REAL,
  min_lng          REAL,
  max_lng          REAL,
  build_id         TEXT,               -- which Foursquare release — renamed from current_build_id
  mapped_at        TEXT,               -- renamed from last_built_at
  -- KAN-346: demand recording, moved across unchanged. A 'none' row created
  -- by a real zero-check hit (not the country pre-build) counts and
  -- timestamps repeat requests, so the worker knows which unmapped Places
  -- to prioritize.
  request_count      INTEGER NOT NULL DEFAULT 0,
  first_requested_at TEXT,
  last_requested_at  TEXT
);
