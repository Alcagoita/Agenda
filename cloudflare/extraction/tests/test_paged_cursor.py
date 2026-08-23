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

    def paged_over(self, pages, key, batch=2, **kwargs):
        seen = []

        def fake_query(sql):
            seen.append(sql)
            return pages.pop(0) if pages else []

        with mock.patch.object(A, 'query', fake_query):
            rows = list(A.paged('poi p JOIN poi_type t ON t.fsq_place_id = p.fsq_place_id',
                                ['p.fsq_place_id AS fsq_place_id'], key, batch, **kwargs))
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
        # the same page. Both predicates must appear in the SAME query.
        _, queries = self.paged_over(
            [[{'fsq_place_id': 'a'}], []], 'p.fsq_place_id',
            where="promotion_status = 'pending'")
        self.assertIn("p.fsq_place_id > ''", queries[0])
        self.assertIn("AND (promotion_status = 'pending')", queries[0])
        # ...and the cursor still advances with the filter present.
        self.assertIn("p.fsq_place_id > 'a'", queries[1])

    def test_group_by_makes_a_one_to_many_join_cursor_safe(self):
        # Without GROUP BY, a place with three types yields three rows sharing
        # the cursor value. A page boundary inside that group makes `> last`
        # skip the remainder — silently, and by an amount that changes with
        # the batch size. Measured on the real query: 302,033 join rows,
        # 302,031 seen.
        _, queries = self.paged_over(
            [[{'fsq_place_id': 'a', 'poi_types': 'cafe,bakery'}], []],
            'p.fsq_place_id', group_by='p.fsq_place_id')
        self.assertIn('GROUP BY p.fsq_place_id', queries[0])
        # Grouping sits between the WHERE and the ORDER BY, or SQLite rejects it.
        where_at = queries[0].index('WHERE')
        group_at = queries[0].index('GROUP BY')
        order_at = queries[0].index('ORDER BY')
        self.assertLess(where_at, group_at)
        self.assertLess(group_at, order_at)

    def test_a_duplicate_cursor_value_split_across_pages_loses_rows(self):
        # The bug itself, pinned: three rows share cursor 'a' and the page
        # break falls after the second. The third is unreachable, because the
        # next query asks for > 'a'. This asserts the LOSS, so the reason
        # group_by exists cannot be quietly removed.
        rows, _ = self.paged_over(
            [[{'fsq_place_id': 'a', 'poi_type': 'cafe'},
              {'fsq_place_id': 'a', 'poi_type': 'bakery'}],
             [{'fsq_place_id': 'b', 'poi_type': 'store'}],
             []],
            'p.fsq_place_id')
        # 'a' had a third type row in the table; it never appears.
        self.assertEqual([r['poi_type'] for r in rows], ['cafe', 'bakery', 'store'])
        self.assertNotIn('ice_cream', [r['poi_type'] for r in rows])


if __name__ == '__main__':
    unittest.main()
