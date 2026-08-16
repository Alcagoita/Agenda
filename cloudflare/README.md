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

All require authentication except `/internal/*`, which uses a separate
`X-Build-Secret: <BUILD_TRIGGER_SECRET>` header instead, and the deliberately
narrow community-contribution routes listed below. Two credentials are
accepted:

- `Authorization: Bearer <Firebase ID token>` — how the app calls this API
  (KAN-367). The Worker verifies the token itself against Google's published
  signing keys (`firebaseAuth.ts`): RS256 only, issuer and audience pinned to
  `FIREBASE_PROJECT_ID`, and the uid taken from the verified `sub` and
  nowhere else. Signing keys are cached for the max-age Google publishes, so
  no per-request round trip. These requests are rate-limited per uid by the
  `ratelimits` bindings in `wrangler.jsonc`, replacing the Firestore counters
  the retired Firebase proxy kept:

  | Routes | Budget |
  |---|---|
  | `/poi`, `/poi/all`, `/poi/nearby` (GET + POST), `/coverage` | 30/min |
  | `/coverage/request`, `/export/:cityId` | 5/min |

  `/export` shares the tighter budget rather than the read one because each
  hit streams a multi-megabyte R2 object. Counted per Cloudflare location and
  eventually consistent by design — a guard rail against a leaked token being
  replayed, not an accounting system. The app itself cannot approach these
  limits: proximity searches are gated behind a 200 m movement threshold and a
  re-entrancy lock, and one search issues one request covering every POI type.
- `X-Api-Key: <API_KEY>` — server-side callers, including the Firebase POI
  proxy that remains deployed as the rollback path until the direct-call app
  build is verified in production. Not rate-limited here: there is no user to
  key on.

A request carrying a bearer token that fails verification is rejected with
401 outright — it never falls back to the API key.

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
- `GET /manual-poi/meta`, `GET /manual-poi/duplicates`, and `POST
  /manual-poi/submissions` — browser-only community-contribution surface,
  CORS-limited to `https://brushaway.app`. Submission requires the managed
  Turnstile action `manual_poi_submit`, is rate-limited by a hashed source IP,
  and creates only a `pending` row; it can never write a live POI directly.
- `GET /manual-poi/admin/submissions` and `PATCH
  /manual-poi/admin/submissions/:id` — reviewer-only moderation. These must
  be protected by a Cloudflare Access application and also verify its signed
  assertion in the Worker. Approval either creates a separate
  `community:<uuid>` curated POI or links the submission to an already-known
  nearby POI with the same normalized name; it never invents a Foursquare id.
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
- `POST /internal/settlement-registry/queue` `{countryCode}` — after a
  country is `mapped`, starts the separate KAN-378 metadata-only job. It
  imports bounded OSM settlement areas into `place` for coverage and area
  naming; it never reloads Foursquare POIs. Repeating a completed job is a
  no-op; a failed job is safely retryable. A successful future country import
  queues this job automatically; this endpoint is the one-time backfill path
  for a country already mapped before KAN-378.
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

### Community POI moderation setup (KAN-362)

Before deploying the website pages, apply
`migrations/0008_moderated_manual_pois.sql` to `brush-poi-registry` and deploy
this Worker. Create one Cloudflare Access application for
`https://brushaway.app/manual-poi/review*`, then add a Worker route for
`brushaway.app/manual-poi/review/api/*` that targets this Worker. The review
page calls that same-origin route, so one Access login protects both the page
and its moderation requests — the browser never has to authenticate to a
second hostname.

Set the following Worker secrets/variables from the **review** Access
application (never commit them):

- `TURNSTILE_SECRET` — already bound to the **Brush Manual POI submissions**
  widget; the corresponding public sitekey belongs only in the website.
- `ACCESS_TEAM_DOMAIN` — the Access team domain, without `https://`.
- `ACCESS_REVIEW_AUD` — the review Access application's audience value.
- `MANUAL_POI_ADMIN_EMAILS` — comma-separated reviewer email allowlist.

`ACCESS_AUD` is optional and only needed when retaining the older direct
`poi-api.brushaway.app/manual-poi/admin/*` Access application; when set, the
Worker accepts either audience.

