import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore } from 'firebase-admin/firestore';
import brandDictionary from '../../src/constants/brandDictionary.json';

/**
 * Proxy for Brush's own Cloudflare-backed POI API (poi-api.brushaway.app,
 * KAN-329 through KAN-341) — mirrors places.ts's Google Places proxy
 * pattern exactly (onCall, defineSecret, per-user rate limit, HttpsError),
 * for the same reason: the API key must never be embedded in the client
 * bundle (KAN-273/274's reasoning applies equally here — this key is ours,
 * not Google's, but the exposure risk is the same).
 */
const cloudflarePoiApiKey = defineSecret('CLOUDFLARE_POI_API_KEY');

const FETCH_TIMEOUT_MS = 8_000;
const CLOUDFLARE_POI_BASE_URL = 'https://poi-api.brushaway.app';
const CLOUDFLARE_POI_PROXY_MAX_INSTANCES = 10;
const CLOUDFLARE_POI_RATE_LIMIT_WINDOW_MS = 60_000;
const CLOUDFLARE_POI_RATE_LIMIT_MAX_REQUESTS = 30;
// Tighter than the read-only proxies above (KAN-346) — this one can trigger
// a server-side Nominatim reverse-geocode call for a brand new municipality,
// not just a D1 read.
const CLOUDFLARE_REQUEST_COVERAGE_RATE_LIMIT_MAX_REQUESTS = 5;

interface CoverageInput {
  lat: number;
  lng: number;
}

type RequestCoverageInput = CoverageInput;

interface NearbyAttributeInput {
  dimension: 'food_cuisine' | 'store_kind';
  values: string[];
}

interface NearbyRequestInput {
  key: string;
  type: string;
  attribute?: NearbyAttributeInput;
  brand?: string;
}

interface PoiAllInput {
  lat: number;
  lng: number;
  radiusMeters: number;
  /** Legacy APK field. New callers send request-keyed searches below. */
  poiTypes?: string[];
  limitPerType?: number;
  requests?: NearbyRequestInput[];
  limitPerRequest?: number;
}

interface RateLimitDoc {
  windowStartedAt: number;
  requestCount: number;
  updatedAt: Date;
}

// Must stay in sync with the Worker's SUBTYPE_FILTERS (cloudflare/src/index.ts).
// KAN-344 group values (asian, bbq, brazilian, mediterranean, pizza, seafood)
// carry no classified poi_attribute row — the Worker resolves them against
// raw_category_labels — but they must be allowed here or the proxy rejects the
// request before it reaches the Worker.
const SUBTYPE_FILTER_VALUES: Record<NearbyAttributeInput['dimension'], readonly string[]> = {
  food_cuisine: ['asian', 'bbq', 'brazilian', 'burger', 'healthy', 'indian', 'italian', 'mediterranean', 'mexican', 'pizza', 'portuguese', 'seafood', 'steak', 'sushi', 'thai', 'vegetarian'],
  store_kind: ['beauty', 'bicycle', 'books', 'clothing', 'electronics', 'furniture', 'hardware', 'home', 'jewelry', 'pet', 'shoes', 'sports', 'toys'],
};

const BRAND_FILTER_TYPES = new Set(['gym', 'bank']);
const CANONICAL_BRANDS = new Map(
  Object.entries(brandDictionary).map(([type, brands]) => [
    type,
    new Set((brands as Array<{ name: string }>).map(brand => brand.name)),
  ]),
);

function assertAuthenticated(auth: unknown): void {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertCoordinate(lat: unknown, lng: unknown): void {
  if (!isFiniteNumber(lat) || lat < -90 || lat > 90) {
    throw new HttpsError('invalid-argument', '"lat" must be a valid latitude.');
  }
  if (!isFiniteNumber(lng) || lng < -180 || lng > 180) {
    throw new HttpsError('invalid-argument', '"lng" must be a valid longitude.');
  }
}

function getApiKey(): string {
  const apiKey = cloudflarePoiApiKey.value();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'Cloudflare POI API key is not configured.');
  }
  return apiKey;
}

