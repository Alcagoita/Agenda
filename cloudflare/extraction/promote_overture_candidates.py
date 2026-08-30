"""
KAN-431 phase 3. Promotes `overture_candidate` rows into `overture_poi`.

TWO WAYS IN, IN THIS ORDER

  1. The category, through src/overtureCategories.json.
  2. The NAME, through classify_and_load's types_from_name — the KAN-391
     machinery. A "Talho Halal Barakah" filed under `halal_restaurant` and a
     "Papelaria Açores" filed under `arts_and_crafts` both state what they
     are in their own name, and the category is simply wrong.

The name may only ADD a type the category could not supply. It never
overrides a category that mapped, because the category is the source's
considered answer and the name is an inference from a string.

WHAT IS DELIBERATELY NOT DONE

No suffix rule on the category. `*_restaurant -> restaurant` looks free and
gains 4 points on Odivelas, but the same rule sends `auto_body_shop` and
`auto_parts_and_supply_store` to `store` — reintroducing exactly what
KAN-412 excluded — and `driving_school`/`dance_school` to `school`, which is
not the errand that word means in this app. A rule that is right about the
tail and wrong about the exclusions is not worth 4 points.

Everything unmatched stays `pending`. It is countable there, which is the
point of staging: the next mapping decision comes from what actually
arrived, not from reading a taxonomy.

Usage:
  python3 promote_overture_candidates.py --sql-out <dir> [--batch 10000] [--dry-run]
"""
import argparse
import json
import os
import sys
from collections import Counter
from datetime import date, datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyse_poi_candidates import paged, query, reachable_types
from classify_and_load import (
    MAX_STATEMENT_BYTES, byte_len, encode_geohash, find_brand,
    load_brand_dictionary, normalize_text, sql_escape, types_from_name,
)
from opening_hours import hours_for_poi_type

CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_VALUES_TERMS = 500

POI_INSERT_PREFIX = (
    'INSERT OR IGNORE INTO overture_poi '
    '(overture_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, brand, '
    'address, category, confidence, source_datasets, open_min, close_min, '
    'imported_at, updated_at) VALUES '
)
TYPE_INSERT_PREFIX = (
    'INSERT OR IGNORE INTO overture_poi_type (overture_id, poi_type, rank) VALUES '
)
ATTRIBUTE_INSERT_PREFIX = (
    'INSERT OR IGNORE INTO overture_poi_attribute (overture_id, dimension, value) VALUES '
)


# KAN-431. Overture's hair-and-beauty categories are a shrug, and measuring
# Odivelas says so: of 401 rows filed `spas`, 86 are named "Cabeleireiro" and
# 4 are barbearias; of 382 filed `beauty_salon`, 89 are hairdressers and 3 are
# barbers; and 5 of the 97 filed `barber` are actually cabeleireiros.
#
# These are four distinct errands — KAN-401 established that for Foursquare
# and OSM — and the category cannot tell them apart. Where a name says which
# one it is, the name wins outright rather than joining as a second type,
# because ranking a barbearia's `salon` first would show the wrong thing and
# was the whole point of KAN-401's split.
#
# Deliberately narrow. Everywhere else the category is the source's considered
# answer and the name may only add to it.
NAME_OUTRANKS_CATEGORY = frozenset({
    'spas', 'beauty_salon', 'hair_salon', 'barber',
    'personal_or_beauty_service', 'personal_care_services',
})


def category_map():
    path = os.path.join(CLOUDFLARE_DIR, 'src', 'overtureCategories.json')
    with open(path) as handle:
        return {k: v for k, v in json.load(handle).items() if not k.startswith('_')}


def decide(row, mapping, reachable, brand_dictionary):
    """(status, types, attributes, reason) for one candidate.

    `types` is ranked: the category's answer first, then anything the name
    adds. Rank 0 becomes primary_poi_type, which is what the app shows.
    """
    normalized = normalize_text(row['name'] or '')
    if not normalized:
        return 'rejected', (), (), 'unnamed'

    types, attributes, reason = [], [], None
    entry = mapping.get(row['category'])
    if entry and entry['poi_type'] in reachable:
        types.append(reachable[entry['poi_type']])
        reason = f"category: {row['category']}"
        if entry.get('store_kind'):
            attributes.append(('store_kind', entry['store_kind']))
        if entry.get('food_cuisine'):
            attributes.append(('food_cuisine', entry['food_cuisine']))

    # The name may add, never replace. A category that mapped is the source's
    # considered answer; the name is an inference from a string.
    #
    # It IS allowed to be the sole basis here, which departs from
    # types_from_name's own rule ("never the sole basis for a POI"). That
    # rule exists for OSM, where the alternative is admitting an element
    # nothing identified as a place at all. An Overture candidate is already
    # a known place with a name and a category — the only open question is
    # which type it is — so the name choosing that type invents nothing.
    # "Talho Halal Barakah" filed under `halal_restaurant` is a butcher, and
    # the category is simply wrong.
    named = [reachable[t] for t in types_from_name(normalized, tuple(types))
             if t in reachable]
    if named and row['category'] in NAME_OUTRANKS_CATEGORY:
        # The coarse hair/beauty bucket: the name decides, and goes first.
        types = named + [t for t in types if t not in named]
        reason = f"name over category {row['category']}: {types[0]}"
    else:
        for inferred in named:
            if inferred not in types:
                types.append(inferred)
                reason = reason or f'name: {inferred}'

    if not types:
        return 'pending', (), (), None
    return 'promoted', tuple(types), tuple(attributes), reason


