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

    def test_a_digit_can_be_the_whole_identity(self):
        """"CAFE 3" is not "Nosso Cafe".

        Dropping single-character tokens left `cafe`, which is contained in
        `nosso cafe` and scored 0.90 — a confident match to a unit on a
        different floor of Colombo. Single letters are apostrophe artefacts
        and initials; single digits are frequently the whole name.
        """
        mall = mall_tenants.mall_tokens('Centro Comercial Colombo')
        self.assertEqual(mall_tenants.tenant_key('CAFE 3', mall), 'cafe 3')
        _, score = mall_tenants.best_match(
            'CAFE 3', [{'name': 'Nosso Cafe'}], mall)
        self.assertLess(score, mall_tenants.CONFIDENT_THRESHOLD)

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

    def test_word_order_is_not_identity(self):
        """"Jeronymo Cafe" is "Cafe Jeronymo".

        We held it in Colombo while the tenant list proposed ADDing it — a
        duplicate, which is the failure this ticket exists to prevent.
        """
        result = self.compare(['CAFE JERONYMO'], [held('Jeronymo Cafe')],
                              osm=[{'name': 'Jeronymo'}])
        self.assertEqual([t for t, row in result['add'] if row is not None], [])
        self.assertEqual(result['remove'], [])

    def test_the_same_token_set_is_required_not_an_overlap(self):
        # Otherwise "Cafe 3" and "Nosso Cafe" would pair on a shared token.
        mall = mall_tenants.mall_tokens('Centro Comercial Colombo')
        _, score = mall_tenants.best_match('CAFE 3', [{'name': 'Nosso Cafe'}], mall)
        self.assertLess(score, mall_tenants.CONFIDENT_THRESHOLD)

    def test_two_tenants_cannot_share_one_osm_element(self):
        """NOORI LAB and NOORI POTS both resolved to a single "Noori".

        Adding both would place the same point twice. Neither is safe to
        pick automatically.
        """
        result = self.compare(['NOORI LAB', 'NOORI POTS'], [],
                              osm=[{'name': 'Noori'}])
        self.assertEqual([t for t, row in result['add'] if row is not None], [])
        self.assertTrue(any('one OSM element' in e[0] for e in result['escalate']))

    def test_an_unlisted_row_is_proposed_for_removal(self):
        result = self.compare(['MCDONALD\'S'], [held('Tun Fon')])
        self.assertEqual([r['name'] for r in result['remove']], ['Tun Fon'])

    def test_a_shared_distinctive_word_stops_a_removal(self):
        """"Livraria Bertrand" is the listed "BERTRAND LIVREIROS".

        It scored below every threshold — only one of two words matches —
        and was proposed for removal. A shared long word is weak evidence,
        too weak to merge two places on, but retiring a real shop is the
        worse error.

        This pair has since been ruled in decisions.md, so it now resolves
        as a confident match rather than a question. Either outcome is
        acceptable; being REMOVED is not.
        """
        result = self.compare(['BERTRAND LIVREIROS'],
                              [held('Livraria Bertrand', 'store')],
                              covers={'store'})
        self.assertEqual(result['remove'], [])
        self.assertTrue(result['confident'] or result['escalate'])

    def test_an_unruled_shared_word_still_escalates(self):
        # The guard itself, on a pair no ruling covers.
        result = self.compare(['QUEBRAMAR SPORTS'],
                              [held('Loja Quebramar', 'store')],
                              covers={'store'})
        self.assertEqual(result['remove'], [])
        self.assertTrue(result['confident'] or result['escalate'])

    def test_a_row_with_no_long_words_can_still_be_removed(self):
        # The guard must not swallow every removal: "Tun Fon" shares no
        # distinctive word with anything on the list.
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


