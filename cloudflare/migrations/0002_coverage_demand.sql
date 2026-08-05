-- KAN-346. `CREATE TABLE IF NOT EXISTS` in city_schema.sql is a no-op
-- against an already-existing `city` table — it does not add new columns —
-- so this needs an explicit ALTER against the live brush-poi-registry
-- database, same pattern as migrations/0001_phase4_poi_attribute_brand.sql.
--
-- Run: npx wrangler d1 execute brush-poi-registry --remote --file=migrations/0002_coverage_demand.sql

ALTER TABLE city ADD COLUMN request_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE city ADD COLUMN first_requested_at TEXT;
ALTER TABLE city ADD COLUMN last_requested_at TEXT;
