/**
 * destinationResolver.ts — KAN-281 shared destination resolution.
 *
 * KAN-279 originally specced "reuse the KAN-279 resolver" but that resolver
 * doesn't exist — KAN-279 shipped simpler (a plain Maps search, no picked
 * destination). This module builds the real per-task resolver KAN-281 needs
 * to order stops and build a multi-stop directions URL.
 *
 * Resolution order per task, first match wins:
 *   1. Learned place for the task's POI type (KAN-230 ranking) — "your"
 *      place wins even if another candidate is closer.
 *   2. Nearest match in the offline habitat cache, within ROUTE_MAX_RADIUS_M.
 *   3. A pre-fetched live-search result for this POI type, if one was
 *      provided (the live search itself is NOT called from here — see
 *      resolveTripDestinations, which batches all unresolved types into at
 *      most one Places API call for the whole trip).
 *
 * `resolveTaskDestination` never calls the network for step 4 — it only
 * reads whatever `liveResults` the orchestrator already fetched. This keeps
 * it fixture-testable per branch without mocking a live API call inside it.
 */

import { queryHabitatCache } from './habitatCache';
import { getLearnedPlaceForPoiType, type LearnedBrand } from './learnedPlaces';
import type { PlacesMap } from './proximity';
import type { Task } from '../types';

/** Wider than the cache's own default (5 km) is not needed — this doubles as
 *  the live-search radius, tuned to the same generous-but-bounded reach as
 *  KAN-279's original design intent. Start here, tune later. */
export const ROUTE_MAX_RADIUS_M = 5_000;

export type DestinationSource = 'learned' | 'cache' | 'live';

export interface ResolvedPlace {
  /** Google Place ID (pinned/live) or the internal habitat cross-source id (learned/cache). */
  internalId: string;
  name: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  source: DestinationSource;
}

export async function resolveTaskDestination(
  task: Task,
  coords: { lat: number; lng: number },
  learnedPlaces: LearnedBrand[],
  liveResults: PlacesMap = {},
): Promise<ResolvedPlace | null> {
  if (!task.poi) { return null; }

  // The offline habitat candidates for this type, nearest first — shared by
  // the learned-brand match (2) and the plain nearest fallback (3). Uncapped
  // (maxResultsPerType: null): a branch of the learned brand could sit past the
  // default per-type cap and would otherwise be missed by the name match below.
  const candidates = queryHabitatCache(
    coords.lat, coords.lng, [task.poi], ROUTE_MAX_RADIUS_M, { maxResultsPerType: null },
  )[task.poi] ?? [];

  // 1. Learned brand — the user's preferred brand for this type wins even if a
  // same-type stranger is closer (KAN-304: match by brand name, not place id).
  // Falls through if no branch of that brand is currently in range.
  const learned = getLearnedPlaceForPoiType(learnedPlaces, task.poi);
  if (learned) {
    const match = candidates.find(c => c.name === learned.name);
    if (match) {
      return {
        internalId:     match.placeId,
        name:           match.name,
        lat:            match.lat,
        lng:            match.lng,
        distanceMeters: match.distanceMeters,
        source:         'learned',
      };
    }
  }

  // 2. Nearest matching place from the offline habitat cache.
  const cached = candidates[0];
  if (cached) {
    return {
      internalId:     cached.placeId,
      name:           cached.name,
      lat:            cached.lat,
      lng:            cached.lng,
      distanceMeters: cached.distanceMeters,
      source:         'cache',
    };
  }

  // 3. A pre-fetched live-search result for this type, if the orchestrator
  // supplied one (respects the same radius cap).
  const live = liveResults[task.poi]?.[0];
  if (live && live.distanceMeters <= ROUTE_MAX_RADIUS_M) {
    return {
      internalId:     live.placeId,
      name:           live.name,
      lat:            live.lat,
      lng:            live.lng,
      distanceMeters: live.distanceMeters,
      source:         'live',
    };
  }

  // 4. Nothing resolved anywhere within the cap.
  return null;
}
