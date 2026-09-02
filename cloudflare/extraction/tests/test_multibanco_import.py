import sys
import types
import unittest
from unittest.mock import patch

import multibanco_import


class MultibancoImportTest(unittest.TestCase):
    def test_fetch_streams_the_full_array_without_using_response_content(self):
        class Response:
            status_code = 200
            headers = {}
            closed = False

            def raise_for_status(self):
                return None

            def iter_content(self, chunk_size):
                self.chunk_size = chunk_size
                yield b'[{"name":"MULTIBANCO"},null]'

            def close(self):
                self.closed = True

        response = Response()
        calls = []
        requests = types.SimpleNamespace(get=lambda *args, **kwargs: (calls.append((args, kwargs)) or response))
        with patch.dict(sys.modules, {'requests': requests}):
            _, payload = multibanco_import.fetch_markers(38.0, 38.1, -9.2, -9.1)

        self.assertEqual(payload, [{'name': 'MULTIBANCO'}, None])
        self.assertTrue(calls[0][1]['stream'])
        self.assertEqual(response.chunk_size, 64 * 1024)
        self.assertTrue(response.closed)

    def test_fetch_closes_the_stream_before_rejecting_an_oversized_body(self):
        class Response:
            status_code = 200
            headers = {}
            closed = False

            def raise_for_status(self):
                return None

            def iter_content(self, chunk_size):
                yield b'a' * multibanco_import.MAX_RESPONSE_BYTES
                yield b'b'

            def close(self):
                self.closed = True

        response = Response()
        requests = types.SimpleNamespace(get=lambda *_args, **_kwargs: response)
        with patch.dict(sys.modules, {'requests': requests}):
            with self.assertRaisesRegex(ValueError, 'safe viewport limit'):
                multibanco_import.fetch_markers(38.0, 38.1, -9.2, -9.1)

        self.assertTrue(response.closed)

    def test_stable_source_identity_and_marker_validation(self):
        markers, rejected, duplicates = multibanco_import.parse_markers([
            {'name': 'MULTIBANCO', 'address': 'Rua Árvore', 'lat': '38.792331', 'lng': '-9.171947'},
            {'name': 'MULTIBANCO', 'address': 'Rua Árvore', 'lat': '38.792331', 'lng': '-9.171947'},
            {'name': '', 'address': 'Broken', 'lat': '38.7', 'lng': '-9.1'},
            None,
            'not a marker',
        ])
        self.assertEqual(len(markers), 1)
        self.assertEqual(rejected, 3)
        self.assertEqual(duplicates, 1)
        self.assertEqual(markers[0].source_id, 'multibanco:multibanco:rua arvore:38.79233:-9.17195')
        self.assertEqual(multibanco_import.encode_geohash(markers[0].lat, markers[0].lng), 'eyckxmc')

    def test_generated_sql_preserves_raw_provenance_and_is_idempotent(self):
        marker = multibanco_import.parse_markers([
            {'name': 'MULTIBANCO', 'address': "Metro d'Odivelas", 'lat': 38.792331, 'lng': -9.171947},
        ])[0][0]
        statements = multibanco_import.statements_for_marker(
            marker, 'relation/5400891', 'https://example.test/locator',
            {'minLat': 38.7, 'maxLat': 38.8, 'minLng': -9.2, 'maxLng': -9.1}, '2026-09-02T12:00:00.000Z',
        )
        self.assertEqual(len(statements), 2)
        self.assertIn('multibanco_import_staging', statements[0])
        self.assertIn('ON CONFLICT(source_id) DO UPDATE', statements[0])
        self.assertIn('multibanco_poi', statements[1])
        self.assertIn("'atm'", statements[1])
        self.assertIn("Metro d''Odivelas", statements[1])


if __name__ == '__main__':
    unittest.main()
