"""
KAN-404 phase 3b. Adds the MISSING types to the rows promoted from
`poi_candidate`.

The promotion wrote one `poi_type` row per place. `classify_and_load` writes
every type a place qualifies for, because a place genuinely can be more than
one thing — a Portuguese pastelaria is a bakery AND a café, and most of them
are.

Carrying two types is not the problem. Carrying ONE when it should carry two
is: the place then answers a search for the type it has and is invisible to
the other. A promoted pastelaria typed `store` cannot answer "buy bread".

4,268 promoted rows carry more than one Foursquare category and got a single
type from it; ~1,000 more have a name stating a type their category never
mentioned.

This is fixable in place, without re-importing, because every promoted row
stored `raw_category_ids` and `raw_category_labels` verbatim. That is what
keeping them was for.

Three sources of types, all of which the promotion should have used:

  * exact category id match — what classify_and_load's build_reverse_map does
  * label-path descent — what the promotion did, and what catches a category
    Foursquare filed one level below one we map (KAN-403's 58,494 rows)
  * the name — KAN-391's keywords, for places whose category says nothing

Purely additive. `poi_type` is INSERT OR IGNORE on (fsq_place_id, poi_type),
new types are written at rank 1 and above, and `primary_poi_type` is left
exactly as it is: this fixes what a search can MATCH, not what the card
displays, and changing the display type is a separate decision.

Usage:
  python3 backfill_promoted_types.py --sql-out <dir> [--stamp 2026-08-21] [--dry-run]
"""
import os
import sys
from collections import Counter

from analyse_poi_candidates import (
    mapped_category_labels, paged, reachable_types, type_from_labels,
)
from classify_and_load import (
    NAME_TYPE_KEYWORDS, build_reverse_map, load_mapping, normalize_text, sql_escape,
)
from promote_poi_candidates import NOT_WANTED_TYPES, batched

CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(CLOUDFLARE_DIR, 'src')
POI_TYPE_INSERT_PREFIX = 'INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank) VALUES '


def category_id_types():
    """Exact-id map, the classifier's own primary mechanism."""
    return build_reverse_map(load_mapping(os.path.join(SRC_DIR, 'poiTypeCategories.json')))


def name_types(normalized):
    """Every keyword the name states, not just the first — a place called
    "Pastelaria e Geladaria Alcôa" is both."""
    padded = f' {normalized} '
    return {poi_type for keyword, poi_type in NAME_TYPE_KEYWORDS.items()
            if f' {keyword} ' in padded}


def types_for(row, id_map, mapped_labels, reachable):
    found = set()
    for cid in (row['raw_category_ids'] or '').split('|'):
        if cid and cid in id_map:
            found.add(id_map[cid])
    for path in (row['raw_category_labels'] or '').split('|'):
        descended = type_from_labels(path, mapped_labels)
        if descended:
            found.add(descended)
    found |= name_types(normalize_text(row['name'] or ''))

    # Resolve to what a user can actually reach, and drop the types the
    # product decided against — the same rules the promotion used, so the
    # backfill cannot introduce a type the promotion would have refused.
    resolved = {reachable.get(t, t) for t in found}
    return {t for t in resolved if t not in NOT_WANTED_TYPES}


def run(stamp, out_dir, dry_run):
    id_map = category_id_types()
    mapped_labels = mapped_category_labels()
    reachable = reachable_types()
    priority = {k: i for i, k in enumerate(
        load_mapping(os.path.join(SRC_DIR, 'poiTypeCategories.json')).keys())}

    stats = Counter()
    added_by_type = Counter()
    pieces = []

    for row in paged('poi', ['fsq_place_id', 'name', 'primary_poi_type',
                             'raw_category_ids', 'raw_category_labels'],
                     'fsq_place_id', 10000, where=f"date_refreshed = '{stamp}'"):
        stats['scanned'] += 1
        if stats['scanned'] % 20000 == 0:
            print(f'  {stats["scanned"]:,}', file=sys.stderr)

        extra = types_for(row, id_map, mapped_labels, reachable) - {row['primary_poi_type']}
        if not extra:
            continue
        stats['rows_gaining_a_type'] += 1
        for rank, poi_type in enumerate(
                sorted(extra, key=lambda t: priority.get(t, 999)), start=1):
            added_by_type[poi_type] += 1
            stats['types_added'] += 1
            pieces.append(f"({sql_escape(row['fsq_place_id'])},{sql_escape(poi_type)},{rank})")

    print(f"\nscanned              {stats['scanned']:,}")
    print(f"rows gaining a type  {stats['rows_gaining_a_type']:,}")
    print(f"type rows to add     {stats['types_added']:,}")
    print('\nadded by type:')
    for poi_type, n in added_by_type.most_common(25):
        print(f'  {n:>7,}  {poi_type}')

    if dry_run:
        print('\n--dry-run: no SQL written')
        return stats

    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, 'backfill_promoted_types.sql')
    with open(path, 'w') as handle:
        for statement in batched(POI_TYPE_INSERT_PREFIX, pieces):
            handle.write(statement)
    print(f'\nwrote {path}')
    return stats


if __name__ == '__main__':
    args = sys.argv[1:]
    stamp = args[args.index('--stamp') + 1] if '--stamp' in args else '2026-08-21'
    out = args[args.index('--sql-out') + 1] if '--sql-out' in args else None
    dry = '--dry-run' in args
    if not out and not dry:
        raise SystemExit('usage: backfill_promoted_types.py --sql-out <dir> [--stamp DATE] [--dry-run]')
    run(stamp, out, dry)
