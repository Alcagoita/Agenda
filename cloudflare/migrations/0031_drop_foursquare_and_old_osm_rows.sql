-- KAN-438. Remove the Foursquare data, and the August OSM bulk import with it.
--
-- Foursquare is retired. Its rows are no longer read by anything — the
-- previous commit moved /poi/nearby onto overture_poi, osm_poi and
-- curated_poi — so what is left is noise that costs storage and D1 reads and
-- makes every count in the database misleading.
--
-- The OSM rows go too. All 75,490 arrived in three days in August as one bulk
-- import; there is no old/new split in the data because there is only the one
-- import. Nothing in the shopping-centre work depends on them: KAN-435 read
-- OSM live from Overpass and wrote its results into curated_poi, which carries
-- its own name, coordinates, type and floor and never points back here. 40 of
-- those curated rows do correspond to elements that also sit in osm_poi —
-- those are the same shop held twice, once from the bulk import without a
-- floor and once from the mall correction with one. Removing osm_poi removes
-- the worse copy of each.
--
-- ROWS, NOT TABLES.
--
-- The tables stay. Three code paths outside /poi/nearby still name `poi` —
-- manual-submission duplicate detection, suppression, and the refresh check.
-- Against an empty table each returns nothing, which is correct: there are no
-- Foursquare duplicates to find. Against a dropped table each would throw.
--
-- WHAT THIS DOES NOT PRESERVE, AND WHY THAT IS THE DECISION
--
-- Foursquare covers 518 geohash cells; Overture's pilot covers 6. Until the
-- country import (KAN-432) runs, coverage outside Lisboa comes from OSM, and
-- this migration removes that too. Both were measured and stated before this
-- ran; removing the data is the goal of the migration and the reason it
-- exists, not a side effect of it.
--
-- The 2026-08-29 backups are full copies and are NOT touched:
--   poi_backup_20260829                    289,532
--   poi_type_backup_20260829               312,025
--   poi_attribute_backup_20260829           53,063
--   poi_candidate_backup_20260829          164,003
--   poi_source_correction_backup_20260829      192
--
-- poi_source_correction itself is also untouched. Every row in it is a
-- person's judgement about a specific place and none of it is regenerable;
-- the openstreetmap rows in particular must survive for the next OSM import
-- to honour, and the overture rows are live.

-- Children first: poi_type and poi_attribute both reference poi.
DELETE FROM poi_attribute;
DELETE FROM poi_type;
DELETE FROM poi;

-- Foursquare's unreviewed staging table. ~164k rows including roads, housing
-- developments and company registrations, none of it ever promoted and none
-- of it reachable now that its only source is gone.
DELETE FROM poi_candidate;

DELETE FROM osm_poi_attribute;
DELETE FROM osm_poi_type;
DELETE FROM osm_poi;
