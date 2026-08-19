"""KAN-383 — add OSM POIs that Foursquare Open Map does not contain.

This is deliberately separate from ``enrich_osm_cuisine.py``.  Enrichment
only improves an existing Foursquare row; this importer admits a *new* OSM
record only after proving it has no confident nearby Foursquare, community, or
already-imported OSM counterpart.  OSM element ids are stable source ids, so
overlapping settlement scopes and repeated runs are idempotent.

The first operational use is always ``--dry-run --place <id>``.  It writes no
D1 data and prints a deterministic audit plus the candidate names and a local
JSON report of nearby, differently named source rows for human review.
"""
from __future__ import annotations

import argparse
import datetime
import difflib
import json
import math
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from typing import Iterable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from classify_and_load import (
    encode_geohash, find_brand, load_brand_dictionary, normalize_text,
    replaces_generic_store, types_from_name,
)
from enrich_osm_cuisine import (
    MATCH_RADIUS_METERS,
    MIN_CONTAINED_NAME_LENGTH,
    NAME_SIMILARITY_THRESHOLD,
    OSM_CUISINE_TO_FOOD_CUISINE,
    OSM_SHOP_TO_STORE_KIND,
    fetch_overpass,
    haversine_m,
)

CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(CLOUDFLARE_DIR, 'build')
GRID_LAT_DEG = MATCH_RADIUS_METERS / 111_000
SQL_BATCH_SIZE = 250

# Venue categories and grammatical particles do not identify a business.
# This deliberately small, evidence-led list supports trustworthy normalized
# identities such as "Café Ala Sul" / "Ala Sul Café". It is not a Portuguese
# venue taxonomy: expand it only from reviewed dry-run evidence.
NON_IDENTITY_NAME_TOKENS = frozenset({
    'a', 'as', 'bar', 'cafe', 'cafeteria', 'da', 'das', 'de', 'do', 'dos',
    'e', 'hamburgueria', 'loja', 'o', 'os', 'pastelaria', 'pizzeria', 'pub',
    'restaurant', 'restaurante', 'shop', 'store',
})

# The public app's OSM tag policy, made explicit for server import.  ``shop``
# needs special treatment: most concrete shop values are useful generic stores,
# while these values describe an area/empty unit rather than a shop the user can
# visit.
EXCLUDED_SHOP_VALUES = frozenset({'mall', 'vacant', 'empty', 'yes', 'no'})
TAG_TYPES: tuple[tuple[str, str, str], ...] = (
    ('amenity', 'atm', 'atm'),
    ('amenity', 'cafe', 'cafe'),
    ('shop', 'supermarket', 'supermarket'),
    ('amenity', 'pharmacy', 'pharmacy'),
    ('amenity', 'fuel', 'gas'),
    ('leisure', 'fitness_centre', 'gym'),
    ('amenity', 'bank', 'bank'),
    ('amenity', 'bureau_de_change', 'currency_exchange'),
    ('amenity', 'money_transfer', 'money_transfer'),
    ('office', 'financial', 'financial_service'),
    ('amenity', 'restaurant', 'restaurant'),
    ('amenity', 'fast_food', 'restaurant'),
    ('leisure', 'park', 'park'),
    ('amenity', 'library', 'library'),
    ('amenity', 'post_office', 'post'),
    ('amenity', 'clinic', 'clinic'),
    ('amenity', 'school', 'school'),
    ('shop', 'bakery', 'bakery'),
    # KAN-399. Both tags are in use: amenity=ice_cream is the parlour you sit
    # in, shop=ice_cream the counter you buy from. Neither was mapped, so the
    # first produced no type at all (dropping the element outright) and the
    # second fell through to generic `store`.
    ('amenity', 'ice_cream', 'ice_cream'),
    ('shop', 'ice_cream', 'ice_cream'),
    ('shop', 'florist', 'florist'),
    # KAN-402. shop=tattoo is a standard OSM tag that was never mapped, so
    # 77 Portuguese studios fell through to generic `store`.
    ('shop', 'tattoo', 'tattoo'),
    ('amenity', 'bar', 'bar'),
    ('amenity', 'pub', 'bar'),
)


@dataclass(frozen=True)
class Candidate:
    source: str
    source_id: str
    name: str
    dedupe_name: str
    lat: float
    lng: float
    poi_type: str


@dataclass(frozen=True)
class SourceCorrection:
    source: str
    source_id: str
    visible: bool
    name_override: str | None
    dedupe_name_override: str | None


