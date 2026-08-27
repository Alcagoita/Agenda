-- KAN-428 — community POI removal. KAN-362 let a contributor propose a POI
-- that is missing; this lets one report a POI that should not be there at
-- all (a closed store, a record that never existed, a duplicate).
--
-- A contributor knows a name, a type and a city. They do not know our
-- coordinates or our ids, so a removal never describes a place the way the
-- add form does — it names one record we already hold, picked from a search.

-- Removal proposals are staged separately from `manual_poi_submission`
-- rather than sharing it behind a `kind` column: the payload has no
-- coordinates, no attributes and no free-typed identity at all — only a
-- reference to a record we already hold, plus a reason. Sharing the table
-- would mean loosening the add path's NOT NULL columns and its validator,
-- which is the one thing KAN-362's review flow should not have to absorb.
--
-- `target_source` matches the vocabulary the manual-POI duplicate check
-- already returns ('foursquare' | 'openstreetmap' | 'community'), so the
-- search results, the submission and the tombstone all speak the same words.
CREATE TABLE IF NOT EXISTS poi_removal_submission (
  submission_id      TEXT PRIMARY KEY,
  idempotency_key    TEXT NOT NULL UNIQUE,
  target_source      TEXT NOT NULL CHECK (target_source IN ('foursquare', 'openstreetmap', 'community')),
  target_id          TEXT NOT NULL,
  -- Captured at submission time from the record the contributor picked, so
  -- the reviewer sees what the contributor saw even if the record changed
  -- or vanished in between.
  target_name        TEXT NOT NULL,
  target_poi_type    TEXT NOT NULL,
  target_address     TEXT,
  reason             TEXT NOT NULL CHECK (reason IN ('closed', 'never_existed', 'duplicate')),
  contributor_note   TEXT,
  ip_hash            TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at       TEXT NOT NULL,
  reviewed_at        TEXT,
  reviewed_by        TEXT,
  rejection_reason   TEXT
);

CREATE INDEX IF NOT EXISTS idx_poi_removal_submission_review
  ON poi_removal_submission (status, submitted_at);

-- Two pending reports against the same record are a duplicate report, not two
-- removals. The reviewer should see one row, and approving it should not race
-- a second approval of the same target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_poi_removal_submission_pending_target
  ON poi_removal_submission (target_source, target_id)
  WHERE status = 'pending';

-- The tombstone. One row per record that must not be served, whatever its
-- source.
--
-- Enforcement is at import, not at read. The nearby query is the hot path
-- and gains nothing by joining here; instead the sweep in index.ts deletes
-- suppressed rows when a removal is approved and again when a build
-- completes. That matters because the loader's poi insert is
-- `INSERT OR IGNORE ... ON CONFLICT DO UPDATE` (classify_and_load.py) — a
-- suppressed Foursquare POI genuinely does come back on the next load, and
-- the sweep is what takes it back out.
--
-- Deleting a row here is the undo: nothing about the removal is destructive
-- beyond the swept rows, which the next load restores.
--
-- Known limit, accepted deliberately (KAN-428): this keys on the source id.
-- A closed store that later re-lists under a NEW fsq_place_id is a different
-- id and will not be caught — it needs a fresh report. Keying on the
-- canonical identity (dedupe_name, lat, lng) would catch it, but matching
-- exact floats is brittle and risks suppressing a genuinely different shop
-- next door.
CREATE TABLE IF NOT EXISTS poi_suppression (
  source            TEXT NOT NULL CHECK (source IN ('foursquare', 'openstreetmap', 'community')),
  source_id         TEXT NOT NULL,
  reason            TEXT NOT NULL CHECK (reason IN ('closed', 'never_existed', 'duplicate')),
  -- Kept for provenance. NULL for a suppression an operator applies directly
  -- rather than through the public form.
  submission_id     TEXT REFERENCES poi_removal_submission(submission_id),
  -- Denormalized so an operator reading this table can tell what was removed
  -- without resolving an id against a table the row no longer exists in.
  name              TEXT NOT NULL,
  suppressed_at     TEXT NOT NULL,
  suppressed_by     TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
);
