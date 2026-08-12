-- KAN-364: Foursquare tagged these explicit financial-service titles as Bank.
-- Keep the rules deliberately narrow: all rows use the generic source category,
-- so category labels cannot safely distinguish them from real bank branches.

DELETE FROM poi_type
WHERE poi_type = 'bank'
  AND fsq_place_id IN (
    SELECT fsq_place_id
    FROM poi
    WHERE primary_poi_type = 'bank'
      AND (
        dedupe_name = 'mb'
        OR dedupe_name LIKE '%bureau de change%'
        OR dedupe_name LIKE '%hivernage exchange%'
        OR dedupe_name LIKE '%taha change%'
        OR dedupe_name LIKE '%moneyone%'
        OR dedupe_name LIKE '%transfex%'
        OR dedupe_name LIKE '%wafa cash%'
      )
  );

INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank)
SELECT fsq_place_id,
       CASE
         WHEN dedupe_name = 'mb' THEN 'atm'
         WHEN dedupe_name LIKE '%bureau de change%'
           OR dedupe_name LIKE '%hivernage exchange%'
           OR dedupe_name LIKE '%taha change%' THEN 'currency_exchange'
         ELSE 'money_transfer'
       END,
       0
FROM poi
WHERE primary_poi_type = 'bank'
  AND (
    dedupe_name = 'mb'
    OR dedupe_name LIKE '%bureau de change%'
    OR dedupe_name LIKE '%hivernage exchange%'
    OR dedupe_name LIKE '%taha change%'
    OR dedupe_name LIKE '%moneyone%'
    OR dedupe_name LIKE '%transfex%'
    OR dedupe_name LIKE '%wafa cash%'
  );

UPDATE poi
SET primary_poi_type = CASE
      WHEN dedupe_name = 'mb' THEN 'atm'
      WHEN dedupe_name LIKE '%bureau de change%'
        OR dedupe_name LIKE '%hivernage exchange%'
        OR dedupe_name LIKE '%taha change%' THEN 'currency_exchange'
      ELSE 'money_transfer'
    END,
    brand = NULL
WHERE primary_poi_type = 'bank'
  AND (
    dedupe_name = 'mb'
    OR dedupe_name LIKE '%bureau de change%'
    OR dedupe_name LIKE '%hivernage exchange%'
    OR dedupe_name LIKE '%taha change%'
    OR dedupe_name LIKE '%moneyone%'
    OR dedupe_name LIKE '%transfex%'
    OR dedupe_name LIKE '%wafa cash%'
  );
