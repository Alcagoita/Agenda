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

# KAN-410. Foursquare leaves that LOOK like a clean mapping and are not.
#
#   Bathing Area — reads like "praia fluvial" and holds a genuine population
#   of natural pools (Piscinas Naturais, Zona Balnear, Poça do Mata Sete),
#   but Foursquare also files beauty businesses there: "All About Beauty",
#   "Vida City SPA e Espaço ZEN", "Ervanária SaraNatura". Mapping it to
#   `beach` would answer a beach search with a nail salon.
#
# KAN-421 recovers the real ones, and not the way KAN-410 assumed.
#
# A beauty-word REJECT list does not work here. Reading all 87 pending PT
# rows, only ~26 are real; ~30 are the beauty businesses above, and ~28 are
# neither — "Casa De Banho" (a toilet), "Eco Bathroom Vd Moses" (a bathroom
# fixtures shop), "Infinity Pool" and "Jacuzzi" (hotel amenities), "Ponte
# Sobre Tejo A13" (a bridge), "Braga, Portugal" (a town), "ATLANTIC OCEAN
# SOUTH OF MADEIRA". Rejecting beauty words leaves every one of those
# promoting as a beach — ~48% correct, worse than the "two thirds right"
# this was split out to avoid. There is no finite list of not-a-bathing-area
# words that covers bridges, towns, toilets and the ocean.
#
# What separates them is that a praia fluvial or a piscina natural carries
# the phrase as its NAME, not as a description of somewhere nearby. So the
# phrase must LEAD the name: "Praia Fluvial de Meitriz" is the place, while
# "Bar da Praia Fluvial", "Ponte da Praia Fluvial", "Jardim da Praia Fluvial"
# and "Campo de Jogos da Praia Fluvial" are a bar, a bridge, a garden and a
# football pitch standing beside one. Across the whole candidate table that
# rule keeps 105 of 111 phrase-bearing rows and drops exactly those six.
#
# Two phrases only, deliberately. `poço` is a well and `albufeira` a
# reservoir — nobody swims there, and every term added past the point of
# certainty is how this leaf gets contaminated again.
# `Swimming Pool` is the same problem one leaf over, and the larger half of
# it: 938 pending rows, overwhelmingly municipal and hotel pools, holding the
# natural pools the Azores and Madeira are full of. It cannot be mapped as a
# category any more than Bathing Area can, and the same two phrases separate
# them.
NATURAL_WATER_PHRASES = ('praia fluvial', 'piscina natural', 'piscinas naturais')
NAME_GATED_LEAVES = {
    'Bathing Area': ('beach', NATURAL_WATER_PHRASES),
    'Swimming Pool': ('beach', NATURAL_WATER_PHRASES),
}

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

    # KAN-421. For a name-gated leaf the category is not evidence on its own,
    # so the name is allowed to promote a row the category could not. The gate
    # only ever ADDS a promotion: a name it does not admit falls through to
    # the ordinary path below, unchanged.
    #
    # Measured before choosing that, over all 1,019 pending rows in the two
    # gated leaves: the classifier promotes zero of them today, so blocking
    # the fall-through would have changed nothing now and quietly broken the
    # day someone maps one of these leaves deliberately.
    gate = NAME_GATED_LEAVES.get(leaf)
    if gate:
        gated_type, phrases = gate
        # The phrase must end on a word boundary, not merely prefix the name:
        # a bare `startswith` would admit "piscina naturalista" as a natural
        # pool. `normalize_text` has already collapsed punctuation to spaces,
        # so a following space is the whole test — plus the exact match, for
        # the row named just "Piscinas Naturais".
        if gated_type in reachable and any(
                normalized == p or normalized.startswith(p + ' ') for p in phrases):
            return 'promoted', reachable[gated_type], f'name-gated {leaf}: {gated_type}'

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
    """The audit trail: what was decided AND why.

    promotion_note is written alongside promotion_status because a status on
    its own cannot be reviewed — "rejected" does not say whether the row was
    a duplicate, a road, or a company registration.

    Guarded on `promotion_status = 'pending'` so a rerun can never overwrite
    a decision already made. That guard matters: on a second pass a row
    promoted by the first is now in `poi`, so the duplicate check matches it
    against itself and would otherwise flip it from promoted to rejected.
    """
    for start in range(0, len(decided_ids), 400):
        chunk = decided_ids[start:start + 400]
        # One statement per distinct reason, so the note is accurate per row
        # rather than a single reason smeared across the whole chunk.
        by_reason = {}
        for place_id, reason in chunk:
            by_reason.setdefault(reason, []).append(place_id)
        for reason, ids in by_reason.items():
            id_list = ','.join(sql_escape(i) for i in ids)
            yield (f"UPDATE poi_candidate SET promotion_status = '{status}', "
                   f"promotion_note = {sql_escape(reason)} "
                   f"WHERE fsq_place_id IN ({id_list}) "
                   f"AND promotion_status = 'pending';\n")


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

    # Only undecided rows. A row promoted by an earlier run is now in `poi`,
    # so the duplicate check would match it against itself and re-decide it
    # as a duplicate — turning a promotion into a rejection on every rerun.
    for row in paged('poi_candidate',
                     ['fsq_place_id', 'name', 'lat', 'lng', 'address',
                      'raw_category_ids', 'raw_category_labels'],
                     'fsq_place_id', batch,
                     where="promotion_status = 'pending'"):
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
