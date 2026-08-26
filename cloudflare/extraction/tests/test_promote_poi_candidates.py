import os
import sqlite3
import sys
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLOUDFLARE_DIR = os.path.dirname(EXTRACTION_DIR)
sys.path.insert(0, EXTRACTION_DIR)

import promote_poi_candidates
import extract


def seeded_db():
    """Real SQLite with the project's own schema — the guards under test are
    SQL conditions, so a fake that inspects statement text would assert
    nothing about whether they actually hold."""
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    for name in ('schema.sql', 'poi_type_schema.sql'):
        db.executescript(open(os.path.join(CLOUDFLARE_DIR, name)).read())
    db.executescript(open(os.path.join(
        CLOUDFLARE_DIR, 'migrations', '0026_poi_candidate.sql')).read())
    return db


def apply(db, statements):
    for statement in statements:
        db.executescript(statement)
    db.commit()


class StatusUpdateTest(unittest.TestCase):
    def candidate(self, db, place_id, status='pending'):
        db.execute(
            "INSERT INTO poi_candidate (fsq_place_id, name, lat, lng, imported_at, promotion_status)"
            " VALUES (?,?,0,0,'t',?)", (place_id, place_id, status))
        db.commit()

    def status_of(self, db, place_id):
        row = db.execute('SELECT promotion_status, promotion_note FROM poi_candidate'
                         ' WHERE fsq_place_id = ?', (place_id,)).fetchone()
        return row['promotion_status'], row['promotion_note']

    def test_writes_the_reason_not_just_the_status(self):
        # A status alone cannot be reviewed: "rejected" does not say whether
        # the row was a duplicate, a road, or a company registration.
        db = seeded_db()
        self.candidate(db, 'a')
        apply(db, promote_poi_candidates.status_updates(
            [('a', 'geography: Road')], 'rejected'))
        self.assertEqual(self.status_of(db, 'a'), ('rejected', 'geography: Road'))

    def test_keeps_reasons_distinct_within_one_chunk(self):
        # Rows sharing a statement must not share one another's reason.
        db = seeded_db()
        for place_id in ('a', 'b'):
            self.candidate(db, place_id)
        apply(db, promote_poi_candidates.status_updates(
            [('a', 'geography: Road'), ('b', 'duplicate of osm "x" (0.91)')], 'rejected'))
        self.assertEqual(self.status_of(db, 'a')[1], 'geography: Road')
        self.assertEqual(self.status_of(db, 'b')[1], 'duplicate of osm "x" (0.91)')

    def test_never_overwrites_a_decision_already_made(self):
        # The rerun guard. On a second pass a row promoted by the first is in
        # `poi`, so the duplicate check matches it against itself and would
        # re-decide it as a duplicate — turning a promotion into a rejection.
        db = seeded_db()
        self.candidate(db, 'a', status='promoted')
        db.execute("UPDATE poi_candidate SET promotion_note = 'existing type via store'"
                   " WHERE fsq_place_id = 'a'")
        db.commit()
        apply(db, promote_poi_candidates.status_updates(
            [('a', 'duplicate of fsq "a" (1.00)')], 'rejected'))
        self.assertEqual(self.status_of(db, 'a'), ('promoted', 'existing type via store'))

    def test_a_pending_row_is_still_decided(self):
        # The guard must not block the first decision.
        db = seeded_db()
        self.candidate(db, 'a')
        apply(db, promote_poi_candidates.status_updates([('a', 'lodging: Hostel')], 'promoted'))
        self.assertEqual(self.status_of(db, 'a'), ('promoted', 'lodging: Hostel'))

    def test_escapes_a_reason_containing_a_quote(self):
        db = seeded_db()
        self.candidate(db, 'a')
        apply(db, promote_poi_candidates.status_updates(
            [('a', 'duplicate of osm "O\'Tacho" (0.95)')], 'rejected'))
        self.assertIn("O'Tacho", self.status_of(db, 'a')[1])


