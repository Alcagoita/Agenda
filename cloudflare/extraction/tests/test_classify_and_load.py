import csv
import contextlib
import io
import os
import sqlite3
import sys
import tempfile
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRATION_PATH = os.path.join(
    os.path.dirname(EXTRACTION_DIR), 'migrations', '0007_deduplicate_global_pois.sql',
)
sys.path.insert(0, EXTRACTION_DIR)

import classify_and_load
import backfill_brands


class ClassifyDeduplicationTest(unittest.TestCase):
    def test_brand_backfill_uses_normalized_phrase_boundaries(self):
        sql = backfill_brands.brand_case([{
            'name': 'Caixa Geral de Depósitos', 'aliases': ['CGD'],
        }])
        self.assertIn("' ' || normalized_name || ' '", sql)
        self.assertIn("% caixa geral de depositos %", sql)
        self.assertIn("% cgd %", sql)
        self.assertNotIn("LIKE '%CGD%'", sql)

    def test_brand_backfill_can_limit_a_d1_batch_by_hex_identifier_prefix(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            backfill_brands.emit_for_foursquare('bank', [{'name': 'Banco BPI', 'aliases': ['BPI']}], 'a')
            backfill_brands.emit_for_curated('bank', [{'name': 'Banco BPI', 'aliases': ['BPI']}], 'a')
        self.assertIn("target.fsq_place_id LIKE 'a%'", output.getvalue())
        self.assertIn("target.poi_id LIKE 'a%'", output.getvalue())

    def test_brand_backfill_prefix_does_not_clear_rows_outside_the_shard(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            backfill_brands.emit_for_foursquare('bank', [{'name': 'Banco BPI', 'aliases': ['BPI']}], 'a')
        with sqlite3.connect(':memory:') as database:
            database.executescript('''
                CREATE TABLE poi (fsq_place_id TEXT PRIMARY KEY, name TEXT, dedupe_name TEXT, brand TEXT);
                CREATE TABLE poi_type (fsq_place_id TEXT, poi_type TEXT);
            ''')
            database.execute("INSERT INTO poi VALUES ('a-match', 'BPI', 'bpi', NULL)")
            database.execute("INSERT INTO poi VALUES ('b-untouched', 'Other bank', 'other bank', 'source value')")
            database.execute("INSERT INTO poi_type VALUES ('a-match', 'bank')")
            database.execute("INSERT INTO poi_type VALUES ('b-untouched', 'bank')")
            database.executescript(output.getvalue())
            self.assertEqual(database.execute("SELECT brand FROM poi WHERE fsq_place_id = 'a-match'").fetchone(), ('Banco BPI',))
            self.assertEqual(database.execute("SELECT brand FROM poi WHERE fsq_place_id = 'b-untouched'").fetchone(), ('source value',))

    def test_brand_backfill_cli_can_emit_one_bank_shard(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            backfill_brands.main(['--poi-type', 'bank', '--id-prefix', 'a'])
        sql = output.getvalue()
        self.assertIn("poi_type.poi_type = 'bank'", sql)
        self.assertIn("target.fsq_place_id LIKE 'a%'", sql)
        self.assertNotIn("poi_type.poi_type = 'gym'", sql)

    def test_brand_backfill_reuses_importer_normalization_for_foursquare_and_curated_rows(self):
        entries = [{'name': 'Caixa Geral de Depósitos', 'aliases': ['CGD']}]
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            backfill_brands.emit_for_foursquare('bank', entries)
            backfill_brands.emit_for_curated('bank', entries)
        with sqlite3.connect(':memory:') as database:
            database.executescript('''
                CREATE TABLE poi (fsq_place_id TEXT PRIMARY KEY, name TEXT, dedupe_name TEXT, brand TEXT);
                CREATE TABLE poi_type (fsq_place_id TEXT, poi_type TEXT);
                CREATE TABLE curated_poi (poi_id TEXT PRIMARY KEY, name TEXT, dedupe_name TEXT, primary_poi_type TEXT, brand TEXT);
            ''')
            database.execute("INSERT INTO poi VALUES ('fsq-cgd', 'CGD — Alcobaça', 'cgd alcobaca', NULL)")
            database.execute("INSERT INTO poi VALUES ('fsq-unlisted', 'Unlisted Source Bank', 'unlisted source bank', 'source value')")
            database.execute("INSERT INTO poi_type VALUES ('fsq-cgd', 'bank')")
            database.execute("INSERT INTO poi_type VALUES ('fsq-unlisted', 'bank')")
            database.execute("INSERT INTO curated_poi VALUES ('manual-cgd', 'Caixa Geral de Depositos - Alcobaça', 'caixa geral de depositos alcobaca', 'bank', NULL)")
            database.execute("INSERT INTO curated_poi VALUES ('manual-unlisted', 'Unlisted Source Bank', 'unlisted source bank', 'bank', 'source value')")
            database.executescript(output.getvalue())
            self.assertEqual(database.execute("SELECT brand FROM poi WHERE fsq_place_id = 'fsq-cgd'").fetchone(), ('Caixa Geral de Depósitos',))
            self.assertEqual(database.execute("SELECT brand FROM poi WHERE fsq_place_id = 'fsq-unlisted'").fetchone(), ('source value',))
            self.assertEqual(database.execute("SELECT brand FROM curated_poi WHERE poi_id = 'manual-cgd'").fetchone(), ('Caixa Geral de Depósitos',))
            self.assertEqual(database.execute("SELECT brand FROM curated_poi WHERE poi_id = 'manual-unlisted'").fetchone(), ('source value',))

    def test_brand_aliases_resolve_to_the_canonical_persisted_value(self):
        dictionary = classify_and_load.load_brand_dictionary()
        self.assertEqual(
            classify_and_load.find_brand('CGD - Alcobaça', ['bank'], dictionary),
            'Caixa Geral de Depósitos',
        )
        self.assertEqual(
            classify_and_load.find_brand('Viva Fit Leiria', ['gym'], dictionary),
            'Vivafit',
        )
        self.assertEqual(
            classify_and_load.find_brand('BANIF Batalha', ['bank'], dictionary),
            'Santander',
        )
        self.assertEqual(
            classify_and_load.find_brand('Unicaja Banco (EspañaDuero)', ['bank'], dictionary),
            'Unicaja',
        )
        self.assertEqual(
            classify_and_load.find_brand('BPCE', ['bank'], dictionary),
            'Banque Populaire',
        )

    def test_explicit_atm_name_rule_does_not_reclassify_a_bank_branch(self):
        self.assertTrue(classify_and_load.is_explicit_atm_name('ATM - Montepio'))
        self.assertTrue(classify_and_load.is_explicit_atm_name('Caixa Agrícola - Multibanco'))
        self.assertTrue(classify_and_load.is_explicit_atm_name('Multibanco CGD - ATM'))
        self.assertTrue(classify_and_load.is_explicit_atm_name('Cajero Automático EspañaDuero Banco'))
        self.assertFalse(classify_and_load.is_explicit_atm_name('Banco Montepio'))
        self.assertFalse(classify_and_load.is_explicit_atm_name('Banco BPI'))

    def test_financial_service_rules_only_override_bank_for_explicit_signals(self):
        rules = classify_and_load.load_financial_service_name_rules()
        self.assertEqual(
            classify_and_load.financial_service_type('Damane Cash Soltana', ['5744ccdfe4b0c0459246b4be'], rules),
            'currency_exchange',
        )
        self.assertEqual(
            classify_and_load.financial_service_type('Western Union - Faro', [], rules),
            'money_transfer',
        )
        self.assertEqual(
            classify_and_load.financial_service_type('Banco Santander', [], rules),
            None,
        )

    def test_named_atm_is_loaded_as_atm_only_even_when_foursquare_says_bank(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            csv_path = os.path.join(temp_dir, 'source.csv')
            sql_path = os.path.join(temp_dir, 'load.sql')
            previous_build_dir = classify_and_load.BUILD_DIR
            classify_and_load.BUILD_DIR = temp_dir
            try:
                with open(csv_path, 'w', newline='') as source:
                    writer = csv.DictWriter(source, fieldnames=[
                        'fsq_place_id', 'name', 'latitude', 'longitude',
                        'category_ids', 'category_labels', 'address',
                    ])
                    writer.writeheader()
                    writer.writerow({
                        'fsq_place_id': 'fsq-atm', 'name': 'ATM - Montepio',
                        'latitude': '38.000000', 'longitude': '-9.000000',
                        'category_ids': '4bf58dd8d48988d10a951735',
                        'category_labels': 'Bank', 'address': '1 Main Street',
                    })

                result = classify_and_load.classify('test-place', csv_path, sql_path)
                with sqlite3.connect(result['sqlite_path']) as export:
                    self.assertEqual(
                        export.execute('SELECT primary_poi_type FROM poi').fetchall(),
                        [('atm',)],
                    )
                    self.assertEqual(
                        export.execute('SELECT poi_type FROM poi_type').fetchall(),
                        [('atm',)],
                    )
            finally:
                classify_and_load.BUILD_DIR = previous_build_dir

    def test_exchange_and_transfer_are_loaded_without_bank(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            csv_path = os.path.join(temp_dir, 'source.csv')
            sql_path = os.path.join(temp_dir, 'load.sql')
            previous_build_dir = classify_and_load.BUILD_DIR
            classify_and_load.BUILD_DIR = temp_dir
            try:
                with open(csv_path, 'w', newline='') as source:
                    writer = csv.DictWriter(source, fieldnames=[
                        'fsq_place_id', 'name', 'latitude', 'longitude',
                        'category_ids', 'category_labels', 'address',
                    ])
                    writer.writeheader()
                    writer.writerow({
                        'fsq_place_id': 'fsq-exchange', 'name': 'Damane Cash Soltana',
                        'latitude': '38.000000', 'longitude': '-9.000000',
                        'category_ids': '4bf58dd8d48988d10a951735|5744ccdfe4b0c0459246b4be',
                        'category_labels': 'Bank|Currency Exchange', 'address': '1 Main Street',
                    })
                    writer.writerow({
                        'fsq_place_id': 'fsq-transfer', 'name': 'Western Union - Faro',
                        'latitude': '38.100000', 'longitude': '-9.000000',
                        'category_ids': '4bf58dd8d48988d10a951735',
                        'category_labels': 'Bank', 'address': '2 Main Street',
                    })

                result = classify_and_load.classify('test-place', csv_path, sql_path)
                with sqlite3.connect(result['sqlite_path']) as export:
                    self.assertEqual(
                        export.execute('SELECT name, primary_poi_type, brand FROM poi ORDER BY name').fetchall(),
                        [('Damane Cash Soltana', 'currency_exchange', None), ('Western Union - Faro', 'money_transfer', None)],
                    )
                    self.assertEqual(
                        export.execute('SELECT fsq_place_id, poi_type FROM poi_type ORDER BY fsq_place_id').fetchall(),
                        [('fsq-exchange', 'currency_exchange'), ('fsq-transfer', 'money_transfer')],
                    )
            finally:
                classify_and_load.BUILD_DIR = previous_build_dir

    def test_child_batches_stay_below_compound_select_cap(self):
        output = io.StringIO()
        select = "SELECT fsq_place_id, 'cafe' AS poi_type, 0 AS rank FROM poi WHERE fsq_place_id = 'fsq-1'"
        batches = classify_and_load.write_guarded_child_batches(
            output, 'poi_type', 'fsq_place_id, poi_type, rank',
            [(str(index), select) for index in range(classify_and_load.MAX_CHILD_SELECT_TERMS + 1)],
            'poi_type', 'test-place',
        )

        sql = output.getvalue()
        self.assertEqual(batches, 2)
        self.assertEqual(sql.count('INSERT OR IGNORE INTO poi_type'), 2)
        self.assertNotIn('WHERE EXISTS', sql)

    def test_migration_keeps_one_poi_and_merges_child_rows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            database_path = os.path.join(temp_dir, 'poi.db')
            with sqlite3.connect(database_path) as database:
                database.executescript('''
                    CREATE TABLE poi (
                      fsq_place_id TEXT PRIMARY KEY, name TEXT NOT NULL,
                      lat REAL NOT NULL, lng REAL NOT NULL, geohash TEXT NOT NULL,
                      primary_poi_type TEXT NOT NULL, brand TEXT, category_label TEXT,
                      raw_category_ids TEXT, raw_category_labels TEXT, address TEXT,
                      date_refreshed TEXT NOT NULL
                    );
                    CREATE TABLE poi_type (
                      fsq_place_id TEXT NOT NULL, poi_type TEXT NOT NULL, rank INTEGER NOT NULL,
                      PRIMARY KEY (fsq_place_id, poi_type)
                    );
                    CREATE TABLE poi_attribute (
                      fsq_place_id TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL,
                      PRIMARY KEY (fsq_place_id, dimension, value)
                    );
                ''')
                database.executemany(
                    'INSERT INTO poi VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    [
                        ('fsq-a', 'A Padaria Portuguesa', 38.0, -9.0, 'eyc', 'cafe', None, None, None, None, None, '2026-01-01'),
                        ('fsq-b', 'A Padaria Portuguesa', 38.0, -9.0, 'eyc', 'bakery', None, None, None, None, None, '2026-01-02'),
                        ('fsq-c', 'A Padaria Portuguêsa', 38.0, -9.0, 'eyc', 'bakery', None, None, None, None, None, '2026-01-03'),
                    ],
                )
                database.execute("INSERT INTO poi_type VALUES ('fsq-b', 'bakery', 1)")
                database.execute("INSERT INTO poi_attribute VALUES ('fsq-b', 'store_kind', 'bakery')")
                with open(MIGRATION_PATH) as migration:
                    database.executescript(migration.read())

                self.assertEqual(
                    database.execute('SELECT fsq_place_id FROM poi').fetchall(),
                    [('fsq-a',)],
                )
                self.assertEqual(
                    database.execute('SELECT fsq_place_id, poi_type FROM poi_type').fetchall(),
                    [('fsq-a', 'bakery')],
                )
                self.assertEqual(
                    database.execute('SELECT fsq_place_id, dimension, value FROM poi_attribute').fetchall(),
                    [('fsq-a', 'store_kind', 'bakery')],
                )
                with self.assertRaises(sqlite3.IntegrityError):
                    database.execute(
                        "INSERT INTO poi (fsq_place_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, date_refreshed) "
                        "VALUES ('fsq-c', 'A Padaria Portuguesa', 'a padaria portuguesa', 38.0, -9.0, 'eyc', 'cafe', '2026-01-03')"
                    )

    def test_same_name_coordinates_are_loaded_once_and_merge_metadata(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            csv_path = os.path.join(temp_dir, 'source.csv')
            sql_path = os.path.join(temp_dir, 'load.sql')
            previous_build_dir = classify_and_load.BUILD_DIR
            classify_and_load.BUILD_DIR = temp_dir
            try:
                with open(csv_path, 'w', newline='') as source:
                    writer = csv.DictWriter(source, fieldnames=[
                        'fsq_place_id', 'name', 'latitude', 'longitude',
                        'category_ids', 'category_labels', 'address',
                    ])
                    writer.writeheader()
                    for fsq_place_id, name, category_id, category_label in (
                        ('fsq-first', 'A Padaria Portuguesa', '4bf58dd8d48988d16d941735|4bf58dd8d48988d103951735', 'Cafe|Clothing Store'),
                        ('fsq-duplicate', 'A Padaria Portuguesa', '4bf58dd8d48988d16a941735', 'Bakery'),
                        ('fsq-accented', 'A Padaria Portuguêsa', '4bf58dd8d48988d16d941735', 'Cafe'),
                    ):
                        writer.writerow({
                            'fsq_place_id': fsq_place_id,
                            'name': name,
                            'latitude': '38.000000',
                            'longitude': '-9.000000',
                            'category_ids': category_id,
                            'category_labels': category_label,
                            'address': '1 Main Street',
                        })

                result = classify_and_load.classify('test-place', csv_path, sql_path)

                self.assertEqual(result['rows_loaded'], 1)
                self.assertEqual(result['rows_skipped'], 0)
                self.assertEqual(result['deduplicated'], 2)
                with sqlite3.connect(result['sqlite_path']) as export:
                    rows = export.execute('SELECT fsq_place_id, name FROM poi').fetchall()
                self.assertEqual(rows, [('fsq-first', 'A Padaria Portuguesa')])
                with open(sql_path) as generated:
                    sql = generated.read()
                self.assertNotIn('fsq-duplicate', sql)
                self.assertNotIn('fsq-accented', sql)
                self.assertIn('dedupe_name', sql)
                self.assertIn('ON CONFLICT(fsq_place_id) DO UPDATE', sql)
                with sqlite3.connect(':memory:') as database:
                    database.executescript('''
                        CREATE TABLE poi (
                          fsq_place_id TEXT PRIMARY KEY, name TEXT NOT NULL,
                          dedupe_name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
                          geohash TEXT NOT NULL, primary_poi_type TEXT NOT NULL,
                          brand TEXT, category_label TEXT, raw_category_ids TEXT,
                          raw_category_labels TEXT, address TEXT, date_refreshed TEXT NOT NULL,
                          open_min INTEGER, close_min INTEGER
                        );
                        CREATE UNIQUE INDEX idx_poi_canonical_identity
                          ON poi (dedupe_name, lat, lng);
                        CREATE TABLE poi_type (
                          fsq_place_id TEXT NOT NULL, poi_type TEXT NOT NULL, rank INTEGER NOT NULL,
                          PRIMARY KEY (fsq_place_id, poi_type)
                        );
                        CREATE TABLE poi_attribute (
                          fsq_place_id TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL,
                          PRIMARY KEY (fsq_place_id, dimension, value)
                        );
                    ''')
                    database.execute(
                        "INSERT INTO poi (fsq_place_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, address, date_refreshed) "
                        "VALUES ('fsq-first', 'stale', 'a padaria portuguesa', 38.0, -9.0, 'eyc', 'cafe', 'stale', '2026-01-01')"
                    )
                    # build_log is deliberately absent from this replay DB;
                    # remove its first generated line without parsing SQL
                    # delimiters that could appear inside a quoted POI value.
                    database.executescript(sql.partition('\n')[2])
                    self.assertEqual(
                        database.execute('SELECT fsq_place_id FROM poi').fetchall(),
                        [('fsq-first',)],
                    )
                    self.assertEqual(
                        database.execute('SELECT fsq_place_id, poi_type FROM poi_type ORDER BY poi_type').fetchall(),
                        [('fsq-first', 'bakery'), ('fsq-first', 'cafe'), ('fsq-first', 'store')],
                    )
                    self.assertEqual(
                        database.execute('SELECT fsq_place_id, dimension, value FROM poi_attribute').fetchall(),
                        [('fsq-first', 'store_kind', 'clothing')],
                    )
                    self.assertEqual(
                        database.execute("SELECT name, address FROM poi WHERE fsq_place_id = 'fsq-first'").fetchall(),
                        [('A Padaria Portuguesa', '1 Main Street')],
                    )
            finally:
                classify_and_load.BUILD_DIR = previous_build_dir


if __name__ == '__main__':
    unittest.main()
