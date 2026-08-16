-- KAN-386 — Alcobaça e Vestiaria operator review. These OSM records name
-- venues already represented by the retained Foursquare source, so suppress
-- only the duplicate source instead of weakening the global name matcher.
INSERT INTO poi_source_correction
  (source, source_id, visible, name_override, dedupe_name_override, review_note)
VALUES
  ('openstreetmap', 'node/9205161033', 0, NULL, NULL, 'Duplicate of retained Foursquare Meat – Hamburgueria, Pregaria e Companhia.'),
  ('openstreetmap', 'node/3938210850', 0, NULL, NULL, 'Duplicate presentation of retained Foursquare Restaurante Rotunda Pizzeria.'),
  ('openstreetmap', 'node/5098363321', 0, NULL, NULL, 'Duplicate presentation of retained Foursquare Ala Sul Café.')
ON CONFLICT(source, source_id) DO UPDATE SET
  visible = excluded.visible,
  name_override = excluded.name_override,
  dedupe_name_override = excluded.dedupe_name_override,
  review_note = excluded.review_note;
