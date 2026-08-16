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


def osm_supplement_complete(country_code, run_id, stats):
    return _post('/internal/osm-supplement/complete', {
        'countryCode': country_code, 'runId': run_id,
        'sourceElements': stats.get('source_elements', 0),
        'insertedRows': stats.get('unique_rows_to_write', stats.get('inserted', 0)),
        'matchedSkipped': stats.get('matched_skipped', 0),
        'ambiguousSkipped': stats.get('ambiguous_skipped', 0),
    })


def osm_supplement_failed(country_code, run_id, error):
    return _post('/internal/osm-supplement/failed', {
        'countryCode': country_code, 'runId': run_id,
        'error': str(error)[:1_000],
    })
