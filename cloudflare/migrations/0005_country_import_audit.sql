-- KAN-357: durable proof that the mandatory generic country pass accounted
-- for every supported Foursquare source row.
CREATE TABLE country_import_audit (
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
CREATE INDEX idx_country_import_audit_country_created
  ON country_import_audit (country_code, created_at DESC);
