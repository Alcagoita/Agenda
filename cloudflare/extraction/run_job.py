"""
KAN-354. Entrypoint for the extraction Container — reads MODE/TARGET from
the environment (set per-invocation via `envVars` when the Worker calls
`container.start(...)`, see cloudflare/src/index.ts's triggerBuild) and
runs the one pipeline both triggers share, per docs/poi-coverage-model.md:

  MODE=place   TARGET=<place_id>       — on-demand, whole Place, all types
  MODE=country TARGET=<country_code>   — pre-build, every settlement in the
                                          country, one Place at a time

Same extraction/classification code either way (extract.py, classify_and_load.py)
— only how the target scope is discovered differs.

D1 and R2 access go through the Worker's own bindings (d1_client.py /
r2_client.py, via extractionContainer.ts's outboundByHost) — no Cloudflare
API token or R2 keys needed here. Required environment:
  FOURSQUARE_JWT       — Iceberg catalog auth (expires; see cloudflare/README.md)
  BUILD_TRIGGER_SECRET — the same secret the Worker's /internal/* routes check
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

def map_place(place_id):
    """The sole Foursquare -> global-POI loader, used by both modes."""
    print(f'[run_job] mapping place: {place_id}')
    stage = 'resolve_place_bounds'
    try:
        min_lat, max_lat, min_lng, max_lng = nominatim_client.lookup_bbox(place_id)
    except Exception as e:
        print(f'[run_job] {e} — cannot scope extraction, failing the Place')
        worker_client.place_failed(place_id, stage, type(e).__name__)
        raise

    try:
        stage = 'foursquare_extract'
        csv_path = extract.extract_place(os.environ['FOURSQUARE_JWT'], place_id, min_lat, max_lat, min_lng, max_lng)
        stage = 'classify'
        sql_path = os.path.join(extract.BUILD_DIR, f'load_{place_id}.sql')
        result = classify(place_id, csv_path, sql_path)
        stage = 'd1_load'
        d1_client.execute_sql_file(result['sql_path'])
        stage = 'raw_extract_upload'
        r2_client.upload_file(csv_path, result['raw_extract_r2_key'])
        stage = 'export_upload'
        r2_client.upload_file(result['sqlite_path'], result['export_r2_key'])
        extent = None
        if result['min_lat'] is not None:
            extent = {k: result[k] for k in ('min_lat', 'max_lat', 'min_lng', 'max_lng')}
        stage = 'build_complete_callback'
        worker_client.build_complete(
            place_id=place_id, build_id=result['build_id'],
            rows_loaded=result['rows_loaded'], rows_skipped=result['rows_skipped'],
            r2_key=result['raw_extract_r2_key'], extent=extent,
        )
        print(f"[run_job] place {place_id} mapped: {result['rows_loaded']} rows")
        return result
    except Exception as e:
        traceback.print_exc()
        # place-failed, not build-complete{status:'failed'} — this can fire
        # before classify() ever ran (extract() itself failing), when no
        # build_id/build_log row exists yet to close out. See
        # /internal/place-failed's own doc comment in cloudflare/src/index.ts.
        worker_client.place_failed(place_id, stage, type(e).__name__)
        raise

def run_place(place_id):
    try:
        map_place(place_id)
    except Exception:
        sys.exit(1)

def run_country(country_code):
    print(f'[run_job] country mode: {country_code}')
    try:
        country_csv = extract.extract_country(os.environ['FOURSQUARE_JWT'], country_code)
        localities = extract.partition_by_locality(country_csv, country_code)
        print(f'[run_job] {len(localities)} distinct localities found for {country_code}')

        # Foursquare localities are only a cheap discovery hint. They are not
        # Place identities: many Lisboa neighbourhoods resolve to Lisboa.
        # Resolve and dedupe ALL of them before any D1 write, then invoke the
        # exact same map_place() pipeline that on-demand mode uses.
        places = {}
        unresolved_count = 0
        for locality_name in localities:
            try:
                lat, lng = extract.locality_centroid(country_csv, locality_name)
                geo = nominatim_client.resolve_place_identity(lat, lng)
                if geo is None:
                    unresolved_count += 1
                    print(f"[run_job] could not resolve a Place identity for locality '{locality_name}' — skipping")
                    continue
                if geo['country_code'] != country_code:
                    unresolved_count += 1
                    print(f"[run_job] locality '{locality_name}' resolved outside {country_code} — skipping")
                    continue
                places.setdefault(geo['place_id'], geo)
            except Exception:
                traceback.print_exc()
                unresolved_count += 1

        mapped_count = 0
        # Unresolved localities are expected: the generic country pass below
        # imports their POIs globally. They are observable, not a failed
        # country build.
        failed_count = 0
        for geo in places.values():
            place_id = geo['place_id']
            try:
                worker_client.ensure_place(place_id, country_code, geo['name'], geo['place_kind'])
                result = map_place(place_id)
                worker_client.country_progress(country_code)
                mapped_count += 1
                print(f"[run_job] {place_id}: {result['rows_loaded']} rows ({mapped_count}/{len(places)})")
            except Exception:
                traceback.print_exc()
                failed_count += 1

        # A final country-wide pass catches POIs with no usable locality or
        # settlement identity. Its synthetic Place has no extent, so it can
        # never influence coverage lookup; it only upserts global POIs.
        generic_id = f'generic:{country_code}'
        try:
            worker_client.ensure_place(generic_id, country_code, f'{country_code} generic POIs', 'generic')
            sql_path = os.path.join(extract.BUILD_DIR, f'load_{country_code}_generic.sql')
            result = classify(generic_id, country_csv, sql_path)
            d1_client.execute_sql_file(result['sql_path'])
            r2_client.upload_file(country_csv, result['raw_extract_r2_key'])
            r2_client.upload_file(result['sqlite_path'], result['export_r2_key'])
            worker_client.build_complete(generic_id, result['build_id'], result['rows_loaded'], result['rows_skipped'], result['raw_extract_r2_key'])
        except Exception:
            traceback.print_exc()
            failed_count += 1

        country_build_id = f'{country_code}-{mapped_count}-places'
        if failed_count:
            print(f'[run_job] country {country_code} incomplete: {mapped_count} mapped, {failed_count} failed, {unresolved_count} unresolved localities covered by generic import')
            worker_client.country_failed(country_code)
            sys.exit(1)
        worker_client.country_complete(country_code, country_build_id)
        print(f'[run_job] country {country_code} complete: {mapped_count} Places mapped')
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
