-- KAN-401 — hair and beauty are four errands, not one.
--
--   barber       men's hair          Barbearia
--   hairdresser  hair, women/unisex  Cabeleireiro
--   salon        full service        Salao
--   nail_salon   hands and feet      Manicure
--
-- Answering "I need a haircut" with a nail bar is a bad answer, so these
-- are never merged. 152 POIs already carry more than one of them, which is
-- useful information a merge would have destroyed.
--
-- `salon` is defined by service, not audience. It is normally women's in
-- practice and commonly unisex, but nothing here claims a gender the source
-- never stated.
INSERT OR IGNORE INTO type_relation (search_type, include_type) VALUES
  ('hairdresser', 'hairdresser'),
  ('hairdresser', 'hair_care'),
  ('hair_care', 'hair_care'),
  ('hair_care', 'hairdresser'),
  ('salon', 'salon'),
  ('salon', 'beauty_salon'),
  ('beauty_salon', 'beauty_salon'),
  ('beauty_salon', 'salon'),
  ('nail_salon', 'nail_salon'),
  ('barber', 'barber'),
  ('barber', 'barber_shop'),
  ('barber_shop', 'barber_shop'),
  ('barber_shop', 'barber');

-- KAN-391's backfill wrote `salon` onto every record whose name said
-- cabeleireiro or barbearia. Under the definitions above those are
-- hairdressers and barbershops, not full-service salons, so the type is
-- reassigned by the same name that produced it and the wrong one removed.
-- The rank is inherited from the row being replaced, so ordering (and
-- therefore primary_poi_type) stays stable.
INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank)
SELECT t.fsq_place_id,
       CASE WHEN lower(p.name) LIKE '%barbearia%' OR lower(p.name) LIKE '%barbeiro%'
                 OR lower(p.name) LIKE '%barber%'
            THEN 'barber' ELSE 'hairdresser' END,
       t.rank
FROM poi_type t JOIN poi p ON p.fsq_place_id = t.fsq_place_id
WHERE t.poi_type = 'salon';

INSERT OR IGNORE INTO osm_poi_type (osm_element_id, poi_type, rank)
SELECT t.osm_element_id,
       CASE WHEN lower(o.name) LIKE '%barbearia%' OR lower(o.name) LIKE '%barbeiro%'
                 OR lower(o.name) LIKE '%barber%'
            THEN 'barber' ELSE 'hairdresser' END,
       t.rank
FROM osm_poi_type t JOIN osm_poi o ON o.osm_element_id = t.osm_element_id
WHERE t.poi_type = 'salon';

-- primary_poi_type drives the hero card's icon, so it must move too.
UPDATE poi SET primary_poi_type =
  CASE WHEN lower(name) LIKE '%barbearia%' OR lower(name) LIKE '%barbeiro%'
            OR lower(name) LIKE '%barber%'
       THEN 'barber' ELSE 'hairdresser' END
WHERE primary_poi_type = 'salon';

UPDATE osm_poi SET primary_poi_type =
  CASE WHEN lower(name) LIKE '%barbearia%' OR lower(name) LIKE '%barbeiro%'
            OR lower(name) LIKE '%barber%'
       THEN 'barber' ELSE 'hairdresser' END
WHERE primary_poi_type = 'salon';

-- Only now, once every row has its replacement: `salon` becomes purely the
-- app's word for beauty_salon, resolved through type_relation above, and no
-- stored row carries it any more.
DELETE FROM poi_type WHERE poi_type = 'salon';
DELETE FROM osm_poi_type WHERE poi_type = 'salon';
