-- KAN-359: Foursquare Open Map can expose the same real-world POI under
-- multiple fsq_place_id values. Nearby search is spatial, so retaining both
-- would show the user duplicate results. Keep the lexicographically first ID
-- as the canonical record, preserving all of the duplicate records' matched
-- types and attributes on that canonical POI before deleting the extras.

ALTER TABLE poi ADD COLUMN dedupe_name TEXT;

-- Existing production data predates the importer-side normalized value. This
-- covers the observed duplicate shape (same name and coordinates) without
-- rewriting user-facing names. New imports use the stricter Python
-- normalizer (case/accent/punctuation insensitive).
UPDATE poi
SET dedupe_name = lower(trim(name))
WHERE dedupe_name IS NULL;

WITH duplicate_map AS (
  SELECT duplicate.fsq_place_id AS duplicate_id, canonical.fsq_place_id AS canonical_id
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
  WHERE duplicate.fsq_place_id <> canonical.fsq_place_id
)
INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank)
SELECT duplicate_map.canonical_id, poi_type.poi_type, poi_type.rank
FROM poi_type
JOIN duplicate_map ON duplicate_map.duplicate_id = poi_type.fsq_place_id;

WITH duplicate_map AS (
  SELECT duplicate.fsq_place_id AS duplicate_id, canonical.fsq_place_id AS canonical_id
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
  WHERE duplicate.fsq_place_id <> canonical.fsq_place_id
)
INSERT OR IGNORE INTO poi_attribute (fsq_place_id, dimension, value)
SELECT duplicate_map.canonical_id, poi_attribute.dimension, poi_attribute.value
FROM poi_attribute
JOIN duplicate_map ON duplicate_map.duplicate_id = poi_attribute.fsq_place_id;

WITH duplicate_ids AS (
  SELECT duplicate.fsq_place_id
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
  WHERE duplicate.fsq_place_id <> canonical.fsq_place_id
)
DELETE FROM poi_type WHERE fsq_place_id IN duplicate_ids;

WITH duplicate_ids AS (
  SELECT duplicate.fsq_place_id
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
  WHERE duplicate.fsq_place_id <> canonical.fsq_place_id
)
DELETE FROM poi_attribute WHERE fsq_place_id IN duplicate_ids;

WITH duplicate_ids AS (
  SELECT duplicate.fsq_place_id
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
  WHERE duplicate.fsq_place_id <> canonical.fsq_place_id
)
DELETE FROM poi WHERE fsq_place_id IN duplicate_ids;

CREATE UNIQUE INDEX idx_poi_canonical_identity
  ON poi (dedupe_name, lat, lng);