function assertNearbyRequests(data: PoiAllInput): { requests: NearbyRequestInput[]; limitPerRequest: number } {
  if (data.requests === undefined && (!Array.isArray(data.poiTypes) || data.poiTypes.length === 0 || data.poiTypes.length > 10 || data.poiTypes.some(type => typeof type !== 'string' || type.trim() === ''))) {
    throw new HttpsError('invalid-argument', '"poiTypes" must contain between 1 and 10 non-empty strings.');
  }
  const requests: NearbyRequestInput[] | undefined = data.requests ?? data.poiTypes?.map(type => ({ key: type, type }));
  const limitPerRequest = data.limitPerRequest ?? data.limitPerType;
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > 32) {
    throw new HttpsError('invalid-argument', '"requests" must contain between 1 and 32 entries.');
  }
  if (typeof limitPerRequest !== 'number' || !Number.isInteger(limitPerRequest) || limitPerRequest < 1 || limitPerRequest > 50) {
    throw new HttpsError('invalid-argument', '"limitPerRequest" must be an integer between 1 and 50.');
  }

  const seenKeys = new Set<string>();
  for (const request of requests) {
    if (!request || typeof request.key !== 'string' || request.key.trim() === '' || request.key.length > 80 || seenKeys.has(request.key)) {
      throw new HttpsError('invalid-argument', 'Each nearby request needs a unique non-empty key.');
    }
    if (typeof request.type !== 'string' || request.type.trim() === '') {
      throw new HttpsError('invalid-argument', 'Each nearby request needs a non-empty type.');
    }
    seenKeys.add(request.key);
    if (request.attribute && (
      !((request.type === 'restaurant' && request.attribute.dimension === 'food_cuisine') ||
        (request.type === 'store' && request.attribute.dimension === 'store_kind')) ||
      !Array.isArray(request.attribute.values) || request.attribute.values.length !== 1 ||
      request.attribute.values.some(value => typeof value !== 'string' || !SUBTYPE_FILTER_VALUES[request.attribute!.dimension].includes(value))
    )) {
      throw new HttpsError('invalid-argument', 'Each nearby attribute filter needs one supported dimension and value.');
    }
    if (request.brand !== undefined && (
      typeof request.brand !== 'string' || !BRAND_FILTER_TYPES.has(request.type) ||
      !CANONICAL_BRANDS.get(request.type)?.has(request.brand)
    )) {
      throw new HttpsError('invalid-argument', 'Each nearby brand filter needs one supported canonical Gym or Bank brand.');
    }
  }
  return { requests, limitPerRequest };
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { 'X-Api-Key': getApiKey() }, signal: controller.signal });
  } catch {
    throw new HttpsError('unavailable', 'Cloudflare POI request failed.');
  } finally {
    clearTimeout(timer);
  }
}

async function postWithTimeout(url: string, body: unknown): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'X-Api-Key': getApiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new HttpsError('unavailable', 'Cloudflare POI request failed.');
  } finally {
    clearTimeout(timer);
  }
}

async function requireOkJsonFrom<T>(response: Response, url: string): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error('[cloudflarePoi] Upstream request failed', {
      url,
      status: response.status,
      body: text.slice(0, 500),
    });
    throw new HttpsError('unavailable', 'Cloudflare POI proxy request failed.');
  }
  return (await response.json()) as T;
}

async function requireOkJson<T>(url: string): Promise<T> {
  const response = await fetchWithTimeout(url);
  return requireOkJsonFrom<T>(response, url);
}

