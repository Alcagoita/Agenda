"""Official MULTIBANCO locator client and idempotent D1 publisher (KAN-440).

The provider exposes map viewport markers rather than a downloadable national
feed.  A single caller fetches one municipality bbox at a time, at least one
second apart; the Worker owns all progress/leases, so this module never needs
credentials or mutable process state.
"""
from __future__ import annotations

import json
import re
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode


LOCATOR_URL = 'https://www.multibanco.pt/wp-admin/admin-ajax.php'
LOCATOR_ACTION = 'sibs_get_markers'
REQUEST_INTERVAL_SECONDS = 1.0
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz'


class LocatorRateLimited(Exception):
    """The public endpoint asked us to slow down; release every held scope."""


@dataclass(frozen=True)
class Marker:
    source_id: str
    name: str
    dedupe_name: str
    address: str
    lat: float
    lng: float
    parish: str | None
    store_type: str | None
    campaign: str | None
    raw: dict[str, Any]


def normalize(value: object) -> str:
    text = unicodedata.normalize('NFD', str(value or ''))
    text = ''.join(char for char in text if unicodedata.category(char) != 'Mn')
    return re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()


def optional_text(value: object) -> str | None:
    text = str(value or '').strip()
    return text or None


def source_id(name: str, address: str, lat: float, lng: float) -> str:
    # The locator does not return a terminal ID. Address + one-metre
    # coordinates is stable across metadata-only changes and deterministic on
    # overlapping municipality bboxes.
    return f'multibanco:{normalize(name)}:{normalize(address)}:{lat:.5f}:{lng:.5f}'


def encode_geohash(lat: float, lng: float, precision: int = 7) -> str:
    lat_range, lng_range = [-90.0, 90.0], [-180.0, 180.0]
    encoded, bit, value, even = [], 0, 0, True
    while len(encoded) < precision:
        bounds, coordinate = (lng_range, lng) if even else (lat_range, lat)
        midpoint = (bounds[0] + bounds[1]) / 2
        if coordinate >= midpoint:
            value = (value << 1) + 1
            bounds[0] = midpoint
        else:
            value <<= 1
            bounds[1] = midpoint
        even = not even
        bit += 1
        if bit == 5:
            encoded.append(GEOHASH_ALPHABET[value])
            bit, value = 0, 0
    return ''.join(encoded)


def locator_url(min_lat: float, max_lat: float, min_lng: float, max_lng: float, zoom: int = 12) -> str:
    return f'{LOCATOR_URL}?{urlencode({"action": LOCATOR_ACTION, "nelat": max_lat, "nelng": max_lng, "swlat": min_lat, "swlng": min_lng, "zoom": zoom})}'


def fetch_markers(min_lat: float, max_lat: float, min_lng: float, max_lng: float) -> tuple[str, list[dict[str, Any]]]:
    # Kept local so parser/SQL unit tests do not need the Container's runtime
    # HTTP dependency installed.
    import requests
    url = locator_url(min_lat, max_lat, min_lng, max_lng)
    response = requests.get(url, headers={'User-Agent': 'Brush MULTIBANCO importer/1.0 (support@brushaway.app)'}, timeout=30)
    if response.status_code in (429, 503):
        raise LocatorRateLimited(f'locator returned {response.status_code}')
    response.raise_for_status()
    declared_length = response.headers.get('content-length')
    if declared_length and int(declared_length) > MAX_RESPONSE_BYTES:
        raise ValueError('locator response exceeds the safe viewport limit')
    if len(response.content) > MAX_RESPONSE_BYTES:
        raise ValueError('locator response exceeds the safe viewport limit')
    payload = response.json()
    if not isinstance(payload, list):
        raise ValueError('locator response is not a marker array')
    return url, [entry for entry in payload if isinstance(entry, dict)]


