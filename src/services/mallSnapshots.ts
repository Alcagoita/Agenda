/**
 * mallSnapshots.ts — the current mall snapshot (KAN-237).
 *
 * Manual, toggle-driven equivalent of Trip Planner (KAN-234) for a single
 * shopping mall: user flips a Profile toggle while physically inside a
 * mall, we look it up via a Places nearby-search, download its POIs once
 * (reusing tripDownload.ts's downloadAreaSnapshot — same atomic
 * delete+reinsert cache write), and persist a singleton Firestore doc so
 * proximity.ts can skip the live API entirely while inside its bounds.
 *
 * Singleton (not a collection like Trip): only one mall is ever "learned"
 * at a time, so cacheAreaId is a fixed constant rather than per-place —
 * re-toggling reuses the same tagged rows instead of piling up old areas.
 */

import { getDoc, setDoc, deleteDoc, Timestamp } from '@react-native-firebase/firestore';
import type { MallSnapshot } from '../types';
import { mallSnapshotRef } from './firestore/refs';
import { searchNearbyPlaces, isGenuineMallType } from './maps';
import { downloadAreaSnapshot } from './tripDownload';
import { NEARBY_RADIUS } from './proximity';

/** Fixed — only one mall snapshot exists per user at a time. */
export const MALL_SNAPSHOT_CACHE_AREA_ID = 'mall_snapshot';

/** Radius used to find the mall itself — matches indoorDetection.ts's own mall lookup. Deliberately smaller than the download radius below: this only needs to bracket the mall place entity, not the POIs around it. */
export const MALL_SEARCH_RADIUS_M = 300;

/**
 * Radius used to bound the mall's POI download and the persisted snapshot's
 * coverage. Must be >= proximity.ts's NEARBY_RADIUS — otherwise a user near
 * the edge of the snapshot (inside MALL_SNAPSHOT_DOWNLOAD_RADIUS_M of the
 * mall center, so cache-first is active) could have real nearby places
 * within their own NEARBY_RADIUS search window that were never downloaded.
 */
export const MALL_SNAPSHOT_DOWNLOAD_RADIUS_M = Math.max(NEARBY_RADIUS, MALL_SEARCH_RADIUS_M);

/** Thrown by downloadMallSnapshot when no mall is nearby — a typed signal so callers (useMallSnapshotToggle) don't need to match on the error message string. */
export class NoMallFoundError extends Error {
  constructor() {
    super('No shopping mall found nearby');
    this.name = 'NoMallFoundError';
  }
}

/** Short-term per Google Places ToS (session/visit scale) — same order of magnitude as habitatCache's HABITAT_CACHE_STALE_MS, comfortably inside the ToS's documented ≤30-day bound. */
export const MALL_SNAPSHOT_STALE_MS = 14 * 24 * 60 * 60 * 1_000; // 14 days

/** Read the current mall snapshot, or null if none is active. */
export async function getMallSnapshot(uid: string): Promise<MallSnapshot | null> {
  const snap = await getDoc(mallSnapshotRef(uid));
  return (snap.data() as MallSnapshot | undefined) ?? null;
}

/** Overwrite the singleton mall snapshot doc. */
export async function setMallSnapshotDoc(uid: string, data: Omit<MallSnapshot, 'createdAt'>): Promise<void> {
  await setDoc(mallSnapshotRef(uid), { ...data, createdAt: Timestamp.now() });
}

/** Deletes the singleton mall snapshot doc. Caller must also clear the cached rows via habitatCache.deleteTripAreaPlaces(MALL_SNAPSHOT_CACHE_AREA_ID). */
export async function deleteMallSnapshotDoc(uid: string): Promise<void> {
  await deleteDoc(mallSnapshotRef(uid));
}

/**
 * Looks up the shopping mall at `center` (throws if none found within
 * MALL_SEARCH_RADIUS_M — the toggle can only be turned on while physically
 * inside one), downloads its POIs (the same curated allowlist the Trip
 * Planner uses), and persists the snapshot doc.
 *
 * Throws on any failure — this is a user-initiated, visible-progress
 * action (the Profile toggle's loading state), not a silent background
 * refresh.
 */
export async function downloadMallSnapshot(
  uid: string,
  center: { lat: number; lng: number },
  poiTypes: string[],
): Promise<MallSnapshot> {
  const { results: mallResults } = await searchNearbyPlaces(center.lat, center.lng, ['shopping_mall'], MALL_SEARCH_RADIUS_M);
  // A place lands in the shopping_mall bucket if ANY of its Google types
  // matched our request (searchNearbyPlaces buckets by "matched something
  // we asked for", not "this IS its type") — a parking/loading-dock feature
  // near a real mall can carry shopping_mall as a secondary tag and, if
  // nearest, get taken as "the mall" under its own wrong name. isGenuineMallType
  // checks BOTH primaryType AND the full types array (2026-07-19) — an
  // individual store inside the real mall can have primaryType:
  // 'shopping_mall' too while still carrying its own real category (e.g.
  // clothing_store), which primaryType alone wouldn't catch. Results stay
  // nearest-first, so the first genuine match here is still the closest one.
  const mall = mallResults.shopping_mall?.find(isGenuineMallType);
  if (!mall) { throw new NoMallFoundError(); }

  const expiresAt = Date.now() + MALL_SNAPSHOT_STALE_MS;
  await downloadAreaSnapshot(
    { lat: mall.lat, lng: mall.lng },
    MALL_SNAPSHOT_DOWNLOAD_RADIUS_M,
    MALL_SNAPSHOT_CACHE_AREA_ID,
    expiresAt,
    poiTypes,
  );

  const snapshot: Omit<MallSnapshot, 'createdAt'> = {
    placeId: mall.placeId,
    name: mall.name,
    centerLat: mall.lat,
    centerLng: mall.lng,
    radius: MALL_SNAPSHOT_DOWNLOAD_RADIUS_M,
    cacheAreaId: MALL_SNAPSHOT_CACHE_AREA_ID,
    expiresAt,
  };
  await setMallSnapshotDoc(uid, snapshot);
  return { ...snapshot, createdAt: Timestamp.now() };
}