class TenantListFormatTest(unittest.TestCase):
    """The list files carry a contract; nothing was enforcing it."""

    def write(self, text):
        import tempfile
        handle = tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False)
        handle.write(text)
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_a_unit_that_has_not_opened_is_not_a_place(self):
        """`|opening` marks an announced unit, and there are five of them.

        The rule was written in decisions.md and applied by hand, which is
        not enforcement — the next run would have added all five.
        """
        path = self.write("C&A|Piso 1\nBrownie|Piso 1|opening\n")
        self.assertEqual(mall_tenants.read_tenant_list(path), [('C&A', 'Piso 1')])

    def test_a_blank_floor_is_read_as_no_floor(self):
        # Written as a bare `Piso` in eight rows, which reads as a floor
        # named "Piso". The operator publishes none for these.
        path = self.write("AWA MASSAGE|\n")
        self.assertEqual(mall_tenants.read_tenant_list(path), [('AWA MASSAGE', '')])

    def test_the_shipped_lists_all_parse(self):
        lists = os.path.join(EXTRACTION_DIR, 'mall_lists')
        for name in os.listdir(lists):
            if not name.endswith('.txt'):
                continue
            rows = mall_tenants.read_tenant_list(os.path.join(lists, name))
            self.assertTrue(rows, name)
            for tenant, floor in rows:
                self.assertTrue(tenant.strip(), name)
                self.assertNotEqual(floor.strip().lower(), 'piso', name)


class ScopedDecisionsTest(unittest.TestCase):
    """A ruling is about one centre's shops, not a fact about the names."""

    def test_a_rebrand_at_one_mall_does_not_travel(self):
        # LEROY MERLIN is the AKI we hold at Colombo. Elsewhere they are two
        # real shops of the same chain and merging them would lose one.
        colombo = mall_tenants.confirmed_pairs(
            mall_name='Centro Comercial Colombo')
        vdg = mall_tenants.confirmed_pairs(
            mall_name='Centro Comercial Vasco da Gama')
        self.assertIn('leroy merlin', colombo)
        self.assertNotIn('leroy merlin', vdg)

    def test_a_ruling_marked_both_applies_at_either(self):
        for mall in ('Centro Comercial Colombo', 'Centro Comercial Vasco da Gama'):
            self.assertIn('pans company',
                          mall_tenants.confirmed_pairs(mall_name=mall))

    def test_omitting_the_mall_returns_every_ruling(self):
        every = mall_tenants.confirmed_pairs()
        scoped = mall_tenants.confirmed_pairs(mall_name='Strada Outlet Odivelas')
        self.assertGreater(len(every), len(scoped))


class OneRowOneTenantTest(unittest.TestCase):
    def test_two_tenants_cannot_claim_one_held_row(self):
        """The directory lists a chain twice; we hold one row.

        Both entries match it confidently, and the second silently took a
        floor belonging to the first. Neither is safe to pick.
        """
        result = mall_tenants.compare(
            ['Sacoor Brothers', 'Sacoor Brothers Woman'],
            [held('Sacoor Brothers', 'store')], [], VDG, {'store'})
        self.assertEqual(result['confident'], [])
        self.assertTrue(any('one held row' in e[0] for e in result['escalate']))

    def test_the_same_name_listed_twice_is_one_tenant(self):
        """Colombo lists TOP ATLANTICO twice; it is one shop, not a clash."""
        result = mall_tenants.compare(
            ['Wells', 'Wells'], [held('Wells', 'pharmacy')], [],
            VDG, {'pharmacy'})
        self.assertEqual(len(result['confident']), 1)
        self.assertEqual(result['escalate'], [])

    def test_a_row_contested_by_two_tenants_is_not_then_removed(self):
        # Escalating must not drop it back into REMOVE.
        result = mall_tenants.compare(
            ['Sacoor Brothers', 'Sacoor Brothers Woman'],
            [held('Sacoor Brothers', 'store')], [], VDG, {'store'})
        self.assertEqual(result['remove'], [])

    def test_distinct_tenants_keep_their_own_rows(self):
        result = mall_tenants.compare(
            ['Cafe do Ponto', 'Ponto do Cafe'],
            [held('Cafe do Ponto', 'cafe'), held('Ponto do Cafe', 'cafe')],
            [], VDG, {'cafe'})
        self.assertEqual(len(result['confident']), 2)
        self.assertEqual(result['remove'], [])


if __name__ == '__main__':
    unittest.main()
