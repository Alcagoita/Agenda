# KAN-354 — deploying the extraction worker

This wasn't deployed or run from the session that wrote it — no `gcloud`,
no container build/push, no live GCP access from that sandbox. Everything
here was written and logic-tested in isolation (unit-testable pieces: Worker
routes via vitest, Python partitioning/normalization/parsing via a throwaway
venv) but the two Cloud Run pieces below have never actually executed
end-to-end. Treat the first real run as the actual test, not this PR's
vitest suite.

## What you're deploying

1. **`brush-poi-extraction`** — a Cloud Run *Job* (batch, not a service).
   The image in `cloudflare/extraction/Dockerfile`. Runs once per
   invocation, `MODE`/`TARGET` set as env var overrides per execution.
2. **`brush-poi-trigger`** — a tiny Cloud Run *service* (`cloudflare/trigger-service/`).
   The only thing the Cloudflare Worker can reach directly; its job is to
   authenticate the request and start a Job execution using its own
   attached service account (no key file leaves GCP).

## Prerequisites

- `gcloud` authenticated against the `brush-away` GCP project (same project
  as Firebase — see `.firebaserc`).
- Artifact Registry repo to hold the extraction image (or use Cloud Build's
  default).
- A **Foursquare JWT** (`cloudflare/README.md`'s "Extraction pipeline"
  section — from the Places Portal, expires, needs manual renewal) in
  Secret Manager.
- A **Cloudflare API token** with D1 edit + R2 edit (same scopes as the
  existing Worker deploy token, `cloudflare/README.md`'s Local Setup
  section) in Secret Manager.
- R2 access-key credentials (R2's S3-compatible API — Cloudflare dashboard
  → R2 → Manage API tokens) in Secret Manager.
- The existing `BUILD_TRIGGER_SECRET` (already set on the Worker via
  `wrangler secret put`, per `cloudflare/README.md`) — the trigger-service
  and the Job both need the same value.

## 1. Secrets

```bash
PROJECT=brush-away

echo -n '<the JWT>' | gcloud secrets create foursquare-jwt --data-file=- --project=$PROJECT
echo -n '<cloudflare API token>' | gcloud secrets create cloudflare-api-token --data-file=- --project=$PROJECT
echo -n '<r2 access key id>' | gcloud secrets create r2-access-key-id --data-file=- --project=$PROJECT
echo -n '<r2 secret access key>' | gcloud secrets create r2-secret-access-key --data-file=- --project=$PROJECT
echo -n '<the existing BUILD_TRIGGER_SECRET>' | gcloud secrets create build-trigger-secret --data-file=- --project=$PROJECT
```

## 2. The extraction Job

Build context is the **repo root** (the Dockerfile copies both `src/` and
`cloudflare/`), not `cloudflare/`:

```bash
cd /path/to/Brush
gcloud builds submit --tag europe-west1-docker.pkg.dev/$PROJECT/brush-poi/extraction:latest \
  --project=$PROJECT -f cloudflare/extraction/Dockerfile .

gcloud run jobs create brush-poi-extraction \
  --project=$PROJECT --region=europe-west1 \
  --image=europe-west1-docker.pkg.dev/$PROJECT/brush-poi/extraction:latest \
  --set-secrets=FOURSQUARE_JWT=foursquare-jwt:latest,CLOUDFLARE_API_TOKEN=cloudflare-api-token:latest,R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest,BUILD_TRIGGER_SECRET=build-trigger-secret:latest \
  --set-env-vars=CLOUDFLARE_ACCOUNT_ID=d1157e9669661ba343c620e2c82ab840,CLOUDFLARE_D1_DATABASE_ID=219307c1-3ada-4df5-bd52-724e5bcc7fb8 \
  --max-retries=0 \
  --task-timeout=3600s \
  --memory=2Gi
```

