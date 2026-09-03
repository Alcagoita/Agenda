"""KAN-443 — country orchestration preserves its raw R2 checkpoint."""
import csv
import os
import sys
import tempfile
import unittest

EXTRACTION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, EXTRACTION_DIR)

try:
    import requests  # noqa: F401
except ImportError:
    import types
    requests = types.ModuleType('requests')
    requests.RequestException = Exception
    requests.post = None
    requests.get = None
    requests.put = None
    sys.modules['requests'] = requests
try:
    import duckdb  # noqa: F401
except ImportError:
    import types
    sys.modules['duckdb'] = types.ModuleType('duckdb')

import run_job  # noqa: E402


class FakeWorker:
    def __init__(self):
        self.source = []
        self.complete = []
        self.failed = []
        self.fail_completion_once = False

    def overture_country_source(self, *args):
        self.source.append(args)

    def overture_country_complete(self, *args):
        self.complete.append(args)
        if self.fail_completion_once:
            self.fail_completion_once = False
            raise RuntimeError('completion callback failed')

    def overture_country_failed(self, *args):
        self.failed.append(args)


class FakeR2:
    def __init__(self):
        self.uploads = []
        self.downloads = []

    def upload_file(self, path, key):
        self.uploads.append((path, key))

    def download_file(self, key, path):
        self.downloads.append((key, path))
        write_csv(path)


class FakeD1:
    def __init__(self):
        self.files = []

    def execute_sql_file(self, path, statements_per_request=50):
        self.files.append((os.path.basename(path), statements_per_request))

    def select(self, _sql):
        return [{'promotion_status': 'promoted', 'count': 1}]


def write_csv(path):
    with open(path, 'w', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=('overture_id', 'name', 'lat', 'lng'))
        writer.writeheader()
        writer.writerow({'overture_id': 'gers-1', 'name': 'Farmácia', 'lat': '38.7', 'lng': '-9.1'})


def write_text(path, value):
    with open(path, 'w') as handle:
        handle.write(value)


class OvertureCountryRunTest(unittest.TestCase):
    def setUp(self):
        self.originals = {name: getattr(run_job, name) for name in (
            'worker_client', 'r2_client', 'd1_client')}
        self.extract = run_job.extract_overture.extract_country
        self.report = run_job.report_overture_backlog.write_report
        self.stage = run_job.load_overture_candidates.write_sql
        self.promote = run_job.promote_overture_candidates.run
        self.build_dir = run_job.extract.BUILD_DIR
        self.temp = tempfile.TemporaryDirectory()
        run_job.extract.BUILD_DIR = self.temp.name
        self.worker, self.r2, self.d1 = FakeWorker(), FakeR2(), FakeD1()
        run_job.worker_client, run_job.r2_client, run_job.d1_client = self.worker, self.r2, self.d1
        def report(_csv, out):
            write_text(out, 'report\n')
        def stage(_csv, out, **_kwargs):
            os.makedirs(out, exist_ok=True)
            write_text(os.path.join(out, '00.sql'), 'INSERT;')
            return 1
        def promote(_batch, out, _dry, *_args):
            os.makedirs(out, exist_ok=True)
            write_text(os.path.join(out, '01.sql'), 'UPDATE;')
            return {'promoted': 1, 'rejected': 0, 'pending': 0}
        run_job.report_overture_backlog.write_report = report
        run_job.load_overture_candidates.write_sql = stage
        run_job.promote_overture_candidates.run = promote

    def tearDown(self):
        for name, value in self.originals.items():
            setattr(run_job, name, value)
        run_job.extract_overture.extract_country = self.extract
        run_job.report_overture_backlog.write_report = self.report
        run_job.load_overture_candidates.write_sql = self.stage
        run_job.promote_overture_candidates.run = self.promote
        run_job.extract.BUILD_DIR = self.build_dir
        self.temp.cleanup()

    def test_extracts_archives_then_stages_and_completes(self):
        run_job.extract_overture.extract_country = lambda _country, path: write_csv(path)
        run_job.run_overture_country('PT', 'run-1')
        self.assertEqual(self.r2.uploads[0][1], 'overture-country-sources/PT/run-1.csv')
        self.assertEqual(self.worker.source[0][2], 'overture-country-sources/PT/run-1.csv')
        self.assertEqual(self.d1.files, [('00.sql', 1), ('01.sql', 1)])
        self.assertEqual(self.worker.complete[0][3]['source_rows'], 1)
        self.assertEqual(self.worker.complete[0][3]['staged_rows'], 1)
        self.assertEqual(self.worker.failed, [])

    def test_resume_downloads_existing_archive_without_extracting_again(self):
        run_job.extract_overture.extract_country = lambda *_args: self.fail('must not extract on resume')
        run_job.run_overture_country('PT', 'run-2', 'overture-country-sources/PT/old-run.csv')
        self.assertEqual(self.r2.downloads[0][0], 'overture-country-sources/PT/old-run.csv')
        self.assertEqual(self.r2.uploads[0][1], 'overture-country-reports/PT/run-2.tsv')
        self.assertEqual(self.worker.source[0][2], 'overture-country-sources/PT/old-run.csv')

    def test_retry_after_promotion_uses_scoped_decision_counts_for_completion(self):
        run_job.extract_overture.extract_country = lambda _country, path: write_csv(path)
        self.worker.fail_completion_once = True
        with self.assertRaisesRegex(RuntimeError, 'completion callback failed'):
            run_job.run_overture_country('PT', 'run-1')
        # This is the same immutable source a Worker re-queue passes in. The
        # promotion fake still reports no per-run counts, so only the scoped
        # D1 aggregate can make the retry's terminal accounting correct.
        run_job.run_overture_country('PT', 'run-2', 'overture-country-sources/PT/run-1.csv')
        self.assertEqual(self.worker.complete[-1][3], {
            'source_rows': 1, 'staged_rows': 1, 'dropped_rows': 0,
            'promoted_rows': 1, 'rejected_rows': 0, 'pending_rows': 0,
        })


if __name__ == '__main__':
    unittest.main()
