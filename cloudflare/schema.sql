-- Single shared D1 database for ALL cities (Cloudflare Free plan caps at 10
-- databases/account and 500MB per database — one-database-per-city breaks
-- past 10 cities; one shared table with a tile_id column scales to ~70+
-- cities before this database alone approaches the 500MB ceiling, at current
-- ~7MB/city average). No R-tree support on D1 — geohash prefix range queries
-- stand in for radius search instead. Lives in the same DB as `coverage`
-- (registry_schema.sql) — one database serves both.

CREATE TABLE IF NOT EXISTS poi (
  fsq_place_id   TEXT NOT NULL,
  tile_id        TEXT NOT NULL,          -- which city this row belongs to (coverage.tile_id)
  name           TEXT NOT NULL,
  lat            REAL NOT NULL,
  lng            REAL NOT NULL,
  geohash        TEXT NOT NULL,          -- precision 7 (~150m cell), prefix-queried for radius search
  poi_type       TEXT NOT NULL,          -- Brush PoiType / poiDictionary key this row was classified into
  store_subtype  TEXT,                   -- only set when poi_type = 'store'
  food_subtype   TEXT,                   -- only set when poi_type = 'restaurant'
  category_label TEXT,                   -- raw Foursquare category hierarchy, for debugging/display
  address        TEXT,
  date_refreshed TEXT NOT NULL,
  PRIMARY KEY (tile_id, fsq_place_id)    -- same place could theoretically appear in two overlapping tiles
);

-- Just one secondary index, not two — each index roughly doubles D1's
-- "rows written" cost per insert/upsert (Free plan caps at 100k rows
-- written/day; observed 6,162 real rows costing 24,648 written — a 4x
-- multiplier from the composite PK + 2 secondary indexes). poi_type is
-- filtered from the already-narrow geohash-prefix result set in application
-- code instead of a dedicated index — that result set is small enough
-- (dozens to low hundreds of rows per query) that the unindexed filter is
-- cheap, and it cuts the write multiplier from 4x to 3x.
CREATE INDEX IF NOT EXISTS idx_poi_tile_geo ON poi (tile_id, geohash);
