"""
Classifies raw Foursquare OS Places extract rows into Brush's poi_type
(+ store/food subtype), computes each row's geohash, and emits a batched SQL
INSERT file ready for `wrangler d1 execute --file`.

Reimplements the same geohash algorithm as cloudflare/src/geohash.ts in
Python — the Worker and this script must agree on precision/encoding or
radius queries silently miss rows.
"""
import csv, json, sys, datetime, os

BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'
CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(CLOUDFLARE_DIR, 'build')

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

def classify(city_name, csv_path, out_sql_path):
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

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    rows_out = []
    type_counts = {}
    skipped = 0

    with open(csv_path) as f:
        for row in csv.DictReader(f):
            cat_ids = (row['category_ids'] or '').split('|')
            cat_ids = [c for c in cat_ids if c]

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
            category_label = (row['category_labels'] or '').split('|')[0]

            rows_out.append((
                row['fsq_place_id'], city_name, row['name'], lat, lng, geohash,
                poi_type, store_subtype, food_subtype, category_label,
                row['address'] or None, now,
            ))
            type_counts[poi_type] = type_counts.get(poi_type, 0) + 1

    print(f"[{city_name}] classified {len(rows_out)} rows, skipped {skipped} (no matching poi_type)")
    print(f"[{city_name}] top types: {sorted(type_counts.items(), key=lambda x: -x[1])[:15]}")

    # Size-aware batching, not a fixed row count. D1's confirmed hard limits
    # are 100KB per statement and 100 bound parameters per query (this pipeline
    # inlines values as literals, not bound params, so the byte-size cap is
    # the one that matters here) — a fixed 200-rows-per-batch assumption
    # breaks the moment a row gets wider (raw category ids, attributes,
    # brand — all planned in later schema-v2 phases). Flush at ~80KB per
    # INSERT, well under the 100KB hard cap, so future wider rows don't
    # silently blow the limit.
    MAX_STATEMENT_BYTES = 80_000
    INSERT_PREFIX = (
        'INSERT OR REPLACE INTO poi '
        '(fsq_place_id, tile_id, name, lat, lng, geohash, poi_type, store_subtype, food_subtype, category_label, address, date_refreshed) '
        'VALUES '
    )

    def byte_len(s):
        # D1's statement-size cap is bytes, not characters — Portuguese
        # names have accented characters that are multi-byte in UTF-8
        # (ç, ã, é, ...), so len() alone undercounts real payload size.
        return len(s.encode('utf-8'))

    def row_sql(r):
        return '(' + ','.join([
            sql_escape(r[0]), sql_escape(r[1]), sql_escape(r[2]), str(r[3]), str(r[4]),
            sql_escape(r[5]), sql_escape(r[6]), sql_escape(r[7]),
            sql_escape(r[8]), sql_escape(r[9]), sql_escape(r[10]),
            sql_escape(r[11]),
        ]) + ')'

    batches_written = 0
    with open(out_sql_path, 'w') as f:
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
            if values and size + piece_size > MAX_STATEMENT_BYTES:
                flush()
            values.append(piece)
            size += piece_size
        flush()
    print(f"[{city_name}] wrote {out_sql_path} ({batches_written} statements, ~{MAX_STATEMENT_BYTES // 1000}KB each max)")

if __name__ == '__main__':
    city = sys.argv[1]
    os.makedirs(BUILD_DIR, exist_ok=True)
    classify(
        city,
        os.path.join(BUILD_DIR, f'raw_{city}.csv'),
        os.path.join(BUILD_DIR, f'load_{city}.sql'),
    )
