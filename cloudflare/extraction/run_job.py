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
import uuid

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

def run_country(country_code, run_id):
    print(f'[run_job] country mode: {country_code}')
    stage = 'country_extract'
    try:
        country_csv = extract.extract_country(os.environ['FOURSQUARE_JWT'], country_code)
        # Persist the source before the slower locality stage so recovery can
        # finish a stopped run without downloading Foursquare again.
        source_key = f'country-sources/{country_code}/{uuid.uuid4()}.csv'
        r2_client.upload_file(country_csv, source_key)
        worker_client.country_source(country_code, run_id, source_key)
        stage = 'resolve_localities'
        audit = extract.country_stats(country_csv)
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
                if geo['place_kind'] == 'country':
                    # A Foursquare locality value may itself be a country
                    # name. It is not coverage metadata and mapping its bbox
                    # turns the per-Place stage into an accidental country
                    # extraction. The mandatory generic pass owns such rows.
                    unresolved_count += 1
                    print(f"[run_job] locality '{locality_name}' resolved to a country boundary — skipping")
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
                stage = 'ensure_place'
                worker_client.ensure_place(place_id, country_code, geo['name'], geo['place_kind'])
                stage = 'map_place'
                result = map_place(place_id)
                stage = 'country_progress'
                worker_client.country_progress(country_code, run_id, place_id)
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
            stage = 'generic_ensure_place'
            worker_client.ensure_place(generic_id, country_code, f'{country_code} generic POIs', 'generic')
            stage = 'generic_classify'
            sql_path = os.path.join(extract.BUILD_DIR, f'load_{country_code}_generic.sql')
            result = classify(generic_id, country_csv, sql_path)
            d1_client.execute_sql_file(result['sql_path'])
            r2_client.upload_file(country_csv, result['raw_extract_r2_key'])
            r2_client.upload_file(result['sqlite_path'], result['export_r2_key'])
            worker_client.build_complete(generic_id, result['build_id'], result['rows_loaded'], result['rows_skipped'], result['raw_extract_r2_key'])
            audit.update(rows_loaded=result['rows_loaded'], rows_skipped=result['rows_skipped'])
        except Exception:
            traceback.print_exc()
            failed_count += 1

        stage = 'country_audit'
        country_build_id = str(uuid.uuid4())
        audit.update(
            resolved_localities=len(places), unresolved_localities=unresolved_count,
            failed_places=failed_count,
        )
        # The generic pass classifies the full country CSV, so this equality is
        # the durable proof that every source row was loaded or intentionally
        # skipped by the supported-type policy.
        if failed_count or audit.get('rows_loaded', 0) + audit.get('rows_skipped', 0) != audit['source_rows']:
            print(f'[run_job] country {country_code} incomplete: {mapped_count} mapped, {failed_count} failed, {unresolved_count} unresolved localities covered by generic import')
            raise RuntimeError('country run did not satisfy its completion audit')
        worker_client.country_audit(country_code, run_id, country_build_id, audit)
        stage = 'country_complete'
        worker_client.country_complete(country_code, run_id, country_build_id)
        print(f'[run_job] country {country_code} complete: {mapped_count} Places mapped')
    except BaseException as error:
        traceback.print_exc()
        worker_client.country_failed(country_code, run_id, stage, type(error).__name__)
        sys.exit(1)

def run_country_reconcile(country_code, run_id, source_key):
    """Finish only the generic/audit tail from an R2 country-source artifact."""
    stage = 'restore_country_source'
    try:
        country_csv = os.path.join(extract.BUILD_DIR, f'recovered_country_{country_code}.csv')
        r2_client.download_file(source_key, country_csv)
        audit = extract.country_stats(country_csv)
        generic_id = f'generic:{country_code}'
        stage = 'generic_ensure_place'
        worker_client.ensure_place(generic_id, country_code, f'{country_code} generic POIs', 'generic')
        stage = 'generic_classify'
        result = classify(generic_id, country_csv, os.path.join(extract.BUILD_DIR, f'load_{country_code}_generic_recovery.sql'))
        stage = 'd1_load'
        d1_client.execute_sql_file(result['sql_path'])
        stage = 'export_upload'
        r2_client.upload_file(result['sqlite_path'], result['export_r2_key'])
        stage = 'build_complete_callback'
        worker_client.build_complete(generic_id, result['build_id'], result['rows_loaded'], result['rows_skipped'], source_key)
        audit.update(rows_loaded=result['rows_loaded'], rows_skipped=result['rows_skipped'],
                     resolved_localities=0, unresolved_localities=0, failed_places=0)
        if audit['rows_loaded'] + audit['rows_skipped'] != audit['source_rows']:
            raise RuntimeError('reconciliation source accounting failed')
        stage = 'country_audit'
        build_id = str(uuid.uuid4())
        worker_client.country_audit(country_code, run_id, build_id, audit)
        stage = 'country_complete'
        worker_client.country_complete(country_code, run_id, build_id)
        print(f'[run_job] country {country_code} reconciled from {source_key}')
    except BaseException as error:
        traceback.print_exc()
        worker_client.country_failed(country_code, run_id, stage, type(error).__name__)
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
        run_id = os.environ.get('COUNTRY_RUN_ID')
        if not run_id:
            print('COUNTRY_RUN_ID is required for country mode', file=sys.stderr)
            sys.exit(2)
        run_country(target.upper(), run_id)
    elif mode == 'country-reconcile':
        source_key = os.environ.get('COUNTRY_SOURCE_R2_KEY')
        if not source_key:
            print('COUNTRY_SOURCE_R2_KEY is required for country-reconcile', file=sys.stderr)
            sys.exit(2)
        run_id = os.environ.get('COUNTRY_RUN_ID')
        if not run_id:
            print('COUNTRY_RUN_ID is required for country-reconcile', file=sys.stderr)
            sys.exit(2)
        run_country_reconcile(target.upper(), run_id, source_key)
    else:
        print(f"unknown MODE '{mode}' — expected 'place', 'country', or 'country-reconcile'")
        sys.exit(2)
