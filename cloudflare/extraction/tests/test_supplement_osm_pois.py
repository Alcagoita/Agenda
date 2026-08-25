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
        imports, stats, _ = supplement.classify_scope([
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
        imports, stats, _ = supplement.classify_scope([
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
        imports, _, _ = supplement.classify_scope([
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
        imports, stats, _ = supplement.classify_scope([
            element(1, 'Casa Verde', amenity='restaurant'),
        ], existing, 39.80345)
        self.assertEqual(imports, [])
        self.assertEqual(stats['ambiguous_skipped'], 1)

    def test_reimport_uses_osm_element_identity_as_an_update(self):
        existing = [
            supplement.Candidate('openstreetmap', 'node/5335674113', 'Santo Amaro', 'santo amaro', 39.80345, -8.10126, 'restaurant'),
        ]
        imports, stats, _ = supplement.classify_scope([
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
        imports, stats, _ = supplement.classify_scope([
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


class NameInferredTypeTest(unittest.TestCase):
    """KAN-391 — the OSM classifier picks up types stated only in the name."""

    def test_a_real_tag_decides_the_primary_type_and_the_name_only_adds(self):
        # 682 PT rows looked like this: a genuine pastelaria whose only clue
        # was in its name. The cafe tag is a real claim, so it stays primary
        # and drives the hero card's icon; bakery joins it.
        poi = supplement.osm_poi_from_element(
            element(11, 'Padaria Pastelaria Belo Horizonte', amenity='cafe'), {},
        )
        self.assertIsNotNone(poi)
        self.assertEqual(poi.primary_poi_type, 'cafe')
        self.assertIn('bakery', poi.poi_types)

    def test_snack_bar_tagged_as_a_cafe_gains_nothing_and_never_a_bar(self):
        poi = supplement.osm_poi_from_element(element(12, 'Snack-Bar Martinik', amenity='cafe'), {})
        self.assertIsNotNone(poi)
        self.assertEqual(poi.poi_types, ('cafe',))

    def test_a_name_alone_cannot_conjure_a_poi_from_an_untyped_element(self):
        # `shop=yes` is excluded as an empty unit. A promising name must not
        # be enough to import something nobody classified.
        self.assertIsNone(supplement.osm_poi_from_element(element(13, 'Papelaria Universal', shop='yes'), {}))

    def test_ice_cream_tags_classify_instead_of_being_dropped_or_shelved(self):
        # amenity=ice_cream produced no type at all before KAN-399, so the
        # element was dropped outright at import; shop=ice_cream fell through
        # to generic `store`.
        parlour = supplement.osm_poi_from_element(element(20, 'Geladaria Santini', amenity='ice_cream'), {})
        self.assertIsNotNone(parlour)
        self.assertEqual(parlour.poi_types, ('ice_cream',))

        counter = supplement.osm_poi_from_element(element(21, 'Gelataria do Cais', shop='ice_cream'), {})
        self.assertIsNotNone(counter)
        self.assertIn('ice_cream', counter.poi_types)
        self.assertNotIn('store', counter.poi_types)

    def test_a_tattoo_shop_is_a_tattoo_studio_not_a_generic_store(self):
        # shop=tattoo is a standard OSM tag that was never mapped, so 77
        # Portuguese studios were sitting in generic `store` (KAN-402).
        poi = supplement.osm_poi_from_element(element(30, 'Sol Ink Tattoos', shop='tattoo'), {})
        self.assertIsNotNone(poi)
        self.assertEqual(poi.poi_types, ('tattoo',))

    def test_a_barbershop_that_also_tattoos_keeps_both(self):
        # "Barbearia 31 Tatuagem" really does cut hair. The multi-type model
        # is correct here and must not be collapsed to one or the other.
        poi = supplement.osm_poi_from_element(
            element(31, 'Barbearia 31 Tatuagem', shop='hairdresser'), {},
        )
        self.assertIsNotNone(poi)
        self.assertIn('tattoo', poi.poi_types)
        # shop=hairdresser gives hairdresser; the name adds the barber split.
        self.assertIn('hairdresser', poi.poi_types)
        self.assertIn('barber', poi.poi_types)

    def test_a_generic_shop_tag_is_replaced_by_what_the_name_says(self):
        # "Guanabara - Pizzaria Padaria Pastelaria" is a lot of things, but a
        # store is not one of them. `shop=convenience` was OSM shrugging.
        poi = supplement.osm_poi_from_element(
            element(15, 'Guanabara - Pizzaria Padaria Pastelaria', shop='convenience'), {},
        )
        self.assertIsNotNone(poi)
        self.assertNotIn('store', poi.poi_types)
        self.assertEqual(set(poi.poi_types), {'bakery', 'restaurant'})

    def test_a_known_shop_kind_outranks_the_name_and_keeps_its_store_type(self):
        # `shop=clothes` is a positive identification, not a shrug — and
        # dropping `store` would orphan the store_kind attribute.
        poi = supplement.osm_poi_from_element(
            element(16, 'Pastelaria Modas', shop='clothes'), {},
        )
        self.assertIsNotNone(poi)
        self.assertIn('store', poi.poi_types)
        self.assertIn('bakery', poi.poi_types)
        self.assertIn(('store_kind', 'clothing'), poi.attributes)

    def test_store_survives_when_the_tags_said_something_else_too(self):
        poi = supplement.osm_poi_from_element(
            element(17, 'Pastelaria do Cais', shop='convenience', amenity='cafe'), {},
        )
        self.assertIsNotNone(poi)
        self.assertIn('store', poi.poi_types)
        self.assertIn('cafe', poi.poi_types)

    def test_inferred_types_are_deduplicated_and_ordered_after_the_tagged_one(self):
        poi = supplement.osm_poi_from_element(
            element(14, 'Restaurante e Churrasqueira do Cais', amenity='cafe'), {},
        )
        self.assertIsNotNone(poi)
        self.assertEqual(poi.poi_types, ('cafe', 'restaurant'))


class ScopedCandidateTest(unittest.TestCase):
    """KAN-387 — a scope reads its own neighbourhood, not the whole country."""

    def test_bounds_widen_by_the_matching_radius_and_scale_longitude(self):
        min_lat, max_lat, min_lng, max_lng = supplement.candidate_bounds(38.7, 38.8, -9.2, -9.1)
        # A Foursquare venue just outside the municipality boundary must still
        # be able to suppress an OSM element just inside it.
        self.assertAlmostEqual(38.7 - min_lat, supplement.MATCH_RADIUS_METERS / 111_000, places=9)
        self.assertAlmostEqual(max_lat - 38.8, supplement.MATCH_RADIUS_METERS / 111_000, places=9)
        # Longitude degrees are shorter this far north, so the east/west
        # margin must be wider in degrees to cover the same metres.
        self.assertGreater(max_lng - -9.1, max_lat - 38.8)
        self.assertGreater(-9.2 - min_lng, 38.7 - min_lat)

    def test_candidate_query_is_restricted_to_the_widened_box(self):
        queries = []

        def fake_query(sql):
            queries.append(sql)
            return []

        original = supplement.run_d1_query
        supplement.run_d1_query = fake_query
        try:
            rows = supplement.existing_candidates_in_bbox(38.7, 38.8, -9.2, -9.1, {})
        finally:
            supplement.run_d1_query = original

        self.assertEqual(rows, [])
        # poi, curated_poi and osm_poi — the last is what keeps overlapping
        # municipality bboxes harmless now that each scope writes as it ends.
        self.assertTrue(any('FROM poi ' in sql for sql in queries))
        self.assertTrue(any('curated_poi' in sql for sql in queries))
        self.assertTrue(any('osm_poi ' in sql for sql in queries))
        for sql in queries:
            self.assertIn('lat BETWEEN', sql)
            self.assertIn('lng BETWEEN', sql)


class OverpassRateLimitTest(unittest.TestCase):
    """KAN-387 — 429 is a stop, and must not be retried across mirrors."""

    def test_rate_limit_raises_immediately_without_trying_other_endpoints(self):
        import io
        import urllib.error
        import enrich_osm_cuisine

        attempts = []

        def fake_urlopen(req, timeout=None):
            attempts.append(req.full_url)
            raise urllib.error.HTTPError(req.full_url, 429, 'Too Many Requests', {}, io.BytesIO(b''))

        original = enrich_osm_cuisine.urllib.request.urlopen
        enrich_osm_cuisine.urllib.request.urlopen = fake_urlopen
        try:
            with self.assertRaises(enrich_osm_cuisine.OverpassRateLimited):
                enrich_osm_cuisine.fetch_overpass('[out:json];node;out;')
        finally:
            enrich_osm_cuisine.urllib.request.urlopen = original
        # The limit is on us, so moving to a different mirror is still abuse.
        self.assertEqual(len(attempts), 1)

    def test_transport_failure_still_falls_back_and_then_raises_plain_runtime_error(self):
        import urllib.error
        import enrich_osm_cuisine

        attempts = []

        def fake_urlopen(req, timeout=None):
            attempts.append(req.full_url)
            raise urllib.error.URLError('connection reset')

        original_open = enrich_osm_cuisine.urllib.request.urlopen
        original_sleep = enrich_osm_cuisine.time.sleep
        enrich_osm_cuisine.urllib.request.urlopen = fake_urlopen
        enrich_osm_cuisine.time.sleep = lambda _seconds: None
        try:
            with self.assertRaises(RuntimeError) as raised:
                enrich_osm_cuisine.fetch_overpass('[out:json];node;out;')
        finally:
            enrich_osm_cuisine.urllib.request.urlopen = original_open
            enrich_osm_cuisine.time.sleep = original_sleep
        self.assertNotIsInstance(raised.exception, enrich_osm_cuisine.OverpassRateLimited)
        self.assertEqual(len(attempts), 2 * len(enrich_osm_cuisine.OVERPASS_ENDPOINTS))


class ScopeCheckpointTest(unittest.TestCase):
    """KAN-387 — the unit the container claims, persists and checkpoints."""

    def test_supplement_scope_reports_its_own_counts_and_writes_nothing(self):
        calls = {}

        def fake_fetch(query):
            calls['query'] = query
            return {'elements': [
                element(5335674113, 'Santo Amaro', amenity='restaurant'),
                element(5381704191, 'O Vilaça', lat=39.9, lng=-8.2, amenity='restaurant'),
            ]}

        original_fetch = supplement.fetch_overpass
        original_candidates = supplement.existing_candidates_in_bbox
        supplement.fetch_overpass = fake_fetch
        supplement.existing_candidates_in_bbox = lambda *args, **kwargs: []
        try:
            imports, stats, renames = supplement.supplement_scope('osm-relation-1', 39.8, 40.0, -8.3, -8.0, {})
        finally:
            supplement.fetch_overpass = original_fetch
            supplement.existing_candidates_in_bbox = original_candidates

        self.assertEqual(len(imports), 2)
        # The counts are per scope: the Worker replaces the scope row with
        # them rather than adding them to a running total.
        self.assertEqual(stats['overpass_elements'], 2)
        self.assertEqual(stats['inserted'], 2)
        self.assertEqual(renames, [])
        self.assertIn('39.8', calls['query'])

    def test_rename_report_serializes_without_touching_local_disk(self):
        report = json.loads(supplement.rename_report_json('osm-relation-1', []))
        self.assertEqual(report, {'label': 'osm-relation-1', 'possible_renames': []})


if __name__ == '__main__':
    unittest.main()


class AmbiguousConflictTest(unittest.TestCase):
    """KAN-390 — an indistinguishable match is evidence, not just a counter."""

    @staticmethod
    def candidate(source_id, name):
        return supplement.Candidate(
            source='foursquare', source_id=source_id, name=name,
            dedupe_name=supplement.normalize_text(name),
            lat=41.5, lng=-8.4, poi_type='cafe',
        )

    def element(self):
        return {'type': 'node', 'id': 1, 'lat': 41.5, 'lon': -8.4,
                'tags': {'amenity': 'cafe', 'name': 'Café Central'}}

    def test_two_indistinguishable_candidates_produce_one_row_each(self):
        # Same name, same spot, two source ids: the matcher cannot say which
        # one the element is, so it imports nothing — and that verdict is
        # exactly what someone needs to review.
        candidates = [self.candidate('fsq1', 'Café Central'),
                      self.candidate('fsq2', 'Café Central')]

        imports, stats, conflicts = supplement.classify_scope(
            [self.element()], candidates, 41.5)

        self.assertEqual(imports, [])
        self.assertEqual(stats['ambiguous_skipped'], 1)
        self.assertEqual(len(conflicts), 2)
        self.assertEqual({c.source_id for c in conflicts}, {'fsq1', 'fsq2'})
        for conflict in conflicts:
            self.assertEqual(conflict.conflict_class, 'ambiguous')
            self.assertEqual(conflict.osm_element_id, 'node/1')

    def test_a_single_confident_match_is_not_a_conflict(self):
        imports, stats, conflicts = supplement.classify_scope(
            [self.element()], [self.candidate('fsq1', 'Café Central')], 41.5)

        self.assertEqual(imports, [])
        self.assertEqual(stats.get('ambiguous_skipped', 0), 0)
        self.assertEqual(conflicts, [])

    def test_no_candidates_means_an_import_and_no_conflict(self):
        imports, _stats, conflicts = supplement.classify_scope(
            [self.element()], [], 41.5)

        self.assertEqual(len(imports), 1)
        self.assertEqual(conflicts, [])


class Kan408ImporterCoverageTest(unittest.TestCase):
    """KAN-408 — every app type the importer claims to supply, it must ask for.

    The app gaining a type does nothing on its own. If the Overpass query
    never requests the tag, the type is one the app can express and the
    database can never hold — the same defect KAN-412 named, from the other
    side.
    """

    def test_every_tag_rule_is_actually_requested(self):
        query = supplement.osm_query(41.0, 41.1, -8.5, -8.4)
        for key, value, poi_type in supplement.TAG_TYPES:
            if key == 'shop':
                # The blanket shop selector covers every shop value.
                self.assertIn('"shop"', query)
                continue
            self.assertIn(f'"{key}"', query, f'{key}={value} ({poi_type}) never requested')
            self.assertIn(value, query, f'{key}={value} ({poi_type}) never requested')

    def test_the_nature_types_reach_the_importer(self):
        # praia fluvial is the case that exposed this: Foursquare had 160
        # typed `beach`, OSM had zero, because natural=beach was not asked
        # for and no OSM beach could ever be imported.
        mapped = {poi_type: (key, value) for key, value, poi_type in supplement.TAG_TYPES}
        for poi_type, expected in [
            ('beach', ('natural', 'beach')),
            ('viewpoint', ('tourism', 'viewpoint')),
            ('waterfall', ('waterway', 'waterfall')),
            ('lighthouse', ('man_made', 'lighthouse')),
            ('theatre', ('amenity', 'theatre')),
        ]:
            self.assertEqual(mapped.get(poi_type), expected, poi_type)

    def test_the_query_never_asks_for_a_bare_key(self):
        # `natural` alone would pull every tree and pond in the bbox. Only
        # `shop` is deliberately blanket, and it predates this.
        query = supplement.osm_query(41.0, 41.1, -8.5, -8.4)
        for key in ('natural', 'tourism', 'historic', 'man_made', 'place', 'waterway', 'leisure', 'amenity'):
            self.assertNotIn(f'nwr["{key}"]', query, f'{key} is requested unscoped')
