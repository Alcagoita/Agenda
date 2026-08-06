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
import { hasCachedPlaces } from '../services/habitatCache';

export interface OfflineCoverage {
  /** True only when we're confident the device is offline — `null`/unknown connectivity stays false. */
  offline: boolean;
  /** Whether the habitat cache has ever been seeded anywhere (not specific to the current location). `null` = not checked yet this offline period. */
  hasCache: boolean | null;
}

export function useOfflineCoverage(): OfflineCoverage {
  const { isConnected, isInternetReachable } = useNetInfo();
  const offline = isConnected === false || isInternetReachable === false;

  const [hasCache, setHasCache] = useState<boolean | null>(null);

  useEffect(() => {
    if (!offline) {
      setHasCache(null);
      return;
    }
    setHasCache(hasCachedPlaces());
  }, [offline]);

  return { offline, hasCache };
}
