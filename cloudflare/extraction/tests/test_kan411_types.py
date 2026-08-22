import os
import sys
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)

import apply_kan411_types as K


def row(name, labels='', brand=None, primary='store'):
    return {'name': name, 'brand': brand, 'primary_poi_type': primary,
            'raw_category_labels': labels}


class Kan411TypeRulesTest(unittest.TestCase):
    """The rules that decide what a place IS. Every assertion here is a case
    that was measured in the data, not an invented one."""

    def types(self, *args, **kwargs):
        return K.types_for(row(*args, **kwargs))[0]

    def kinds(self, *args, **kwargs):
        return K.types_for(row(*args, **kwargs))[1]

    # ── the shop/repair split, which is the whole point ──────────────────

    def test_sapataria_is_a_shoe_shop_not_a_cobbler(self):
        # 346 rows say sapataria. Matching them as shoe_repair would send
        # someone with a broken heel to a shop that sells new ones — and
        # Foursquare files several of them under "Shoe Repair Service".
        self.assertEqual(
            self.types('Sapataria Ravel',
                       'Business and Professional Services > Shoe Repair Service'),
            set())
        self.assertEqual(self.types('Sapatarias Luis'), set())

    def test_sapateiro_is_the_cobbler(self):
        self.assertEqual(self.types('Sapateiro do Bairro'), {'shoe_repair'})
        self.assertEqual(self.types('Meias Solas e Chaves'), {'shoe_repair'})

    def test_retrosaria_and_tecidos_are_shops_not_alterations(self):
        # Both are filed under Tailor by Foursquare, and both sell cloth.
        self.assertEqual(
            self.types('Retrosaria Sarmento',
                       'Business and Professional Services > Tailor'),
            set())
        self.assertEqual(
            self.types('Modelina Tecidos',
                       'Business and Professional Services > Tailor'),
            set())

    def test_arranjos_and_costureira_are_alterations(self):
        self.assertEqual(self.types('Arranjos de Roupa da Ana'), {'clothing_repair'})
        self.assertEqual(self.types('Costureira Maria'), {'clothing_repair'})

    # ── word boundaries ──────────────────────────────────────────────────

    def test_matches_are_word_bounded(self):
        # "PlantaToo" is named in KAN-391's own source comment as the reason
        # its keywords use boundaries. Same class as "Drink" containing ink.
        self.assertEqual(self.types('PlantaToo'), set())
        self.assertEqual(self.types('Sapateirovsky Consulting'), set())

    # ── categories that ARE reliable ─────────────────────────────────────

    def test_tea_room_and_bubble_tea_become_tea(self):
        self.assertEqual(
            self.types('Casa de Cha', 'Dining and Drinking > Cafe, Coffee, and Tea House > Tea Room'),
            {'tea'})
        self.assertEqual(
            self.types('Chai Point', 'Dining and Drinking > Cafe, Coffee, and Tea House > Bubble Tea Shop'),
            {'tea'})

    def test_juice_bar_becomes_juice(self):
        self.assertEqual(
            self.types('O Suminho', 'Dining and Drinking > Juice Bar'), {'juice'})

    def test_liquor_and_phone_become_store_kinds_not_types(self):
        # These refine an existing `store`; they are not errands of their own.
        self.assertEqual(
            self.kinds('Garrafeira Ideal', 'Retail > Food and Beverage Retail > Liquor Store'),
            {'drinks'})
        self.assertEqual(
            self.kinds('Vodafone Colombo', 'Retail > Mobile Phone Store'), {'phone'})

    # ── brand-driven, and the multi-type case ────────────────────────────

    def test_worten_and_fnac_are_phone_repair_as_well_as_shops(self):
        # They sell electronics AND repair phones. Carrying one type when a
        # place qualifies for two makes it invisible to half its searches.
        self.assertEqual(
            self.types('Worten Colombo', 'Retail > Electronics Store', brand='Worten'),
            {'phone_repair'})
        self.assertEqual(self.types('Fnac Chiado', brand='Fnac'), {'phone_repair'})

    def test_a_phone_shop_that_does_not_repair_is_not_phone_repair(self):
        self.assertEqual(
            self.types('Gadget Fun', 'Retail > Mobile Phone Store'), set())

    # ── the categories that lie ──────────────────────────────────────────

    def test_the_computer_repair_category_is_never_used(self):
        # Sampled: mostly software houses, consultancies and a coworking
        # space. Three for three with Drugstore and Construction Supplies.
        self.assertEqual(
            self.types('Nexlogic - Business Solutions',
                       'Business and Professional Services > Computer Repair Service'),
            set())

    def test_construction_supplies_never_implies_hardware(self):
        # 94 of 6,747 were hardware shops; the rest are contractors.
        self.assertEqual(
            self.kinds('Fluxoterm - Climatizacao',
                       'Retail > Construction Supplies Store'),
            set())

    # ── no double-typing ─────────────────────────────────────────────────

    def test_does_not_repeat_a_type_the_row_already_has(self):
        self.assertEqual(
            self.types('Casa de Cha', 'Dining and Drinking > Cafe, Coffee, and Tea House > Tea Room',
                       primary='tea'),
            set())


if __name__ == '__main__':
    unittest.main()
