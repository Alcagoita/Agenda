import csv
import os
import sys
import tempfile
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)


class ReportTest(unittest.TestCase):
    def test_rejects_an_output_path_that_resolves_to_the_input(self):
        import report_overture_backlog as report
        with tempfile.NamedTemporaryFile('w', suffix='.csv', delete=False) as handle:
            handle.write('overture_id,name\n1,Shop\n')
            path = handle.name
        try:
            with self.assertRaisesRegex(ValueError, 'must be different'):
                report.write_report(path, path)
            with open(path) as handle:
                self.assertIn('overture_id', handle.read())
        finally:
            os.unlink(path)

    def test_builds_optional_indexes_once_and_reuses_them_for_all_rows(self):
        import report_overture_backlog as report
        calls = []
        originals = {name: getattr(report, name) for name in (
            'category_map', 'reachable_types', 'load_brand_dictionary',
            'store_kind_alias_index', 'food_cuisine_alias_index',
            'load_financial_service_name_rules', 'store_brand_index', 'decide')}
        report.category_map = lambda: {}
        report.reachable_types = lambda: {}
        report.load_brand_dictionary = lambda: {}
        report.store_kind_alias_index = lambda: {'store': []}
        report.food_cuisine_alias_index = lambda: {'food': []}
        report.load_financial_service_name_rules = lambda: {'atm': []}
        report.store_brand_index = lambda: [('kind', 'Brand', 'brand')]
        report.decide = lambda *args: (calls.append(args[4:]) or ('pending', (), (), None))
        with tempfile.NamedTemporaryFile('w', suffix='.csv', delete=False, newline='') as handle:
            csv.DictWriter(handle, fieldnames=('overture_id', 'name')).writeheader()
            csv.DictWriter(handle, fieldnames=('overture_id', 'name')).writerows([{'overture_id': '1', 'name': 'A'}, {'overture_id': '2', 'name': 'B'}])
            path = handle.name
        try:
            list(report.unresolved_rows(path))
        finally:
            os.unlink(path)
            for name, value in originals.items(): setattr(report, name, value)
        self.assertEqual(calls, [calls[0], calls[0]])
        self.assertEqual(calls[0], ({'store': []}, {'food': []}, {'atm': []}, [('kind', 'Brand', 'brand')]))


if __name__ == '__main__':
    unittest.main()
