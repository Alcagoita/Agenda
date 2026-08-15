"""
Diagnostic: how many Foursquare OS Places rows exist for a country, both
raw (all categories) and filtered to the ~90 category IDs our pipeline
actually ingests (category_ids.py). Lets us compare Foursquare's universe
against what we've loaded into D1.

Usage:
  export FOURSQUARE_JWT='<datahub jwt>'   # same token the extraction uses
  python3 count_country.py PT

Requires duckdb (pip install duckdb) — same dependency extract.py uses.
Read-only: runs COUNTs against the Iceberg catalog, writes nothing.
"""
import os
import sys

from category_ids import all_category_ids


def _connect(foursquare_jwt):
    """Load DuckDB only when an authenticated count is actually requested."""
    from extract import _connect as connect
    return connect(foursquare_jwt)


def count(country_code):
    jwt = os.environ.get('FOURSQUARE_JWT')
    if not jwt:
        raise SystemExit('FOURSQUARE_JWT not set — export it first (see module docstring)')
    category_ids = all_category_ids()
    con = _connect(jwt)
    try:
        total = con.execute(
            "SELECT COUNT(*) FROM places.datasets.places_os WHERE country = ? AND date_closed IS NULL",
            [country_code],
        ).fetchone()[0]
        filtered = con.execute(
            f"SELECT COUNT(*) FROM places.datasets.places_os "
            f"WHERE country = ? AND date_closed IS NULL "
            f"AND list_has_any(fsq_category_ids, {category_ids!r})",
            [country_code],
        ).fetchone()[0]
    finally:
        con.close()
    print(f"{country_code}: {total:,} open places total")
    print(f"{country_code}: {filtered:,} in our {len(category_ids)} ingested categories (apples-to-apples with D1)")


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: python3 count_country.py <country_code>')
    count(sys.argv[1])
