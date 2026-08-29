"""KAN-431 — the Overture category map has to stay reachable.

A mapping entry that points at a type or subtype the app cannot search is
worse than no entry at all: the row is promoted, counted as coverage, and
never returned to anyone. That is the failure KAN-412 spent a ticket
measuring, so it gets a guard here rather than a rediscovery later.
"""
import json
import os
import sys
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLOUDFLARE_DIR = os.path.dirname(EXTRACTION_DIR)
sys.path.insert(0, EXTRACTION_DIR)


def _load(name):
    with open(os.path.join(CLOUDFLARE_DIR, 'src', name)) as handle:
        return json.load(handle)


class OvertureCategoryMapTest(unittest.TestCase):
    def setUp(self):
        self.mapping = {k: v for k, v in _load('overtureCategories.json').items()
                        if not k.startswith('_')}
        self.store_kinds = set(_load('storeSubtypeCategories.json'))
        self.food_cuisines = set(_load('foodSubtypeCategories.json'))
        import analyse_poi_candidates as analyse
        self.analyse = analyse
        # reachable_types() reads `type_relation` from live D1. A unit test
        # must not depend on the network; the two bridges the docstring names
        # are stubbed, which is all this needs to be meaningful.
        self._real_pairs = analyse._type_relation_pairs
        analyse._type_relation_pairs = lambda: [
            ('fitness_center', 'gym'), ('grocery_store', 'supermarket'),
        ]
        self.reachable = analyse.reachable_types()

    def tearDown(self):
        self.analyse._type_relation_pairs = self._real_pairs

    def test_every_mapped_type_is_reachable(self):
        for category, entry in sorted(self.mapping.items()):
            with self.subTest(category=category):
                self.assertIn(entry['poi_type'], self.reachable)

    def test_every_store_kind_is_a_real_subtype(self):
        # `store` is the one type a task cannot be created for without a
        # subtype, so an invented store_kind produces rows nothing can reach.
        for category, entry in sorted(self.mapping.items()):
            if 'store_kind' in entry:
                with self.subTest(category=category):
                    self.assertIn(entry['store_kind'], self.store_kinds)

    def test_every_food_cuisine_is_a_real_subtype(self):
        for category, entry in sorted(self.mapping.items()):
            if 'food_cuisine' in entry:
                with self.subTest(category=category):
                    self.assertIn(entry['food_cuisine'], self.food_cuisines)

    def test_a_subtype_is_only_set_on_the_type_that_owns_it(self):
        # A food_cuisine on a `store`, or a store_kind on a `restaurant`,
        # would be written into an attribute dimension the search for that
        # type never reads.
        for category, entry in sorted(self.mapping.items()):
            with self.subTest(category=category):
                if 'store_kind' in entry:
                    self.assertEqual(entry['poi_type'], 'store')
                if 'food_cuisine' in entry:
                    self.assertEqual(entry['poi_type'], 'restaurant')

    def test_entries_carry_nothing_but_the_three_known_keys(self):
        for category, entry in sorted(self.mapping.items()):
            with self.subTest(category=category):
                self.assertLessEqual(set(entry),
                                     {'poi_type', 'store_kind', 'food_cuisine'})

    def test_the_deliberate_exclusions_stay_unmapped(self):
        """KAN-412 decided these are searched for by name at an address, never
        stumbled upon. If one appears here, that decision was reversed by
        accident rather than on purpose."""
        for category in ('automotive_repair', 'car_dealer', 'dentist',
                         'hospital', 'medical_center', 'diagnostic_services'):
            with self.subTest(category=category):
                self.assertNotIn(category, self.mapping)


if __name__ == '__main__':
    unittest.main()