class CountryCodeValidationTest(unittest.TestCase):
    """country_code reaches the SQL through out_path, which cannot be a bound
    parameter — DuckDB's COPY target is interpolated. So it is validated at
    the boundary instead."""

    def test_rejects_anything_that_is_not_two_letters(self):
        for bad in ("PT'; DROP TABLE poi; --", '../../etc/passwd', 'PRT', 'P', '', None, 'P7'):
            with self.assertRaises(ValueError):
                extract.extract_country_candidates('jwt', bad)

    def test_accepts_a_real_country_code(self):
        # Fails at _connect (no JWT/network), which is past the validation —
        # ValueError would mean a valid code was rejected.
        with self.assertRaises(Exception) as caught:
            extract.extract_country_candidates('not-a-jwt', 'PT')
        self.assertNotIsInstance(caught.exception, ValueError)


if __name__ == '__main__':
    unittest.main()


class CategoryMapPortabilityTest(unittest.TestCase):
    """KAN-410 — promoting rows fixes Portugal; the map fixes everywhere else.

    `extract_place`/`extract_country` filter Foursquare to the ids in
    poiTypeCategories.json + the two subtype files. A category absent from
    them is never downloaded, so it can never be promoted later. PT only has
    these rows because KAN-404 ran one unfiltered extract by hand.

    A type promoted here but missing from the map is therefore a type only
    Portugal will ever have — and nothing reports it, because coverage still
    reads `mapped`.
    """

    def setUp(self):
        import analyse_poi_candidates as analyse
        self.labels = analyse.mapped_category_labels()
        self.reachable = analyse.reachable_types()

    def test_the_union_parser_sees_every_type(self):
        # It split on the first `;` after the union began, including one
        # inside a comment, and read 33 of 86 — silently. Every type declared
        # after that point looked unreachable, which blocked its candidates
        # from ever promoting.
        import analyse_poi_candidates as analyse
        union = analyse._union_types()
        self.assertGreater(len(union), 80, 'union parse truncated again')
        for late in ('viewpoint', 'waterfall', 'lighthouse', 'music_venue'):
            self.assertIn(late, union, f'{late} declared late and lost by the parser')

    def test_every_leaf_this_ticket_maps_resolves_to_a_reachable_type(self):
        for leaf in ['Scenic Lookout', 'Castle', 'Monument', 'Palace', 'Waterfall',
                     'Bathing Area', 'Nature Preserve', 'Hot Spring', 'Island',
                     'Lighthouse', 'Surf Spot', 'Harbor or Marina', 'Plaza',
                     'Theater', 'Music Venue', 'Concert Hall', 'River', 'Mountain',
                     'Lake', 'Bridge', 'Garden']:
            poi_type = self.labels.get(leaf)
            self.assertIsNotNone(poi_type, f'{leaf} is not in the category map')
            self.assertIn(poi_type, self.reachable, f'{leaf} -> {poi_type} is unreachable')

    def test_the_extraction_filter_asks_for_them(self):
        # The half that makes this portable. Without it Madrid never
        # downloads a castle, so there is nothing to promote there.
        from category_ids import all_category_ids
        ids = all_category_ids()
        self.assertGreater(len(ids), 130, 'the filter did not widen')

    def test_a_multi_leaf_type_contributes_all_its_ids(self):
        # `historical_landmark` is Monument AND Castle AND Palace. Reading
        # only the primary would extract a third of the material and report
        # success.
        import json, os
        mapping = json.load(open(os.path.join(
            os.path.dirname(EXTRACTION_DIR), 'src', 'poiTypeCategories.json')))
        entry = mapping['historical_landmark']
        names = {entry['category_name']} | {a['category_name'] for a in entry.get('also', ())}
        for leaf in ('Monument', 'Castle', 'Palace'):
            self.assertIn(leaf, names)
        from category_ids import all_category_ids
        ids = all_category_ids()
        for extra in entry.get('also', ()):
            self.assertIn(extra['category_id'], ids)
