#!/usr/bin/env node
/**
 * Produces a reviewed D1 import file for the Odivelas MULTIBANCO pilot.
 *
 * It performs no database write itself. Pipe `--sql` output to a temporary
 * file, inspect it, then apply it with `wrangler d1 execute ... --file`.
 * This keeps the public-locator fetch separate from the production mutation.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const MULTIBANCO_SOURCE = 'multibanco';
export const ODIVELAS_RELATION_ID = 5400891;
export const ODIVELAS_BOUNDS = {
  northEastLat: 38.8305301,
  northEastLng: -9.1498877,
  southWestLat: 38.7602212,
  southWestLng: -9.2411200,
  zoom: 12,
};

const LOCATOR_URL = 'https://www.multibanco.pt/wp-admin/admin-ajax.php';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

function normalize(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sqlString(value) {
  if (value == null) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Same provider-scoped identity used by the local staging contract. */
export function multibancoSourceId(name, address, lat, lng) {
  return [MULTIBANCO_SOURCE, normalize(name), normalize(address), Number(lat).toFixed(5), Number(lng).toFixed(5)].join(':');
}

/** A small, dependency-free WGS84 point-in-polygon check for the municipal GeoJSON. */
export function pointInPolygon(lng, lat, geometry) {
  const pointInRing = ring => {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [x, y] = ring[index];
      const [previousX, previousY] = ring[previous];
      if ((y > lat) !== (previousY > lat)
        && lng < ((previousX - x) * (lat - y) / (previousY - y) + x)) {
        inside = !inside;
      }
    }
    return inside;
  };

  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(polygon => pointInRing(polygon[0]) && !polygon.slice(1).some(pointInRing));
}

/** Geohash precision 7 is the precision used by the served curated-POI model. */
export function encodeGeohash(lat, lng, precision = 7) {
  let latitudeRange = [-90, 90];
  let longitudeRange = [-180, 180];
  let hash = '';
  let bit = 0;
  let value = 0;
  let evenBit = true;

  while (hash.length < precision) {
    const range = evenBit ? longitudeRange : latitudeRange;
    const coordinate = evenBit ? lng : lat;
    const middle = (range[0] + range[1]) / 2;
    if (coordinate >= middle) {
      value = (value << 1) + 1;
      range[0] = middle;
    } else {
      value <<= 1;
      range[1] = middle;
    }
    evenBit = !evenBit;
    bit += 1;
    if (bit === 5) {
      hash += GEOHASH_ALPHABET[value];
      bit = 0;
      value = 0;
    }
  }
  return hash;
}

export function eligibleOdivelasMarkers(markers, geometry) {
  const records = new Map();
  let rejected = 0;
  let outsideBoundary = 0;
  let duplicates = 0;

  for (const raw of markers) {
    const name = String(raw.name == null ? '' : raw.name).trim();
    const address = String(raw.address == null ? '' : raw.address).trim();
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    if (!name || !address || !Number.isFinite(lat) || !Number.isFinite(lng)
      || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      rejected += 1;
      continue;
    }
    if (!pointInPolygon(lng, lat, geometry)) {
      outsideBoundary += 1;
      continue;
    }
    const id = multibancoSourceId(name, address, lat, lng);
    if (records.has(id)) {
      duplicates += 1;
      continue;
    }
    records.set(id, { id, name, address, lat, lng, raw });
  }

  return { records: [...records.values()], rejected, outsideBoundary, duplicates };
}

function createLocatorRequestUrl() {
  const url = new URL(LOCATOR_URL);
  url.searchParams.set('action', 'sibs_get_markers');
  url.searchParams.set('nelat', String(ODIVELAS_BOUNDS.northEastLat));
  url.searchParams.set('nelng', String(ODIVELAS_BOUNDS.northEastLng));
  url.searchParams.set('swlat', String(ODIVELAS_BOUNDS.southWestLat));
  url.searchParams.set('swlng', String(ODIVELAS_BOUNDS.southWestLng));
  url.searchParams.set('zoom', String(ODIVELAS_BOUNDS.zoom));
  return url;
}

async function fetchOdivelasBoundary() {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', 'Odivelas, Lisboa, Portugal');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('polygon_geojson', '1');
  url.searchParams.set('limit', '1');

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Brush Multibanco pilot/0.1 (support@brushaway.app)' },
  });
  if (!response.ok) throw new Error(`Odivelas boundary request failed: ${response.status}`);
  const matches = await response.json();
  const match = matches[0];
  if (!match || !match.geojson || Number(match.osm_id) !== ODIVELAS_RELATION_ID) {
    throw new Error('Odivelas municipality boundary did not resolve to relation 5400891');
  }
  return match.geojson;
}

