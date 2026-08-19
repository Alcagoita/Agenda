-- Merge rules as data (KAN-337, Phase 5). Replaces the hardcoded
-- TYPE_MERGE_INCLUDES object in src/index.ts — a search for search_type
-- also returns places matching every include_type row, letting merge
-- rules be tuned without a code deploy. Loaded once per Worker isolate
-- and cached in module scope (see loadTypeRelations in src/index.ts) —
-- not re-queried on every request.
--
-- Directional, not symmetric groups. Foursquare's taxonomy splits some
-- real-world-equivalent venues into sibling leaf categories (supermarket
-- vs. grocery_store — same kind of place to a shopper, just inconsistently
-- labeled) and genuinely contains one type inside another (every bank
-- branch has an ATM; a standalone ATM is not a bank):
--   - searching a broad/containing type also returns the narrower type it
--     structurally contains (atm -> atm+bank)
--   - searching the narrower type does NOT pull in the broader one (bank
--     search must not return standalone ATMs with no other bank services)
--   - genuine synonyms merge both ways (supermarket <-> grocery_store)
--   - a distinct real intent never merges with a nearby type even if
--     Foursquare's tree puts them close together (convenience_store stays
--     isolated — deliberately different "quick top-up" intent from "the
--     weekly grocery run")
--
-- self-rows (e.g. atm -> atm) are required: a search_type with no row at
-- all falls back to searching itself only (see loadTypeRelations), but a
-- search_type that HAS rows must explicitly include itself too, or it
-- would stop matching its own type the moment it gained a merge partner.

CREATE TABLE IF NOT EXISTS type_relation (
  search_type  TEXT NOT NULL,
  include_type TEXT NOT NULL,
  PRIMARY KEY (search_type, include_type)
);

INSERT OR IGNORE INTO type_relation (search_type, include_type) VALUES
  ('atm', 'atm'),
  ('atm', 'bank'),
  ('supermarket', 'supermarket'),
  ('supermarket', 'grocery_store'),
  ('grocery_store', 'grocery_store'),
  ('grocery_store', 'supermarket'),
  -- fitness_center/gym and hotel/lodging are distinct PoiTypes in our own
  -- catalog, but Foursquare has exactly one leaf category for each real
  -- concept ("Gym and Studio", "Hotel") — classification can only assign a
  -- place to one or the other (see the collision warning in
  -- extraction/classify_and_load.py's build_reverse_map), so both sides
  -- need to be searched together or one of the two PoiTypes silently never
  -- returns anything.
  ('fitness_center', 'fitness_center'),
  ('fitness_center', 'gym'),
  ('gym', 'gym'),
  ('gym', 'fitness_center'),
  ('hotel', 'hotel'),
  ('hotel', 'lodging'),
  ('lodging', 'lodging'),
  ('lodging', 'hotel'),
  -- bar/pub are one intent to a user ("grab a drink"), especially in PT
  -- where the line between them is blurry — a search for either returns
  -- both. Genuine synonyms, so both directions (like supermarket <->
  -- grocery_store above), not a containment pair.
  ('bar', 'bar'),
  ('bar', 'pub'),
  ('pub', 'pub'),
  ('pub', 'bar'),
  -- KAN-398: the app's own catalog words vs the classifier's Google Places
  -- names. gas/post/clinic/bus matched literally zero rows in production
  -- until these landed, while 5,750 petrol stations and 1,380 post offices
  -- sat in the table under the other spelling. Genuine synonyms, so both
  -- directions.
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
  -- clinic <-> doctor only; dentist/hospital/medical_lab/physiotherapist
  -- stay separate, and bus <-> bus_station only, since a train station is a
  -- different mode rather than another word for a bus stop.
  ('clinic', 'clinic'),
  ('clinic', 'doctor'),
  ('doctor', 'doctor'),
  ('doctor', 'clinic'),
  ('bus', 'bus'),
  ('bus', 'bus_station'),
  ('bus_station', 'bus_station'),
  ('bus_station', 'bus'),
  -- KAN-399: ice cream is a first-class type app-side (and quick-actionable
  -- — it is the errand you decide on the spot), so the 1,369 rows already
  -- classified as ice_cream_shop become reachable.
  ('ice_cream', 'ice_cream'),
  ('ice_cream', 'ice_cream_shop'),
  ('ice_cream_shop', 'ice_cream_shop'),
  ('ice_cream_shop', 'ice_cream');
