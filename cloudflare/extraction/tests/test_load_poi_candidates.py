import csv
import os
import sqlite3
import sys
import tempfile
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLOUDFLARE_DIR = os.path.dirname(EXTRACTION_DIR)
MIGRATION_PATH = os.path.join(CLOUDFLARE_DIR, 'migrations', '0026_poi_candidate.sql')
sys.path.insert(0, EXTRACTION_DIR)

import load_poi_candidates


class FakeD1:
    """Runs the loader's SQL against real SQLite carrying the project's own
    migration, rather than pattern-matching statement text. INSERT OR IGNORE
    against a real PRIMARY KEY is the entire idempotence claim — a fake that
    just records calls would assert nothing about it."""

    def __init__(self, poi_ids=()):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        with open(MIGRATION_PATH) as handle:
            self.db.executescript(handle.read())
        self.db.execute('CREATE TABLE poi (fsq_place_id TEXT PRIMARY KEY)')
        for poi_id in poi_ids:
            self.db.execute('INSERT INTO poi VALUES (?)', (poi_id,))
        self.statements = []

    def execute(self, sql):
        self.statements.append(sql)
        cursor = self.db.execute(sql)
        self.db.commit()
        return {'changes': cursor.rowcount}

    def select(self, sql):
        return [dict(row) for row in self.db.execute(sql).fetchall()]


def write_csv(rows):
    handle = tempfile.NamedTemporaryFile('w', suffix='.csv', delete=False, newline='')
    writer = csv.DictWriter(handle, fieldnames=[
        'fsq_place_id', 'name', 'latitude', 'longitude', 'address', 'locality',
        'category_ids', 'category_labels',
    ])
    writer.writeheader()
    writer.writerows(rows)
    handle.close()
    return handle.name


def row(place_id, name='Talho Central', lat='38.7', lng='-9.1', **overrides):
    base = {
        'fsq_place_id': place_id, 'name': name, 'latitude': lat, 'longitude': lng,
        'address': 'Rua A', 'locality': 'Lisboa',
        'category_ids': '52f2ab2ebcbc57f1066b8b38',
        'category_labels': 'Business and Professional Services > Lottery Retailer',
    }
    base.update(overrides)
    return base


class LoadPoiCandidatesTest(unittest.TestCase):
    def setUp(self):
        self._real = load_poi_candidates.d1_client
        self.addCleanup(setattr, load_poi_candidates, 'd1_client', self._real)

    def run_load(self, rows, poi_ids=()):
        fake = FakeD1(poi_ids)
        load_poi_candidates.d1_client = fake
        path = write_csv(rows)
        self.addCleanup(os.unlink, path)
        result = load_poi_candidates.load('PT', path)
        return fake, result

    def staged(self, fake):
        return {r['fsq_place_id']: r for r in fake.select(
            'SELECT * FROM poi_candidate ORDER BY fsq_place_id')}

    def test_stages_only_the_delta_against_poi(self):
        # The whole reason the load is cheap: 223k rows already in poi are
        # not duplicated into a table that exists to hold what poi lacks.
        fake, result = self.run_load(
            [row('already-here'), row('new-one')], poi_ids=['already-here'])
        self.assertEqual(list(self.staged(fake)), ['new-one'])
        self.assertEqual(result['inserted'], 1)

    def test_keeps_the_raw_category_text_verbatim(self):
        # A candidate's category is unmapped by definition. Preserving what
        # the source actually said is the point of the table — a promotion
        # rule written later has nothing else to match on.
        fake, _ = self.run_load([row('lottery')])
        staged = self.staged(fake)['lottery']
        self.assertEqual(staged['raw_category_ids'], '52f2ab2ebcbc57f1066b8b38')
        self.assertEqual(
            staged['raw_category_labels'],
            'Business and Professional Services > Lottery Retailer')
        self.assertEqual(staged['promotion_status'], 'pending')

    def test_keeps_rows_carrying_no_category_at_all(self):
        # 27,612 PT rows have no category. They are exactly the rows only a
        # name can resolve, so dropping them would repeat the original
        # mistake one level down.
        fake, _ = self.run_load([row('bare', category_ids='', category_labels='')])
        staged = self.staged(fake)['bare']
        self.assertIsNone(staged['raw_category_ids'])
        self.assertEqual(staged['name'], 'Talho Central')

    def test_drops_rows_with_no_name_or_no_position(self):
        fake, _ = self.run_load([
            row('nameless', name=''),
            row('unplaced', lat=''),
            row('fine'),
        ])
        self.assertEqual(list(self.staged(fake)), ['fine'])

    def test_is_idempotent(self):
        rows = [row('a'), row('b')]
        fake, first = self.run_load(rows)
        load_poi_candidates.load('PT', write_csv(rows))
        self.assertEqual(len(self.staged(fake)), 2)
        self.assertEqual(first['inserted'], 2)

    def test_a_rerun_does_not_reset_a_decision_already_made(self):
        # The property that makes it safe to re-run a load that died halfway
        # without first auditing what someone had already decided.
        rows = [row('decided')]
        fake, _ = self.run_load(rows)
        fake.execute("UPDATE poi_candidate SET promotion_status = 'rejected', "
                     "promotion_note = 'company registration' WHERE fsq_place_id = 'decided'")
        load_poi_candidates.load('PT', write_csv(rows))
        staged = self.staged(fake)['decided']
        self.assertEqual(staged['promotion_status'], 'rejected')
        self.assertEqual(staged['promotion_note'], 'company registration')

    def test_never_writes_to_poi(self):
        # Belt and braces: the loader's only contact with production is the
        # read that lists ids to skip.
        fake, _ = self.run_load([row('x')], poi_ids=['kept'])
        for statement in fake.statements:
            self.assertNotIn('INTO poi ', statement)
            self.assertNotIn('UPDATE poi ', statement)
            self.assertNotIn('DELETE', statement.upper())
        self.assertEqual(
            [r['fsq_place_id'] for r in fake.select('SELECT * FROM poi')], ['kept'])

    def test_escapes_names_that_would_otherwise_break_the_statement(self):
        fake, _ = self.run_load([row('quoted', name="O'Tacho d'Ouro")])
        self.assertEqual(self.staged(fake)['quoted']['name'], "O'Tacho d'Ouro")

    def test_splits_into_statements_under_d1s_size_cap(self):
        rows = [row(f'id-{i}', name='X' * 300) for i in range(400)]
        fake, _ = self.run_load(rows)
        self.assertGreater(len(fake.statements), 1)
        for statement in fake.statements:
            self.assertLessEqual(
                load_poi_candidates.byte_len(statement),
                load_poi_candidates.MAX_STATEMENT_BYTES)
        self.assertEqual(len(self.staged(fake)), 400)

    def test_a_duplicate_id_inside_one_csv_is_staged_once(self):
        fake, _ = self.run_load([row('dup'), row('dup', name='Other')])
        self.assertEqual(self.staged(fake)['dup']['name'], 'Talho Central')


if __name__ == '__main__':
    unittest.main()
