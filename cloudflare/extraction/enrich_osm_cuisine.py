"""
KAN-340 (priority-1 source, the part deferred past the name-keyword fallback
that already landed): OSM cuisine=/shop= tag enrichment for restaurant/store
rows Foursquare left with no subtype at all — not rows Foursquare tagged but
we weren't querying for (that's KAN-334), and not rows a keyword in the
place's own name already recovered (that's the first half of this ticket,
already shipped). This is specifically for places like "Miya Sushi & Ramen"
if its name hadn't happened to contain "sushi" — Foursquare's row has
nothing to classify from at all, so the only way to recover it is a second,
independent data source: OpenStreetMap.

One-time bulk backfill per Place, not live per-user (same reasoning as the
rest of this pipeline) — matches OSM elements (by name + proximity) against
`poi` rows already loaded by classify_and_load.py that still have no
food_cuisine/store_kind poi_attribute row after BOTH the category-tag and
keyword-fallback passes, and writes new poi_attribute rows for confident
matches, tagged with the Place's CURRENT build_id (read live from D1) so
they survive that build's sweep-delete cycle. Must be re-run after every
future Foursquare re-extraction for the same Place, or this enrichment is
lost when that build's sweep retires the previous build's poi_attribute
rows — same requirement documented for the keyword pass, just run as a
separate step here instead of inline, since Overpass is a slow, flaky,
retryable external call (~40-60% single-attempt failure rate per KAN-322)
that doesn't belong in the fast synchronous Foursquare pipeline.

KAN-355 note: this script queries `place`/`place_id` (min/max lat/lng), not
the pre-rename `city`/`city_id` (center/radius) — updated 2026-08-06, was
broken (still targeting the old schema) until then; nothing had run it
since the rename.

Usage: python3 enrich_osm_cuisine.py <place_id>
Uses wrangler's own ambient auth (same login `wrangler d1 execute` already
uses elsewhere in this pipeline) — no separate token env vars required.
"""
import json, math, os, subprocess, sys, time, urllib.request, urllib.error, urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from classify_and_load import normalize_text, sql_escape, CLOUDFLARE_DIR, BUILD_DIR

# Mirrors src/services/osmPlaces.ts's endpoint-fallback list — the canonical
# Overpass instance is volunteer-run and genuinely flaky under load.
OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
]
USER_AGENT = 'BrushPoiBackend-Enrichment/1.0 (one-time batch backfill)'
OVERPASS_TIMEOUT_S = 90
MATCH_RADIUS_METERS = 75  # confident-match proximity threshold — tight enough to avoid matching the wrong nearby business with a similar name

# OSM's cuisine= tag vocabulary doesn't map 1:1 onto ours — only mapping
# values with a clear, unambiguous correspondence to one of our 10 existing
# food_cuisine keys (cloudflare/src/foodSubtypeCategories.json). An OSM
# cuisine tag with no entry here is skipped, never guessed.
OSM_CUISINE_TO_FOOD_CUISINE = {
    'portuguese': 'portuguese', 'regional_portuguese': 'portuguese',
    'italian': 'italian', 'pizza': 'italian',
    'sushi': 'sushi',
    'burger': 'burger',
    'indian': 'indian',
    'thai': 'thai',
    'mexican': 'mexican',
    'steak_house': 'steak', 'steak': 'steak',
    'vegetarian': 'vegetarian', 'vegan': 'vegetarian',
}

# OSM's shop= tag vocabulary mapped to our 14 store_kind keys
# (cloudflare/src/storeSubtypeCategories.json), excluding 'any' (generic,
# never a real subtype — see build_reverse_map's own 'any' exclusion).
OSM_SHOP_TO_STORE_KIND = {
    'clothes': 'clothing', 'boutique': 'clothing',
    'shoes': 'shoes',
    'electronics': 'electronics', 'computer': 'electronics', 'mobile_phone': 'electronics',
    'furniture': 'furniture',
    'hardware': 'hardware', 'doityourself': 'hardware',
    'jewelry': 'jewelry',
    'toys': 'toys',
    'sports': 'sports',
    'houseware': 'home', 'interior_decoration': 'home',
    'books': 'books',
    'bicycle': 'bicycle',
    'pet': 'pet',
    'beauty': 'beauty', 'cosmetics': 'beauty', 'hairdresser_supply': 'beauty',
}


def run_d1_query(sql):
    """Read-only D1 query via wrangler, matching this pipeline's existing
    shell-out convention (writes are always a printed command for the
    operator to run deliberately, per the existing manual-pipeline pattern —
    but a SELECT has no side effects, so shelling out directly here is lower
    risk and much more convenient than round-tripping through a saved file)."""
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'brush-poi-registry', '--remote', '--command', sql, '--json'],
        cwd=CLOUDFLARE_DIR, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)[0]['results']


