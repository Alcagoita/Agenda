"""
KAN-404 phase 3. Applies the settled rules to `poi_candidate` and emits the
promotion as SQL.

Every rule here was decided from measured evidence, not taste:

  REJECT — duplicate. The row is a place we already hold, matched on
    normalized name within MATCH_RADIUS_METERS against BOTH `poi` and
    `osm_poi`. The OSM half is the one that matters: an OSM row has no
    fsq_place_id, so the id exclusion the loader did says nothing about it,
    and 11,272 candidates match one.

  REJECT — geography. Road, Structure, City, Neighborhood, Farm, Field and
    friends are not places a person visits. This is the ONLY kind of
    wholesale exclusion allowed: bare parents and geography, never a branch
    of the taxonomy (KAN-403 — a junk parent does not make its children
    junk).

  PROMOTE — the row lands on a type a user can already reach. Reachability
    is wider than the PoiType union: type_relation bridges fitness_center to
    gym and grocery_store to supermarket, and the store/food subtype keys
    resolve into store and restaurant.

  PROMOTE — lodging. Product decision: load them now, dormant, against a
    future use case. Neither `hotel` nor `lodging` is in the PoiType union,
    so these rows are unreachable until that exists. Deliberate.

  PENDING — everything else, left exactly as it is. Notably the Medical
    Center, Education and Financial Service leaves: the product decision is
    that no use case is served by a RANDOM location of those types, so they
    are not promoted — but not rejected either, because rejection is the
    only decision that becomes irreversible when the table is dropped.

Promoted rows are built to be indistinguishable from imported ones: geohash
at the same precision, dedupe_name through the same normalizer, brand
through the same dictionary in the same priority order. A promoted row
missing its geohash would be silently invisible to nearby search, which
does a geohash prefix range scan.

Usage:
  python3 promote_poi_candidates.py --sql-out <dir> [--batch 10000] [--dry-run]
"""
import os
import sys
from collections import Counter
from datetime import date

from analyse_poi_candidates import (
    build_identity_index, existing_match, mapped_category_labels, paged, query,
    reachable_types, type_from_labels, type_from_name,
)
from classify_and_load import (
    MAX_STATEMENT_BYTES, byte_len, encode_geohash, find_brand,
    load_brand_dictionary, normalize_text, sql_escape,
)
from load_poi_candidates import MAX_VALUES_TERMS

# Leaves that are geography rather than destinations. The ONLY wholesale
# exclusion permitted — see the module docstring.
GEOGRAPHY_LEAVES = frozenset({
    'Road', 'Structure', 'City', 'Neighborhood', 'Village', 'Town',
    'States and Municipalities', 'Housing Development', 'Apartment or Condo',
    'Residential Building', 'Farm', 'Field', 'Forest', 'Well', 'Stable',
    'Roof Deck', 'Other Great Outdoors', 'Factory',
})

# Product decision: no use case is served by a RANDOM location of these
# types — you do not wander into a clinic, you have an appointment; you do
# not pass a school and remember an errand. They stay pending rather than
# being promoted.
#
# `financial_service` and `clinic` have no Foursquare category at all and so
# would never have been promoted anyway, but that is luck rather than intent,
# and luck is what this list replaces. `school` IS mapped (to "Primary and
# Secondary School") and was being promoted until this existed.
#
# Not rejected — rejection is the only decision that survives the table being
# dropped, and this one may be revisited if a use case appears.
NOT_WANTED_TYPES = frozenset({'school', 'clinic', 'financial_service'})

# Product decision: load now, dormant until a use case exists.
LODGING_LEAVES = frozenset({
    'Hotel', 'Hostel', 'Bed and Breakfast', 'Vacation Rental', 'Motel',
    'Inn', 'Guesthouse', 'Lodging', 'Boarding House', 'Resort',
})

POI_INSERT_PREFIX = (
    'INSERT OR IGNORE INTO poi '
    '(fsq_place_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, brand, '
    'category_label, raw_category_ids, raw_category_labels, address, date_refreshed) '
    'VALUES '
)
POI_TYPE_INSERT_PREFIX = 'INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank) VALUES '


def leaf_of(label_text):
    if not label_text:
        return None
    return label_text.split('|')[0].split('>')[-1].strip()


def decide(row, index, mapped_labels, reachable):
    """(status, poi_type, reason) for one candidate. Order matters: the
    duplicate test runs first, because a row we already hold must not be
    promoted however well it classifies."""
    normalized = normalize_text(row['name'] or '')
    match = existing_match(index, normalized, row['lat'], row['lng'])
    if match:
        return 'rejected', None, f'duplicate of {match[2]} "{match[0]}" ({match[1]:.2f})'

    leaf = leaf_of(row['raw_category_labels'])
    if leaf in GEOGRAPHY_LEAVES:
        return 'rejected', None, f'geography: {leaf}'

    classifier_type = (type_from_labels(row['raw_category_labels'], mapped_labels)
                       or type_from_name(normalized))
    if classifier_type and classifier_type in reachable:
        poi_type = reachable[classifier_type]
        if poi_type in NOT_WANTED_TYPES or classifier_type in NOT_WANTED_TYPES:
            return 'pending', None, None
        return 'promoted', poi_type, f'existing type via {classifier_type}'

    if leaf in LODGING_LEAVES:
        return 'promoted', 'lodging', f'lodging: {leaf}'

    return 'pending', None, None


