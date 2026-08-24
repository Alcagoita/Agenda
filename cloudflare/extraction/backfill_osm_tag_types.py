"""KAN-412. Give already-imported OSM rows the types their own tags state.

`osm_poi` does not store raw tags, so unlike the name backfill this cannot be
recomputed locally: the only record of `shop=butcher` is in OSM itself. The
elements are already in the database — they arrived through the blanket
`shop` selector and were filed as generic `store`, because TAG_TYPES had no
entry for the value. KAN-412 added those entries, which fixes every FUTURE
import and nothing already landed.

So this asks Overpass for ids only — no geometry, no tags, no re-import —
and types the ids it already has. An element not already in `osm_poi` is
skipped: importing new POIs is `supplement_osm_pois.py`'s job, not this
script's, and doing it here would smuggle an unreviewed import into a
backfill.

  python3 cloudflare/extraction/backfill_osm_tag_types.py --area PT > /tmp/tt.sql
  (cd cloudflare && npx wrangler d1 execute brush-poi-registry --remote --file=/tmp/tt.sql)

Safe to re-run: every statement is `INSERT OR IGNORE`, and the `store`
retirement only fires where `store` is still the only type on the row.
"""
import argparse
import json
import os
import subprocess
import sys
import time

from enrich_osm_cuisine import OverpassRateLimited, fetch_overpass
from measure_osm_query_scope import area_filter, seconds_until_slot

CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL_BATCH_SIZE = 250
MAX_SLOT_WAITS = 3

# The tag -> type pairs KAN-412 added to TAG_TYPES. Only these, deliberately:
# a backfill that re-derived the whole mapping would rewrite types that
# earlier tickets decided, and any disagreement would be silent.
BACKFILL_PAIRS = [
    ('shop', 'butcher', 'butcher'),
    ('shop', 'seafood', 'fishmonger'),
    ('shop', 'fishmonger', 'fishmonger'),
    ('shop', 'laundry', 'laundry'),
    ('shop', 'dry_cleaning', 'laundry'),
    ('amenity', 'car_wash', 'car_wash'),
    ('amenity', 'car_rental', 'car_rental'),
    ('amenity', 'veterinary', 'veterinary_care'),
    ('amenity', 'cinema', 'movie_theater'),
    ('amenity', 'charging_station', 'electric_vehicle_charging_station'),
    ('leisure', 'playground', 'playground'),
]

# Values per request. Same reasoning as KAN-405's measurement: Overpass
# limits by cost and slot, not request rate, so batching is what helps.
VALUES_PER_QUERY = 6
REQUEST_SPACING_S = 10.0


def run_d1_query(sql):
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'brush-poi-registry',
         '--remote', '--json', '--command', sql],
        cwd=CLOUDFLARE_DIR, capture_output=True, text=True, check=True,
    )
    payload = json.loads(result.stdout[result.stdout.index('['):])
    return payload[0]['results']


def ids_query(chunk, area):
    """One request, `out ids` per value. Ids are all this needs."""
    parts = [f'[out:json][timeout:600];{area_filter(area)}']
    for key, value, _ in chunk:
        parts.append(f'nwr["{key}"="{value}"](area.a);out ids;')
    return ''.join(parts)


def element_ids(payload):
    """Overpass returns elements in statement order but does not label which
    statement produced them, so this is only usable one value at a time."""
    return {f"{e['type']}/{e['id']}" for e in payload.get('elements', [])
            if e.get('type') in ('node', 'way', 'relation')}


def fetch_ids(area, skip=()):
    """type -> set of element ids, from Overpass.

    Queried one value per request despite the batching helper above: a
    batched `out ids` gives back one undifferentiated element list, and
    guessing which id came from which statement is exactly the kind of
    silent mis-assignment this ticket exists to stop.
    """
    pairs = [p for p in BACKFILL_PAIRS if f'{p[0]}={p[1]}' not in skip]
    by_type = {}
    slot_waits = 0
    index = 0
    while index < len(pairs):
        key, value, poi_type = pairs[index]
        try:
            payload = fetch_overpass(ids_query([(key, value, poi_type)], area))
        except OverpassRateLimited:
            wait = seconds_until_slot()
            if wait is None or slot_waits >= MAX_SLOT_WAITS:
                print(f'  RATE LIMITED at {key}={value} — stopping with partial '
                      'results', file=sys.stderr)
                break
            slot_waits += 1
            print(f'  rate limited; slot frees in {wait}s '
                  f'({slot_waits}/{MAX_SLOT_WAITS})', file=sys.stderr)
            time.sleep(wait + 5)
            continue
        except Exception as error:  # noqa: BLE001 — one bad value must not lose the run
            print(f'  {key}={value} FAILED ({error})', file=sys.stderr)
            index += 1
            continue

        ids = element_ids(payload)
        by_type.setdefault(poi_type, set()).update(ids)
        print(f'  {key}={value}: {len(ids):,} elements', file=sys.stderr)
        index += 1
        if index < len(pairs):
            time.sleep(REQUEST_SPACING_S)
    return by_type


