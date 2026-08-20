"""
KAN-404 phase 1. Loads an unfiltered country extract into `poi_candidate`.

What this deliberately does NOT do:

  * It does not go through run_job.run_country. That path resolves
    localities and calls map_place for each one, which writes into `poi`
    and flips the country row to 'mapping'. Sending unfiltered rows down it
    would put ~170k unreviewed places into production — the exact outcome
    the candidates table exists to prevent.
  * It does not call /internal/country-source, so `country`'s
    source_raw_extract_r2_key keeps pointing at the filtered archive a
    reconcile would want.
  * It does not classify, compute geohashes, resolve brands or touch
    poi_type. Candidates are inert rows until something promotes them.
  * It deletes nothing. Rows `poi` already holds are skipped, not moved.

Idempotence: INSERT OR IGNORE on the primary key. Re-running after a
partial load fills the gaps; re-running after someone has set
promotion_status leaves those decisions alone, because an existing row is
ignored rather than replaced. That property is what makes it safe to re-run
a load that died halfway without anyone auditing what had already been
decided.

Usage (inside the extraction container, where d1.internal resolves):
  python3 load_poi_candidates.py <country_code> <unfiltered_csv>
"""
import csv
import os
import sys
from datetime import datetime, timezone

import d1_client
from classify_and_load import MAX_STATEMENT_BYTES, byte_len, sql_escape

INSERT_PREFIX = (
    'INSERT OR IGNORE INTO poi_candidate '
    '(fsq_place_id, name, lat, lng, address, locality, '
    'raw_category_ids, raw_category_labels, imported_at) VALUES '
)


def existing_poi_ids():
    """Every id already in `poi`, so the load stores only the delta.

    Paged rather than one SELECT: at 223k rows a single response is large
    enough to be worth not holding twice, and D1 caps response size anyway.
    Read-only — this is the only thing the loader reads from production.
    """
    ids = set()
    last = ''
    while True:
        rows = d1_client.select(
            'SELECT fsq_place_id FROM poi '
            f'WHERE fsq_place_id > {sql_escape(last)} '
            'ORDER BY fsq_place_id LIMIT 10000'
        )
        if not rows:
            return ids
        for row in rows:
            ids.add(row['fsq_place_id'])
        last = rows[-1]['fsq_place_id']


def candidate_rows(csv_path, known_ids):
    """Yields the rows worth staging, skipping what `poi` already has.

    A row with no name or no coordinates is dropped: the name is the only
    signal a candidate has (its category is unmapped by definition, or it
    would not be here), and a place with no position cannot be promoted
    into a geohash-indexed table later. For PT that is 256 rows of 396,749.
    """
    imported_at = datetime.now(timezone.utc).isoformat()
    seen = set()
    with open(csv_path) as handle:
        for row in csv.DictReader(handle):
            place_id = (row.get('fsq_place_id') or '').strip()
            name = (row.get('name') or '').strip()
            lat = (row.get('latitude') or '').strip()
            lng = (row.get('longitude') or '').strip()
            if not place_id or not name or not lat or not lng:
                continue
            if place_id in known_ids or place_id in seen:
                continue
            seen.add(place_id)
            yield (
                place_id, name, lat, lng,
                (row.get('address') or '').strip() or None,
                (row.get('locality') or '').strip() or None,
                (row.get('category_ids') or '').strip() or None,
                (row.get('category_labels') or '').strip() or None,
                imported_at,
            )


def value_tuple(row):
    place_id, name, lat, lng, address, locality, ids, labels, imported_at = row
    return (
        f'({sql_escape(place_id)},{sql_escape(name)},{float(lat)},{float(lng)},'
        f'{sql_escape(address)},{sql_escape(locality)},'
        f'{sql_escape(ids)},{sql_escape(labels)},{sql_escape(imported_at)})'
    )


def statements(rows):
    """Size-aware batching on the same 80KB budget classify_and_load uses.
    D1's hard statement cap is 100KB and these are inlined literals, not
    bound parameters, so bytes are what matter — and Portuguese names are
    multi-byte in UTF-8, which is why byte_len exists.
    """
    values = []
    size = byte_len(INSERT_PREFIX) + byte_len(';')
    for row in rows:
        piece = value_tuple(row)
        piece_size = byte_len(piece) + 1
        if values and size + piece_size > MAX_STATEMENT_BYTES:
            yield INSERT_PREFIX + ','.join(values) + ';'
            values = []
            size = byte_len(INSERT_PREFIX) + byte_len(';')
        values.append(piece)
        size += piece_size
    if values:
        yield INSERT_PREFIX + ','.join(values) + ';'


def load(country_code, csv_path):
    known_ids = existing_poi_ids()
    print(f'[candidates] {len(known_ids):,} ids already in poi — those are skipped')

    staged = written = 0
    for statement in statements(candidate_rows(csv_path, known_ids)):
        meta = d1_client.execute(statement)
        staged += statement.count('),(') + 1
        written += (meta or {}).get('changes', 0)

    total = d1_client.select('SELECT COUNT(*) AS n FROM poi_candidate')[0]['n']
    print(f'[candidates] {country_code}: {staged:,} rows offered, '
          f'{written:,} newly inserted, {total:,} now in poi_candidate')
    print('[candidates] rows already present were ignored, not overwritten — '
          'any promotion_status already set is untouched')
    return {'offered': staged, 'inserted': written, 'table_total': total}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: python3 load_poi_candidates.py <country_code> <unfiltered_csv>')
    country, path = sys.argv[1], sys.argv[2]
    if not os.path.exists(path):
        raise SystemExit(f'no such CSV: {path}')
    load(country.upper(), path)