`--max-retries=0`: a failed run already reports itself via
`/internal/place-failed` / `/internal/country-failed` (KAN-354's own
failure handling) — a platform-level retry would re-run extraction against
data that may have already partially loaded, double-counting `place_count`
and re-uploading over the same `build_id`. Retry by re-triggering
(`/internal/country/queue` or a real user's next `/coverage/request`), not
via Cloud Run's own retry policy.

`--task-timeout=3600s`: generous, matches "no latency target" — Portugal's
whole-country run can take an hour-plus per
`docs/poi-coverage-model.md`. Tune down for place-mode-only if country runs
end up needing more (Cloud Run Jobs support per-execution timeout overrides
if that split becomes worth making).

## 3. The trigger-service

```bash
cd cloudflare/trigger-service
gcloud run deploy brush-poi-trigger \
  --project=$PROJECT --region=europe-west1 \
  --source=. \
  --no-allow-unauthenticated \
  --set-secrets=BUILD_TRIGGER_SECRET=build-trigger-secret:latest \
  --set-env-vars=GCP_PROJECT=$PROJECT,GCP_REGION=europe-west1,EXTRACTION_JOB_NAME=brush-poi-extraction \
  --min-instances=0
```

`--no-allow-unauthenticated`: this service also needs its own IAM-level
gate (Cloud Run's built-in auth, on top of the X-Build-Secret application
check) — the Worker calling it needs `roles/run.invoker` granted to
whatever identity signs its request. **Open question, not resolved here**:
Cloudflare Workers can't natively mint a Google-signed ID token the way
another GCP service could — either make this service `--allow-unauthenticated`
and rely on X-Build-Secret alone (simpler, matches the existing
BUILD_TRIGGER_SECRET-only trust model the Worker/Job pair already uses for
`/internal/*`), or have the Worker fetch a token via some other path. If
going the `--allow-unauthenticated` route, drop that flag from the command
above — worth a real decision, not a default, since it's a public network
data-in point onto the GCP project even though X-Build-Secret still gates it.

The trigger-service's own service account needs `roles/run.developer` (or
narrower — `run.jobs.run` specifically) on the `brush-poi-extraction` Job:

```bash
SERVICE_ACCOUNT=$(gcloud run services describe brush-poi-trigger \
  --project=$PROJECT --region=europe-west1 --format='value(spec.template.spec.serviceAccountName)')

gcloud run jobs add-iam-policy-binding brush-poi-extraction \
  --project=$PROJECT --region=europe-west1 \
  --member="serviceAccount:$SERVICE_ACCOUNT" \
  --role="roles/run.developer"
```

## 4. Point the Worker at it

```bash
cd cloudflare
npx wrangler secret put BUILD_TRIGGER_URL
# paste: https://brush-poi-trigger-<hash>-ew.a.run.app  (the URL gcloud run deploy printed)
```

`BUILD_TRIGGER_SECRET` is already set (step 1 reused the existing value —
don't rotate it here, or the Worker and the trigger-service disagree).

## 5. First real test

```bash
# A Place that's never been requested before — Sertã, per this ticket's own
# regression tests, is a "clean" one-zoom resolution with no freguesia
# complication to also debug at the same time.
curl -X POST https://poi-api.brushaway.app/coverage/request \
  -H "X-Api-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"lat": 39.8007, "lng": -8.0956}'
# expect {"coverageStatus":"building","cityId":"osm-relation-...","retryAfterSeconds":60}

gcloud run jobs executions list --job=brush-poi-extraction --project=$PROJECT --region=europe-west1
# watch the execution; `gcloud run jobs executions logs read <id>` for run_job.py's own prints

curl "https://poi-api.brushaway.app/coverage?lat=39.8007&lng=-8.0956" -H "X-Api-Key: $API_KEY"
# expect {"status":"ready", ...} once the execution finishes
```

Then the country path:

```bash
curl -X POST https://poi-api.brushaway.app/internal/country/queue \
  -H "X-Build-Secret: $BUILD_TRIGGER_SECRET" -H "Content-Type: application/json" \
  -d '{"countryCode":"PT"}'
```

**Before running this for real**, confirm the assumption `extract.py`'s top
comment flags: `places.datasets.places_os` actually carries `country` and
`locality` columns as documented, e.g.:

```sql
DESCRIBE places.datasets.places_os;
```

If `locality` doesn't group rows into sensible per-settlement buckets,
`extract.partition_by_locality`'s whole approach needs rethinking before a
country run — check this on a small sample before queuing all of Portugal.
