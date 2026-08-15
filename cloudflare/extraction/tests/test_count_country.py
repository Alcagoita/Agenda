"""KAN-379 — country-source count diagnostic. Run: python3 tests/test_count_country.py"""
import contextlib
import io
import os
import sys
import unittest
from unittest.mock import patch

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)

import count_country


class FakeResult:
    def __init__(self, value):
        self.value = value

    def fetchone(self):
        return (self.value,)


class FakeConnection:
    def __init__(self):
        self.queries = []
        self.closed = False

    def execute(self, sql, parameters):
        self.queries.append((sql, parameters))
        return FakeResult(124 if 'list_has_any' in sql else 456)

    def close(self):
        self.closed = True


class CountryCountTest(unittest.TestCase):
    @patch.dict(os.environ, {'FOURSQUARE_JWT': 'test-jwt'}, clear=False)
    @patch.object(count_country, 'all_category_ids', return_value=['category-a', 'category-b'])
    def test_counts_supported_rows_without_writing(self, _categories):
        connection = FakeConnection()
        with patch.object(count_country, '_connect', return_value=connection) as connect:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                count_country.count('PT')

        connect.assert_called_once_with('test-jwt')
        self.assertEqual(len(connection.queries), 2)
        self.assertTrue(all('SELECT COUNT(*)' in sql for sql, _ in connection.queries))
        self.assertTrue(all(parameters == ['PT'] for _, parameters in connection.queries))
        self.assertIn("list_has_any(fsq_category_ids, ['category-a', 'category-b'])", connection.queries[1][0])
        self.assertTrue(connection.closed)
        self.assertEqual(
            output.getvalue().splitlines(),
            ['PT: 456 open places total', 'PT: 124 in our 2 ingested categories (apples-to-apples with D1)'],
        )

    @patch.dict(os.environ, {}, clear=True)
    def test_requires_foursquare_jwt(self):
        with self.assertRaisesRegex(SystemExit, 'FOURSQUARE_JWT not set'):
            count_country.count('PT')


if __name__ == '__main__':
    unittest.main()
