"""
KAN-431 phase 1. Pulls Overture Maps places for a bounding box into a CSV.

WHY THIS IS NOT SHAPED LIKE extract.py OR THE OSM SUPPLEMENT

Overture publishes as public Parquet on S3. There is no API, no key, no
rate limit and no per-request cost, so a whole-country pull is one DuckDB
scan with bbox predicate pushdown. None of KAN-387's batching, leasing or
backoff machinery applies — that exists because Overpass is a shared
service that enforces its policy by blocking, and this is a file read.

WHAT IT EXCLUDES, AND WHY IT IS AN EXCLUDE LIST

KAN-404's rule: import everything, decide afterwards. It binds harder here
than it did for Foursquare — Portugal alone has 1,357 distinct Overture
categories, which is far too many to whitelist confidently, and a category
nobody anticipated would be invisible forever because our own data cannot
show what was never requested.

So this excludes only what is certainly not a place a person runs an errand
at, and everything else is staged for classification. The list below is a
starting position measured from PT data, not a taxonomy — widen or narrow
it from what actually arrives, and record why.

Note `travel_service` is deliberately absent from the exclusions: there were
10 rows within 100 m of one point in Baixa, and a travel agency may well be
a real errand. That is a decision to make from data, not in advance.

BBOX IS FOR PILOTS. COUNTRY IS FOR IMPORTS.

extract_country is the shape a real import takes, and it matches
extract.extract_country: one pull filtered on `country`, no per-municipality
iteration. --bbox exists so a pilot can measure one town against a known
truth list; it is not how Portugal gets loaded.

Usage:
  python3 extract_overture.py --bbox MIN_LAT,MAX_LAT,MIN_LNG,MAX_LNG --out <csv>
  python3 extract_overture.py --place <place_id> --out <csv>
  python3 extract_overture.py --country PT --out <csv>
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Pinned rather than "latest": a release is a dataset version, and a pilot
# that cannot say which version it measured is not reproducible. Bump it
# deliberately, and re-measure when you do.
OVERTURE_RELEASE = '2026-08-19.0'
OVERTURE_PLACES = (
    's3://overturemaps-us-west-2/release/%s/theme=places/type=place/*.parquet'
)

# Categories that are businesses rather than places to visit. Every one was
# observed in Portuguese data; none is guessed from a taxonomy listing.
EXCLUDED_CATEGORIES = (
    'professional_service',
    'real_estate_service',
    'home_service',
    'technical_service',
    'tutoring_service',
    'media_service',
    'software_development',
    'marketing_agency',
    'party_and_event_planning',
    'event_photography',
    'financial_advising',
)


def _connect():
    """DuckDB with the two extensions the Overture read needs.

    httpfs for the S3 range reads, spatial for ST_X/ST_Y — the geometry
    column is WKB and the lat/lng have to come out of it.
    """
    import duckdb
    connection = duckdb.connect()
    connection.execute(
        "INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;"
        " SET s3_region='us-west-2';"
    )
    return connection


def extract_bbox(min_lat, max_lat, min_lng, max_lng, out_path,
                 release=OVERTURE_RELEASE):
    """Every named Overture place in the box, minus the excluded categories.

    The bbox filter reads `bbox.ymin`/`bbox.xmin` rather than the geometry:
    those are plain columns with Parquet row-group statistics, so the scan
    prunes files instead of decoding every geometry in the world.

    Unnamed rows are dropped here rather than staged. A place with no name
    cannot be matched, cannot be shown, and cannot be judged by a human
    later — it is not evidence of anything. In PT this drops nothing at all:
    all 440,594 rows carry a name.
    """
    excluded = ','.join("'%s'" % value for value in EXCLUDED_CATEGORIES)
    connection = _connect()
    connection.execute(
        f"""
        COPY (
          SELECT id AS overture_id,
                 names.primary AS name,
                 ST_Y(geometry) AS lat,
                 ST_X(geometry) AS lng,
                 addresses[1].freeform AS address,
                 addresses[1].locality AS locality,
                 categories.primary AS category,
                 basic_category,
                 array_to_string(taxonomy.hierarchy, '|') AS category_path,
                 confidence,
                 array_to_string(list_distinct(
                   list_transform(sources, s -> s.dataset)), '|') AS source_datasets
          FROM read_parquet('{OVERTURE_PLACES % release}')
          WHERE bbox.ymin BETWEEN ? AND ?
            AND bbox.xmin BETWEEN ? AND ?
            AND names.primary IS NOT NULL
            AND (basic_category IS NULL OR basic_category NOT IN ({excluded}))
            AND (categories.primary IS NULL OR categories.primary NOT IN ({excluded}))
        ) TO '{out_path}' (FORMAT CSV, HEADER)
        """,
        [min_lat, max_lat, min_lng, max_lng],
    )
    connection.close()
    return out_path


def extract_country(country_code, out_path, release=OVERTURE_RELEASE):
    """Every named Overture place in one country. THE path for a full import.

    Mirrors extract.extract_country deliberately: that function pulls a whole
    country in one query filtered on `country`, and run_job partitions the
    result afterwards. There is no per-municipality iteration anywhere in the
    Foursquare path, which is why nothing there can double-count a place that
    sits near a boundary.

    A bbox pull cannot do this. A rectangle over an irregular border pulls in
    neighbouring municipalities — and over a national border, another country
    — while still missing anything outside the box. `addresses[].country` is
    exact. Measured on the Odivelas box: 8,855 rows, every one carrying a
    country, none null.

    The GERS id is the primary key, so even a re-run over overlapping ground
    inserts each place once. Country filtering is about asking the right
    question, not about protecting against duplicates.
    """
    if not re.fullmatch(r'[A-Za-z]{2}', country_code or ''):
        raise ValueError(
            f'country_code must be two ASCII letters, got {country_code!r}')
    excluded = ','.join("'%s'" % value for value in EXCLUDED_CATEGORIES)
    connection = _connect()
    connection.execute(
        f"""
        COPY (
          SELECT id AS overture_id,
                 names.primary AS name,
                 ST_Y(geometry) AS lat,
                 ST_X(geometry) AS lng,
                 addresses[1].freeform AS address,
                 addresses[1].locality AS locality,
                 categories.primary AS category,
                 basic_category,
                 array_to_string(taxonomy.hierarchy, '|') AS category_path,
                 confidence,
                 array_to_string(list_distinct(
                   list_transform(sources, s -> s.dataset)), '|') AS source_datasets
          FROM read_parquet('{OVERTURE_PLACES % release}')
          WHERE addresses[1].country = ?
            AND names.primary IS NOT NULL
            AND (basic_category IS NULL OR basic_category NOT IN ({excluded}))
            AND (categories.primary IS NULL OR categories.primary NOT IN ({excluded}))
        ) TO '{out_path}' (FORMAT CSV, HEADER)
        """,
        [country_code.upper()],
    )
    connection.close()
    return out_path


def place_bbox(place_id):
    """The stored bounds for one place, read through the same D1 path the
    rest of the extraction uses."""
    from analyse_poi_candidates import query
    rows = query(
        'SELECT min_lat, max_lat, min_lng, max_lng FROM place '
        "WHERE place_id = '%s'" % place_id.replace("'", "''")
    )
    if not rows:
        raise SystemExit(f'no place row for {place_id!r}')
    row = rows[0]
    if row['min_lat'] is None:
        raise SystemExit(f'{place_id!r} has no bounding box')
    return row['min_lat'], row['max_lat'], row['min_lng'], row['max_lng']


def main(argv):
    parser = argparse.ArgumentParser()
    # One comma-separated value, not four positionals: western longitudes are
    # negative and argparse reads a bare `-9.2545` as an option string.
    parser.add_argument('--bbox', metavar='MIN_LAT,MAX_LAT,MIN_LNG,MAX_LNG')
    parser.add_argument('--place')
    parser.add_argument('--country', metavar='ISO2',
                        help='whole-country pull, the path a full import uses')
    parser.add_argument('--out', required=True)
    parser.add_argument('--release', default=OVERTURE_RELEASE)
    args = parser.parse_args(argv)

    given = [bool(args.bbox), bool(args.place), bool(args.country)]
    if sum(given) != 1:
        raise SystemExit('give exactly one of --bbox, --place or --country')

    if args.country:
        print(f'overture {args.release}: reading country {args.country.upper()}',
              file=sys.stderr)
        extract_country(args.country, args.out, release=args.release)
        with open(args.out) as handle:
            rows = sum(1 for _ in handle) - 1
        print(f'wrote {rows:,} rows to {args.out}', file=sys.stderr)
        return 0

    if args.bbox:
        parts = [p.strip() for p in args.bbox.split(',')]
        if len(parts) != 4:
            raise SystemExit('--bbox needs MIN_LAT,MAX_LAT,MIN_LNG,MAX_LNG')
        bounds = tuple(float(p) for p in parts)
    else:
        bounds = place_bbox(args.place)

    print(f'overture {args.release}: reading '
          f'lat {bounds[0]}..{bounds[1]} lng {bounds[2]}..{bounds[3]}',
          file=sys.stderr)
    extract_bbox(*bounds, out_path=args.out, release=args.release)
    with open(args.out) as handle:
        rows = sum(1 for _ in handle) - 1
    print(f'wrote {rows:,} rows to {args.out}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
