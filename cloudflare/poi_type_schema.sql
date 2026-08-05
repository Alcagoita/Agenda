-- Multi-type support (KAN-335). A place can genuinely be more than one
-- type — "Pastelaria Alcôa" is tagged both Bakery and Café in Foursquare's
-- own data. `poi.primary_poi_type` (schema.sql) stays denormalized for
-- cheap single-icon/label display; this table is what search actually
-- matches against — every type a place qualifies for, not just one.
--
-- rank 0 = primary (same value as poi.primary_poi_type, kept in sync at
-- load time), rank 1+ = the place's other matched types, ordered by the
-- same priority list used to choose primary. Priority is deterministic —
-- driven by declaration order in src/poiTypeCategories.json, not by
-- Foursquare's own per-row category array order (which is inconsistent
-- across rows, so the same real-world category combo could otherwise pick
-- a different "primary" type depending on how Foursquare happened to
-- order that specific row's tags).

CREATE TABLE IF NOT EXISTS poi_type (
  place_id      TEXT NOT NULL,
  fsq_place_id TEXT NOT NULL,
  build_id     TEXT NOT NULL,
  poi_type     TEXT NOT NULL,
  rank         INTEGER NOT NULL,
  PRIMARY KEY (place_id, fsq_place_id, poi_type)
);

-- No secondary index: the only lookup against this table (index.ts EXISTS
-- subquery) filters on (place_id, fsq_place_id), the PK's own leading
-- columns — already covered. A (place_id, poi_type) index would never be
-- hit by that predicate shape, so it'd cost write overhead for nothing.
