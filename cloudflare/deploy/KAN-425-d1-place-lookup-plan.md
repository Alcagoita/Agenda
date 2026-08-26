# KAN-425 — D1 place lookup scale plan

## Decision

Keep `findPlace`'s current linear lookup in production. Introduce a
`place_bucket` side table only when both of these measured conditions hold:

1. `place` has at least 50,000 bounded rows; and
2. the standalone lookup's production p95 D1 time exceeds 5 ms over a
   comparable 24-hour window.

This prevents a migration based on anticipated global coverage rather than a
current hot-path problem. On 2026-08-27, production had 490 rows and the
current full scan took 0.91 ms in Western Europe.

## Candidate design

Use a fixed 0.25-degree grid, not an R-tree (unsupported by D1):

```sql
CREATE TABLE place_bucket (
  lat_bucket INTEGER NOT NULL,
  lng_bucket INTEGER NOT NULL,
  place_id TEXT NOT NULL REFERENCES place(place_id),
  PRIMARY KEY (lat_bucket, lng_bucket, place_id)
);
```

Backfill one row for every grid cell touched by each bounded place extent.
Lookup first computes the point's two bucket numbers, joins only that bucket
to `place`, and retains the current precise `BETWEEN` predicates and
specificity selection in the Worker. This preserves nested-place, country
fallback, and exact-boundary behaviour; the bucket is only a candidate
filter. Bboxes that cross the antimeridian must be split into two ranges
during backfill.

An in-memory SQLite benchmark with 50,000 production-shaped bounded rows ran
1,000 lookups in 5,472 ms for the scan versus 40 ms for the bucketed query.
`EXPLAIN QUERY PLAN` used the bucket primary key followed by the place primary
key. This is the selected implementation trigger: it is materially faster at
the chosen threshold but unjustified at today's production size.

## Safe rollout and rollback

1. **Expand:** add `place_bucket` without changing `findPlace`.
2. **Backfill:** insert in idempotent batches (`INSERT OR IGNORE`) and record
   progress by `place_id`; do not delete or rewrite `place` rows.
3. **Verify:** compare bucketed and linear results for the existing coverage
   fixtures, nested/overlapping bboxes, country fallbacks, and boundaries;
   require an indexed `EXPLAIN QUERY PLAN` before enabling reads.
4. **Switch:** retain the linear query behind a Worker flag for one full
   release while collecting aggregate timing data only.
5. **Rollback:** switch reads back to linear immediately. The additive table
   is harmless and may be dropped only in a separately approved contraction.

No production schema, write path, or public coverage behaviour changes in
this ticket.
