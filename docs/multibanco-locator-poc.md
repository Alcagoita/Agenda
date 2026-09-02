# MULTIBANCO locator POC

## Scope and outcome

This began as a local, read-only proof of concept for using the public
MULTIBANCO locator as a dedicated Portuguese ATM source. KAN-440 implements
the production backend job, but does not start a national harvest until the
Worker migration and image have been deployed. It never calls the locator from
the app, writes Firestore, or changes the separate Foursquare/Overture cutover.

The official site says it has terminals throughout the national territory and
describes the network as roughly 12k–13k terminals. The proposed 13,700 record
benchmark below is a review threshold, not an official exact count or a licence
grant. Obtain confirmation from SIBS/MULTIBANCO before running a national import
or publishing derived data.

Sources: [MULTIBANCO home](https://www.multibanco.pt/) and
[Rede ATM](https://www.multibanco.pt/rede-atm/), checked 2026-09-02.

## Small endpoint validation

The public map code calls:

```text
GET https://www.multibanco.pt/wp-admin/admin-ajax.php
  ?action=sibs_get_markers
  &nelat={north-east latitude}&nelng={north-east longitude}
  &swlat={south-west latitude}&swlng={south-west longitude}
  &zoom={google-map zoom}
```

A read-only central-Lisbon viewport at zoom 18 (`38.7158,-9.1410` to
`38.7180,-9.1370`) returned two records. The response was a JSON array with the
following fields:

```json
{
  "name": "MULTIBANCO",
  "address": "Inatel-Calcada Santana",
  "parish": null,
  "lat": "38.7176410",
  "lng": "-9.1389320",
  "store_type": null,
  "campaign": null
}
```

The page calls this endpoint after `zoom_changed` and `dragend`. It passes map
bounds plus the zoom on each request; this is a viewport API, not a documented
tile feed. The inspected client request has no `limit`, cursor, pagination, or
documented response cap. No national-size request was made, so a server-side
maximum remains unknown and must be discovered only with source-owner approval.

### Odivelas-area trial

With explicit approval for a smaller-area trial, one zoom-12 viewport
(`38.7700,-9.2550` to `38.8250,-9.1450`) returned 168 records on 2026-09-02.
That validates a moderate response can be parsed in one request, but it is not a
municipality-exact Odivelas total: a rectangular map viewport necessarily also
includes nearby Lisbon, Amadora, and the airport edge. No records from this
trial were retained outside the observed aggregate/count or written to a
database.

### Odivelas production pilot

On 2026-09-02 an approved, municipality-bounded pilot used OSM relation
`5400891` (Odivelas) to filter the locator response. The one viewport returned
257 markers; 105 unique provider identities were inside the municipal polygon
and were published as active `atm` POIs in production D1.

Each published `curated_poi` uses a `multibanco:`-prefixed `poi_id` and is
paired one-to-one with `multibanco_import_staging`, which retains the raw
locator payload, endpoint URL, request bounds, municipality relation and fetch
time. The existing `curated_poi.source` constraint permits only `community` or
`manual`, so this import uses `manual` for the ingestion mechanism; the data
source itself is recorded as `multibanco` in staging and in the stable ID. This
is intentionally explicit rather than mislabelling a MULTIBANCO record as a
community contribution.

The repeatable importer is
`scripts/multibancoOdivelasPilot.mjs`; it emits a D1 import file rather than
writing the database directly. It filters against the municipal polygon,
deduplicates exact provider identities, assigns `primary_poi_type = 'atm'`, and
upserts both provenance staging and the already-served curated-POI model.

## Staging/import design

`src/services/multibancoStaging.ts` is a pure contract for an approved backend
worker. Each staged record retains the raw provider payload, exact request
bounds/zoom, fetch timestamp, source URL, normalized values, and a
source-scoped identity. The app must not treat that identity as a provider-free
place identifier.

Because the response has no terminal ID, identity is:

```text
multibanco:{normalised name}:{normalised address}:{latitude to 5 decimals}:{longitude to 5 decimals}
```

That suppresses overlap duplicates from adjacent viewports while keeping a
metadata-only change (for example `campaign`) as an update. Records without a
name, address, or valid coordinates are rejected for review rather than guessed.

KAN-440 implements this as a dedicated first-class source in D1:

- `multibanco_poi` is the app-facing official ATM table. It preserves the
  provider identity, raw marker payload, request URL, and fetch timestamp.
- `multibanco_import_staging` remains the provenance evidence for the Odivelas
  pilot and each idempotent source upsert.
- `multibanco_import` and `multibanco_import_scope` are D1-owned run and
  municipality checkpoints. A Container claims at most eight scopes, publishes
  each one before marking it complete, exits, and cron starts the next batch.
- A locator `429` or `503` returns all claimed scopes to pending, without
  spending their retry budget, and applies a five-minute country backoff.
- The importer makes one locator request per second. This is intentionally
  slower than the earlier 750 ms POC pacing while national behaviour is being
  observed.

The internal operational endpoints are authenticated with the existing build
secret: `POST /internal/multibanco/queue`, `GET /internal/multibanco/status`,
and `POST /internal/multibanco/cancel`. The Container-only claim/result/release
routes are not app-facing.

The Odivelas rollout is reversible query-time precedence: the 105
boundary-filtered official pilot records move into `multibanco_poi` during the
migration, and an official ATM suppresses another `atm` result only when both
are within 20 m in that demo zone. The other source is retained, not deleted.

The job deliberately does not mark source records absent just because one
viewport fails. A successful refresh updates existing provider identities; a
removal policy requires a separately reviewed complete-snapshot design.

The original design criteria remain:

1. Persist a deterministic viewport plan and an empty `multibanco` checkpoint.
2. Fetch one viewport at least 750 ms after the previous request. Persist its
   raw staging batch and completed viewport ID atomically.
3. Resume by selecting the first plan ID not in `completedViewportIds`; failed
   viewports remain incomplete and can be retried with bounded backoff.
4. Deduplicate the whole staging run by source ID, retain all source provenance,
   and require a manual review when the unique count falls outside 11,645–15,755
   (13,700 ±15%). This catches partial runs and obvious source changes without
   asserting an unsupported exact total.
5. Review a completed national count outside 11,645–15,755 (13,700 ±15%) before
   treating it as a healthy refresh; this is an operational alert, not an
   unsupported exact-count assertion.
6. Refresh monthly and retain the prior serving rows if a refresh fails.

The supplied tests exercise parsing, overlap deduplication, malformed data,
resumption, rate timing, refresh timing, national-count validation, D1 leases,
idempotent scope completion, locator backoff, and Odivelas source precedence.
