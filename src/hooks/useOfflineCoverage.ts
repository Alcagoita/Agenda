/**
 * useOfflineCoverage — shared offline/habitat-coverage detection (KAN-241).
 *
 * Keeps the connectivity and cache-coverage checks together so the offline
 * glyph only appears after coverage is known.
 *
 * hasCachedPlaces() opens/queries SQLite, so it must never run during
 * render (the first call can synchronously create the DB + schema) — it's
 * deferred to a post-commit effect, one tick behind `offline` itself.
 *
 * `hasCache` is tri-state (`null` = not yet known) rather than defaulting to
 * false: on the render where `offline` first flips true, the real cache
 * state hasn't been read yet. Callers must treat `null` as "don't render the
 * coverage-dependent glyph yet."
 */
import { useEffect, useState } from 'react';
import { useNetInfo } from '@react-native-community/netinfo';
import { hasCachedPlaces, hasCachedPlacesNear } from '../services/habitatCache';

export interface OfflineCoverage {
  /** True only when we're confident the device is offline — `null`/unknown connectivity stays false. */
  offline: boolean;
  /** Whether the habitat cache has ever been seeded anywhere (not specific to the current location). `null` = not checked yet this offline period. */
  hasCache: boolean | null;
  /**
   * Whether the cache holds places around the position passed in — the
   * location-specific answer `hasCache` can't give (KAN-316). `null` when no
   * position was supplied, when online, or before the check has run.
   */
  knowsHere: boolean | null;
}

/**
 * @param coords Position to answer `knowsHere` for. Omit it (Header does) to
 *               get connectivity plus the global `hasCache` only.
 * @param radiusMeters How far around `coords` counts as "here".
 */
export function useOfflineCoverage(
  coords?: { lat: number; lng: number } | null,
  radiusMeters?: number,
): OfflineCoverage {
  const { isConnected, isInternetReachable } = useNetInfo();
  const offline = isConnected === false || isInternetReachable === false;

  const [hasCache, setHasCache] = useState<boolean | null>(null);
  const [knowsHere, setKnowsHere] = useState<boolean | null>(null);

  // Primitive deps, not the coords object: a new object identity every render
  // would re-run this SQLite query on every render.
  const lat = coords?.lat ?? null;
  const lng = coords?.lng ?? null;

  useEffect(() => {
    if (!offline) {
      setHasCache(null);
      setKnowsHere(null);
      return;
    }
    setHasCache(hasCachedPlaces());
    setKnowsHere(lat != null && lng != null ? hasCachedPlacesNear(lat, lng, radiusMeters) : null);
  }, [offline, lat, lng, radiusMeters]);

  return { offline, hasCache, knowsHere };
}
