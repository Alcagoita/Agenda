"""KAN-412. The rules `backfill_osm_tag_types.sql_for` must not get wrong.

Two of them are only visible in production if they break: retiring `store`
from a row that had other types would delete a real answer, and retiring it
from a row that has nothing else would leave a POI no search can return.
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import backfill_osm_tag_types as backfill  # noqa: E402


def sql_for(by_type, existing):
    with mock.patch.object(backfill, 'known_ids', return_value=existing):
        return backfill.sql_for(by_type)


class TagBackfillTest(unittest.TestCase):
    def test_adds_the_type_and_retires_a_lone_store(self):
        statements, adds, retire = sql_for(
            {'butcher': {'node/1'}}, {'node/1': {'store'}})
        self.assertEqual(adds, {'butcher': 1})
        self.assertEqual(retire, ['node/1'])
        joined = '\n'.join(statements)
        self.assertIn("('node/1','butcher',0)", joined)
        self.assertIn("DELETE FROM osm_poi_type WHERE poi_type = 'store'", joined)

    def test_keeps_store_when_the_row_has_another_type(self):
        # The tags knew something beyond the catch-all, so `store` was not a
        # shrug and dropping it would delete a real answer.
        _, adds, retire = sql_for(
            {'butcher': {'node/1'}}, {'node/1': {'store', 'supermarket'}})
        self.assertEqual(adds, {'butcher': 1})
        self.assertEqual(retire, [])

    def test_never_empties_a_row_that_had_only_the_new_type(self):
        # No `store` to retire means no DELETE at all — the row keeps the
        # single type it is about to receive.
        statements, _, retire = sql_for(
            {'butcher': {'node/1'}}, {'node/1': set()})
        self.assertEqual(retire, [])
        self.assertNotIn('DELETE', '\n'.join(statements))

    def test_skips_elements_not_already_imported(self):
        # Importing new POIs is supplement_osm_pois.py's job. An id Overpass
        # returns that D1 has never seen produces nothing here.
        statements, adds, retire = sql_for({'butcher': {'node/999'}}, {})
        self.assertEqual((statements, adds, retire), ([], {}, []))

    def test_is_idempotent_for_a_type_already_present(self):
        statements, adds, _ = sql_for(
            {'butcher': {'node/1'}}, {'node/1': {'butcher'}})
        self.assertEqual((statements, adds), ([], {}))

    def test_skip_leaves_out_only_the_named_pairs(self):
        with mock.patch.object(backfill, 'fetch_overpass') as fetch:
            fetch.return_value = {'elements': []}
            with mock.patch.object(backfill.time, 'sleep'):
                backfill.fetch_ids('PT', skip={'shop=butcher', 'shop=laundry'})
        asked = [call.args[0] for call in fetch.call_args_list]
        self.assertEqual(len(asked), len(backfill.BACKFILL_PAIRS) - 2)
        self.assertFalse(any('"shop"="butcher"' in q for q in asked))
        self.assertTrue(any('"shop"="seafood"' in q for q in asked))

    def test_primary_type_update_only_touches_retired_rows(self):
        statements, _, _ = sql_for({'butcher': {'node/1'}}, {'node/1': {'store'}})
        updates = [s for s in statements if s.startswith('UPDATE osm_poi SET')]
        self.assertEqual(len(updates), 1)
        # A row whose types were all deleted must not get a NULL primary.
        self.assertIn('EXISTS (SELECT 1 FROM osm_poi_type', updates[0])


if __name__ == '__main__':
    unittest.main()
