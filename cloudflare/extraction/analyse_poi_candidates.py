"""
KAN-404 phase 2. Reads `poi_candidate` and answers two questions the
promotion phase cannot start without.

1. WHICH CANDIDATES ARE ALREADY IN THE DATABASE UNDER ANOTHER NAME?

   `poi` holds 223k Foursquare places and `osm_poi` holds 75k OSM ones, and
   the OSM supplement deliberately imported venues Foursquare never had. A
   candidate promoted without checking both would create a second row for a
   place the app already knows — the exact duplicate class KAN-392 spent 186
   corrections cleaning up.

   Foursquare ids cannot answer this: an OSM row has no fsq_place_id, so the
   `poi` id check the loader already did says nothing about OSM. Matching is
   by normalized name within MATCH_RADIUS_METERS, using the same
   normalize_text, name_similarity and thresholds the OSM importer uses.
   A third normalizer would mean three definitions of "same place".

2. WHAT WOULD EACH CANDIDATE BECOME, USING ONLY TYPES THE APP ALREADY HAS?

   Every new POI type is app work — catalog entry, icon, two translations,
   dictionary terms. So the ranking is by how much volume an EXISTING type
   can absorb, not by what a perfect taxonomy would look like. A candidate
   is attributed to an existing type when its category path descends from a
   category we already map (the KAN-403 descendant finding: 58,494 PT rows
   need no new type at all), or when its name states one (KAN-391's
   keywords).

Everything is paged. Nothing is held in memory whole except the two
identity indexes, and nothing is written — this script only reads.

Usage:
  python3 analyse_poi_candidates.py [--batch 10000] [--out <path.md>]
"""
import json
import math
import os
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict

from classify_and_load import (
    NAME_TYPE_KEYWORDS, load_mapping, normalize_text, build_reverse_map,
)
from enrich_osm_cuisine import (
    MATCH_RADIUS_METERS, NAME_SIMILARITY_THRESHOLD,
)
from supplement_osm_pois import name_similarity

CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(CLOUDFLARE_DIR, 'src')
GRID_DEG = MATCH_RADIUS_METERS / 111_000


def query(sql, attempts=5):
    """Read-only, through wrangler. This runs from a workstation, not the
    container, so d1.internal does not resolve here.

    Retried with backoff: a full pass is ~50 CLI calls in quick succession
    and the API intermittently refuses one. Without this the whole scan dies
    on a blip after several minutes of work, which is how the first run of
    this script ended.
    """
    for attempt in range(attempts):
        result = subprocess.run(
            ['npx', 'wrangler', 'd1', 'execute', 'brush-poi-registry', '--remote',
             '-y', '--command', sql, '--json'],
            cwd=CLOUDFLARE_DIR, capture_output=True, text=True,
        )
        if result.returncode == 0:
            try:
                return json.loads(result.stdout)[0]['results']
            except (json.JSONDecodeError, IndexError, KeyError) as error:
                last = f'unparseable response: {error}'
        else:
            last = (result.stderr or result.stdout)[-400:]
        if attempt < attempts - 1:
            delay = 2 ** attempt
            print(f'  retrying in {delay}s after: {last.strip()[:160]}', file=sys.stderr)
            time.sleep(delay)
    raise RuntimeError(f'D1 read failed after {attempts} attempts: {last}')


def paged(table, columns, key, batch):
    """Keyset pagination, not OFFSET: D1 charges rows_read for everything it
    skips, so OFFSET on a 200k table re-reads the whole prefix every page."""
    last = ''
    while True:
        rows = query(
            f"SELECT {', '.join(columns)} FROM {table} "
            f"WHERE {key} > '{last}' ORDER BY {key} LIMIT {batch}"
        )
        if not rows:
            return
        for row in rows:
            yield row
        last = rows[-1][key]


def metres(lat1, lng1, lat2, lng2):
    mean_lat = math.radians((lat1 + lat2) / 2)
    dx = (lng2 - lng1) * 111_320 * math.cos(mean_lat)
    dy = (lat2 - lat1) * 110_540
    return math.hypot(dx, dy)


def cell(lat, lng):
    return (int(lat / GRID_DEG), int(lng / GRID_DEG))


