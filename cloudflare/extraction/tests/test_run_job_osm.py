"""KAN-387 — the container's OSM batch loop.

run_job pulls in the whole extraction pipeline at import time (duckdb, the
HTTP clients), none of which this behaviour needs. Stubbing those modules
before the import keeps the test hermetic and, more importantly, keeps it
honest: the loop is exercised through the same worker_client / d1_client /
r2_client calls production uses, so a change to that contract fails here.
"""
import contextlib
import importlib.util
import io
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

    def osm_batch_release(self, country_code, run_id, worker_id, outcome='done', completed_scopes=0):
        self.released.append((outcome, completed_scopes))
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
        self.assertEqual(worker.released, [('done', 2)])

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
        self.assertEqual(worker.released, [('done', 1)])

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
        # Nothing finished before the 429, so the country backs further off.
        self.assertEqual(worker.released, [('rate_limited', 0)])
        # The second scope is never attempted — a 429 is a country-wide stop.
        self.assertEqual(worker.started, ['osm-relation-100'])

    def test_a_429_after_real_work_reports_what_the_batch_achieved(self):
        worker = FakeWorkerClient([scope('osm-relation-100'), scope('osm-relation-101'), scope('osm-relation-102')])
        run_job.worker_client = worker

        def behaviour(place_id, *_args, **_kwargs):
            if place_id == 'osm-relation-100':
                return [], {'unique_rows_to_write': 0, 'overpass_elements': 4}, []
            raise OverpassRateLimited('rate limited')

        self.use_scope(behaviour)
        run_job.run_osm_supplement('PT', 'run-1')

        # Being throttled while still finishing municipalities is not being
        # blocked. Reporting the count is what lets the Worker recover the
        # delay instead of ratcheting it to the cap (KAN-389).
        self.assertEqual(worker.released, [('rate_limited', 1)])
        self.assertEqual([row[0] for row in worker.completed], ['osm-relation-100'])

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
        self.assertEqual(worker.released, [('done', 0)])

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
        self.assertEqual(worker.released, [('done', 0)])

    def test_does_nothing_when_another_batch_owns_the_country(self):
        worker = FakeWorkerClient([], locked=False)
        run_job.worker_client = worker
        run_job.run_osm_supplement('PT', 'run-1')
        self.assertEqual(worker.released, [])


if __name__ == '__main__':
    unittest.main()


