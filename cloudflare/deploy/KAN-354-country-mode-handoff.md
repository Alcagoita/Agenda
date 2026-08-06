# KAN-354 handoff — fix country mode, wire OSM subtype enrichment

Two pieces of unfinished work, written up for a fresh agent/session to pick
up. Both live in `cloudflare/extraction/` and `cloudflare/src/index.ts`.
Read `docs/poi-coverage-model.md` and `cloudflare/README.md` first for
overall context — this doc assumes that background.

---

## 1. Country mode is disabled — real data loss happened, root cause known

### What happened

On 2026-08-06, a real `POST /internal/country/queue {"countryCode":"PT"}`
run destroyed the good data for all three previously-mapped Places:

| Place | Before | After the run |
|---|---|---|
| Lisboa (`osm-relation-2897141`) | ~24,216 poi rows | 1 |
| Odivelas (`osm-relation-6522461`) | ~6,162 poi rows | 1 |
| Sertã (`osm-relation-5533563`) | 90 (from a place-mode build minutes earlier) | 3 |

All three were manually recovered from R2 raw-extract backups (R2 keys are
`build_id`-namespaced, so old builds' objects are never touched by a sweep —
that's what made recovery possible) and reloaded via
`classify_and_load.py`'s existing CLI path directly against remote D1. They
are correct and live again as of this writing.

Additionally, the same run left **536 orphaned place_ids** worth of
`poi`/`poi_type`/`poi_attribute`/`build_log` rows with no matching `place`
row at all (2,080 orphaned `poi` rows, 6,399 orphaned `build_log` rows).
These were unreachable (nothing can serve them without a `place` row to
`findPlace` against) but were real DB clutter — already cleaned up via:

```sql
DELETE FROM poi_attribute WHERE place_id NOT IN (SELECT place_id FROM place);
DELETE FROM poi_type WHERE place_id NOT IN (SELECT place_id FROM place);
DELETE FROM poi WHERE place_id NOT IN (SELECT place_id FROM place);
DELETE FROM build_log WHERE place_id NOT IN (SELECT place_id FROM place);
```

`POST /internal/country/queue` currently returns a hard `503` in
`cloudflare/src/index.ts` (search for `DISABLED 2026-08-06`). **Do not
re-enable it without fixing both root causes below and testing against a
small, cheap case first** (see "How to test safely" at the end).

### Root cause 1 — locality grouping is far finer than a Place identity

`cloudflare/extraction/extract.py`'s `partition_by_locality()` groups
Foursquare's country-wide extract by its own `locality` column. That
column is much finer-grained than an administrative Place: greater Lisboa
alone produced **~580 distinct locality strings** (individual
neighborhoods/parishes), and `nominatim_client.resolve_place_identity()`
— correctly, per its own zoom-retry design (the Lisboa/Porto freguesia fix
from earlier in KAN-354/355) — resolves *every one of them* back to the
same Lisboa municipality `place_id`.

`cloudflare/extraction/run_job.py`'s `run_country()` then runs one full
`classify()` → `d1_client.execute_sql_file()` → sweep-delete cycle **per
locality group**, not per resolved `place_id`. Every one of those ~580
cycles for Lisboa ran the sweep
(`DELETE FROM poi WHERE place_id = ? AND build_id != ?`, generated inside
`classify_and_load.py`'s `classify()`) against the *same* `place_id`,
retiring whatever the previous cycle had just loaded. The final state is
whatever the last-processed, typically tiny, locality group happened to
contain — hence Lisboa ending at exactly 1 row.

**The fix has to happen before any D1 write, not just guard the sweep:**
group locality-buckets by their *resolved* `place_id`, not by the raw
Foursquare `locality` string, and merge all their rows into one CSV before
calling `classify()` once per distinct resolved Place. Concretely, in
`run_job.py`'s `run_country()`:

1. Call `extract.partition_by_locality()` as today (or drop it — see below).
2. For each locality bucket, resolve its centroid via
   `nominatim_client.resolve_place_identity()` **before** deciding to
   write anything.
3. Accumulate rows from every bucket that resolves to the same `place_id`
   into a single combined CSV.
4. Run exactly one `classify()` → `d1_client.execute_sql_file()` cycle per
   distinct resolved `place_id`, using the combined rows.

An even simpler alternative worth considering: since
`resolve_place_identity()` already does the real work of finding the
correct administrative boundary, country mode could skip
`locality`-grouping entirely and instead resolve *every row's own
coordinates* to a `place_id` directly, group by that, and only then batch.
`locality` was only ever meant as a cheap first-pass grouping heuristic to
avoid an extra Nominatim call per row — worth measuring whether call volume
actually requires it (Nominatim's usage policy is 1 req/s; a full-country
row-by-row resolve would be far too slow/abusive, so the grouping step
is real and necessary — but it needs to key on the *resolved* Place, not
the raw string).

### Root cause 2 — `/internal/build-complete` silently orphans data for a brand-new Place

For any locality that resolves to a `place_id` **not already in the
`place` table**, `run_country()` never creates a `place` row before
calling `worker_client.build_complete()`. That function POSTs to
`/internal/build-complete`, whose handler in `cloudflare/src/index.ts` does:

```ts
"UPDATE place SET status = 'mapped', build_id = ?, mapped_at = ?, ... WHERE place_id = ?"
```

An `UPDATE` against a `place_id` with no existing row matches 0 rows. The
handler correctly detects this (`placeResult.meta.changes !== 1`) and
returns a `404` — **but this check happens after the batched D1 write
already committed** (`env.REGISTRY_DB.batch([...])` runs both the place
update and the build_log update regardless of row-match count; batch
atomicity only protects against genuine execution errors, not "0 rows
matched"). So the `poi`/`poi_type`/`poi_attribute` rows (already written
by `d1_client.execute_sql_file()` before this callback) survive with
`build_log` correctly closed as `'ready'`, but the `place` row that should
own them was never created — hence the 536 orphaned `place_id`s.

**Fix:** `run_country()` needs to create the `place` row for a genuinely
new Place *before* (or atomically with) the D1 load — e.g. an
`INSERT OR IGNORE INTO place (place_id, country_code, name, place_kind,
status, ...) VALUES (..., 'mapping', ...)` step using the identity info
`resolve_place_identity()` already returns, run once per newly-discovered
`place_id` before its first `classify()` call. This mirrors what
`/coverage/request`'s place-mode path already does correctly in
`cloudflare/src/index.ts` (see the `INSERT INTO place ... ON CONFLICT`
block) — country mode should probably call the same Worker endpoint (or a
new dedicated one) rather than reimplementing the insert, so there's one
place that owns "how a new Place row gets created."

### Known-good reference: place mode never had this problem

`run_place()` (place mode) has neither bug: the target `place_id` is given
directly by the trigger (already resolved and already has a `place` row
from `/coverage/request`'s own insert), and it does exactly one
`classify()` → load → sweep cycle for that one Place, scoped to its real
Nominatim boundary (`nominatim_client.lookup_bbox()`), not a row-group
centroid. It's what recovered all three damaged Places safely. Any country
mode fix should converge on the same shape: resolve identity first,
one write per Place, using a real boundary/full dataset — not a
locality-string artifact.

### How to test safely once fixed

Do **not** re-run against all of Portugal first. Options, cheapest first:

1. Unit/integration-test the grouping logic in isolation
   (`extract.partition_by_locality` + the new merge-by-resolved-id step)
   against a small synthetic CSV with multiple locality strings that
   should collapse to one Place — assert exactly one `classify()` call
   happens for that Place with all rows combined.
2. If a live test is needed, pick a country/region with only a handful of
   settlements (or temporarily hack `extract_country()`'s SQL to add an
   extra `AND locality IN (...)` filter for a 2-3-locality test slice)
   rather than queuing all of Portugal again.
3. After any live run, verify with the same queries used to find this bug:
   ```sql
   SELECT COUNT(*) FROM poi WHERE place_id NOT IN (SELECT place_id FROM place);
   SELECT p.place_id, p.name, (SELECT COUNT(*) FROM poi WHERE poi.place_id = p.place_id) as poi_count FROM place p;
   ```
   A `poi_count` that looks too low for a known place (e.g. Lisboa under
   a few thousand) is the same failure signature — stop and check before
   it sweeps further.

---

## 2. Subtype enrichment (`store_kind` / `food_cuisine`) isn't fully wired for automated builds

Every `classify()` call (place mode and country mode alike) already runs
two of the three subtype sources automatically, no extra step needed:

1. **Foursquare category-tag matching** — the primary source, always runs.
2. **KAN-340 keyword fallback** — matches a place's own name against
   `src/constants/storeSubtypeDictionary.json` /
   `restaurantFoodDictionary.json` when category tags found nothing.
   Already automatic, already ran for Lisboa/Odivelas/Sertã (see the
   `KAN-340 keyword fallback: N store_kind + M food_cuisine rows recovered`
   line each `classify_and_load.py` run prints).

**What's NOT automated:** `cloudflare/extraction/enrich_osm_cuisine.py` —
the third source (OSM `cuisine=`/`shop=` tag enrichment via Overpass,
per `cloudflare/README.md`'s "OSM enrichment" section). This is a
**separate, standalone script**, never called from `run_job.py` or wired
into the Container pipeline at all.

**Update 2026-08-06:** the script was broken against the post-KAN-355
schema (still queried the old `city`/`city_id`/`center_lat`/`center_lng`/
`radius_km`/`current_build_id` columns — fixed to use `place`/`place_id`/
`min_lat`/`max_lat`/`min_lng`/`max_lng`/`build_id`) and has now been run
manually for all three current Places:

| Place | new `food_cuisine` rows | new `store_kind` rows |
|---|---|---|
| Lisboa | 50 | 0 |
| Odivelas | 11 | 0 |
| Sertã | 0 | 0 |

Applied directly to remote D1. Sertã matched nothing (small town, sparse
OSM tagging — not a bug: 9 restaurant + 3 store candidates were queried,
Overpass returned 55 elements, none matched by name+proximity).

**`store_kind` root cause (diagnosed, not a bug in the matching code):**
matching is exact-normalized-name (`normalize_text`, diacritics/case/punct
stripped) + haversine ≤75m, no fuzzy/token matching. For Lisboa, 2,591
Overpass elements had a mappable `shop=` tag, but only **2** had a
normalized name overlapping any of the 522 store candidates. Root cause is
the candidate pool itself, not the matcher: these 522 are exactly the rows
Foursquare's category tag *and* the KAN-340 keyword pass already failed to
classify — i.e. by construction the long tail of small businesses with
legal-entity names ("Redidáctica - Reparações, Montagens e Comércio de
Equipamentos Didácticos", "Chaveca & Martins", "Cab. N."), which OSM
mappers essentially never tag under a matching name. Restaurants don't hit
this as hard because cuisine-tagged OSM elements skew toward recognizable
eatery names that actually overlap Foursquare's restaurant names.
Fuzzy/token-subset matching could recover a handful more, but most of this
cohort likely has no usable OSM counterpart regardless of match strategy —
diminishing-returns territory, not worth chasing without evidence it moves
the needle. `food_cuisine` matching is confirmed working end-to-end.

Still only run manually, still not wired into `run_job.py` — the automation
decision below is unchanged.

### What to do

Either:

- **(a) Keep it manual, run it per-Place after each build** — `python3
  enrich_osm_cuisine.py <place_id>` (README documents the workflow; the
  script writes new `poi_attribute` rows tagged with the Place's *current*
  `build_id`, read live from D1, so they survive that build's own sweep).
  Simplest, matches today's manual-pipeline precedent, but means every
  future automated Container build (place or country mode) ships without
  OSM enrichment unless someone remembers to run this separately.
- **(b) Wire it into `run_job.py`** so every `run_place()` (and, once
  fixed, `run_country()`) call runs it automatically as a step after
  `d1_client.execute_sql_file()` succeeds. This is the "maybe in all
  Places" ask — makes coverage consistent without a manual follow-up step,
  at the cost of `enrich_osm_cuisine.py`'s own Overpass call volume/latency
  (it's a separate, slower, flakier external call per
  `cloudflare/README.md`'s own note — ~40-60% single-attempt failure rate
  historically) now sitting inside every build instead of being optional.

(b) is very likely the right long-term answer — decide bounded retry
behavior for the Overpass calls (same backoff-not-retry-harder policy the
rest of this codebase uses for Overpass/Nominatim) before wiring it in,
rather than adding a fourth source of flakiness to every build silently.

### Backfilling the 3 already-recovered Places — done 2026-08-06

This step is complete for the current three Places (see the coverage table
above). Re-run the same commands after any future re-extraction of these
Places, since a new `build_id` sweep retires the previous build's
`poi_attribute` rows same as the keyword-fallback pass:

```bash
cd cloudflare/extraction
python3 enrich_osm_cuisine.py osm-relation-2897141   # Lisboa
python3 enrich_osm_cuisine.py osm-relation-6522461   # Odivelas
python3 enrich_osm_cuisine.py osm-relation-5533563   # Sertã
```

Each prints a `wrangler d1 execute --file=...` command to run afterward,
same pattern as `classify_and_load.py`'s own manual workflow.
