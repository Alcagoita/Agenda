import os
import sys
import types
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)

# The production Container installs requests. Keep these parser/SQL unit tests
# runnable on a bare local Python too; they never perform an HTTP request.
try:
    import requests  # noqa: F401
except ModuleNotFoundError:
    requests_stub = types.ModuleType('requests')
    requests_stub.RequestException = Exception
    requests_stub.post = lambda *args, **kwargs: None
    sys.modules['requests'] = requests_stub

import settlement_registry


class SettlementRegistryTest(unittest.TestCase):
    def test_parses_real_bounded_settlements_and_rejects_point_only_records(self):
        payload = {
            'elements': [
                {
                    'type': 'relation', 'id': 123, 'tags': {'name': 'Porto', 'boundary': 'administrative', 'admin_level': '7'},
                    'bounds': {'minlat': 41.1, 'maxlat': 41.2, 'minlon': -8.7, 'maxlon': -8.5},
                },
                {
                    'type': 'relation', 'id': 456, 'tags': {'name': 'Sintra', 'place': 'town'},
                    'bounds': {'minlat': 38.75, 'maxlat': 38.85, 'minlon': -9.5, 'maxlon': -9.3},
                },
                {'type': 'node', 'id': 789, 'tags': {'name': 'Point Village', 'place': 'village'}},
            ],
        }

        settlements, skipped = settlement_registry.settlements_from_overpass(payload)

        self.assertEqual([settlement.place_id for settlement in settlements], ['osm-relation-123', 'osm-relation-456'])
        self.assertEqual(settlements[0].place_kind, 'municipality')
        self.assertEqual(settlements[1].place_kind, 'town')
        self.assertEqual(skipped, 1)

    def test_upsert_sql_preserves_lifecycle_and_writes_real_bounds(self):
        settlement = settlement_registry.Settlement('osm-relation-123', "D'Example", 'municipality', 1, 2, 3, 4)

        sql = next(iter(settlement_registry.settlement_upsert_sql('PT', [settlement])))

        self.assertIn("'D''Example'", sql)
        self.assertIn("'mapped'", sql)
        self.assertIn('min_lat = excluded.min_lat', sql)
        self.assertNotIn('status = excluded.status', sql)

    def test_country_query_is_limited_to_real_areas(self):
        query = settlement_registry.country_query('pt')

        self.assertIn('ISO3166-1"="PT', query)
        self.assertIn('admin_level=7', query)
        self.assertNotIn('node(area.country)', query)

    def test_rejects_invalid_country_codes(self):
        with self.assertRaises(ValueError):
            settlement_registry.country_query('Portugal')
