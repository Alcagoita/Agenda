"""Country promotion is paged and checkpoints after each page."""
import os
import sys
import types
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
        import promote_overture_candidates as promote
        rows = [row('gers-1', 'Farmácia Nabais', 'pharmacy')]
        d1_client = types.SimpleNamespace(execute=mock.Mock())
        with (
            mock.patch.dict(sys.modules, {'d1_client': d1_client}),
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
        ):
            self.assertEqual(
                promote.run_country(1, 'overture-country-sources/PT/run.csv'),
                {'promoted': 1})

        statements = [call.args[0] for call in d1_client.execute.call_args_list]
        self.assertTrue(statements[0].startswith('INSERT OR IGNORE INTO overture_poi '))
        self.assertTrue(statements[1].startswith('INSERT OR IGNORE INTO overture_poi_type '))
        self.assertIn("UPDATE overture_candidate SET promotion_status = 'promoted'", statements[-1])

    def test_reviewed_overrides_read_only_the_explicit_batch(self):
        import promote_overture_candidates as promote
        reviewed = {'reviewed-1': {
            'poi_type': 'store', 'store_kind': 'books',
            'reason': 'reviewed Books batch: bookshop',
        }}
        d1_client = types.SimpleNamespace(
            select=mock.Mock(return_value=[row('reviewed-1', 'Livraria Exemplo', 'shopping')]),
            execute=mock.Mock(),
        )
        with (
            mock.patch.dict(sys.modules, {'d1_client': d1_client}),
            mock.patch.object(promote, 'candidate_overrides', return_value=reviewed),
            mock.patch.object(promote, 'category_map', return_value={}),
            mock.patch.object(promote, 'reachable_types', return_value={'store': 'store'}),
            mock.patch.object(promote, 'load_brand_dictionary', return_value={}),
            mock.patch.object(promote, 'store_kind_alias_index', return_value=[]),
            mock.patch.object(promote, 'food_cuisine_alias_index', return_value=[]),
            mock.patch.object(promote, 'load_financial_service_name_rules', return_value={}),
            mock.patch.object(promote, 'store_brand_index', return_value=[]),
        ):
            self.assertEqual(
                promote.run_country_overrides('overture-country-sources/PT/run.csv', 'books'),
                {'promoted': 1})

        self.assertIn("overture_id IN ('reviewed-1')", d1_client.select.call_args.args[0])
        statements = [call.args[0] for call in d1_client.execute.call_args_list]
        self.assertTrue(statements[0].startswith('INSERT OR IGNORE INTO overture_poi '))
        self.assertIn("'store_kind','books'", statements[2])
        self.assertIn("promotion_status = 'promoted'", statements[-1])


if __name__ == '__main__':
    unittest.main()
