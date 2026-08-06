"""
KAN-354. Generates and runs the Foursquare Iceberg query DuckDB previously
ran from hand-written per-city files (extract_lisboa.sql, extract_odivelas.sql)
— same query shape, built dynamically from category_ids.py's full category
list instead of a copy-pasted 90-id literal, and parameterized by either a
bbox (place mode) or a country code (country mode) instead of a hardcoded
one.

Country field assumption: Foursquare OS Places' published schema
(opensource.foursquare.com/os-places) documents a `country` column
(ISO 3166-1 alpha-2) and a `locality` column on `places_os` — this is what
lets country mode filter by country exactly (docs/poi-coverage-model.md's
`country_schema.sql` note: "No bbox if the Foursquare dataset carries a
country field") and discover distinct settlements via `locality` grouping
without a separate admin-boundary source. Not re-verified against a live
query from this environment (no network/JWT access while writing this) —
confirm both columns exist with a quick `DESCRIBE places.datasets.places_os`
before the first real country-mode run; if `locality` doesn't carry a
useful per-settlement value, country mode needs a different partitioning
key (e.g. `region` + a coarser geohash grouping instead).
"""
import csv
import os
import duckdb

from category_ids import all_category_ids

CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(CLOUDFLARE_DIR, 'build')

ICEBERG_ENDPOINT = 'https://catalog.h3-hub.foursquare.com/iceberg'

def _connect(foursquare_jwt):
    con = duckdb.connect()
    con.execute('INSTALL httpfs; LOAD httpfs;')
    con.execute("CREATE SECRET iceberg_secret (TYPE ICEBERG, TOKEN ?);", [foursquare_jwt])
    con.execute(
        "ATTACH 'places' AS places (TYPE iceberg, SECRET iceberg_secret, ENDPOINT ?);",
        [ICEBERG_ENDPOINT],
    )
    return con

def extract_place(foursquare_jwt, place_id, min_lat, max_lat, min_lng, max_lng):
    """Bbox-scoped extraction for on-demand (place) mode. Whole-Place, all
    categories — docs/poi-coverage-model.md: "There is no on-demand radius.
    A resolved Place is downloaded whole." """
    category_ids = all_category_ids()
    out_path = os.path.join(BUILD_DIR, f'raw_{place_id}.csv')
    con = _connect(foursquare_jwt)
    con.execute(
        f"""
        COPY (
          SELECT fsq_place_id, name, latitude, longitude, address,
                 array_to_string(fsq_category_ids, '|') AS category_ids,
                 array_to_string(fsq_category_labels, '|') AS category_labels
          FROM places.datasets.places_os
          WHERE latitude BETWEEN ? AND ?
            AND longitude BETWEEN ? AND ?
            AND date_closed IS NULL
            AND list_has_any(fsq_category_ids, {category_ids!r})
        ) TO '{out_path}' (FORMAT CSV, HEADER)
        """,
        [min_lat, max_lat, min_lng, max_lng],
    )
    con.close()
    return out_path

def extract_country(foursquare_jwt, country_code):
    """Whole-country extraction for the pre-build path. One big pull,
    partitioned into per-settlement CSVs by run_job.py afterwards — see this
    module's top comment on the `locality` assumption."""
    category_ids = all_category_ids()
    out_path = os.path.join(BUILD_DIR, f'raw_country_{country_code}.csv')
    con = _connect(foursquare_jwt)
    con.execute(
        f"""
        COPY (
          SELECT fsq_place_id, name, latitude, longitude, address, locality,
                 array_to_string(fsq_category_ids, '|') AS category_ids,
                 array_to_string(fsq_category_labels, '|') AS category_labels
          FROM places.datasets.places_os
          WHERE country = ?
            AND date_closed IS NULL
            AND list_has_any(fsq_category_ids, {category_ids!r})
        ) TO '{out_path}' (FORMAT CSV, HEADER)
        """,
        [country_code],
    )
    con.close()
    return out_path

def partition_by_locality(country_csv_path, country_code):
    """Splits a country-wide CSV into one CSV per distinct non-empty
    `locality` value, each written with the same column shape
    classify_and_load.py's classify() expects (locality itself dropped —
    it's not a classify() input, only how this function grouped rows).
    Returns {locality_name: csv_path}. Rows with no locality at all are
    dropped, not put in some catch-all bucket — a name-less locality has no
    settlement to reverse-geocode a centroid for, and Foursquare's own
    address string covers those rows' details already."""
    buckets = {}
    fieldnames = ['fsq_place_id', 'name', 'latitude', 'longitude', 'address', 'category_ids', 'category_labels']
    with open(country_csv_path) as f:
        for row in csv.DictReader(f):
            locality = (row.get('locality') or '').strip()
            if not locality:
                continue
            buckets.setdefault(locality, []).append({k: row[k] for k in fieldnames})

    out_paths = {}
    for locality, rows in buckets.items():
        safe_name = ''.join(c if c.isalnum() else '_' for c in locality.lower())
        out_path = os.path.join(BUILD_DIR, f'raw_locality_{country_code}_{safe_name}.csv')
        with open(out_path, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        out_paths[locality] = out_path
    return out_paths

def country_stats(country_csv_path):
    """Counts every country-source row once, independently of locality
    resolution. The generic pass must reconcile against these values."""
    source_rows = rows_with_locality = 0
    with open(country_csv_path) as f:
        for row in csv.DictReader(f):
            source_rows += 1
            if (row.get('locality') or '').strip():
                rows_with_locality += 1
    return {
        'source_rows': source_rows,
        'rows_with_locality': rows_with_locality,
        'rows_without_locality': source_rows - rows_with_locality,
    }

def locality_centroid(country_csv_path, locality):
    """Average lat/lng of a locality's rows — enough precision to reverse-
    geocode which settlement this is; not used for anything spatial beyond
    that single lookup."""
    lats, lngs = [], []
    with open(country_csv_path) as f:
        for row in csv.DictReader(f):
            if (row.get('locality') or '').strip() == locality:
                lats.append(float(row['latitude']))
                lngs.append(float(row['longitude']))
    return sum(lats) / len(lats), sum(lngs) / len(lngs)
