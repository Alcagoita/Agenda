"""KAN-409 — short, initial-shaped brands must not match unrelated names.

`normalize_text` collapses every non-alphanumeric character to a space, so
`C&A`, `C. A.` and the initials inside `C A Santos` all arrive as `c a`. A
padded-substring match then brands an electrical wholesaler, a car dealer or a
private individual as a clothing chain.

Every name below is real, taken from the production rows carrying these
brands.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from classify_and_load import (  # noqa: E402
    brand_form_matches, find_brand, is_ambiguous_brand_form,
    leads_with_tight_ampersand, load_brand_dictionary,
)

TYPES = ['store', 'restaurant', 'gas', 'supermarket', 'clothing_repair']


class AmbiguousFormTest(unittest.TestCase):
    def test_initials_and_two_letter_forms_are_ambiguous(self):
        for form in ['c a', 'h m', 'hm', 'bp', 'zu', 'a b c']:
            self.assertTrue(is_ambiguous_brand_form(form), form)

    def test_a_digit_makes_a_short_brand_safe(self):
        # Not initials, not a word. Requiring these to lead the name would
        # have unbranded "Café H3" for no gain — measured, not assumed.
        for form in ['h3', 'q8']:
            self.assertFalse(is_ambiguous_brand_form(form), form)

    def test_ordinary_brands_are_unaffected(self):
        for form in ['delta', 'costa coffee', 'pingo doce', 'continente']:
            self.assertFalse(is_ambiguous_brand_form(form), form)


class BrandMatchingTest(unittest.TestCase):
    def setUp(self):
        self.brands = load_brand_dictionary()

    def brand_for(self, name):
        return find_brand(name, TYPES, self.brands)

    def test_genuine_ampersand_stores_keep_their_brand(self):
        # Every one of these is a real store: bare, a sub-brand, a mall
        # branch with a comma and one without.
        for name in ['C&A', 'C&A Portimao', 'C&A Massamá', 'C&A Kids Store',
                     'C&a, Arrabida Shopping', 'C&A, Braga Parque',
                     'H&M', 'H&M HOME', 'H&M Store', 'H&M Mar Shopping',
                     'H&M, Algarve Shopping']:
            self.assertIn(self.brand_for(name), ('C&A', 'H&M'), name)

    def test_a_spaced_ampersand_is_two_initials_not_a_chain(self):
        # In Portuguese company names "C & A" is normally two initials joined
        # by an "and". Across every row we hold, no genuine store writes it
        # that way and every spaced instance is a different business.
        for name in ['C & A Modas, Unipessoal',
                     'C & A Costa - materiais construçao',
                     'C & A - Modas',
                     'Modas Lda & C, C & A']:
            self.assertIsNone(self.brand_for(name), name)

    def test_initials_in_a_company_or_personal_name_are_not_a_brand(self):
        for name in ['C A Santos - Comércio de Electrodomésticos',
                     'C. A. Produções - Equipamentos de Som e Iluminação, Unip.',
                     'Maria C A M Pinto Lavrador',
                     'Mercado Abastecedor C.A.P.A',
                     'C A F Assistência A Elevadores',
                     'Ourivesaria João C A Baptista']:
            self.assertIsNone(self.brand_for(name), name)

    def test_the_car_dealers_that_normalized_to_the_same_initials(self):
        # C.A.M. is a dealer group. Five rows, five wrong brands.
        for marque in ['Ford', 'Fiat', 'Citröen', 'Mitsubishi']:
            self.assertIsNone(self.brand_for(f'C.A.M. {marque}'))

    def test_the_bare_alias_cannot_smuggle_a_match_past_the_ampersand_rule(self):
        # `HM` is an alias of H&M and carries no ampersand of its own. The
        # rule is checked against the CANONICAL brand for exactly this reason.
        for name in ['HM Telecom', 'HM-Motos', 'Óptica HM', 'Garagem HM',
                     'H.M. Cork - Comércio e Indústria de Cortiça', 'Hm Impor']:
            self.assertIsNone(self.brand_for(name), name)

    def test_an_ampersand_elsewhere_in_the_name_is_not_enough(self):
        # Has an ampersand, but the brand does not lead the name.
        self.assertIsNone(self.brand_for('RS & HM - Material Eléctrico'))

    def test_the_tight_form_must_end_on_a_word_boundary(self):
        self.assertTrue(leads_with_tight_ampersand('C&A Kids Store', 'C&A'))
        self.assertTrue(leads_with_tight_ampersand('C&A, Braga Parque', 'C&A'))
        self.assertTrue(leads_with_tight_ampersand('  C&A', 'C&A'))
        # Case-insensitive: the source writes it however it likes.
        self.assertTrue(leads_with_tight_ampersand('C&a, Arrabida Shopping', 'C&A'))
        # Must not run into a longer word.
        self.assertFalse(leads_with_tight_ampersand('C&American Diner', 'C&A'))
        # Must lead.
        self.assertFalse(leads_with_tight_ampersand('Loja C&A', 'C&A'))

    def test_digit_brands_still_match_anywhere_in_the_name(self):
        self.assertEqual(self.brand_for('Café H3'), 'H3')
        self.assertEqual(self.brand_for('New Hamburgology H3'), 'H3')
        self.assertEqual(self.brand_for('H3 Hambúrguer Gourmet'), 'H3')

    def test_leading_two_letter_brands_still_match(self):
        self.assertEqual(self.brand_for('BP Famalicão'), 'BP')

    def test_ordinary_brands_still_match_mid_name(self):
        # The strict path must not leak into normal brands — they are the
        # overwhelming majority and their behaviour is unchanged.
        self.assertEqual(self.brand_for('Supermercado Pingo Doce Belém'), 'Pingo Doce')


class FormMatchingUnitTest(unittest.TestCase):
    def test_ampersand_requirement_reads_the_canonical_brand_not_the_alias(self):
        # `HM` is an alias of H&M carrying no ampersand of its own. The rule
        # is checked against the canonical brand, so the alias cannot be the
        # way in.
        self.assertFalse(brand_form_matches('hm', 'hm telecom', 'HM Telecom', 'H&M'))
        self.assertTrue(brand_form_matches('hm', 'h m home', 'H&M HOME', 'H&M'))

    def test_a_non_ambiguous_form_keeps_the_substring_rule(self):
        self.assertTrue(brand_form_matches(
            'pingo doce', 'supermercado pingo doce belem',
            'Supermercado Pingo Doce Belém', 'Pingo Doce'))


if __name__ == '__main__':
    unittest.main()
