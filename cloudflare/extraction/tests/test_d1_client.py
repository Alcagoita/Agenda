"""D1 SQL-file execution keeps its transport batches explicitly bounded."""
import os
import sys
import tempfile
import unittest
from unittest import mock

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)

try:
    import requests  # noqa: F401
except ImportError:
    import types
    requests = types.ModuleType('requests')
    requests.post = None
    sys.modules['requests'] = requests

import d1_client  # noqa: E402


class ExecuteSqlFileTest(unittest.TestCase):
    def test_honours_requested_transport_batch_size(self):
        with tempfile.NamedTemporaryFile('w', delete=False) as handle:
            handle.write('INSERT 1;\nINSERT 2;\nINSERT 3;\n')
            path = handle.name
        try:
            with mock.patch.object(d1_client, 'execute_many') as execute_many:
                d1_client.execute_sql_file(path, statements_per_request=1)
            self.assertEqual(
                [tuple(call.args[0]) for call in execute_many.call_args_list],
                [('INSERT 1;',), ('INSERT 2;',), ('INSERT 3;',)])
        finally:
            os.unlink(path)

    def test_rejects_an_out_of_range_transport_batch_size(self):
        with self.assertRaisesRegex(ValueError, 'between 1 and 50'):
            d1_client.execute_sql_file('unused.sql', statements_per_request=0)


if __name__ == '__main__':
    unittest.main()
