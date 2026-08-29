"""
KAN-431 phase 2. Loads an Overture extract into `overture_candidate`.

What this deliberately does NOT do, mirroring KAN-404's loader:

  * It does not classify, compute geohashes, resolve brands or touch any
    poi_type table. Candidates are inert rows until something promotes them.
  * It does not read or write `poi`, `osm_poi` or `curated_poi`. Overture
    rows carry their own GERS ids and live in their own tables, so there is
    no id space to reconcile and nothing existing to disturb.
  * It deletes nothing.

Idempotence: INSERT OR IGNORE on the primary key. Re-running after a partial
load fills the gaps; re-running after someone has set `promotion_status`
leaves those decisions alone, because an existing row is ignored rather than
replaced. That property is what makes it safe to re-run a load that died
halfway without auditing what had already been decided.

Rows with no name or no coordinates are dropped rather than staged. A place
with no name cannot be matched, shown, or judged by a human later, and one
with no position cannot be promoted into a geohash-indexed table. (In PT
this drops nothing: all 440,594 Overture rows carry both.)

Usage:
  python3 load_overture_candidates.py <extract.csv> --sql-out <dir>
  python3 load_overture_candidates.py <extract.csv> --sql-out <dir> --dry-run

Writes batched SQL rather than executing it, so the statements can be read
before they touch production and applied with
`wrangler d1 execute brush-poi-registry --remote --file <sql>`.
"""
import argparse
import csv
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from classify_and_load import MAX_STATEMENT_BYTES, byte_len, sql_escape

INSERT_PREFIX = (
    'INSERT OR IGNORE INTO overture_candidate '
    '(overture_id, name, lat, lng, address, locality, category, basic_category, '
    'category_path, confidence, source_datasets, imported_at) VALUES '
)
MAX_VALUES_TERMS = 500


def candidate_rows(csv_path):
    """The rows worth staging, with the source's own values preserved."""
    imported_at = datetime.now(timezone.utc).isoformat()
    seen = set()
    with open(csv_path, newline='') as handle:
        for row in csv.DictReader(handle):
            overture_id = (row.get('overture_id') or '').strip()
            name = (row.get('name') or '').strip()
            lat = (row.get('lat') or '').strip()
            lng = (row.get('lng') or '').strip()
            if not overture_id or not name or not lat or not lng:
                continue
            if overture_id in seen:
                continue
            seen.add(overture_id)
            confidence = (row.get('confidence') or '').strip()
            yield (
                overture_id, name, float(lat), float(lng),
                (row.get('address') or '').strip() or None,
                (row.get('locality') or '').strip() or None,
                (row.get('category') or '').strip() or None,
                (row.get('basic_category') or '').strip() or None,
                (row.get('category_path') or '').strip() or None,
                float(confidence) if confidence else None,
                (row.get('source_datasets') or '').strip() or None,
                imported_at,
            )


def value_tuple(row):
    (overture_id, name, lat, lng, address, locality, category,
     basic_category, category_path, confidence, sources, imported_at) = row
    return (
        f'({sql_escape(overture_id)},{sql_escape(name)},{lat},{lng},'
        f'{sql_escape(address)},{sql_escape(locality)},{sql_escape(category)},'
        f'{sql_escape(basic_category)},{sql_escape(category_path)},'
        f'{"NULL" if confidence is None else confidence},'
        f'{sql_escape(sources)},{sql_escape(imported_at)})'
    )


def batched(pieces):
    values, size = [], byte_len(INSERT_PREFIX) + 2
    for piece in pieces:
        piece_size = byte_len(piece) + 1
        if values and (size + piece_size > MAX_STATEMENT_BYTES
                       or len(values) >= MAX_VALUES_TERMS):
            yield INSERT_PREFIX + ',\n'.join(values) + ';\n'
            values, size = [], byte_len(INSERT_PREFIX) + 2
        values.append(piece)
        size += piece_size
    if values:
        yield INSERT_PREFIX + ',\n'.join(values) + ';\n'


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('csv_path')
    parser.add_argument('--sql-out', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)

    rows = list(candidate_rows(args.csv_path))
    statements = list(batched(value_tuple(row) for row in rows))
    print(f'{len(rows):,} candidate rows -> {len(statements)} statements',
          file=sys.stderr)

    if args.dry_run:
        print('--dry-run: no SQL written', file=sys.stderr)
        return 0

    os.makedirs(args.sql_out, exist_ok=True)
    for index, statement in enumerate(statements):
        path = os.path.join(args.sql_out, f'{index:04d}_overture_candidate.sql')
        with open(path, 'w') as handle:
            handle.write(statement)
    print(f'wrote {len(statements)} files to {args.sql_out}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
