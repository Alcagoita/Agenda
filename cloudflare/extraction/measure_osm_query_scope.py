"""
KAN-405. Measures what the OSM supplement never asks Overpass for.

Sibling to KAN-403's Foursquare measurement, same discipline: read-only
counts, no import, no change to the live query. Measure first.

`supplement_osm_pois.osm_query` asks for four selectors — a 15-value
`amenity` enum, `office=financial`, a 2-value `leisure` enum, and a blanket
`shop`. Everything else in OSM is simply not fetched, and no query against
our own data can reveal it, because `osm_poi` stores no raw tags either.

Three failure modes, and this script separates them:

  NEVER REQUESTED   outside the selectors entirely. `tourism=*` in full, so
                    museums, hotels and attractions never arrive.
                    `highway=bus_stop` likewise — and `bus` reaches 778 POIs
                    nationally, the thinnest type we ship.
  DEGRADED          `shop=*` is blanket-queried, so `shop=butcher` and
                    `shop=optician` DO arrive and land as generic `store`
                    because TAG_TYPES has no rule for them. Already in the
                    database, unfindable by errand.
  FETCHES NOTHING   `amenity=ice_cream` is in TAG_TYPES but absent from the
                    selector, so it is never fetched at all (KAN-399).

## Why counts and not a full ranking

Overpass has no GROUP BY. A true ranking of every unrequested value would
mean downloading the tags of every element in Portugal, which is exactly
the kind of request the usage policy exists to stop. Instead this counts a
curated list of values with `out count`, batched many-per-request, and states
plainly that it is a targeted measurement rather than an exhaustive one.

## Rate limit

Overpass enforces by blocking, and KAN-387 lost a day to it.

One request per value was rate-limited after TWO queries even at 3s spacing:
each `out count` scans the whole country, and the limit is on cost and slots
rather than request rate, so spacing them further apart does not help. The
counts are therefore batched many-per-request — 85 requests become six.

On a 429 the run reads Overpass's own status endpoint, waits the interval it
announces, and gives up after MAX_SLOT_WAITS with partial results kept.
Waiting for the time the service publishes is the mechanism it provides;
switching mirrors to dodge the limit would not be.

Usage:
  python3 measure_osm_query_scope.py [--area PT] [--out <path.md>]
"""
import json
import os
import re
import sys
import time
import urllib.request

from enrich_osm_cuisine import OverpassRateLimited, fetch_overpass
from supplement_osm_pois import TAG_TYPES

# Derived, never hand-listed: which shop values the classifier ALREADY maps.
# Asserting this by hand is how a report claims bakeries are broken when a
# rule for them has existed since KAN-399.
MAPPED_SHOP = {value: poi_type for key, value, poi_type in TAG_TYPES if key == 'shop'}

# Polite spacing between counted queries. Overpass asks for well under one
# request per second sustained; this is deliberately slower.
REQUEST_SPACING_S = 10.0

# What the live selectors actually request today, copied from
# supplement_osm_pois.osm_query. Kept here so the report can state what is
# already covered rather than implying everything below is missing.
REQUESTED_AMENITY = {
    'atm', 'cafe', 'pharmacy', 'fuel', 'bank', 'bureau_de_change',
    'money_transfer', 'restaurant', 'fast_food', 'library', 'post_office',
    'clinic', 'school', 'bar', 'pub',
}
REQUESTED_LEISURE = {'fitness_centre', 'park'}

# Errand-shaped values the selectors never ask for. Curated, because
# Overpass cannot rank for us — each is here because it maps onto an app
# type we ship, or one KAN-400/KAN-411 has already decided is wanted.
NEVER_REQUESTED = [
    ('amenity', 'doctors'), ('amenity', 'dentist'), ('amenity', 'hospital'),
    ('amenity', 'veterinary'), ('amenity', 'cinema'), ('amenity', 'theatre'),
    ('amenity', 'place_of_worship'), ('amenity', 'ice_cream'),
    ('amenity', 'bus_station'), ('amenity', 'marketplace'),
    ('amenity', 'car_wash'), ('amenity', 'driving_school'),
    ('amenity', 'nightclub'), ('amenity', 'parking'), ('amenity', 'townhall'),
    ('tourism', 'museum'), ('tourism', 'attraction'), ('tourism', 'hotel'),
    ('tourism', 'artwork'), ('tourism', 'gallery'), ('tourism', 'viewpoint'),
    ('tourism', 'guest_house'), ('tourism', 'hostel'), ('tourism', 'zoo'),
    ('tourism', 'aquarium'), ('tourism', 'picnic_site'),
    ('historic', 'castle'), ('historic', 'monument'), ('historic', 'memorial'),
    ('historic', 'ruins'), ('historic', 'church'),
    ('leisure', 'sports_centre'), ('leisure', 'pitch'), ('leisure', 'garden'),
    ('leisure', 'swimming_pool'), ('leisure', 'playground'),
    ('highway', 'bus_stop'),
    ('railway', 'station'), ('railway', 'tram_stop'),
    ('craft', 'shoemaker'), ('craft', 'tailor'), ('craft', 'brewery'),
    ('office', 'lawyer'), ('office', 'insurance'), ('office', 'estate_agent'),
]

