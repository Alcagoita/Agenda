"""
Classifies raw Foursquare OS Places extract rows into Brush's poi_type(s)
(+ poi_attribute dimension/value pairs + brand), computes each row's
geohash, and emits a batched SQL file ready for `wrangler d1 execute
--file`: a build_log start row, the poi INSERT statements, the poi_type
INSERT statements (KAN-335 — a place can match more than one type), the
poi_attribute INSERT statements (KAN-336 — a place can match more than one
subtype per dimension), and a sweep DELETE that retires anything from a
previous build that didn't reappear (closed places).

Reimplements the same geohash algorithm as cloudflare/src/geohash.ts in
Python — the Worker and this script must agree on precision/encoding or
radius queries silently miss rows.
"""
import csv, json, sqlite3, sys, datetime, os, re, unicodedata, uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from opening_hours import hours_for_category_label  # KAN-318: default open/close per category

BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'
CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(CLOUDFLARE_DIR)
BUILD_DIR = os.path.join(CLOUDFLARE_DIR, 'build')
PIPELINE_VERSION = 'v2-phase5'

def normalize_text(s):
    """Same rules as src/services/poiInference.ts's normalize(): lowercase,
    strip accents, collapse everything non-alphanumeric to single spaces.
    Kept in sync deliberately — brand matching here must agree with how the
    app itself normalizes text, or a brand that matches client-side could
    silently fail to match at load time (or vice versa)."""
    s = s.lower()
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = re.sub(r'[^a-z0-9\s]', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()

def load_brand_dictionary():
    # One canonical app/import/API catalogue. Every item has a persisted
    # `name` and source/title aliases that must resolve to that same value.
    return load_mapping(os.path.join(REPO_ROOT, 'src', 'constants', 'brandDictionary.json'))

def find_brand(name, ranked_types, brand_dictionary):
    """First brand match, in the same priority order as primary_poi_type
    (ranked_types), then by the brand list's own declared order. Word-
    boundary substring match (padded with spaces) so 'Delta' doesn't match
    inside an unrelated longer word, while multi-word brands like 'Costa
    Coffee' still match as a phrase."""
    normalized_name = normalize_text(name)
    if not normalized_name:
        return None
    padded_name = f' {normalized_name} '
    for t in ranked_types:
        for brand in brand_dictionary.get(t, []):
            canonical_name = brand['name']
            for candidate in [canonical_name, *brand.get('aliases', [])]:
                normalized_brand = normalize_text(candidate)
                if normalized_brand and f' {normalized_brand} ' in padded_name:
                    return canonical_name
    return None


def is_explicit_atm_name(name, name_rules):
    """True only when the source title identifies the POI itself as an ATM.

    Foursquare often tags a real bank branch with both Bank and ATM because it
    has a cash machine on-site. That category overlap must remain searchable
    as a Bank. This rule deliberately relies on the POI's own title instead:
    e.g. "Multibanco CGD" and "ATM - Montepio" are ATM-only locations.
    """
    normalized_name = normalize_text(name)
    padded_name = f' {normalized_name} '
    for alias in name_rules.get('atm', []):
        normalized_alias = normalize_text(alias)
        if normalized_alias == 'mb':
            if normalized_name == normalized_alias:  # Portuguese Multibanco label.
                return True
        elif normalized_alias and f' {normalized_alias} ' in padded_name:
            return True
    return False

def load_financial_service_name_rules():
    """Curated provider/title rules for Foursquare's incorrectly Bank-tagged
    exchange and transfer locations. These classify source data, not task text."""
    return load_mapping(os.path.join(CLOUDFLARE_DIR, 'src', 'financialServiceNameRules.json'))

def financial_service_classification(name, cat_ids, name_rules):
    """Return (primary type, optional subtype) only for an explicit source signal.

    Currency Exchange has its own Foursquare category. Transfer providers are
    often Bank-only rows, so a small title allowlist is the reliable fallback.
    Other financial businesses use a source-only type with a name-verified
    ``financial_service_kind`` attribute; none are task-selectable POI types.
    """
    if '5744ccdfe4b0c0459246b4be' in cat_ids:
        return ('currency_exchange', None)
    padded_name = f' {normalize_text(name)} '
    for service_type in ('money_transfer', 'currency_exchange'):
        for alias in name_rules.get(service_type, []):
            normalized_alias = normalize_text(alias)
            if normalized_alias and f' {normalized_alias} ' in padded_name:
                return (service_type, None)
    for kind, aliases in name_rules.get('financial_service', {}).items():
        for alias in aliases:
            normalized_alias = normalize_text(alias)
            if normalized_alias and f' {normalized_alias} ' in padded_name:
                return ('financial_service', kind)
    return (None, None)

def load_keyword_dictionary(filename):
    # KAN-340: reuses the app's existing keyword-inference dictionaries
    # (used elsewhere for task-title inference) rather than building a
    # third, parallel keyword list.
    return load_mapping(os.path.join(REPO_ROOT, 'src', 'constants', filename))

def build_alias_index(dictionary, exclude_keys=()):
    """{key: [normalized aliases]} — 'any' is excluded for store_kind, same
    reasoning as store_reverse in build_reverse_map: it's a generic catch-all,
    not a real subtype, and would win every match if left in."""
    index = {}
    for key, entry in dictionary.items():
        if key in exclude_keys:
            continue
        normalized = [normalize_text(a) for a in entry.get('aliases', [])]
        index[key] = [a for a in normalized if a]
    return index

def match_keyword_subtypes(name, alias_index):
    """Every dimension value whose alias appears in the name as a whole
    word/phrase — not just the first match (KAN-340 follows the same
    multi-value reasoning as KAN-334/336's category-tag matching: a place
    literally named e.g. "Sushi Vegetariano" should get both, not just one).
    Only called when category-tag matching already found nothing for this
    dimension, so there's no existing match to compete with or override."""
    normalized_name = normalize_text(name)
    if not normalized_name:
        return set()
    padded_name = f' {normalized_name} '
    matched = set()
    for key, aliases in alias_index.items():
        for alias in aliases:
            if f' {alias} ' in padded_name:
                matched.add(key)
                break
    return matched

def encode_geohash(lat, lng, precision=7):
    lat_min, lat_max = -90.0, 90.0
    lng_min, lng_max = -180.0, 180.0
    geohash = []
    bit = 0
    ch = 0
    even_bit = True
    while len(geohash) < precision:
        if even_bit:
            mid = (lng_min + lng_max) / 2
            if lng >= mid:
                ch |= (1 << (4 - bit)); lng_min = mid
            else:
                lng_max = mid
        else:
            mid = (lat_min + lat_max) / 2
            if lat >= mid:
                ch |= (1 << (4 - bit)); lat_min = mid
            else:
                lat_max = mid
        even_bit = not even_bit
        if bit < 4:
            bit += 1
        else:
            geohash.append(BASE32[ch]); bit = 0; ch = 0
    return ''.join(geohash)

def sql_escape(s):
    if s is None:
        return 'NULL'
    return "'" + s.replace("'", "''") + "'"

def byte_len(s):
    # D1's statement-size cap is bytes, not characters — Portuguese names
    # have accented characters that are multi-byte in UTF-8 (ç, ã, é, ...),
    # so len() alone undercounts real payload size.
    return len(s.encode('utf-8'))

def load_mapping(path):
    with open(path) as source:
        return json.load(source)

def build_reverse_map(mapping):
    """Warns on category_id collisions instead of silently letting the last
    key win — two PoiTypes sharing an id (e.g. fitness_center/gym, hotel/
    lodging both map to Foursquare's single "Gym and Studio"/"Hotel" leaf)
    means the loser never gets classified at all. Known collisions are
    resolved via TYPE_MERGE_INCLUDES in cloudflare/src/index.ts, not here —
    this warning exists so a *new*, unhandled collision doesn't go unnoticed."""
    reverse = {}
    for k, v in mapping.items():
        cid = v.get('category_id')
        # Some useful app types have no reliable Foursquare category. They are
        # classified by explicit title rules, without widening the extract.
        if not cid:
            continue
        if cid in reverse:
            print(f"WARNING: category_id {cid} claimed by both '{reverse[cid]}' and '{k}' — "
                  f"'{k}' wins classification, '{reverse[cid]}' gets zero rows unless merged "
                  f"via TYPE_MERGE_INCLUDES in cloudflare/src/index.ts")
        reverse[cid] = k
    return reverse

MAX_STATEMENT_BYTES = 80_000
# SQLite's default SQLITE_MAX_COMPOUND_SELECT is 500. Keep below it so a
# short child-row SELECT cannot bypass the byte cap and still fail in D1.
MAX_CHILD_SELECT_TERMS = 400

def write_batches(f, insert_prefix, pieces, label, place_id, statement_suffix=''):
    """Size-aware batching, not a fixed row count — shared by both the poi
    and poi_type INSERT statements. D1's confirmed hard limits are 100KB per
    statement and 100 bound parameters per query (this pipeline inlines
    values as literals, not bound params, so the byte-size cap is the one
    that matters here); flushes at ~80KB per statement, well under the
    100KB hard cap. Returns the number of statements written."""
    batches_written = 0
    values: list[str] = []
    size = byte_len(insert_prefix) + byte_len(statement_suffix) + byte_len(';\n')

    def flush():
        nonlocal values, size, batches_written
        if not values:
            return
        f.write(insert_prefix + ','.join(values) + statement_suffix + ';\n')
        batches_written += 1
        values = []
        size = byte_len(insert_prefix) + byte_len(statement_suffix) + byte_len(';\n')

    for identifier, piece in pieces:
        piece_size = byte_len(piece) + 1  # +1 for the joining comma
        # A single row that can't fit even alone in a fresh statement would
        # otherwise be silently appended anyway — not caught here, not
        # caught until the actual D1 execute fails later with a confusing
        # native error instead of a clear one now.
        solo_size = byte_len(insert_prefix) + byte_len(piece) + byte_len(statement_suffix) + byte_len(';\n')
        if solo_size > MAX_STATEMENT_BYTES:
            raise ValueError(
                f"[{place_id}] {label} row {identifier} is {solo_size} bytes alone, "
                f"exceeds MAX_STATEMENT_BYTES ({MAX_STATEMENT_BYTES}) even in its own statement"
            )
        if values and size + piece_size > MAX_STATEMENT_BYTES:
            flush()
        values.append(piece)
        size += piece_size
    flush()
    return batches_written

def write_guarded_child_batches(f, table, columns, pieces, label, place_id):
    """Write child rows resolved to the canonical parent by each inner
    SELECT. The source SELECT emits no row when the parent did not survive
    canonical deduplication, so no extra existence lookup is necessary."""
    prefix = f'INSERT OR IGNORE INTO {table} ({columns}) SELECT * FROM ('
    suffix = ') AS incoming'
    batches_written = 0
    selects: list[str] = []
    size = byte_len(prefix) + byte_len(suffix) + byte_len(';\n')
    term_count = 0

    def flush():
        nonlocal selects, size, term_count, batches_written
        if not selects:
            return
        f.write(prefix + ' UNION ALL '.join(selects) + suffix + ';\n')
        batches_written += 1
        selects = []
        size = byte_len(prefix) + byte_len(suffix) + byte_len(';\n')
        term_count = 0

    for identifier, select in pieces:
        select_size = byte_len(select) + byte_len(' UNION ALL ')
        solo_size = byte_len(prefix) + byte_len(select) + byte_len(suffix) + byte_len(';\n')
        if solo_size > MAX_STATEMENT_BYTES:
            raise ValueError(
                f"[{place_id}] {label} row {identifier} is {solo_size} bytes alone, "
                f"exceeds MAX_STATEMENT_BYTES ({MAX_STATEMENT_BYTES}) even in its own statement"
            )
        if selects and (size + select_size > MAX_STATEMENT_BYTES or term_count + 1 > MAX_CHILD_SELECT_TERMS):
            flush()
        selects.append(select)
        size += select_size
        term_count += 1
    flush()
    return batches_written

def write_sqlite_export(place_id, build_id, pipeline_version, poi_rows, poi_type_rows, poi_attribute_rows, out_sqlite_path):
    """KAN-339: client-download export — a single city+build's poi/poi_type/
    poi_attribute rows flattened into a standalone SQLite file (no place_id/
    build_id columns needed per-row, both are implied by the whole file, and
    are instead recorded once in _export_meta so the client can compare its
    cached build_id against /coverage's current one before deciding whether
    to re-download). Reads straight from the same in-memory rows already
    classified above, not a second D1 round-trip — guarantees the D1 load
    and this export can never disagree with each other."""
    if os.path.exists(out_sqlite_path):
        os.remove(out_sqlite_path)
    conn = sqlite3.connect(out_sqlite_path)
    conn.executescript("""
        CREATE TABLE poi (
          fsq_place_id     TEXT PRIMARY KEY,
          name             TEXT NOT NULL,
          lat              REAL NOT NULL,
          lng              REAL NOT NULL,
          primary_poi_type TEXT NOT NULL,
          brand            TEXT,
          category_label   TEXT,
          address          TEXT
        );
        CREATE TABLE poi_type (
          fsq_place_id TEXT NOT NULL,
          poi_type     TEXT NOT NULL,
          rank         INTEGER NOT NULL,
          PRIMARY KEY (fsq_place_id, poi_type)
        );
        CREATE TABLE poi_attribute (
          fsq_place_id TEXT NOT NULL,
          dimension    TEXT NOT NULL,
          value        TEXT NOT NULL,
          PRIMARY KEY (fsq_place_id, dimension, value)
        );
        CREATE INDEX idx_poi_type_lookup ON poi_type (poi_type);
        CREATE TABLE _export_meta (
          place_id          TEXT NOT NULL,
          build_id         TEXT NOT NULL,
          generated_at     TEXT NOT NULL,
          pipeline_version TEXT NOT NULL,
          row_count        INTEGER NOT NULL
        );
    """)
    # r[0]=fsq_place_id, r[3]=name, r[4]=lat, r[5]=lng, r[7]=primary_poi_type,
    # r[8]=brand, r[9]=category_label, r[12]=address — see the poi_rows.append
    # call above for the full tuple shape.
    conn.executemany(
        'INSERT INTO poi (fsq_place_id, name, lat, lng, primary_poi_type, brand, category_label, address) VALUES (?,?,?,?,?,?,?,?)',
        [(r[0], r[3], r[4], r[5], r[7], r[8], r[9], r[12]) for r in poi_rows],
    )
    conn.executemany(
        'INSERT OR IGNORE INTO poi_type (fsq_place_id, poi_type, rank) VALUES (?,?,?)',
        [(r[0], r[3], r[4]) for r in poi_type_rows],
    )
    conn.executemany(
        'INSERT OR IGNORE INTO poi_attribute (fsq_place_id, dimension, value) VALUES (?,?,?)',
        [(r[0], r[3], r[4]) for r in poi_attribute_rows],
    )
    conn.execute(
        'INSERT INTO _export_meta (place_id, build_id, generated_at, pipeline_version, row_count) VALUES (?,?,?,?,?)',
        (place_id, build_id, datetime.datetime.now(datetime.timezone.utc).isoformat(), pipeline_version, len(poi_rows)),
    )
    conn.commit()
    conn.close()

def classify(place_id, csv_path, out_sql_path):
    poi_types = load_mapping(os.path.join(CLOUDFLARE_DIR, 'src', 'poiTypeCategories.json'))
    store_subtypes = load_mapping(os.path.join(CLOUDFLARE_DIR, 'src', 'storeSubtypeCategories.json'))
    food_subtypes = load_mapping(os.path.join(CLOUDFLARE_DIR, 'src', 'foodSubtypeCategories.json'))

    poi_reverse = build_reverse_map(poi_types)
    # 'any' maps to the same generic "Retail" category id that poi_type=='store'
    # itself is keyed on — every store row's tag array necessarily contains it
    # (that's *why* it's classified as store), so 'any' must never compete in
    # the subtype scan or it always wins before a real specific subtype (e.g.
    # Bookstore) further down the same row's tag array ever gets checked.
    store_reverse = {v['category_id']: k for k, v in store_subtypes.items() if k != 'any'}
    food_reverse = build_reverse_map(food_subtypes)
    brand_dictionary = load_brand_dictionary()
    financial_service_rules = load_financial_service_name_rules()

    # KAN-340: Foursquare frequently tags a place as the generic 'restaurant'
    # or 'store' with no specific cuisine/kind category id at all — no
    # amount of extraction-filter widening recovers that, since the data
    # simply isn't in Foursquare's row (confirmed: "Miya Sushi & Ramen"
    # carries only the generic "Restaurant" tag). Fallback: match the
    # place's own name against the app's existing keyword dictionaries —
    # only when category-tag matching (above) already found nothing for
    # that dimension, never overriding a real category-tag match.
    store_kind_aliases = build_alias_index(load_keyword_dictionary('storeSubtypeDictionary.json'), exclude_keys={'any'})
    food_cuisine_aliases = build_alias_index(load_keyword_dictionary('restaurantFoodDictionary.json'))

    # KAN-335: explicit, deterministic priority for choosing primary_poi_type
    # among a place's multiple matched types — declaration order in
    # poiTypeCategories.json, NOT Foursquare's own per-row category array
    # order (which is inconsistent across rows, so the same real-world
    # category combo could otherwise pick a different "primary" type
    # depending on how Foursquare happened to order that specific row).
    type_priority = {k: i for i, k in enumerate(poi_types.keys())}

    build_id = str(uuid.uuid4())
    brand_matches = 0
    keyword_store_kind_matches = 0
    keyword_food_cuisine_matches = 0
    # Printed immediately, not just on success — if this crashes partway
    # through (bad row, D1 load failure, etc.), this is the only place the
    # build_id is visible at all, and it's needed to close out build_log as
    # 'failed' via POST /internal/build-complete {cityId, buildId,
    # status:'failed'} instead of leaving that row stuck at 'building' forever.
    print(f"[{place_id}] build_id={build_id} (starting)")
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    poi_rows = []
    poi_type_rows = []
    poi_attribute_rows = []
    type_counts = {}
    skipped_no_type = 0
    multi_type_count = 0
    deduplicated = 0
    seen_identities = {}

    with open(csv_path) as f:
        for row in csv.DictReader(f):
            raw_category_ids = row['category_ids'] or ''
            raw_category_labels = row['category_labels'] or ''
            cat_ids = [c for c in raw_category_ids.split('|') if c]

            # Every main type any category id matches — not just the first
            # (KAN-335: a place tagged both Bakery and Café should match
            # searches for either, not silently drop one).
            matched_types = {poi_reverse[cid] for cid in cat_ids if cid in poi_reverse}

            # KAN-334: also add 'store'/'restaurant' if a subtype-only id
            # matches, independent of whether a main type already matched —
            # the extraction filter pulls in rows tagged ONLY with a
            # specific subtype leaf (e.g. "Bookstore"), no generic parent
            # tag, which poi_reverse alone would never recognize.
            #
            # KAN-336: every matching subtype id, not just the first — a
            # restaurant tagged both "Italian" and "Vegetarian" should carry
            # both, not silently drop one to whichever tag Foursquare happened
            # to list first (same reasoning as the poi_type multiplicity fix).
            store_kinds = set()
            for cid in cat_ids:
                if cid in store_reverse:
                    matched_types.add('store')
                    store_kinds.add(store_reverse[cid])

            food_cuisines = set()
            for cid in cat_ids:
                if cid in food_reverse:
                    matched_types.add('restaurant')
                    food_cuisines.add(food_reverse[cid])

            # A named ATM is not a Bank search result. Keep genuine branches
            # that merely carry both Foursquare categories intact; only the
            # explicit title markers override Foursquare's Bank-only tagging.
            if is_explicit_atm_name(row['name'], financial_service_rules):
                matched_types.discard('bank')
                matched_types.add('atm')

            service_type, financial_service_kind = financial_service_classification(
                row['name'], cat_ids, financial_service_rules,
            )
            if service_type:
                matched_types.discard('bank')
                matched_types.add(service_type)

            # KAN-340 keyword fallback — only for dimensions category-tag
            # matching left empty, and only for rows already classified as
            # store/restaurant by real Foursquare category tags (never
            # invents a store_kind/food_cuisine attribute on a place that
            # isn't even tagged as a store/restaurant to begin with).
            keyword_store_kind_match = False
            if 'store' in matched_types and not store_kinds:
                store_kinds = match_keyword_subtypes(row['name'], store_kind_aliases)
                if store_kinds:
                    keyword_store_kind_match = True
            keyword_food_cuisine_match = False
            if 'restaurant' in matched_types and not food_cuisines:
                food_cuisines = match_keyword_subtypes(row['name'], food_cuisine_aliases)
                if food_cuisines:
                    keyword_food_cuisine_match = True

            if not matched_types:
                skipped_no_type += 1
                continue

            ranked_types = sorted(matched_types, key=lambda t: type_priority.get(t, len(type_priority)))
            primary_poi_type = ranked_types[0]
            if len(ranked_types) > 1:
                multi_type_count += 1

            lat = float(row['latitude'])
            lng = float(row['longitude'])
            geohash = encode_geohash(lat, lng, 7)
            category_label = raw_category_labels.split('|')[0]
            dedupe_name = normalize_text(row['name']) or row['name'].strip().lower()
            identity = (dedupe_name, lat, lng)
            if identity in seen_identities:
                # The first row is the deterministic canonical source record
                # for this load. The D1 unique index applies the same rule
                # across earlier and later loads.
                deduplicated += 1
                canonical_fsq_place_id = seen_identities[identity]
                for rank, t in enumerate(ranked_types):
                    poi_type_rows.append((canonical_fsq_place_id, place_id, build_id, t, rank, dedupe_name, lat, lng))
                for value in sorted(store_kinds):
                    poi_attribute_rows.append((canonical_fsq_place_id, place_id, build_id, 'store_kind', value, dedupe_name, lat, lng))
                for value in sorted(food_cuisines):
                    poi_attribute_rows.append((canonical_fsq_place_id, place_id, build_id, 'food_cuisine', value, dedupe_name, lat, lng))
                if financial_service_kind:
                    poi_attribute_rows.append((canonical_fsq_place_id, place_id, build_id, 'financial_service_kind', financial_service_kind, dedupe_name, lat, lng))
                continue
            seen_identities[identity] = row['fsq_place_id']
            if keyword_store_kind_match:
                keyword_store_kind_matches += 1
            if keyword_food_cuisine_match:
                keyword_food_cuisine_matches += 1
            brand = find_brand(row['name'], ranked_types, brand_dictionary)
            if brand is not None:
                brand_matches += 1

            open_min, close_min = hours_for_category_label(category_label)  # KAN-318
            poi_rows.append((
                row['fsq_place_id'], place_id, build_id, row['name'], lat, lng, geohash,
                primary_poi_type, brand, category_label,
                raw_category_ids or None, raw_category_labels or None,
                row['address'] or None, started_at, dedupe_name,
                open_min, close_min,
            ))
            for rank, t in enumerate(ranked_types):
                poi_type_rows.append((row['fsq_place_id'], place_id, build_id, t, rank, dedupe_name, lat, lng))
            for value in sorted(store_kinds):
                poi_attribute_rows.append((row['fsq_place_id'], place_id, build_id, 'store_kind', value, dedupe_name, lat, lng))
            for value in sorted(food_cuisines):
                poi_attribute_rows.append((row['fsq_place_id'], place_id, build_id, 'food_cuisine', value, dedupe_name, lat, lng))
            if financial_service_kind:
                poi_attribute_rows.append((row['fsq_place_id'], place_id, build_id, 'financial_service_kind', financial_service_kind, dedupe_name, lat, lng))
            type_counts[primary_poi_type] = type_counts.get(primary_poi_type, 0) + 1

    print(f"[{place_id}] classified {len(poi_rows)} rows, skipped {skipped_no_type} (no matching poi_type)")
    print(f"[{place_id}] deduplicated {deduplicated} same-name, same-coordinate source rows")
    print(f"[{place_id}] {multi_type_count} rows matched more than one type ({len(poi_type_rows)} total poi_type rows)")
    print(f"[{place_id}] {brand_matches} rows matched a brand, {len(poi_attribute_rows)} total poi_attribute rows")
    print(f"[{place_id}] KAN-340 keyword fallback: {keyword_store_kind_matches} store_kind + {keyword_food_cuisine_matches} food_cuisine rows recovered (category tags alone found nothing for these)")
    print(f"[{place_id}] top primary types: {sorted(type_counts.items(), key=lambda x: -x[1])[:15]}")

    def poi_row_sql(r):
        return '(' + ','.join([
            sql_escape(r[0]), sql_escape(r[3]), str(r[4]), str(r[5]), sql_escape(r[6]),
            sql_escape(r[7]), sql_escape(r[8]), sql_escape(r[9]), sql_escape(r[10]),
            sql_escape(r[11]), sql_escape(r[12]), sql_escape(r[13]), sql_escape(r[14]),
            ('NULL' if r[15] is None else str(r[15])), ('NULL' if r[16] is None else str(r[16])),
        ]) + ')'

    def poi_type_row_select(r):
        return 'SELECT ' + ','.join([
            'fsq_place_id', f'{sql_escape(r[3])} AS poi_type', f'{r[4]} AS rank',
        ]) + ' FROM poi WHERE ' + ' AND '.join([
            f'dedupe_name = {sql_escape(r[5])}', f'lat = {r[6]}', f'lng = {r[7]}',
        ])

    def poi_attribute_row_select(r):
        return 'SELECT ' + ','.join([
            'fsq_place_id', f'{sql_escape(r[3])} AS dimension', f'{sql_escape(r[4])} AS value',
        ]) + ' FROM poi WHERE ' + ' AND '.join([
            f'dedupe_name = {sql_escape(r[5])}', f'lat = {r[6]}', f'lng = {r[7]}',
        ])

    poi_insert_prefix = (
        'INSERT OR IGNORE INTO poi '
        '(fsq_place_id, name, lat, lng, geohash, primary_poi_type, brand, '
        'category_label, raw_category_ids, raw_category_labels, address, date_refreshed, dedupe_name, '
        'open_min, close_min) '
        'VALUES '
    )
    poi_insert_suffix = (
        ' ON CONFLICT(fsq_place_id) DO UPDATE SET '
        'name = excluded.name, lat = excluded.lat, lng = excluded.lng, geohash = excluded.geohash, '
        'primary_poi_type = excluded.primary_poi_type, brand = excluded.brand, '
        'category_label = excluded.category_label, raw_category_ids = excluded.raw_category_ids, '
        'raw_category_labels = excluded.raw_category_labels, address = excluded.address, '
        'date_refreshed = excluded.date_refreshed, dedupe_name = excluded.dedupe_name, '
        'open_min = excluded.open_min, close_min = excluded.close_min'
    )

    with open(out_sql_path, 'w') as f:
        # build_log start row — closed out by /internal/build-complete once
        # the load + sweep below have actually run against D1.
        f.write(
            "INSERT INTO build_log (build_id, place_id, started_at, status, pipeline_version, source) "
            f"VALUES ({sql_escape(build_id)}, {sql_escape(place_id)}, {sql_escape(started_at)}, "
            f"'building', {sql_escape(PIPELINE_VERSION)}, 'foursquare_os_places');\n"
        )

        poi_batches = write_batches(
            f, poi_insert_prefix, [(r[0], poi_row_sql(r)) for r in poi_rows],
            'poi', place_id, poi_insert_suffix,
        )
        poi_type_batches = write_guarded_child_batches(
            f, 'poi_type', 'fsq_place_id, poi_type, rank',
            [(r[0], poi_type_row_select(r)) for r in poi_type_rows],
            'poi_type', place_id,
        )
        poi_attribute_batches = write_guarded_child_batches(
            f, 'poi_attribute', 'fsq_place_id, dimension, value',
            [(r[0], poi_attribute_row_select(r)) for r in poi_attribute_rows],
            'poi_attribute', place_id,
        )


    # build_id-specific, not just place_id-specific: a rerun for the same
    # city before the previous run's upload command was actually executed
    # would otherwise overwrite this file with a different build's data,
    # while the already-printed upload command still names the OLD
    # build_id — uploading mismatched content under a stale build_id label.
    sqlite_path = os.path.join(BUILD_DIR, f'export_{place_id}_{build_id}.sqlite')
    write_sqlite_export(place_id, build_id, PIPELINE_VERSION, poi_rows, poi_type_rows, poi_attribute_rows, sqlite_path)
    export_r2_key = f"exports/{place_id}/{build_id}.sqlite"

    r2_key = f"raw-extracts/{place_id}/{build_id}.csv"
    print(f"[{place_id}] wrote {out_sql_path} ({poi_batches} poi statements + {poi_type_batches} poi_type statements + {poi_attribute_batches} poi_attribute statements, ~{MAX_STATEMENT_BYTES // 1000}KB each max)")
    print(f"[{place_id}] wrote {sqlite_path} (client-download export, KAN-339)")
    print(f"[{place_id}] build_id={build_id} rows_loaded={len(poi_rows)} rows_skipped={skipped_no_type} deduplicated={deduplicated}")
    print(f"[{place_id}] after loading this file, upload the raw extract + export and close out the build:")
    print(f"  npx wrangler r2 object put brush-poi-exports/{r2_key} --file={csv_path} --remote")
    print(f"  npx wrangler r2 object put brush-poi-exports/{export_r2_key} --file={sqlite_path} --remote")
    print(f"  curl -X POST https://poi-api.brushaway.app/internal/build-complete "
          f"-H \"X-Build-Secret: $BUILD_TRIGGER_SECRET\" -H \"Content-Type: application/json\" "
          f"-d '{{\"cityId\":\"{place_id}\",\"buildId\":\"{build_id}\",\"rowsLoaded\":{len(poi_rows)},"
          f"\"rowsSkipped\":{skipped_no_type},\"deduplicated\":{deduplicated},\"r2Key\":\"{r2_key}\"}}'")

    # KAN-354: run_job.py's automated path needs these back programmatically
    # instead of re-parsing the printed curl command — the manual/CLI usage
    # below still works unchanged, this return is additive.
    lats = [r[4] for r in poi_rows]
    lngs = [r[5] for r in poi_rows]
    return {
        'place_id': place_id,
        'build_id': build_id,
        'rows_loaded': len(poi_rows),
        'rows_skipped': skipped_no_type,
        'deduplicated': deduplicated,
        'sql_path': out_sql_path,
        'sqlite_path': sqlite_path,
        'raw_extract_r2_key': r2_key,
        'export_r2_key': export_r2_key,
        # None (not 0/0/0/0) when nothing was loaded — an empty extent isn't
        # a real extent, and place.status must stay whatever it already was
        # (worker_client.build_complete's caller checks this before sending
        # minLat/etc at all).
        'min_lat': min(lats) if lats else None,
        'max_lat': max(lats) if lats else None,
        'min_lng': min(lngs) if lngs else None,
        'max_lng': max(lngs) if lngs else None,
    }

if __name__ == '__main__':
    city = sys.argv[1]
    os.makedirs(BUILD_DIR, exist_ok=True)
    classify(
        city,
        os.path.join(BUILD_DIR, f'raw_{city}.csv'),
        os.path.join(BUILD_DIR, f'load_{city}.sql'),
    )
