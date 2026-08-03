"""
Classifies raw Foursquare OS Places extract rows into Brush's poi_type
(+ store/food subtype), computes each row's geohash, and emits a batched SQL
file ready for `wrangler d1 execute --file`: a build_log start row, the poi
INSERT statements (tagged with a fresh build_id), and a sweep DELETE that
retires anything from a previous build that didn't reappear (closed places).

Reimplements the same geohash algorithm as cloudflare/src/geohash.ts in
Python — the Worker and this script must agree on precision/encoding or
radius queries silently miss rows.
"""
import csv, json, sys, datetime, os, uuid

BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'
CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(CLOUDFLARE_DIR, 'build')
PIPELINE_VERSION = 'v2-phase1'

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

def load_mapping(path):
    return json.load(open(path))

def build_reverse_map(mapping):
    """Warns on category_id collisions instead of silently letting the last
    key win — two PoiTypes sharing an id (e.g. fitness_center/gym, hotel/
    lodging both map to Foursquare's single "Gym and Studio"/"Hotel" leaf)
    means the loser never gets classified at all. Known collisions are
    resolved via TYPE_MERGE_INCLUDES in cloudflare/src/index.ts, not here —
    this warning exists so a *new*, unhandled collision doesn't go unnoticed."""
    reverse = {}
    for k, v in mapping.items():
        cid = v['category_id']
        if cid in reverse:
            print(f"WARNING: category_id {cid} claimed by both '{reverse[cid]}' and '{k}' — "
                  f"'{k}' wins classification, '{reverse[cid]}' gets zero rows unless merged "
                  f"via TYPE_MERGE_INCLUDES in cloudflare/src/index.ts")
        reverse[cid] = k
    return reverse

