-- KAN-336 (Phase 4). `CREATE TABLE IF NOT EXISTS` in schema.sql is a no-op
-- against an already-existing `poi` table — it does not add new columns —
-- so the brand column and the retirement of store_subtype/food_subtype
-- need an explicit ALTER, run once against the live brush-poi-registry
-- database before (or as part of) deploying a build that uses the new
-- classify_and_load.py / Worker response shape.
--
-- Already applied to production as of this ticket. Kept here so the change
-- is reproducible (a fresh restore of the DB from schema.sql alone would
-- otherwise be missing brand and would still have the retired columns).
--
-- Run: npx wrangler d1 execute brush-poi-registry --remote --file=migrations/0001_phase4_poi_attribute_brand.sql

ALTER TABLE poi ADD COLUMN brand TEXT;
ALTER TABLE poi DROP COLUMN store_subtype;
ALTER TABLE poi DROP COLUMN food_subtype;
