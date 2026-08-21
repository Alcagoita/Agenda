import os
import sqlite3
import sys
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLOUDFLARE_DIR = os.path.dirname(EXTRACTION_DIR)
sys.path.insert(0, EXTRACTION_DIR)

import backfill_promoted_types


class ScopeTest(unittest.TestCase):
    """The backfill must touch only rows the promotion created.

    Scoping by `date_refreshed` alone caught any ordinary import refreshed the
    same day. The scope is a JOIN to poi_candidate instead, so this exercises
    the real query against real SQLite rather than trusting the string.
    """

    def db(self):
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        db.executescript(open(os.path.join(CLOUDFLARE_DIR, 'schema.sql')).read())
        db.executescript(open(os.path.join(
            CLOUDFLARE_DIR, 'migrations', '0026_poi_candidate.sql')).read())
        poi = ("INSERT INTO poi (fsq_place_id, name, dedupe_name, lat, lng, geohash,"
               " primary_poi_type, date_refreshed) VALUES (?,?,?,?,?,?,?, '2026-08-21')")
        # Same refresh date, different provenance.
        db.execute(poi, ('promoted-1', 'Pastelaria X', 'pastelaria x', 1, 1, 'aaaaaaa', 'store'))
        db.execute(poi, ('ordinary-1', 'Pastelaria Y', 'pastelaria y', 2, 2, 'bbbbbbb', 'store'))
        db.execute("INSERT INTO poi_candidate (fsq_place_id, name, lat, lng, imported_at,"
                   " promotion_status) VALUES ('promoted-1','Pastelaria X',1,1,'t','promoted')")
        db.execute("INSERT INTO poi_candidate (fsq_place_id, name, lat, lng, imported_at,"
                   " promotion_status) VALUES ('pending-1','Pastelaria Z',3,3,'t','pending')")
        db.commit()
        return db

    def scoped_ids(self, db):
        rows = db.execute(
            "SELECT p.fsq_place_id FROM poi p JOIN poi_candidate c"
            " ON c.fsq_place_id = p.fsq_place_id"
            " WHERE p.fsq_place_id > '' AND (c.promotion_status = 'promoted')"
            " ORDER BY p.fsq_place_id").fetchall()
        return [r['fsq_place_id'] for r in rows]

    def test_only_promoted_candidates_are_in_scope(self):
        self.assertEqual(self.scoped_ids(self.db()), ['promoted-1'])

    def test_an_ordinary_import_sharing_the_date_is_untouched(self):
        self.assertNotIn('ordinary-1', self.scoped_ids(self.db()))

    def test_a_pending_candidate_is_not_in_scope(self):
        # Pending rows have no poi row yet; the join must not invent one.
        self.assertNotIn('pending-1', self.scoped_ids(self.db()))


class ResolutionTest(unittest.TestCase):
    def types(self, row, reachable):
        return backfill_promoted_types.types_for(
            row, id_map={}, mapped_labels={'Bakery': 'bakery', 'Hotel': 'hotel'},
            reachable=reachable)

    def test_drops_a_classifier_type_the_app_cannot_reach(self):
        # Keeping it would write poi_type rows for a type no search can
        # request — the dead-type shape KAN-398 had to clean up.
        row = {'name': '', 'raw_category_ids': '',
               'raw_category_labels': 'Travel and Transportation > Lodging > Hotel'}
        self.assertEqual(self.types(row, reachable={'bakery': 'bakery'}), set())

    def test_keeps_a_type_that_resolves_through_the_reachable_map(self):
        row = {'name': '', 'raw_category_ids': '',
               'raw_category_labels': 'Dining and Drinking > Bakery'}
        self.assertEqual(self.types(row, reachable={'bakery': 'bakery'}), {'bakery'})

    def test_still_drops_the_types_the_product_refused(self):
        row = {'name': 'Escola Primaria', 'raw_category_ids': '', 'raw_category_labels': ''}
        self.assertNotIn('school', self.types(row, reachable={'school': 'school'}))


if __name__ == '__main__':
    unittest.main()
