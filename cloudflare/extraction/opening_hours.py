"""
KAN-318 — default opening hours per Foursquare category.

We have no per-place hours in Foursquare OS Places (the extract carries no
hours at all), and OSM `opening_hours` is a sparse, separate enrichment
(deferred). So the Nearby "don't show closed places" feature is driven by a
small hand-authored default keyed on the category hierarchy every poi already
stores in `category_label` — ~20 rules covering all ~476 leaf types.

Representation: minutes from local midnight. `open_min`/`close_min` = None means
"always open" — which for the Nearby filter also stands in for 24h and for
"unknown" (a pharmacy that might be 24h, a hotel, a park): all three mean
"never hide it". Portugal-uniform windows; same every day (holidays/lunch
breaks are out of scope, tracked separately).

Matched most-specific-first as a case-insensitive substring of the full
category_label path. First match wins; no match -> None (always open).
"""

# (needle, open_min, close_min) — ORDER MATTERS: specific before general.
_RULES = [
    # Financial: a standalone ATM is 24h; a bank branch closes early (PT ~8:30–15:00).
    ('> ATM', None, None),
    ('Financial Service', 510, 900),          # 08:30–15:00 (bank)
    # Retail: pharmacy hours vary too much to hide on; groceries run late; rest 9–19.
    ('> Pharmacy', None, None),               # always (some 24h, some to 19:00 — unknown)
    ('Food and Beverage Retail', 540, 1320),  # 09:00–22:00 (supermarket/grocery)
    # Dining specifics before the generic Restaurant catch.
    ('> Bakery', 420, 1260),                  # 07:00–21:00
    ('Dessert Shop', 420, 1260),              # 07:00–21:00 (café group)
    ('Cafe, Coffee', 420, 1260),              # 07:00–21:00
    ('> Bar', None, None),                    # always (lunch crowd vs 20:00+ — unknown)
    ('Night Club', None, None),               # always
    ('> Restaurant', 660, 1380),              # 11:00–23:00
    ('Dining and Drinking', 660, 1380),       # any other dining -> restaurant window
    # Sports / services / health.
    ('Gym and Studio', 360, 1380),            # 06:00–23:00
    ('Health and Beauty Service', 540, 1140), # 09:00–19:00 (salon/beauty)
    ('Automotive Service', 540, 1140),        # 09:00–19:00
    ('Health and Medicine', 540, 1140),       # 09:00–19:00 (clinic/physician/dentist)
    # Community / government.
    ('Government Building', 540, 1020),       # 09:00–17:00
    ('Spiritual Center', None, None),         # always (churches)
    # Travel.
    ('> Lodging', None, None),                # always (hotels — effectively 24h)
    ('Transport Hub', None, None),            # always
    # Arts / culture / outdoors.
    ('> Museum', 600, 1080),                  # 10:00–18:00
    ('Art Gallery', 600, 1080),               # 10:00–18:00
    ('Landmarks and Outdoors', None, None),   # always (parks, monuments)
    # Generic catch-alls LAST.
    ('Retail', 540, 1140),                    # 09:00–19:00 (any other store)
    ('Business and Professional Services', 540, 1140),  # 09:00–19:00
]


def hours_for_category_label(category_label):
    """Returns (open_min, close_min) for a poi's category_label, or (None, None)
    for 'always open'. A null/empty label is always open."""
    if not category_label:
        return (None, None)
    haystack = category_label.lower()
    for needle, open_min, close_min in _RULES:
        if needle.lower() in haystack:
            return (open_min, close_min)
    return (None, None)



