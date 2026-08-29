-- KAN-431. Overture Maps becomes the base POI source, replacing Foursquare.
--
-- WHY OVERTURE, AND WHY PRECISION IS THE MEASURE
--
-- Measured against two shopping centres' own published tenant lists — the
-- only free, complete ground truth available, because a mall operator
-- publishes exactly what is inside:
--
--                              recall   precision
--   Foursquare, Vasco da Gama    77%       46%
--   Foursquare, Colombo          92%       48%
--   Overture,   Vasco da Gama    45%       60%
--   Overture,   Colombo          75%       70%
--
-- Roughly half of what Foursquare gives us inside a mall is not on the
-- mall's own list — 46% and 48%, two independent measurements. Overture
-- returns less and is right more often, and that is the trade the product
-- needs: missing a shop is recoverable, sending someone to a shop that is
-- not there is the failure CLAUDE.md's "the app never lies" forbids.
--
-- LICENCE
--
-- Read from the data's own `sources` column, not assumed: CDLA-Permissive-2.0
-- (Meta, Microsoft, PinMeTo), Apache-2.0 (rows Overture took from
-- Foursquare), CC0-1.0 (AllThePlaces). No ODbL, no share-alike — strictly
-- more permissive than the OSM data we already ship. Attribution is required
-- and belongs in copy.ts's settings footer alongside the existing sources.
--
-- IDENTITY
--
-- Overture's GERS `id` is the source id. It is stable across releases and
-- globally unique, so nothing here needs to reason about Foursquare ids.
-- Keeping Overture rows in their own tables is what preserves licence
-- provenance per row, which CLAUDE.md requires: Foursquare, OSM and Overture
-- ids are not interchangeable and mislabelling one corrupts both dedupe and
-- attribution.

-- ─── Staging ────────────────────────────────────────────────────────────────
--
-- Everything the extraction admits lands here first, exactly as Overture
-- published it, and classification happens afterwards from this table.
--
-- This is KAN-404's rule, and it binds harder for Overture than it did for
-- Foursquare: there are 1,357 distinct categories in Portugal alone. A
-- whitelist cannot be written confidently at that width, and a category
-- nobody anticipated would be invisible forever — our own data cannot show
-- what was never requested. So the extraction excludes only what is
-- certainly useless and the rest is sorted here, where it can be counted.

CREATE TABLE IF NOT EXISTS overture_candidate (
  overture_id       TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  lat               REAL NOT NULL,
  lng               REAL NOT NULL,
  address           TEXT,
  locality          TEXT,
  -- Verbatim from Overture. `category` is the fine-grained
  -- `categories.primary`; `basic_category` is the coarse bucket. Both are
  -- kept because they disagree usefully: `basic_category` collapses
  -- clothing, shoes and jewellery into fashion_and_apparel_store, while
  -- `category` keeps them apart and feeds our store subtypes.
  category          TEXT,
  basic_category    TEXT,
  -- The ancestor chain, pipe-joined. KAN-404's "nearest mapped ancestor"
  -- rule needs it: a leaf we have never seen can still be typed from the
  -- closest ancestor we have mapped.
  category_path     TEXT,
  -- Overture's own 0..1 quality score. We have never had one. Nationally
  -- 30.7% of PT rows are >= 0.9 and 18.4% are below 0.5, and at Colombo the
  -- junk sat low while the real chains sat at 0.99-1.00. Stored per row so a
  -- threshold can be MEASURED before it is chosen — do not hard-code one.
  confidence        REAL,
  -- Which upstream datasets contributed, pipe-joined. This is the licence
  -- record for the row, so it is never dropped.
  source_datasets   TEXT,
  promotion_status  TEXT NOT NULL DEFAULT 'pending'
                      CHECK (promotion_status IN ('pending', 'promoted', 'rejected')),
  -- Why. A decision without its reason cannot be reviewed by anyone who was
  -- not in the room.
  promotion_note    TEXT,
  imported_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_overture_candidate_status
  ON overture_candidate (promotion_status);

-- Counting "how many rows does this category hold, and how many are still
-- pending" is the core question of every mapping decision, and it is a table
-- scan without this.
CREATE INDEX IF NOT EXISTS idx_overture_candidate_category
  ON overture_candidate (category);

-- ─── Served ─────────────────────────────────────────────────────────────────
--
-- Mirrors `osm_poi` deliberately. The Worker already merges three sources in
-- queryNearbyPoiDb; matching the existing shape makes Overture a fourth
-- source rather than a new mechanism.

CREATE TABLE IF NOT EXISTS overture_poi (
  overture_id       TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  dedupe_name       TEXT NOT NULL,
  lat               REAL NOT NULL,
  lng               REAL NOT NULL,
  -- Nearby search is a geohash prefix range scan. A promoted row missing its
  -- geohash is silently invisible, so it is computed at promotion by the same
  -- path that computes it for every other source.
  geohash           TEXT NOT NULL,
  primary_poi_type  TEXT NOT NULL,
  brand             TEXT,
  address           TEXT,
  category          TEXT,
  confidence        REAL,
  source_datasets   TEXT,
  -- Opening hours are NOT carried from Overture, which has no hours column.
  -- They are derived from the category by opening_hours.py exactly as they
  -- are for Foursquare rows, so nothing is lost by the change of source.
  open_min          INTEGER,
  close_min         INTEGER,
  imported_at       TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_overture_poi_geohash ON overture_poi (geohash);

CREATE TABLE IF NOT EXISTS overture_poi_type (
  overture_id  TEXT NOT NULL REFERENCES overture_poi(overture_id),
  poi_type     TEXT NOT NULL,
  rank         INTEGER NOT NULL,
  PRIMARY KEY (overture_id, poi_type)
);

CREATE INDEX IF NOT EXISTS idx_overture_poi_type_type ON overture_poi_type (poi_type);

CREATE TABLE IF NOT EXISTS overture_poi_attribute (
  overture_id  TEXT NOT NULL REFERENCES overture_poi(overture_id),
  dimension    TEXT NOT NULL,
  value        TEXT NOT NULL,
  PRIMARY KEY (overture_id, dimension, value)
);