def build_identity_index(batch):
    """{cell: [(dedupe_name, lat, lng, source)]} for both existing sources.

    Cells are MATCH_RADIUS_METERS wide, so a candidate can only match
    something in its own cell or the eight around it — the same grid trick
    the OSM supplement uses to avoid a 217k x 300k comparison.
    """
    index = defaultdict(list)
    counts = Counter()
    for table, key, source in (
        ('poi', 'fsq_place_id', 'fsq'),
        ('osm_poi', 'osm_element_id', 'osm'),
    ):
        for row in paged(table, [key, 'dedupe_name', 'lat', 'lng'], key, batch):
            name = row.get('dedupe_name')
            if not name or row.get('lat') is None:
                continue
            index[cell(row['lat'], row['lng'])].append(
                (name, row['lat'], row['lng'], source))
            counts[source] += 1
        print(f'  indexed {counts[source]:,} rows from {table}', file=sys.stderr)
    return index, counts


def existing_match(index, name, lat, lng):
    """The best existing row this candidate is plausibly the same place as."""
    if not name:
        return None
    base = cell(lat, lng)
    best = None
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for other_name, other_lat, other_lng, source in index.get(
                    (base[0] + dx, base[1] + dy), ()):
                if metres(lat, lng, other_lat, other_lng) > MATCH_RADIUS_METERS:
                    continue
                score = name_similarity(name, other_name)
                if score >= NAME_SIMILARITY_THRESHOLD and (best is None or score > best[1]):
                    best = (other_name, score, source)
    return best


def mapped_category_labels():
    """The label of every category the app already maps, so a candidate can
    be tested for descending from one."""
    labels = {}
    for filename in ('poiTypeCategories.json', 'storeSubtypeCategories.json',
                     'foodSubtypeCategories.json'):
        mapping = load_mapping(os.path.join(SRC_DIR, filename))
        for poi_type, entry in mapping.items():
            name = entry.get('category_name')
            if name:
                labels.setdefault(name, poi_type)
    return labels


def type_from_labels(label_text, mapped_labels):
    """An existing type for this candidate, via the taxonomy path.

    `list_has_any` matched ids exactly and so ignored the hierarchy; this
    walks the label path instead, which is what makes an 8-row Australian
    Restaurant a plain `restaurant` with no new type decision.
    """
    if not label_text:
        return None
    for path in label_text.split('|'):
        segments = [segment.strip() for segment in path.split('>')]
        for segment in reversed(segments):
            if segment in mapped_labels:
                return mapped_labels[segment]
    return None


def reachable_types():
    """Every classifier type a user can already reach, and the app type it
    lands on. Three distinct mechanisms, all of which already ship:

      * the PoiType union itself (27 types)
      * type_relation bridges — `fitness_center` IS `gym` to a searcher, and
        `grocery_store` IS `supermarket` (KAN-398 built these precisely so
        the classifier's vocabulary and the app's could differ safely)
      * store and food subtype keys — `furniture` and `sports` are reachable
        as `store`, `mexican` as `restaurant`, via the subtype dimension
        rather than a type of their own

    Counting any of these as "needs a new POI type" overstates the app work
    by treating vocabulary we already bridge as vocabulary we lack.
    """
    types = {}
    for poi_type in _union_types():
        types[poi_type] = poi_type
    for search_type, include_type in _type_relation_pairs():
        if include_type in types and search_type not in types:
            types[search_type] = types[include_type]
    for filename, parent in (('storeSubtypeCategories.json', 'store'),
                             ('foodSubtypeCategories.json', 'restaurant')):
        for key in load_mapping(os.path.join(SRC_DIR, filename)):
            types.setdefault(key, parent)
    return types


def _type_relation_pairs():
    return [(row['search_type'], row['include_type'])
            for row in query('SELECT search_type, include_type FROM type_relation')]


def _union_types():
    """The 27 types the app's PoiType union actually has.

    poiTypeCategories.json carries 93 keys — the classifier's vocabulary,
    which is wider. A candidate landing on a classifier key the app has no
    type for is NOT free: it needs a catalog entry, an icon and two
    translations before anyone can tag a task with it. Conflating the two
    is how `gas`, `post`, `clinic` and `bus` ended up offered to users while
    matching zero rows (KAN-398), so the report keeps them apart.
    """
    source = os.path.join(os.path.dirname(CLOUDFLARE_DIR), 'src', 'types', 'index.ts')
    with open(source) as handle:
        text = handle.read()
    union = text.split('export type PoiType =', 1)[1].split(';', 1)[0]
    return frozenset(re.findall(r"'([a-z_]+)'", union))


def type_from_name(name):
    """KAN-391's keywords. Values are plain type strings, not collections —
    indexing into one yields a letter, not a type."""
    padded = f' {name} '
    for keyword, poi_type in NAME_TYPE_KEYWORDS.items():
        if f' {keyword} ' in padded:
            return poi_type
    return None


