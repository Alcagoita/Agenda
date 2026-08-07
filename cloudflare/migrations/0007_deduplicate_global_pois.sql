-- KAN-359: Foursquare Open Map can expose the same real-world POI under
-- multiple fsq_place_id values. Nearby search is spatial, so retaining both
-- would show the user duplicate results. Keep the lexicographically first ID
-- as the canonical record, preserving all types and attributes on it.

ALTER TABLE poi ADD COLUMN dedupe_name TEXT;

-- D1 does not expose application-defined SQL functions during migrations, so
-- normalize existing Latin names character-by-character. This mirrors
-- normalize_text's lowercase, accent-removal, punctuation-to-space, and
-- whitespace-collapse rules for the names in this dataset (including PT).
WITH RECURSIVE normalized_characters(fsq_place_id, name, position, value) AS (
  SELECT fsq_place_id, name, 1, '' FROM poi
  UNION ALL
  SELECT fsq_place_id, name, position + 1,
    CASE
      WHEN instr('abcdefghijklmnopqrstuvwxyz0123456789', substr(name, position, 1)) > 0
        THEN value || substr(name, position, 1)
      WHEN instr('ABCDEFGHIJKLMNOPQRSTUVWXYZ', substr(name, position, 1)) > 0
        THEN value || lower(substr(name, position, 1))
      WHEN instr('ÀÁÂÃÄÅàáâãäåĀĂĄāăą', substr(name, position, 1)) > 0 THEN value || 'a'
      WHEN instr('ÇĆĈČçćĉč', substr(name, position, 1)) > 0 THEN value || 'c'
      WHEN instr('ÈÉÊËĒĔĖĘĚèéêëēĕėęě', substr(name, position, 1)) > 0 THEN value || 'e'
      WHEN instr('ÌÍÎÏĨĪĬĮìíîïĩīĭį', substr(name, position, 1)) > 0 THEN value || 'i'
      WHEN instr('ÑŃŇñńň', substr(name, position, 1)) > 0 THEN value || 'n'
      WHEN instr('ÒÓÔÕÖŌŎŐòóôõöōŏő', substr(name, position, 1)) > 0 THEN value || 'o'
      WHEN instr('ŔŘŕř', substr(name, position, 1)) > 0 THEN value || 'r'
      WHEN instr('ŚŜŞŠśŝşš', substr(name, position, 1)) > 0 THEN value || 's'
      WHEN instr('ÙÚÛÜŨŪŬŮŰŲùúûüũūŭůűų', substr(name, position, 1)) > 0 THEN value || 'u'
      WHEN instr('ÝŸýÿ', substr(name, position, 1)) > 0 THEN value || 'y'
      WHEN instr('ŹŻŽźżž', substr(name, position, 1)) > 0 THEN value || 'z'
      WHEN value = '' OR substr(value, -1, 1) = ' ' THEN value
      ELSE value || ' '
    END
  FROM normalized_characters
  WHERE position <= length(name)
), normalized_names AS (
  SELECT fsq_place_id, trim(value) AS dedupe_name
  FROM normalized_characters
  WHERE position > length(name)
)
UPDATE poi
SET dedupe_name = COALESCE((
  SELECT dedupe_name FROM normalized_names
  WHERE normalized_names.fsq_place_id = poi.fsq_place_id
), '');

-- A migration-only scratch table avoids recomputing the duplicate groups for
-- each child-table transfer and deletion. It is dropped before completion.
CREATE TABLE poi_duplicate_map (
  duplicate_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL
);

INSERT INTO poi_duplicate_map (duplicate_id, canonical_id)
SELECT duplicate.fsq_place_id, canonical.fsq_place_id
FROM poi AS duplicate
JOIN (
  SELECT dedupe_name, lat, lng, MIN(fsq_place_id) AS fsq_place_id
  FROM poi
  GROUP BY dedupe_name, lat, lng
  HAVING COUNT(*) > 1
) AS canonical
  ON canonical.dedupe_name = duplicate.dedupe_name
 AND canonical.lat = duplicate.lat
 AND canonical.lng = duplicate.lng
WHERE duplicate.fsq_place_id <> canonical.fsq_place_id;

INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank)
SELECT poi_duplicate_map.canonical_id, poi_type.poi_type, poi_type.rank
FROM poi_type
JOIN poi_duplicate_map ON poi_duplicate_map.duplicate_id = poi_type.fsq_place_id;

INSERT OR IGNORE INTO poi_attribute (fsq_place_id, dimension, value)
SELECT poi_duplicate_map.canonical_id, poi_attribute.dimension, poi_attribute.value
FROM poi_attribute
JOIN poi_duplicate_map ON poi_duplicate_map.duplicate_id = poi_attribute.fsq_place_id;

DELETE FROM poi_type
WHERE fsq_place_id IN (SELECT duplicate_id FROM poi_duplicate_map);

DELETE FROM poi_attribute
WHERE fsq_place_id IN (SELECT duplicate_id FROM poi_duplicate_map);

DELETE FROM poi
WHERE fsq_place_id IN (SELECT duplicate_id FROM poi_duplicate_map);

-- ALTER TABLE cannot add a NOT NULL column without a default. Rebuild after
-- the backfill and cleanup so production matches schema.sql exactly.
CREATE TABLE poi_rebuilt (
  fsq_place_id        TEXT NOT NULL,
  name                TEXT NOT NULL,
  dedupe_name         TEXT NOT NULL,
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  geohash             TEXT NOT NULL,
  primary_poi_type    TEXT NOT NULL,
  brand               TEXT,
  category_label      TEXT,
  raw_category_ids    TEXT,
  raw_category_labels TEXT,
  address             TEXT,
  date_refreshed      TEXT NOT NULL,
  PRIMARY KEY (fsq_place_id)
);

INSERT INTO poi_rebuilt
SELECT fsq_place_id, name, dedupe_name, lat, lng, geohash, primary_poi_type,
       brand, category_label, raw_category_ids, raw_category_labels, address,
       date_refreshed
FROM poi;

DROP TABLE poi;
ALTER TABLE poi_rebuilt RENAME TO poi;
CREATE INDEX idx_poi_geo ON poi (geohash);
CREATE UNIQUE INDEX idx_poi_canonical_identity ON poi (dedupe_name, lat, lng);
DROP TABLE poi_duplicate_map;