# ─── KAN-431: the same windows, keyed on our own type ──────────────────────
#
# `hours_for_category_label` matches Foursquare's label format
# ("Dining and Drinking > Restaurant"). Overture names its categories
# `portuguese_restaurant` and OSM tags them `amenity=restaurant`, so neither
# can reach those rules — an Overture row would silently get "always open",
# which is the one answer the app must not guess (a place shown as open when
# it is closed is the app lying).
#
# So the windows are also reachable by `poi_type`, which is the app-level
# concept every source resolves to. Same numbers as the rules above,
# deliberately: this is a second door onto one decision, not a second policy.
# A type absent here means "always open", exactly as an unmatched label does.
_TYPE_HOURS = {
    # Financial. A standalone ATM is 24h; a branch closes early (PT ~8:30–15:00).
    'bank': (510, 900),
    'financial_service': (510, 900),
    'currency_exchange': (540, 1140),
    'money_transfer': (540, 1140),
    # Retail.
    'supermarket': (540, 1320),
    'grocery_store': (540, 1320),
    'bakery': (420, 1260),
    'store': (540, 1140),
    # KAN-431. A talho, peixaria or florista keeps shop hours like any other
    # retailer. Overture promotes all three, and without an entry here they
    # inherit "always open" — the app showing a butcher open at 3am is the
    # lying this table exists to prevent.
    'butcher': (540, 1140),
    'fishmonger': (540, 1140),
    'florist': (540, 1140),
    # Dining.
    'cafe': (420, 1260),
    'coffee_shop': (420, 1260),
    'tea': (420, 1260),
    'juice': (420, 1260),
    'ice_cream': (420, 1260),
    'restaurant': (660, 1380),
    # Services.
    'gym': (360, 1380),
    'yoga_studio': (360, 1380),
    'salon': (540, 1140),
    'hairdresser': (540, 1140),
    'barber': (540, 1140),
    'nail_salon': (540, 1140),
    'spa': (540, 1140),
    'laundry': (540, 1140),
    'car_wash': (540, 1140),
    'car_rental': (540, 1140),
    'veterinary_care': (540, 1140),
    'clinic': (540, 1140),
    # Civic and culture.
    'post': (540, 1020),
    'school': (540, 1020),
    'library': (600, 1080),
    'museum': (600, 1080),
    'art_gallery': (600, 1080),
    'movie_theater': (600, 1380),
    'theatre': (600, 1380),
}


def hours_for_poi_type(poi_type):
    """(open_min, close_min) for one of our types, or (None, None) for
    'always open' — which covers pharmacies, bars, night clubs, churches,
    lodging, transport and everything outdoors, all of which vary too much
    to state without lying."""
    return _TYPE_HOURS.get(poi_type, (None, None))

def _backfill_sql():
    """Emits UPDATE statements that set open_min/close_min on existing poi rows
    by category_label, applying the table above. Only touches rows still NULL,
    and runs most-specific-first so an earlier (more specific) rule wins — same
    precedence as hours_for_category_label. Rows matching no rule stay NULL
    (= always open). Operator applies via:
      npx wrangler d1 execute brush-poi-registry --remote --file=<this output>
    """
    lines = ["-- KAN-318 opening-hours backfill (generated from opening_hours.py)"]
    # First-match-wins across independent UPDATEs: each rule claims only rows
    # still unclaimed (open_min IS NULL). An 'always' rule (None) still has to
    # CLAIM its rows with a -1 sentinel, or a later broader window rule would
    # grab them (e.g. Retail > Pharmacy must stay always-open, not become the
    # generic Retail 9–19; ATM must stay 24h, not the bank 8:30–15). The final
    # statement converts the sentinel back to NULL.
    for needle, open_min, close_min in _RULES:
        o = -1 if open_min is None else open_min
        c = -1 if close_min is None else close_min
        needle_sql = needle.replace("'", "''")
        lines.append(
            f"UPDATE poi SET open_min={o}, close_min={c} "
            f"WHERE open_min IS NULL AND category_label LIKE '%{needle_sql}%';"
        )
    lines.append("UPDATE poi SET open_min=NULL, close_min=NULL WHERE open_min=-1;")
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    print(_backfill_sql(), end='')
