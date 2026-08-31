"""KAN-435 — the tenant comparison must never act on an uncertain match.

Every guard here exists because the first version of this comparison got it
wrong on real data, in a way that would have retired real shops.
"""
import os
import sys
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)

import mall_tenants

VDG = 'Centro Comercial Vasco da Gama'


def held(name, poi_type='restaurant'):
    return {'name': name, 'primary_poi_type': poi_type, 'lat': 38.767, 'lng': -9.097}


class TenantKeyTest(unittest.TestCase):
    def test_the_malls_own_name_is_not_part_of_a_tenants_identity(self):
        # "Amorino Gelato - Lisboa Vasco Da Gama" against "AMORINO - GELATO
        # AL NATURALE". Leaving the mall in cost 10 points of recall.
        mall = mall_tenants.mall_tokens(VDG)
        self.assertEqual(
            mall_tenants.tenant_key('Amorino Gelato - Lisboa Vasco Da Gama', mall),
            'amorino gelato')

    def test_a_name_that_is_only_noise_keeps_its_words(self):
        # Stripping everything would leave an empty key, and empty keys
        # match each other perfectly.
        mall = mall_tenants.mall_tokens(VDG)
        self.assertTrue(mall_tenants.tenant_key('Loja Vasco da Gama', mall))


class CompareTest(unittest.TestCase):
    def compare(self, tenants, rows, osm=(), mall=VDG, covers=mall_tenants.FOOD_TYPES):
        return mall_tenants.compare(list(tenants), list(rows), list(osm), mall, covers)

    def test_a_food_list_never_proposes_removing_a_shoe_shop(self):
        """The lists we have are the operators' EATING PLACES pages.

        Comparing the whole footprint against one proposed removing 91 rows
        at Vasco da Gama — every clothing shop, Fnac, Worten and the
        pharmacy. A list is an authority only over what it covers.
        """
        result = self.compare(['MCDONALD\'S'],
                              [held('Zara', 'store'), held('Fnac', 'store'),
                               held('Well\'s', 'pharmacy')])
        self.assertEqual(result['remove'], [])

    def test_a_second_row_of_a_listed_tenant_is_not_retired(self):
        """Each tenant claims one row, so a duplicate fell through to REMOVE.

        On Colombo that proposed retiring "Burger King Centro Comercial
        Colombo", "Cafe3", "Cervejaria Portugalia" and "Vitaminas &
        Companhia" — all on the operator's own list.
        """
        result = self.compare(
            ['BURGER KING'],
            [held('Burger King'), held('Burger King Centro Comercial Colombo')])
        self.assertEqual(result['remove'], [])

    def test_whitespace_is_not_identity(self):
        # "SushiCorner" is "Sushi Corner".
        result = self.compare(['SUSHI CORNER'], [held('SushiCorner')])
        self.assertEqual(result['remove'], [])

    def test_an_unlisted_row_is_proposed_for_removal(self):
        result = self.compare(['MCDONALD\'S'], [held('Tun Fon')])
        self.assertEqual([r['name'] for r in result['remove']], ['Tun Fon'])

    def test_a_weak_pairing_is_escalated_rather_than_added(self):
        """`FEEL RIO` must not become "Ambientes do Rio".

        Prefer missing a place over holding it twice: anything short of
        confident goes to a person, never to a silent ADD.
        """
        result = self.compare(['FEEL RIO'], [held('Ambientes do Rio | Lisbon')])
        added = [t for t, row in result['add'] if row is not None]
        self.assertEqual(added, [])

    def test_removal_escalates_on_weaker_evidence_than_matching(self):
        """The destructive direction is deliberately more cautious.

        At the matching threshold this still proposed removing "H3
        Hamburguer Gourmet", listed as "H3 - NEW HAMBURGOLOGY".
        """
        self.assertLess(mall_tenants.REMOVE_ESCALATE_THRESHOLD,
                        mall_tenants.ESCALATE_THRESHOLD)
        result = self.compare(['H3 - NEW HAMBURGOLOGY'],
                              [held('H3 Hamburguer Gourmet')])
        self.assertEqual(result['remove'], [])
        self.assertTrue(result['escalate'] or result['confident'])

    def test_a_tenant_no_source_can_place_is_never_invented(self):
        result = self.compare(['CAFE JERONYMO'], [], osm=[])
        unplaceable = [t for t, row in result['add'] if row is None]
        self.assertEqual(unplaceable, ['CAFE JERONYMO'])

    def test_osm_supplies_a_tenant_we_lack(self):
        result = self.compare(['TACO BELL'], [], osm=[{'name': 'Taco Bell'}])
        placeable = [(t, row['name']) for t, row in result['add'] if row is not None]
        self.assertEqual(placeable, [('TACO BELL', 'Taco Bell')])

    def test_nothing_is_mutated(self):
        rows = [held('Tun Fon')]
        before = [dict(r) for r in rows]
        self.compare(['MCDONALD\'S'], rows)
        self.assertEqual(rows, before)


if __name__ == '__main__':
    unittest.main()