export async function fetchOdivelasPilot() {
  const [boundary, locatorResponse] = await Promise.all([
    fetchOdivelasBoundary(),
    fetch(createLocatorRequestUrl()),
  ]);
  if (!locatorResponse.ok) throw new Error(`MULTIBANCO locator request failed: ${locatorResponse.status}`);
  const markers = await locatorResponse.json();
  if (!Array.isArray(markers)) throw new Error('MULTIBANCO locator response was not an array');
  return {
    fetchedAt: new Date().toISOString(),
    sourceUrl: createLocatorRequestUrl().toString(),
    viewportRecords: markers.length,
    ...eligibleOdivelasMarkers(markers, boundary),
  };
}

/**
 * Generates one idempotent D1 transaction. `curated_poi.source` intentionally
 * remains `manual`: the deployed shared-POI schema currently permits only
 * `community` and `manual`. The provider is preserved unambiguously by the
 * `multibanco:` POI ID and the dedicated staging table's `source_name`.
 */
export function buildPilotSql(pilot, importedAt = pilot.fetchedAt) {
  const requestBounds = JSON.stringify(ODIVELAS_BOUNDS);
  const statements = [
    `CREATE TABLE IF NOT EXISTS multibanco_import_staging (
      source_id TEXT PRIMARY KEY,
      source_name TEXT NOT NULL CHECK (source_name = 'multibanco'),
      municipality_relation_id INTEGER NOT NULL,
      source_url TEXT NOT NULL,
      request_bounds_json TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      published_poi_id TEXT NOT NULL,
      published_at TEXT NOT NULL
    );`,
    'CREATE INDEX IF NOT EXISTS idx_multibanco_import_staging_municipality ON multibanco_import_staging(municipality_relation_id);',
  ];

  for (const record of pilot.records) {
    const rawPayload = JSON.stringify(record.raw);
    statements.push(
      `INSERT INTO multibanco_import_staging
       (source_id, source_name, municipality_relation_id, source_url, request_bounds_json, raw_payload_json, fetched_at, published_poi_id, published_at)
       VALUES (${sqlString(record.id)}, 'multibanco', ${ODIVELAS_RELATION_ID}, ${sqlString(pilot.sourceUrl)}, ${sqlString(requestBounds)}, ${sqlString(rawPayload)}, ${sqlString(pilot.fetchedAt)}, ${sqlString(record.id)}, ${sqlString(importedAt)})
       ON CONFLICT(source_id) DO UPDATE SET
         source_url = excluded.source_url,
         request_bounds_json = excluded.request_bounds_json,
         raw_payload_json = excluded.raw_payload_json,
         fetched_at = excluded.fetched_at,
         published_poi_id = excluded.published_poi_id,
         published_at = excluded.published_at;`,
      `INSERT INTO curated_poi
       (poi_id, source, source_submission_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, brand, address, status, created_at, created_by, updated_at, updated_by)
       VALUES (${sqlString(record.id)}, 'manual', NULL, ${sqlString(record.name)}, ${sqlString(normalize(record.name))}, ${record.lat}, ${record.lng}, ${sqlString(encodeGeohash(record.lat, record.lng))}, 'atm', NULL, ${sqlString(record.address)}, 'active', ${sqlString(importedAt)}, 'multibanco-import', ${sqlString(importedAt)}, 'multibanco-import')
       ON CONFLICT(poi_id) DO UPDATE SET
         name = excluded.name,
         dedupe_name = excluded.dedupe_name,
         lat = excluded.lat,
         lng = excluded.lng,
         geohash = excluded.geohash,
         primary_poi_type = 'atm',
         brand = NULL,
         address = excluded.address,
         status = 'active',
         updated_at = excluded.updated_at,
         updated_by = 'multibanco-import';`,
    );
  }
  return `${statements.join('\n')}\n`;
}

async function main() {
  const sqlMode = process.argv.includes('--sql');
  const pilot = await fetchOdivelasPilot();
  if (sqlMode) {
    process.stdout.write(buildPilotSql(pilot));
    return;
  }
  console.log(JSON.stringify({
    viewportRecords: pilot.viewportRecords,
    publishedCandidates: pilot.records.length,
    outsideBoundary: pilot.outsideBoundary,
    rejected: pilot.rejected,
    duplicates: pilot.duplicates,
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
