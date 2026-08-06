-- KAN-354: POIs are global Foursquare entities. Places are coverage/build
-- metadata only, never a partition of nearby search. This collapses former
-- overlap duplicates keyed by (place_id, fsq_place_id).

CREATE TABLE poi_global (
  fsq_place_id TEXT PRIMARY KEY,
  name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, geohash TEXT NOT NULL,
  primary_poi_type TEXT NOT NULL, brand TEXT, category_label TEXT,
  raw_category_ids TEXT, raw_category_labels TEXT, address TEXT, date_refreshed TEXT NOT NULL
);
INSERT INTO poi_global
SELECT fsq_place_id, MIN(name), MIN(lat), MIN(lng), MIN(geohash), MIN(primary_poi_type),
       MIN(brand), MIN(category_label), MIN(raw_category_ids), MIN(raw_category_labels), MIN(address), MAX(date_refreshed)
FROM poi GROUP BY fsq_place_id;

CREATE TABLE poi_type_global (
  fsq_place_id TEXT NOT NULL, poi_type TEXT NOT NULL, rank INTEGER NOT NULL,
  PRIMARY KEY (fsq_place_id, poi_type)
);
INSERT INTO poi_type_global SELECT fsq_place_id, poi_type, MIN(rank) FROM poi_type GROUP BY fsq_place_id, poi_type;

CREATE TABLE poi_attribute_global (
  fsq_place_id TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (fsq_place_id, dimension, value)
);
INSERT OR IGNORE INTO poi_attribute_global (fsq_place_id, dimension, value)
SELECT fsq_place_id, dimension, value FROM poi_attribute;

DROP TABLE poi_attribute;
DROP TABLE poi_type;
DROP TABLE poi;
ALTER TABLE poi_global RENAME TO poi;
ALTER TABLE poi_type_global RENAME TO poi_type;
ALTER TABLE poi_attribute_global RENAME TO poi_attribute;
CREATE INDEX idx_poi_geo ON poi (geohash);
