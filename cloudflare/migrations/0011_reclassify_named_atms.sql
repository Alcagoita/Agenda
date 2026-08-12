-- Foursquare sometimes classifies an explicitly named ATM/Multibanco as a
-- Bank. A real branch that happens to have an ATM keeps both source types;
-- this repair applies only when the POI title itself says ATM or Multibanco.
INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank)
SELECT p.fsq_place_id, 'atm', 0
FROM poi AS p
JOIN poi_type AS bank_type
  ON bank_type.fsq_place_id = p.fsq_place_id
 AND bank_type.poi_type = 'bank'
WHERE lower(p.name) LIKE '%atm%'
   OR lower(p.name) LIKE '%multibanco%';

UPDATE poi
SET primary_poi_type = 'atm',
    brand = NULL
WHERE (lower(name) LIKE '%atm%'
    OR lower(name) LIKE '%multibanco%')
  AND fsq_place_id IN (
    SELECT fsq_place_id
    FROM poi_type
    WHERE poi_type = 'bank'
  );

DELETE FROM poi_type
WHERE poi_type = 'bank'
  AND fsq_place_id IN (
    SELECT fsq_place_id
    FROM poi
    WHERE lower(name) LIKE '%atm%'
       OR lower(name) LIKE '%multibanco%'
  );
