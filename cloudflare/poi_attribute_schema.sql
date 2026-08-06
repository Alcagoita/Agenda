-- Generic per-place attribute store (KAN-336, Phase 4). Replaces the old
-- single-value store_subtype/food_subtype columns on `poi` — those could
-- only ever hold one value, but a place can genuinely have more than one
-- (a restaurant that's both "italian" and "vegetarian" today just picked
-- whichever category id happened to appear first in Foursquare's tag
-- array). dimension/value pairs also let new dimensions (e.g. gym_brand,
-- hotel_class) get added later with zero schema change.
--
-- Known dimensions today: 'store_kind' (from storeSubtypeCategories.json),
-- 'food_cuisine' (from foodSubtypeCategories.json).
--
-- No secondary index: nothing queries this table by (dimension, value) yet
-- — see the KAN-335 idx_poi_type_lookup removal for why an index isn't
-- added speculatively ahead of an actual query needing it.

CREATE TABLE IF NOT EXISTS poi_attribute (
  fsq_place_id TEXT NOT NULL,
  dimension    TEXT NOT NULL,
  value        TEXT NOT NULL,
  PRIMARY KEY (fsq_place_id, dimension, value)
);