# Where each degraded value should land. Most are EXISTING store subtypes or
# types we already ship, which is what makes this the cheapest work in the
# ticket — a TAG_TYPES rule, no new app surface. A value mapping to something
# that does not exist yet names the ticket that owns it.
DEGRADED_TARGET = {
    'clothes': 'store + store_kind=clothing',
    'shoes': 'store + store_kind=shoes',
    'jewelry': 'store + store_kind=jewelry',
    'books': 'store + store_kind=books',
    'pet': 'store + store_kind=pet',
    'toys': 'store + store_kind=toys',
    'electronics': 'store + store_kind=electronics',
    'computer': 'store + store_kind=electronics',
    'mobile_phone': 'store + store_kind=phone (KAN-411)',
    'hardware': 'store + store_kind=hardware',
    'doityourself': 'store + store_kind=hardware',
    'paint': 'store + store_kind=hardware',
    'alcohol': 'store + store_kind=drinks (KAN-411)',
    'wine': 'store + store_kind=drinks (KAN-411)',
    'beverages': 'store + store_kind=drinks (KAN-411)',
    'pastry': 'bakery — the type already exists',
    'confectionery': 'bakery',
    'chocolate': 'bakery',
    'laundry': 'laundry — DEAD TYPE, 770 rows unreachable (KAN-412)',
    'dry_cleaning': 'laundry — same type, not a separate one',
    'butcher': 'butcher (KAN-396)',
    'seafood': 'fishmonger (KAN-396)',
    'stationery': 'papelaria (KAN-393)',
    'optician': 'eyecare (KAN-400)',
    'greengrocer': 'store — produce; needs a decision',
    'deli': 'store — needs a decision',
    'cheese': 'store — needs a decision',
    'newsagent': 'lottery/newsagent — needs a decision',
    'kiosk': 'lottery (KAN-411) — kiosks sell the games',
    'tobacco': 'lottery (KAN-411) — tabacarias sell them too',
    'convenience': 'convenience_store — DEAD TYPE, 1,417 rows (KAN-412)',
    'garden_centre': 'store — needs a decision',
    'massage': 'salon or its own type — needs a decision',
}

# Fetched by the blanket `shop` selector, but with no TAG_TYPES rule, so
# they land as generic `store`. Fixing these needs NO Overpass call at
# import time — only a classification rule — which makes them the cheapest
# win in the ticket.
DEGRADED_SHOP = [
    'butcher', 'seafood', 'stationery', 'optician', 'greengrocer',
    'confectionery', 'chocolate', 'deli', 'cheese', 'beverages', 'wine',
    'alcohol', 'tobacco', 'newsagent', 'books', 'hardware', 'doityourself',
    'paint', 'garden_centre', 'florist', 'mobile_phone', 'computer',
    'electronics', 'laundry', 'dry_cleaning', 'hairdresser', 'beauty',
    'massage', 'tattoo', 'jewelry', 'shoes', 'clothes', 'toys', 'pet',
    'bakery', 'pastry', 'ice_cream', 'supermarket', 'convenience', 'kiosk',
]


def area_filter(area):
    """ISO country code -> Overpass area clause. `area` is resolved by
    Overpass itself, so no bbox arithmetic and no risk of clipping."""
    return f'area["ISO3166-1"="{area}"][admin_level=2]->.a;'


# Values per Overpass request. Each `out count` scans the whole country, so
# one request per value rate-limited us after TWO — Overpass limits by cost
# and slot, not by request rate, and spacing them out does not help. Batching
# many counts into one query turns 85 requests into six.
VALUES_PER_QUERY = 12

# On 429, Overpass publishes when a slot frees. Waiting for the time it
# announces is not "retrying harder" — it is the mechanism the service
# provides. Anything beyond this and the run stops with partial results.
STATUS_URL = 'https://overpass-api.de/api/status'
MAX_SLOT_WAITS = 3


def batch_query(pairs, area):
    """One request, one `out count` per value, answered in order."""
    parts = [f'[out:json][timeout:600];{area_filter(area)}']
    for key, value in pairs:
        parts.append(f'nwr["{key}"="{value}"](area.a);out count;')
    return ''.join(parts)


