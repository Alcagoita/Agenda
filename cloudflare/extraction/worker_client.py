"""
KAN-354. Callbacks to the Worker's /internal/* endpoints — closes out a
build the same way the manual pipeline's printed curl command did, minus
the human running it. See cloudflare/README.md's Endpoints section for each
route's contract.
"""
import os
import requests

def _base_url():
    return os.environ.get('POI_API_BASE_URL', 'https://poi-api.brushaway.app')

def _headers():
    return {'X-Build-Secret': os.environ['BUILD_TRIGGER_SECRET'], 'Content-Type': 'application/json'}

def _post(path, body):
    res = requests.post(f'{_base_url()}{path}', headers=_headers(), json=body, timeout=30)
    res.raise_for_status()
    return res.json()

def build_complete(place_id, build_id, rows_loaded, rows_skipped, r2_key, extent=None):
    """extent, when given: {'min_lat','max_lat','min_lng','max_lng'} — the
    Worker writes these onto the Place row (KAN-354 AC3). Omitted (None)
    when classify() loaded zero rows — an empty extent isn't a real one."""
    body = {
        'cityId': place_id, 'buildId': build_id,
        'rowsLoaded': rows_loaded, 'rowsSkipped': rows_skipped, 'r2Key': r2_key,
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

def country_progress(country_code):
    return _post('/internal/country-progress', {'countryCode': country_code})

def country_complete(country_code, build_id):
    return _post('/internal/country-complete', {'countryCode': country_code, 'buildId': build_id})

def country_failed(country_code):
    return _post('/internal/country-failed', {'countryCode': country_code})
