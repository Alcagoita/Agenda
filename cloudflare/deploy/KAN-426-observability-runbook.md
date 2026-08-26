# KAN-426 — production POI observability runbook

This runbook grants and uses **read-only** production visibility for the POI
Worker and D1 registry. It is for performance diagnosis; it must not be used
to apply migrations, execute writes, change Worker configuration, or inspect
location-level user activity.

## 1. Use the approved Wrangler session

Use the existing authenticated Wrangler session for the account that owns
`brush-poi-registry` and `brush-poi-backend`. KAN-426 performs only the
read-only commands below; it does not need another credential or any dashboard
change.

Confirm the active account before any production diagnostic:

```sh
cd cloudflare
npx wrangler whoami
```

The expected result is the production account configured for
`brush-poi-registry`. If it is not, stop: do not run a query against a
similarly named database in another account. Never place OAuth tokens or API
keys in this repository or `.dev.vars`.

## 2. Approved D1 diagnostics

Every command below is read-only. Use `--remote` deliberately: local D1
results do not represent production cardinality or query plans.

```sh
# Table growth only — never retrieve POI names, addresses, coordinates, or IDs.
npx wrangler d1 execute brush-poi-registry --remote --command "
  SELECT 'poi' AS table_name, COUNT(*) AS row_count FROM poi
  UNION ALL SELECT 'osm_poi', COUNT(*) FROM osm_poi
  UNION ALL SELECT 'curated_poi', COUNT(*) FROM curated_poi
  UNION ALL SELECT 'poi_source_correction', COUNT(*) FROM poi_source_correction
  UNION ALL SELECT 'place', COUNT(*) FROM place;"

# Confirm lookup indexes and inspect the plan before changing a hot query.
npx wrangler d1 execute brush-poi-registry --remote --command "
  EXPLAIN QUERY PLAN
  SELECT source, source_id, visible, name_override, dedupe_name_override
  FROM poi_source_correction;"

# Inspect schema/index metadata without reading application data.
npx wrangler d1 execute brush-poi-registry --remote --command "
  SELECT name, tbl_name FROM sqlite_master
  WHERE type = 'index'
  ORDER BY tbl_name, name;"
```

Only use representative coordinates in `EXPLAIN QUERY PLAN` when they are
synthetic or already approved test fixtures. Do not paste coordinate-bearing
queries or their output into Jira, logs, chat, or incident tickets.

## 3. Worker route diagnostics

The Worker has `observability.enabled` and emits sampled nearby-search timing
events. Tail briefly during a controlled test window; do not persist raw
requests.

```sh
cd cloudflare
npx wrangler tail brush-poi-backend --format json
```

Track route-level aggregates only:

- `/poi/nearby`: request count, p50/p95 total latency, D1 time, Worker
  filtering/serialization time, error rate, deploy version.
- `/coverage`: latency/error rate and R2-head outcome.
- `/coverage/request`: D1-hit versus reverse-geocode latency, attempt count,
  timeout/rate-limit rate.
- `/export/:placeId`: latency, response size bucket, R2 error rate.

Do not log or dashboard coordinates, Firebase UIDs, Authorization headers,
place IDs, POI IDs, names, or addresses. Use coarse latency and byte-size
buckets instead of raw values.

## 4. Baseline and change review

For each production performance change:

1. Capture a baseline over a comparable traffic window.
2. Record p50/p95 latency, error rate, and D1 candidate/row-read proxy
   metrics by route and deploy version.
3. Validate the intended D1 query with `EXPLAIN QUERY PLAN`.
4. Deploy the change, then capture the same metrics over a comparable window.
5. Attach aggregate results to the Jira ticket; never attach raw request or
   location data.

## 5. Baseline captured on 2026-08-26

Read-only diagnostics were run against the production primary in Western
Europe. Aggregate table sizes were:

| table | rows |
|---|---:|
| `poi` | 289,502 |
| `osm_poi` | 75,490 |
| `curated_poi` | 4 |
| `poi_source_correction` | 192 |
| `place` | 490 |

`EXPLAIN QUERY PLAN` confirms that the current full correction lookup scans
`poi_source_correction`; this validates KAN-423's hot-path change. The
bounding-box `findPlace` lookup also scans `place`, but its standalone SQL
time is currently below 1 ms at 490 rows. KAN-425 should retain its
threshold-driven scope rather than redesigning that lookup prematurely.

The existing approved OAuth session is the operational access method for this
task. This runbook deliberately uses only read-only commands, regardless of
the session's wider account permissions.

## References

- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [D1 query guidance](https://developers.cloudflare.com/d1/best-practices/query-d1/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
