-- KAN-390. The triage queue for POIs whose sources disagree about a name.
--
-- Foursquare's open dataset is stale, and the OSM import is the thing that
-- proves WHICH records are stale — then throws most of that evidence away.
-- `Café Destaque` standing where Foursquare still says `A Brazileira de
-- Torres` is a venue that changed hands and the dataset never noticed. That
-- is the input to a later name-refresh pass, so it has to be queryable.
--
-- Two classes come out of classify_scope / confident_match:
--
--   disagreement  the OSM element was ADMITTED despite a same-type source row
--                 within 75 m under a materially different name. Both rows
--                 now exist. Written to an R2 JSON report today.
--
--   ambiguous     the OSM element matched two or more candidates
--                 indistinguishably, so it was dropped entirely. Recorded
--                 today as a counter and nothing else — 187 elements across
--                 the first 189 PT municipalities, gone. This is the class
--                 this table exists for.
--
-- The R2 report keeps being written. It is still the fastest way to eyeball
-- one municipality without a query; this is for everything a JSON blob per
-- scope cannot do — joining, counting, triaging across a country.
CREATE TABLE IF NOT EXISTS osm_source_conflict (
  -- Natural key. One row per (element, the source row it conflicts with,
  -- the type they share) — an element ambiguous between two candidates is
  -- two rows, because each is a separate thing to review.
  osm_element_id    TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('foursquare', 'openstreetmap')),
  source_id         TEXT NOT NULL,
  poi_type          TEXT NOT NULL,

  country_code      TEXT,
  place_id          TEXT,
  run_id            TEXT,

  osm_name          TEXT NOT NULL,
  osm_lat           REAL NOT NULL,
  osm_lng           REAL NOT NULL,

  source_name       TEXT NOT NULL,
  source_lat        REAL NOT NULL,
  source_lng        REAL NOT NULL,
  distance_meters   REAL NOT NULL,

  conflict_class    TEXT NOT NULL CHECK (conflict_class IN ('disagreement', 'ambiguous')),
  -- Same bands the rename report already uses: same_location <= 20 m,
  -- nearby 21-75 m.
  severity          TEXT NOT NULL CHECK (severity IN ('same_location', 'nearby')),

  -- Human verdict. A re-import MUST NOT reset this: the whole point of a
  -- queue is that reviewing something makes it stay reviewed, and a scope
  -- re-runs for reasons that have nothing to do with the review.
  triage_status     TEXT NOT NULL DEFAULT 'unreviewed'
                    CHECK (triage_status IN ('unreviewed', 'resolved', 'dismissed')),
  resolution_note   TEXT,

  first_seen_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (osm_element_id, source, source_id, poi_type)
);

-- Triage reads the queue by status, usually narrowed to one country.
CREATE INDEX IF NOT EXISTS idx_osm_source_conflict_triage
  ON osm_source_conflict (triage_status, country_code);

-- KAN-388 will size the single-identity-token matching gap from this corpus,
-- which means reading one class at a time.
CREATE INDEX IF NOT EXISTS idx_osm_source_conflict_class
  ON osm_source_conflict (conflict_class, severity);

-- Joining a conflict back to the POI it describes.
CREATE INDEX IF NOT EXISTS idx_osm_source_conflict_source
  ON osm_source_conflict (source, source_id);