class PlaceOsmSupplementTest(unittest.TestCase):
    """KAN-394 — an on-demand Place runs the OSM supplement too.

    Before this, a country-mapped Place got Foursquare AND OSM while an
    on-demand Place got Foursquare alone, and both reported `mapped`.
    """

    def setUp(self):
        self.original_d1 = run_job.d1_client
        self.original_scope = supplement_osm_pois.supplement_scope
        self.original_corrections = supplement_osm_pois.source_corrections
        self.original_statements = supplement_osm_pois.statements_for_pois
        supplement_osm_pois.source_corrections = lambda: {}
        self.d1 = FakeD1()
        run_job.d1_client = self.d1

    def tearDown(self):
        run_job.d1_client = self.original_d1
        supplement_osm_pois.supplement_scope = self.original_scope
        supplement_osm_pois.source_corrections = self.original_corrections
        supplement_osm_pois.statements_for_pois = self.original_statements

    def test_writes_the_osm_rows_it_found(self):
        seen = {}

        def behaviour(place_id, min_lat, max_lat, min_lng, max_lng, *_a, **_k):
            seen['bounds'] = (place_id, min_lat, max_lat, min_lng, max_lng)
            return ['poi-a', 'poi-b'], {'unique_rows_to_write': 2}, []

        supplement_osm_pois.supplement_scope = behaviour
        supplement_osm_pois.statements_for_pois = lambda pois: [f'INSERT {p}' for p in pois]

        stats = run_job.supplement_place_with_osm('osm-relation-1', 1.0, 2.0, 3.0, 4.0)

        self.assertEqual(stats, {'unique_rows_to_write': 2})
        self.assertEqual(seen['bounds'], ('osm-relation-1', 1.0, 2.0, 3.0, 4.0))
        self.assertEqual(self.d1.statements, ['INSERT poi-a', 'INSERT poi-b'])

    def test_uses_the_bbox_it_is_given_not_a_d1_lookup(self):
        # At this point in map_place the Place row has no extent yet — the
        # build-complete callback is what records it. Reading bounds from D1
        # here (as import_place does) would fail or scope to nothing.
        called = {}

        def behaviour(place_id, min_lat, *_a, **_k):
            called['min_lat'] = min_lat
            return [], {}, []

        supplement_osm_pois.supplement_scope = behaviour
        run_job.supplement_place_with_osm('osm-relation-1', 41.5, 41.6, -8.5, -8.4)
        self.assertEqual(called['min_lat'], 41.5)

    def run_supplement(self):
        """Returns (result, stdout). Both failure branches return None, so the
        log line is the only thing that says WHICH one ran — without it a test
        aimed at the rate-limit branch passes just as happily on any other
        exception, which is exactly how the first version of this test passed
        while raising NameError."""
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            result = run_job.supplement_place_with_osm('osm-relation-1', 1.0, 2.0, 3.0, 4.0)
        return result, out.getvalue()

    def test_a_rate_limit_does_not_fail_the_place(self):
        # The Foursquare rows are already loaded. Failing here would trade a
        # Place with one source for a Place with nothing, over a limit that
        # is not the Place's fault.
        def behaviour(*_a, **_k):
            raise OverpassRateLimited('429')

        supplement_osm_pois.supplement_scope = behaviour
        result, log = self.run_supplement()
        self.assertIsNone(result)
        self.assertIn('rate limited', log)

    def test_any_other_failure_does_not_fail_the_place_either(self):
        def behaviour(*_a, **_k):
            raise RuntimeError('overpass exploded')

        supplement_osm_pois.supplement_scope = behaviour
        result, log = self.run_supplement()
        self.assertIsNone(result)
        # The generic branch, NOT the rate-limit one.
        self.assertIn('OSM supplement failed', log)
        self.assertNotIn('rate limited', log)

    def test_a_d1_write_failure_is_contained(self):
        # Stranding the Place in `mapping` is the one outcome KAN-387 exists
        # to prevent, so a write failure must not propagate out of here.
        supplement_osm_pois.supplement_scope = lambda *a, **k: (['poi-a'], {}, [])
        supplement_osm_pois.statements_for_pois = lambda pois: ['INSERT poi-a']

        def explode(_statement):
            raise FakeD1.D1Error('d1 down')

        self.d1.execute = explode
        self.assertIsNone(run_job.supplement_place_with_osm('osm-relation-1', 1.0, 2.0, 3.0, 4.0))


class MapPlaceOrderTest(unittest.TestCase):
    """The supplement has to run BEFORE the Place is reported mapped."""

    def setUp(self):
        self.saved = {n: getattr(run_job, n) for n in
                      ('worker_client', 'd1_client', 'r2_client', 'nominatim_client', 'extract', 'classify')}
        self.order = []

        run_job.nominatim_client = types.SimpleNamespace(
            lookup_bbox=lambda _pid: (1.0, 2.0, 3.0, 4.0))
        run_job.extract = types.SimpleNamespace(
            BUILD_DIR='/tmp', extract_place=lambda *a, **k: '/tmp/x.csv')
        run_job.classify = lambda *a, **k: {
            'sql_path': '/tmp/x.sql', 'sqlite_path': '/tmp/x.sqlite',
            'raw_extract_r2_key': 'raw/k', 'export_r2_key': 'exports/k',
            'build_id': 'b1', 'rows_loaded': 10, 'rows_skipped': 0,
            'deduplicated': 0, 'min_lat': None,
        }
        run_job.d1_client = types.SimpleNamespace(
            execute_sql_file=lambda _p: self.order.append('d1_load'),
            execute=lambda _s: None)
        run_job.r2_client = types.SimpleNamespace(
            upload_file=lambda *_a: self.order.append('upload'))
        run_job.worker_client = types.SimpleNamespace(
            build_complete=lambda **_k: self.order.append('build_complete'),
            place_failed=lambda *a, **k: self.order.append('place_failed'))
        self.original_supplement = run_job.supplement_place_with_osm
        run_job.supplement_place_with_osm = lambda *a, **k: self.order.append('osm') or {}
        os.environ.setdefault('FOURSQUARE_JWT', 'test')

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(run_job, name, value)
        run_job.supplement_place_with_osm = self.original_supplement

    def test_osm_runs_after_the_foursquare_load_and_before_build_complete(self):
        run_job.map_place('osm-relation-1')

        self.assertIn('osm', self.order)
        self.assertLess(self.order.index('d1_load'), self.order.index('osm'))
        self.assertLess(self.order.index('osm'), self.order.index('build_complete'))
        self.assertNotIn('place_failed', self.order)


