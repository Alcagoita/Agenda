"""
KAN-354. The 90-category-id extraction filter, generated from the same
mapping files classify_and_load.py classifies against
(poiTypeCategories.json, storeSubtypeCategories.json,
foodSubtypeCategories.json) instead of hand-copied into every per-city SQL
file the way extract_lisboa.sql/extract_odivelas.sql did. Adding a new
PoiType to any of those three files now automatically widens future
extractions too — no separate list to remember to update.
"""
import json
import os

CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def _category_ids(filename):
    path = os.path.join(CLOUDFLARE_DIR, 'src', filename)
    mapping = json.load(open(path))
    ids = set()
    for entry in mapping.values():
        # KAN-410 — a type may map to several Foursquare leaves. `museum` is
        # one category; `historical_landmark` is Monument, Castle and Palace.
        # Reading only the primary would extract a third of the material and
        # report success.
        if 'category_id' in entry:
            ids.add(entry['category_id'])
        for extra in entry.get('also', ()):
            if 'category_id' in extra:
                ids.add(extra['category_id'])
    return ids

def all_category_ids():
    ids = set()
    ids |= _category_ids('poiTypeCategories.json')
    ids |= _category_ids('storeSubtypeCategories.json')
    ids |= _category_ids('foodSubtypeCategories.json')
    return sorted(ids)