def fetch_overpass(query):
    """Same endpoint-fallback + explicit UA convention as osmPlaces.ts's
    fetchOverpass — tries each endpoint in turn, returns the first success."""
    last_error = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(2):  # one retry per endpoint — ~40-60% single-attempt failure rate per KAN-322
            try:
                req = urllib.request.Request(
                    endpoint,
                    data=f"data={urllib.parse.quote(query)}".encode('utf-8'),
                    headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT},
                    method='POST',
                )
                with urllib.request.urlopen(req, timeout=OVERPASS_TIMEOUT_S) as resp:
                    return json.loads(resp.read())
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as e:
                last_error = e
                time.sleep(2)
    raise RuntimeError(f"all Overpass endpoints failed: {last_error}")


def first_mapped_cuisine(cuisine_tag):
    """OSM's cuisine= value can be semicolon-separated (e.g. "italian;pizza")
    — checking only the first token missed a mappable value whenever it
    happened to come second. Returns the first token (in the tag's own
    order) that has an entry in OSM_CUISINE_TO_FOOD_CUISINE, or None."""
    for token in cuisine_tag.split(';'):
        value = OSM_CUISINE_TO_FOOD_CUISINE.get(token.strip().lower())
        if value:
            return value
    return None


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def enrich(place_id):
    print(f"[{place_id}] fetching Place bounds + current build_id from D1...")
    place_rows = run_d1_query(f"SELECT min_lat, max_lat, min_lng, max_lng, build_id FROM place WHERE place_id = {sql_escape(place_id)};")
    if not place_rows:
        raise ValueError(f"no place row for '{place_id}'")
    place = place_rows[0]
    build_id = place['build_id']
    if not build_id:
        raise ValueError(f"place '{place_id}' has no build_id — run the regular extraction pipeline first")
    min_lat, max_lat, min_lng, max_lng = place['min_lat'], place['max_lat'], place['min_lng'], place['max_lng']
    if min_lat is None:
        raise ValueError(f"place '{place_id}' has no ingested extent yet — run the regular extraction pipeline first")
    print(f"[{place_id}] bbox=({min_lat},{min_lng})-({max_lat},{max_lng}) build_id={build_id}")

    print(f"[{place_id}] fetching restaurant/store rows still missing a subtype after category-tag + keyword matching...")
    restaurant_candidates = run_d1_query(f"""
        SELECT fsq_place_id, name, lat, lng FROM poi p
        WHERE p.place_id = {sql_escape(place_id)} AND p.primary_poi_type = 'restaurant'
        AND NOT EXISTS (SELECT 1 FROM poi_attribute a WHERE a.place_id = p.place_id AND a.fsq_place_id = p.fsq_place_id AND a.dimension = 'food_cuisine');
    """)
    store_candidates = run_d1_query(f"""
        SELECT fsq_place_id, name, lat, lng FROM poi p
        WHERE p.place_id = {sql_escape(place_id)} AND p.primary_poi_type = 'store'
        AND NOT EXISTS (SELECT 1 FROM poi_attribute a WHERE a.place_id = p.place_id AND a.fsq_place_id = p.fsq_place_id AND a.dimension = 'store_kind');
    """)
    print(f"[{place_id}] {len(restaurant_candidates)} restaurant + {len(store_candidates)} store candidates")

    print(f"[{place_id}] querying Overpass (cuisine-tagged restaurants + tagged shops)...")
    # bbox filter (south,west,north,east) directly from the Place's own
    # ingested extent — no lossy center+radius round-trip needed now that
    # KAN-355 stores the real bbox.
    query = (
        f"[out:json][timeout:{OVERPASS_TIMEOUT_S - 10}];"
        f'(nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub)$"]["cuisine"]({min_lat},{min_lng},{max_lat},{max_lng});'
        f'nwr["shop"]({min_lat},{min_lng},{max_lat},{max_lng}););'
        "out center;"
    )
    data = fetch_overpass(query)
    elements = data.get('elements', [])
    print(f"[{place_id}] Overpass returned {len(elements)} elements")

    # Index candidates by normalized name for fast lookup — proximity is
    # checked per-candidate-match, not per-full-scan, since name collisions
    # across an entire city are rare and this keeps the match loop cheap.
    def index_by_name(candidates):
        index = {}
        for c in candidates:
            key = normalize_text(c['name'])
            if key:
                index.setdefault(key, []).append(c)
        return index

    restaurant_index = index_by_name(restaurant_candidates)
    store_index = index_by_name(store_candidates)

    matched_rows = []  # (fsq_place_id, dimension, value)
    matched_place_ids = set()  # a place already matched by an earlier OSM element shouldn't match a second one under a different dimension by accident
    cuisine_matches = 0
    store_kind_matches = 0
    ambiguous_skipped = 0

    def closest_unambiguous_candidate(index, normalized_name, lat, lng):
        """All unassigned same-normalized-name candidates within
        MATCH_RADIUS_METERS, picking the strictly closest one — but only
        when it's unambiguously closest (no other eligible candidate at the
        same distance). Two candidates at an identical distance means we
        can't tell which business the OSM element actually refers to, so
        neither gets guessed at; returns None for that case too."""
        eligible = []
        for candidate in index.get(normalized_name, []):
            if candidate['fsq_place_id'] in matched_place_ids:
                continue
            dist = haversine_m(lat, lng, candidate['lat'], candidate['lng'])
            if dist <= MATCH_RADIUS_METERS:
                eligible.append((dist, candidate))
        if not eligible:
            return None
        eligible.sort(key=lambda pair: pair[0])
        if len(eligible) > 1 and eligible[0][0] == eligible[1][0]:
            return 'ambiguous'
        return eligible[0][1]

    for el in elements:
        tags = el.get('tags') or {}
        name = tags.get('name')
        if not name:
            continue
        lat = el.get('lat') or (el.get('center') or {}).get('lat')
        lng = el.get('lon') or (el.get('center') or {}).get('lon')
        if lat is None or lng is None:
            continue
        normalized_name = normalize_text(name)
        if not normalized_name:
            continue

        cuisine_tag = tags.get('cuisine')
        if cuisine_tag:
            value = first_mapped_cuisine(cuisine_tag)
            if value:
                candidate = closest_unambiguous_candidate(restaurant_index, normalized_name, lat, lng)
                if candidate == 'ambiguous':
                    ambiguous_skipped += 1
                elif candidate:
                    matched_rows.append((candidate['fsq_place_id'], 'food_cuisine', value))
                    matched_place_ids.add(candidate['fsq_place_id'])
                    cuisine_matches += 1

        shop_tag = tags.get('shop')
        if shop_tag:
            value = OSM_SHOP_TO_STORE_KIND.get(shop_tag.strip().lower())
            if value:
                candidate = closest_unambiguous_candidate(store_index, normalized_name, lat, lng)
                if candidate == 'ambiguous':
                    ambiguous_skipped += 1
                elif candidate:
                    matched_rows.append((candidate['fsq_place_id'], 'store_kind', value))
                    matched_place_ids.add(candidate['fsq_place_id'])
                    store_kind_matches += 1

    print(f"[{place_id}] matched {cuisine_matches} food_cuisine + {store_kind_matches} store_kind rows from OSM ({ambiguous_skipped} skipped as ambiguous — multiple same-named candidates equidistant)")

    if not matched_rows:
        print(f"[{place_id}] nothing to write, done")
        return

    out_path = os.path.join(BUILD_DIR, f'osm_enrich_{place_id}_{build_id}.sql')
    # This script writes a file for the operator to apply later, by hand —
    # an arbitrary time gap in which a regular classify_and_load.py run for
    # the same city could produce a NEW build_id, making these rows stale
    # the moment they'd be written (attached to a build_id that's no longer
    # current, and due to be swept by the next re-run after that). Each
    # INSERT is guarded with a build-drift check: it only writes if
    # city.current_build_id still equals the build_id captured at the start
    # of this run, otherwise it's a silent no-op for that statement rather
    # than corrupting data under a stale build_id.
    guard = f"WHERE EXISTS (SELECT 1 FROM place WHERE place_id = {sql_escape(place_id)} AND build_id = {sql_escape(build_id)})"
    insert_prefix = 'INSERT OR REPLACE INTO poi_attribute (fsq_place_id, place_id, build_id, dimension, value) SELECT * FROM (VALUES '
    with open(out_path, 'w') as f:
        batches = 0
        chunk = []
        chunk_size = 0
        MAX_CHUNK_BYTES = 80_000
        for fsq_place_id, dimension, value in matched_rows:
            piece = '(' + ','.join([sql_escape(fsq_place_id), sql_escape(place_id), sql_escape(build_id), sql_escape(dimension), sql_escape(value)]) + ')'
            piece_bytes = len(piece.encode('utf-8')) + 1
            if chunk and chunk_size + piece_bytes > MAX_CHUNK_BYTES:
                f.write(insert_prefix + ','.join(chunk) + ') ' + guard + ';\n')
                batches += 1
                chunk = []
                chunk_size = 0
            chunk.append(piece)
            chunk_size += piece_bytes
        if chunk:
            f.write(insert_prefix + ','.join(chunk) + ') ' + guard + ';\n')
            batches += 1
    print(f"[{place_id}] wrote {out_path} ({batches} statements, each guarded against build drift)")
    print(f"[{place_id}] apply with:")
    print(f"  npx wrangler d1 execute brush-poi-registry --remote --file={out_path}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("usage: python3 enrich_osm_cuisine.py <place_id>")
        sys.exit(1)
    enrich(sys.argv[1])
