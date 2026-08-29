-- KAN-431 — the Overture staging and serving tables. Full rationale in
-- cloudflare/overture_schema.sql; this migration is how an existing database
-- catches up to it.
--
-- Creates only. It does not read, alter or delete `poi`, `poi_type`,
-- `osm_poi`, `curated_poi` or anything else already in production. Overture
-- rows live in their own tables under their own GERS ids, so there is no
-- overlap to reconcile and nothing existing changes shape.
--
-- Reversible with four DROP TABLEs.
--
-- Deliberately NOT included: widening `poi_source_correction`'s source CHECK
-- to accept 'overture'. Retiring an Overture row is KAN-435's job, and that
-- table holds 192 human decisions — rebuilding it (SQLite cannot alter a
-- CHECK in place) is a risk worth taking only when the capability is
-- actually needed, not in advance of it.

CREATE TABLE IF NOT EXISTS overture_candidate (
  overture_id       TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  lat               REAL NOT NULL,
  lng               REAL NOT NULL,
  address           TEXT,
  locality          TEXT,
  category          TEXT,
  basic_category    TEXT,
  category_path     TEXT,
  confidence        REAL,
  source_datasets   TEXT,
  promotion_status  TEXT NOT NULL DEFAULT 'pending'
                      CHECK (promotion_status IN ('pending', 'promoted', 'rejected')),
  promotion_note    TEXT,
  imported_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_overture_candidate_status
  ON overture_candidate (promotion_status);
CREATE INDEX IF NOT EXISTS idx_overture_candidate_category
  ON overture_candidate (category);

CREATE TABLE IF NOT EXISTS overture_poi (
  overture_id       TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  dedupe_name       TEXT NOT NULL,
  lat               REAL NOT NULL,
  lng               REAL NOT NULL,
  geohash           TEXT NOT NULL,
  primary_poi_type  TEXT NOT NULL,
  brand             TEXT,
  address           TEXT,
  category          TEXT,
  confidence        REAL,
  source_datasets   TEXT,
  open_min          INTEGER,
  close_min         INTEGER,
  imported_at       TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_overture_poi_geohash ON overture_poi (geohash);

CREATE TABLE IF NOT EXISTS overture_poi_type (
  overture_id  TEXT NOT NULL REFERENCES overture_poi(overture_id),
  poi_type     TEXT NOT NULL,
  rank         INTEGER NOT NULL,
  PRIMARY KEY (overture_id, poi_type)
);

CREATE INDEX IF NOT EXISTS idx_overture_poi_type_type ON overture_poi_type (poi_type);

CREATE TABLE IF NOT EXISTS overture_poi_attribute (
  overture_id  TEXT NOT NULL REFERENCES overture_poi(overture_id),
  dimension    TEXT NOT NULL,
  value        TEXT NOT NULL,
  PRIMARY KEY (overture_id, dimension, value)
);
