/**
 * tripDownload.ts — Trip Planner business logic (KAN-234).
 *
 * Orchestrates a manual, destination-based offline area download: derives
 * the curated POI allowlist plus supported custom categories (same reasoning
 * as proximity.ts's habitat-cache prefetch — a trip task is created *during*
 * the trip, so a download filtered to today's tasks couldn't serve tomorrow's
 * "buy sunscreen"), fetches once via osmPlaces.searchOsmPlaces, and upserts
 * every result into the habitat cache tagged with this trip's
 * cacheAreaId/expiresAt (habitatCache.upsertTripPlace).
 *
 * Unlike habitatCache's own silent opportunistic refresh, downloadTripArea/
 * refreshTripArea are user-initiated, visible-progress actions — they throw
 * on failure so the screen can show a real error/retry instead of silently
 * swallowing it.
 *
 * The day-before-departure pre-refresh has no native scheduler to run on
 * (the app is foreground-only — KAN-231): checkAndRunTripPreRefresh mirrors
 * rolloverIncompleteTasks's "runs once on boot, non-fatal, best-effort"
 * shape (see SplashScreen.tsx) instead.
 */

import NetInfo from '@react-native-community/netinfo';
import { ALL_POI_TYPES } from '../types';
import { SUPPORTED_GOOGLE_PLACE_TYPES } from '../constants/googlePlaceTypes';
import type { Trip, TripRadiusPreset } from '../types';
import { searchOsmPlacesStrict } from './osmPlaces';
import { writeTripAreaPlaces, HABITAT_BYTES_PER_ROW } from './habitatCache';
import { updateTrip } from './firestore/trips';
import { todayISO } from '../utils/date';
// ─── Radius presets ───────────────────────────────────────────────────────────

/**
 * The 3 area-size presets offered in the Trip Planner flow.
 * No `label` here on purpose (KAN-252 review) — COPY is language-dynamic, and
 * this is a module-scope constant evaluated once at import time. Reading
 * COPY.* here would freeze the label in whatever language was active on
 * first import, never updating on a later language change. Callers look up
 * the label at render time instead — see TripPlannerScreen's `radiusLabel`.
 */
export const TRIP_RADIUS_PRESETS: { key: TripRadiusPreset; radiusMeters: number }[] = [
  { key: 'town',            radiusMeters: 5_000 },  // == HABITAT_RADIUS_M — the same "walkable metro area" assumption already validated by the opportunistic habitat cache
  { key: 'town_and_around', radiusMeters: 15_000 },
  { key: 'region',          radiusMeters: 40_000 },
];

export function getAreaDownloadPoiTypes(): string[] {
  return [...new Set([
    ...ALL_POI_TYPES,
    ...SUPPORTED_GOOGLE_PLACE_TYPES,
  ])];
}

/** A larger request (16+ types, up to 40km) than the opportunistic 5km refresh has ever needed — give Overpass more time before giving up (see osmPlaces.searchOsmPlaces's timeoutMs param). Shared by trip and mall snapshot downloads. */
const AREA_DOWNLOAD_TIMEOUT_MS = 20_000;

// ─── Expiry ───────────────────────────────────────────────────────────────────

/** Dateless downloads' default lifetime — a distinct constant from HABITAT_CACHE_STALE_MS (14d, which governs per-row OSM re-fetch freshness for the opportunistic pool, a different concept from "how long should this whole trip area live"). */
export const TRIP_DEFAULT_STALE_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days

/** Internal safety margin only, added past a dated trip's endDate — never shown to the user as the "know until" date, which is always endDate itself (see copy.ts's tripRowKnownUntil / sizeEstimateLine). */
export const TRIP_END_GRACE_MS = 5 * 24 * 60 * 60 * 1_000; // 5 days

