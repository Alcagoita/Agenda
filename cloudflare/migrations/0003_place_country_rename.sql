-- KAN-355. `city` -> `place`, drop the invented center/radius model, add
-- `country`, rename city_id -> place_id everywhere. Full reasoning:
-- docs/poi-coverage-model.md.
--
-- SQLite/D1 can't ALTER a CHECK constraint in place (status vocabulary
-- changes from none/building/ready to none/mapping/mapped), so `place` is a
-- full rebuild, not a plain ALTER — same standard SQLite table-rebuild
-- pattern, just bigger than migration 0001/0002's single ALTERs.
--
-- Existing rows are keyed on slugs ('lisboa', 'odivelas') — migrated here to
-- their real Nominatim municipality identities (osm_type:osm_id), resolved
-- live against Nominatim on 2026-08-05:
--   lisboa   -> osm-relation-2897141 (zoom=8 reverse geocode of the city's
--               own center — zoom=10, this Worker's usual resolution zoom,
--               resolves inside Lisboa to "Arroios", one of its freguesia
--               subdivisions, not the municipality itself; see index.ts's
--               resolvePlaceIdentity for the bounded zoom-retry that now
--               handles this generally)
--   odivelas -> osm-relation-6522461 (zoom=10 already resolves correctly —
--               Odivelas has no freguesia layer between it and the point)
--
-- min/max lat/lng for both are NOT the true ingested extent (this database
-- has no local record of the actual loaded POIs' bounding coordinates to
-- migrate from) — approximated instead from the old center/radius circle's
-- bounding box, using the same formula the extraction scripts themselves
-- used to compute their query bbox (see extraction/extract_lisboa.sql /
-- extract_odivelas.sql, which this closely matches). Conservative
-- superset of the circle, safe as a stand-in until KAN-354 re-maps either
-- Place and overwrites it with the real ingested extent.
--
-- Run: npx wrangler d1 execute brush-poi-registry --remote --file=migrations/0003_place_country_rename.sql

-- Defers FK checking to the end of D1's implicit transaction for this whole
-- file, rather than disabling it outright — place_new's country_code FK
-- would otherwise fail mid-migration (place_new is populated before
-- `country` has committed in the same sense a real transaction would need).
PRAGMA defer_foreign_keys = ON;

CREATE TABLE country (
  country_code TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('none', 'mapping', 'mapped')),
  build_id     TEXT,
  mapped_at    TEXT,
  place_count  INTEGER NOT NULL DEFAULT 0
);

INSERT INTO country (country_code, name, status) VALUES ('PT', 'Portugal', 'none');

CREATE TABLE place_new (
  place_id         TEXT PRIMARY KEY,
  country_code     TEXT REFERENCES country(country_code),
  name             TEXT NOT NULL,
  place_kind       TEXT,
  status           TEXT NOT NULL CHECK (status IN ('none', 'mapping', 'mapped')),
  min_lat          REAL,
  max_lat          REAL,
  min_lng          REAL,
  max_lng          REAL,
  build_id         TEXT,
  mapped_at        TEXT,
  request_count      INTEGER NOT NULL DEFAULT 0,
  first_requested_at TEXT,
  last_requested_at  TEXT
);

INSERT INTO place_new (
  place_id, country_code, name, place_kind, status,
  min_lat, max_lat, min_lng, max_lng,
  build_id, mapped_at, request_count, first_requested_at, last_requested_at
)
SELECT
  CASE city_id
    WHEN 'lisboa'   THEN 'osm-relation-2897141'
    WHEN 'odivelas' THEN 'osm-relation-6522461'
    ELSE city_id
  END,
  'PT',
  name,
  NULL,
  CASE status WHEN 'building' THEN 'mapping' WHEN 'ready' THEN 'mapped' ELSE 'none' END,
  COALESCE(min_lat, CASE city_id WHEN 'lisboa' THEN 38.632209909909909 WHEN 'odivelas' THEN 38.746054954954964 END),
  COALESCE(max_lat, CASE city_id WHEN 'lisboa' THEN 38.812390090090090 WHEN 'odivelas' THEN 38.836145045045044 END),
  COALESCE(min_lng, CASE city_id WHEN 'lisboa' THEN -9.254440495379864 WHEN 'odivelas' THEN -9.243325770101443 END),
  COALESCE(max_lng, CASE city_id WHEN 'lisboa' THEN -9.024159504620137 WHEN 'odivelas' THEN -9.128074229898559 END),
  current_build_id,
  last_built_at,
  request_count, first_requested_at, last_requested_at
FROM city;

DROP TABLE city;
ALTER TABLE place_new RENAME TO place;

-- Derived, not hardcoded — counts whatever place_new actually produced
-- rather than assuming exactly the two rows this migration was written
-- against. Every migrated row is assigned 'PT' above (this migration only
-- ever runs against the current Portugal-only dataset — see the file's own
-- top comment), so a straight count is correct without a WHERE.
UPDATE country SET place_count = (SELECT COUNT(*) FROM place WHERE country_code = 'PT') WHERE country_code = 'PT';

-- poi / poi_type / poi_attribute / build_log: city_id -> place_id, and
-- remap the two known slug values to their new identities.
ALTER TABLE poi RENAME COLUMN city_id TO place_id;
UPDATE poi
   SET place_id = 'osm-relation-2897141'
 WHERE place_id = 'lisboa';
UPDATE poi
   SET place_id = 'osm-relation-6522461'
 WHERE place_id = 'odivelas';
DROP INDEX IF EXISTS idx_poi_city_geo;
DROP INDEX IF EXISTS idx_poi_city_build;
CREATE INDEX idx_poi_place_geo   ON poi (place_id, geohash);
CREATE INDEX idx_poi_place_build ON poi (place_id, build_id);

ALTER TABLE poi_type RENAME COLUMN city_id TO place_id;
UPDATE poi_type
   SET place_id = 'osm-relation-2897141'
 WHERE place_id = 'lisboa';
UPDATE poi_type
   SET place_id = 'osm-relation-6522461'
 WHERE place_id = 'odivelas';

ALTER TABLE poi_attribute RENAME COLUMN city_id TO place_id;
UPDATE poi_attribute
   SET place_id = 'osm-relation-2897141'
 WHERE place_id = 'lisboa';
UPDATE poi_attribute
   SET place_id = 'osm-relation-6522461'
 WHERE place_id = 'odivelas';

ALTER TABLE build_log RENAME COLUMN city_id TO place_id;
UPDATE build_log
   SET place_id = 'osm-relation-2897141'
 WHERE place_id = 'lisboa';
UPDATE build_log
   SET place_id = 'osm-relation-6522461'
 WHERE place_id = 'odivelas';
