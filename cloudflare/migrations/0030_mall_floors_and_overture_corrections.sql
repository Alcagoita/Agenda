-- KAN-435. Two prerequisites for correcting shopping centres against the
-- operators' published tenant lists.
--
-- 1. A floor, so the app can say where in the building a place is. GPS is
--    close to useless inside a mall — four floors share one coordinate.
--
-- 2. `poi_source_correction` able to record a decision about an Overture
--    row, which it currently cannot.

-- ---------------------------------------------------------------------------
-- floor
--
-- TEXT, not INTEGER: floors go negative ("-1"), and a store that genuinely
-- occupies two levels needs to say so without another migration. Nullable
-- and unset everywhere except inside a mall — most places in the world have
-- no floor worth stating, and a default would be a claim we cannot support.
--
-- Both tables get it because a mall unit can arrive either way: it is an
-- Overture row we already hold, or a tenant on the operator's list that only
-- OSM could place, which lands in curated_poi.
--
-- The value comes from the OPERATOR'S LIST first and OSM second. Measured on
-- Colombo, OSM's `level` agreed with the published Piso on 55 of 55 tenants
-- where both existed. But in Gare do Oriente, Subway and Portela Cafés both
-- sit at OSM level -2 while the operator publishes Piso -1 — two independent
-- disagreements pointing the same way, so the station numbers its basements
-- differently. The operator is the authority; OSM fills the gaps.
ALTER TABLE overture_poi ADD COLUMN floor TEXT;
ALTER TABLE curated_poi ADD COLUMN floor TEXT;

-- ---------------------------------------------------------------------------
-- poi_source_correction accepting 'overture'
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
-- It holds 192 human decisions (187 openstreetmap, 5 foursquare) and those
-- are the one thing here that cannot be regenerated from any source — every
-- row is somebody's judgement about a specific place. Copy first, drop
-- second, and let the transaction take it all back if anything fails.
--
-- The added columns `name_source` and `name_updated_at` arrived by later
-- ALTER and are carried across explicitly; column order follows the live
-- schema so the INSERT ... SELECT stays positional-safe.
CREATE TABLE poi_source_correction_new (
  source                TEXT NOT NULL CHECK (source IN ('foursquare', 'openstreetmap', 'overture')),
  source_id             TEXT NOT NULL,
  visible               INTEGER NOT NULL CHECK (visible IN (0, 1)),
  name_override         TEXT,
  dedupe_name_override  TEXT,
  review_note           TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name_source           TEXT,
  name_updated_at       TEXT,
  PRIMARY KEY (source, source_id)
);

INSERT INTO poi_source_correction_new
  (source, source_id, visible, name_override, dedupe_name_override,
   review_note, created_at, name_source, name_updated_at)
SELECT
   source, source_id, visible, name_override, dedupe_name_override,
   review_note, created_at, name_source, name_updated_at
FROM poi_source_correction;

DROP TABLE poi_source_correction;

ALTER TABLE poi_source_correction_new RENAME TO poi_source_correction;