def counts_from(payload, expected):
    """Overpass returns the count elements in statement order."""
    totals = [int(e['tags']['total']) for e in payload.get('elements', [])
              if e.get('type') == 'count']
    if len(totals) != expected:
        raise RuntimeError(f'expected {expected} counts, got {len(totals)}')
    return totals


def seconds_until_slot():
    """Parse Overpass's own announcement of when a slot frees."""
    try:
        with urllib.request.urlopen(STATUS_URL, timeout=30) as resp:
            text = resp.read().decode('utf-8', 'replace')
    except Exception:  # noqa: BLE001 — status is a courtesy, not a dependency
        return None
    waits = [int(m) for m in re.findall(r'Slot available after:.*?in (\d+) seconds', text)]
    return min(waits) if waits else None


def measure(pairs, area, label):
    results = []
    slot_waits = 0
    index = 0
    while index < len(pairs):
        chunk = pairs[index:index + VALUES_PER_QUERY]
        try:
            payload = fetch_overpass(batch_query(chunk, area))
            totals = counts_from(payload, len(chunk))
        except OverpassRateLimited:
            wait = seconds_until_slot()
            if wait is None or slot_waits >= MAX_SLOT_WAITS:
                print(f'  RATE LIMITED after {len(results)} of {len(pairs)} — stopping, '
                      'partial results kept', file=sys.stderr)
                break
            slot_waits += 1
            print(f'  rate limited; Overpass says a slot frees in {wait}s — waiting '
                  f'({slot_waits}/{MAX_SLOT_WAITS})', file=sys.stderr)
            time.sleep(wait + 5)
            continue
        except Exception as error:  # noqa: BLE001 — one bad batch must not lose the run
            print(f'  batch at {index} FAILED ({error})', file=sys.stderr)
            index += VALUES_PER_QUERY
            continue

        for (key, value), total in zip(chunk, totals):
            results.append({'key': key, 'value': value, 'count': total})
            print(f'  {label} {key}={value}: {total:,}', file=sys.stderr)
        index += VALUES_PER_QUERY
        if index < len(pairs):
            time.sleep(REQUEST_SPACING_S)
    results.sort(key=lambda r: (-r['count'], r['key'], r['value']))
    return results


