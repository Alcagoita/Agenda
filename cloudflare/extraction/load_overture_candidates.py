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

TWO WAYS TO RUN, AND WHEN EACH IS RIGHT

  * In the extraction container, writing through d1.internal one sized
    statement at a time. This is how the ~170k-row PT candidate load was
    done (load_poi_candidates.load) and it is THE path for a country.
  * As numbered .sql files for `wrangler d1 execute --file`, 500 statements
    each, so a failure names the chunk that failed and the run resumes from
    it. Fine for a pilot; a country is ~1,400 wrangler invocations, which is
    not a thing to do from a laptop.

Usage:
  python3 load_overture_candidates.py <extract.csv>                  # container
  python3 load_overture_candidates.py <extract.csv> --sql-out <dir>  # files
  python3 load_overture_candidates.py <extract.csv> --sql-out <dir> --dry-run
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


def load(csv_path):
    """The country path: execute through the Worker's D1 binding directly.

    Mirrors load_poi_candidates.load, including what it reports. `offered`
    minus `inserted` is the number of rows D1 already had — for Overture
    that is how boxes that overlap, or a re-run of a load that died
    halfway, account for themselves. Both numbers are printed because
    silence about the difference is what makes a partial load look complete.
    """
    import d1_client
    offered = inserted = 0
    for statement in batched(value_tuple(row) for row in candidate_rows(csv_path)):
        meta = d1_client.execute(statement)
        offered += statement.count('),(') + 1
        inserted += (meta or {}).get('changes', 0)
    total = d1_client.select('SELECT COUNT(*) AS n FROM overture_candidate')[0]['n']
    print(f'[overture] {offered:,} rows offered, {inserted:,} newly inserted, '
          f'{total:,} now in overture_candidate')
    print('[overture] rows already present were ignored, not overwritten — '
          'any promotion_status already set is untouched')
    return {'offered': offered, 'inserted': inserted, 'table_total': total}


def write_sql(csv_path, out_dir, statements_per_file=500):
    """Numbered .sql files for `wrangler d1 execute --file`.

    500 statements per file rather than one, matching load_poi_candidates:
    a failure names the chunk, and every statement is INSERT OR IGNORE, so
    re-running an already-applied chunk is a no-op.
    """
    os.makedirs(out_dir, exist_ok=True)
    paths, handle, count, total = [], None, 0, 0
    for statement in batched(value_tuple(row) for row in candidate_rows(csv_path)):
        if handle is None or count >= statements_per_file:
            if handle:
                handle.close()
            path = os.path.join(out_dir, f'candidates_{len(paths):04d}.sql')
            paths.append(path)
            handle = open(path, 'w')
            count = 0
        handle.write(statement)
        count += 1
        total += 1
    if handle:
        handle.close()
    return paths, total


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('csv_path')
    parser.add_argument('--sql-out')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)

    if args.dry_run:
        rows = sum(1 for _ in candidate_rows(args.csv_path))
        print(f'--dry-run: {rows:,} candidate rows, nothing written',
              file=sys.stderr)
        return 0

    if args.sql_out:
        paths, total = write_sql(args.csv_path, args.sql_out)
        print(f'{total:,} statements in {len(paths)} files -> {args.sql_out}',
              file=sys.stderr)
        return 0

    load(args.csv_path)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
