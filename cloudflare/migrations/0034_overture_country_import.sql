-- KAN-443. Overture's national job is independent of the retired
-- Foursquare country pipeline: its source, staging, and audit semantics are
-- different, so it owns a separate resumable state row.
--
-- The CREATE is intentionally repeated here even though pilot environments
-- received 0029: a rebuilt or partially migrated D1 must have staging before
-- this runner can start. The ALTER adds the durable archive identity to that
-- existing 0029 table.
CREATE TABLE IF NOT EXISTS overture_candidate (
  overture_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  address TEXT,
  locality TEXT,
  category TEXT,
  basic_category TEXT,
  category_path TEXT,
  confidence REAL,
  source_datasets TEXT,
  promotion_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (promotion_status IN ('pending', 'promoted', 'rejected')),
  promotion_note TEXT,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_overture_candidate_status ON overture_candidate (promotion_status);
CREATE INDEX IF NOT EXISTS idx_overture_candidate_category ON overture_candidate (category);
ALTER TABLE overture_candidate ADD COLUMN country_source_r2_key TEXT;
CREATE INDEX IF NOT EXISTS idx_overture_candidate_source_status
  ON overture_candidate (country_source_r2_key, promotion_status);

CREATE TABLE IF NOT EXISTS overture_country_import (
  country_code TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'none'
    CHECK (status IN ('none', 'mapping', 'mapped', 'failed')),
  active_run_id TEXT,
  raw_extract_r2_key TEXT,
  backlog_report_r2_key TEXT,
  source_rows INTEGER NOT NULL DEFAULT 0,
  staged_rows INTEGER NOT NULL DEFAULT 0,
  dropped_rows INTEGER NOT NULL DEFAULT 0,
  promoted_rows INTEGER NOT NULL DEFAULT 0,
  rejected_rows INTEGER NOT NULL DEFAULT 0,
  pending_rows INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT
);