@dataclass(frozen=True)
class OsmPoi:
    osm_element_id: str
    name: str
    dedupe_name: str
    lat: float
    lng: float
    primary_poi_type: str
    poi_types: tuple[str, ...]
    brand: str | None
    address: str | None
    attributes: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class PossibleRename:
    osm_element_id: str
    osm_name: str
    osm_lat: float
    osm_lng: float
    poi_type: str
    source: str
    source_id: str
    source_name: str
    source_lat: float
    source_lng: float
    distance_meters: float
    severity: str

    def as_dict(self) -> dict:
        return {
            'osm_element_id': self.osm_element_id,
            'osm_name': self.osm_name,
            'osm_lat': self.osm_lat,
            'osm_lng': self.osm_lng,
            'poi_type': self.poi_type,
            'source': self.source,
            'source_id': self.source_id,
            'source_name': self.source_name,
            'source_lat': self.source_lat,
            'source_lng': self.source_lng,
            'distance_meters': round(self.distance_meters, 1),
            'severity': self.severity,
        }


def sql_quote(value: str | None) -> str:
    if value is None:
        return 'NULL'
    # OSM tags are external input. Keep generated statement boundaries out of
    # values as an additional defence around the normal SQL literal escaping.
    sanitized = re.sub(r'[\x00-\x1f\x7f;]+', ' ', value).strip()
    return "'" + sanitized.replace("'", "''") + "'"


def run_d1_query(sql: str) -> list[dict]:
    """Read D1 both locally and inside the extraction Container.

    Local dry-runs retain the existing Wrangler read-only convention.  The
    container calls the Worker binding through d1_client instead, avoiding a
    second Cloudflare credential in the job image.
    """
    if os.environ.get('D1_INTERNAL') == '1':
        import d1_client
        return d1_client.select(sql)
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'brush-poi-registry', '--remote', '--command', sql, '--json'],
        cwd=CLOUDFLARE_DIR, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)[0]['results']


def normalized_identity_terms_match(left: str, right: str) -> bool:
    """Match reordered multi-term business identities, never a shared word."""
    if left == right:
        return False
    left_core = Counter(token for token in left.split() if token not in NON_IDENTITY_NAME_TOKENS)
    right_core = Counter(token for token in right.split() if token not in NON_IDENTITY_NAME_TOKENS)
    # A one-term identity is too weak: Café Rosa and Alberto Rosa & Filhos can
    # be separate venues. Counter equality also preserves repeated terms.
    return sum(left_core.values()) >= 2 and left_core == right_core