def classify(city_id, csv_path, out_sql_path):
    poi_types = load_mapping(os.path.join(CLOUDFLARE_DIR, 'src', 'poiTypeCategories.json'))
    store_subtypes = load_mapping(os.path.join(CLOUDFLARE_DIR, 'src', 'storeSubtypeCategories.json'))
    food_subtypes = load_mapping(os.path.join(CLOUDFLARE_DIR, 'src', 'foodSubtypeCategories.json'))

    poi_reverse = build_reverse_map(poi_types)
    # 'any' maps to the same generic "Retail" category id that poi_type=='store'
    # itself is keyed on — every store row's tag array necessarily contains it
    # (that's *why* it's classified as store), so 'any' must never compete in
    # the subtype scan or it always wins before a real specific subtype (e.g.
    # Bookstore) further down the same row's tag array ever gets checked.
    # Real bug found via KAN-329 field testing: every single loaded store row
    # came back store_subtype='any' — this is the fix.
    store_reverse = {v['category_id']: k for k, v in store_subtypes.items() if k != 'any'}
    food_reverse = build_reverse_map(food_subtypes)

    build_id = str(uuid.uuid4())
    # Printed immediately, not just on success — if this crashes partway
    # through (bad row, D1 load failure, etc.), this is the only place the
    # build_id is visible at all, and it's needed to close out build_log as
    # 'failed' via POST /internal/build-complete {cityId, buildId,
    # status:'failed'} instead of leaving that row stuck at 'building' forever.
    print(f"[{city_id}] build_id={build_id} (starting)")
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    rows_out = []
    type_counts = {}
    skipped = 0

    with open(csv_path) as f:
        for row in csv.DictReader(f):
            raw_category_ids = row['category_ids'] or ''
            raw_category_labels = row['category_labels'] or ''
            cat_ids = [c for c in raw_category_ids.split('|') if c]

            poi_type = None
            for cid in cat_ids:
                if cid in poi_reverse:
                    poi_type = poi_reverse[cid]
                    break
            if poi_type is None:
                skipped += 1
                continue

            store_subtype = None
            if poi_type == 'store':
                for cid in cat_ids:
                    if cid in store_reverse:
                        store_subtype = store_reverse[cid]
                        break

            food_subtype = None
            if poi_type == 'restaurant':
                for cid in cat_ids:
                    if cid in food_reverse:
                        food_subtype = food_reverse[cid]
                        break

            lat = float(row['latitude'])
            lng = float(row['longitude'])
            geohash = encode_geohash(lat, lng, 7)
            category_label = raw_category_labels.split('|')[0]

            rows_out.append((
                row['fsq_place_id'], city_id, build_id, row['name'], lat, lng, geohash,
                poi_type, store_subtype, food_subtype, category_label,
                raw_category_ids or None, raw_category_labels or None,
                row['address'] or None, started_at,
            ))
            type_counts[poi_type] = type_counts.get(poi_type, 0) + 1

    print(f"[{city_id}] classified {len(rows_out)} rows, skipped {skipped} (no matching poi_type)")
    print(f"[{city_id}] top types: {sorted(type_counts.items(), key=lambda x: -x[1])[:15]}")

    # Size-aware batching, not a fixed row count. D1's confirmed hard limits
    # are 100KB per statement and 100 bound parameters per query (this pipeline
    # inlines values as literals, not bound params, so the byte-size cap is
    # the one that matters here) — flush at ~80KB per INSERT, well under the
    # 100KB hard cap, so wider rows (raw category ids added this phase, more
    # planned later) don't silently blow the limit.
    MAX_STATEMENT_BYTES = 80_000
    INSERT_PREFIX = (
        'INSERT OR REPLACE INTO poi '
        '(fsq_place_id, city_id, build_id, name, lat, lng, geohash, poi_type, store_subtype, '
        'food_subtype, category_label, raw_category_ids, raw_category_labels, address, date_refreshed) '
        'VALUES '
    )

    def byte_len(s):
        # D1's statement-size cap is bytes, not characters — Portuguese
        # names have accented characters that are multi-byte in UTF-8
        # (ç, ã, é, ...), so len() alone undercounts real payload size.
        return len(s.encode('utf-8'))

    def row_sql(r):
        return '(' + ','.join([
            sql_escape(r[0]), sql_escape(r[1]), sql_escape(r[2]), sql_escape(r[3]), str(r[4]), str(r[5]),
            sql_escape(r[6]), sql_escape(r[7]), sql_escape(r[8]),
            sql_escape(r[9]), sql_escape(r[10]), sql_escape(r[11]),
            sql_escape(r[12]), sql_escape(r[13]), sql_escape(r[14]),
        ]) + ')'

    batches_written = 0
    with open(out_sql_path, 'w') as f:
        # build_log start row — closed out by /internal/build-complete once
        # the load + sweep below have actually run against D1.
        f.write(
            "INSERT INTO build_log (build_id, city_id, started_at, status, pipeline_version, source) "
            f"VALUES ({sql_escape(build_id)}, {sql_escape(city_id)}, {sql_escape(started_at)}, "
            f"'building', {sql_escape(PIPELINE_VERSION)}, 'foursquare_os_places');\n"
        )

        values: list[str] = []
        size = byte_len(INSERT_PREFIX) + byte_len(';\n')

        def flush():
            nonlocal values, size, batches_written
            if not values:
                return
            f.write(INSERT_PREFIX + ','.join(values) + ';\n')
            batches_written += 1
            values = []
            size = byte_len(INSERT_PREFIX) + byte_len(';\n')

        for r in rows_out:
            piece = row_sql(r)
            piece_size = byte_len(piece) + 1  # +1 for the joining comma
            # A single row that can't fit even alone in a fresh statement
            # would otherwise be silently appended anyway — not caught here,
            # not caught until the actual D1 execute fails later with a
            # confusing native error instead of a clear one now.
            solo_size = byte_len(INSERT_PREFIX) + byte_len(piece) + byte_len(';\n')
            if solo_size > MAX_STATEMENT_BYTES:
                raise ValueError(
                    f"[{city_id}] row {r[0]} ({r[3]!r}) is {solo_size} bytes alone, "
                    f"exceeds MAX_STATEMENT_BYTES ({MAX_STATEMENT_BYTES}) even in its own statement"
                )
            if values and size + piece_size > MAX_STATEMENT_BYTES:
                flush()
            values.append(piece)
            size += piece_size
        flush()

        # Sweep — retires rows from a previous build that didn't reappear in
        # this one (the place closed / Foursquare dropped it). Safe to run
        # even on a city's very first build: nothing has a different
        # build_id yet, so this is a no-op.
        f.write(
            f"DELETE FROM poi WHERE city_id = {sql_escape(city_id)} AND build_id != {sql_escape(build_id)};\n"
        )

    print(f"[{city_id}] wrote {out_sql_path} ({batches_written} poi statements, ~{MAX_STATEMENT_BYTES // 1000}KB each max)")
    print(f"[{city_id}] build_id={build_id} rows_loaded={len(rows_out)} rows_skipped={skipped}")
    print(f"[{city_id}] after loading this file, close out the build:")
    print(f"  curl -X POST https://poi-api.brushaway.app/internal/build-complete "
          f"-H \"X-Build-Secret: $BUILD_TRIGGER_SECRET\" -H \"Content-Type: application/json\" "
          f"-d '{{\"cityId\":\"{city_id}\",\"buildId\":\"{build_id}\",\"rowsLoaded\":{len(rows_out)},\"rowsSkipped\":{skipped}}}'")

if __name__ == '__main__':
    city = sys.argv[1]
    os.makedirs(BUILD_DIR, exist_ok=True)
    classify(
        city,
        os.path.join(BUILD_DIR, f'raw_{city}.csv'),
        os.path.join(BUILD_DIR, f'load_{city}.sql'),
    )