def analyse(batch, out_path):
    print('building identity index from poi + osm_poi...', file=sys.stderr)
    index, source_counts = build_identity_index(batch)
    mapped_labels = mapped_category_labels()

    app_types = reachable_types()
    stats = Counter()
    by_existing_type = Counter()
    by_classifier_only = Counter()
    dup_examples = []
    unmapped_labels = Counter()

    print('scanning candidates...', file=sys.stderr)
    for row in paged('poi_candidate',
                     ['fsq_place_id', 'name', 'lat', 'lng', 'raw_category_labels'],
                     'fsq_place_id', batch):
        stats['total'] += 1
        if stats['total'] % 25000 == 0:
            print(f'  {stats["total"]:,}', file=sys.stderr)

        normalized = normalize_text(row['name'] or '')
        match = existing_match(index, normalized, row['lat'], row['lng'])
        if match:
            stats['duplicate'] += 1
            stats[f'duplicate_{match[2]}'] += 1
            if len(dup_examples) < 40:
                dup_examples.append((row['name'], match[0], round(match[1], 2), match[2]))
            continue

        existing_type = (type_from_labels(row['raw_category_labels'], mapped_labels)
                         or type_from_name(normalized))
        if existing_type and existing_type in app_types:
            stats['absorbed'] += 1
            by_existing_type[app_types[existing_type]] += 1
        elif existing_type:
            # Classified, but onto a type the app cannot express yet.
            stats['classifier_only'] += 1
            by_classifier_only[existing_type] += 1
        else:
            stats['needs_decision'] += 1
            for path in (row['raw_category_labels'] or '').split('|'):
                if path.strip():
                    unmapped_labels[path.strip()] += 1

    report(out_path, stats, source_counts, by_existing_type, by_classifier_only,
           unmapped_labels, dup_examples)
    return stats


def report(out_path, stats, source_counts, by_existing_type, by_classifier_only,
           unmapped_labels, dup_examples):
    lines = []
    add = lines.append
    total = stats['total'] or 1
    add('# KAN-404 phase 2 — what is in poi_candidate\n')
    add(f'Candidates scanned: **{stats["total"]:,}**\n')
    add('Identity index built from '
        f'{source_counts["fsq"]:,} `poi` rows and {source_counts["osm"]:,} `osm_poi` rows, '
        f'matched on normalized name within {MATCH_RADIUS_METERS}m at similarity '
        f'>= {NAME_SIMILARITY_THRESHOLD}.\n')
    add('| outcome | rows | share |')
    add('|---|---:|---:|')
    for key, label in (('duplicate', 'Already in the database under another name'),
                       ('absorbed', 'Fits a type the app already ships'),
                       ('classifier_only', 'Classifiable, but onto a type the app has no PoiType for'),
                       ('needs_decision', 'Needs a product decision')):
        add(f'| {label} | {stats[key]:,} | {stats[key] / total * 100:.1f}% |')
    add('')
    add(f'Of the duplicates, {stats["duplicate_osm"]:,} match an OSM row and '
        f'{stats["duplicate_fsq"]:,} match a Foursquare row already in `poi`.\n')

    add('## Absorbed by an existing type\n')
    add('No new app work: no catalog entry, no icon, no translations.\n')
    add('| existing type | rows |')
    add('|---|---:|')
    for poi_type, n in by_existing_type.most_common():
        add(f'| `{poi_type}` | {n:,} |')
    add('')

    add('## Classified, but the app has no PoiType for it\n')
    add('These are not free. Each needs a catalog entry, an icon and two\n'
        'translations before a task can be tagged with it — the difference\n'
        'that left `gas`, `post`, `clinic` and `bus` matching zero rows until\n'
        'KAN-398.\n')
    add('| classifier type | rows |')
    add('|---|---:|')
    for poi_type, n in by_classifier_only.most_common():
        add(f'| `{poi_type}` | {n:,} |')
    add('')

    add('## Still needing a decision, ranked\n')
    add('| category path | rows |')
    add('|---|---:|')
    for label, n in unmapped_labels.most_common(120):
        add(f'| {label} | {n:,} |')
    add('')

    add('## Duplicate examples\n')
    add('```')
    for name, matched, score, source in dup_examples:
        add(f'{score:.2f} {source}  {name}  ==  {matched}')
    add('```')

    with open(out_path, 'w') as handle:
        handle.write('\n'.join(lines) + '\n')
    print(f'wrote {out_path}', file=sys.stderr)


if __name__ == '__main__':
    args = sys.argv[1:]
    batch = 10000
    out = os.path.join(os.path.dirname(CLOUDFLARE_DIR), 'docs',
                       'KAN-404-candidate-analysis.md')
    if '--batch' in args:
        batch = int(args[args.index('--batch') + 1])
    if '--out' in args:
        out = args[args.index('--out') + 1]
    analyse(batch, out)
