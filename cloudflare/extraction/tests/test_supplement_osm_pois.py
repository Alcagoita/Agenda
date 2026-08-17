import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import supplement_osm_pois as supplement


def element(element_id, name, lat=39.8034492, lng=-8.1012644, **tags):
    return {
        'type': 'node', 'id': element_id, 'lat': lat, 'lon': lng,
        'tags': {'name': name, **tags},
    }


class SupplementOsmPoisTest(unittest.TestCase):
    def test_excluded_shop_values_are_not_admitted(self):
        for value in ('mall', 'vacant', 'yes'):
            with self.subTest(shop=value):
                self.assertIsNone(
                    supplement.osm_poi_from_element(element(1, 'Some Unit', shop=value), {}),
                )

    def test_generic_shop_becomes_a_store_and_mapped_shop_keeps_its_type(self):
        generic = supplement.osm_poi_from_element(element(2, 'Papelaria', shop='stationery'), {})
        self.assertIsNotNone(generic)
        self.assertEqual(generic.poi_types, ('store',))
        bakery = supplement.osm_poi_from_element(element(3, 'Padaria', shop='bakery'), {})
        self.assertIsNotNone(bakery)
        self.assertEqual(bakery.poi_types, ('bakery',))

    def test_sql_quote_removes_statement_control_characters(self):
        self.assertEqual(supplement.sql_quote("A;\nB\x00's"), "'A B ''s'")

    def test_paged_query_continues_through_a_driver_row_without_a_type(self):
        responses = [
            [{'source_id': 'one', 'poi_type': None}],
            [{'source_id': 'two', 'poi_type': 'restaurant'}],
            [],
        ]
        calls = []
        original = supplement.run_d1_query
        try:
            supplement.run_d1_query = lambda after: (calls.append(after), responses.pop(0))[1]
            rows = list(supplement.paged_query(lambda after: after))
        finally:
            supplement.run_d1_query = original
        self.assertEqual([row['source_id'] for row in rows], ['one', 'two'])
        self.assertEqual(calls, ['', 'one', 'two'])

    def test_classifies_named_restaurant_with_stable_osm_identity(self):
        poi = supplement.osm_poi_from_element(
            element(5335674113, 'Santo Amaro', amenity='restaurant', cuisine='portuguese'),
            {},
        )
        self.assertIsNotNone(poi)
        self.assertEqual(poi.osm_element_id, 'node/5335674113')
        self.assertEqual(poi.poi_types, ('restaurant',))
        self.assertEqual(poi.attributes, (('food_cuisine', 'portuguese'),))

    def test_confident_nearby_same_name_is_skipped_but_different_name_is_admitted(self):
        existing = [
            supplement.Candidate('foursquare', 'fsq-santo', 'Santo Amaro', 'santo amaro', 39.80345, -8.10126, 'restaurant'),
        ]
        imports, stats = supplement.classify_scope([
            element(1, 'Santo Amaro', amenity='restaurant'),
            element(2, 'Lagar Restaurante', lat=39.80346, lng=-8.10127, amenity='restaurant'),
        ], existing, 39.80345)
        self.assertEqual([poi.name for poi in imports], ['Lagar Restaurante'])
        self.assertEqual(stats['matched_skipped'], 1)
        self.assertEqual(stats['inserted'], 1)

    def test_reordered_identity_terms_match_but_a_shared_surname_does_not(self):
        self.assertGreaterEqual(
            supplement.name_similarity('cafe ala sul', 'ala sul cafe'),
            supplement.NAME_SIMILARITY_THRESHOLD,
        )
        self.assertLess(
            supplement.name_similarity('cafe rosa', 'alberto rosa filhos'),
            supplement.NAME_SIMILARITY_THRESHOLD,
        )
        self.assertLess(
            supplement.name_similarity('cafe rosa', 'rosa cafe'),
            supplement.NAME_SIMILARITY_THRESHOLD,
        )
        self.assertLess(
            supplement.name_similarity('cafe ala sul', 'cafe ala norte'),
            supplement.NAME_SIMILARITY_THRESHOLD,
        )

    def test_reordered_identity_name_is_skipped_but_shared_surname_is_imported(self):
        existing = [
            supplement.Candidate('foursquare', 'ala-sul', 'Ala Sul Café', 'ala sul cafe', 39.80345, -8.10126, 'cafe'),
            supplement.Candidate('foursquare', 'rosa-family', 'Alberto Rosa & Filhos', 'alberto rosa filhos', 39.80355, -8.10126, 'cafe'),
        ]
        imports, stats = supplement.classify_scope([
            element(1, 'Café Ala Sul', amenity='cafe'),
            element(2, 'Café Rosa', lat=39.80355, amenity='cafe'),
        ], existing, 39.80345)

        self.assertEqual([poi.name for poi in imports], ['Café Rosa'])
        self.assertEqual(stats['matched_skipped'], 1)
        self.assertEqual(stats['normalized_identity_matched_skipped'], 1)

    def test_differently_named_same_location_is_reported_but_still_admitted(self):
        existing = [
            supplement.Candidate('foursquare', 'fsq-lagar', 'Lagar Restaurante', 'lagar restaurante', 39.80345, -8.10126, 'restaurant'),
        ]
        imports, _ = supplement.classify_scope([
            element(2, 'O Lagar', lat=39.80346, lng=-8.10127, amenity='restaurant'),
        ], existing, 39.80345)

        rows = supplement.possible_renames(imports, existing)

        self.assertEqual([poi.name for poi in imports], ['O Lagar'])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].severity, 'same_location')
        self.assertEqual(rows[0].source, 'foursquare')
        self.assertEqual(rows[0].source_name, 'Lagar Restaurante')

    def test_possible_renames_only_calculates_distance_for_nearby_same_type_rows(self):
        poi = supplement.osm_poi_from_element(
            element(2, 'O Lagar', lat=39.80346, lng=-8.10127, amenity='restaurant'), {},
        )
        assert poi is not None
        candidates = [
            supplement.Candidate('foursquare', 'nearby', 'Lagar Restaurante', 'lagar restaurante', 39.80345, -8.10126, 'restaurant'),
            supplement.Candidate('foursquare', 'far-away', 'Other Restaurant', 'other restaurant', 40.80345, -8.10126, 'restaurant'),
            supplement.Candidate('community', 'wrong-type', 'Other Cafe', 'other cafe', 39.80345, -8.10126, 'cafe'),
        ]
        calls = []
        original_haversine = supplement.haversine_m
        try:
            supplement.haversine_m = lambda *args: (calls.append(args), original_haversine(*args))[1]
            rows = supplement.possible_renames([poi], candidates)
        finally:
            supplement.haversine_m = original_haversine

        self.assertEqual([row.source_id for row in rows], ['nearby'])
        self.assertEqual(len(calls), 1)

    def test_possible_rename_report_is_machine_readable(self):
        row = supplement.PossibleRename(
            'node/1', 'O Lagar', 39.80346, -8.10127, 'restaurant',
            'community', 'curated-1', 'Lagar Restaurante', 39.80345, -8.10126,
            1.5, 'same_location',
        )
        original_build_dir = supplement.BUILD_DIR
        try:
            with tempfile.TemporaryDirectory() as temporary_dir:
                supplement.BUILD_DIR = temporary_dir
                path = supplement.write_possible_rename_report('test-place', [row])
                with open(path) as report:
                    payload = json.load(report)
        finally:
            supplement.BUILD_DIR = original_build_dir

        self.assertEqual(payload['label'], 'test-place')
        self.assertEqual(payload['possible_renames'][0]['severity'], 'same_location')
        self.assertEqual(payload['possible_renames'][0]['source_id'], 'curated-1')

    def test_ambiguous_nearby_candidates_are_not_imported(self):
        existing = [
            supplement.Candidate('foursquare', 'one', 'Casa Verde', 'casa verde', 39.80345, -8.10126, 'restaurant'),
            supplement.Candidate('foursquare', 'two', 'Casa Verde', 'casa verde', 39.80346, -8.10127, 'restaurant'),
        ]
        imports, stats = supplement.classify_scope([
            element(1, 'Casa Verde', amenity='restaurant'),
        ], existing, 39.80345)
        self.assertEqual(imports, [])
        self.assertEqual(stats['ambiguous_skipped'], 1)

    def test_reimport_uses_osm_element_identity_as_an_update(self):
        existing = [
            supplement.Candidate('openstreetmap', 'node/5335674113', 'Santo Amaro', 'santo amaro', 39.80345, -8.10126, 'restaurant'),
        ]
        imports, stats = supplement.classify_scope([
            element(5335674113, 'Santo Amaro', amenity='restaurant'),
        ], existing, 39.80345)
        self.assertEqual([poi.osm_element_id for poi in imports], ['node/5335674113'])
        self.assertEqual(stats['updated'], 1)
        self.assertNotIn('inserted', stats)

    def test_reviewed_osm_correction_excludes_closed_poi_and_overrides_name(self):
        corrections = {
            ('openstreetmap', 'node/5381704191'): supplement.SourceCorrection('openstreetmap', 'node/5381704191', False, None, None),
            ('openstreetmap', 'node/5381704211'): supplement.SourceCorrection('openstreetmap', 'node/5381704211', True, 'Lagar', 'lagar'),
        }
        imports, stats = supplement.classify_scope([
            element(5381704191, 'O Vilaça', amenity='restaurant'),
            element(5381704211, 'O Lagar', lat=39.80346, lng=-8.10127, amenity='restaurant'),
        ], [], 39.80345, corrections)

        self.assertEqual([poi.name for poi in imports], ['Lagar'])
        self.assertEqual(imports[0].dedupe_name, 'lagar')
        self.assertEqual(stats['operator_excluded'], 1)

    def test_sql_is_idempotent_and_does_not_fabricate_a_foursquare_id(self):
        poi = supplement.osm_poi_from_element(element(5335674113, 'Santo Amaro', amenity='restaurant'), {})
        assert poi is not None
        sql = supplement.sql_for_pois([poi])
        self.assertIn('INSERT INTO osm_poi', sql)
        self.assertIn('node/5335674113', sql)
        self.assertIn('ON CONFLICT(osm_element_id) DO UPDATE', sql)
        self.assertNotIn('fsq_place_id', sql)


if __name__ == '__main__':
    unittest.main()
