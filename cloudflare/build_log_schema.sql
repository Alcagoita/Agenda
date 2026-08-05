-- One row per extraction run. Written at the start of a build (status
-- 'building') by the loader, closed out (status 'ready'/'failed', counts,
-- finished_at) by /internal/build-complete. Lives in the same shared DB as
-- `place` and `poi`. Its own status vocabulary describes the build RUN's
-- lifecycle, distinct from place.status/country.status (KAN-355:
-- none/mapping/mapped) which describe the target's coverage state.

CREATE TABLE IF NOT EXISTS build_log (
  build_id           TEXT PRIMARY KEY,
  place_id           TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  status             TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
  rows_loaded        INTEGER,
  rows_skipped       INTEGER,
  pipeline_version   TEXT NOT NULL,
  source             TEXT NOT NULL,           -- 'foursquare_os_places'
  source_snapshot    TEXT,                    -- dataset release date, when known
  raw_extract_r2_key TEXT                     -- set once Phase 2 (KAN-334) uploads the raw extract
);
