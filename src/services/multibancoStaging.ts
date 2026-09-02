/**
 * Provenance-preserving primitives for a future MULTIBANCO locator import.
 *
 * This module deliberately has no network or database side effects. The public
 * locator is a map viewport endpoint rather than a bulk-data API, so harvesting
 * it needs an explicitly approved backend job. Keeping the transformations
 * here pure makes that job resumable and testable without putting a scraper in
 * the mobile client or changing any existing POI provider.
 */

export const MULTIBANCO_SOURCE = 'multibanco' as const;
export const MULTIBANCO_LOCATOR_URL =
  'https://www.multibanco.pt/wp-admin/admin-ajax.php?action=sibs_get_markers';

/** Conservative client-side pacing for a future approved import worker. */
export const MULTIBANCO_MIN_REQUEST_INTERVAL_MS = 750;

/** A successful national run should be refreshed monthly, not continuously. */
export const MULTIBANCO_REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Benchmark used as a drift signal, not an assertion that the locator must
 * expose exactly this many records. The user-supplied 13.7k estimate is
 * intentionally given a broad tolerance because the official public copy
 * describes the network only as "about 13k" terminals.
 */
export const MULTIBANCO_NATIONAL_EXPECTED_COUNT = 13_700;
export const MULTIBANCO_NATIONAL_COUNT_TOLERANCE = 0.15;

export interface LocatorBounds {
  northEastLat: number;
  northEastLng: number;
  southWestLat: number;
  southWestLng: number;
}

export interface MultibancoLocatorMarker {
  name: string | null;
  address: string | null;
  parish: string | null;
  lat: string | number | null;
  lng: string | number | null;
  store_type: string | null;
  campaign: string | null;
}

export interface MultibancoStagedRecord {
  /** Stable source-scoped identity; never substitute this with a provider-free POI id. */
  id: string;
  source: typeof MULTIBANCO_SOURCE;
  sourceUrl: string;
  fetchedAt: string;
  request: {
    bounds: LocatorBounds;
    zoom: number;
  };
  /** Original marker fields, retained for re-parsing and auditability. */
  raw: MultibancoLocatorMarker;
  normalized: {
    name: string;
    address: string;
    parish: string | null;
    lat: number;
    lng: number;
    storeType: string | null;
    campaign: string | null;
  };
}

export interface MultibancoRejectedMarker {
  marker: MultibancoLocatorMarker;
  reason: 'missing-address' | 'invalid-coordinate' | 'missing-name';
}

export interface StageMultibancoMarkersResult {
  records: MultibancoStagedRecord[];
  rejected: MultibancoRejectedMarker[];
  /** Duplicate source identities suppressed within this response. */
  duplicates: number;
}

/** A durable job checkpoint can safely be persisted after every completed viewport. */
export interface MultibancoImportCheckpoint {
  source: typeof MULTIBANCO_SOURCE;
  runId: string;
  completedViewportIds: string[];
  lastSuccessfulAt: string | null;
}

function cleanText(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function identityText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function asCoordinate(value: string | number | null): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const coordinate = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(coordinate) ? coordinate : null;
}

