-- KAN-428 follow-up. The removal routes write manual_poi_audit rows with
-- target_kind = 'removal', but 0008 created that column with
-- CHECK (target_kind IN ('submission', 'curated_poi')). Every removal
-- submission therefore failed its constraint, rolled the whole batch back,
-- and surfaced in the browser as a network error — the Worker's unhandled
-- exception returns without CORS headers, which a browser cannot tell apart
-- from a blocked origin.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
-- The 15 existing rows are copied across; none of them can violate the new
-- constraint, which is strictly wider than the old one.

CREATE TABLE manual_poi_audit_new (
  audit_id       TEXT PRIMARY KEY,
  target_kind    TEXT NOT NULL CHECK (target_kind IN ('submission', 'curated_poi', 'removal')),
  target_id      TEXT NOT NULL,
  action         TEXT NOT NULL,
  actor          TEXT NOT NULL,
  detail_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

INSERT INTO manual_poi_audit_new (audit_id, target_kind, target_id, action, actor, detail_json, created_at)
  SELECT audit_id, target_kind, target_id, action, actor, detail_json, created_at FROM manual_poi_audit;

DROP TABLE manual_poi_audit;

ALTER TABLE manual_poi_audit_new RENAME TO manual_poi_audit;

-- Dropped with the old table, so recreate it.
CREATE INDEX IF NOT EXISTS idx_manual_poi_audit_target
  ON manual_poi_audit (target_kind, target_id, created_at);
