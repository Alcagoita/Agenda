"""KAN-318 — opening_hours category mapping. Run: python3 tests/test_opening_hours.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from opening_hours import hours_for_category_label as h  # noqa: E402
from opening_hours import hours_for_poi_type as t  # noqa: E402

CASES = [
    ("Dining and Drinking > Restaurant > Pizzeria", (660, 1380)),
    ("Dining and Drinking > Cafe, Coffee, and Tea House > Café", (420, 1260)),
    ("Dining and Drinking > Bakery", (420, 1260)),
    ("Dining and Drinking > Dessert Shop", (420, 1260)),
    ("Dining and Drinking > Bar", (None, None)),
    ("Retail > Pharmacy", (None, None)),                       # always, NOT generic retail 9-19
    ("Retail > Food and Beverage Retail > Supermarket", (540, 1320)),
    ("Retail > Fashion Retail > Boutique", (540, 1140)),
    ("Business and Professional Services > Financial Service > Banking and Finance > Bank", (510, 900)),
    ("Business and Professional Services > Financial Service > Banking and Finance > ATM", (None, None)),  # 24h, NOT bank
    ("Sports and Recreation > Gym and Studio", (360, 1380)),
    ("Health and Medicine > Dentist", (540, 1140)),
    ("Community and Government > Spiritual Center > Church", (None, None)),
    ("Community and Government > Government Building", (540, 1020)),
    ("Travel and Transportation > Lodging > Hotel", (None, None)),
    ("Travel and Transportation > Transport Hub > Bus Station", (None, None)),
    ("Arts and Entertainment > Art Gallery", (600, 1080)),
    ("Landmarks and Outdoors > Historic and Protected Site", (None, None)),
    ("Event > Something", (None, None)),                        # no rule -> always
    (None, (None, None)),
    ("", (None, None)),
]


def main():
    fails = 0
    # KAN-431. The label door and the poi_type door must agree: they are two
    # ways into one decision, and a drift between them would give an Overture
    # or OSM row different hours from the Foursquare row for the same place.
    AGREE = [
        ('restaurant', 'Dining and Drinking > Restaurant'),
        ('cafe', 'Dining and Drinking > Cafe, Coffee, and Tea House'),
        ('bakery', 'Dining and Drinking > Bakery'),
        ('supermarket', 'Retail > Food and Beverage Retail > Supermarket'),
        ('store', 'Retail > Fashion Retail'),
        ('bank', 'Business and Professional Services > Financial Service'),
        ('gym', 'Sports and Recreation > Gym and Studio'),
        ('clinic', 'Health and Medicine > Dentist'),
        ('museum', 'Arts and Entertainment > Museum'),
        ('post', 'Community and Government > Government Building'),
        # Always-open on both sides, for different stated reasons.
        ('pharmacy', 'Retail > Pharmacy'),
        ('bar', 'Dining and Drinking > Bar'),
    ]
    for poi_type, label in AGREE:
        if t(poi_type) != h(label):
            print(f"FAIL: {poi_type!r} -> {t(poi_type)}, but {label!r} -> {h(label)}")
            fails += 1
    for label, expected in CASES:
        got = h(label)
        if got != expected:
            print(f"FAIL: {label!r} -> {got}, expected {expected}")
            fails += 1
    if fails:
        print(f"{fails} failure(s)")
        sys.exit(1)
    print(f"OK: {len(CASES)} label cases + {len(AGREE)} agreement cases pass")


if __name__ == '__main__':
    main()
