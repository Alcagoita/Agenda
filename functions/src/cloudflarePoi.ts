import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore } from 'firebase-admin/firestore';

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

interface PoiAllInput {
  lat: number;
  lng: number;
  radiusMeters: number;
}

interface RateLimitDoc {
  windowStartedAt: number;
  requestCount: number;
  updatedAt: Date;
}

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
    await enforceUserRateLimit(request.auth!.uid, 'poiAll');

    return requireOkJson(
      `${CLOUDFLARE_POI_BASE_URL}/poi/all?lat=${encodeURIComponent(data.lat)}&lng=${encodeURIComponent(data.lng)}&radius=${encodeURIComponent(data.radiusMeters)}`,
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
