-- KAN-404 — the staging table for rows the extraction filter used to
-- discard at source. Full rationale in cloudflare/poi_candidate_schema.sql;
-- this migration is how an existing database catches up to it.
--
-- Creates only. It does not read, alter or delete `poi`, `poi_type`,
-- `osm_poi` or anything else already in production, and the candidate load
-- excludes ids `poi` already holds so the two never overlap.
--
-- Reversible with a single `DROP TABLE poi_candidate;` once promotion is
-- finished — which is the reason the rows are staged here rather than
-- mixed into `poi` with a status column.

CREATE TABLE IF NOT EXISTS poi_candidate (
  fsq_place_id        TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  address             TEXT,
  locality            TEXT,
  raw_category_ids    TEXT,
  raw_category_labels TEXT,
  promotion_status    TEXT NOT NULL DEFAULT 'pending'
                        CHECK (promotion_status IN ('pending', 'promoted', 'rejected')),
  promotion_note      TEXT,
  imported_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_poi_candidate_status
  ON poi_candidate (promotion_status);
