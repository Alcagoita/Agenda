"""KAN-391. Emit an idempotent D1 backfill for types stated only in a name.

New classification only helps future imports. The PT country run already
landed 75,490 OSM POIs, 2,809 of which are missing a type their own name
states — roughly 840 real bakeries filed as generic `store`, invisible to a
"buy bread" task tagged `bakery`.

Reads the current names and types out of D1, applies the same
`types_from_name` rule the classifiers now use, and prints the INSERT
statements for the missing rows only. Nothing is deleted or replaced: a
record that already carries the type produces no statement at all, which is
what makes re-running this safe.

  python3 cloudflare/extraction/backfill_name_types.py --source osm > /tmp/nt-osm.sql
  (cd cloudflare && npx wrangler d1 execute brush-poi-registry --remote --file=/tmp/nt-osm.sql)

`--source foursquare` does the same for the `poi` table. Review the printed
summary on stderr before applying either.

Rank: appended after the existing types, so `primary_poi_type` — which the
app reads for the hero card's icon and accent — never changes.
"""
import argparse
import json
import os
import subprocess
import sys

from classify_and_load import types_from_name

CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL_BATCH_SIZE = 250

SOURCES = {
    'osm': {
        'id_column': 'osm_element_id',
        'poi_table': 'osm_poi',
        'type_table': 'osm_poi_type',
    },
    'foursquare': {
        'id_column': 'fsq_place_id',
        'poi_table': 'poi',
        'type_table': 'poi_type',
    },
}


def run_d1_query(sql):
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'brush-poi-registry', '--remote', '--command', sql, '--json'],
        cwd=CLOUDFLARE_DIR, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout[result.stdout.index('['):])[0]['results']


def sql_string(value):
    return "'" + value.replace("'", "''") + "'"


def rows_for(source):
    """Every record with its current type set, in one pass per source."""
    spec = SOURCES[source]
    return run_d1_query(f'''
        SELECT p.{spec['id_column']} AS id, p.name AS name,
               group_concat(t.poi_type) AS types,
               COALESCE(MAX(t.rank), -1) AS max_rank
        FROM {spec['poi_table']} p
        LEFT JOIN {spec['type_table']} t ON t.{spec['id_column']} = p.{spec['id_column']}
        GROUP BY p.{spec['id_column']}
    ''')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=sorted(SOURCES), required=True)
    args = parser.parse_args()
    spec = SOURCES[args.source]

    values = []
    gained = {}
    for row in rows_for(args.source):
        existing = set((row['types'] or '').split(',')) if row['types'] else set()
        additions = types_from_name(row['name'], existing)
        if not additions:
            continue
        rank = int(row['max_rank'])
        for poi_type in additions:
            rank += 1
            values.append(f"({sql_string(row['id'])},{sql_string(poi_type)},{rank})")
            gained[poi_type] = gained.get(poi_type, 0) + 1

    for start in range(0, len(values), SQL_BATCH_SIZE):
        group = ',\n'.join(values[start:start + SQL_BATCH_SIZE])
        # INSERT OR IGNORE against the (id, poi_type) primary key: applying
        # this twice is a no-op rather than a duplicate-key failure.
        print(f'INSERT OR IGNORE INTO {spec["type_table"]} ({spec["id_column"]}, poi_type, rank) VALUES\n{group};')

    summary = ', '.join(f'{poi_type}={count}' for poi_type, count in sorted(gained.items()))
    print(f'[{args.source}] {len(values)} type rows to add ({summary})', file=sys.stderr)


if __name__ == '__main__':
    main()
