-- KAN-368: MediaMarkt Portugal was rebranded as Darty. Keep the raw
-- Foursquare name intact, but use the current chain name for brand matching.
UPDATE poi AS target
SET brand = 'Darty'
WHERE (target.brand IS NULL OR target.brand = 'MediaMarkt')
  AND EXISTS (
    SELECT 1
    FROM poi_type
    WHERE poi_type.fsq_place_id = target.fsq_place_id
      AND poi_type.poi_type = 'store'
  )
  AND (
    (' ' || target.dedupe_name || ' ') LIKE '% mediamarkt %'
    OR (' ' || target.dedupe_name || ' ') LIKE '% media markt %'
  );

UPDATE curated_poi AS target
SET brand = 'Darty'
WHERE target.primary_poi_type = 'store'
  AND (target.brand IS NULL OR target.brand = 'MediaMarkt')
  AND (
    (' ' || target.dedupe_name || ' ') LIKE '% mediamarkt %'
    OR (' ' || target.dedupe_name || ' ') LIKE '% media markt %'
  );
