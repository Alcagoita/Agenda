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
  PRIMARY KEY (fsq_place_id)
);

CREATE INDEX IF NOT EXISTS idx_poi_geo ON poi (geohash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_poi_canonical_identity
  ON poi (dedupe_name, lat, lng);
