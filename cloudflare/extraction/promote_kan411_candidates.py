"""
KAN-411. Promotes the pending candidates the six new types describe.

Companion to apply_kan411_types.py, which typed the rows already in `poi`.
These are the ones still sitting in `poi_candidate` — same rules, same
vocabulary traps, but they need the full promotion treatment: a duplicate
check against every source nearby search reads, a geohash, a dedupe_name
and a brand.

The duplicate check is not optional. An `osm_poi` row has no
`fsq_place_id`, so the loader's id exclusion said nothing about it, and
11,272 of KAN-404's candidates turned out to duplicate one. `curated_poi`
is tiny but hand-entered, which makes duplicating it the worst kind.
"""
import os
import sys
from collections import Counter
from datetime import date

from analyse_poi_candidates import build_identity_index, existing_match, paged
from apply_kan411_types import types_for
from classify_and_load import load_brand_dictionary, normalize_text, sql_escape
from promote_poi_candidates import (
    POI_INSERT_PREFIX, POI_TYPE_INSERT_PREFIX, batched, poi_values, status_updates,
)

ATTR_INSERT = 'INSERT OR IGNORE INTO poi_attribute (fsq_place_id, dimension, value) VALUES '


def run(out_dir, dry_run):
    print('building identity index...', file=sys.stderr)
    index, _ = build_identity_index(10000)
    brands = load_brand_dictionary()
    refreshed = date.today().isoformat()

    stats = Counter()
    by_type = Counter()
    poi_pieces, type_pieces, attr_pieces = [], [], []
    promoted, rejected = [], []
    seen = set()

    for row in paged('poi_candidate',
                     ['fsq_place_id', 'name', 'lat', 'lng', 'address',
                      'raw_category_ids', 'raw_category_labels'],
                     'fsq_place_id', 10000, where="promotion_status = 'pending'"):
        # types_for expects the poi column shape; a candidate has no brand or
        # primary type yet, and passing None for primary keeps the subtraction
        # in types_for from removing anything it found.
        found, kinds = types_for({**row, 'brand': None, 'primary_poi_type': None})
        if not found and not kinds:
            continue
        stats['matched'] += 1

        normalized = normalize_text(row['name'] or '')
        match = existing_match(index, normalized, row['lat'], row['lng'])
        if match:
            stats['duplicate'] += 1
            rejected.append((row['fsq_place_id'], f'duplicate of {match[2]}'))
            continue
        identity = (normalized, row['lat'], row['lng'])
        if identity in seen:
            stats['duplicate'] += 1
            rejected.append((row['fsq_place_id'], 'duplicate within batch'))
            continue
        seen.add(identity)

        # A row that only earned a store_kind is a shop first: it becomes a
        # `store` carrying that subtype, not a typeless row.
        ranked = sorted(found) if found else ['store']
        stats['promoted'] += 1
        poi_pieces.append(poi_values(row, ranked[0], brands, refreshed))
        for rank, poi_type in enumerate(ranked):
            by_type[poi_type] += 1
            type_pieces.append(f"({sql_escape(row['fsq_place_id'])},{sql_escape(poi_type)},{rank})")
        for kind in sorted(kinds):
            attr_pieces.append(f"({sql_escape(row['fsq_place_id'])},'store_kind',{sql_escape(kind)})")
        promoted.append((row['fsq_place_id'], 'KAN-411 type rule'))

    print(f"\nmatched   {stats['matched']:,}")
    print(f"promoted  {stats['promoted']:,}")
    print(f"duplicate {stats['duplicate']:,}")
    print('\nby type:')
    for t, n in by_type.most_common():
        print(f'  {n:>5,}  {t}')

    if dry_run:
        print('\n--dry-run: no SQL written')
        return stats

    os.makedirs(out_dir, exist_ok=True)
    for name, statements in (
        ('00_poi', batched(POI_INSERT_PREFIX, poi_pieces)),
        ('01_poi_type', batched(POI_TYPE_INSERT_PREFIX, type_pieces)),
        ('02_poi_attribute', batched(ATTR_INSERT, attr_pieces)),
        ('03_status_promoted', status_updates(promoted, 'promoted')),
        ('04_status_rejected', status_updates(rejected, 'rejected')),
    ):
        path = os.path.join(out_dir, f'{name}.sql')
        with open(path, 'w') as handle:
            for statement in statements:
                handle.write(statement)
        print(f'wrote {path}')
    return stats


if __name__ == '__main__':
    args = sys.argv[1:]
    out = args[args.index('--sql-out') + 1] if '--sql-out' in args else None
    dry = '--dry-run' in args
    if not out and not dry:
        raise SystemExit('usage: promote_kan411_candidates.py --sql-out <dir> [--dry-run]')
    run(out, dry)
