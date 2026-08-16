-- Single shared D1 database for ALL places — one shared table with a
-- place_id column, not one database per place (still true even off the Free
-- plan: 10GB is the hard per-database ceiling regardless of plan tier).
-- No R-tree support on D1 — geohash prefix range queries stand in for
-- radius search instead. Lives in the same DB as `place` (place_schema.sql),
-- `country` (country_schema.sql) and `build_log` (build_log_schema.sql) —
-- one database serves all four.
--
-- build_id (KAN-333): every load tags its rows with a fresh build_id.
-- Loading is INSERT OR REPLACE on the (place_id, fsq_place_id) PK, so a
-- place present in both the old and new build updates in place — no
-- duplicate risk. After loading, a sweep (DELETE WHERE place_id = ? AND
-- build_id != ?) removes anything that didn't reappear in the new build
-- (closed places). Not atomic with the load — a closed place can linger
-- for the duration of one load cycle between the two steps, never longer,
-- never duplicated.
--
-- primary_poi_type (KAN-335): display/icon only — a place can genuinely
-- match more than one type, and search matches against the poi_type table
-- (poi_type_schema.sql), not this column. Deliberate denormalization: every
-- result needs exactly one icon/label, and that shouldn't cost a join.
--
-- place_id (KAN-355): renamed from city_id — kept as a column (not
-- normalized away) because it's how you rebuild or delete one Place's POIs.
-- Whether it stays in the read query's predicate is measured against the
-- pre-rename ~23ms baseline (see index.ts's queryPoiDb), not assumed.

CREATE TABLE IF NOT EXISTS poi (
  fsq_place_id        TEXT NOT NULL,
  name                TEXT NOT NULL,
  dedupe_name         TEXT NOT NULL,          -- normalized at import time; together with coordinates identifies one real-world POI even when Foursquare supplies multiple IDs
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  geohash             TEXT NOT NULL,          -- precision 7 (~150m cell), lowercase base32 only (see geohash.ts's BASE32); prefix-range-queried for radius search (index.ts's queryPoiDb: `geohash >= ? AND geohash < ?~`). No COLLATE clause -> SQLite's default BINARY collation, which is what makes that range correct: BASE32 is already in ascending codepoint order, so byte comparison alone matches the intended geohash subtree. Never load an uppercase geohash into this column — it would sort before its lowercase siblings and silently miss every prefix range that should contain it.
  primary_poi_type    TEXT NOT NULL,          -- display/icon only — see poi_type table for the full match set
  brand               TEXT,                   -- matched at load time against src/constants/brandDictionary.json; NULL when no confident match — added to an existing table via migrations/0001_phase4_poi_attribute_brand.sql, CREATE TABLE IF NOT EXISTS alone won't add it
  category_label      TEXT,                   -- raw Foursquare category hierarchy, for debugging/display
  raw_category_ids    TEXT,                   -- '|'-joined fsq category ids, verbatim — populated during CSV loading; NULL only when a row's raw category string was itself empty
  raw_category_labels TEXT,                   -- '|'-joined fsq category labels, verbatim — populated during CSV loading; NULL only when a row's raw category string was itself empty
  address             TEXT,
  date_refreshed      TEXT NOT NULL,
  open_min            INTEGER,                -- KAN-318: opening time in minutes from local midnight; NULL = always open (also stands in for 24h and "unknown" — all "never hide" for Nearby)
  close_min           INTEGER,                -- KAN-318: closing time, minutes from local midnight; paired with open_min
  PRIMARY KEY (fsq_place_id)
);

CREATE INDEX IF NOT EXISTS idx_poi_geo ON poi (geohash);
CREATE INDEX IF NOT EXISTS idx_poi_brand_geo ON poi (brand, geohash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_poi_canonical_identity
  ON poi (dedupe_name, lat, lng);

-- KAN-383: OpenStreetMap-only POIs are deliberately kept outside `poi`.
-- `poi.fsq_place_id` must always be a genuine Foursquare identifier; an OSM
-- element has its own stable identity and is joined by the nearby query as a
-- supplementary source.
CREATE TABLE IF NOT EXISTS osm_poi (
  osm_element_id      TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  dedupe_name         TEXT NOT NULL,
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  geohash             TEXT NOT NULL,
  primary_poi_type    TEXT NOT NULL,
  brand               TEXT,
  address             TEXT,
  imported_at         TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  open_min            INTEGER,
  close_min           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_osm_poi_geo ON osm_poi (geohash);
CREATE INDEX IF NOT EXISTS idx_osm_poi_brand_geo ON osm_poi (brand, geohash);
CREATE INDEX IF NOT EXISTS idx_osm_poi_name ON osm_poi (dedupe_name);

CREATE TABLE IF NOT EXISTS osm_poi_type (
  osm_element_id TEXT NOT NULL REFERENCES osm_poi(osm_element_id),
  poi_type       TEXT NOT NULL,
  rank           INTEGER NOT NULL,
  PRIMARY KEY (osm_element_id, poi_type)
);
CREATE INDEX IF NOT EXISTS idx_osm_poi_type_type_place
  ON osm_poi_type (poi_type, osm_element_id);

CREATE TABLE IF NOT EXISTS osm_poi_attribute (
  osm_element_id TEXT NOT NULL REFERENCES osm_poi(osm_element_id),
  dimension      TEXT NOT NULL,
  value          TEXT NOT NULL,
  PRIMARY KEY (osm_element_id, dimension, value)
);

CREATE TABLE IF NOT EXISTS osm_supplement_import (
  country_code          TEXT PRIMARY KEY REFERENCES country(country_code),
  status                TEXT NOT NULL CHECK (status IN ('none', 'mapping', 'mapped', 'failed')),
  active_run_id         TEXT,
  started_at            TEXT,
  completed_at          TEXT,
  source_elements       INTEGER NOT NULL DEFAULT 0,
  inserted_rows         INTEGER NOT NULL DEFAULT 0,
  matched_skipped       INTEGER NOT NULL DEFAULT 0,
  ambiguous_skipped     INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT
);

-- KAN-386: reviewed source decisions are applied at read time so a later
-- Foursquare reload cannot reintroduce a venue that was replaced by a more
-- accurate OSM record. Raw source rows remain available for audit.
CREATE TABLE IF NOT EXISTS poi_source_correction (
  source                TEXT NOT NULL CHECK (source IN ('foursquare', 'openstreetmap')),
  source_id             TEXT NOT NULL,
  visible               INTEGER NOT NULL CHECK (visible IN (0, 1)),
  name_override         TEXT,
  dedupe_name_override  TEXT,
  review_note           TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source, source_id)
);
