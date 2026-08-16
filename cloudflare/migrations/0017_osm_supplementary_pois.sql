-- KAN-383 — OSM is a supplementary POI source, never a fabricated
-- Foursquare record and never a moderated community submission.  The stable
-- OSM element identity makes repeated imports idempotent even when adjacent
-- settlement bboxes overlap.

CREATE TABLE osm_poi (
  osm_element_id      TEXT PRIMARY KEY, -- e.g. node/5335674113
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

CREATE INDEX idx_osm_poi_geo ON osm_poi (geohash);
CREATE INDEX idx_osm_poi_brand_geo ON osm_poi (brand, geohash);
CREATE INDEX idx_osm_poi_name ON osm_poi (dedupe_name);

CREATE TABLE osm_poi_type (
  osm_element_id TEXT NOT NULL REFERENCES osm_poi(osm_element_id),
  poi_type       TEXT NOT NULL,
  rank           INTEGER NOT NULL,
  PRIMARY KEY (osm_element_id, poi_type)
);
CREATE INDEX idx_osm_poi_type_type_place ON osm_poi_type (poi_type, osm_element_id);

CREATE TABLE osm_poi_attribute (
  osm_element_id TEXT NOT NULL REFERENCES osm_poi(osm_element_id),
  dimension      TEXT NOT NULL,
  value          TEXT NOT NULL,
  PRIMARY KEY (osm_element_id, dimension, value)
);

-- One durable state row per country-scale OSM run. A stopped Container can
-- safely be retried: source identities make the write itself idempotent.
CREATE TABLE osm_supplement_import (
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
