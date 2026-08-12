-- KAN-364: Foursquare sometimes labels money transfer and currency-exchange
-- locations as Bank. Keep real branches (including Bank + ATM) untouched;
-- reclassify only an explicit category or curated provider/title match.

INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank)
SELECT fsq_place_id, 'currency_exchange', 0
FROM poi
WHERE raw_category_ids LIKE '%5744ccdfe4b0c0459246b4be%'
   OR lower(name) LIKE '%currency exchange%'
   OR lower(name) LIKE '%cambio%'
   OR lower(name) LIKE '%câmbio%'
   OR lower(name) LIKE '%cambios%'
   OR lower(name) LIKE '%câmbios%'
   OR lower(name) LIKE '%novacambios%'
   OR lower(name) LIKE '%unicambio%';

INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank)
SELECT fsq_place_id, 'money_transfer', 0
FROM poi
WHERE lower(name) LIKE '%western union%'
   OR lower(name) LIKE '%wafacash%'
   OR lower(name) LIKE '%real transfer%'
   OR lower(name) LIKE '%munditransfers%'
   OR lower(name) LIKE '%money transfers%'
   OR lower(name) LIKE '%swift international money transfers%';

DELETE FROM poi_type
WHERE poi_type = 'bank'
  AND fsq_place_id IN (
    SELECT fsq_place_id FROM poi_type
    WHERE poi_type IN ('currency_exchange', 'money_transfer')
  );

UPDATE poi
SET primary_poi_type = CASE
      WHEN EXISTS (
        SELECT 1
        FROM poi_type
        WHERE poi_type.fsq_place_id = poi.fsq_place_id
          AND poi_type.poi_type = 'money_transfer'
      )
        THEN 'money_transfer'
      ELSE 'currency_exchange'
    END,
    brand = NULL
WHERE fsq_place_id IN (
  SELECT fsq_place_id FROM poi_type
  WHERE poi_type IN ('currency_exchange', 'money_transfer')
);

-- Spanish source names are equally explicit: Cajero Automático means ATM.
INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank)
SELECT fsq_place_id, 'atm', 0
FROM poi
WHERE lower(name) LIKE '%cajero automatico%'
   OR lower(name) LIKE '%cajero automático%';

DELETE FROM poi_type
WHERE poi_type = 'bank'
  AND fsq_place_id IN (
    SELECT fsq_place_id FROM poi
    WHERE lower(name) LIKE '%cajero automatico%'
       OR lower(name) LIKE '%cajero automático%'
  );

UPDATE poi
SET primary_poi_type = 'atm', brand = NULL
WHERE lower(name) LIKE '%cajero automatico%'
   OR lower(name) LIKE '%cajero automático%';
