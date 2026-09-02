import unittest

import multibanco_import


class MultibancoImportTest(unittest.TestCase):
    def test_stable_source_identity_and_marker_validation(self):
        markers, rejected, duplicates = multibanco_import.parse_markers([
            {'name': 'MULTIBANCO', 'address': 'Rua Árvore', 'lat': '38.792331', 'lng': '-9.171947'},
            {'name': 'MULTIBANCO', 'address': 'Rua Árvore', 'lat': '38.792331', 'lng': '-9.171947'},
            {'name': '', 'address': 'Broken', 'lat': '38.7', 'lng': '-9.1'},
        ])
        self.assertEqual(len(markers), 1)
        self.assertEqual(rejected, 1)
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
