-- KAN-386 — reviewed source corrections remain effective after later raw
-- Foursquare imports. Hidden records stay in the raw registry for audit;
-- query-time filtering prevents them returning alongside their approved OSM
-- replacement.
CREATE TABLE poi_source_correction (
  source                TEXT NOT NULL CHECK (source IN ('foursquare', 'openstreetmap')),
  source_id             TEXT NOT NULL,
  visible               INTEGER NOT NULL CHECK (visible IN (0, 1)),
  name_override         TEXT,
  dedupe_name_override  TEXT,
  review_note           TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source, source_id)
);

-- Sertã review. OSM is the approved visible source for the corrected venues.
INSERT INTO poi_source_correction
  (source, source_id, visible, name_override, dedupe_name_override, review_note)
VALUES
  ('foursquare', 'c86d182b907f439eeccd2fc0', 0, NULL, NULL, 'Replaced by OSM node/5381704212 Carnes Simões.'),
  ('foursquare', '46e421197ffd4f74e3ea1a26', 0, NULL, NULL, 'Venue closed; paired OSM node/5381704191 is excluded.'),
  ('foursquare', '5d65267d486e48000891c68d', 0, NULL, NULL, 'Replaced by OSM way/1183904594, approved name Lagar.'),
  ('foursquare', 'e4eb1689e21f4a413995156f', 0, NULL, NULL, 'Replaced by OSM way/1183904594, approved name Lagar.'),
  ('foursquare', '4c291f8a9eb195219ea92959', 0, NULL, NULL, 'Replaced by OSM node/5381704347 Jet7.'),
  ('openstreetmap', 'node/5381704191', 0, NULL, NULL, 'O Vilaça is closed; do not import.'),
  ('openstreetmap', 'way/1183904594', 1, 'Lagar', 'lagar', 'Approved display name from local review.')
ON CONFLICT(source, source_id) DO UPDATE SET
  visible = excluded.visible,
  name_override = excluded.name_override,
  dedupe_name_override = excluded.dedupe_name_override,
  review_note = excluded.review_note;
