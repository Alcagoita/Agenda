"""KAN-391. Emit an idempotent D1 backfill for types stated only in a name.

New classification only helps future imports. The PT country run already
landed 75,490 OSM POIs, 2,809 of which are missing a type their own name
states — roughly 840 real bakeries filed as generic `store`, invisible to a
"buy bread" task tagged `bakery`.

Reads the current names and types out of D1 and applies the same
`types_from_name` / `replaces_generic_store` rules the classifiers now use.
A record that already carries the type produces no statement at all, and
every statement is safe to apply twice, which is what makes re-running this
harmless.

  python3 cloudflare/extraction/backfill_name_types.py --source osm > /tmp/nt-osm.sql
  (cd cloudflare && npx wrangler d1 execute brush-poi-registry --remote --file=/tmp/nt-osm.sql)

`--source foursquare` does the same for the `poi` table. Review the printed
summary on stderr before applying either.

Usually purely additive: the inferred types are appended after the existing
ones, so `primary_poi_type` — which drives the hero card's icon and accent —
does not move. The exception is a record whose ONLY type was a generic
`store` that the name supersedes ("Guanabara - Pizzaria Padaria Pastelaria"
is not a store). Those are reconciled properly: the `store` row is retired,
the inferred types take the ranks from the top, and `primary_poi_type` moves
to the first of them. Leaving the row in place would keep the venue
answering a "buy a gift" store task.
"""
import argparse
import json
import os
import subprocess
import sys

from classify_and_load import replaces_generic_store, types_from_name

CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL_BATCH_SIZE = 250

SOURCES = {
    'osm': {
        'id_column': 'osm_element_id',
        'poi_table': 'osm_poi',
        'type_table': 'osm_poi_type',
        'attribute_table': 'osm_poi_attribute',
    },
    'foursquare': {
        'id_column': 'fsq_place_id',
        'poi_table': 'poi',
        'type_table': 'poi_type',
        'attribute_table': 'poi_attribute',
    },
}


def run_d1_query(sql):
    """Read D1 through wrangler, failing loudly when it did not return rows.

    Wrangler prefixes its JSON with progress chatter, hence the slice. But it
    also answers some invocations with a summary table and no array at all,
    in which case a bare `.index('[')` raises a ValueError that says nothing
    about what actually happened. Surface both streams instead.
    """
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'brush-poi-registry', '--remote', '--command', sql, '--json'],
        cwd=CLOUDFLARE_DIR, capture_output=True, text=True, check=True,
    )
    start = result.stdout.find('[')
    if start == -1:
        raise RuntimeError(
            'wrangler returned no JSON array.\n'
            f'--- stdout ---\n{result.stdout[:2000]}\n--- stderr ---\n{result.stderr[:2000]}'
        )
    try:
        payload = json.loads(result.stdout[start:])
        return payload[0]['results']
    except (json.JSONDecodeError, IndexError, KeyError, TypeError) as error:
        raise RuntimeError(
            f'could not read results from wrangler output ({error}).\n'
            f'--- stdout ---\n{result.stdout[:2000]}\n--- stderr ---\n{result.stderr[:2000]}'
        ) from error


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


def store_kind_ids(source):
    """Records the source positively identified as a kind of shop.

    A matched store_kind outranks anything a name says, and dropping
    `store` would orphan the attribute besides — it only exists on a record
    typed `store`. Fetched as one set rather than a query per row.
    """
    spec = SOURCES[source]
    rows = run_d1_query(
        f"SELECT DISTINCT {spec['id_column']} AS id FROM {spec['attribute_table']} "
        "WHERE dimension = 'store_kind'"
    )
    return {row['id'] for row in rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=sorted(SOURCES), required=True)
    args = parser.parse_args()
    spec = SOURCES[args.source]

    known_store_kinds = store_kind_ids(args.source)
    values = []
    replaced_store = []
    gained = {}
    for row in rows_for(args.source):
        # A record with no type at all is not ours to classify. Both
        # classifiers skip those, and the name must never be the sole basis
        # for a POI — a backfill that quietly typed them would break the one
        # rule the live path enforces.
        if not row['types']:
            continue
        existing = set(row['types'].split(','))
        additions = types_from_name(row['name'], existing)
        if not additions:
            continue
        if replaces_generic_store(existing, additions, row['id'] in known_store_kinds):
            # Insert-only would leave the superseded `store` in place and the
            # venue would still answer a "buy a gift" store task. Reconcile:
            # retire it, rank the replacements from the top, and move
            # primary_poi_type onto the first of them.
            replaced_store.append((row['id'], additions[0]))
            ranks = list(enumerate(additions))
        else:
            ranks = list(enumerate(additions, start=int(row['max_rank']) + 1))
        for rank, poi_type in ranks:
            values.append(f"({sql_string(row['id'])},{sql_string(poi_type)},{rank})")
            gained[poi_type] = gained.get(poi_type, 0) + 1

    # Deletes first: the inserts below cannot land a rank 0 while the old
    # `store` still owns it.
    for start in range(0, len(replaced_store), SQL_BATCH_SIZE):
        ids = ','.join(sql_string(i) for i, _ in replaced_store[start:start + SQL_BATCH_SIZE])
        print(f"DELETE FROM {spec['type_table']} WHERE poi_type = 'store' AND {spec['id_column']} IN ({ids});")

    for start in range(0, len(values), SQL_BATCH_SIZE):
        group = ',\n'.join(values[start:start + SQL_BATCH_SIZE])
        # INSERT OR IGNORE against the (id, poi_type) primary key: applying
        # this twice is a no-op rather than a duplicate-key failure.
        print(f'INSERT OR IGNORE INTO {spec["type_table"]} ({spec["id_column"]}, poi_type, rank) VALUES\n{group};')

    # primary_poi_type drives the hero card's icon and accent, so a record
    # that stopped being a store must stop looking like one.
    for identifier, primary in replaced_store:
        print(
            f"UPDATE {spec['poi_table']} SET primary_poi_type = {sql_string(primary)} "
            f"WHERE {spec['id_column']} = {sql_string(identifier)} AND primary_poi_type = 'store';"
        )

    summary = ', '.join(f'{poi_type}={count}' for poi_type, count in sorted(gained.items()))
    print(
        f'[{args.source}] {len(values)} type rows to add ({summary}); '
        f'{len(replaced_store)} generic store rows retired',
        file=sys.stderr,
    )


if __name__ == '__main__':
    main()
