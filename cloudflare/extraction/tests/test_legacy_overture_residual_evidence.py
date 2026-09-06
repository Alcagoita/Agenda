import os
import sys
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)
import legacy_overture_residual_evidence as evidence


class LegacyEvidenceTest(unittest.TestCase):
    def test_query_is_source_scoped_and_exact_id_bounded(self):
        query = evidence.query_for_ids(['first-id', 'second-id'])
        self.assertIn("country_source_r2_key = 'overture-country-sources/PT/", query)
        self.assertIn("overture_id IN ('first-id','second-id')", query)
        self.assertNotIn("promotion_status = 'pending'", query)

    def test_only_accent_insensitive_exact_names_are_evidence(self):
        accepted = evidence.corroborated([
            {'overture_name': 'Óptica Central', 'legacy_name': 'Optica Central'},
            {'overture_name': 'Loja Central', 'legacy_name': 'Outra Loja'},
        ])
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]['overture_name'], 'Óptica Central')

    def test_wrangler_json_is_extracted_from_its_banner(self):
        rows = evidence.parse_wrangler_output('banner\n[{"results":[{"overture_id":"id"}]}]\n')
        self.assertEqual(rows, [{'overture_id': 'id'}])

