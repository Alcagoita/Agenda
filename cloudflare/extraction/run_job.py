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
import time
import traceback
import uuid
import csv

import d1_client
import r2_client
import worker_client
import nominatim_client
import extract
from classify_and_load import classify
import settlement_registry
import supplement_osm_pois
import enrich_osm_cuisine
import multibanco_import
import extract_overture
import load_overture_candidates
import promote_overture_candidates
import report_overture_backlog

# KAN-387. Municipalities per container invocation, processed serially —
# Overpass politeness, and small enough that a dead instance loses little.
# The Worker caps this too (OSM_SCOPE_BATCH_SIZE in osmSupplement.ts); it is
# the authority, this is the request.
OSM_SCOPE_BATCH_SIZE = 8
MULTIBANCO_SCOPE_BATCH_SIZE = 8


def _csv_row_count(path):
    with open(path, newline='') as handle:
        return sum(1 for _ in csv.DictReader(handle))


def _execute_sql_directory(path):
    for name in sorted(os.listdir(path)):
        if name.endswith('.sql'):
            d1_client.execute_sql_file(os.path.join(path, name))


def run_overture_country(country_code, run_id, source_r2_key=None):
    """Archive Overture in R2 before D1 work; retries reuse that archive."""
    os.environ['D1_INTERNAL'] = '1'
    work_dir = os.path.join(extract.BUILD_DIR, f'overture-country-{run_id}')
    csv_path = os.path.join(work_dir, f'{country_code}.csv')
    report_path = os.path.join(work_dir, 'unresolved.tsv')
    stage_dir = os.path.join(work_dir, 'stage-sql')
    promote_dir = os.path.join(work_dir, 'promote-sql')
    os.makedirs(work_dir, exist_ok=True)
    try:
        if source_r2_key:
            r2_client.download_file(source_r2_key, csv_path)
            raw_key = source_r2_key
        else:
            extract_overture.extract_country(country_code, csv_path)
            raw_key = f'overture-country-sources/{country_code}/{run_id}.csv'
            r2_client.upload_file(csv_path, raw_key)
        source_rows = _csv_row_count(csv_path)
        worker_client.overture_country_source(country_code, run_id, raw_key, source_rows)

        # This reads the archived CSV locally and streams its report before
        # any staging write; it is not a country-scale D1 scan.
        report_overture_backlog.write_report(csv_path, report_path)
        report_key = f'overture-country-reports/{country_code}/{run_id}.tsv'
        r2_client.upload_file(report_path, report_key)

        staged_rows = load_overture_candidates.write_sql(csv_path, stage_dir)
        _execute_sql_directory(stage_dir)
        promotion = promote_overture_candidates.run(10000, promote_dir, False)
        _execute_sql_directory(promote_dir)
        stats = {
            'source_rows': source_rows, 'staged_rows': staged_rows,
            'dropped_rows': source_rows - staged_rows,
            'promoted_rows': promotion.get('promoted', 0),
            'rejected_rows': promotion.get('rejected', 0),
            'pending_rows': promotion.get('pending', 0),
        }
        worker_client.overture_country_complete(country_code, run_id, report_key, stats)
        print(f'[run_job] Overture {country_code}: {stats}')
    except Exception as error:
        traceback.print_exc()
        try:
            worker_client.overture_country_failed(country_code, run_id, f'{type(error).__name__}: {error}')
        except Exception:
            traceback.print_exc()
        raise