function isValidLatLng(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * The locator does not return an official terminal ID. This identity combines
 * the human-visible address with coordinates rounded to roughly one metre;
 * changes in optional campaign metadata intentionally do not create a new POI.
 */
export function multibancoSourceId(name: string, address: string, lat: number, lng: number): string {
  return [
    MULTIBANCO_SOURCE,
    identityText(name),
    identityText(address),
    lat.toFixed(5),
    lng.toFixed(5),
  ].join(':');
}

export function validateLocatorBounds(bounds: LocatorBounds, zoom: number): void {
  const coordinates = [
    bounds.northEastLat, bounds.northEastLng, bounds.southWestLat, bounds.southWestLng,
  ];
  if (!coordinates.every(Number.isFinite)
    || bounds.northEastLat <= bounds.southWestLat
    || bounds.northEastLng <= bounds.southWestLng
    || !isValidLatLng(bounds.northEastLat, bounds.northEastLng)
    || !isValidLatLng(bounds.southWestLat, bounds.southWestLng)
    || !Number.isInteger(zoom) || zoom < 0 || zoom > 22) {
    throw new Error('Invalid MULTIBANCO locator viewport');
  }
}

/**
 * A deterministic resume key for a planned viewport. It is a job key only:
 * the public endpoint accepts geographic bounds, not slippy-map tile IDs.
 */
export function multibancoViewportId(bounds: LocatorBounds, zoom: number): string {
  validateLocatorBounds(bounds, zoom);
  return [
    zoom,
    bounds.southWestLat.toFixed(5), bounds.southWestLng.toFixed(5),
    bounds.northEastLat.toFixed(5), bounds.northEastLng.toFixed(5),
  ].join(':');
}

export function stageMultibancoMarkers(
  markers: MultibancoLocatorMarker[],
  request: MultibancoStagedRecord['request'],
  fetchedAt: string,
): StageMultibancoMarkersResult {
  validateLocatorBounds(request.bounds, request.zoom);
  if (Number.isNaN(Date.parse(fetchedAt))) {
    throw new Error('Invalid MULTIBANCO fetchedAt timestamp');
  }

  const records = new Map<string, MultibancoStagedRecord>();
  const rejected: MultibancoRejectedMarker[] = [];
  let duplicates = 0;

  for (const marker of markers) {
    const name = cleanText(marker.name);
    const address = cleanText(marker.address);
    const lat = asCoordinate(marker.lat);
    const lng = asCoordinate(marker.lng);

    if (!name) {
      rejected.push({ marker, reason: 'missing-name' });
      continue;
    }
    if (!address) {
      rejected.push({ marker, reason: 'missing-address' });
      continue;
    }
    if (lat == null || lng == null || !isValidLatLng(lat, lng)) {
      rejected.push({ marker, reason: 'invalid-coordinate' });
      continue;
    }

    const id = multibancoSourceId(name, address, lat, lng);
    if (records.has(id)) {
      duplicates += 1;
      continue;
    }
    records.set(id, {
      id,
      source: MULTIBANCO_SOURCE,
      sourceUrl: MULTIBANCO_LOCATOR_URL,
      fetchedAt,
      request,
      raw: marker,
      normalized: {
        name,
        address,
        parish: cleanText(marker.parish),
        lat,
        lng,
        storeType: cleanText(marker.store_type),
        campaign: cleanText(marker.campaign),
      },
    });
  }

  return { records: [...records.values()], rejected, duplicates };
}

/** Returns a new checkpoint after an atomically persisted viewport batch. */
export function markMultibancoViewportComplete(
  checkpoint: MultibancoImportCheckpoint,
  viewportId: string,
  completedAt: string,
): MultibancoImportCheckpoint {
  if (checkpoint.source !== MULTIBANCO_SOURCE || Number.isNaN(Date.parse(completedAt))) {
    throw new Error('Invalid MULTIBANCO import checkpoint');
  }
  return {
    ...checkpoint,
    completedViewportIds: checkpoint.completedViewportIds.includes(viewportId)
      ? checkpoint.completedViewportIds
      : [...checkpoint.completedViewportIds, viewportId],
    lastSuccessfulAt: completedAt,
  };
}

export function nextUnfinishedMultibancoViewport(
  viewportIds: string[],
  checkpoint: MultibancoImportCheckpoint,
): string | null {
  if (checkpoint.source !== MULTIBANCO_SOURCE) { throw new Error('Wrong source checkpoint'); }
  return viewportIds.find(id => !checkpoint.completedViewportIds.includes(id)) ?? null;
}

export function nextMultibancoRequestAllowedAt(lastRequestAt: number | null): number {
  return lastRequestAt == null
    ? 0
    : lastRequestAt + MULTIBANCO_MIN_REQUEST_INTERVAL_MS;
}

export function shouldRefreshMultibancoSource(
  lastSuccessfulAt: number | null,
  now: number,
): boolean {
  return lastSuccessfulAt == null || now - lastSuccessfulAt >= MULTIBANCO_REFRESH_INTERVAL_MS;
}

export interface NationalCountValidation {
  actual: number;
  minExpected: number;
  maxExpected: number;
  withinExpectedRange: boolean;
}

/** A quality gate for review; it never authorizes a production import by itself. */
export function validateNationalMultibancoCount(
  actual: number,
  expected: number = MULTIBANCO_NATIONAL_EXPECTED_COUNT,
  tolerance: number = MULTIBANCO_NATIONAL_COUNT_TOLERANCE,
): NationalCountValidation {
  if (!Number.isInteger(actual) || actual < 0 || !Number.isFinite(expected)
    || expected <= 0 || tolerance < 0 || tolerance >= 1) {
    throw new Error('Invalid MULTIBANCO national count validation input');
  }
  const minExpected = Math.ceil(expected * (1 - tolerance));
  const maxExpected = Math.floor(expected * (1 + tolerance));
  return { actual, minExpected, maxExpected, withinExpectedRange: actual >= minExpected && actual <= maxExpected };
}
