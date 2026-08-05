"""
KAN-354. Entrypoint for the Cloud Run Job — reads MODE/TARGET from the
environment (Cloud Run Jobs pass per-execution overrides as env vars, not
CLI args, when triggered via the Jobs API's `overrides.containerOverrides`)
and runs the one pipeline both triggers share, per docs/poi-coverage-model.md:

  MODE=place   TARGET=<place_id>       — on-demand, whole Place, all types
  MODE=country TARGET=<country_code>   — pre-build, every settlement in the
                                          country, one Place at a time

Same extraction/classification code either way (extract.py, classify_and_load.py)
— only how the target scope is discovered differs.

Required environment (see cloudflare/deploy/README.md for how these get set):
  FOURSQUARE_JWT            — Iceberg catalog auth (expires; see cloudflare/README.md)
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN — D1 HTTP API
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (optional) — R2 upload
  BUILD_TRIGGER_SECRET       — the same secret the Worker's /internal/* routes check
  POI_API_BASE_URL (optional, defaults to the production Worker)
"""
import os
import sys
import traceback

import d1_client
import r2_client
import worker_client
import nominatim_client
import extract
from classify_and_load import classify

def run_place(place_id):
    print(f'[run_job] place mode: {place_id}')
    try:
        min_lat, max_lat, min_lng, max_lng = nominatim_client.lookup_bbox(place_id)
    except nominatim_client.PlaceNotResolvable as e:
        print(f'[run_job] {e} — cannot scope extraction, failing the Place')
        worker_client.place_failed(place_id)
        sys.exit(1)

    try:
        csv_path = extract.extract_place(os.environ['FOURSQUARE_JWT'], place_id, min_lat, max_lat, min_lng, max_lng)
        sql_path = os.path.join(extract.BUILD_DIR, f'load_{place_id}.sql')
        result = classify(place_id, csv_path, sql_path)
        d1_client.execute_sql_file(result['sql_path'])
        r2_client.upload_file(csv_path, result['raw_extract_r2_key'])
        r2_client.upload_file(result['sqlite_path'], result['export_r2_key'])
        extent = None
        if result['min_lat'] is not None:
            extent = {k: result[k] for k in ('min_lat', 'max_lat', 'min_lng', 'max_lng')}
        worker_client.build_complete(
            place_id=place_id, build_id=result['build_id'],
            rows_loaded=result['rows_loaded'], rows_skipped=result['rows_skipped'],
            r2_key=result['raw_extract_r2_key'], extent=extent,
        )
        print(f"[run_job] place {place_id} mapped: {result['rows_loaded']} rows")
    except Exception:
        traceback.print_exc()
        # place-failed, not build-complete{status:'failed'} — this can fire
        # before classify() ever ran (extract() itself failing), when no
        # build_id/build_log row exists yet to close out. See
        # /internal/place-failed's own doc comment in cloudflare/src/index.ts.
        worker_client.place_failed(place_id)
        sys.exit(1)

def run_country(country_code):
    print(f'[run_job] country mode: {country_code}')
    try:
        country_csv = extract.extract_country(os.environ['FOURSQUARE_JWT'], country_code)
        localities = extract.partition_by_locality(country_csv, country_code)
        print(f'[run_job] {len(localities)} distinct localities found for {country_code}')

        mapped_count = 0
        for locality_name, locality_csv in localities.items():
            try:
                lat, lng = extract.locality_centroid(country_csv, locality_name)
                geo = nominatim_client.resolve_place_identity(lat, lng)
                if geo is None:
                    print(f"[run_job] could not resolve a Place identity for locality '{locality_name}' — skipping")
                    continue
                place_id = geo['place_id']
                sql_path = os.path.join(extract.BUILD_DIR, f'load_{place_id}.sql')
                result = classify(place_id, locality_csv, sql_path)
                d1_client.execute_sql_file(result['sql_path'])
                r2_client.upload_file(locality_csv, result['raw_extract_r2_key'])
                r2_client.upload_file(result['sqlite_path'], result['export_r2_key'])
                extent = None
                if result['min_lat'] is not None:
                    extent = {k: result[k] for k in ('min_lat', 'max_lat', 'min_lng', 'max_lng')}
                worker_client.build_complete(
                    place_id=place_id, build_id=result['build_id'],
                    rows_loaded=result['rows_loaded'], rows_skipped=result['rows_skipped'],
                    r2_key=result['raw_extract_r2_key'], extent=extent,
                )
                worker_client.country_progress(country_code)
                mapped_count += 1
                print(f"[run_job] {locality_name} -> {place_id}: {result['rows_loaded']} rows ({mapped_count}/{len(localities)})")
            except Exception:
                # One locality's failure doesn't abort the whole country run
                # — KAN-354 AC1 wants progress visible Place by Place, and a
                # single bad locality shouldn't cost every other one already
                # queued behind it. Logged, not re-raised.
                traceback.print_exc()
                print(f"[run_job] locality '{locality_name}' failed, continuing with the rest of {country_code}")

        country_build_id = f'{country_code}-{mapped_count}-places'
        worker_client.country_complete(country_code, country_build_id)
        print(f'[run_job] country {country_code} complete: {mapped_count}/{len(localities)} localities mapped')
    except Exception:
        traceback.print_exc()
        worker_client.country_failed(country_code)
        sys.exit(1)

if __name__ == '__main__':
    os.makedirs(extract.BUILD_DIR, exist_ok=True)
    mode = os.environ.get('MODE')
    target = os.environ.get('TARGET')
    if not mode or not target:
        print('MODE and TARGET env vars are required (MODE=place|country, TARGET=<place_id|country_code>)')
        sys.exit(2)

    if mode == 'place':
        run_place(target)
    elif mode == 'country':
        run_country(target.upper())
    else:
        print(f"unknown MODE '{mode}' — expected 'place' or 'country'")
        sys.exit(2)
