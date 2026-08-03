-- Single shared D1 database for ALL cities — one shared table with a
-- city_id column, not one database per city (still true even off the Free
-- plan: 10GB is the hard per-database ceiling regardless of plan tier).
-- No R-tree support on D1 — geohash prefix range queries stand in for
-- radius search instead. Lives in the same DB as `city` (city_schema.sql)
-- and `build_log` (build_log_schema.sql) — one database serves all three.
--
-- build_id (KAN-333): every load tags its rows with a fresh build_id.
-- Loading is INSERT OR REPLACE on the (city_id, fsq_place_id) PK, so a
-- place present in both the old and new build updates in place — no
-- duplicate risk. After loading, a sweep (DELETE WHERE city_id = ? AND
-- build_id != ?) removes anything that didn't reappear in the new build
-- (closed places). Not atomic with the load — a closed place can linger
-- for the duration of one load cycle between the two steps, never longer,
-- never duplicated.

CREATE TABLE IF NOT EXISTS poi (
  fsq_place_id        TEXT NOT NULL,
  city_id             TEXT NOT NULL,          -- which city this row belongs to (city.city_id)
  build_id            TEXT NOT NULL,          -- generation tag for the sweep-delete build/swap procedure
  name                TEXT NOT NULL,
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  geohash             TEXT NOT NULL,          -- precision 7 (~150m cell), prefix-queried for radius search
  poi_type            TEXT NOT NULL,          -- Brush PoiType / poiDictionary key this row was classified into
  store_subtype       TEXT,                   -- only set when poi_type = 'store'
  food_subtype        TEXT,                   -- only set when poi_type = 'restaurant'
  category_label      TEXT,                   -- raw Foursquare category hierarchy, for debugging/display
  raw_category_ids    TEXT,                   -- '|'-joined fsq category ids, verbatim — populated during CSV loading; NULL only when a row's raw category string was itself empty
  raw_category_labels TEXT,                   -- '|'-joined fsq category labels, verbatim — populated during CSV loading; NULL only when a row's raw category string was itself empty
  address             TEXT,
  date_refreshed      TEXT NOT NULL,
  PRIMARY KEY (city_id, fsq_place_id)         -- same place could theoretically appear in two overlapping cities
);

CREATE INDEX IF NOT EXISTS idx_poi_city_geo   ON poi (city_id, geohash);
CREATE INDEX IF NOT EXISTS idx_poi_city_build ON poi (city_id, build_id);
