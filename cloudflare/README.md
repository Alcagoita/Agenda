# Brush POI Backend (Cloudflare)

KAN-329 — replaces live Google/Foursquare calls with our own POI database for
major cities. Google Places API stays as the permanent fallback for
small/rural cities (see project memory `project_poi_backend_migration_plan`).

## Architecture

- **Workers** (`src/index.ts`) — the API. Deployed at `poi-api.brushaway.app`.
- **D1** — one shared database (`brush-poi-registry`) for everything: `place`
  (which settlements exist, map status — KAN-355, renamed from `city`),
  `country` (which countries the background worker maps wholesale — KAN-355,
  new), `poi` (all Places' places, scoped by a `place_id` column), and
  `build_log` (one row per extraction run — KAN-333's build lifecycle).
  **Not** one database per Place — 10GB is D1's hard per-database ceiling
  regardless of plan tier, which breaks past a relatively small number of
  Places if sharded that way. One shared table scales much further, at
  current ~7MB/Place average. Full model reasoning:
  `docs/poi-coverage-model.md`.
- **Build lifecycle** (KAN-333): every load tags its `poi` rows with a fresh
  `build_id`. Loading is `INSERT OR REPLACE` on the `(place_id, fsq_place_id)`
  PK, so a place present in both the old and new build just updates in
  place. After loading, a sweep (`DELETE ... WHERE place_id = ? AND build_id
  != ?`) retires anything that didn't reappear (closed places) — see the
  comment at the top of `schema.sql` for the non-atomicity tradeoff.
  `/internal/build-complete` closes out both `place.status` and the matching
  `build_log` row.
- **R2** (`brush-poi-exports`) — holds two things per build: the raw
  Foursquare extract (`raw-extracts/{cityId}/{buildId}.csv`, for
  reproducibility) and the client-download export (KAN-339,
  `exports/{cityId}/{buildId}.sqlite`) — a standalone, build-specific SQLite
  file with that city's `poi`/`poi_type`/`poi_attribute` rows, written by
  `write_sqlite_export()` in `extraction/classify_and_load.py` from the same
  in-memory rows the D1 load SQL comes from within that run. The local file
  is also named per-build (`build/export_{cityId}_{buildId}.sqlite`), not
  just per-city — a rerun for the same city can't silently overwrite an
  earlier build's not-yet-uploaded local file out from under its own
  already-printed upload command. Served to clients via `GET /export/:cityId`
  (X-Api-Key gated, not a public R2 URL). Client-side download/caching
  integration (which app screen triggers this, when to re-download) is its
  own follow-up ticket, per KAN-339's own scope note — not built here.
- No R-tree/geospatial index on D1 (confirmed unsupported, and R2 SQL's
  geospatial support is still "exploring" per Cloudflare's own docs) —
  radius search uses geohash prefix range queries instead
  (`src/geohash.ts`), same algorithm reimplemented in Python for the
  extraction script (`extraction/classify_and_load.py`) — the two must stay
  in sync or radius queries silently miss rows.

## Endpoints

All require `X-Api-Key: <API_KEY>` header except `/internal/*`, which uses a
separate `X-Build-Secret: <BUILD_TRIGGER_SECRET>` header instead.

- `GET /poi?lat=&lng=&radius=&type=&attribute=&value=` — POIs of one type
  within a radius, optionally narrowed to 1-2 `poi_attribute` values (e.g.
  `type=restaurant&attribute=food_cuisine&value=sushi`)
- `GET /poi/all?lat=&lng=&radius=` — all cached types within a radius
- `GET /coverage?lat=&lng=` — `{status, cityId, buildId}` for this location.
  `buildId` (KAN-339) lets a client compare its locally cached download's
  build against the current one without fetching `/export/:cityId` just to
  check.
- `GET /export/:cityId` — the current build's client-download SQLite export
  (KAN-339), streamed from R2. 404 if the Place isn't `ready`, or if it's
  `ready` but predates this ticket and has no export object yet. Route and
  param name unchanged by KAN-355 on purpose — the rename to
  `/export/:placeId` is explicitly KAN-343's scope.
- `POST /coverage/request` `{lat,lng}` — `{coverageStatus, cityId, retryAfterSeconds?}`
  for this specific location (KAN-346/355/354). **Public response shape is
  unchanged since KAN-346** — `cityId` and the `none`/`building`/`ready`
  status values are the wire contract the Cloud Function proxy and app
  client ship against; only the internal DB model changed, and the Worker
  translates at the response boundary (`toApiStatus` in `index.ts`).
  Reverse-geocodes server-side to a stable Place identity (Nominatim
  `osm_type:osm_id`, retried at a coarser zoom when the finest zoom
  resolves to a sub-unit of a named settlement, e.g. a Lisboa freguesia
  instead of Lisboa itself) and dedupes on it. An already-mapped location
  returns its state as-is, with no geocode call (the DB's own
  ingested-extent bbox short-circuits it — see `findPlace`). A brand new or
  previously-recorded-but-unmapped Place is atomically promoted `none` ->
  `mapping` and the extraction trigger (`BUILD_TRIGGER_URL`, KAN-354) fires
  exactly once (`startPlaceMapping`) — every other concurrent/later request
  for the same Place just observes `mapping` and does nothing further.
  Capped at `MAX_PENDING_DEMAND_PLACES` pending (`status='none'`) rows
  before a brand new Place gets HTTP 429 `{error}` instead — a `'none'` row
  is normally short-lived now (promoted in the same request), so this
  mostly guards the case where `BUILD_TRIGGER_URL` isn't configured at all
  (local dev) and rows can't move past `none`.
- `POST /internal/build-complete` `{cityId, buildId, rowsLoaded?, rowsSkipped?, status?, r2Key?}`
  — called by the extraction Job once a Place's rows are loaded (or failed);
  `cityId` targets `place.place_id` — kept as the field name for this
  internal-only contract. On success, flips `place.status` to `mapped`
  (API-visible as `ready`), sets `place.build_id`, closes out the matching
  `build_log` row. On `status: 'failed'`, closes `build_log` as `failed`
  and — only if this Place was never previously mapped (`build_id` still
  null) — reverts `place.status` back to `none` so a future zero-check
  naturally retries it; a failed *re-map* of an already-mapped Place never
  un-maps it, the last successful build keeps serving.
- `POST /internal/country/queue` `{countryCode}` — KAN-354's country
  pre-build trigger, operational (queued by whoever decides which country
  goes next, not automatically). Promotes `none` -> `mapping` and fires the
  trigger with `mode: 'country'`; idempotent — queuing an
  already-`mapping`/`mapped` country just reports its current status,
  never a second job. 404s if the country has no row yet (create one first
  — e.g. via a `/coverage/request` for a point in it, or a direct D1 insert).
- `POST /internal/country-progress` `{countryCode}` — called by a
  country-mode Job once per Place it finishes, incrementing
  `country.place_count` so progress is visible before the whole run ends.
- `POST /internal/country-complete` `{countryCode, buildId}` — the whole
  country finished; sets `country.status` to `mapped`.
- `POST /internal/country-failed` `{countryCode}` — the whole run errored;
  reverts `country.status` to `none` (only if still `mapping` — a stale
  duplicate callback must not clobber a country a later run already
  completed) so it can be re-queued.

## Local setup

```bash
cd cloudflare
npm install
export CLOUDFLARE_API_TOKEN='<token — Workers Scripts:Edit, D1:Edit, R2:Edit, Account Settings:Read>'
export CLOUDFLARE_ACCOUNT_ID='d1157e9669661ba343c620e2c82ab840'
npx wrangler deploy
```

Secrets (`API_KEY`, `BUILD_TRIGGER_SECRET`) are already set on the deployed
Worker via `wrangler secret put` — not in `wrangler.jsonc`. Local copies live
in `.dev.vars` (gitignored, never committed) for testing against the live
API from a shell: `source .dev.vars`.

### Known gaps in this token's permissions

This Cloudflare API token **cannot** manage DNS records or Worker Routes on
the `brushaway.app` zone (`Zone:DNS`/`Zone:Workers Routes` not granted) —
both are currently configured manually via the dashboard, not in
`wrangler.jsonc`. If routing/DNS ever needs to change, either do it in the
dashboard directly, or get a zone-scoped token addition for
`brushaway.app` specifically.

## Extraction pipeline (manual today, not yet automated)

**KAN-354 automated this.** `extraction/run_job.py` is now the real
entrypoint — reads `MODE`/`TARGET` from the environment, resolves scope
(a Place's bbox via Nominatim, or a whole country via Foursquare's own
`country` field), runs extraction + `classify_and_load.py`'s classification
(now `place_id`-keyed, matching the KAN-355 schema) automatically, uploads
to D1 (`d1_client.py`, Cloudflare's HTTP Query API) and R2 (`r2_client.py`,
S3-compatible API) without a human running `wrangler` by hand, and closes
the build out via the Worker's `/internal/*` routes
(`worker_client.py`). Deployed as a Cloud Run Job — see
`cloudflare/deploy/README.md` for the actual `gcloud` commands (not run
from the environment that wrote this, see that file's own caveat).

`classify_and_load.py`'s direct CLI usage (`python3 classify_and_load.py
<place_id>`) still works for a one-off manual run against an
already-extracted CSV — useful for debugging a single Place's
classification without going through the whole Job.

Source: [Foursquare OS Places](https://opensource.foursquare.com/os-places/)
(Apache 2.0, bulk-storable — unlike the live Foursquare Search API, which
explicitly forbids caching on a Pay-as-you-go key). Queried via DuckDB
against Foursquare's Iceberg REST catalog.

**Auth — the non-obvious part**: `catalog.h3-hub.foursquare.com/iceberg`
needs a **JWT issued by `datahub-metadata-service`** from the Places
Portal (decodes to `{"actorType":"USER","iss":"datahub-metadata-service",...}`).
The live-API bearer key, a plain Portal access token, and a proper OAuth2
client_id/client_secret pair all fail with a flat 401 — only that specific
JWT works. It has a real `exp` claim (personal access token, not a service
credential) — get a fresh one from the Places Portal when it expires.

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET iceberg_secret (TYPE ICEBERG, TOKEN '<the JWT>');
ATTACH 'places' AS places (TYPE iceberg, SECRET iceberg_secret, ENDPOINT 'https://catalog.h3-hub.foursquare.com/iceberg');
SELECT * FROM places.datasets.places_os LIMIT 1000;    -- the actual places table
SELECT * FROM places.datasets.categories_os LIMIT 100; -- category taxonomy (1,279 rows)
```

**Category mapping**: `src/poiTypeCategories.json` (90 Brush POI types →
Foursquare category_id, covers the full `poiDictionary.en.json` set, not
just the 16-entry built-in catalog), `src/storeSubtypeCategories.json` (14),
`src/foodSubtypeCategories.json` (10) — all hand-verified against the real
1,279-row Foursquare taxonomy (`build/fsq_categories.csv`), not guessed.

**Keyword fallback (KAN-340)**: Foursquare frequently tags a place as the
generic `restaurant`/`store` with no specific cuisine/kind category id at
all — no amount of extraction-filter widening recovers that (confirmed:
"Miya Sushi & Ramen" carries only the generic "Restaurant" tag, nothing
else). When category-tag matching finds nothing for `food_cuisine`/
`store_kind` on an already-classified restaurant/store row, `classify()`
falls back to matching the place's own name against the app's existing
`src/constants/restaurantFoodDictionary.json` /
`storeSubtypeDictionary.json` alias lists — same dictionaries used for
task-title inference elsewhere in the app, not a third parallel list.
Real but modest recovery given the dictionaries' size (10 cuisines, 14
store kinds): +120 `food_cuisine` / +36 `store_kind` rows on Lisboa,
+22 / +8 on Odivelas.

**OSM enrichment (`extraction/enrich_osm_cuisine.py`, KAN-340's originally
higher-priority source)**: run separately from `classify_and_load.py`, not
inline — Overpass is a slow, flaky, retryable external call (~40-60%
single-attempt failure rate per KAN-322) that doesn't belong in the fast
synchronous Foursquare pipeline. Queries Overpass for the city's
`cuisine=`/`shop=`-tagged elements, matches them to `poi` rows still
missing a subtype after *both* the category-tag and keyword-fallback
passes (by normalized name + ≤75m proximity — deliberately conservative to
avoid mismatching two different nearby businesses with similar names), and
writes new `poi_attribute` rows tagged with the city's current
`build_id` (read live from D1) so they survive that build's sweep.
**Must be re-run after every future Foursquare re-extraction for the same
city**, or this enrichment is lost when the next build's sweep retires the
previous build's `poi_attribute` rows — same requirement as the keyword
pass, just a separate manual step here instead of automatic.

Usage: `python3 extraction/enrich_osm_cuisine.py <city_id>` (after the
regular pipeline has already loaded that city), then run the printed
`wrangler d1 execute --file=...` command.

Real yield, measured against actual OSM/Foursquare name overlap in these
two cities (most OSM elements simply don't share a listing with
Foursquare at all — of 200 sampled cuisine-tagged OSM elements near
Odivelas, only 22% had any same-named Foursquare row, 18% also within
75m): +5 `food_cuisine` on Lisboa, +2 on Odivelas (a later review round
tightened the OSM tag mapping — removed `japanese`→`sushi` and
`stationery`→`books`, both broad-to-narrow guesses that could mislabel a
real place, and matching now requires an unambiguous closest candidate
rather than the first one found — smaller yield, but every match is one
we're actually confident in). Smaller than the keyword pass's yield, as
expected for a third, supplementary source layered on top of two already-run passes — but real,
verified live, and recovers cases neither of the other two passes can
(a place whose name gives no cuisine hint at all, and whose Foursquare row
was never tagged with one either).

**Steps** (see `extraction/extract_*.sql`, `extraction/classify_and_load.py`
— both must be run with `cloudflare/` as the working directory; the SQL
files write to a relative `build/` path and the Python script resolves
`build/` relative to its own location either way):
1. Query `places_os` filtered to a city's bbox + our 90 category IDs
2. Classify each row into every matching `poi_type` (a place can match more
   than one), every matching `poi_attribute` (`store_kind`/`food_cuisine`,
   also multi-valued) by matching its Foursquare category IDs against the
   mapping files, and a `brand` by matching its name against
   `src/constants/brandDictionary.json`; compute its geohash, tag every row
   with a fresh `build_id`
3. Write a `build_log` start row, then batch `INSERT OR REPLACE` into the
   shared D1 `poi`/`poi_type`/`poi_attribute` tables, then a sweep `DELETE`
   retiring the previous build's rows for that city, across all three tables
4. Write the client-download SQLite export (KAN-339,
   `build/export_{cityId}_{buildId}.sqlite`) from the same in-memory rows
5. Upload the raw CSV extract and the SQLite export to R2 (the script prints
   both exact `wrangler r2 object put` commands), then call
   `/internal/build-complete` (also printed, with the real `build_id`/counts)
   to close out `city.status` and `build_log`

### Rows-written cost

On Workers Paid (in use since the KAN-329/331 upgrade): 50M rows-written/month
included, then metered — no daily cap, no need to trim indexes or spread a
city's initial load across multiple days to stay under a quota. Every index an
insert touches still counts as an extra "row written" (a straight INSERT is
not 1:1 with real rows — e.g. a `poi` row with 2 indexes costs 3), so it's
still worth knowing, just no longer a hard constraint that shapes schema
decisions. D1's actual hard ceiling is 10GB/database, plan-independent — see
`schema.sql`.

## Test Places

- `osm-relation-2897141` ("Lisboa") — formerly the `lisboa` slug; migrated by
  `migrations/0003_place_country_rename.sql` (KAN-355). 24,216 POIs loaded.
  Ingested extent approximated from the old center 38.7223,-9.1393 /
  radius 10km circle (the migration has no access to the true loaded-rows
  extent) — will be overwritten with the real ingested extent the next time
  KAN-354 re-maps this Place.
- `osm-relation-6522461` ("Odivelas") — formerly the `odivelas` slug, same
  migration. 6,162 POIs loaded. Extent approximated from center
  38.7911,-9.1857 / radius 5km the same way.

Verified against the earlier live-Foursquare-API field test from the same
session — e.g. Odivelas' top café result ("Côco Verde", ~118m) matches
exactly, confirming the bulk pipeline reproduces live-API quality.
