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
    return {v['category_id']: k for k, v in mapping.items()}

def classify(city_name, csv_path, out_sql_path):
    poi_types = load_mapping(os.path.join(CLOUDFLARE_DIR, 'src', 'poiTypeCategories.json'))
    store_subtypes = load_mapping(os.path.join(CLOUDFLARE_DIR, 'src', 'storeSubtypeCategories.json'))
    food_subtypes = load_mapping(os.path.join(CLOUDFLARE_DIR, 'src', 'foodSubtypeCategories.json'))

    poi_reverse = build_reverse_map(poi_types)
    store_reverse = build_reverse_map(store_subtypes)
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

    BATCH = 200
    with open(out_sql_path, 'w') as f:
        for i in range(0, len(rows_out), BATCH):
            batch = rows_out[i:i + BATCH]
            values = []
            for r in batch:
                values.append(
                    '(' + ','.join([
                        sql_escape(r[0]), sql_escape(r[1]), sql_escape(r[2]), str(r[3]), str(r[4]),
                        sql_escape(r[5]), sql_escape(r[6]), sql_escape(r[7]),
                        sql_escape(r[8]), sql_escape(r[9]), sql_escape(r[10]),
                        sql_escape(r[11]),
                    ]) + ')'
                )
            f.write(
                'INSERT OR REPLACE INTO poi '
                '(fsq_place_id, tile_id, name, lat, lng, geohash, poi_type, store_subtype, food_subtype, category_label, address, date_refreshed) '
                'VALUES ' + ','.join(values) + ';\n'
            )
    print(f"[{city_name}] wrote {out_sql_path}")

if __name__ == '__main__':
    city = sys.argv[1]
    os.makedirs(BUILD_DIR, exist_ok=True)
    classify(
        city,
        os.path.join(BUILD_DIR, f'raw_{city}.csv'),
        os.path.join(BUILD_DIR, f'load_{city}.sql'),
    )