def known_ids(candidate_ids):
    """Which of these are already in `osm_poi`, and what types they carry."""
    known = {}
    ids = sorted(candidate_ids)
    for start in range(0, len(ids), SQL_BATCH_SIZE):
        chunk = ids[start:start + SQL_BATCH_SIZE]
        quoted = ','.join("'" + i.replace("'", "''") + "'" for i in chunk)
        rows = run_d1_query(
            'SELECT p.osm_element_id AS id, '
            "group_concat(t.poi_type, '|') AS types "
            'FROM osm_poi p LEFT JOIN osm_poi_type t '
            '  ON t.osm_element_id = p.osm_element_id '
            f'WHERE p.osm_element_id IN ({quoted}) '
            'GROUP BY p.osm_element_id'
        )
        for row in rows:
            known[row['id']] = set((row['types'] or '').split('|')) - {''}
    return known


def sql_for(by_type):
    """Additive type rows, plus a `store` retirement where `store` was the
    only thing the row had. Same reconciliation the name backfill does: a
    row left as `store` keeps answering a "buy a gift" task."""
    statements = []
    adds = {}
    retire = []

    wanted = {i for ids in by_type.values() for i in ids}
    if not wanted:
        return statements, adds, retire
    existing = known_ids(wanted)
    print(f'  {len(existing):,} of {len(wanted):,} elements already in osm_poi',
          file=sys.stderr)

    inserts = []
    for poi_type, ids in sorted(by_type.items()):
        for osm_id in sorted(ids):
            types = existing.get(osm_id)
            if types is None or poi_type in types:
                continue
            inserts.append((osm_id, poi_type))
            adds[poi_type] = adds.get(poi_type, 0) + 1
            if types == {'store'}:
                retire.append(osm_id)

    for start in range(0, len(retire), SQL_BATCH_SIZE):
        chunk = retire[start:start + SQL_BATCH_SIZE]
        quoted = ','.join("'" + i.replace("'", "''") + "'" for i in chunk)
        statements.append(
            "DELETE FROM osm_poi_type WHERE poi_type = 'store' "
            f'AND osm_element_id IN ({quoted});'
        )

    for start in range(0, len(inserts), SQL_BATCH_SIZE):
        chunk = inserts[start:start + SQL_BATCH_SIZE]
        values = ',\n'.join(
            f"('{osm_id}','{poi_type}',0)" for osm_id, poi_type in chunk
        )
        statements.append(
            'INSERT OR IGNORE INTO osm_poi_type (osm_element_id, poi_type, rank) '
            f'VALUES\n{values};'
        )

    # primary_poi_type drives the hero icon. It only moves for the rows whose
    # only type was the retired `store` — everywhere else the existing
    # primary is still valid and must not be touched.
    for start in range(0, len(retire), SQL_BATCH_SIZE):
        chunk = retire[start:start + SQL_BATCH_SIZE]
        quoted = ','.join("'" + i.replace("'", "''") + "'" for i in chunk)
        statements.append(
            'UPDATE osm_poi SET primary_poi_type = ('
            '  SELECT poi_type FROM osm_poi_type t '
            '  WHERE t.osm_element_id = osm_poi.osm_element_id '
            '  ORDER BY t.rank, t.poi_type LIMIT 1) '
            f'WHERE osm_element_id IN ({quoted}) '
            '  AND EXISTS (SELECT 1 FROM osm_poi_type t '
            '              WHERE t.osm_element_id = osm_poi.osm_element_id);'
        )
    return statements, adds, retire


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--area', default='PT', help='ISO 3166-1 country code')
    parser.add_argument(
        '--skip', default='',
        help='comma-separated key=value pairs to leave out. Overpass rate '
             'limits by cost, so a resumed run should not re-ask for the '
             'values an earlier run already applied.')
    args = parser.parse_args()

    by_type = fetch_ids(args.area, skip={s for s in args.skip.split(',') if s})
    statements, adds, retire = sql_for(by_type)
    for statement in statements:
        print(statement)

    summary = ', '.join(f'{t}={n}' for t, n in sorted(adds.items()))
    print(f'[{args.area}] {sum(adds.values())} type rows to add ({summary}); '
          f'{len(retire)} generic store rows retired', file=sys.stderr)


if __name__ == '__main__':
    main()