class SourceConflictQueueTest(unittest.TestCase):
    """KAN-390 — the disagreements and ambiguities become a queryable queue."""

    def setUp(self):
        self.original_d1 = run_job.d1_client
        self.original_scope = supplement_osm_pois.supplement_scope
        self.original_corrections = supplement_osm_pois.source_corrections
        supplement_osm_pois.source_corrections = lambda: {}
        self.d1 = FakeD1()
        run_job.d1_client = self.d1

    def tearDown(self):
        run_job.d1_client = self.original_d1
        supplement_osm_pois.supplement_scope = self.original_scope
        supplement_osm_pois.source_corrections = self.original_corrections

    @staticmethod
    def conflict(conflict_class, source_id='fsq1'):
        return supplement_osm_pois.PossibleRename(
            osm_element_id='node/1', osm_name='Café Destaque', osm_lat=1.0, osm_lng=2.0,
            poi_type='cafe', source='foursquare', source_id=source_id,
            source_name='A Brazileira de Torres', source_lat=1.0, source_lng=2.0,
            distance_meters=12.4, severity='same_location', conflict_class=conflict_class,
        )

    def test_both_classes_are_written(self):
        supplement_osm_pois.supplement_scope = lambda *a, **k: (
            [], {}, [self.conflict('disagreement'), self.conflict('ambiguous', 'fsq2')])

        run_job.supplement_place_with_osm('osm-relation-1', 1.0, 2.0, 3.0, 4.0)

        written = '\n'.join(self.d1.statements)
        self.assertIn('osm_source_conflict', written)
        self.assertIn("'disagreement'", written)
        self.assertIn("'ambiguous'", written)

    def test_a_scope_with_no_conflicts_writes_nothing(self):
        supplement_osm_pois.supplement_scope = lambda *a, **k: ([], {}, [])
        run_job.supplement_place_with_osm('osm-relation-1', 1.0, 2.0, 3.0, 4.0)
        self.assertEqual(
            [s for s in self.d1.statements if 'osm_source_conflict' in s], [])

    def test_the_upsert_never_resets_a_human_verdict(self):
        # The whole point of a queue is that reviewing something makes it stay
        # reviewed. A scope re-runs for reasons unrelated to the review.
        statements = supplement_osm_pois.statements_for_conflicts(
            [self.conflict('disagreement')], country_code='PT')
        sql = statements[0]
        self.assertIn('ON CONFLICT (osm_element_id, source, source_id, poi_type) DO UPDATE', sql)
        self.assertNotIn('triage_status', sql)
        self.assertNotIn('resolution_note', sql)
        # ...nor claim the row is newly discovered on every run.
        self.assertNotIn('first_seen_at', sql)
        self.assertIn('last_seen_at = CURRENT_TIMESTAMP', sql)

    def test_one_row_per_candidate_the_element_could_have_been(self):
        # An ambiguous element is ambiguous BETWEEN candidates; which one is
        # right is the question being queued, so each is its own row.
        statements = supplement_osm_pois.statements_for_conflicts(
            [self.conflict('ambiguous', 'fsq1'), self.conflict('ambiguous', 'fsq2')])
        self.assertIn("'fsq1'", statements[0])
        self.assertIn("'fsq2'", statements[0])
