/**
 * clusterLeisure.ts — KAN-293 ("Central Park is right there").
 *
 * When a notable leisure or cultural place happens to sit among the stops of
 * an errand cluster, the cluster box mentions it once. The errand run becomes
 * an excuse for a walk. The place is never persisted as a task; if the user
 * accepts it, the card adds it to that one Maps handoff only.
 *
 * Detection is pure and cache-only. It reads rows the habitat cache already
 * holds — the leisure types ride along in the SAME prefetch the proximity
 * engine already makes for the user's own POI types (see
 * CLUSTER_LEISURE_TYPES and proximity.ts's prefetchTypes), so this feature
 * issues no request of its own.
 *
 * That prefetch is no longer an Overpass request: KAN-366 routed it through
 * searchNearbyPlaces (our POI API first, Overpass second), and KAN-407 let
 * the two heritage types through a filter that had been dropping them for
 * lacking an OSM tag they never needed.
 *
 * COMMERCIAL NEUTRALITY (KAN-293 doctrine — monetize fulfilment, never
 * placement): nothing in this module takes a partner, sponsor, bid or
 * revenue input. The only signals are physical: is the place one of a fixed
 * hand-authored set of types, does it have a real name, does its cached OSM
 * footprint suggest a real destination, and how far is it from a stop the user
 * was already going to. Nobody can pay to appear here, and no ordering below
 * may ever be influenced by a commercial relationship. The ticket link this
 * surfaces (`website`) is the place's own OSM-tagged
 * site — if that link ever becomes monetized, the change belongs to the
 * fulfilment action in KAN-239, never to the detection in this file.
 */

import { getDistanceMeters, placeTypeLabel } from './maps';
import type { NearbyPlace } from './maps';
import { queryHabitatCache } from './habitatCache';
import { CLUSTER_LEISURE_TYPES } from '../types';
import type { ClusterLeisureType } from '../types';
import type { ErrandBundle } from './errandBundles';

/**
 * How close a leisure place must be to one of the cluster's stops to be worth
 * mentioning. Deliberately much tighter than ERRAND_BUNDLE_RADIUS_M (700 m):
 * the bundle radius answers "can these errands be one trip", while this
 * answers "is this literally right there as you walk past" — the honest
 * threshold for the word "right there" in the copy.
 */
export const LEISURE_NEAR_STOP_RADIUS_M = 100;

export interface ClusterLeisureSuggestion {
  place: NearbyPlace;
  type: ClusterLeisureType;
  /** Distance to the nearest cluster stop — what qualified it, and the ranking key. */
  distanceToStopMeters: number;
}

const LARGE_FOOTPRINT_M2 = 2_000;
const MEDIUM_FOOTPRINT_M2 = 300;

/**
 * The one leisure place worth mentioning for `bundle`, or null.
 *
 * Rules, in order:
 *  - candidates come only from the habitat cache, only in CLUSTER_LEISURE_TYPES
 *  - a candidate must be within LEISURE_NEAR_STOP_RADIUS_M of at least ONE
 *    cluster stop (any stop, not just the anchor — the walk passes them all)
 *  - it must have a real name; an unnamed row ("Park") says nothing worth
 *    interrupting for, and the copy is built around naming the place
 *  - it must not already BE one of the cluster's stops (a park the user has
 *    an errand at is not a discovery)
 *  - larger cached OSM footprints outrank tiny fixtures; distance to the
 *    nearest stop breaks ties inside each footprint tier
 *  - if every candidate lacks footprint info, nearest-first is preserved
 *  - exactly one suggestion per bundle, ever
 *
 * Never throws — any failure yields null, and the line is simply absent.
 * Absence is the default state, never a placeholder.
 */
export function findClusterLeisure(bundle: ErrandBundle): ClusterLeisureSuggestion | null {
  try {
    const stops = bundle.entries.map(entry => entry.place);
    if (stops.length === 0) { return null; }

    // Search around the anchor, wide enough to reach a leisure place sitting
    // just past the furthest stop. Every candidate is then re-measured
    // against the individual stops below — this radius only bounds the query.
    const furthestStopM = Math.max(
      ...stops.map(stop => getDistanceMeters(bundle.anchor.lat, bundle.anchor.lng, stop.lat, stop.lng)),
    );
    const searchRadiusM = furthestStopM + LEISURE_NEAR_STOP_RADIUS_M;

    const byType = queryHabitatCache(
      bundle.anchor.lat,
      bundle.anchor.lng,
      [...CLUSTER_LEISURE_TYPES],
      searchRadiusM,
      { maxResultsPerType: null },
    );

    // A place already in the cluster is an errand, not a discovery.
    const stopPlaceIds = new Set(stops.map(stop => stop.placeId));

    let best: ClusterLeisureSuggestion | null = null;

    for (const type of CLUSTER_LEISURE_TYPES) {
      for (const place of byType[type] ?? []) {
        if (stopPlaceIds.has(place.placeId)) { continue; }
        if (!hasRealName(place, type)) { continue; }

        let nearestStopM = Infinity;
        for (const stop of stops) {
          const dist = getDistanceMeters(place.lat, place.lng, stop.lat, stop.lng);
          if (dist < nearestStopM) { nearestStopM = dist; }
        }
        if (nearestStopM > LEISURE_NEAR_STOP_RADIUS_M) { continue; }

        const candidate = { place, type, distanceToStopMeters: nearestStopM };
        if (!best || compareSuggestions(candidate, best) < 0) {
          best = candidate;
        }
      }
    }

    return best;
  } catch (err) {
    console.warn('[clusterLeisure] findClusterLeisure failed', err);
    return null;
  }
}

/**
 * True when the cached row carries a genuine name rather than osmPlaces'
 * type-label fallback. The cache doesn't surface its `is_generic_name` flag
 * through NearbyPlace, so compare against the same label the fallback would
 * have produced — a place actually called "Museum" is indistinguishable from
 * an unnamed one, and staying quiet is the right call either way.
 */
function hasRealName(place: NearbyPlace, type: ClusterLeisureType): boolean {
  const name = place.name?.trim();
  if (!name) { return false; }
  return name.toLowerCase() !== placeTypeLabel(type).trim().toLowerCase();
}

function footprintTier(place: NearbyPlace): number {
  const area = place.footprintAreaM2;
  if (area == null) { return 0; }
  if (area >= LARGE_FOOTPRINT_M2) { return 3; }
  if (area >= MEDIUM_FOOTPRINT_M2) { return 2; }
  if (area > 0) { return 1; }
  return 0;
}

function compareSuggestions(a: ClusterLeisureSuggestion, b: ClusterLeisureSuggestion): number {
  const tierDiff = footprintTier(b.place) - footprintTier(a.place);
  if (tierDiff !== 0) { return tierDiff; }
  return a.distanceToStopMeters - b.distanceToStopMeters;
}