The Worker fails closed when `ACCESS_TEAM_DOMAIN` or
`MANUAL_POI_ADMIN_EMAILS` is absent, or when both `ACCESS_AUD` and
`ACCESS_REVIEW_AUD` are absent. It also fails closed for public submissions
when `TURNSTILE_SECRET` is absent: every attempt receives HTTP 400 with
`verification failed; please try again.` The public form can be deployed
independently, but it will only become usable after the Worker and its D1
migration are live.

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
(now `place_id`-keyed, matching the KAN-355 schema) automatically, writes
to D1 and R2 through the Worker's own bindings (`d1_client.py`/`r2_client.py`,
via `extractionContainer.ts`'s `outboundByHost` — no separate Cloudflare
API token or R2 keys) without a human running `wrangler` by hand, and
closes the build out via the Worker's `/internal/*` routes
(`worker_client.py`). Runs as a **Cloudflare Container** bound to this same
Worker (`src/extractionContainer.ts`) — deployed with the same `wrangler
deploy` you already use, no separate service or cloud account. See
`cloudflare/deploy/README.md` (not run from the environment that wrote
this, see that file's own caveat).

`classify_and_load.py`'s direct CLI usage (`python3 classify_and_load.py
<place_id>`) still works for a one-off manual run against an
already-extracted CSV — useful for debugging a single Place's
classification without going through the whole Job.

### Country-source count diagnostic

Before investigating a country-import coverage discrepancy, run this
read-only local diagnostic with a current Foursquare Places Portal JWT:

```bash
export FOURSQUARE_JWT='<Places Portal JWT>'
python3 cloudflare/extraction/count_country.py PT
```

It reports all open Foursquare OS Places rows for the country and the subset
in Brush's supported category IDs. It neither writes to Foursquare nor D1;
compare the supported count with the durable country-import audit when
reconciling source coverage.

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

### Financial classification and rebuild rules

The fresh-import path is the recovery path. `extraction/classify_and_load.py`
applies the version-controlled rules while it loads each Foursquare row, so a
re-import does **not** depend on the historical one-off D1 migrations:

- `../src/constants/brandDictionary.json` is the single catalogue for Bank and
  Gym brands. It contains both the canonical app value and historical aliases
  (for example BPN/BancoBIC/EuroBic → ABANCA, Finibanco → Montepio, and the
  Crédito Agrícola variants).
- `src/financialServiceNameRules.json` contains the explicit, whole-word title
  rules that remove non-Banks from Bank search: named ATMs, currency exchange,
  money transfer, and `financial_service` kinds. Its six source-only kinds are
  insurance, consumer credit, financial intermediary, leasing/factoring,
  central bank, and public finance. They are stored as
  `poi_attribute.financial_service_kind`; they are not task-creation choices.

For a database rebuild, rerun the ordinary current extraction Container for
each required country or Place. It reads both files automatically and produces
the same canonical `poi.brand`, `poi.primary_poi_type`, `poi_type`, and
`poi_attribute` values as a clean import. Do not replay the old
`0011`–`0014` data migrations against a rebuilt database.

### D1 migration ledger

`brush-poi-registry` existed before Wrangler's migration ledger was adopted.
On 2026-08-12 its already-present schema and data state were verified, then
the historical `0001`–`0014` filenames were recorded in `d1_migrations` without
executing them again. For this existing database, all future migrations must be
applied with `npx wrangler d1 migrations apply brush-poi-registry --remote`;
do not run a migration file directly with `d1 execute`. A newly created D1
database must use the normal migration-apply path instead of this baseline.

After a rebuild, verify the rules with these read-only queries:

```sql
-- No financial-service record must still be returned as a Bank.
SELECT COUNT(*) AS bank_with_financial_service_kind
FROM poi AS p
JOIN poi_attribute AS a ON a.fsq_place_id = p.fsq_place_id
WHERE p.primary_poi_type = 'bank'
  AND a.dimension = 'financial_service_kind';

-- Review the durable source-only subtype distribution.
SELECT a.value AS financial_service_kind, COUNT(*) AS pois
FROM poi AS p
JOIN poi_attribute AS a ON a.fsq_place_id = p.fsq_place_id
WHERE p.primary_poi_type = 'financial_service'
  AND a.dimension = 'financial_service_kind'
GROUP BY a.value
ORDER BY pois DESC;

-- Canonical Bank brands and all remaining unbranded source names.
SELECT COALESCE(brand, '(unbranded)') AS brand, COUNT(*) AS pois
FROM poi WHERE primary_poi_type = 'bank'
GROUP BY brand ORDER BY pois DESC, brand;
```

**OSM enrichment (`extraction/enrich_osm_cuisine.py`, KAN-340's originally
higher-priority source)**: run separately from `classify_and_load.py`, not
inline — Overpass is a slow, flaky, retryable external call (~40-60%
single-attempt failure rate per KAN-322) that doesn't belong in the fast
synchronous Foursquare pipeline. Queries Overpass for the place's
`cuisine=`/`shop=`-tagged elements, matches them to `poi` rows still
missing a subtype after *both* the category-tag and keyword-fallback
passes, and writes new `poi_attribute` rows tagged with the place's current
`build_id` (read live from D1) so they survive that build's sweep.
**Must be re-run after every future Foursquare re-extraction for the same
place**, or this enrichment is lost when the next build's sweep retires the
previous build's `poi_attribute` rows — same requirement as the keyword
pass, just a separate manual step here instead of automatic.

**Matching rule (KAN-354, 2026-08-06 — exact-name matching replaced):**
candidates are grid-indexed by location, not name — bucket size ≈
`MATCH_RADIUS_METERS` (75m), 3x3-neighborhood scan, so every candidate
within radius is considered regardless of name spelling. Each candidate is
then scored on `name_similarity()`: 1.0 identical, 0.9 if one name fully
contains the other (covers franchise/branch qualifiers and legal-entity
suffixes OSM never carries, e.g. "Redidáctica" vs "Redidáctica -
Reparações, Montagens e Comércio de Equipamentos Didácticos"), else a
`difflib.SequenceMatcher` ratio (stdlib, no dependency added) — must clear
`NAME_SIMILARITY_THRESHOLD = 0.72`. A candidate is only accepted if
**unambiguous**: no second eligible candidate scores within 0.05 similarity
*and* 15m distance of the winner. Exact-name-only matching was tried first
and undershot badly — of 2,591 Overpass elements with a mappable `shop=`
tag near Lisboa, only 2 had a name exactly equal to a leftover store
candidate, because the leftover pool is by construction the long tail
category-tag + keyword matching already failed on (legal-entity names OSM
mappers don't tag verbatim). Fuzzy name + location recovered the rest
without needing exact spelling agreement.

Usage: `python3 extraction/enrich_osm_cuisine.py <place_id>` (after the
regular pipeline has already loaded that place), then run the printed
`wrangler d1 execute --file=...` command.

Real yield, measured live against Lisboa/Odivelas/Sertã (most OSM elements
simply don't share a listing with Foursquare at all — most of a Place's
Overpass results never match anything): Lisboa +50 `food_cuisine` / +10
`store_kind`, Odivelas +15 `food_cuisine` / +2 `store_kind`, Sertã +0/+0
(town too small — only 55 Overpass elements total, none overlapping the 9
restaurant + 3 store candidates). Smaller than the keyword pass's yield, as
expected for a third, supplementary source layered on top of two
already-run passes — but real, verified live, and recovers cases neither
of the other two passes can (a place whose name gives no cuisine hint at
all, and whose Foursquare row was never tagged with one either).

### OSM-only supplementary POIs

KAN-383 keeps OSM-only venues in `osm_poi`/`osm_poi_type`/`osm_poi_attribute`,
separate from both Foursquare `poi` rows and moderated `curated_poi` rows. An
OSM element is added only when no same-type, similar normalized-name candidate
exists within 75m; ambiguous candidates are skipped rather than guessed. The
stable `node/<id>` / `way/<id>` / `relation/<id>` identity makes reruns and
overlapping municipality bboxes idempotent.

Start every new source with a read-only settlement or bbox dry-run. For
example, `python3 extraction/supplement_osm_pois.py --dry-run --bbox 39.794
39.813 -8.113 -8.090` inspects Sertã without writing D1. The country operation
uses bounded municipality scopes instead of one Portugal-wide Overpass query;
it is queued with `POST /internal/osm-supplement/queue` only after the
country's Foursquare data and settlement registry are mapped.

Each dry-run also writes a local `build/*_possible_renames.json` review report.
It lists candidates that would otherwise be added when a Foursquare or active
community POI of the same type has a materially different normalized name
within 75m. `same_location` means within 20m; `nearby` means 21–75m. These are
not removed or merged automatically: review the report before applying the
generated SQL.

When review confirms that a nearby differently named Foursquare row is stale,
record the decision in `poi_source_correction` rather than rewriting raw source
data. The nearby Worker hides a reviewed retired source row and can apply an
approved OSM display-name override. The importer reads the same registry, so
an excluded OSM element is not reintroduced and a later Foursquare reload does
not recreate a user-visible duplicate.

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