async function enforceUserRateLimit(
  uid: string,
  action: string,
  maxRequests: number = CLOUDFLARE_POI_RATE_LIMIT_MAX_REQUESTS,
): Promise<void> {
  const db = getFirestore();
  const docRef = db.collection('_cloudflarePoiProxyRateLimits').doc(`${uid}:${action}`);
  const now = Date.now();

  await db.runTransaction(async transaction => {
    const snap = await transaction.get(docRef);
    const current = snap.data() as Omit<RateLimitDoc, 'updatedAt'> | undefined;
    const withinWindow = current != null && now - current.windowStartedAt < CLOUDFLARE_POI_RATE_LIMIT_WINDOW_MS;
    const nextCount = withinWindow ? current.requestCount + 1 : 1;

    if (withinWindow && current.requestCount >= maxRequests) {
      throw new HttpsError('resource-exhausted', 'Too many POI requests. Please try again soon.');
    }

    transaction.set(docRef, {
      windowStartedAt: withinWindow ? current!.windowStartedAt : now,
      requestCount: nextCount,
      updatedAt: new Date(),
    } satisfies RateLimitDoc);
  });
}

export const cloudflareCoverageProxy = onCall(
  {
    secrets: [cloudflarePoiApiKey],
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: CLOUDFLARE_POI_PROXY_MAX_INSTANCES,
  },
  async (request) => {
    assertAuthenticated(request.auth);
    const data = request.data as CoverageInput;
    assertCoordinate(data?.lat, data?.lng);
    await enforceUserRateLimit(request.auth!.uid, 'coverage');

    return requireOkJson(
      `${CLOUDFLARE_POI_BASE_URL}/coverage?lat=${encodeURIComponent(data.lat)}&lng=${encodeURIComponent(data.lng)}`,
    );
  },
);

export const cloudflarePoiAllProxy = onCall(
  {
    secrets: [cloudflarePoiApiKey],
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: CLOUDFLARE_POI_PROXY_MAX_INSTANCES,
  },
  async (request) => {
    assertAuthenticated(request.auth);
    const data = request.data as PoiAllInput;
    assertCoordinate(data?.lat, data?.lng);
    if (!Number.isInteger(data?.radiusMeters) || data.radiusMeters <= 0 || data.radiusMeters > 4_500) {
      throw new HttpsError('invalid-argument', '"radiusMeters" must be an integer between 1 and 4500.');
    }
    const { requests, limitPerRequest } = assertNearbyRequests(data ?? ({} as PoiAllInput));
    await enforceUserRateLimit(request.auth!.uid, 'poiAll');

    return requireOkJsonFrom(
      await postWithTimeout(`${CLOUDFLARE_POI_BASE_URL}/poi/nearby`, {
        lat: data.lat,
        lng: data.lng,
        radius: data.radiusMeters,
        requests,
        limitPerRequest,
      }),
      `${CLOUDFLARE_POI_BASE_URL}/poi/nearby`,
    );
  },
);

/**
 * KAN-346 — proxy for POST /coverage/request. Records demand for an
 * uncovered area and answers this location's coverage; never returns
 * `building` until KAN-354's extraction worker exists (see cloudflare/src/
 * index.ts). Own tighter rate limit — unlike the two read-only proxies
 * above, an unknown-municipality call makes the Worker do a server-side
 * Nominatim reverse-geocode, not just a D1 read.
 */
export const cloudflareRequestCoverageProxy = onCall(
  {
    secrets: [cloudflarePoiApiKey],
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: CLOUDFLARE_POI_PROXY_MAX_INSTANCES,
  },
  async (request) => {
    assertAuthenticated(request.auth);
    const data = request.data as RequestCoverageInput;
    assertCoordinate(data?.lat, data?.lng);
    await enforceUserRateLimit(request.auth!.uid, 'requestCoverage', CLOUDFLARE_REQUEST_COVERAGE_RATE_LIMIT_MAX_REQUESTS);

    const response = await postWithTimeout(`${CLOUDFLARE_POI_BASE_URL}/coverage/request`, { lat: data.lat, lng: data.lng });
    return requireOkJsonFrom(response, `${CLOUDFLARE_POI_BASE_URL}/coverage/request`);
  },
);
