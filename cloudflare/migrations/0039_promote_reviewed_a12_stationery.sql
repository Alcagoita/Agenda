-- KAN-432. A12papelaria is the sole valid survivor of the former reviewed
-- Books batch. It is a Papelaria, not a bookshop. Keep this source-scoped and
-- explicit; the other three records were user-confirmed closed.
INSERT OR IGNORE INTO overture_poi
  (overture_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, brand,
   address, category, confidence, source_datasets, open_min, close_min, imported_at, updated_at)
VALUES
  ('e5e4bd94-fd64-4c96-b4d4-4658f0fb9f6b', 'A12papelaria', 'a12papelaria',
   39.7999743, -8.5825526, 'ez1fktq', 'store', NULL,
   'Praça da Igreja Velha 32', 'shopping', 0.763251543045044, 'Overture|meta',
   NULL, NULL, '2026-09-05', '2026-09-05');

INSERT OR IGNORE INTO overture_poi_type (overture_id, poi_type, rank)
VALUES ('e5e4bd94-fd64-4c96-b4d4-4658f0fb9f6b', 'store', 0);

INSERT OR IGNORE INTO overture_poi_attribute (overture_id, dimension, value)
VALUES ('e5e4bd94-fd64-4c96-b4d4-4658f0fb9f6b', 'store_kind', 'cards_and_stationery');

UPDATE overture_candidate
SET promotion_status = 'promoted', promotion_note = 'reviewed Stationery batch: papelaria'
WHERE overture_id = 'e5e4bd94-fd64-4c96-b4d4-4658f0fb9f6b';
