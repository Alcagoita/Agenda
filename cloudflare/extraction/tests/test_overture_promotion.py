"""KAN-431 — what promote_overture_candidates.decide() is allowed to conclude.

The promotion has two ways in, and the ORDER between them is the whole
design: the category is the source's considered answer, the name is an
inference from a string, and the name may only add — except for Overture's
hair-and-beauty bucket, where measuring Odivelas showed the category is a
shrug and the name is the real answer.

Those two rules pull in opposite directions, so both need a test that fails
if someone widens NAME_OUTRANKS_CATEGORY without meaning to.
"""
import os
import sys
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)


def _row(name, category, **overrides):
    row = {
        'overture_id': 'gers-1', 'name': name, 'lat': 38.79, 'lng': -9.17,
        'address': None, 'category': category, 'confidence': 0.9,
        'source_datasets': 'Overture|meta',
    }
    row.update(overrides)
    return row


class DecideTest(unittest.TestCase):
    def setUp(self):
        import analyse_poi_candidates as analyse
        import promote_overture_candidates as promote
        from classify_and_load import load_brand_dictionary
        self.promote = promote
        self.analyse = analyse
        # reachable_types() reads `type_relation` from live D1. A unit test
        # must not depend on the network; the two bridges that matter here
        # are stubbed, matching test_overture_categories.py.
        self._real_pairs = analyse._type_relation_pairs
        analyse._type_relation_pairs = lambda: [
            ('fitness_center', 'gym'), ('grocery_store', 'supermarket'),
        ]
        self.reachable = analyse.reachable_types()
        self.mapping = promote.category_map()
        self.brands = load_brand_dictionary()

    def tearDown(self):
        self.analyse._type_relation_pairs = self._real_pairs

    def decide(self, name, category):
        return self.promote.decide(
            _row(name, category), self.mapping, self.reachable, self.brands)

    def test_a_mapped_category_promotes_to_its_type(self):
        status, types, attributes, reason = self.decide('Farmácia Nabais', 'pharmacy')
        self.assertEqual(status, 'promoted')
        self.assertEqual(types[0], 'pharmacy')
        self.assertEqual(reason, 'category: pharmacy')

    def test_a_store_category_carries_its_subtype(self):
        # `store` is the one type a task cannot be created for without a
        # subtype, so losing the attribute makes the row unreachable.
        status, types, attributes, _ = self.decide('Movel Forte', 'hardware_store')
        self.assertEqual(status, 'promoted')
        self.assertEqual(types[0], 'store')
        self.assertIn(('store_kind', 'hardware'), attributes)

    def test_an_unmapped_category_with_a_silent_name_stays_pending(self):
        # Pending is countable, which is the point of staging: the next
        # mapping decision comes from what arrived, not from a taxonomy.
        # Not `hotel`: that one has been ruled on and is now rejected.
        # Pending is for categories nobody has decided about yet.
        status, types, attributes, reason = self.decide(
            'Junta de Freguesia', 'central_government_office')
        self.assertEqual(status, 'pending')
        self.assertEqual(types, ())
        self.assertIsNone(reason)

    def test_the_name_supplies_a_store_kind_the_category_could_not(self):
        # KAN-340's fallback, the one classify_and_load already runs for
        # Foursquare. `papelaria` is an alias of `books` in the app's own
        # dictionary, so this subtype is looked up, never invented.
        # A category Overture does not have. Its real shopping leaves are all
        # mapped now, each keeping its own kind, so the fallback only has to
        # cover what the source could not name at all.
        status, types, attributes, _ = self.decide('Papelaria Trevo', 'unmapped_shop_xyz')
        self.assertEqual(status, 'promoted')
        self.assertEqual(types, ('store',))
        self.assertIn(('store_kind', 'books'), attributes)

    def test_a_store_no_name_can_qualify_stays_pending(self):
        # Reachability is the bar: a `store` with no subtype answers no
        # search, so pending keeps it countable rather than invisible.
        status, types, _, _ = self.decide('Zee', 'unmapped_category_xyz')
        self.assertEqual(status, 'pending')
        self.assertEqual(types, ())

    def test_a_rejected_category_is_rejected_whatever_the_name_says(self):
        # Letting a name keyword rescue a ruled-out category would reopen
        # the decision one row at a time.
        status, types, _, reason = self.decide('Clínica Farmácia Silva', 'dentist')
        self.assertEqual(status, 'rejected')
        self.assertEqual(types, ())
        self.assertEqual(reason, 'rejected category: dentist')

    def test_a_housing_development_is_not_a_landmark(self):
        status, _, _, reason = self.decide(
            'Urbanização da Quinta Nova', 'landmark_and_historical_building')
        self.assertEqual(status, 'rejected')
        self.assertEqual(reason, 'housing development, not a place')

    def test_a_venue_inside_a_development_is_kept(self):
        # The prefix match is what makes this safe: here the word locates a
        # real café rather than naming the estate itself.
        status, types, _, _ = self.decide('Café da Urbanização Nova', 'cafe')
        self.assertEqual(status, 'promoted')
        self.assertEqual(types[0], 'cafe')

    def test_a_store_that_has_a_subtype_still_promotes(self):
        status, types, attributes, _ = self.decide('Movel Forte', 'hardware_store')
        self.assertEqual(status, 'promoted')
        self.assertEqual(types[0], 'store')
        self.assertIn(('store_kind', 'hardware'), attributes)

    def test_a_name_replaces_a_bare_store_with_a_specific_type(self):
        mapping = {**self.mapping, 'generic_store': {'poi_type': 'store'}}
        status, types, attributes, reason = self.promote.decide(
            _row('Pizzaria Angelus', 'generic_store'), mapping, self.reachable, self.brands)
        self.assertEqual(status, 'promoted')
        self.assertEqual(types, ('restaurant',))
        self.assertNotIn(('store_kind', 'pizza'), attributes)
        self.assertEqual(reason, 'name replaces generic store: restaurant')

    def test_a_restaurant_name_recovers_a_missing_cuisine(self):
        status, types, attributes, _ = self.decide('Noori Sushi', 'restaurant')
        self.assertEqual(status, 'promoted')
        self.assertIn('restaurant', types)
        self.assertIn(('food_cuisine', 'sushi'), attributes)

    def test_official_multibanco_source_owns_generic_overture_atms(self):
        status, types, attributes, reason = self.decide('ATM Multibanco', 'atms')
        self.assertEqual(status, 'rejected')
        self.assertEqual(types, ())
        self.assertEqual(attributes, ())
        self.assertEqual(reason, 'ATM reserved for official Multibanco source')

    def test_explicit_non_multibanco_operator_remains_an_atm(self):
        status, types, _, _ = self.decide('Euronet ATM', 'atms')
        self.assertEqual(status, 'promoted')
        self.assertEqual(types, ('atm',))

    def test_financial_name_rules_apply_to_overture_rows(self):
        status, types, attributes, _ = self.decide('Western Union - Faro', 'banks')
        self.assertEqual(status, 'promoted')
        self.assertEqual(types[0], 'money_transfer')
        self.assertNotIn('bank', types)
        self.assertEqual(attributes, ())

    def test_an_unnamed_row_is_rejected(self):
        status, types, _, reason = self.decide('   ', 'pharmacy')
        self.assertEqual(status, 'rejected')
        self.assertEqual(types, ())
        self.assertEqual(reason, 'unnamed')

    def test_the_name_can_be_the_sole_basis_when_no_category_maps(self):
        # Departs from types_from_name's own "never the sole basis" rule.
        # That rule protects OSM, where the alternative is admitting an
        # element nothing identified as a place. An Overture candidate is
        # already a known place; only its type is open.
        # A category Overture does not have, so only the name can answer.
        # Not a real food category: those are all mapped now, one to one.
        status, types, _, reason = self.decide('Talho Halal Barakah', 'unmapped_category_xyz')
        self.assertEqual(status, 'promoted')
        self.assertEqual(types[0], 'butcher')
        self.assertEqual(reason, 'name: butcher')

    def test_the_name_adds_to_a_mapped_category_but_never_outranks_it(self):
        # The category mapped, so it stays rank 0 — rank 0 becomes
        # primary_poi_type, which is what the app shows.
        status, types, _, reason = self.decide('Pastelaria Gomes', 'cafe')
        self.assertEqual(status, 'promoted')
        self.assertEqual(types[0], 'cafe')
        self.assertIn('bakery', types)
        self.assertEqual(reason, 'category: cafe')

    def test_the_name_outranks_the_hair_and_beauty_shrug(self):
        # Of 401 Odivelas rows filed `spas`, 86 were named "Cabeleireiro".
        # These are four distinct errands (KAN-401) and the category cannot
        # tell them apart, so here the name goes FIRST rather than joining.
        status, types, _, reason = self.decide('Barbearia do Zé', 'spas')
        self.assertEqual(status, 'promoted')
        self.assertEqual(types[0], 'barber')
        self.assertEqual(reason, 'name over category spas: barber')

    def test_the_override_does_not_lose_the_category_type(self):
        # Outranking re-ranks; it must not drop what the category said.
        _, types, _, _ = self.decide('Cabeleireiro Ana', 'beauty_salon')
        self.assertEqual(types[0], 'hairdresser')
        self.assertIn('salon', types)

    def test_the_override_is_narrow(self):
        """Everywhere outside the hair/beauty bucket the category wins.

        If this fails, someone widened NAME_OUTRANKS_CATEGORY, and a name
        keyword can now demote a category the source was confident about.
        """
        self.assertEqual(
            self.promote.NAME_OUTRANKS_CATEGORY,
            frozenset({'spas', 'beauty_salon', 'hair_salon', 'barber',
                       'personal_or_beauty_service', 'personal_care_services'}))
        _, types, _, _ = self.decide('Pastelaria Gomes', 'pharmacy')
        self.assertEqual(types[0], 'pharmacy')


