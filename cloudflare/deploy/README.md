# KAN-354 — deploying the extraction worker

**Everything runs on Cloudflare now — no GCP, no second bill.** The
extraction pipeline (Python + DuckDB) runs as a [Cloudflare
Container](https://developers.cloudflare.com/containers/), bound directly
to the same Worker, deployed with the same `wrangler deploy` you already
use. Included in the $5/month Workers Paid plan you already pay for (25
GiB-hours + 375 vCPU-minutes/month free, metered past that — see
[Containers pricing](https://developers.cloudflare.com/workers/platform/pricing/#containers)).

This wasn't actually deployed from the session that wrote it — no Docker
daemon available there to build the image (`npx wrangler deploy --dry-run`
confirmed the Worker config, bindings, and Container definition itself are
all valid — that part's not a guess — but it exits before Docker would
actually build `extraction/Dockerfile`, which needs Docker running).
Worker-side logic (routing, dedup, the Container start call) is covered by
`npx vitest run`; the Python pipeline's non-network logic was smoke-tested
via a throwaway venv. The Container itself has never executed end-to-end.
Treat the first real run below as the actual test.

## What you're deploying

One thing: your existing `brush-poi-backend` Worker, now with a Container
attached (`cloudflare/src/extractionContainer.ts`, built from
`cloudflare/extraction/Dockerfile`). No separate service, no separate
account — `wrangler deploy` builds and pushes the image alongside the
Worker in one step.

## Prerequisites

- **Docker running locally** (Docker Desktop, or Colima) — `wrangler
  deploy` needs it to build `cloudflare/extraction/Dockerfile`. Check with
  `docker info`.
- A **Foursquare JWT** (`cloudflare/README.md`'s "Extraction pipeline"
  section — from the Places Portal, expires, needs manual renewal).
- The existing `BUILD_TRIGGER_SECRET` you already have (or pick a new
  value if you don't — see below).
- `npm install` in `cloudflare/` (already done if you've deployed the
  Worker before; picks up the new `@cloudflare/containers` dependency).

## 1. Secrets

Same `wrangler secret put` flow you already used for `API_KEY`:

```bash
cd cloudflare
npx wrangler secret put FOURSQUARE_JWT
# paste the JWT from the Foursquare Places Portal

npx wrangler secret put BUILD_TRIGGER_SECRET
# paste a value — this is what the Container uses to authenticate its own
# /internal/* callbacks. Pick any long random string if you don't already
# have one; it doesn't need to match anything else.
```

## 2. Deploy

```bash
npx wrangler deploy
```

This builds `cloudflare/extraction/Dockerfile` with Docker, pushes the
image, deploys the Worker, and wires up the Durable Object binding
(`EXTRACTION_CONTAINER`) that starts it — all one command. First deploy
will take longer (building the image); later deploys reuse Docker's layer
cache.

Watch it in the dashboard: **Workers & Pages → Containers** shows status,
metrics, and logs for the running/recent instances.

## 3. First real test

```bash
# A Place that's never been requested before — Sertã, per this ticket's own
# regression tests, is a "clean" one-zoom resolution with no freguesia
# complication to also debug at the same time.
curl -X POST https://poi-api.brushaway.app/coverage/request \
  -H "X-Api-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"lat": 39.8007, "lng": -8.0956}'
# expect {"coverageStatus":"building","cityId":"osm-relation-...","retryAfterSeconds":60}
```

Then check the Containers dashboard for the instance's logs (`run_job.py`'s
own prints — extraction progress, row counts, upload confirmations). Once
it finishes:

```bash
curl "https://poi-api.brushaway.app/coverage?lat=39.8007&lng=-8.0956" -H "X-Api-Key: $API_KEY"
# expect {"status":"ready", ...}
```

Then the country path:

```bash
curl -X POST https://poi-api.brushaway.app/internal/country/queue \
  -H "X-Build-Secret: $BUILD_TRIGGER_SECRET" -H "Content-Type: application/json" \
  -d '{"countryCode":"PT"}'
```

Once the country reports `mapped`, populate its settlement registry without
re-running the POI import:

```bash
npx wrangler d1 execute brush-poi-registry --remote --file=migrations/0015_settlement_registry.sql
npx wrangler deploy --containers-rollout=none

curl -X POST https://poi-api.brushaway.app/internal/settlement-registry/queue \
  -H "X-Build-Secret: $BUILD_TRIGGER_SECRET" -H "Content-Type: application/json" \
  -d '{"countryCode":"PT"}'
```

This KAN-378 job uses bounded OSM areas only for geographic metadata. It does
not add OSM POIs or change the Foursquare POI dataset.

**Before running this for real**, confirm the assumption `extract.py`'s top
comment flags: `places.datasets.places_os` actually carries `country` and
`locality` columns as documented. From a machine with the Foursquare JWT
and DuckDB available (the manual pipeline's existing setup,
`cloudflare/README.md`'s "Extraction pipeline" section):

```sql
DESCRIBE places.datasets.places_os;
```

If `locality` doesn't group rows into sensible per-settlement buckets,
`extract.partition_by_locality`'s whole approach needs rethinking before a
country run — check this on a small sample before queuing all of Portugal.

## If something looks stuck

- **A Place stays `building` and never flips to `ready`**: check the
  Containers dashboard for that instance's logs — `run_job.py` prints a
  full traceback on any failure before calling `/internal/place-failed`
  (which reverts the row to `none` so a later request retries it
  automatically — you shouldn't need to intervene by hand).
- **The Container never seems to start at all**: `POST
  /coverage/request`'s response already tells you if the Place was
  promoted to `mapping` — if it was, but nothing shows up in the Containers
  dashboard, that's `container.start()` itself failing silently
  (best-effort by design, see `triggerBuild` in `cloudflare/src/index.ts`).
  Re-deploy and check `wrangler tail` for errors during the start call.
