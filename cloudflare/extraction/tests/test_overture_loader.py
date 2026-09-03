"""KAN-431 — which Overture rows get staged, and which are dropped.

These drop rules are not cosmetic: the country load audits itself with
`offered + dropped == source_rows`, so anything silently skipped here would
make a truncated extract look like a complete import.
"""
import csv
import os
import sys
import tempfile
import unittest
from unittest import mock

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)

FIELDS = ('overture_id', 'name', 'lat', 'lng', 'address', 'locality',
          'category', 'basic_category', 'category_path', 'confidence',
          'source_datasets')


def _csv(rows):
    handle = tempfile.NamedTemporaryFile('w', suffix='.csv', delete=False,
                                         newline='')
    writer = csv.DictWriter(handle, fieldnames=FIELDS)
    writer.writeheader()
    for row in rows:
        writer.writerow({field: row.get(field, '') for field in FIELDS})
    handle.close()
    return handle.name


def _row(**overrides):
    row = {'overture_id': 'gers-1', 'name': 'Farmácia Nabais',
           'lat': '38.79', 'lng': '-9.17', 'category': 'pharmacy',
           'confidence': '0.9'}
    row.update(overrides)
    return row


class CandidateRowsTest(unittest.TestCase):
    def rows(self, raw):
        import load_overture_candidates as loader
        path = _csv(raw)
        try:
            return list(loader.candidate_rows(path))
        finally:
            os.unlink(path)

    def test_a_complete_row_is_staged(self):
        staged = self.rows([_row()])
        self.assertEqual(len(staged), 1)
        self.assertEqual(staged[0][0], 'gers-1')
        self.assertEqual(staged[0][1], 'Farmácia Nabais')

    def test_a_row_with_no_name_is_dropped(self):
        # A place with no name cannot be matched, shown, or judged later.
        self.assertEqual(self.rows([_row(name='')]), [])

    def test_a_row_with_no_position_is_dropped(self):
        # overture_poi is geohash-indexed; a row with no position would be
        # promoted and then be invisible to every search.
        self.assertEqual(self.rows([_row(lat='')]), [])
        self.assertEqual(self.rows([_row(lng='')]), [])

    def test_a_row_with_no_id_is_dropped(self):
        self.assertEqual(self.rows([_row(overture_id='')]), [])

    def test_a_repeated_gers_id_is_staged_once(self):
        # Overlapping pilot boxes return the same place twice. The database
        # would absorb it via INSERT OR IGNORE, but then `offered` would
        # overcount and the country audit's equality would be wrong.
        staged = self.rows([_row(), _row(name='Farmácia Nabais (dup)')])
        self.assertEqual(len(staged), 1)

    def test_a_missing_confidence_becomes_null_not_zero(self):
        # Zero is a real confidence value and would misreport the source.
        staged = self.rows([_row(confidence='')])
        self.assertIsNone(staged[0][9])

    def test_the_sources_own_values_are_preserved(self):
        staged = self.rows([_row(category='pharmacy',
                                 basic_category='drugstore',
                                 category_path='health|pharmacy',
                                 source_datasets='Overture|meta')])
        self.assertEqual(staged[0][6], 'pharmacy')
        self.assertEqual(staged[0][7], 'drugstore')
        self.assertEqual(staged[0][8], 'health|pharmacy')
        self.assertEqual(staged[0][10], 'Overture|meta')

    def test_country_load_streams_one_bounded_statement_at_a_time(self):
        import d1_client
        import load_overture_candidates as loader
        path = _csv([_row(overture_id='gers-1'), _row(overture_id='gers-2')])
        try:
            with mock.patch.object(d1_client, 'execute', return_value={'changes': 1}) as execute:
                self.assertEqual(loader.load(path, 'overture-country-sources/PT/run.csv'), 2)
            self.assertEqual(execute.call_count, 1)
            statement = execute.call_args.args[0]
            self.assertIn('ON CONFLICT(overture_id) DO UPDATE', statement)
            self.assertIn('overture-country-sources/PT/run.csv', statement)
        finally:
            os.unlink(path)


if __name__ == '__main__':
    unittest.main()