class ViewpointTest(DecideTest):
    """KAN-431 — a miradouro is recovered by name, but only on an outdoor host."""

    def test_a_landmark_named_miradouro_gains_viewpoint(self):
        _, types, _, _ = self.decide(
            'Miradouro da Senhora do Monte', 'landmark_and_historical_building')
        self.assertEqual(types[0], 'historical_landmark')
        self.assertIn('viewpoint', types)

    def test_a_cafe_named_miradouro_does_not(self):
        # The kiosk AT the viewpoint is not the viewpoint. Someone looking
        # for a view must not be sent to a coffee counter.
        _, types, _, _ = self.decide('Quiosque do Miradouro', 'coffee_shop')
        self.assertEqual(types[0], 'cafe')
        self.assertNotIn('viewpoint', types)

    def test_a_bar_named_miradouro_does_not(self):
        _, types, _, _ = self.decide('Bar Miradouro', 'bar')
        self.assertNotIn('viewpoint', types)


class BackfillTest(unittest.TestCase):
    def test_generic_overture_atms_are_suppressed_without_deleting_the_row(self):
        import backfill_overture_classification as backfill
        import analyse_poi_candidates as analyse

        original_pairs = analyse._type_relation_pairs
        analyse._type_relation_pairs = lambda: []
        try:
            sql = ''.join(backfill.statements([{
                'overture_id': 'gers-atm', 'name': 'ATM Multibanco', 'category': 'atms',
                'primary_poi_type': 'atm', 'types': 'atm', 'max_rank': 0, 'attributes': None,
            }]))
        finally:
            analyse._type_relation_pairs = original_pairs
        self.assertIn("INSERT INTO poi_source_correction", sql)
        self.assertIn("'overture','gers-atm',0", sql)
        self.assertNotIn('DELETE FROM overture_poi;', sql)


if __name__ == '__main__':
    unittest.main()
