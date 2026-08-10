-- KAN-318: default opening hours per POI, to stop surfacing closed places as Nearby.
-- Minutes from local midnight; NULL/NULL = always open (also covers 24h and
-- "unknown" — for the Nearby filter those are the same: never hide).
-- Populate with the generated backfill (extraction/opening_hours.py) — keyed on
-- category_label — and going forward classify_and_load.py sets them on ingest.
ALTER TABLE poi ADD COLUMN open_min INTEGER;
ALTER TABLE poi ADD COLUMN close_min INTEGER;
