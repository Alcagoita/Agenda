-- KAN-355. New table — what the background worker (KAN-354) maps wholesale,
-- ahead of any user needing it. Portugal first. Full reasoning:
-- docs/poi-coverage-model.md.
--
-- No bbox: the Foursquare OS Places dataset carries its own `country` field
-- (ISO 3166-1 alpha-2), per Foursquare's published schema — extraction
-- filters on it exactly, with no boundary to source or invent. If a future
-- release of the dataset drops that field, a bbox goes back in.

CREATE TABLE IF NOT EXISTS country (
  country_code TEXT PRIMARY KEY,   -- ISO 3166-1 alpha-2
  name         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('none', 'mapping', 'mapped')),
  build_id     TEXT,               -- which Foursquare release — they publish monthly, this is what says when to re-run
  mapped_at    TEXT,
  place_count  INTEGER NOT NULL DEFAULT 0   -- worker progress
);