def supplement_place_with_osm(place_id, min_lat, max_lat, min_lng, max_lng, country_code=None):
    """The per-Place OSM pass (KAN-394). Additive, and never fails the Place.

    Before this, "mapped" meant two different things. A country-mapped Place
    got Foursquare AND the OSM supplement — 75,491 OSM-only venues across PT,
    the small cafes and talhos the open Foursquare dataset never had. An
    on-demand Place got Foursquare alone, and reported the same `mapped`. A
    user asking for Tokyo was quietly given a thinner database than a user in
    Lisboa.

    One Place is one bbox, which is exactly the unit `supplement_scope`
    already claims and checkpoints for the country run — so this reuses it
    rather than inventing a second path. The country's claim/lease machinery
    is not reused: it exists to spread 307 municipality scopes across
    container lifetimes, and a single scope has nothing to spread.

    The bbox comes from the caller, not from `import_place`'s D1 lookup: at
    this point in the flow the Place row has no extent yet, because the
    build-complete callback is what records it.

    **A failure here does not fail the Place.** The Foursquare rows are
    already loaded and useful, so the choice is between a Place mapped with
    one source and a Place with nothing. Overpass being rate limited is not
    the Place's fault, and stranding it in `mapping` is the one outcome
    KAN-387 was written to prevent. The shortfall is logged and the Place
    completes; re-running the supplement later fills it in, because the write
    is idempotent on the OSM element id.
    """
    try:
        imports, stats, conflicts = supplement_osm_pois.supplement_scope(
            place_id, min_lat, max_lat, min_lng, max_lng,
        )
        # D1 first: a crash before returning re-runs the scope, which the
        # element-id upsert makes harmless.
        for statement in supplement_osm_pois.statements_for_pois(imports):
            d1_client.execute(statement)
        # KAN-390 — an on-demand Place produces the same staleness evidence a
        # country scope does, and it is worth just as much.
        for statement in supplement_osm_pois.statements_for_conflicts(
            conflicts, country_code=country_code, place_id=place_id,
        ):
            d1_client.execute(statement)
        print(f"[run_job] {place_id}: OSM supplement added "
              f"{stats.get('unique_rows_to_write', 0)} rows, "
              f"{len(conflicts)} source conflicts")
        return stats
    except enrich_osm_cuisine.OverpassRateLimited:
        traceback.print_exc()
        print(f'[run_job] {place_id}: Overpass rate limited — completing the '
              'Place with Foursquare data only, OSM can be re-run later')
        return None
    except Exception:
        traceback.print_exc()
        print(f'[run_job] {place_id}: OSM supplement failed — completing the '
              'Place with Foursquare data only')
        return None


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
        # KAN-394 — before the Place is reported mapped, so `mapped` means the
        # same thing however the Place got here.
        stage = 'osm_supplement'
        supplement_place_with_osm(place_id, min_lat, max_lat, min_lng, max_lng)
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
            deduplicated=result['deduplicated'],
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
            worker_client.build_complete(generic_id, result['build_id'], result['rows_loaded'], result['rows_skipped'], result['raw_extract_r2_key'], deduplicated=result['deduplicated'])
            audit.update(rows_loaded=result['rows_loaded'], rows_skipped=result['rows_skipped'] + result['deduplicated'])
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
        worker_client.build_complete(generic_id, result['build_id'], result['rows_loaded'], result['rows_skipped'], source_key, deduplicated=result['deduplicated'])
        audit.update(rows_loaded=result['rows_loaded'], rows_skipped=result['rows_skipped'] + result['deduplicated'],
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

def run_settlement_registry(country_code):
    """Import geographic settlement metadata; never touch Foursquare POIs."""
    print(f'[run_job] settlement registry mode: {country_code}')
    try:
        result = settlement_registry.import_country_settlements(country_code)
        print(f"[run_job] settlement registry {country_code} complete: {result['upserted']} areas")
    except BaseException:
        traceback.print_exc()
        sys.exit(1)


def run_osm_supplement(country_code, run_id):
    """One bounded batch of municipality scopes, then exit (KAN-387).

    KAN-383 ran every municipality in one container and wrote D1 only at the
    end; PT's 307 scopes could not finish inside a container lifetime, and
    the run that died left no checkpoint and no error. Here the container
    claims a few scopes, persists after each one, releases the country lock
    and exits. The Worker's cron starts the next batch while claimable
    scopes remain, so an instance dying costs at most one batch.

    Writes stay idempotent on the OSM element id, so re-running a scope that
    died mid-write cannot duplicate a POI.
    """
    os.environ['D1_INTERNAL'] = '1'
    worker_id = str(uuid.uuid4())
    print(f'[run_job] OSM supplement {country_code} batch, worker {worker_id}')
    claim = worker_client.osm_claim_batch(country_code, run_id, worker_id, OSM_SCOPE_BATCH_SIZE)
    scopes = claim.get('scopes') or []
    if not claim.get('locked'):
        # Another batch holds the country lock, the country is backing off
        # from a 429, or a cancel is pending. None of them is a failure, and
        # there is no lock of ours to give back.
        print(f'[run_job] no country lock for {country_code} — another batch owns it')
        return
    if not scopes:
        # Locked but nothing to claim: the run is finished. Releasing is what
        # finalizes it — returning here without releasing would hold the
        # country lock until its lease expired and stall the cron.
        released = worker_client.osm_batch_release(country_code, run_id, worker_id, 'done')
        print(f"[run_job] no claimable scopes for {country_code}; finalized={released.get('finalized')}")
        return

    corrections = supplement_osm_pois.source_corrections()
    outcome = 'done'
    # What this batch actually achieved. The country-wide backoff escalates
    # on this rather than on the bare fact of a 429 (KAN-389) — being
    # throttled while still finishing municipalities is not the same as
    # being blocked outright.
    completed_scopes = 0
    for index, scope in enumerate(scopes, start=1):
        place_id = scope['placeId']
        print(f"[run_job] scope {index}/{len(scopes)}: {place_id}")
        try:
            worker_client.osm_scope_start(country_code, place_id, worker_id)
            imports, stats, renames = supplement_osm_pois.supplement_scope(
                place_id, scope['minLat'], scope['maxLat'], scope['minLng'], scope['maxLng'], corrections,
            )
            # D1 first, then the checkpoint: a crash between them re-runs the
            # scope, which the element-id upsert makes harmless. The reverse
            # order could mark a scope done that wrote nothing.
            for statement in supplement_osm_pois.statements_for_pois(imports):
                d1_client.execute(statement)
            # KAN-390 — the queryable half of the same evidence. Written
            # after the POIs and before the checkpoint, so a crash re-runs
            # the scope and the upsert makes that harmless.
            for statement in supplement_osm_pois.statements_for_conflicts(
                renames, country_code=country_code, place_id=place_id, run_id=run_id,
            ):
                d1_client.execute(statement)
            report_key = f'osm-rename-reports/{country_code}/{run_id}/{place_id}.json'
            try:
                r2_client.upload_bytes(supplement_osm_pois.rename_report_json(place_id, renames), report_key)
            except Exception:
                # The report is a review artifact, not the deliverable. Its
                # POIs are already in D1, so failing the scope here would
                # spend a retry attempt re-doing work that is done.
                traceback.print_exc()
                print(f'[run_job] rename report upload failed for {place_id} — keeping the scope complete')
                report_key = None
            worker_client.osm_scope_completed(country_code, place_id, worker_id, stats, report_key)
            completed_scopes += 1
            print(f"[run_job] {place_id}: {stats.get('unique_rows_to_write', 0)} rows written")
        except enrich_osm_cuisine.OverpassRateLimited as error:
            # Country-wide stop. Every scope this worker holds goes back
            # unpenalised — the limit is on us, not on the municipality, and
            # spending retry budget on it would eventually park good scopes.
            traceback.print_exc()
            print(f'[run_job] Overpass rate limited on {place_id} — backing off the whole country')
            outcome = 'rate_limited'
            break
        except Exception as error:
            traceback.print_exc()
            error_class = 'd1' if isinstance(error, d1_client.D1Error) else 'overpass_failed'
            try:
                worker_client.osm_scope_failed(country_code, place_id, worker_id, f'{type(error).__name__}: {error}', error_class)
            except Exception:
                # Either our lease is gone (the Worker rejects a result for a
                # scope we no longer hold) or the callback itself could not be
                # delivered. Both mean stop — the lease is the authority, not
                # this process. Still offer the lock back: if we do hold it,
                # returning without releasing would stall the cron for the
                # rest of the lease. Best-effort, and never allowed to mask
                # the failure that got us here.
                traceback.print_exc()
                try:
                    worker_client.osm_batch_release(country_code, run_id, worker_id, 'done')
                except Exception:
                    traceback.print_exc()
                print(f'[run_job] could not record {place_id} — abandoning the batch')
                return

    released = worker_client.osm_batch_release(country_code, run_id, worker_id, outcome, completed_scopes)
    counts = released.get('counts') or {}
    print(f"[run_job] batch {outcome}: {completed_scopes} of {len(scopes)} scopes this batch, "
          f"{counts.get('completed')}/{counts.get('total')} overall, finalized={released.get('finalized')}")


def run_multibanco_import(country_code, run_id):
    """Fetch a paced, bounded locator batch and checkpoint each scope."""
    os.environ['D1_INTERNAL'] = '1'
    worker_id = str(uuid.uuid4())
    claim = worker_client.multibanco_claim_batch(country_code, run_id, worker_id, MULTIBANCO_SCOPE_BATCH_SIZE)
    scopes = claim.get('scopes') or []
    if not claim.get('locked'):
        print(f'[run_job] MULTIBANCO {country_code}: no claimable batch')
        return
    if not scopes:
        print(f"[run_job] MULTIBANCO {country_code}: finalized={worker_client.multibanco_batch_release(country_code, run_id, worker_id).get('finalized')}")
        return
    outcome = 'done'
    for scope in scopes:
        try:
            source_url, raw = multibanco_import.fetch_markers(scope['minLat'], scope['maxLat'], scope['minLng'], scope['maxLng'])
            markers, rejected, duplicates = multibanco_import.parse_markers(raw)
            fetched_at = multibanco_import.utc_now()
            bounds = {'minLat': scope['minLat'], 'maxLat': scope['maxLat'], 'minLng': scope['minLng'], 'maxLng': scope['maxLng']}
            for marker in markers:
                for statement in multibanco_import.statements_for_marker(marker, scope['placeId'], source_url, bounds, fetched_at):
                    d1_client.execute(statement)
            if not worker_client.multibanco_scope_completed(country_code, scope['placeId'], worker_id, len(markers), rejected, duplicates):
                raise RuntimeError('scope checkpoint was rejected')
            # Never burst requests merely because the upstream was fast.
            time.sleep(multibanco_import.REQUEST_INTERVAL_SECONDS)
        except multibanco_import.LocatorRateLimited:
            traceback.print_exc()
            outcome = 'rate_limited'
            break
        except Exception as error:
            traceback.print_exc()
            worker_client.multibanco_scope_failed(country_code, scope['placeId'], worker_id, f'{type(error).__name__}: {error}')
    released = worker_client.multibanco_batch_release(country_code, run_id, worker_id, outcome)
    print(f"[run_job] MULTIBANCO {country_code}: {outcome}, {released.get('counts', {}).get('completed')}/{released.get('counts', {}).get('total')} scopes")

if __name__ == '__main__':
    os.makedirs(extract.BUILD_DIR, exist_ok=True)
    mode = os.environ.get('MODE')
    target = os.environ.get('TARGET')
    if not mode or not target:
        print('MODE and TARGET env vars are required (MODE=place|country|settlements, TARGET=<place_id|country_code>)')
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
    elif mode == 'settlements':
        run_settlement_registry(target.upper())
    elif mode == 'osm-country':
        run_id = os.environ.get('OSM_SUPPLEMENT_RUN_ID')
        if not run_id:
            print('OSM_SUPPLEMENT_RUN_ID is required for osm-country mode', file=sys.stderr)
            sys.exit(2)
        run_osm_supplement(target.upper(), run_id)
    elif mode == 'multibanco-country':
        run_id = os.environ.get('MULTIBANCO_RUN_ID')
        if not run_id:
            print('MULTIBANCO_RUN_ID is required for multibanco-country mode', file=sys.stderr)
            sys.exit(2)
        run_multibanco_import(target.upper(), run_id)
    elif mode == 'overture-country':
        run_id = os.environ.get('OVERTURE_COUNTRY_RUN_ID')
        if not run_id:
            print('OVERTURE_COUNTRY_RUN_ID is required for overture-country mode', file=sys.stderr)
            sys.exit(2)
        run_overture_country(target.upper(), run_id, os.environ.get('COUNTRY_SOURCE_R2_KEY'))
    else:
        print(f"unknown MODE '{mode}' — expected 'place', 'country', 'country-reconcile', 'settlements', 'osm-country', 'multibanco-country', or 'overture-country'")
        sys.exit(2)
