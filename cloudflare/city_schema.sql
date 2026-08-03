-- Renamed from `coverage` (KAN-329) — this is a city today, not a
-- speculative geohash-tiling concept that was never built. One row per
-- built settlement, in the shared brush-poi-registry database alongside
-- `poi` (schema.sql) and `build_log` (build_log_schema.sql).

CREATE TABLE IF NOT EXISTS city (
  city_id          TEXT PRIMARY KEY,   -- slug, e.g. "lisboa", "odivelas"
  name             TEXT NOT NULL,
  country          TEXT,
  center_lat       REAL NOT NULL,
  center_lng       REAL NOT NULL,
  radius_km        REAL NOT NULL,
  min_lat          REAL,
  max_lat          REAL,
  min_lng          REAL,
  max_lng          REAL,
  status           TEXT NOT NULL CHECK (status IN ('none', 'building', 'ready')),
  current_build_id TEXT,
  last_built_at    TEXT
);