def report(path, never, degraded, area, stopped_early):
    lines = [f'# KAN-405 — what the OSM query never asks for ({area})\n']
    lines.append('Measurement only. No import, no change to the live Overpass query — '
                 'the same discipline as KAN-403.\n')
    lines.append('## What the live selectors request today\n')
    lines.append('```')
    lines.append('nwr["amenity"~"^(atm|cafe|pharmacy|fuel|bank|bureau_de_change|money_transfer|')
    lines.append('                 restaurant|fast_food|library|post_office|clinic|school|bar|pub)$"]')
    lines.append('nwr["office"="financial"]')
    lines.append('nwr["leisure"~"^(fitness_centre|park)$"]')
    lines.append('nwr["shop"]')
    lines.append('```\n')
    lines.append('Everything outside those four is not fetched, and `osm_poi` keeps no '
                 'raw tags, so nothing in our own database can reveal what is missing. '
                 'That is why this had to be measured against Overpass.\n')

    if stopped_early:
        lines.append('> **Partial.** Overpass rate-limited the run; the counts below are '
                     'what completed before stopping. Re-running later fills the rest — '
                     'the limit is on us, so retrying harder is the wrong move.\n')

    lines.append('## Never requested\n')
    lines.append('These values are absent from the selectors entirely, so no element '
                 'carrying them has ever been fetched.\n')
    lines.append('| tag | elements in ' + area + ' |')
    lines.append('|---|---:|')
    for row in never:
        lines.append(f"| `{row['key']}={row['value']}` | {row['count']:,} |")
    lines.append('')

    handled = [r for r in degraded if r['value'] in MAPPED_SHOP]
    truly = [r for r in degraded if r['value'] not in MAPPED_SHOP]

    lines.append('## Fetched, but degraded to generic `store`\n')
    lines.append('`shop` is blanket-queried, so every value below DOES arrive. Those '
                 'without a `TAG_TYPES` rule land as generic `store` — **already in the '
                 'database, unfindable by errand.** Fixing them needs a classification '
                 'rule and no Overpass call at all, which makes this the cheapest work '
                 'in the ticket.\n')
    lines.append('| tag | elements | maps onto |')
    lines.append('|---|---:|---|')
    for row in truly:
        target = DEGRADED_TARGET.get(row['value'], 'needs a decision')
        lines.append(f"| `shop={row['value']}` | {row['count']:,} | {target} |")
    lines.append('')
    lines.append(f'Already handled by `TAG_TYPES`, listed so nobody re-fixes them '
                 f'({len(handled)} values):\n')
    lines.append('| tag | elements | type |')
    lines.append('|---|---:|---|')
    for row in handled:
        lines.append(f"| `shop={row['value']}` | {row['count']:,} | `{MAPPED_SHOP[row['value']]}` |")
    lines.append('')

    lines.append('## Element count is not importance\n')
    lines.append('The largest numbers here are the least useful data, and reading down '
                 'from the top of this table is a mistake:\n')
    lines.append('```')
    for row in never[:6]:
        lines.append(f"{row['key']}={row['value']:<18} {row['count']:>7,}")
    lines.append('```\n')
    lines.append('`leisure=swimming_pool` and `leisure=garden` are overwhelmingly '
                 'private — domestic pools and back gardens, not places anyone visits. '
                 '`leisure=pitch` is every five-a-side court in the country.\n')
    lines.append('**`highway=bus_stop` is the clearest trap.** 51,648 elements, and the '
                 'app reaches 778 `bus` POIs today, so it looks like the largest gap in '
                 'the ticket. It is not worth taking: a bus stop without routes or '
                 'timetables tells the user only that a stop exists, which they can see '
                 'by standing there. Importing it would add 51,648 rows that answer no '
                 'errand and crowd everything that does. Product decision, recorded so '
                 'the number does not tempt someone later — **unless route or timetable '
                 'data arrives, location alone is not enough to help.**\n')
    lines.append('This is the same lesson as KAN-403 arriving from the other direction. '
                 'There, reading down a volume ranking surfaced roads and offices; here '
                 'it surfaces swimming pools. Volume measures what a source maps '
                 'densely, never what a person would walk to.\n')

    lines.append('## Method and its limits\n')
    lines.append('Overpass has no GROUP BY, so an exhaustive ranking of every '
                 'unrequested value would mean downloading the tags of every element in '
                 'the country — precisely what the usage policy exists to prevent. '
                 'These are therefore **targeted counts of a curated list**, not an '
                 'exhaustive ranking, and a value absent from the list is unmeasured '
                 'rather than zero.\n')
    lines.append('Each count is one `out count` query, spaced '
                 f'{REQUEST_SPACING_S:.0f}s apart. A 429 stops the run rather than '
                 'moving to another mirror: the limit is on us, and KAN-387 lost a day '
                 'to learning that.\n')
    lines.append('```')
    lines.append('[out:json][timeout:180];')
    lines.append(f'area["ISO3166-1"="{area}"][admin_level=2]->.a;')
    lines.append('nwr["<key>"="<value>"](area.a);')
    lines.append('out count;')
    lines.append('```\n')

    with open(path, 'w') as handle:
        handle.write('\n'.join(lines) + '\n')
    print(f'wrote {path}')


def run(area, out_path, cache_path=None, use_cache=False):
    # Counts are cached so the wording of the report can be revised without
    # asking Overpass again. Re-measuring to fix a table header is exactly
    # the sort of casual load the usage policy exists to prevent.
    if use_cache and cache_path and os.path.exists(cache_path):
        with open(cache_path) as handle:
            cached = json.load(handle)
        print(f'using cached counts from {cache_path}', file=sys.stderr)
        never, degraded, stopped = cached['never'], cached['degraded'], cached['stopped']
    else:
        print(f'never-requested values ({len(NEVER_REQUESTED)})...', file=sys.stderr)
        never = measure(NEVER_REQUESTED, area, 'never')
        stopped = len(never) < len(NEVER_REQUESTED)

        degraded = []
        if not stopped:
            print(f'degraded shop values ({len(DEGRADED_SHOP)})...', file=sys.stderr)
            degraded = measure([('shop', v) for v in DEGRADED_SHOP], area, 'shop')
            stopped = len(degraded) < len(DEGRADED_SHOP)

        if cache_path:
            with open(cache_path, 'w') as handle:
                json.dump({'never': never, 'degraded': degraded, 'stopped': stopped}, handle)

    report(out_path, never, degraded, area, stopped)
    return never, degraded


if __name__ == '__main__':
    args = sys.argv[1:]
    area = args[args.index('--area') + 1] if '--area' in args else 'PT'
    default_out = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        'docs', 'KAN-405-osm-query-scope-measurement.md')
    out = args[args.index('--out') + 1] if '--out' in args else default_out
    cache = args[args.index('--cache') + 1] if '--cache' in args else None
    run(area, out, cache, use_cache='--use-cache' in args)