def poi_values(row, poi_type, brand_dictionary, refreshed):
    name = row['name']
    open_min, close_min = hours_for_poi_type(poi_type)
    confidence = row.get('confidence')
    return (
        f"({sql_escape(row['overture_id'])},{sql_escape(name)},"
        f"{sql_escape(normalize_text(name) or name.strip().lower())},"
        f"{row['lat']},{row['lng']},"
        f"{sql_escape(encode_geohash(row['lat'], row['lng']))},"
        f"{sql_escape(poi_type)},"
        f"{sql_escape(find_brand(name, [poi_type], brand_dictionary))},"
        f"{sql_escape(row.get('address'))},{sql_escape(row.get('category'))},"
        f"{'NULL' if confidence is None else confidence},"
        f"{sql_escape(row.get('source_datasets'))},"
        f"{'NULL' if open_min is None else open_min},"
        f"{'NULL' if close_min is None else close_min},"
        f"{sql_escape(refreshed)},{sql_escape(refreshed)})"
    )


def batched(prefix, pieces):
    values, size = [], byte_len(prefix) + 2
    for piece in pieces:
        # +2, not +1: join writes ',\n' between values. Same undercount as
        # the loader had.
        piece_size = byte_len(piece) + 2
        if values and (size + piece_size > MAX_STATEMENT_BYTES
                       or len(values) >= MAX_VALUES_TERMS):
            yield prefix + ',\n'.join(values) + ';\n'
            values, size = [], byte_len(prefix) + 2
        values.append(piece)
        size += piece_size
    if values:
        yield prefix + ',\n'.join(values) + ';\n'


def status_updates(decided, status):
    """What was decided AND why. A status without its reason cannot be
    reviewed by anyone who was not in the room.

    Never overwrites a decision already made: a rerun must not turn a
    promotion into something else because the mapping changed underneath it.
    """
    for overture_id, reason in decided:
        yield (
            'UPDATE overture_candidate SET '
            f'promotion_status = {sql_escape(status)}, '
            f'promotion_note = {sql_escape(reason)} '
            f"WHERE overture_id = {sql_escape(overture_id)} "
            "AND promotion_status = 'pending';\n"
        )


def run(batch, out_dir, dry_run):
    mapping = category_map()
    reachable = reachable_types()
    brand_dictionary = load_brand_dictionary()
    refreshed = date.today().isoformat()

    stats = Counter()
    by_type = Counter()
    unmapped = Counter()
    poi_pieces, type_pieces, attribute_pieces = [], [], []
    promoted, rejected = [], []

    # `overture_id` is the primary key, so it is unique per returned row —
    # the condition paged() requires for its keyset cursor to be safe.
    for row in paged(
        'overture_candidate',
        ('overture_id', 'name', 'lat', 'lng', 'address', 'category',
         'confidence', 'source_datasets'),
        'overture_id', batch,
        where="promotion_status = 'pending'",
    ):
        status, types, attributes, reason = decide(
            row, mapping, reachable, brand_dictionary)
        stats[status] += 1
        if status == 'promoted':
            by_type[types[0]] += 1
            promoted.append((row['overture_id'], reason))
            poi_pieces.append(poi_values(row, types[0], brand_dictionary, refreshed))
            for rank, poi_type in enumerate(types):
                type_pieces.append(
                    f"({sql_escape(row['overture_id'])},{sql_escape(poi_type)},{rank})")
            for dimension, value in attributes:
                attribute_pieces.append(
                    f"({sql_escape(row['overture_id'])},{sql_escape(dimension)},"
                    f"{sql_escape(value)})")
        elif status == 'rejected':
            rejected.append((row['overture_id'], reason))
        else:
            unmapped[row['category'] or '(none)'] += 1

    print(f"\nscanned   {sum(stats.values()):,}")
    print(f"promoted  {stats['promoted']:,}")
    print(f"pending   {stats['pending']:,}")
    print(f"rejected  {stats['rejected']:,}")
    print('\npromoted by type:')
    for poi_type, count in by_type.most_common(20):
        print(f'  {count:7,}  {poi_type}')
    print(f'\nunmapped categories ({len(unmapped)}), top 20 — the mapping backlog:')
    for category, count in unmapped.most_common(20):
        print(f'  {count:7,}  {category}')

    if dry_run:
        print('\n--dry-run: no SQL written')
        return

    os.makedirs(out_dir, exist_ok=True)
    for name, statements in (
        ('00_overture_poi', batched(POI_INSERT_PREFIX, poi_pieces)),
        ('01_overture_poi_type', batched(TYPE_INSERT_PREFIX, type_pieces)),
        ('02_overture_poi_attribute', batched(ATTRIBUTE_INSERT_PREFIX, attribute_pieces)),
        ('03_status_promoted', status_updates(promoted, 'promoted')),
        ('04_status_rejected', status_updates(rejected, 'rejected')),
    ):
        path = os.path.join(out_dir, f'{name}.sql')
        with open(path, 'w') as handle:
            handle.writelines(statements)
        print(f'wrote {path}')


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--sql-out', required=True)
    parser.add_argument('--batch', type=int, default=10000)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    # paged() uses this as its LIMIT. Zero returns no rows and the keyset
    # cursor never advances, so the scan spins forever reporting nothing.
    if args.batch < 1:
        parser.error('--batch must be at least 1')
    run(args.batch, args.sql_out, args.dry_run)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
