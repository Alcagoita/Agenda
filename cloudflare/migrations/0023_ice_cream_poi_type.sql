-- KAN-399 — ice cream becomes a first-class type.
--
-- 1,369 Foursquare POIs already carry `ice_cream_shop`, a classifier type
-- the app's PoiType union never contained, so no user could reach any of
-- them. Unlike a butcher or a dentist, this is the errand you decide on the
-- spot — you pass a place and remember — which is why it also joins the
-- quick-creation carousel app-side.
--
-- Synonyms in both directions, self-rows included, like every other pair in
-- type_relation_schema.sql: a search_type with rows but no self-row stops
-- matching its own type entirely.
INSERT OR IGNORE INTO type_relation (search_type, include_type) VALUES
  ('ice_cream', 'ice_cream'),
  ('ice_cream', 'ice_cream_shop'),
  ('ice_cream_shop', 'ice_cream_shop'),
  ('ice_cream_shop', 'ice_cream');
