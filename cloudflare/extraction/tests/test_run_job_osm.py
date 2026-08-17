"""KAN-387 — the container's OSM batch loop.

run_job pulls in the whole extraction pipeline at import time (duckdb, the
HTTP clients), none of which this behaviour needs. Stubbing those modules
before the import keeps the test hermetic and, more importantly, keeps it
honest: the loop is exercised through the same worker_client / d1_client /
r2_client calls production uses, so a change to that contract fails here.
"""
import os
import sys
import types
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)


def _stub(name, **attributes):
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    sys.modules.setdefault(name, module)
    return sys.modules[name]


_stub('requests', RequestException=Exception, post=None, put=None, get=None)
_stub('duckdb')

import run_job  # noqa: E402
import supplement_osm_pois  # noqa: E402
from enrich_osm_cuisine import OverpassRateLimited  # noqa: E402


class FakeWorkerClient:
    def __init__(self, scopes, locked=True):
        self.claim_response = {'locked': locked, 'scopes': scopes}
        self.started = []
        self.completed = []
        self.failed = []
        self.released = []

    def osm_claim_batch(self, country_code, run_id, worker_id, batch_size):
        return self.claim_response

    def osm_scope_start(self, country_code, place_id, worker_id):
        self.started.append(place_id)

    def osm_scope_completed(self, country_code, place_id, worker_id, stats, rename_report_r2_key=None):
        self.completed.append((place_id, stats, rename_report_r2_key))

    def osm_scope_failed(self, country_code, place_id, worker_id, error, error_class='overpass_failed'):
        self.failed.append((place_id, error_class))

    def osm_batch_release(self, country_code, run_id, worker_id, outcome='done'):
        self.released.append(outcome)
        return {'finalized': False, 'counts': {'completed': len(self.completed), 'total': 3}}


class FakeD1:
    class D1Error(Exception):
        pass

    def __init__(self):
        self.statements = []

    def execute(self, sql):
        self.statements.append(sql)


class FakeR2:
    def __init__(self):
        self.uploads = []

    def upload_bytes(self, data, key, content_type='application/json'):
        self.uploads.append(key)
        return key


def scope(place_id):
    return {'placeId': place_id, 'minLat': 38.0, 'maxLat': 38.5, 'minLng': -9.5, 'maxLng': -9.0}


class RunOsmSupplementTest(unittest.TestCase):
    def setUp(self):
        self.originals = {name: getattr(run_job, name) for name in ('worker_client', 'd1_client', 'r2_client')}
        self.original_scope = supplement_osm_pois.supplement_scope
        # Read once per batch in production; irrelevant to the loop's shape.
        self.original_corrections = supplement_osm_pois.source_corrections
        supplement_osm_pois.source_corrections = lambda: {}
        self.d1 = FakeD1()
        self.r2 = FakeR2()
        run_job.d1_client = self.d1
        run_job.r2_client = self.r2

    def tearDown(self):
        for name, value in self.originals.items():
            setattr(run_job, name, value)
        supplement_osm_pois.supplement_scope = self.original_scope
        supplement_osm_pois.source_corrections = self.original_corrections

    def use_scope(self, behaviour):
        supplement_osm_pois.supplement_scope = behaviour

    def test_persists_and_checkpoints_each_municipality_before_the_next(self):
        worker = FakeWorkerClient([scope('osm-relation-100'), scope('osm-relation-101')])
        run_job.worker_client = worker
        order = []

        def behaviour(place_id, *_args, **_kwargs):
            order.append(place_id)
            poi = supplement_osm_pois.osm_poi_from_element(
                {'type': 'node', 'id': 5335674113, 'lat': 39.8, 'lon': -8.1,
                 'tags': {'name': 'Santo Amaro', 'amenity': 'restaurant'}}, {},
            )
            return [poi], {'unique_rows_to_write': 1, 'inserted': 1, 'overpass_elements': 3}, []

        self.use_scope(behaviour)
        run_job.run_osm_supplement('PT', 'run-1')

        self.assertEqual(order, ['osm-relation-100', 'osm-relation-101'])
        self.assertEqual(worker.started, ['osm-relation-100', 'osm-relation-101'])
        self.assertEqual([row[0] for row in worker.completed], ['osm-relation-100', 'osm-relation-101'])
        # Each scope's report lands in R2 as it finishes — nothing
        # country-sized is held in memory or on container-local disk.
        self.assertEqual(self.r2.uploads, [
            'osm-rename-reports/PT/run-1/osm-relation-100.json',
            'osm-rename-reports/PT/run-1/osm-relation-101.json',
        ])
        # Every statement of each scope's SQL is applied before the scope is
        # checkpointed — the POI row, its types, and the replacement deletes.
        self.assertTrue(all(sql.endswith(';') for sql in self.d1.statements))
        self.assertEqual(sum(sql.startswith('INSERT INTO osm_poi\n') for sql in self.d1.statements), 2)
        self.assertEqual(sum(sql.startswith('INSERT INTO osm_poi_type') for sql in self.d1.statements), 2)
        self.assertEqual(worker.released, ['done'])

    def test_a_failed_scope_does_not_stop_the_rest_of_the_batch(self):
        worker = FakeWorkerClient([scope('osm-relation-100'), scope('osm-relation-101')])
        run_job.worker_client = worker

        def behaviour(place_id, *_args, **_kwargs):
            if place_id == 'osm-relation-100':
                raise RuntimeError('overpass timeout')
            return [], {'unique_rows_to_write': 0, 'overpass_elements': 0}, []

        self.use_scope(behaviour)
        run_job.run_osm_supplement('PT', 'run-1')

        self.assertEqual(worker.failed, [('osm-relation-100', 'overpass_failed')])
        self.assertEqual([row[0] for row in worker.completed], ['osm-relation-101'])
        self.assertEqual(worker.released, ['done'])

    def test_a_429_stops_the_country_and_charges_nothing(self):
        worker = FakeWorkerClient([scope('osm-relation-100'), scope('osm-relation-101')])
        run_job.worker_client = worker

        def behaviour(place_id, *_args, **_kwargs):
            raise OverpassRateLimited('rate limited')

        self.use_scope(behaviour)
        run_job.run_osm_supplement('PT', 'run-1')

        # No per-scope failure is recorded: the limit is on us, and spending
        # the municipality's retry budget on it would eventually park it.
        self.assertEqual(worker.failed, [])
        self.assertEqual(worker.released, ['rate_limited'])
        # The second scope is never attempted — a 429 is a country-wide stop.
        self.assertEqual(worker.started, ['osm-relation-100'])

    def test_releases_the_country_lock_when_there_is_nothing_to_claim(self):
        worker = FakeWorkerClient([])
        run_job.worker_client = worker
        run_job.run_osm_supplement('PT', 'run-1')
        # Returning without releasing would hold the lock until its lease
        # expired and stall the cron for the whole of that window.
        self.assertEqual(worker.released, ['done'])

    def test_does_nothing_when_another_batch_owns_the_country(self):
        worker = FakeWorkerClient([], locked=False)
        run_job.worker_client = worker
        run_job.run_osm_supplement('PT', 'run-1')
        self.assertEqual(worker.released, [])


if __name__ == '__main__':
    unittest.main()
