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
  place_count  INTEGER NOT NULL DEFAULT 0,  -- worker progress
  last_run_started_at TEXT,
  last_failure_stage TEXT,
  last_failure_error TEXT,
  last_failed_at TEXT,
  source_raw_extract_r2_key TEXT,
  active_run_id TEXT
);

-- A callback delivery is counted once per country run. This prevents an HTTP
-- retry after a lost response from incrementing visible progress twice.
CREATE TABLE IF NOT EXISTS country_progress_delivery (
  country_code TEXT NOT NULL,
  run_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  PRIMARY KEY (country_code, run_id, place_id)
);

-- KAN-357: one durable reconciliation record for each completed country run.
CREATE TABLE IF NOT EXISTS country_import_audit (
  build_id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  source_rows INTEGER NOT NULL,
  rows_with_locality INTEGER NOT NULL,
  rows_without_locality INTEGER NOT NULL,
  rows_loaded INTEGER NOT NULL,
  rows_skipped INTEGER NOT NULL,
  resolved_localities INTEGER NOT NULL,
  unresolved_localities INTEGER NOT NULL,
  failed_places INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (source_rows = rows_loaded + rows_skipped),
  CHECK (source_rows = rows_with_locality + rows_without_locality)
);
