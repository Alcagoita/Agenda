-- KAN-438. Retire the active Foursquare and August OSM datasets.
--
-- The 2026-08-29 backups are immutable audit material. Before deleting the
-- active Foursquare rows, retain only the agreed non-commercial fallback:
-- banks plus heritage, cultural, nature/scenic and visitor destinations.
-- ATMs are deliberately excluded: the official MULTIBANCO import owns them.

CREATE TABLE IF NOT EXISTS legacy_poi (
  source_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dedupe_name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  geohash TEXT NOT NULL,
  primary_poi_type TEXT NOT NULL,
  address TEXT,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_legacy_poi_geo ON legacy_poi (geohash);
CREATE INDEX IF NOT EXISTS idx_legacy_poi_name ON legacy_poi (dedupe_name);
CREATE TABLE IF NOT EXISTS legacy_poi_type (
  source_id TEXT NOT NULL REFERENCES legacy_poi(source_id),
  poi_type TEXT NOT NULL,
  rank INTEGER NOT NULL,
  PRIMARY KEY (source_id, poi_type)
);
CREATE INDEX IF NOT EXISTS idx_legacy_poi_type_type ON legacy_poi_type (poi_type, source_id);

-- This allowlist is intentionally narrow. Everyday commerce is Overture's
-- responsibility; this frozen layer exists only for the Outings gaps.
INSERT OR IGNORE INTO legacy_poi
  (source_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, address, imported_at)
SELECT p.fsq_place_id, p.name, p.dedupe_name, p.lat, p.lng, p.geohash,
       t.poi_type, p.address, CURRENT_TIMESTAMP
FROM poi_backup_20260829 p
JOIN poi_type_backup_20260829 t ON t.fsq_place_id = p.fsq_place_id
WHERE t.poi_type IN (
  'bank', 'amusement_park', 'aquarium', 'art_gallery', 'beach',
  'botanical_garden', 'bridge', 'campground', 'cemetery', 'church',
  'cultural_center', 'golf_course', 'hiking_area', 'historical_landmark',
  'hot_spring', 'island', 'lake', 'lighthouse', 'marina', 'mountain',
  'movie_theater', 'museum', 'music_venue', 'nature_preserve', 'park',
  'plaza', 'river', 'surf_spot', 'theatre', 'tourist_attraction',
  'viewpoint', 'water_park', 'waterfall', 'winery', 'zoo'
)
AND NOT EXISTS (
  SELECT 1 FROM poi_type_backup_20260829 earlier
  WHERE earlier.fsq_place_id = t.fsq_place_id
    AND earlier.poi_type IN (
      'bank', 'amusement_park', 'aquarium', 'art_gallery', 'beach',
      'botanical_garden', 'bridge', 'campground', 'cemetery', 'church',
      'cultural_center', 'golf_course', 'hiking_area', 'historical_landmark',
      'hot_spring', 'island', 'lake', 'lighthouse', 'marina', 'mountain',
      'movie_theater', 'museum', 'music_venue', 'nature_preserve', 'park',
      'plaza', 'river', 'surf_spot', 'theatre', 'tourist_attraction',
      'viewpoint', 'water_park', 'waterfall', 'winery', 'zoo'
    ) AND earlier.rank < t.rank
)
AND NOT EXISTS (
  SELECT 1 FROM poi_source_correction c
  WHERE c.source = 'foursquare' AND c.source_id = p.fsq_place_id AND c.visible = 0
);

INSERT OR IGNORE INTO legacy_poi_type (source_id, poi_type, rank)
SELECT t.fsq_place_id, t.poi_type, t.rank
FROM poi_type_backup_20260829 t
JOIN legacy_poi l ON l.source_id = t.fsq_place_id
WHERE t.poi_type IN (
  'bank', 'amusement_park', 'aquarium', 'art_gallery', 'beach',
  'botanical_garden', 'bridge', 'campground', 'cemetery', 'church',
  'cultural_center', 'golf_course', 'hiking_area', 'historical_landmark',
  'hot_spring', 'island', 'lake', 'lighthouse', 'marina', 'mountain',
  'movie_theater', 'museum', 'music_venue', 'nature_preserve', 'park',
  'plaza', 'river', 'surf_spot', 'theatre', 'tourist_attraction',
  'viewpoint', 'water_park', 'waterfall', 'winery', 'zoo'
);

-- The immutable *_backup_20260829 tables and source corrections are not
-- touched. They are the rollback/audit copy for later legacy evaluation.
DELETE FROM poi_attribute;
DELETE FROM poi_type;
DELETE FROM poi;
DELETE FROM poi_candidate;
DELETE FROM osm_poi_attribute;
DELETE FROM osm_poi_type;
DELETE FROM osm_poi;
