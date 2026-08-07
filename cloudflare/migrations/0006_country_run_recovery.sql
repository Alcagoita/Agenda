-- KAN-358: retain the last country-run failure so an interrupted Container
-- can be diagnosed and explicitly retried instead of remaining opaque.
ALTER TABLE country ADD COLUMN last_run_started_at TEXT;
ALTER TABLE country ADD COLUMN last_failure_stage TEXT;
ALTER TABLE country ADD COLUMN last_failure_error TEXT;
ALTER TABLE country ADD COLUMN last_failed_at TEXT;
ALTER TABLE country ADD COLUMN source_raw_extract_r2_key TEXT;
ALTER TABLE country ADD COLUMN active_run_id TEXT;

CREATE TABLE country_progress_delivery (
  country_code TEXT NOT NULL,
  run_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  PRIMARY KEY (country_code, run_id, place_id)
);
