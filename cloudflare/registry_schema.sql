-- Coverage registry — lives in the shared brush-poi-registry database, next
-- to the `poi` table (schema.sql). Tracks which city/tile shards exist and
-- their build status, so the app knows whether to call our API or fall back
-- to OSM, and so RequestCoverage can dedup build triggers.

CREATE TABLE IF NOT EXISTS coverage (
  tile_id       TEXT PRIMARY KEY,        -- city slug for now (e.g. "lisboa", "odivelas") — matches poi.tile_id
  status        TEXT NOT NULL CHECK (status IN ('none', 'building', 'ready')),
  center_lat    REAL NOT NULL,
  center_lng    REAL NOT NULL,
  radius_km     REAL NOT NULL,
  last_built_at TEXT
);
