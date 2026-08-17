"""KAN-387 — the container's OSM batch loop.

run_job pulls in the whole extraction pipeline at import time (duckdb, the
HTTP clients), none of which this behaviour needs. Stubbing those modules
before the import keeps the test hermetic and, more importantly, keeps it
honest: the loop is exercised through the same worker_client / d1_client /
r2_client calls production uses, so a change to that contract fails here.
"""
import importlib.util
import os
import sys
import types
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)


def _stub_if_missing(name, **attributes):
    """Stand in for a dependency only when it is genuinely not installed.

    The extraction image ships requests and duckdb for real. Installing a
    fake unconditionally would shadow them for every test that runs after
    this module in the same process, so absence is checked first.
    """
    if importlib.util.find_spec(name) is not None:
        return sys.modules.get(name)
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    sys.modules.setdefault(name, module)
    return sys.modules[name]


_stub_if_missing('requests', RequestException=Exception, post=None, put=None, get=None)
_stub_if_missing('duckdb')

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

    def test_a_d1_write_failure_is_reported_as_its_own_error_class(self):
        worker = FakeWorkerClient([scope('osm-relation-100')])
        run_job.worker_client = worker

        def failing_execute(_sql):
            raise FakeD1.D1Error('D1 reported failure')

        self.d1.execute = failing_execute
        self.use_scope(lambda place_id, *_a, **_k: (
            [supplement_osm_pois.osm_poi_from_element(
                {'type': 'node', 'id': 1, 'lat': 39.8, 'lon': -8.1,
                 'tags': {'name': 'X', 'amenity': 'restaurant'}}, {})],
            {'unique_rows_to_write': 1}, [],
        ))
        run_job.run_osm_supplement('PT', 'run-1')

        # A D1 failure needs different operator action from an Overpass one,
        # so it must not be filed under the generic retryable class.
        self.assertEqual(worker.failed, [('osm-relation-100', 'd1')])

    def test_losing_the_lease_stops_the_batch_and_offers_the_lock_back(self):
        worker = FakeWorkerClient([scope('osm-relation-100'), scope('osm-relation-101')])
        run_job.worker_client = worker

        def rejected(*_args, **_kwargs):
            raise RuntimeError('409 stale or unknown scope')

        worker.osm_scope_failed = rejected
        self.use_scope(lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError('overpass timeout')))
        run_job.run_osm_supplement('PT', 'run-1')

        # The lease is the authority: stop rather than keep claiming work
        # that may already belong to another container.
        self.assertEqual(worker.started, ['osm-relation-100'])
        self.assertEqual(worker.completed, [])
        # Still offer the lock back — we may well still hold it.
        self.assertEqual(worker.released, ['done'])

    def test_a_failed_review_report_upload_still_completes_the_scope(self):
        worker = FakeWorkerClient([scope('osm-relation-100')])
        run_job.worker_client = worker

        def failing_upload(_data, _key, content_type='application/json'):
            raise RuntimeError('R2 outbound upload failed (500)')

        self.r2.upload_bytes = failing_upload
        self.use_scope(lambda *_a, **_k: ([], {'unique_rows_to_write': 0}, []))
        run_job.run_osm_supplement('PT', 'run-1')

        # The POIs are already in D1. Failing the scope over an audit
        # artifact would spend a retry attempt re-doing finished work.
        self.assertEqual(worker.failed, [])
        self.assertEqual([row[0] for row in worker.completed], ['osm-relation-100'])
        self.assertIsNone(worker.completed[0][2])

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
