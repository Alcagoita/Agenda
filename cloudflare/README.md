# Brush POI Backend (Cloudflare)

KAN-329 — replaces live Google/Foursquare calls with our own POI database for
major cities. Google Places API stays as the permanent fallback for
small/rural cities (see project memory `project_poi_backend_migration_plan`).

## Architecture

- **Workers** (`src/index.ts`) — the API. Deployed at `poi-api.brushaway.app`.
- **D1** — one shared database (`brush-poi-registry`) for everything: a
  `coverage` table (which cities exist, build status) and a `poi` table (all
  cities' places, scoped by a `tile_id` column). **Not** one database per
  city — Cloudflare Free plan caps at 10 databases/account, which breaks past
  10 cities. One shared table scales to ~70+ cities before approaching the
  500MB Free-plan per-database ceiling, at current ~7MB/city average.
- **R2** (`brush-poi-exports`) — bucket exists, provisioned, but **nothing
  writes to it yet**. Meant to hold per-city downloadable SQLite extracts for
  client-side local caching — that flow needs the client integration ticket's
  format decisions first, so it's deliberately not built blind here.
- No R-tree/geospatial index on D1 (confirmed unsupported, and R2 SQL's
  geospatial support is still "exploring" per Cloudflare's own docs) —
  radius search uses geohash prefix range queries instead
  (`src/geohash.ts`), same algorithm reimplemented in Python for the
  extraction script (`extraction/classify_and_load.py`) — the two must stay
  in sync or radius queries silently miss rows.

## Endpoints

All require `X-Api-Key: <API_KEY>` header except `/internal/*`, which uses a
separate `X-Build-Secret: <BUILD_TRIGGER_SECRET>` header instead.

- `GET /poi?lat=&lng=&radius=&type=` — POIs of one type within a radius
- `GET /poi/all?lat=&lng=&radius=` — all cached types within a radius
- `GET /coverage?lat=&lng=` — `none` / `building` / `ready` for this location
- `POST /coverage/request` `{lat,lng}` — trigger a build for an uncovered
  area. **Not implemented yet** — currently just reports `none`. Real
  auto-provisioning (new tile_id row + Cloud Function trigger) is follow-up
  work, deliberately out of this ticket's scope.
- `POST /internal/build-complete` `{tileId}` — called by the extraction
  pipeline once a city's rows are loaded; flips `coverage.status` to `ready`.

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
2. Classify each row into a `poi_type` (+ `store_subtype`/`food_subtype` if
   applicable) by matching its Foursquare category IDs against the mapping
   files, compute its geohash
3. Batch `INSERT OR REPLACE` into the shared D1 `poi` table

### Rows-written cost — real constraint, watch this before the next city

D1 Free plan caps at **100,000 rows written/day**. Every index an insert
touches counts as an extra "row written" — a straight INSERT is not 1:1 with
real rows. Observed: 6,162 real rows → 24,648 "rows written" (4x, from the
composite PK + 2 secondary indexes) before the index was trimmed down to one
(now ~3x). **A city with more than ~30-35k real POIs will not fit in a single
day's free quota** even post-fix — either spread a large city's initial load
across multiple days, or move to Workers Paid (removes the cap) once regular
re-seeding/new-city cadence needs it.

## Test cities

- `lisboa` — center 38.7223,-9.1393, radius 10km, 24,216 POIs loaded
- `odivelas` — center 38.7911,-9.1857, radius 5km, 6,162 POIs loaded

Verified against the earlier live-Foursquare-API field test from the same
session — e.g. Odivelas' top café result ("Côco Verde", ~118m) matches
exactly, confirming the bulk pipeline reproduces live-API quality.
