"""KAN-378 — import settlement *metadata*, never POIs.

Foursquare Open Map's Portugal extract has no usable `locality` values, so it
cannot discover settlements. This module uses OSM administrative/place areas
only to populate the `place` coverage and naming registry. It does not read,
write, classify, or partition Foursquare POIs.

Only elements with a real OSM bounding box are admitted. Point-only place
nodes are deliberately skipped: inventing a radius around a village would make
the API confidently return the wrong area name nearby. Municipal boundaries
provide country-wide coverage; smaller named place areas win naturally because
the Worker selects the smallest containing bbox.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import time
from typing import Any, Callable, Iterable

import requests

import d1_client

OVERPASS_ENDPOINTS = (
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
)
OVERPASS_TIMEOUT_S = 180
USER_AGENT = 'BrushSettlementRegistry/1.0 (one-time country metadata import)'
SETTLEMENT_PLACE_KINDS = frozenset({'city', 'town', 'village', 'hamlet', 'municipality'})
SQL_BATCH_SIZE = 100


@dataclass(frozen=True)
class Settlement:
    place_id: str
    name: str
    place_kind: str
    min_lat: float
    max_lat: float
    min_lng: float
    max_lng: float


def country_query(country_code: str) -> str:
    """Return a boundary-only Overpass query for an ISO two-letter country."""
    if not country_code.isalpha() or len(country_code) != 2:
        raise ValueError('country_code must be a two-letter ISO code')
    code = country_code.upper()
    return f'''[out:json][timeout:180];
area["ISO3166-1"="{code}"][admin_level=2]->.country;
(
  relation(area.country)[boundary=administrative][admin_level=7];
  relation(area.country)[place~"^(city|town|village|hamlet|municipality)$"];
  way(area.country)[place~"^(city|town|village|hamlet|municipality)$"];
);
out tags bb;'''


def fetch_overpass(query: str, post: Callable[..., Any] = requests.post) -> dict[str, Any]:
    """Fetch once from each supported endpoint, with one retry per endpoint."""
    last_error: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(2):
            try:
                response = post(
                    endpoint,
                    data={'data': query},
                    headers={'User-Agent': USER_AGENT},
                    timeout=OVERPASS_TIMEOUT_S,
                )
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError('Overpass response was not an object')
                return payload
            except (requests.RequestException, ValueError, json.JSONDecodeError) as error:
                last_error = error
                if attempt == 0:
                    time.sleep(2)
    raise RuntimeError(f'all Overpass settlement-registry requests failed: {last_error}')


def _as_finite_number(value: object) -> float | None:
    if not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if number == number and abs(number) != float('inf') else None


def settlements_from_overpass(payload: dict[str, Any]) -> tuple[list[Settlement], int]:
    """Parse usable named areas and count rejected source elements."""
    settlements: dict[str, Settlement] = {}
    skipped = 0
    elements = payload.get('elements')
    if not isinstance(elements, list):
        return [], 0

    for element in elements:
        if not isinstance(element, dict):
            skipped += 1
            continue
        element_type = element.get('type')
        element_id = element.get('id')
        tags = element.get('tags')
        bounds = element.get('bounds')
        if element_type not in {'relation', 'way'} or not isinstance(element_id, int) or not isinstance(tags, dict) or not isinstance(bounds, dict):
            skipped += 1
            continue
        name = tags.get('name')
        place_kind = tags.get('place')
        if not isinstance(name, str) or not name.strip():
            skipped += 1
            continue
        if place_kind not in SETTLEMENT_PLACE_KINDS:
            place_kind = 'municipality' if tags.get('boundary') == 'administrative' and tags.get('admin_level') == '7' else None
        if place_kind is None:
            skipped += 1
            continue
        min_lat = _as_finite_number(bounds.get('minlat'))
        max_lat = _as_finite_number(bounds.get('maxlat'))
        min_lng = _as_finite_number(bounds.get('minlon'))
        max_lng = _as_finite_number(bounds.get('maxlon'))
        if None in (min_lat, max_lat, min_lng, max_lng) or min_lat >= max_lat or min_lng >= max_lng:
            skipped += 1
            continue
        place_id = f'osm-{element_type}-{element_id}'
        settlements[place_id] = Settlement(place_id, name.strip(), place_kind, min_lat, max_lat, min_lng, max_lng)

    return sorted(settlements.values(), key=lambda settlement: settlement.place_id), skipped


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def settlement_upsert_sql(country_code: str, settlements: Iterable[Settlement]) -> Iterable[str]:
    """Yield bounded UPSERT statements; never changes a Place lifecycle state."""
    batch: list[Settlement] = []
    for settlement in settlements:
        batch.append(settlement)
        if len(batch) == SQL_BATCH_SIZE:
            yield _upsert_batch_sql(country_code, batch)
            batch = []
    if batch:
        yield _upsert_batch_sql(country_code, batch)


def _upsert_batch_sql(country_code: str, settlements: list[Settlement]) -> str:
    values = ',\n'.join(
        '(' + ', '.join((
            sql_quote(s.place_id), sql_quote(country_code), sql_quote(s.name), sql_quote(s.place_kind), "'mapped'",
            str(s.min_lat), str(s.max_lat), str(s.min_lng), str(s.max_lng), '0',
        )) + ')'
        for s in settlements
    )
    return f'''INSERT INTO place
  (place_id, country_code, name, place_kind, status, min_lat, max_lat, min_lng, max_lng, request_count)
VALUES {values}
ON CONFLICT(place_id) DO UPDATE SET
  country_code = excluded.country_code,
  name = excluded.name,
  place_kind = excluded.place_kind,
  min_lat = excluded.min_lat,
  max_lat = excluded.max_lat,
  min_lng = excluded.min_lng,
  max_lng = excluded.max_lng;'''


def mark_import(country_code: str, *, status: str, source_records: int, upserted: int, skipped: int, error: str | None = None) -> None:
    error_sql = 'NULL' if error is None else sql_quote(error[:1_000])
    completed_at = "datetime('now')" if status in {'mapped', 'failed'} else 'NULL'
    d1_client.execute(f'''UPDATE settlement_registry_import
SET status = {sql_quote(status)}, source = 'overpass', source_records = {source_records},
    settlements_upserted = {upserted}, settlements_skipped = {skipped},
    completed_at = {completed_at}, last_error = {error_sql}
WHERE country_code = {sql_quote(country_code)};''')


def import_country_settlements(country_code: str) -> dict[str, int]:
    """Fetch, validate, and persist a country's settlement metadata."""
    code = country_code.upper()
    source_records = 0
    upserted = 0
    skipped = 0
    try:
        payload = fetch_overpass(country_query(code))
        elements = payload.get('elements')
        source_records = len(elements) if isinstance(elements, list) else 0
        settlements, skipped = settlements_from_overpass(payload)
        if not settlements:
            raise RuntimeError('settlement source produced no usable bounded areas')
        for sql in settlement_upsert_sql(code, settlements):
            d1_client.execute(sql)
        upserted = len(settlements)
        mark_import(code, status='mapped', source_records=source_records, upserted=upserted, skipped=skipped)
        return {'source_records': source_records, 'upserted': upserted, 'skipped': skipped}
    except BaseException as error:
        # Keep the usable source/accounting details even if a later D1 write
        # fails; this makes the durable audit useful when retrying the job.
        try:
            mark_import(code, status='failed', source_records=source_records, upserted=upserted, skipped=skipped, error=type(error).__name__)
        except Exception as mark_error:
            print(f'[settlement_registry] could not persist failure state: {mark_error}')
        raise
