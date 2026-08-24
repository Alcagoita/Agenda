# KAN-405 — what the OSM query never asks for (PT)

Measurement only. No import, no change to the live Overpass query — the same discipline as KAN-403.

## What the live selectors request today

```
nwr["amenity"~"^(atm|cafe|pharmacy|fuel|bank|bureau_de_change|money_transfer|
                 restaurant|fast_food|library|post_office|clinic|school|bar|pub)$"]
nwr["office"="financial"]
nwr["leisure"~"^(fitness_centre|park)$"]
nwr["shop"]
```

Everything outside those four is not fetched, and `osm_poi` keeps no raw tags, so nothing in our own database can reveal what is missing. That is why this had to be measured against Overpass.

## Never requested

These values are absent from the selectors entirely, so no element carrying them has ever been fetched.

| tag | elements in PT |
|---|---:|
| `amenity=parking` | 64,735 |
| `highway=bus_stop` | 51,648 |
| `leisure=swimming_pool` | 42,923 |
| `leisure=garden` | 34,509 |
| `leisure=pitch` | 16,985 |
| `amenity=place_of_worship` | 13,574 |
| `leisure=playground` | 5,277 |
| `tourism=artwork` | 5,065 |
| `tourism=attraction` | 3,319 |
| `tourism=viewpoint` | 3,213 |
| `tourism=hotel` | 3,077 |
| `leisure=sports_centre` | 2,393 |
| `tourism=picnic_site` | 2,385 |
| `tourism=guest_house` | 2,196 |
| `historic=memorial` | 2,064 |
| `amenity=townhall` | 2,062 |
| `historic=ruins` | 1,584 |
| `tourism=museum` | 1,301 |
| `office=estate_agent` | 1,207 |
| `amenity=car_wash` | 1,033 |
| `amenity=dentist` | 917 |
| `office=insurance` | 822 |
| `amenity=marketplace` | 788 |
| `tourism=hostel` | 763 |
| `historic=castle` | 648 |
| `amenity=veterinary` | 608 |
| `amenity=theatre` | 563 |
| `office=lawyer` | 431 |
| `amenity=ice_cream` | 409 |
| `historic=monument` | 400 |
| `railway=station` | 394 |
| `amenity=driving_school` | 385 |
| `amenity=hospital` | 334 |
| `amenity=doctors` | 292 |
| `amenity=nightclub` | 289 |
| `amenity=bus_station` | 271 |
| `railway=tram_stop` | 248 |
| `historic=church` | 198 |
| `tourism=gallery` | 183 |
| `amenity=cinema` | 173 |
| `craft=shoemaker` | 104 |
| `tourism=zoo` | 47 |
| `craft=tailor` | 46 |
| `craft=brewery` | 27 |
| `tourism=aquarium` | 11 |

## Fetched, but degraded to generic `store`

`shop` is blanket-queried, so every value below DOES arrive. Those without a `TAG_TYPES` rule land as generic `store` — **already in the database, unfindable by errand.** Fixing them needs a classification rule and no Overpass call at all, which makes this the cheapest work in the ticket.

