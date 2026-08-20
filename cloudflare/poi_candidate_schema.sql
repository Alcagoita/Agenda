-- KAN-404. Staging table for the Foursquare rows the extraction filter used
-- to discard at source.
--
-- extract.py filtered the dataset to 111 mapped category ids and threw the
-- rest away before anything was written, so a category we never mapped
-- produced no data at all. KAN-403 measured the cost for PT: 188,438
-- rejected rows, 51.0% of the rows the filter actually judged, across 870
-- distinct categories — and 579 of those categories are leaves holding
-- fewer than 100 rows each, which is exactly where the errands live
-- (Locksmith, Lottery Retailer, Telecommunication Service, and every rare
-- cuisine).
--
-- Widening the allowlist cannot fix that. A venue Foursquare typed WRONGLY
-- lands in whatever subtree its wrong type belongs to, so any allowlist
-- keeps discarding the records most in need of correction — invisibly,
-- since nothing in our own data can show what never arrived. So the filter
-- goes away and the rejected rows land here instead.
--
-- This table is deliberately NOT `poi`:
--
--   * `poi` is on the hot path. Nearby search reads it on every request
--     through geohash range scans. Adding ~170k unpromotable rows would
--     change index size and scan cost in production for data nobody can
--     query yet.
--   * Rollback is DROP TABLE. No migration to unpick, no rows to tell
--     apart after the fact.
--   * classify_and_load's sweep DELETE never has to reason about rows it
--     did not create.
--
-- It is temporary by design: once promotion is done the table is dropped.
-- That is safe only because the unfiltered CSV is archived to R2 first,
-- under its own key — the filtered archives from previous runs are left
-- exactly where they are (run_job.py writes a fresh uuid key per run, so
-- nothing is ever overwritten).
--
-- No geohash column. Only promoted rows are ever searched, so the geohash
-- is computed at promotion by the same classify_and_load path that
-- computes it for everything else, rather than stored here for rows that
-- may never be promoted.

CREATE TABLE IF NOT EXISTS poi_candidate (
  fsq_place_id        TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  address             TEXT,
  locality            TEXT,
  -- Verbatim, pipe-joined, exactly as Foursquare published them. The whole
  -- point of the table is to preserve what the source said, including when
  -- what it said is wrong — a name rule can only correct a row that is here.
  raw_category_ids    TEXT,
  raw_category_labels TEXT,
  -- 'pending' until a human decides. Promotion is by ranked group, never
  -- record by record: at this volume per-record review does not finish.
  promotion_status    TEXT NOT NULL DEFAULT 'pending'
                        CHECK (promotion_status IN ('pending', 'promoted', 'rejected')),
  -- Why. A decision without its reason cannot be reviewed or reversed by
  -- anyone who was not in the room.
  promotion_note      TEXT,
  imported_at         TEXT NOT NULL
);

-- The analysis pass groups by category and filters by status; both are
-- table scans without this, and the table is larger than `poi`.
CREATE INDEX IF NOT EXISTS idx_poi_candidate_status
  ON poi_candidate (promotion_status);
