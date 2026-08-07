import csv
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


class ClassifyDeduplicationTest(unittest.TestCase):
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

    def test_same_name_coordinates_and_type_are_loaded_once(self):
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
                    for fsq_place_id, category_id, category_label in (
                        ('fsq-first', '4bf58dd8d48988d16d941735', 'Cafe'),
                        ('fsq-duplicate', '4bf58dd8d48988d16a941735', 'Bakery'),
                    ):
                        writer.writerow({
                            'fsq_place_id': fsq_place_id,
                            'name': 'A Padaria Portuguesa',
                            'latitude': '38.000000',
                            'longitude': '-9.000000',
                            'category_ids': category_id,
                            'category_labels': category_label,
                            'address': '1 Main Street',
                        })

                result = classify_and_load.classify('test-place', csv_path, sql_path)

                self.assertEqual(result['rows_loaded'], 1)
                self.assertEqual(result['rows_skipped'], 1)
                with sqlite3.connect(result['sqlite_path']) as export:
                    rows = export.execute('SELECT fsq_place_id, name FROM poi').fetchall()
                self.assertEqual(rows, [('fsq-first', 'A Padaria Portuguesa')])
                with open(sql_path) as generated:
                    sql = generated.read()
                self.assertNotIn('fsq-duplicate', sql)
                self.assertIn('dedupe_name', sql)
                with sqlite3.connect(':memory:') as database:
                    database.executescript('''
                        CREATE TABLE poi (
                          fsq_place_id TEXT PRIMARY KEY, name TEXT NOT NULL,
                          dedupe_name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
                          geohash TEXT NOT NULL, primary_poi_type TEXT NOT NULL,
                          brand TEXT, category_label TEXT, raw_category_ids TEXT,
                          raw_category_labels TEXT, address TEXT, date_refreshed TEXT NOT NULL
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
                    for statement in sql.split(';\n'):
                        if statement and not statement.startswith('INSERT INTO build_log'):
                            database.execute(statement)
                    self.assertEqual(
                        database.execute('SELECT fsq_place_id FROM poi').fetchall(),
                        [('fsq-first',)],
                    )
                    self.assertEqual(
                        database.execute('SELECT fsq_place_id, poi_type FROM poi_type ORDER BY poi_type').fetchall(),
                        [('fsq-first', 'bakery'), ('fsq-first', 'cafe')],
                    )
            finally:
                classify_and_load.BUILD_DIR = previous_build_dir


if __name__ == '__main__':
    unittest.main()
