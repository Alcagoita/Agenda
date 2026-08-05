"""
KAN-354. Server-side Nominatim access for the extraction Job — a different
concern from cloudflare/src/index.ts's own Nominatim calls (which resolve a
coordinate to a Place identity for the Worker's dedupe) and from
src/services/maps.ts's (Lantern label, zero-check). This module answers a
different question: "given a Place identity we already have, what's its
boundary?" — needed to scope the Foursquare extraction query for on-demand
(place) mode. No boundary lookup is needed for country mode — Foursquare's
own `country` field does that filtering directly (see extract.py).
"""
import os
import time
import requests

NOMINATIM_LOOKUP_URL = 'https://nominatim.openstreetmap.org/lookup'
NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse'
USER_AGENT = 'BrushPoiExtractionJob/1 (poi-api.brushaway.app)'
# Nominatim's usage policy caps traffic at 1 request/second per caller — this
# Job makes at most one lookup per place-mode run (never per-POI, never
# looped), so a fixed pre-call sleep is sufficient; no token-bucket needed
# for a call volume this low.
MIN_INTERVAL_S = 1.0

_last_call_at = 0.0

# osm_type as stored in place_id (cloudflare/src/index.ts's `osm-${osmType}-${osmId}`) -> Nominatim's single-letter lookup prefix.
_OSM_TYPE_PREFIX = {'node': 'N', 'way': 'W', 'relation': 'R'}

class PlaceNotResolvable(Exception):
    pass

def parse_place_id(place_id):
    """'osm-relation-2897141' -> ('relation', '2897141'). Raises if place_id
    isn't in the KAN-355 osm-<type>-<id> shape — a place_id from before that
    migration (there shouldn't be any left) or a malformed target."""
    parts = place_id.split('-', 2)
    if len(parts) != 3 or parts[0] != 'osm' or parts[1] not in _OSM_TYPE_PREFIX:
        raise PlaceNotResolvable(f"place_id '{place_id}' is not in the expected 'osm-<type>-<id>' shape")
    return parts[1], parts[2]

def lookup_bbox(place_id):
    """Returns (min_lat, max_lat, min_lng, max_lng) for a Place's OSM
    boundary, or raises PlaceNotResolvable. This bbox scopes the extraction
    query only — the Place row's own min/max_lat/lng, written after
    extraction, records what was actually INGESTED (which rows fell inside
    this bbox and matched a category), per place_schema.sql's "not a
    boundary chosen in advance" contract. The two can legitimately differ
    slightly (a query bbox with zero matching rows near its edge)."""
    global _last_call_at
    osm_type, osm_id = parse_place_id(place_id)
    prefix = _OSM_TYPE_PREFIX[osm_type]

    elapsed = time.monotonic() - _last_call_at
    if elapsed < MIN_INTERVAL_S:
        time.sleep(MIN_INTERVAL_S - elapsed)
    _last_call_at = time.monotonic()

    res = requests.get(
        NOMINATIM_LOOKUP_URL,
        params={'osm_ids': f'{prefix}{osm_id}', 'format': 'jsonv2'},
        headers={'User-Agent': USER_AGENT},
        timeout=10,
    )
    res.raise_for_status()
    results = res.json()
    if not results:
        raise PlaceNotResolvable(f"Nominatim /lookup returned nothing for place_id '{place_id}'")
    bbox = results[0].get('boundingbox')
    if not bbox or len(bbox) != 4:
        raise PlaceNotResolvable(f"Nominatim /lookup returned no boundingbox for place_id '{place_id}'")
    south, north, west, east = (float(x) for x in bbox)
    return south, north, west, east

# ─── Place identity resolution — country mode's locality discovery ────────
#
# Python port of cloudflare/src/index.ts's resolvePlaceIdentity /
# nominatimReverse / normalizeSettlementName. Kept deliberately in sync by
# hand (no shared package between the Worker and this Job) — same bounded
# zoom-retry algorithm, same reasoning: a fixed zoom does not reliably
# resolve "the settlement" (Lisboa/Porto's freguesia problem). Only used by
# country mode, to turn a locality's row centroid into a stable place_id;
# place mode never needs this — its target place_id is given directly by
# the trigger, already resolved by the Worker at demand-recording time.

import unicodedata

ZOOM_CANDIDATES = (10, 9, 8)
SETTLEMENT_FIELD_PRIORITY = ('city', 'town', 'village', 'municipality', 'suburb', 'county')

def _normalize_settlement_name(value):
    decomposed = unicodedata.normalize('NFD', value)
    stripped = ''.join(c for c in decomposed if unicodedata.category(c) != 'Mn')
    return stripped.lower().strip()

def _nominatim_reverse(lat, lng, zoom):
    global _last_call_at
    elapsed = time.monotonic() - _last_call_at
    if elapsed < MIN_INTERVAL_S:
        time.sleep(MIN_INTERVAL_S - elapsed)
    _last_call_at = time.monotonic()

    res = requests.get(
        NOMINATIM_REVERSE_URL,
        params={'lat': lat, 'lon': lng, 'format': 'jsonv2', 'zoom': zoom, 'addressdetails': 1},
        headers={'User-Agent': USER_AGENT},
        timeout=10,
    )
    if not res.ok:
        return None
    data = res.json()
    osm_type = data.get('osm_type')
    osm_id = data.get('osm_id')
    name = data.get('name')
    if not osm_type or osm_id is None or not name:
        return None
    address = data.get('address') or {}
    settlement_name = None
    for field in SETTLEMENT_FIELD_PRIORITY:
        value = address.get(field)
        if value:
            settlement_name = value
            break
    return {
        'osm_type': osm_type, 'osm_id': osm_id, 'name': name,
        'addresstype': data.get('addresstype'),
        'country_code': (address.get('country_code') or '').upper() or None,
        'settlement_name': settlement_name,
    }

def resolve_place_identity(lat, lng):
    """Returns {'place_id', 'name', 'country_code', 'place_kind'} or None —
    same contract as the Worker's PlaceGeo. See the module-level note above:
    keep this in sync with resolvePlaceIdentity in cloudflare/src/index.ts."""
    for zoom in ZOOM_CANDIDATES:
        result = _nominatim_reverse(lat, lng, zoom)
        if result is None:
            return None
        settlement_name = result['settlement_name']
        if not settlement_name or _normalize_settlement_name(settlement_name) == _normalize_settlement_name(result['name']):
            return {
                'place_id': f"osm-{result['osm_type']}-{result['osm_id']}",
                'name': settlement_name or result['name'],
                'country_code': result['country_code'],
                'place_kind': result['addresstype'],
            }
    return None