def poi_values(row, poi_type, brand_dictionary, refreshed):
    name = row['name']
    labels = row['raw_category_labels']
    return (
        f"({sql_escape(row['fsq_place_id'])},{sql_escape(name)},"
        f"{sql_escape(normalize_text(name) or name.strip().lower())},"
        f"{row['lat']},{row['lng']},"
        f"{sql_escape(encode_geohash(row['lat'], row['lng']))},"
        f"{sql_escape(poi_type)},"
        f"{sql_escape(find_brand(name, [poi_type], brand_dictionary))},"
        f"{sql_escape(labels.split('|')[0] if labels else None)},"
        f"{sql_escape(row['raw_category_ids'])},{sql_escape(labels)},"
        f"{sql_escape(row['address'])},{sql_escape(refreshed)})"
    )


def batched(prefix, pieces, suffix=''):
    values, size = [], byte_len(prefix) + byte_len(suffix) + 2
    for piece in pieces:
        piece_size = byte_len(piece) + 1
        if values and (size + piece_size > MAX_STATEMENT_BYTES or len(values) >= MAX_VALUES_TERMS):
            yield prefix + ','.join(values) + suffix + ';\n'
            values, size = [], byte_len(prefix) + byte_len(suffix) + 2
        values.append(piece)
        size += piece_size
    if values:
        yield prefix + ','.join(values) + suffix + ';\n'


def status_updates(decided_ids, status):
    """promotion_status carries the audit trail, so a dropped table still
    leaves a record of what was decided and why."""
    for start in range(0, len(decided_ids), 400):
        chunk = decided_ids[start:start + 400]
        ids = ','.join(sql_escape(i) for i, _ in chunk)
        yield (f"UPDATE poi_candidate SET promotion_status = '{status}' "
               f"WHERE fsq_place_id IN ({ids});\n")


def run(batch, out_dir, dry_run):
    print('building identity index from poi + osm_poi...', file=sys.stderr)
    index, _ = build_identity_index(batch)
    mapped_labels = mapped_category_labels()
    reachable = reachable_types()
    brand_dictionary = load_brand_dictionary()
    refreshed = date.today().isoformat()

    stats = Counter()
    seen_identities = set()
    by_type = Counter()
    reasons = Counter()
    poi_pieces, type_pieces = [], []
    promoted_ids, rejected_ids = [], []

    for row in paged('poi_candidate',
                     ['fsq_place_id', 'name', 'lat', 'lng', 'address',
                      'raw_category_ids', 'raw_category_labels'],
                     'fsq_place_id', batch):
        stats['scanned'] += 1
        if stats['scanned'] % 25000 == 0:
            print(f'  {stats["scanned"]:,}', file=sys.stderr)

        status, poi_type, reason = decide(row, index, mapped_labels, reachable)

        # `poi` carries UNIQUE (dedupe_name, lat, lng) — KAN-392's canonical
        # identity. Two candidates can collide on it: Foursquare holds more
        # than one id for the same place at the same coordinates. INSERT OR
        # IGNORE would keep one and silently drop the other, but the poi_type
        # row for the loser would still be written, leaving a row pointing at
        # a poi that does not exist. So the collision is resolved HERE, and
        # the loser is recorded as what it is — a duplicate.
        if status == 'promoted':
            identity = (normalize_text(row['name'] or ''), row['lat'], row['lng'])
            if identity in seen_identities:
                status, poi_type = 'rejected', None
                reason = 'duplicate of another candidate on (dedupe_name, lat, lng)'
                stats['duplicate_within_batch'] += 1
            else:
                seen_identities.add(identity)

        stats[status] += 1
        if status == 'promoted':
            by_type[poi_type] += 1
            promoted_ids.append((row['fsq_place_id'], reason))
            poi_pieces.append(poi_values(row, poi_type, brand_dictionary, refreshed))
            type_pieces.append(
                f"({sql_escape(row['fsq_place_id'])},{sql_escape(poi_type)},0)")
        elif status == 'rejected':
            rejected_ids.append((row['fsq_place_id'], reason))
            reasons[reason.split(':')[0].split(' of ')[0]] += 1

    print(f"\nscanned   {stats['scanned']:,}")
    print(f"promoted  {stats['promoted']:,}")
    print(f"rejected  {stats['rejected']:,}   {dict(reasons)}")
    print(f"pending   {stats['pending']:,}")
    print('\npromoted by type:')
    for poi_type, n in by_type.most_common():
        print(f'  {n:>7,}  {poi_type}')

    if dry_run:
        print('\n--dry-run: no SQL written')
        return stats

    os.makedirs(out_dir, exist_ok=True)
    written = 0
    for name, statements in (
        ('poi', batched(POI_INSERT_PREFIX, poi_pieces)),
        ('poi_type', batched(POI_TYPE_INSERT_PREFIX, type_pieces)),
        ('status_promoted', status_updates(promoted_ids, 'promoted')),
        ('status_rejected', status_updates(rejected_ids, 'rejected')),
    ):
        path = os.path.join(out_dir, f'{written:02d}_{name}.sql')
        with open(path, 'w') as handle:
            for statement in statements:
                handle.write(statement)
        print(f'wrote {path}')
        written += 1
    return stats


if __name__ == '__main__':
    args = sys.argv[1:]
    batch = int(args[args.index('--batch') + 1]) if '--batch' in args else 10000
    out = args[args.index('--sql-out') + 1] if '--sql-out' in args else None
    dry = '--dry-run' in args
    if not out and not dry:
        raise SystemExit('usage: promote_poi_candidates.py --sql-out <dir> [--batch N] [--dry-run]')
    run(batch, out, dry)
