import os
import sys
import unittest
from unittest import mock

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)

import analyse_poi_candidates as A


class PagedCursorTest(unittest.TestCase):
    """`paged` advances its cursor by reading the last row of each page.

    On a join the key is qualified for the SQL (`p.fsq_place_id`) while D1
    returns the bare column name, so reading the cursor under the qualified
    key raises KeyError — but only on a join, and only once a SECOND page is
    needed. Every single-table caller was unaffected, which is exactly why
    it went unnoticed until a 302k-row join ran.
    """

    def paged_over(self, pages, key, batch=2):
        seen = []

        def fake_query(sql):
            seen.append(sql)
            return pages.pop(0) if pages else []

        with mock.patch.object(A, 'query', fake_query):
            rows = list(A.paged('poi p JOIN poi_type t ON t.fsq_place_id = p.fsq_place_id',
                                ['p.fsq_place_id AS fsq_place_id'], key, batch))
        return rows, seen

    def test_advances_the_cursor_on_a_joined_query(self):
        rows, queries = self.paged_over(
            [[{'fsq_place_id': 'a'}, {'fsq_place_id': 'b'}],
             [{'fsq_place_id': 'c'}],
             []],
            'p.fsq_place_id')
        self.assertEqual([r['fsq_place_id'] for r in rows], ['a', 'b', 'c'])
        # The SQL keeps the qualified name — the join needs it — while the
        # cursor value comes from the bare one.
        self.assertIn("p.fsq_place_id > 'b'", queries[1])

    def test_still_works_for_an_unqualified_key(self):
        rows, queries = self.paged_over(
            [[{'fsq_place_id': 'a'}], []], 'fsq_place_id')
        self.assertEqual([r['fsq_place_id'] for r in rows], ['a'])
        self.assertIn("fsq_place_id > ''", queries[0])

    def test_stops_on_an_empty_page(self):
        rows, queries = self.paged_over([[]], 'p.fsq_place_id')
        self.assertEqual(rows, [])
        self.assertEqual(len(queries), 1)

    def test_where_clause_is_anded_not_replacing_the_cursor(self):
        # A `where` that replaced the cursor predicate would loop forever on
        # the same page.
        _, queries = self.paged_over(
            [[{'fsq_place_id': 'a'}], []], 'p.fsq_place_id')
        self.assertIn('>', queries[0])
        with mock.patch.object(A, 'query', lambda sql: []):
            list(A.paged('poi', ['fsq_place_id'], 'fsq_place_id', 2,
                         where="promotion_status = 'pending'"))


if __name__ == '__main__':
    unittest.main()