def name_similarity(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    shorter, longer = sorted((left, right), key=len)
    if (len(shorter) >= MIN_CONTAINED_NAME_LENGTH and
            (longer.startswith(shorter + ' ') or longer.endswith(' ' + shorter))):
        return 0.9
    if normalized_identity_terms_match(left, right):
        return 0.9
    return difflib.SequenceMatcher(None, left, right).ratio()


def element_coordinates(element: dict) -> tuple[float, float] | None:
    lat = element.get('lat') or (element.get('center') or {}).get('lat')
    lng = element.get('lon') or (element.get('center') or {}).get('lon')
    if lat is None or lng is None:
        return None
    return float(lat), float(lng)


def address_for(tags: dict[str, str]) -> str | None:
    full = tags.get('addr:full')
    if full:
        return full
    parts = [tags.get('addr:street'), tags.get('addr:housenumber'), tags.get('addr:postcode'), tags.get('addr:city')]
    rendered = ', '.join(part for part in parts if part)
    return rendered or None


def types_for(tags: dict[str, str]) -> list[str]:
    types = [poi_type for key, value, poi_type in TAG_TYPES if tags.get(key) == value]
    shop = tags.get('shop')
    if shop and shop not in EXCLUDED_SHOP_VALUES and 'store' not in types and shop not in {'supermarket', 'bakery', 'florist', 'ice_cream', 'tattoo'}:
        types.append('store')
    return types


def attributes_for(tags: dict[str, str], poi_types: Iterable[str]) -> tuple[tuple[str, str], ...]:
    types = set(poi_types)
    attributes: list[tuple[str, str]] = []
    if 'restaurant' in types:
        for token in (tags.get('cuisine') or '').split(';'):
            cuisine = OSM_CUISINE_TO_FOOD_CUISINE.get(token.strip().lower())
            if cuisine:
                attributes.append(('food_cuisine', cuisine))
    if 'store' in types:
        store_kind = OSM_SHOP_TO_STORE_KIND.get((tags.get('shop') or '').strip().lower())
        if store_kind:
            attributes.append(('store_kind', store_kind))
    return tuple(sorted(set(attributes)))


def osm_poi_from_element(element: dict, brand_dictionary: dict) -> OsmPoi | None:
    tags = element.get('tags') or {}
    name = tags.get('name')
    coordinates = element_coordinates(element)
    element_type = element.get('type')
    element_id = element.get('id')
    if not isinstance(name, str) or not name.strip() or coordinates is None:
        return None
    if not isinstance(element_type, str) or not isinstance(element_id, int):
        return None
    tag_types = types_for(tags)
    if not tag_types:
        return None
    # KAN-391. Appended after the tag-derived types, never before: the first
    # entry becomes primary_poi_type, and what the mapper tagged outranks
    # what the name merely says. Guarded by the check above, so a name alone
    # still cannot conjure a POI out of an untyped element.
    inferred = types_from_name(name, tag_types)
    store_kind = OSM_SHOP_TO_STORE_KIND.get((tags.get('shop') or '').strip().lower())
    if replaces_generic_store(tag_types, inferred, bool(store_kind)):
        # A bare `shop=*` OSM never mapped is a shrug, not a claim. Keeping
        # it would leave a pastelaria matching a "buy a gift" store task.
        poi_types = inferred
    else:
        poi_types = tag_types + inferred
    dedupe_name = normalize_text(name)
    if not dedupe_name:
        return None
    lat, lng = coordinates
    ranked_types = tuple(dict.fromkeys(poi_types))
    return OsmPoi(
        osm_element_id=f'{element_type}/{element_id}',
        name=name.strip(), dedupe_name=dedupe_name, lat=lat, lng=lng,
        primary_poi_type=ranked_types[0], poi_types=ranked_types,
        brand=find_brand(name, ranked_types, brand_dictionary),
        address=address_for(tags), attributes=attributes_for(tags, ranked_types),
    )


def grid_key(poi_type: str, lat: float, lng: float, grid_lng_deg: float) -> tuple[str, int, int]:
    return poi_type, int(lat / GRID_LAT_DEG), int(lng / grid_lng_deg)


def grid_for(candidates: Iterable[Candidate], center_lat: float) -> dict[tuple[str, int, int], list[Candidate]]:
    grid_lng_deg = GRID_LAT_DEG / max(math.cos(math.radians(center_lat)), 0.01)
    grid: dict[tuple[str, int, int], list[Candidate]] = defaultdict(list)
    for candidate in candidates:
        grid[grid_key(candidate.poi_type, candidate.lat, candidate.lng, grid_lng_deg)].append(candidate)
    return grid


def confident_match(poi: OsmPoi, grid: dict[tuple[str, int, int], list[Candidate]], center_lat: float) -> Candidate | str | None:
    """Return an existing confident duplicate, ``ambiguous``, or None.

    This uses the same 75m / fuzzy-name safety contract as OSM subtype
    enrichment.  A close unrelated business is accepted; a weak or ambiguous
    resemblance is never merged or imported automatically.
    """
    grid_lng_deg = GRID_LAT_DEG / max(math.cos(math.radians(center_lat)), 0.01)
    scored: list[tuple[float, float, Candidate]] = []
    seen_ids: set[tuple[str, str]] = set()
    for poi_type in poi.poi_types:
        bucket = grid_key(poi_type, poi.lat, poi.lng, grid_lng_deg)
        for dlat in (-1, 0, 1):
            for dlng in (-1, 0, 1):
                for candidate in grid.get((poi_type, bucket[1] + dlat, bucket[2] + dlng), ()):
                    candidate_key = (candidate.source, candidate.source_id)
                    if candidate_key in seen_ids:
                        continue
                    seen_ids.add(candidate_key)
                    distance = haversine_m(poi.lat, poi.lng, candidate.lat, candidate.lng)
                    if distance > MATCH_RADIUS_METERS:
                        continue
                    similarity = name_similarity(poi.dedupe_name, candidate.dedupe_name)
                    if similarity >= NAME_SIMILARITY_THRESHOLD:
                        scored.append((similarity, distance, candidate))
    if not scored:
        return None
    scored.sort(key=lambda value: (-value[0], value[1], value[2].source, value[2].source_id))
    best_similarity, best_distance, best = scored[0]
    for similarity, distance, _ in scored[1:]:
        if best_similarity - similarity < 0.05 and abs(best_distance - distance) < 15:
            return 'ambiguous'
    return best


def paged_query(sql_for_after):
    """Yield a D1 identity scan in bounded responses, ordered by source id."""
    after = ''
    while True:
        page = run_d1_query(sql_for_after(after))
        if not page:
            return
        yield from page
        after = page[-1]['source_id']


def source_corrections() -> dict[tuple[str, str], SourceCorrection]:
    """Read the small, reviewed exception registry without blocking pre-migration dry-runs."""
    try:
        rows = run_d1_query('''
            SELECT source, source_id, visible, name_override, dedupe_name_override
            FROM poi_source_correction
        ''')
    except Exception as error:
        details = ' '.join((str(error), str(getattr(error, 'stdout', '')), str(getattr(error, 'stderr', ''))))
        if 'no such table: poi_source_correction' not in details:
            raise
        return {}
    return {
        (row['source'], row['source_id']): SourceCorrection(
            source=row['source'], source_id=row['source_id'], visible=bool(row['visible']),
            name_override=row['name_override'], dedupe_name_override=row['dedupe_name_override'],
        )
        for row in rows
    }


def apply_osm_correction(poi: OsmPoi, correction: SourceCorrection | None) -> OsmPoi | None:
    if correction is None:
        return poi
    if not correction.visible:
        return None
    name = correction.name_override or poi.name
    return replace(
        poi,
        name=name,
        dedupe_name=correction.dedupe_name_override or normalize_text(name),
    )


def candidate_bounds(min_lat: float, max_lat: float, min_lng: float, max_lng: float) -> tuple[float, float, float, float]:
    """Widen a scope bbox by the matching radius.

    A Foursquare venue just outside the municipality boundary must still be
    able to suppress an OSM element just inside it, or every boundary would
    quietly import duplicates.  Longitude degrees shrink with latitude, so
    the east/west margin is scaled by cos(lat) — the same correction
    ``grid_for`` applies.
    """
    lat_margin = MATCH_RADIUS_METERS / 111_000
    mid_lat = (min_lat + max_lat) / 2
    lng_margin = lat_margin / max(math.cos(math.radians(mid_lat)), 0.01)
    return min_lat - lat_margin, max_lat + lat_margin, min_lng - lng_margin, max_lng + lng_margin


def existing_candidates_in_bbox(
    min_lat: float, max_lat: float, min_lng: float, max_lng: float,
    corrections: dict[tuple[str, str], SourceCorrection] | None = None,
) -> list[Candidate]:
    """Identities near one scope, instead of the whole country (KAN-387).

    The loader this replaced read every POI in the country before the first
    municipality was touched — hundreds of thousands of rows through the
    Worker binding, held in container memory for the entire run.  A scope
    can only ever match something within ``MATCH_RADIUS_METERS``, so reading
    that neighbourhood is both far cheaper and exactly as correct.

    Already-imported ``osm_poi`` rows are included, which is what keeps
    overlapping municipality bboxes harmless now that each scope writes to
    D1 as it finishes: the overlap is re-read from D1 rather than carried
    between scopes in memory.
    """
    corrections = corrections if corrections is not None else source_corrections()
    lo_lat, hi_lat, lo_lng, hi_lng = candidate_bounds(min_lat, max_lat, min_lng, max_lng)
    box = f'lat BETWEEN {lo_lat} AND {hi_lat} AND lng BETWEEN {lo_lng} AND {hi_lng}'
    rows: list[Candidate] = []
    for row in paged_query(lambda after: '''
        WITH page AS (
          SELECT fsq_place_id, name, dedupe_name, lat, lng
          FROM poi WHERE %s AND fsq_place_id > %s ORDER BY fsq_place_id LIMIT 5000
        )
        SELECT page.fsq_place_id AS source_id, page.name, page.dedupe_name, page.lat, page.lng, poi_type.poi_type
        FROM page LEFT JOIN poi_type ON poi_type.fsq_place_id = page.fsq_place_id
        ORDER BY page.fsq_place_id
    ''' % (box, sql_quote(after))):
        correction = corrections.get(('foursquare', row['source_id']))
        if row['poi_type'] is not None and (correction is None or correction.visible):
            rows.append(Candidate('foursquare', row['source_id'], row['name'], row['dedupe_name'], row['lat'], row['lng'], row['poi_type']))
    for row in paged_query(lambda after: """
        SELECT poi_id AS source_id, name, dedupe_name, lat, lng, primary_poi_type AS poi_type
        FROM curated_poi WHERE status = 'active' AND %s AND poi_id > %s
        ORDER BY poi_id
        LIMIT 5000
    """ % (box, sql_quote(after))):
        rows.append(Candidate('community', row['source_id'], row['name'], row['dedupe_name'], row['lat'], row['lng'], row['poi_type']))
    try:
        osm_rows = list(paged_query(lambda after: '''
            WITH page AS (
              SELECT osm_element_id, name, dedupe_name, lat, lng
              FROM osm_poi WHERE %s AND osm_element_id > %s ORDER BY osm_element_id LIMIT 5000
            )
            SELECT page.osm_element_id AS source_id, page.name, page.dedupe_name, page.lat, page.lng, osm_poi_type.poi_type
            FROM page LEFT JOIN osm_poi_type ON osm_poi_type.osm_element_id = page.osm_element_id
            ORDER BY page.osm_element_id
        ''' % (box, sql_quote(after))))
    except Exception as error:
        # A dry-run is intentionally useful *before* the migration is applied.
        # Do not hide any other D1 failure: only the expected absent new table
        # is safe to treat as an empty first import.
        details = ' '.join((str(error), str(getattr(error, 'stdout', '')), str(getattr(error, 'stderr', ''))))
        if 'no such table: osm_poi' not in details:
            raise
        osm_rows = []
    for row in osm_rows:
        correction = corrections.get(('openstreetmap', row['source_id']))
        if row['poi_type'] is not None and (correction is None or correction.visible):
            name = correction.name_override if correction and correction.name_override else row['name']
            dedupe_name = correction.dedupe_name_override if correction and correction.dedupe_name_override else normalize_text(name)
            rows.append(Candidate('openstreetmap', row['source_id'], name, dedupe_name, row['lat'], row['lng'], row['poi_type']))
    return rows


def osm_query(min_lat: float, max_lat: float, min_lng: float, max_lng: float) -> str:
    # One nwr selector per source category: OSM overlap is preserved and then
    # collapsed by the stable element id below. `out center` keeps relation /
    # way locations usable alongside nodes without pretending bbox corners are
    # precise venue coordinates.
    selectors = [
        'nwr["amenity"~"^(atm|cafe|pharmacy|fuel|bank|bureau_de_change|money_transfer|restaurant|fast_food|library|post_office|clinic|school|bar|pub)$"]',
        'nwr["office"="financial"]',
        'nwr["leisure"~"^(fitness_centre|park)$"]',
        'nwr["shop"]',
    ]
    bbox = f'({min_lat},{min_lng},{max_lat},{max_lng})'
    return f'[out:json][timeout:170];({"".join(selector + bbox + ";" for selector in selectors)});out center;'


def classify_scope(elements: Iterable[dict], candidates: list[Candidate], center_lat: float, corrections: dict[tuple[str, str], SourceCorrection] | None = None) -> tuple[list[OsmPoi], dict[str, int]]:
    brand_dictionary = load_brand_dictionary()
    grid = grid_for(candidates, center_lat)
    grid_lng_deg = GRID_LAT_DEG / max(math.cos(math.radians(center_lat)), 0.01)
    existing_osm_ids = {candidate.source_id for candidate in candidates if candidate.source == 'openstreetmap'}
    imports: list[OsmPoi] = []
    stats: dict[str, int] = defaultdict(int)
    seen_elements: set[str] = set()
    corrections = corrections or {}
    for element in elements:
        poi = osm_poi_from_element(element, brand_dictionary)
        if poi is None:
            stats['unsupported_or_unnamed'] += 1
            continue
        if poi.osm_element_id in seen_elements:
            continue
        seen_elements.add(poi.osm_element_id)
        poi = apply_osm_correction(poi, corrections.get(('openstreetmap', poi.osm_element_id)))
        if poi is None:
            stats['operator_excluded'] += 1
            continue
        stats['classified'] += 1
        if poi.osm_element_id in existing_osm_ids:
            imports.append(poi)  # source refresh, not a duplicate
            stats['updated'] += 1
            continue
        match = confident_match(poi, grid, center_lat)
        if match == 'ambiguous':
            stats['ambiguous_skipped'] += 1
        elif match is not None:
            stats['matched_skipped'] += 1
            if normalized_identity_terms_match(poi.dedupe_name, match.dedupe_name):
                stats['normalized_identity_matched_skipped'] += 1
        else:
            imports.append(poi)
            stats['inserted'] += 1
            for poi_type in poi.poi_types:
                grid.setdefault(grid_key(poi_type, poi.lat, poi.lng, grid_lng_deg), []).append(
                    Candidate('openstreetmap', poi.osm_element_id, poi.name, poi.dedupe_name, poi.lat, poi.lng, poi_type),
                )
    stats['source_elements'] = len(seen_elements)
    return imports, dict(stats)


def possible_renames(imports: Iterable[OsmPoi], candidates: Iterable[Candidate]) -> list[PossibleRename]:
    """Report nearby, differently named source rows without excluding either.

    A name disagreement is useful human-review evidence, not an automatic
    duplicate rule. Existing confident same-name matches have already been
    removed by ``classify_scope``; this only sees new OSM candidates.
    """
    imported = list(imports)
    if not imported:
        return []
    source_candidates = [candidate for candidate in candidates if candidate.source in {'foursquare', 'community'}]
    # Keep this audit bounded for country imports. The source registry can be
    # large, but only same-type rows within the 75m matching neighborhood can
    # produce a review item.
    center_lat = imported[0].lat
    source_grid = grid_for(source_candidates, center_lat)
    grid_lng_deg = GRID_LAT_DEG / max(math.cos(math.radians(center_lat)), 0.01)
    rows: list[PossibleRename] = []
    seen: set[tuple[str, str, str, str]] = set()
    for poi in imported:
        for poi_type in poi.poi_types:
            bucket = grid_key(poi_type, poi.lat, poi.lng, grid_lng_deg)
            for dlat in (-1, 0, 1):
                for dlng in (-1, 0, 1):
                    for candidate in source_grid.get((poi_type, bucket[1] + dlat, bucket[2] + dlng), ()):
                        distance = haversine_m(poi.lat, poi.lng, candidate.lat, candidate.lng)
                        if distance > MATCH_RADIUS_METERS or name_similarity(poi.dedupe_name, candidate.dedupe_name) >= NAME_SIMILARITY_THRESHOLD:
                            continue
                        key = (poi.osm_element_id, candidate.source, candidate.source_id, candidate.poi_type)
                        if key in seen:
                            continue
                        seen.add(key)
                        rows.append(PossibleRename(
                            osm_element_id=poi.osm_element_id, osm_name=poi.name, osm_lat=poi.lat, osm_lng=poi.lng,
                            poi_type=candidate.poi_type, source=candidate.source, source_id=candidate.source_id,
                            source_name=candidate.name, source_lat=candidate.lat, source_lng=candidate.lng,
                            distance_meters=distance, severity='same_location' if distance <= 20 else 'nearby',
                        ))
    severity_rank = {'same_location': 0, 'nearby': 1}
    return sorted(rows, key=lambda row: (severity_rank[row.severity], row.distance_meters, row.osm_element_id, row.source_id))


def rename_report_json(label: str, rows: Iterable[PossibleRename]) -> str:
    """Serialize one scope's review report.

    Separate from writing it so the container can put a per-scope report in
    R2 as each municipality finishes (KAN-387) instead of accumulating a
    country-sized report in memory or on container-local disk that dies with
    the instance.
    """
    return json.dumps({'label': label, 'possible_renames': [row.as_dict() for row in rows]}, indent=2) + '\n'


def write_possible_rename_report(label: str, rows: Iterable[PossibleRename]) -> str:
    """Write a local, reviewable report for an operator dry-run; never writes D1."""
    os.makedirs(BUILD_DIR, exist_ok=True)
    path = os.path.join(BUILD_DIR, f'osm_supplement_{label}_{datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")}_possible_renames.json')
    with open(path, 'w') as output:
        output.write(rename_report_json(label, rows))
    return path


def chunks(items: list, size: int = SQL_BATCH_SIZE):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def statements_for_pois(pois: list[OsmPoi]) -> list[str]:
    """Bounded idempotent D1 writes, one complete statement per item.

    The container executes these directly (KAN-387). Returning the list is
    what lets it do so without splitting a joined blob back apart on a
    separator that also has to be legal inside the SQL it delimits.
    """
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    statements: list[str] = []
    for group in chunks(pois):
        values = ',\n'.join(
            '(' + ','.join((
                sql_quote(poi.osm_element_id), sql_quote(poi.name), sql_quote(poi.dedupe_name),
                str(poi.lat), str(poi.lng), sql_quote(encode_geohash(poi.lat, poi.lng, 7)),
                sql_quote(poi.primary_poi_type), sql_quote(poi.brand), sql_quote(poi.address),
                sql_quote(now), sql_quote(now), 'NULL', 'NULL',
            )) + ')'
            for poi in group
        )
        statements.append('''INSERT INTO osm_poi
  (osm_element_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, brand, address, imported_at, updated_at, open_min, close_min)
VALUES ''' + values + '''
ON CONFLICT(osm_element_id) DO UPDATE SET
  name = excluded.name, dedupe_name = excluded.dedupe_name, lat = excluded.lat, lng = excluded.lng,
  geohash = excluded.geohash, primary_poi_type = excluded.primary_poi_type, brand = excluded.brand,
  address = excluded.address, updated_at = excluded.updated_at;''')
        ids = ','.join(sql_quote(poi.osm_element_id) for poi in group)
        statements.append(f'DELETE FROM osm_poi_type WHERE osm_element_id IN ({ids});')
        statements.append(f'DELETE FROM osm_poi_attribute WHERE osm_element_id IN ({ids});')
        types = [(poi.osm_element_id, poi_type, rank) for poi in group for rank, poi_type in enumerate(poi.poi_types)]
        if types:
            statements.append('INSERT INTO osm_poi_type (osm_element_id, poi_type, rank) VALUES ' + ','.join(
                '(' + ','.join((sql_quote(element_id), sql_quote(poi_type), str(rank))) + ')'
                for element_id, poi_type, rank in types
            ) + ';')
        attributes = [(poi.osm_element_id, dimension, value) for poi in group for dimension, value in poi.attributes]
        if attributes:
            statements.append('INSERT INTO osm_poi_attribute (osm_element_id, dimension, value) VALUES ' + ','.join(
                '(' + ','.join((sql_quote(element_id), sql_quote(dimension), sql_quote(value))) + ')'
                for element_id, dimension, value in attributes
            ) + ';')
    return statements


def sql_for_pois(pois: list[OsmPoi]) -> str:
    """The same writes as one reviewable .sql file for an operator dry-run."""
    statements = statements_for_pois(pois)
    return '\n'.join(statements) + ('\n' if statements else '')


def import_scope(label: str, min_lat: float, max_lat: float, min_lng: float, max_lng: float, *, dry_run: bool = False, candidates: list[Candidate] | None = None, corrections: dict[tuple[str, str], SourceCorrection] | None = None, show_candidates: bool = True, write_rename_report: bool = True) -> tuple[list[OsmPoi], dict[str, int], str | None, list[PossibleRename]]:
    print(f'[{label}] querying OSM within bbox=({min_lat},{min_lng})-({max_lat},{max_lng})')
    elements = fetch_overpass(osm_query(min_lat, max_lat, min_lng, max_lng)).get('elements', [])
    corrections = corrections if corrections is not None else source_corrections()
    scope_candidates = candidates if candidates is not None else existing_candidates_in_bbox(min_lat, max_lat, min_lng, max_lng, corrections)
    imports, stats = classify_scope(elements, scope_candidates, (min_lat + max_lat) / 2, corrections)
    # Existing OSM ids are source refreshes, not new additions. The report is
    # specifically for OSM candidates that could otherwise be newly imported.
    existing_osm_ids = {candidate.source_id for candidate in scope_candidates if candidate.source == 'openstreetmap'}
    renames = possible_renames(
        (poi for poi in imports if poi.osm_element_id not in existing_osm_ids),
        scope_candidates,
    )
    stats['overpass_elements'] = len(elements)
    stats['possible_rename_same_location'] = sum(row.severity == 'same_location' for row in renames)
    stats['possible_rename_nearby'] = sum(row.severity == 'nearby' for row in renames)
    print(f'[{label}] OSM audit: ' + ', '.join(f'{key}={value}' for key, value in sorted(stats.items())))
    if show_candidates:
        for poi in imports[:50]:
            print(f'[{label}] candidate {poi.primary_poi_type}: {poi.name} ({poi.osm_element_id})')
        if len(imports) > 50:
            print(f'[{label}] ... {len(imports) - 50} more candidates')
    if write_rename_report:
        report_path = write_possible_rename_report(label, renames)
        print(f'[{label}] possible rename report: {report_path} ({len(renames)} rows)')
    if dry_run:
        return imports, stats, None, renames
    os.makedirs(BUILD_DIR, exist_ok=True)
    path = os.path.join(BUILD_DIR, f'osm_supplement_{label}_{datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")}.sql')
    with open(path, 'w') as output:
        output.write(sql_for_pois(imports))
    print(f'[{label}] wrote {path}; apply only after reviewing the dry-run')
    return imports, stats, path, renames


def import_place(place_id: str, *, dry_run: bool = False) -> tuple[list[OsmPoi], dict[str, int], str | None, list[PossibleRename]]:
    rows = run_d1_query(
        'SELECT min_lat, max_lat, min_lng, max_lng FROM place WHERE place_id = ' + sql_quote(place_id),
    )
    if not rows:
        raise ValueError(f"no place row for '{place_id}'")
    place = rows[0]
    bounds = tuple(place[key] for key in ('min_lat', 'max_lat', 'min_lng', 'max_lng'))
    if any(value is None for value in bounds):
        raise ValueError(f"place '{place_id}' has no bounded extent")
    min_lat, max_lat, min_lng, max_lng = (float(value) for value in bounds)
    return import_scope(place_id, min_lat, max_lat, min_lng, max_lng, dry_run=dry_run)


def supplement_scope(
    place_id: str, min_lat: float, max_lat: float, min_lng: float, max_lng: float,
    corrections: dict[tuple[str, str], SourceCorrection] | None = None,
) -> tuple[list[OsmPoi], dict[str, int], list[PossibleRename]]:
    """One municipality, start to finish, writing nothing (KAN-387).

    This is the unit the container claims, persists and checkpoints. It
    deliberately holds no state between scopes: candidates come from the
    scope's own neighbourhood in D1, so the previous scope's imports are
    visible because they were already written, not because they were kept
    in memory.
    """
    corrections = corrections if corrections is not None else source_corrections()
    elements = fetch_overpass(osm_query(min_lat, max_lat, min_lng, max_lng)).get('elements', [])
    candidates = existing_candidates_in_bbox(min_lat, max_lat, min_lng, max_lng, corrections)
    imports, stats = classify_scope(elements, candidates, (min_lat + max_lat) / 2, corrections)
    existing_osm_ids = {candidate.source_id for candidate in candidates if candidate.source == 'openstreetmap'}
    renames = possible_renames(
        (poi for poi in imports if poi.osm_element_id not in existing_osm_ids),
        candidates,
    )
    stats['overpass_elements'] = len(elements)
    stats['possible_rename_same_location'] = sum(row.severity == 'same_location' for row in renames)
    stats['possible_rename_nearby'] = sum(row.severity == 'nearby' for row in renames)
    print(f'[{place_id}] OSM audit: ' + ', '.join(f'{key}={value}' for key, value in sorted(stats.items())))
    return imports, stats, renames


def import_country(country_code: str, *, dry_run: bool = False) -> tuple[list[OsmPoi], dict[str, int], str | None]:
    """Audit a whole country locally, one municipality bbox at a time.

    Municipality rows are the settlement-registry layer that covers the whole
    country.  Their individual bboxes keep every Overpass request bounded;
    stable OSM ids make their edge overlap harmless.  A country without those
    registry rows is intentionally refused rather than silently importing a
    partial arbitrary set of towns.

    KAN-387: this is now the *operator dry-run* path only. Production runs go
    through the container's claim/checkpoint loop in run_job.py, because a
    single serial pass over 307 municipalities cannot finish inside one
    container and leaves nothing behind when it dies.
    """
    code = country_code.upper()
    scopes = run_d1_query('''
        SELECT place_id, min_lat, max_lat, min_lng, max_lng
        FROM place
        WHERE country_code = %s AND place_kind = 'municipality'
          AND min_lat IS NOT NULL AND max_lat IS NOT NULL AND min_lng IS NOT NULL AND max_lng IS NOT NULL
        ORDER BY place_id
    ''' % sql_quote(code))
    if not scopes:
        raise ValueError(f"country '{code}' has no bounded municipality registry; import settlement metadata first")
    corrections = source_corrections()
    imports_by_id: dict[str, OsmPoi] = {}
    renames_by_key: dict[tuple[str, str, str, str], PossibleRename] = {}
    totals: dict[str, int] = defaultdict(int)
    for index, scope in enumerate(scopes, start=1):
        label = scope['place_id']
        print(f'[{code}] scope {index}/{len(scopes)}: {label}')
        try:
            imports, stats, renames = supplement_scope(
                label, float(scope['min_lat']), float(scope['max_lat']),
                float(scope['min_lng']), float(scope['max_lng']), corrections,
            )
        except Exception as error:
            raise RuntimeError(f'OSM supplement scope {label} failed: {error}') from error
        for key, value in stats.items():
            totals[key] += value
        # Deduplicating on the element id is what keeps overlapping bboxes
        # honest in a dry-run, where nothing has been written to D1 yet and
        # the next scope's candidate query therefore cannot see these.
        for poi in imports:
            imports_by_id[poi.osm_element_id] = poi
        for row in renames:
            renames_by_key[(row.osm_element_id, row.source, row.source_id, row.poi_type)] = row
    imports = [imports_by_id[element_id] for element_id in sorted(imports_by_id)]
    totals['scopes'] = len(scopes)
    totals['unique_rows_to_write'] = len(imports)
    totals['possible_rename_same_location'] = sum(row.severity == 'same_location' for row in renames_by_key.values())
    totals['possible_rename_nearby'] = sum(row.severity == 'nearby' for row in renames_by_key.values())
    print(f'[{code}] country OSM audit: ' + ', '.join(f'{key}={value}' for key, value in sorted(totals.items())))
    report_path = write_possible_rename_report(code, renames_by_key.values())
    print(f'[{code}] possible rename report: {report_path} ({len(renames_by_key)} rows)')
    if dry_run:
        return imports, dict(totals), None
    os.makedirs(BUILD_DIR, exist_ok=True)
    path = os.path.join(BUILD_DIR, f'osm_supplement_{code}_{datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")}.sql')
    with open(path, 'w') as output:
        output.write(sql_for_pois(imports))
    print(f'[{code}] wrote {path}; apply only after reviewing the dry-run')
    return imports, dict(totals), path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--place', help='bounded Place identity, e.g. osm-relation-123')
    target.add_argument('--bbox', nargs=4, type=float, metavar=('MIN_LAT', 'MAX_LAT', 'MIN_LNG', 'MAX_LNG'))
    target.add_argument('--country', help='ISO country code; processes each bounded municipality scope')
    parser.add_argument('--dry-run', action='store_true', help='read OSM/D1 and print candidates without writing SQL')
    args = parser.parse_args()
    if args.place:
        import_place(args.place, dry_run=args.dry_run)
    elif args.country:
        import_country(args.country, dry_run=args.dry_run)
    else:
        min_lat, max_lat, min_lng, max_lng = args.bbox
        import_scope('bbox', min_lat, max_lat, min_lng, max_lng, dry_run=args.dry_run)


if __name__ == '__main__':
    main()
