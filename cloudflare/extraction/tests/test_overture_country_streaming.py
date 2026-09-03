"""Country promotion is paged and checkpoints after each page."""
import os
import sys
import unittest
from unittest import mock

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)


def row(overture_id, name, category):
    return {
        'overture_id': overture_id, 'name': name, 'lat': 38.79, 'lng': -9.17,
        'address': None, 'category': category, 'category_path': None,
        'confidence': 0.9, 'source_datasets': None,
    }


class CountryStreamingTest(unittest.TestCase):
    def test_page_writes_serving_rows_before_its_status_checkpoint(self):
        import d1_client
        import promote_overture_candidates as promote
        rows = [row('gers-1', 'Farmácia Nabais', 'pharmacy')]
        with (
            mock.patch.object(promote, 'paged', return_value=iter(rows)),
            mock.patch.object(promote, 'category_map', return_value={
                'pharmacy': {'poi_type': 'pharmacy'},
            }),
            mock.patch.object(promote, 'reachable_types', return_value={
                'pharmacy': 'pharmacy',
            }),
            mock.patch.object(promote, 'load_brand_dictionary', return_value={}),
            mock.patch.object(promote, 'store_kind_alias_index', return_value=[]),
            mock.patch.object(promote, 'food_cuisine_alias_index', return_value=[]),
            mock.patch.object(promote, 'load_financial_service_name_rules', return_value={}),
            mock.patch.object(promote, 'store_brand_index', return_value=[]),
            mock.patch.object(d1_client, 'execute') as execute,
        ):
            self.assertEqual(
                promote.run_country(1, 'overture-country-sources/PT/run.csv'),
                {'promoted': 1})

        statements = [call.args[0] for call in execute.call_args_list]
        self.assertTrue(statements[0].startswith('INSERT OR IGNORE INTO overture_poi '))
        self.assertTrue(statements[1].startswith('INSERT OR IGNORE INTO overture_poi_type '))
        self.assertIn("UPDATE overture_candidate SET promotion_status = 'promoted'", statements[-1])


if __name__ == '__main__':
    unittest.main()
