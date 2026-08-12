-- KAN-364: title-verified businesses that Foursquare placed in its generic
-- Bank category. `financial_service` is source-only and deliberately absent
-- from task creation; its stored kind preserves useful data without polluting
-- Bank nearby searches.

WITH reclassified AS (
  SELECT fsq_place_id,
    CASE
      WHEN (' ' || dedupe_name || ' ') LIKE '% acoreana %'
        OR (' ' || dedupe_name || ' ') LIKE '% fernando figueiredo seguros imperio %'
        OR (' ' || dedupe_name || ' ') LIKE '% fidelidade %'
        OR (' ' || dedupe_name || ' ') LIKE '% goseguro %'
        OR (' ' || dedupe_name || ' ') LIKE '% icoral assurances %'
        OR (' ' || dedupe_name || ' ') LIKE '% mamda assurance %'
        OR (' ' || dedupe_name || ' ') LIKE '% mapfre %'
        OR (' ' || dedupe_name || ' ') LIKE '% marfouk assurances %'
        OR (' ' || dedupe_name || ' ') LIKE '% pedro rodrigues seguros %'
        OR (' ' || dedupe_name || ' ') LIKE '% privilege seguros %'
        OR (' ' || dedupe_name || ' ') LIKE '% seguro directo %'
        OR (' ' || dedupe_name || ' ') LIKE '% zurich %' THEN 'insurance'
      WHEN (' ' || dedupe_name || ' ') LIKE '% bbva consumer finance %'
        OR (' ' || dedupe_name || ' ') LIKE '% bnp paribas personal finance %'
        OR (' ' || dedupe_name || ' ') LIKE '% cetelem %'
        OR (' ' || dedupe_name || ' ') LIKE '% cofidis %'
        OR (' ' || dedupe_name || ' ') LIKE '% credibom %'
        OR (' ' || dedupe_name || ' ') LIKE '% ge consumer finance %'
        OR (' ' || dedupe_name || ' ') LIKE '% wafasalaf %'
        OR (' ' || dedupe_name || ' ') LIKE '% wizink %' THEN 'consumer_credit'
      WHEN (' ' || dedupe_name || ' ') LIKE '% decisoes e solucoes %'
        OR (' ' || dedupe_name || ' ') LIKE '% esaf espirito santo activos financeiros %'
        OR (' ' || dedupe_name || ' ') LIKE '% fagent %'
        OR (' ' || dedupe_name || ' ') LIKE '% finsorinveste %'
        OR (' ' || dedupe_name || ' ') LIKE '% liderfin %'
        OR (' ' || dedupe_name || ' ') LIKE '% rothschild portugal servicos financeiros %' THEN 'financial_intermediary'
      WHEN (' ' || dedupe_name || ' ') LIKE '% bescleasing %' THEN 'leasing_factoring'
      WHEN (' ' || dedupe_name || ' ') LIKE '% banco de portugal %'
        OR (' ' || dedupe_name || ' ') LIKE '% banco de espana %' THEN 'central_bank'
      WHEN (' ' || dedupe_name || ' ') LIKE '% financas lisboa 7 %'
        OR (' ' || dedupe_name || ' ') LIKE '% reparticao de financas %'
        OR (' ' || dedupe_name || ' ') LIKE '% tesouraria rtp %' THEN 'public_finance'
    END AS kind
  FROM poi
  WHERE primary_poi_type = 'bank'
), matched AS (SELECT * FROM reclassified WHERE kind IS NOT NULL)
INSERT OR IGNORE INTO poi_attribute (fsq_place_id, dimension, value)
SELECT fsq_place_id, 'financial_service_kind', kind FROM matched;

INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank)
SELECT fsq_place_id, 'financial_service', 0
FROM poi
WHERE primary_poi_type = 'bank'
  AND fsq_place_id IN (
    SELECT fsq_place_id FROM poi_attribute WHERE dimension = 'financial_service_kind'
  );

DELETE FROM poi_type
WHERE poi_type = 'bank'
  AND fsq_place_id IN (
    SELECT fsq_place_id FROM poi_attribute WHERE dimension = 'financial_service_kind'
  );

UPDATE poi
SET primary_poi_type = 'financial_service', brand = NULL
WHERE primary_poi_type = 'bank'
  AND fsq_place_id IN (
    SELECT fsq_place_id FROM poi_attribute WHERE dimension = 'financial_service_kind'
  );
