"""
KAN-411. Types the rows already in `poi` that the six new types describe,
and the store subtypes alongside them.

Nothing here is an import. Every row is already in `poi`; they are typed
`store`, `cafe` or `restaurant` and are invisible to a search for what they
actually are. This adds the missing types.

## Which signal each type uses, and why it varies

Category, for the retail leaves. `Tea Room`, `Bubble Tea Shop`, `Juice Bar`,
`Lottery Retailer`, `Liquor Store` and `Mobile Phone Store` are shopfronts,
and Foursquare files them accurately.

Name, for the repairs. Every Foursquare SERVICE or SUPPLY category checked
so far describes the trade sector rather than the shopfront — three for
three:

  Retail > Drugstore              -> pharmaceutical wholesalers, hospital
                                     dispensaries, company registrations
  Computer Repair Service         -> software houses, a coworking space
  Retail > Construction Supplies  -> contractors, stone works, carpenters;
                                     94 of 6,747 were hardware shops

So the repairs are matched on the venue's own name, and the category is not
consulted at all.

## The trap this file exists to avoid

Portuguese separates the shop from the repair where the category does not:

  sapataria    shoe SHOP        346 rows   -> store + store_kind=shoes
  sapateiro    cobbler          26 rows    -> shoe_repair
  retrosaria   haberdashery     64 rows    -> a shop, NOT alterations
  arranjos     alterations      21 rows    -> clothing_repair

Matching `sapataria` for shoe_repair would file 346 shoe shops as cobblers
and send someone with a broken heel to a shop selling new ones. Every
pattern below is space-padded for word boundaries, which is also what keeps
`tatoo` out of `PlantaToo` and `ink` out of `Drink`.

Additive only: INSERT OR IGNORE on (fsq_place_id, poi_type) at rank 1+, and
`primary_poi_type` is never rewritten. This changes what a search MATCHES,
not what the card displays.
"""
import os
import sys
from collections import Counter

from analyse_poi_candidates import paged, query
from classify_and_load import sql_escape
from promote_poi_candidates import batched

POI_TYPE_INSERT = 'INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank) VALUES '
ATTR_INSERT = 'INSERT OR IGNORE INTO poi_attribute (fsq_place_id, dimension, value) VALUES '

# Foursquare leaves that ARE shopfronts. Safe to type on the category alone.
CATEGORY_TYPES = {
    'Tea Room': 'tea',
    'Bubble Tea Shop': 'tea',
    'Juice Bar': 'juice',
    'Lottery Retailer': 'lottery',
}

CATEGORY_SUBTYPES = {
    'Liquor Store': 'drinks',
    'Beer Store': 'drinks',
    'Mobile Phone Store': 'phone',
}

# Name terms, normalized and matched with word boundaries. Positive terms
# only — a term that also names a shop belongs in EXCLUDE below, not here.
NAME_TYPES = {
    'phone_repair': [
        'reparacao de telemoveis', 'reparacao de telemovel', 'arranjar telemovel',
        'assistencia tecnica', 'iservices', 'ecra partido', 'reparacao telemoveis',
    ],
    'shoe_repair': ['sapateiro', 'sapateiros', 'meias solas'],
    'clothing_repair': ['arranjos de roupa', 'arranjos', 'costureira', 'bainhas'],
    'lottery': ['lotaria', 'lotarias', 'raspadinha', 'euromilhoes', 'totoloto'],
}

# Terms that must never win, even when a positive term also matches. These
# are the shops, and the whole point of the split.
EXCLUDE = {
    'shoe_repair': ['sapataria', 'sapatarias'],
    'clothing_repair': ['retrosaria', 'retrosarias', 'tecidos'],
}

BRAND_TYPES = {'phone_repair': ['Worten', 'Fnac', 'iServices', 'Phone House']}


def leaves(labels):
    return {p.split('>')[-1].strip() for p in (labels or '').split('|') if p}


def normalize(text):
    import unicodedata, re
    text = unicodedata.normalize('NFD', (text or '').lower())
    text = ''.join(c for c in text if unicodedata.category(c) != 'Mn')
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9\s]', ' ', text)).strip()


def types_for(row):
    """(poi_types, store_kinds) this row qualifies for beyond what it has."""
    found, kinds = set(), set()
    row_leaves = leaves(row['raw_category_labels'])

    for leaf in row_leaves:
        if leaf in CATEGORY_TYPES:
            found.add(CATEGORY_TYPES[leaf])
        if leaf in CATEGORY_SUBTYPES:
            kinds.add(CATEGORY_SUBTYPES[leaf])

    padded = f" {normalize(row['name'])} "
    for poi_type, terms in NAME_TYPES.items():
        if any(f' {t} ' in padded for t in EXCLUDE.get(poi_type, [])):
            continue
        if any(f' {t} ' in padded for t in terms):
            found.add(poi_type)

    for poi_type, brands in BRAND_TYPES.items():
        if row.get('brand') in brands:
            found.add(poi_type)

    return found - {row['primary_poi_type']}, kinds


def run(out_dir, dry_run):
    stats = Counter()
    by_type, by_kind = Counter(), Counter()
    type_pieces, attr_pieces = [], []

    for row in paged('poi',
                     ['fsq_place_id', 'name', 'brand', 'primary_poi_type',
                      'raw_category_labels'],
                     'fsq_place_id', 10000):
        stats['scanned'] += 1
        if stats['scanned'] % 50000 == 0:
            print(f'  {stats["scanned"]:,}', file=sys.stderr)

        found, kinds = types_for(row)
        for rank, poi_type in enumerate(sorted(found), start=1):
            by_type[poi_type] += 1
            type_pieces.append(f"({sql_escape(row['fsq_place_id'])},{sql_escape(poi_type)},{rank})")
        for kind in sorted(kinds):
            by_kind[kind] += 1
            attr_pieces.append(f"({sql_escape(row['fsq_place_id'])},'store_kind',{sql_escape(kind)})")

    print(f"\nscanned          {stats['scanned']:,}")
    print(f"poi_type rows    {len(type_pieces):,}")
    print(f"attribute rows   {len(attr_pieces):,}")
    print('\nby type:')
    for t, n in by_type.most_common():
        print(f'  {n:>6,}  {t}')
    print('\nby store_kind:')
    for k, n in by_kind.most_common():
        print(f'  {n:>6,}  {k}')

    if dry_run:
        print('\n--dry-run: no SQL written')
        return stats

    os.makedirs(out_dir, exist_ok=True)
    for name, prefix, pieces in (('00_poi_type', POI_TYPE_INSERT, type_pieces),
                                 ('01_poi_attribute', ATTR_INSERT, attr_pieces)):
        path = os.path.join(out_dir, f'{name}.sql')
        with open(path, 'w') as handle:
            for statement in batched(prefix, pieces):
                handle.write(statement)
        print(f'wrote {path}')
    return stats


if __name__ == '__main__':
    args = sys.argv[1:]
    out = args[args.index('--sql-out') + 1] if '--sql-out' in args else None
    dry = '--dry-run' in args
    if not out and not dry:
        raise SystemExit('usage: apply_kan411_types.py --sql-out <dir> [--dry-run]')
    run(out, dry)
