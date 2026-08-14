-- KAN-378: geographic settlement metadata is independent of Foursquare POI
-- ingestion. One row tracks the durable lifecycle of a country registry
-- import; the settlement rows themselves live in `place`.
CREATE TABLE settlement_registry_import (
  country_code      TEXT PRIMARY KEY REFERENCES country(country_code),
  status            TEXT NOT NULL CHECK (status IN ('none', 'mapping', 'mapped', 'failed')) DEFAULT 'none',
  source            TEXT,
  source_records    INTEGER NOT NULL DEFAULT 0,
  settlements_upserted INTEGER NOT NULL DEFAULT 0,
  settlements_skipped  INTEGER NOT NULL DEFAULT 0,
  started_at         TEXT,
  completed_at       TEXT,
  last_error         TEXT
);