/** No endDate → now + TRIP_DEFAULT_STALE_MS. With endDate → endDate + TRIP_END_GRACE_MS (internal only — the displayed date is always endDate). */
export function computeTripExpiresAt(endDate: string | undefined, now: number = Date.now()): number {
  if (!endDate) { return now + TRIP_DEFAULT_STALE_MS; }
  const endDateMs = new Date(`${endDate}T00:00:00`).getTime();
  return endDateMs + TRIP_END_GRACE_MS;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00`).getTime();
  const to = new Date(`${toIso}T00:00:00`).getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1_000));
}

/**
 * True only when today is the day before departure (or later, tolerating a
 * skipped day — up to a week past a dateless-end trip's start, as a sane
 * fallback bound), the device is online, and the pre-refresh hasn't already
 * run for this trip. False for dateless trips (nothing to pre-refresh
 * toward) and for trips whose endDate has already passed.
 */
export function shouldPreRefreshTrip(trip: Trip, todayIso: string, isOnline: boolean): boolean {
  if (!isOnline) { return false; }
  if (!trip.startDate) { return false; }
  if (trip.preRefreshedAt != null) { return false; }
  if (trip.endDate && todayIso > trip.endDate) { return false; }

  const daysUntilStart = daysBetween(todayIso, trip.startDate);
  if (daysUntilStart > 1) { return false; } // too early
  if (!trip.endDate && daysUntilStart < -7) { return false; } // no end date, more than a week past start — stop trying
  return true;
}

// ─── Size estimate ────────────────────────────────────────────────────────────

/**
 * Rough POI density used for the pre-download size estimate — illustrative,
 * not measured (per the ticket's own "one honest line" framing; no real
 * Overpass preflight call). Blended across all 16 built-in types and typical
 * suburban/rural density; genuinely dense downtown areas will undercount,
 * sparse rural ones will overcount, but this only needs to be roughly
 * honest, not precise. Tune after a real Overpass response is measured
 * during implementation (see risk notes in the KAN-234 plan).
 */
const POI_DENSITY_PER_KM2_PER_TYPE = 0.3;

/** area(km²) × POI_DENSITY_PER_KM2_PER_TYPE × poiTypeCount × HABITAT_BYTES_PER_ROW, rounded. */
export function estimateTripDownloadBytes(radiusMeters: number, poiTypeCount: number): number {
  const areaKm2 = Math.PI * (radiusMeters / 1_000) ** 2;
  const estimatedRows = areaKm2 * POI_DENSITY_PER_KM2_PER_TYPE * poiTypeCount;
  return Math.round(estimatedRows * HABITAT_BYTES_PER_ROW);
}

/**
 * "4 MB" / "< 1 MB" — language-neutral size token only (KAN-252 review): no
 * leading words like "About"/"Less than" here, since callers wrap this in
 * their own localized phrasing (see COPY.tripPlanner.sizeEstimateLine) —
 * baking English wording in here produced mixed-language output once pt-PT
 * was added (e.g. "Cerca de Less than 1 MB").
 */
export function formatTripSizeMb(bytes: number): string {
  const mb = bytes / (1_000 * 1_000);
  return mb < 1 ? '< 1 MB' : `${Math.round(mb)} MB`;
}

// ─── Download orchestration ───────────────────────────────────────────────────

/**
 * Fetches all given POI types once for the given center/radius and writes
 * every result into the habitat cache tagged with cacheAreaId/expiresAt.
 * Throws on failure — this is a user-initiated, visible-progress action
 * (unlike habitatCache's own silent fire-and-forget refresh), so the caller
 * can show a real error/retry. Uses searchOsmPlacesStrict (not
 * searchOsmPlaces) specifically so a real network failure surfaces as a
 * thrown error instead of collapsing into the same empty result as "this
 * area genuinely has no POIs" — a plain empty success would otherwise
 * persist a useless area.
 *
 * Clears any rows already tagged with this cacheAreaId and repopulates them
 * in a single SQLite transaction (habitatCache.writeTripAreaPlaces) — so a
 * refresh reconciles away places that no longer exist, but a write failure
 * partway through rolls back instead of leaving a previously-good area
 * cache half-deleted. This is a foreground, user-initiated action where data
 * integrity matters, unlike habitatCache's own never-throws opportunistic
 * writes.
 *
 * Shared by downloadTripArea (below) and mallSnapshots.ts's
 * downloadMallSnapshot (KAN-237) — both are "download this bounded area's
 * POIs once, tagged for cache-first proximity" with only the
 * center/radius/cacheAreaId/expiry differing.
 *
 * Returns the number of places written, for a confirmation state.
 */
export async function downloadAreaSnapshot(
  center: { lat: number; lng: number },
  radiusMeters: number,
  cacheAreaId: string,
  expiresAt: number,
  poiTypes: string[],
): Promise<number> {
  const osmResults = await searchOsmPlacesStrict(center.lat, center.lng, poiTypes, radiusMeters, AREA_DOWNLOAD_TIMEOUT_MS);

  const totalFound = poiTypes.reduce((sum, poiType) => sum + (osmResults[poiType]?.length ?? 0), 0);
  // A fetch that "succeeds" with zero places anywhere is indistinguishable
  // from a soft failure (e.g. Overpass rate-limiting with a 200) — treat it
  // as an error before touching any existing rows for this cacheAreaId, so a
  // spurious empty refresh can't wipe out an area that was working before.
  if (totalFound === 0) { throw new Error('Area download returned no places'); }

  const places = poiTypes.flatMap(poiType =>
    (osmResults[poiType] ?? []).map(place => ({
      poiType,
      name:            place.name,
      isGenericName:   place.isGenericName,
      lat:             place.lat,
      lng:             place.lng,
      source:          { osm: place.osmId },
      footprintAreaM2: place.footprintAreaM2,
    })),
  );
  return writeTripAreaPlaces(cacheAreaId, expiresAt, places);
}

/**
 * Derives the full curated POI allowlist (same reasoning as proximity.ts's
 * KAN-238 habitat-cache prefetch — a trip task
 * is created *during* the trip, so a download filtered to today's tasks
 * couldn't serve tomorrow's "buy sunscreen") and delegates to
 * downloadAreaSnapshot.
 */
export async function downloadTripArea(
  center: { lat: number; lng: number },
  radiusMeters: number,
  cacheAreaId: string,
  expiresAt: number,
): Promise<number> {
  const poiTypes = getAreaDownloadPoiTypes();
  return downloadAreaSnapshot(center, radiusMeters, cacheAreaId, expiresAt, poiTypes);
}

/**
 * Re-runs downloadTripArea for an existing trip (manual refresh from Places
 * I Know, or the day-before pre-refresh) and bumps its Firestore
 * expiresAt/preRefreshedAt to match.
 */
export async function refreshTripArea(
  uid: string,
  trip: Trip,
): Promise<void> {
  const expiresAt = computeTripExpiresAt(trip.endDate);
  await downloadTripArea(
    { lat: trip.centerLat, lng: trip.centerLng },
    trip.areaRadius,
    trip.cacheAreaId,
    expiresAt,
  );
  await updateTrip(uid, trip.id, { expiresAt, preRefreshedAt: Date.now() });
}

/**
 * Boot-time check: for each trip, if shouldPreRefreshTrip(...), refresh it.
 * Each trip is wrapped in its own try/catch — one trip's failure must not
 * block the others (mirrors rolloverIncompleteTasks's "non-fatal, best
 * effort" boot pattern — see SplashScreen.tsx).
 */
export async function checkAndRunTripPreRefresh(
  uid: string,
  trips: Trip[],
): Promise<void> {
  const today = todayISO();
  let isOnline = false;
  try { isOnline = (await NetInfo.fetch()).isConnected !== false; } catch { /* treat as offline */ }

  for (const trip of trips) {
    if (!shouldPreRefreshTrip(trip, today, isOnline)) { continue; }
    try {
      await refreshTripArea(uid, trip);
    } catch (err) {
      console.warn('[tripDownload] checkAndRunTripPreRefresh failed for trip', trip.id, err);
    }
  }
}
