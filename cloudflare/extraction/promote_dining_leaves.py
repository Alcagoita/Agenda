"""
KAN-404. Promotes the Dining and Drinking leaves that hang directly off the
top-level parent, which label descent could not reach.

Why they were missed: descent matches the category_name strings in
poiTypeCategories.json against the label path, and our name for the café
category is "Café" while Foursquare's actual label is "Cafe, Coffee, and Tea
House". So every café descendant failed to match. Bakery matched fine. The
general fix — deriving the id->label map from our own data, since
raw_category_ids and raw_category_labels are positionally aligned — is
bigger than this harvest and belongs in its own change; this maps the
affected leaves explicitly instead, which is exact and auditable.

Type assignments are product decisions, not inference:

  Snack Place      -> cafe            a Portuguese snack-bar is a daytime
                                      eatery, not a drinking bar (KAN-391)
  Breakfast Spot   -> cafe + bakery   both fit; a pastelaria serving
                                      breakfast is genuinely both
  Cafeteria        -> cafe
  Dessert Shop     -> bakery
  Pastry Shop      -> bakery
  Bagel Shop       -> bakery
  Cupcake Shop     -> bakery
  Gelato Shop      -> ice_cream
  Creperie         -> restaurant
  Food Court       -> restaurant
  Food Truck       -> restaurant
  Food Stand       -> restaurant

Deliberately NOT here:
  Tea Room, Bubble Tea Shop  - waiting on a new `tea` type (KAN-411)
  Vineyard                   - not an errand
  Juice Bar                  - undecided

Multi-type from the start, unlike the first promotion: a row that qualifies
for two types gets two, because carrying one when it should carry two makes
the place invisible to half its searches.
"""
import os
import sys
from collections import Counter
from datetime import date

from analyse_poi_candidates import build_identity_index, existing_match, paged
from classify_and_load import load_brand_dictionary, normalize_text, sql_escape
from promote_poi_candidates import (
    POI_INSERT_PREFIX, POI_TYPE_INSERT_PREFIX, batched, poi_values, status_updates,
)

LEAF_TYPES = {
    'Snack Place': ['cafe'],
    'Breakfast Spot': ['cafe', 'bakery'],
    'Cafeteria': ['cafe'],
    'Dessert Shop': ['bakery'],
    'Pastry Shop': ['bakery'],
    'Bagel Shop': ['bakery'],
    'Cupcake Shop': ['bakery'],
    'Gelato Shop': ['ice_cream'],
    'Creperie': ['restaurant'],
    'Food Court': ['restaurant'],
    'Food Truck': ['restaurant'],
    'Food Stand': ['restaurant'],
}


def leaf_of(labels):
    return (labels or '').split('|')[0].split('>')[-1].strip()


def run(out_dir, dry_run):
    print('building identity index...', file=sys.stderr)
    index, _ = build_identity_index(10000)
    brands = load_brand_dictionary()
    refreshed = date.today().isoformat()

    stats = Counter()
    by_type = Counter()
    poi_pieces, type_pieces = [], []
    promoted, rejected = [], []
    seen = set()

    for row in paged('poi_candidate',
                     ['fsq_place_id', 'name', 'lat', 'lng', 'address',
                      'raw_category_ids', 'raw_category_labels'],
                     'fsq_place_id', 10000,
                     where="promotion_status = 'pending' AND raw_category_labels LIKE 'Dining and Drinking%'"):
        types = LEAF_TYPES.get(leaf_of(row['raw_category_labels']))
        if not types:
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

        stats['promoted'] += 1
        poi_pieces.append(poi_values(row, types[0], brands, refreshed))
        for rank, poi_type in enumerate(types):
            by_type[poi_type] += 1
            type_pieces.append(f"({sql_escape(row['fsq_place_id'])},{sql_escape(poi_type)},{rank})")
        promoted.append((row['fsq_place_id'], 'dining leaf'))

    print(f"\nmatched   {stats['matched']:,}")
    print(f"promoted  {stats['promoted']:,}")
    print(f"duplicate {stats['duplicate']:,}")
    print('\ntype rows by type:')
    for t, n in by_type.most_common():
        print(f'  {n:>6,}  {t}')

    if dry_run:
        print('\n--dry-run: no SQL written')
        return stats

    os.makedirs(out_dir, exist_ok=True)
    for name, statements in (
        ('00_poi', batched(POI_INSERT_PREFIX, poi_pieces)),
        ('01_poi_type', batched(POI_TYPE_INSERT_PREFIX, type_pieces)),
        ('02_status_promoted', status_updates(promoted, 'promoted')),
        ('03_status_rejected', status_updates(rejected, 'rejected')),
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
        raise SystemExit('usage: promote_dining_leaves.py --sql-out <dir> [--dry-run]')
    run(out, dry)