| tag | elements | maps onto |
|---|---:|---|
| `shop=clothes` | 4,971 | store + store_kind=clothing |
| `shop=convenience` | 3,493 | convenience_store — DEAD TYPE, 1,417 rows (KAN-412) |
| `shop=laundry` | 1,232 | laundry — DEAD TYPE, 770 rows unreachable (KAN-412) |
| `shop=butcher` | 1,153 | butcher (KAN-396) |
| `shop=pastry` | 1,098 | bakery — the type already exists |
| `shop=optician` | 1,040 | eyecare (KAN-400) |
| `shop=jewelry` | 892 | store + store_kind=jewelry |
| `shop=shoes` | 848 | store + store_kind=shoes |
| `shop=kiosk` | 842 | lottery (KAN-411) — kiosks sell the games |
| `shop=greengrocer` | 751 | store — produce; needs a decision |
| `shop=electronics` | 732 | store + store_kind=electronics |
| `shop=doityourself` | 715 | store + store_kind=hardware |
| `shop=stationery` | 681 | papelaria (KAN-393) |
| `shop=mobile_phone` | 592 | store + store_kind=phone (KAN-411) |
| `shop=hardware` | 555 | store + store_kind=hardware |
| `shop=books` | 422 | store + store_kind=books |
| `shop=pet` | 387 | store + store_kind=pet |
| `shop=computer` | 353 | store + store_kind=electronics |
| `shop=seafood` | 296 | fishmonger (KAN-396) |
| `shop=paint` | 269 | store + store_kind=hardware |
| `shop=wine` | 254 | store + store_kind=drinks (KAN-411) |
| `shop=confectionery` | 213 | bakery |
| `shop=newsagent` | 182 | lottery/newsagent — needs a decision |
| `shop=garden_centre` | 175 | store — needs a decision |
| `shop=alcohol` | 168 | store + store_kind=drinks (KAN-411) |
| `shop=massage` | 163 | salon or its own type — needs a decision |
| `shop=tobacco` | 163 | lottery (KAN-411) — tabacarias sell them too |
| `shop=toys` | 120 | store + store_kind=toys |
| `shop=dry_cleaning` | 113 | laundry — same type, not a separate one |
| `shop=deli` | 101 | store — needs a decision |
| `shop=chocolate` | 55 | bakery |
| `shop=cheese` | 49 | store — needs a decision |
| `shop=beverages` | 48 | store + store_kind=drinks (KAN-411) |

Already handled by `TAG_TYPES`, listed so nobody re-fixes them (7 values):

| tag | elements | type |
|---|---:|---|
| `shop=hairdresser` | 3,931 | `hairdresser` |
| `shop=supermarket` | 3,643 | `supermarket` |
| `shop=bakery` | 2,116 | `bakery` |
| `shop=beauty` | 1,255 | `salon` |
| `shop=florist` | 687 | `florist` |
| `shop=tattoo` | 173 | `tattoo` |
| `shop=ice_cream` | 10 | `ice_cream` |

## Element count is not importance

The largest numbers here are the least useful data, and reading down from the top of this table is a mistake:

```
amenity=parking             64,735
highway=bus_stop            51,648
leisure=swimming_pool       42,923
leisure=garden              34,509
leisure=pitch               16,985
amenity=place_of_worship    13,574
```

`leisure=swimming_pool` and `leisure=garden` are overwhelmingly private — domestic pools and back gardens, not places anyone visits. `leisure=pitch` is every five-a-side court in the country.

**`highway=bus_stop` is the clearest trap.** 51,648 elements, and the app reaches 778 `bus` POIs today, so it looks like the largest gap in the ticket. It is not worth taking: a bus stop without routes or timetables tells the user only that a stop exists, which they can see by standing there. Importing it would add 51,648 rows that answer no errand and crowd everything that does. Product decision, recorded so the number does not tempt someone later — **unless route or timetable data arrives, location alone is not enough to help.**

This is the same lesson as KAN-403 arriving from the other direction. There, reading down a volume ranking surfaced roads and offices; here it surfaces swimming pools. Volume measures what a source maps densely, never what a person would walk to.

## Method and its limits

Overpass has no GROUP BY, so an exhaustive ranking of every unrequested value would mean downloading the tags of every element in the country — precisely what the usage policy exists to prevent. These are therefore **targeted counts of a curated list**, not an exhaustive ranking, and a value absent from the list is unmeasured rather than zero.

Counts are batched: each request carries up to 12 `out count` statements, answered in order, with 10s between requests. One request per value was rate-limited after two queries even at 3s spacing — each count scans the whole country, and Overpass limits by cost and slot rather than request rate.

On a 429 the run reads Overpass's status endpoint, waits the interval it publishes, and retries — up to 3 times, after which it stops and keeps partial results. Waiting for the announced time is the mechanism the service provides; moving to another mirror to dodge the limit is not, and KAN-387 lost a day to learning that.

```
[out:json][timeout:600];
area["ISO3166-1"="PT"][admin_level=2]->.a;
nwr["<key>"="<value>"](area.a);out count;   // repeated, up to
nwr["<key>"="<value>"](area.a);out count;   // 12 per request
```

