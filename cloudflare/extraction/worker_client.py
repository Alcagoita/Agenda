"""
KAN-354. Callbacks to the Worker's /internal/* endpoints — closes out a
build the same way the manual pipeline's printed curl command did, minus
the human running it. See cloudflare/README.md's Endpoints section for each
route's contract.
"""
import os
import time
import requests

def _base_url():
    return os.environ.get('POI_API_BASE_URL', 'https://poi-api.brushaway.app')

def _headers():
    return {'X-Build-Secret': os.environ['BUILD_TRIGGER_SECRET'], 'Content-Type': 'application/json'}

def _post(path, body):
    """Internal callbacks are the Job's durable state transitions. Retry
    transient network/5xx failures so a healthy D1 load cannot be stranded
    merely because one callback raced a short Worker/network failure."""
    last_error = None
    for attempt in range(3):
        try:
            res = requests.post(f'{_base_url()}{path}', headers=_headers(), json=body, timeout=30)
            if res.status_code < 500:
                res.raise_for_status()
                return res.json()
            last_error = requests.HTTPError(f'{res.status_code}: {res.text[:500]}')
        except requests.RequestException as error:
            last_error = error
        if attempt < 2:
            time.sleep(attempt + 1)
    raise last_error

def build_complete(place_id, build_id, rows_loaded, rows_skipped, r2_key, extent=None, deduplicated=0):
    """extent, when given: {'min_lat','max_lat','min_lng','max_lng'} — the
    Worker writes these onto the Place row (KAN-354 AC3). Omitted (None)
    when classify() loaded zero rows — an empty extent isn't a real one."""
    body = {
        'cityId': place_id, 'buildId': build_id,
        'rowsLoaded': rows_loaded, 'rowsSkipped': rows_skipped, 'r2Key': r2_key,
        'deduplicated': deduplicated,
    }
    if extent is not None:
        body.update(minLat=extent['min_lat'], maxLat=extent['max_lat'], minLng=extent['min_lng'], maxLng=extent['max_lng'])
    return _post('/internal/build-complete', body)

def build_failed(place_id, build_id):
    return _post('/internal/build-complete', {'cityId': place_id, 'buildId': build_id, 'status': 'failed'})

def place_failed(place_id, stage=None, error=None):
    """Usable at any point in a run, even before a build_id exists — see
    /internal/place-failed's own doc comment in cloudflare/src/index.ts."""
    body = {'cityId': place_id}
    if stage:
        body['stage'] = stage
    if error:
        # This is diagnostic metadata for the Worker log, never a full
        # traceback. Keep callbacks small and avoid accidentally propagating
        # a credential from a lower-level library error.
        body['error'] = str(error)[:1_000]
    return _post('/internal/place-failed', body)

def ensure_place(place_id, country_code, name, place_kind):
    """Create a coverage row for a Place discovered by country mode.

    This deliberately goes through the Worker rather than duplicating the
    Place schema/upsert rules in the Container.
    """
    return _post('/internal/place/ensure', {
        'placeId': place_id, 'countryCode': country_code,
        'name': name, 'placeKind': place_kind,
    })

def country_progress(country_code, run_id, place_id):
    return _post('/internal/country-progress', {
        'countryCode': country_code, 'runId': run_id, 'placeId': place_id,
    })

def country_source(country_code, run_id, raw_extract_r2_key):
    return _post('/internal/country-source', {
        'countryCode': country_code, 'runId': run_id, 'rawExtractR2Key': raw_extract_r2_key,
    })

def country_complete(country_code, run_id, build_id):
    return _post('/internal/country-complete', {'countryCode': country_code, 'runId': run_id, 'buildId': build_id})

def country_audit(country_code, run_id, build_id, stats):
    return _post('/internal/country-audit', {
        'countryCode': country_code, 'runId': run_id, 'buildId': build_id,
        'sourceRows': stats['source_rows'],
        'rowsWithLocality': stats['rows_with_locality'],
        'rowsWithoutLocality': stats['rows_without_locality'],
        'rowsLoaded': stats['rows_loaded'], 'rowsSkipped': stats['rows_skipped'],
        'resolvedLocalities': stats['resolved_localities'],
        'unresolvedLocalities': stats['unresolved_localities'],
        'failedPlaces': stats['failed_places'],
    })

def country_failed(country_code, run_id, stage=None, error=None):
    body = {'countryCode': country_code, 'runId': run_id}
    if stage:
        body['stage'] = stage
    if error:
        body['error'] = str(error)[:1_000]
    return _post('/internal/country-failed', body)


# KAN-387. The country OSM supplement is a claim/checkpoint loop, not one
# long run with a single completion callback. The Worker owns all durable
# state; these are the container's only writes to it.

def osm_claim_batch(country_code, run_id, worker_id, batch_size):
    """Take the country batch lock and claim up to batch_size municipalities.

    `locked: False` or an empty `scopes` both mean the same thing to the
    caller — there is nothing to do, exit and let the cron decide when to
    start another container.
    """
    return _post('/internal/osm-supplement/claim', {
        'countryCode': country_code, 'runId': run_id,
        'workerId': worker_id, 'batchSize': batch_size,
    })


def osm_scope_start(country_code, place_id, worker_id):
    """Record that this scope's work really began.

    Without it an expired lease cannot tell a container that died doing the
    work (charge an attempt) from one that never started (charge nothing).
    """
    return _post('/internal/osm-supplement/scope-start', {
        'countryCode': country_code, 'placeId': place_id, 'workerId': worker_id,
    })


def osm_scope_completed(country_code, place_id, worker_id, stats, rename_report_r2_key=None):
    return _post('/internal/osm-supplement/scope-result', {
        'countryCode': country_code, 'placeId': place_id, 'workerId': worker_id,
        'status': 'completed',
        'inserted': stats.get('unique_rows_to_write', stats.get('inserted', 0)),
        'matchedSkipped': stats.get('matched_skipped', 0),
        'ambiguousSkipped': stats.get('ambiguous_skipped', 0),
        'overpassElements': stats.get('overpass_elements', 0),
        'renameReportR2Key': rename_report_r2_key,
    })


def osm_scope_failed(country_code, place_id, worker_id, error, error_class='overpass_failed'):
    return _post('/internal/osm-supplement/scope-result', {
        'countryCode': country_code, 'placeId': place_id, 'workerId': worker_id,
        'status': 'failed', 'error': str(error)[:1_000], 'errorClass': error_class,
    })


def osm_batch_release(country_code, run_id, worker_id, outcome='done', completed_scopes=0):
    """Drop the country lock. `outcome='rate_limited'` also sets the
    country-wide Overpass backoff and returns every held scope free of
    charge — a 429 is about us, not about the municipality.

    `completed_scopes` is what this batch finished before being throttled.
    It is the signal the backoff escalates on (KAN-389): still working means
    recover, nothing finished means back further off.
    """
    return _post('/internal/osm-supplement/batch-release', {
        'countryCode': country_code, 'runId': run_id,
        'workerId': worker_id, 'outcome': outcome,
        'completedScopes': completed_scopes,
    })