def parse_markers(raw_markers: list[dict[str, Any]]) -> tuple[list[Marker], int, int]:
    records: dict[str, Marker] = {}
    rejected = duplicates = 0
    for raw in raw_markers:
        name, address = optional_text(raw.get('name')), optional_text(raw.get('address'))
        try:
            lat, lng = float(raw.get('lat')), float(raw.get('lng'))
        except (TypeError, ValueError):
            rejected += 1
            continue
        if not name or not address or not (-90 <= lat <= 90 and -180 <= lng <= 180):
            rejected += 1
            continue
        identity = source_id(name, address, lat, lng)
        if identity in records:
            duplicates += 1
            continue
        records[identity] = Marker(identity, name, normalize(name), address, lat, lng,
                                   optional_text(raw.get('parish')), optional_text(raw.get('store_type')),
                                   optional_text(raw.get('campaign')), raw)
    return list(records.values()), rejected, duplicates


def sql_literal(value: object | None) -> str:
    if value is None:
        return 'NULL'
    # Marker fields are untrusted remote input. SQLite literal escaping plus
    # control-character removal keeps every generated statement single-row.
    safe = re.sub(r'[\x00-\x1f\x7f;]+', ' ', str(value)).strip()
    return "'" + safe.replace("'", "''") + "'"


def municipality_relation_id(place_id: str) -> int:
    match = re.search(r'(\d+)$', place_id)
    return int(match.group(1)) if match else 0


def statements_for_marker(marker: Marker, place_id: str, source_url: str, bounds: dict[str, float], fetched_at: str) -> list[str]:
    raw_payload = json.dumps(marker.raw, ensure_ascii=False, separators=(',', ':'))
    common = {
        'source_id': sql_literal(marker.source_id), 'name': sql_literal(marker.name),
        'dedupe_name': sql_literal(marker.dedupe_name), 'lat': marker.lat, 'lng': marker.lng,
        'geohash': sql_literal(encode_geohash(marker.lat, marker.lng)), 'address': sql_literal(marker.address),
        'parish': sql_literal(marker.parish), 'store_type': sql_literal(marker.store_type),
        'campaign': sql_literal(marker.campaign), 'url': sql_literal(source_url),
        'raw': sql_literal(raw_payload), 'fetched_at': sql_literal(fetched_at),
    }
    return [
        f'''INSERT INTO multibanco_import_staging
          (source_id, source_name, municipality_relation_id, source_url, request_bounds_json, raw_payload_json, fetched_at, published_poi_id, published_at)
          VALUES ({common['source_id']}, 'multibanco', {municipality_relation_id(place_id)}, {common['url']},
                  {sql_literal(json.dumps(bounds, separators=(',', ':')))}, {common['raw']}, {common['fetched_at']}, {common['source_id']}, {common['fetched_at']})
          ON CONFLICT(source_id) DO UPDATE SET source_url=excluded.source_url, request_bounds_json=excluded.request_bounds_json,
            raw_payload_json=excluded.raw_payload_json, fetched_at=excluded.fetched_at, published_poi_id=excluded.published_poi_id, published_at=excluded.published_at;''',
        f'''INSERT INTO multibanco_poi
          (source_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, address, parish, store_type, campaign,
           source_url, raw_payload_json, fetched_at, imported_at, updated_at, is_demo_zone)
          VALUES ({common['source_id']}, {common['name']}, {common['dedupe_name']}, {common['lat']}, {common['lng']},
                  {common['geohash']}, 'atm', {common['address']}, {common['parish']}, {common['store_type']}, {common['campaign']},
                  {common['url']}, {common['raw']}, {common['fetched_at']}, {common['fetched_at']}, {common['fetched_at']}, 0)
          ON CONFLICT(source_id) DO UPDATE SET name=excluded.name, dedupe_name=excluded.dedupe_name, lat=excluded.lat,
            lng=excluded.lng, geohash=excluded.geohash, address=excluded.address, parish=excluded.parish,
            store_type=excluded.store_type, campaign=excluded.campaign, source_url=excluded.source_url,
            raw_payload_json=excluded.raw_payload_json, fetched_at=excluded.fetched_at, updated_at=excluded.updated_at;''',
    ]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
