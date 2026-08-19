-- KAN-398 — four of the app's own catalog types matched nothing at all.
--
-- The POI vocabulary was designed before the migration to Foursquare/OSM.
-- classify_and_load classifies into Google Places type names, while
-- PoiType in src/types/index.ts kept its own shorter words, and nothing
-- reconciled the two except this table. Measured in production before this
-- migration, against 75k OSM and 234k Foursquare type rows:
--
--   gas     0 rows  <-  gas_station  5,750
--   post    0 rows  <-  post_office  1,380
--   clinic  0 rows  <-  doctor       3,108
--   bus     0 rows  <-  bus_station    778
--   cafe   21,810   <-  coffee_shop  7,025 unreachable
--
-- "Fill up the car" returned nothing anywhere in Portugal while 5,750
-- petrol stations sat in the table.
--
-- All five are genuine synonyms — the same real place under two names, not
-- a containment pair — so each merges in both directions, like
-- supermarket <-> grocery_store above. Self-rows are mandatory: a
-- search_type that has any row must include itself or it stops matching
-- its own type (see this file's header and loadTypeRelations).
INSERT OR IGNORE INTO type_relation (search_type, include_type) VALUES
  ('gas', 'gas'),
  ('gas', 'gas_station'),
  ('gas_station', 'gas_station'),
  ('gas_station', 'gas'),

  ('post', 'post'),
  ('post', 'post_office'),
  ('post_office', 'post_office'),
  ('post_office', 'post'),

  ('cafe', 'cafe'),
  ('cafe', 'coffee_shop'),
  ('coffee_shop', 'coffee_shop'),
  ('coffee_shop', 'cafe'),

  -- clinic <-> doctor only. Dentist, hospital, medical_lab and
  -- physiotherapist stay separate types: you do not wander into a dentist,
  -- you search for one specifically, and answering "find a dentist" with a
  -- physiotherapist is worse than answering it with nothing. They get
  -- their own catalog entries instead.
  ('clinic', 'clinic'),
  ('clinic', 'doctor'),
  ('doctor', 'doctor'),
  ('doctor', 'clinic'),

  -- bus <-> bus_station only. train_station, subway_station and
  -- transit_station are deliberately excluded: they are different modes of
  -- transport, not other words for a bus stop, and merging them would make
  -- a bus search answer with a metro station. They deserve their own
  -- types, not this one's.
  ('bus', 'bus'),
  ('bus', 'bus_station'),
  ('bus_station', 'bus_station'),
  ('bus_station', 'bus');
