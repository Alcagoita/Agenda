/**
 * cloudflarePoiFunctions.ts — typed calls against Brush's Cloudflare POI API.
 *
 * KAN-367: these three used to go through Firebase callables of the same
 * names; they now call poi-api.brushaway.app directly with the user's
 * Firebase ID token (see poiApi.ts). The exported names keep the `Proxy`
 * suffix on purpose — they are load-bearing across ~20 test files' module
 * mocks and every call site in maps.ts, and renaming them is churn this
 * ticket does not need. The Firebase functions themselves stay deployed as
 * the rollback path until this build is verified in production.
 */

import { poiApiGet, poiApiPost } from './poiApi';

interface CoverageResponse {
  status: 'none' | 'building' | 'ready';
  cityId: string | null;
  buildId?: string | null;
}

/**
 * KAN-346's own response shape, distinct from CoverageResponse above (GET
 * /coverage) — `coverageStatus` answers for the exact requested location,
 * not a whole city, and `retryAfterSeconds` is only ever present once
 * KAN-354's extraction worker exists (this endpoint cannot return
 * `building` before then — see cloudflare/src/index.ts).
 */
export interface RequestCoverageResponse {
  coverageStatus: 'none' | 'building' | 'ready';
  cityId: string | null;
  retryAfterSeconds?: number;
}

export interface CloudflareNearbyRequest {
  /** Stable client key: response buckets are keyed by this, not broad POI type. */
  key: string;
  type: string;
  attribute?: {
    dimension: 'food_cuisine' | 'store_kind' | 'financial_service_kind';
    values: [string];
  };
  /** Canonical Gym/Bank brand. Validated by the proxy and Worker. */
  brand?: string;
}

interface PoiAllResponse {
  /** KAN-377 — the settlement the requested point falls in, as the place table names it. Null when the point is in no known settlement. */
  placeName?: string | null;
  results: Record<string, Array<{
    /** Stable API identity: Foursquare id or an explicitly community-scoped id. */
    poi_id: string;
    /** Null for moderated community records; never a generated stand-in. */
    fsq_place_id: string | null;
    name: string;
    lat: number;
    lng: number;
    primary_poi_type: string;
    brand: string | null;
    category_label: string | null;
    address: string | null;
    /** KAN-318: default opening window, minutes from local midnight; null = always open. */
    open_min: number | null;
    close_min: number | null;
    distanceMeters: number;
    attributes: Record<string, string[]>;
  }>>;
}

export function cloudflareCoverageProxy(lat: number, lng: number): Promise<CoverageResponse> {
  return poiApiGet<CoverageResponse>(
    `/coverage?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`,
  );
}

/** KAN-347 global typed nearby search — POST /poi/nearby. */
export function cloudflarePoiAllProxy(
  lat: number,
  lng: number,
  radiusMeters: number,
  requests: CloudflareNearbyRequest[],
  limitPerRequest = 20,
): Promise<PoiAllResponse> {
  // `radius`, not `radiusMeters` — the Worker's own field name, which the
  // retired Firebase proxy used to translate.
  return poiApiPost<PoiAllResponse>('/poi/nearby', {
    lat, lng, radius: radiusMeters, requests, limitPerRequest,
  });
}

/** KAN-346 — records demand for an uncovered location. See searchNearbyPlacesCloudflare (maps.ts) for the deduped fire-and-forget caller. */
export function cloudflareRequestCoverageProxy(lat: number, lng: number): Promise<RequestCoverageResponse> {
  return poiApiPost<RequestCoverageResponse>('/coverage/request', { lat, lng });
}
