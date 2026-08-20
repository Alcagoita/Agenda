"""
KAN-403. Measures what extract.py's category allowlist throws away.

extract.py only pulls rows matching `list_has_any(fsq_category_ids, <ids>)`,
where the ids come from category_ids.py. Everything outside that list is
discarded at the source, so no query against D1 can reveal it — the rows
were never stored. This asks Foursquare directly instead.

Read-only: COUNTs and GROUP BYs against the Iceberg catalog, writes nothing
to Foursquare, D1 or R2. It does not change the filter and does not
re-extract (KAN-404 owns that decision).

Usage:
  export FOURSQUARE_JWT='<datahub jwt>'   # same token the extraction uses
  python3 measure_rejected_categories.py PT [--top N]

Requires duckdb (pip install duckdb) — same dependency extract.py uses.

The by-category breakdown counts a rejected row once per category it
carries, so the column sums to more than the rejected-row total. That is
deliberate: the question is "which categories are we missing", and a row
with two unmapped categories is evidence for both. No filtering of the
unnested categories is needed — on a rejected row every category is
unmapped by definition, or the row would have passed list_has_any.
"""
import os
import sys

from category_ids import all_category_ids


def _connect(foursquare_jwt):
    """Load DuckDB only when an authenticated run is actually requested."""
    from extract import _connect as connect
    return connect(foursquare_jwt)


def _rejected_predicate(category_ids):
    return (
        "country = ? AND date_closed IS NULL "
        f"AND NOT list_has_any(fsq_category_ids, {category_ids!r})"
    )


def measure(country_code, top=None):
    jwt = os.environ.get('FOURSQUARE_JWT')
    if not jwt:
        raise SystemExit('FOURSQUARE_JWT not set — export it first (see module docstring)')
    category_ids = all_category_ids()
    con = _connect(jwt)
    try:
        total = con.execute(
            "SELECT COUNT(*) FROM places.datasets.places_os "
            "WHERE country = ? AND date_closed IS NULL",
            [country_code],
        ).fetchone()[0]
        kept = con.execute(
            "SELECT COUNT(*) FROM places.datasets.places_os "
            "WHERE country = ? AND date_closed IS NULL "
            f"AND list_has_any(fsq_category_ids, {category_ids!r})",
            [country_code],
        ).fetchone()[0]
        rejected = con.execute(
            "SELECT COUNT(*) FROM places.datasets.places_os "
            f"WHERE {_rejected_predicate(category_ids)}",
            [country_code],
        ).fetchone()[0]
        # Counted against the base predicate, not the rejected one: on a row
        # with a NULL fsq_category_ids, list_has_any returns NULL, so neither
        # `list_has_any(...)` nor `NOT list_has_any(...)` is true and the row
        # falls outside both counts above. These rows are dropped by the
        # extraction too — they are lost places, just not lost to the
        # allowlist. kept + rejected + uncategorised = total.
        uncategorised = con.execute(
            "SELECT COUNT(*) FROM places.datasets.places_os "
            "WHERE country = ? AND date_closed IS NULL "
            "AND (fsq_category_ids IS NULL OR len(fsq_category_ids) = 0)",
            [country_code],
        ).fetchone()[0]
        breakdown = con.execute(
            "SELECT category_id, any_value(category_label) AS category_label, "
            "       COUNT(*) AS rejected_rows "
            "FROM ( "
            "  SELECT unnest(fsq_category_ids) AS category_id, "
            "         unnest(fsq_category_labels) AS category_label "
            "  FROM places.datasets.places_os "
            f"  WHERE {_rejected_predicate(category_ids)} "
            ") "
            "GROUP BY category_id "
            "ORDER BY rejected_rows DESC, category_label",
            [country_code],
        ).fetchall()
    finally:
        con.close()

    pct = (rejected / total * 100) if total else 0
    print(f"{country_code}: {total:,} open places total")
    print(f"{country_code}: {kept:,} kept by the {len(category_ids)}-id filter")
    print(f"{country_code}: {rejected:,} rejected ({pct:.1f}% of open places)")
    print(f"{country_code}: {uncategorised:,} carry no category at all "
          f"(outside both counts above — see the comment in measure())")
    print(f"{country_code}: {len(breakdown):,} distinct unmapped categories\n")

    rows = breakdown[:top] if top else breakdown
    print(f"{'rejected':>10}  {'category_id':<26}  category_label")
    for category_id, category_label, n in rows:
        print(f"{n:>10,}  {category_id:<26}  {category_label}")
    if top and len(breakdown) > top:
        print(f"... {len(breakdown) - top:,} more categories not shown (drop --top for all)")


if __name__ == '__main__':
    args = sys.argv[1:]
    top = None
    if '--top' in args:
        i = args.index('--top')
        top = int(args[i + 1])
        del args[i:i + 2]
    if len(args) != 1:
        raise SystemExit('usage: python3 measure_rejected_categories.py <country_code> [--top N]')
    measure(args[0], top)
