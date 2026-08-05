# POI coverage — Places and Countries

*Decision record. Agreed with Olegário 2026-08-05. Replaces the earlier cells/tiling draft entirely.*

---

## The vocabulary

**Place** — any settlement: a city, a town, a village. Lisbon is a Place, Sertã is a Place. One word covers them all, and it's the word the app already uses ("Places I know", "Teach it a new place").

**Country** — what the background worker maps wholesale.

`city` becomes `place`. That's the change.

---

## What the Place table is for

**One job: telling a true zero from an empty one.**

Without it, a zero result is ambiguous — we can't tell "there's genuinely no pharmacy here" from "we haven't mapped this area yet". That ambiguity decides whether the app falls back to OSM and says "still getting to know this area", or simply shows nothing nearby.

It is *not* queried on every request. **Only on zero.** That's what makes it cheap.

---

## The zero check

A zero result triggers a reverse geocode of the user's coordinates. Nominatim already does this for the Lantern.

| Reverse geocode returns | Meaning | Action |
|---|---|---|
| Nothing / no country | Ocean, Antarctica, nowhere | Nothing to show. **No worker, no OSM.** Zero is the truth |
| Country, no settlement | Desert, farmland, between towns | **No worker.** Still try OSM — there may be a petrol station |
| Country + settlement | Normal | Place mapped → **true zero, done.** Not mapped → **start the worker** |

This is a record, not a heuristic. The geocoder either returned a country or it didn't.

Reuse `extractCityName` in `maps.ts` — it already walks Nominatim's `village` / `hamlet` / `town` / `city` / `municipality` keys.

---

## The two paths

**Supported country** (Portugal now) — the worker mapped it before anyone opened the app. Data is instant. OSM only appears if our API is down.

**Unsupported country** (Japan) — first user there waits a few seconds for the area around them; the rest arrives afterwards. OSM covers the gap meanwhile.

Nothing clashes between these. They're the same pipeline with different triggers.

---

## Schema

### `country`

| Field | Notes |
|---|---|
| `country_code` PK | ISO 3166-1 alpha-2 |
| `name` | |
| `status` | `none` / `mapping` / `mapped` |
| `build_id`, `mapped_at` | Which Foursquare release. They publish monthly — this is what says when to re-run |
| `place_count` | Worker progress |

No bbox **if** the Foursquare dataset carries a country field — then extraction filters on it exactly, with no boundary to source. Check before writing the schema.

### `place` — renamed from `city`

| Field | Notes |
|---|---|
| `place_id` PK | Nominatim OSM type + id. Stable, and it's exactly what the coordinate lookup returns — no slug to invent |
| `country_code` FK | → `country` |
| `name`, `place_kind` | Human name; city/town/village from Nominatim, for reporting not logic |
| `status` | `none` / `mapping` / `mapped` |
| `min_lat`, `max_lat`, `min_lng`, `max_lng` | **The extent actually ingested.** A record of what the worker pulled, not a boundary chosen in advance |
| `build_id`, `mapped_at` | Staleness |
| `request_count`, `first_requested_at`, `last_requested_at` | Already shipped in KAN-346, moves across unchanged |

`center_lat`, `center_lng`, `radius_km` are dropped — those were the invented part, and inventing them for every place on earth was the mess.

### `poi`

`city_id` → `place_id`. **Keep the column** — it's how you rebuild or delete one Place's POIs. Whether it stays in the read query's predicate should be **measured** against the existing ~23 ms baseline, not assumed.

---

## The waiting message

Show *"Still getting to know this area — I'll have more soon"* **while something is actually in flight** — OSM retrying, or the worker running. Not based on which case above applies.

- Settled and still zero → clear it, "nothing nearby"
- Nothing ever started (no country) → never shown

OSM can take three retries. The message must survive all of them rather than flashing between attempts.

Its sibling — *"I know less than usual around here right now"* — keeps its own case: our API failed and OSM is standing in, rather than our API correctly reporting nothing here yet.

---

## Tickets

| Ticket | |
|---|---|
| KAN-355 | The schema change: `city` → `place`, add `country`, Nominatim identity, drop centre/radius, wire the zero check |
| KAN-354 | The extraction worker: country pre-build queue + on-demand Place build |
| KAN-343 | `GET /export/:cityId` → `place` |
| KAN-339 | `buildId` staleness per Place |
| KAN-349 | The waiting message — unchanged copy, add the survives-retries rule |
