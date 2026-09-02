"""KAN-440 — MULTIBANCO container orchestration stays inside D1 leases."""
import os
import sys
import types
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)


if 'requests' not in sys.modules:
    requests = types.ModuleType('requests')
    requests.RequestException = Exception
    requests.get = None
    requests.post = None
    requests.put = None
    sys.modules['requests'] = requests
if 'duckdb' not in sys.modules:
    sys.modules['duckdb'] = types.ModuleType('duckdb')

import run_job  # noqa: E402


def scope(place_id):
    return {'placeId': place_id, 'minLat': 38.0, 'maxLat': 38.1, 'minLng': -9.2, 'maxLng': -9.1}


class FakeWorkerClient:
    def __init__(self, scopes, locked=True):
        self.claim_response = {'locked': locked, 'scopes': scopes}
        self.completed = []
        self.failed = []
        self.released = []

    def multibanco_claim_batch(self, country_code, run_id, worker_id, batch_size):
        return self.claim_response

    def multibanco_scope_completed(self, country_code, place_id, worker_id, published, rejected, duplicates):
        self.completed.append((place_id, published, rejected, duplicates))
        return True

    def multibanco_scope_failed(self, country_code, place_id, worker_id, error):
        self.failed.append((place_id, error))
        return True

    def multibanco_batch_release(self, country_code, run_id, worker_id, outcome='done'):
        self.released.append(outcome)
        return {'finalized': False, 'counts': {'completed': len(self.completed), 'total': len(self.claim_response['scopes'])}}


class FakeD1:
    def __init__(self):
        self.statements = []

    def execute(self, statement):
        self.statements.append(statement)


class RunMultibancoImportTest(unittest.TestCase):
    def setUp(self):
        self.worker_client = run_job.worker_client
        self.d1_client = run_job.d1_client
        self.fetch_markers = run_job.multibanco_import.fetch_markers
        self.parse_markers = run_job.multibanco_import.parse_markers
        self.statements_for_marker = run_job.multibanco_import.statements_for_marker
        self.utc_now = run_job.multibanco_import.utc_now
        self.sleep = run_job.time.sleep
        self.print_exc = run_job.traceback.print_exc
        self.d1 = FakeD1()
        run_job.d1_client = self.d1
        run_job.time.sleep = lambda _seconds: None
        run_job.traceback.print_exc = lambda: None

    def tearDown(self):
        run_job.worker_client = self.worker_client
        run_job.d1_client = self.d1_client
        run_job.multibanco_import.fetch_markers = self.fetch_markers
        run_job.multibanco_import.parse_markers = self.parse_markers
        run_job.multibanco_import.statements_for_marker = self.statements_for_marker
        run_job.multibanco_import.utc_now = self.utc_now
        run_job.time.sleep = self.sleep
        run_job.traceback.print_exc = self.print_exc

    def test_writes_markers_and_checkpoints_each_successful_scope(self):
        worker = FakeWorkerClient([scope('relation/5400891')])
        run_job.worker_client = worker
        marker = object()
        run_job.multibanco_import.fetch_markers = lambda *_bounds: ('https://locator.test', [marker])
        run_job.multibanco_import.parse_markers = lambda raw: ([marker], 2, 3)
        run_job.multibanco_import.statements_for_marker = lambda *_args: ['INSERT staging;', 'INSERT poi;']
        run_job.multibanco_import.utc_now = lambda: '2026-09-02T00:00:00.000Z'

        run_job.run_multibanco_import('PT', 'run-1')

        self.assertEqual(self.d1.statements, ['INSERT staging;', 'INSERT poi;'])
        self.assertEqual(worker.completed, [('relation/5400891', 1, 2, 3)])
        self.assertEqual(worker.failed, [])
        self.assertEqual(worker.released, ['done'])

    def test_releases_an_empty_claimed_batch(self):
        worker = FakeWorkerClient([])
        run_job.worker_client = worker
        run_job.multibanco_import.fetch_markers = lambda *_bounds: self.fail('locator must not be called')

        run_job.run_multibanco_import('PT', 'run-1')

        self.assertEqual(worker.released, ['done'])

    def test_rate_limit_stops_the_batch_without_failing_the_scope(self):
        worker = FakeWorkerClient([scope('relation/5400891'), scope('relation/5400892')])
        run_job.worker_client = worker

        def rate_limited(*_bounds):
            raise run_job.multibanco_import.LocatorRateLimited('slow down')

        run_job.multibanco_import.fetch_markers = rate_limited
        run_job.run_multibanco_import('PT', 'run-1')

        self.assertEqual(worker.completed, [])
        self.assertEqual(worker.failed, [])
        self.assertEqual(worker.released, ['rate_limited'])

    def test_a_scope_failure_is_checkpointed_and_later_scopes_continue(self):
        worker = FakeWorkerClient([scope('relation/5400891'), scope('relation/5400892')])
        run_job.worker_client = worker
        marker = object()
        calls = 0

        def fetch(*_bounds):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ValueError('invalid payload')
            return 'https://locator.test', [marker]

        run_job.multibanco_import.fetch_markers = fetch
        run_job.multibanco_import.parse_markers = lambda raw: ([marker], 0, 0)
        run_job.multibanco_import.statements_for_marker = lambda *_args: ['INSERT poi;']
        run_job.run_multibanco_import('PT', 'run-1')

        self.assertEqual(worker.failed[0][0], 'relation/5400891')
        self.assertIn('ValueError: invalid payload', worker.failed[0][1])
        self.assertEqual(worker.completed, [('relation/5400892', 1, 0, 0)])
        self.assertEqual(worker.released, ['done'])


if __name__ == '__main__':
    unittest.main()
