-- KAN-443. Overture's national job is independent of the retired
-- Foursquare country pipeline: its source, staging, and audit semantics are
-- different, so it owns a separate resumable state row.
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
