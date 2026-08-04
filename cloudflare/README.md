# Brush POI Backend (Cloudflare)

KAN-329 — replaces live Google/Foursquare calls with our own POI database for
major cities. Google Places API stays as the permanent fallback for
small/rural cities (see project memory `project_poi_backend_migration_plan`).

## Architecture

- **Workers** (`src/index.ts`) — the API. Deployed at `poi-api.brushaway.app`.
- **D1** — one shared database (`brush-poi-registry`) for everything: `city`
  (which settlements exist, build status), `poi` (all cities' places, scoped
  by a `city_id` column), and `build_log` (one row per extraction run —
  KAN-333's build lifecycle). **Not** one database per city — 10GB is D1's
  hard per-database ceiling regardless of plan tier, which breaks past a
  relatively small number of cities if sharded that way. One shared table
  scales much further, at current ~7MB/city average.
- **Build lifecycle** (KAN-333): every load tags its `poi` rows with a fresh
  `build_id`. Loading is `INSERT OR REPLACE` on the `(city_id, fsq_place_id)`
  PK, so a place present in both the old and new build just updates in
  place. After loading, a sweep (`DELETE ... WHERE city_id = ? AND build_id
  != ?`) retires anything that didn't reappear (closed places) — see the
  comment at the top of `schema.sql` for the non-atomicity tradeoff.
  `/internal/build-complete` closes out both `city.status` and the matching
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
  (KAN-339), streamed from R2. 404 if the city isn't `ready`, or if it's
  `ready` but predates this ticket and has no export object yet.
- `POST /coverage/request` `{lat,lng}` — trigger a build for an uncovered
  area. **Not implemented yet** — currently just reports `none`. Real
  auto-provisioning (new city row + Cloud Function trigger) is follow-up
  work, deliberately out of this ticket's scope.
- `POST /internal/build-complete` `{cityId, buildId, rowsLoaded?, rowsSkipped?}`
  — called by the extraction pipeline once a city's rows are loaded; flips
  `city.status` to `ready`, sets `city.current_build_id`, and closes out the
  matching `build_log` row.

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

## Test cities

- `lisboa` — center 38.7223,-9.1393, radius 10km, 24,216 POIs loaded
- `odivelas` — center 38.7911,-9.1857, radius 5km, 6,162 POIs loaded

Verified against the earlier live-Foursquare-API field test from the same
session — e.g. Odivelas' top café result ("Côco Verde", ~118m) matches
exactly, confirming the bulk pipeline reproduces live-API quality.
