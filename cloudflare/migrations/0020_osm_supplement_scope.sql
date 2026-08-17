-- KAN-387 — the country OSM supplement becomes a checkpointed, resumable
-- job instead of one all-or-nothing container run.
--
-- The run that motivated this (PT, 87ac955d-…) sat in 'mapping' for eight
-- hours across 307 municipality bboxes, wrote nothing, and recorded no
-- error, because nothing was persisted until the last scope succeeded.
--
-- Scope identity is (country_code, place_id) and NOT (run_id, place_id).
-- Keying on the run would make every new run redo all 307 municipalities;
-- `last_completed_at` is the refresh authority instead, so a run claims
-- only never-completed, stale, or retryable scopes.  Stable OSM element ids
-- already make the POI writes idempotent, so re-running a scope that died
-- mid-write is safe.

CREATE TABLE osm_supplement_scope (
  country_code         TEXT NOT NULL,
  place_id             TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  last_run_id          TEXT,
  last_completed_at    TEXT,

  -- Reset to zero on completion so a monthly refresh starts with a clean
  -- retry budget; `total_attempts` never resets, which is the only way to
  -- see a municipality that has quietly failed every month.
  consecutive_attempts INTEGER NOT NULL DEFAULT 0,
  total_attempts       INTEGER NOT NULL DEFAULT 0,

  -- A container can be allocated and die before doing any work. That must
  -- not burn one of the three useful attempts, so an expired lease only
  -- charges an attempt when `work_started_at` proves the scope really ran.
  -- `lease_expiries` counts every reclaim regardless, which is what stops a
  -- permanently broken container start from being retried forever.
  lease_expires_at     TEXT,
  work_started_at      TEXT,
  lease_expiries       INTEGER NOT NULL DEFAULT 0,
  worker_id            TEXT,

  -- Replaced at each completion, never incremented: a retry of a partly
  -- written scope would otherwise double-count. Run totals are always
  -- SUM()ed over these rows rather than accumulated anywhere.
  inserted             INTEGER NOT NULL DEFAULT 0,
  matched_skipped      INTEGER NOT NULL DEFAULT 0,
  ambiguous_skipped    INTEGER NOT NULL DEFAULT 0,
  overpass_elements    INTEGER NOT NULL DEFAULT 0,

  rename_report_r2_key TEXT,
  last_error           TEXT,
  -- 'overpass_failed' | 'rate_limited' | 'container_never_started' |
  -- 'data' | 'd1' — different classes need different operator action.
  last_error_class     TEXT,

  PRIMARY KEY (country_code, place_id)
);

-- The claim query's exact predicate: country, then eligibility by status,
-- then lease expiry for reclaiming abandoned work.
CREATE INDEX idx_osm_supplement_scope_claim
  ON osm_supplement_scope (country_code, status, lease_expires_at);

-- Cron plus expired leases can otherwise start two containers that claim
-- disjoint scopes and hit Overpass in parallel. One batch lock per country,
-- leased like the scopes themselves so a dead holder frees it.
ALTER TABLE osm_supplement_import ADD COLUMN batch_worker_id TEXT;
ALTER TABLE osm_supplement_import ADD COLUMN batch_lease_expires_at TEXT;

-- Overpass 429 is a country-wide stop, never 307 individual retries. The
-- delay grows while the backoff keeps being hit and resets on a clean batch.
ALTER TABLE osm_supplement_import ADD COLUMN backoff_until TEXT;
ALTER TABLE osm_supplement_import ADD COLUMN backoff_seconds INTEGER NOT NULL DEFAULT 0;

-- A country whose remaining scopes are all permanently failed still becomes
-- 'mapped': a handful of unreachable municipalities must not block national
-- coverage. The count keeps the gap visible and individually re-runnable.
ALTER TABLE osm_supplement_import ADD COLUMN failed_scopes INTEGER NOT NULL DEFAULT 0;

-- Cancellation is cooperative — the container checks between scopes. That
-- works even when the container instance identity has been lost.
ALTER TABLE osm_supplement_import ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
