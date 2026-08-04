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

interface CoverageInput {
  lat: number;
  lng: number;
}

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

async function requireOkJson<T>(url: string): Promise<T> {
  const response = await fetchWithTimeout(url);
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

async function enforceUserRateLimit(uid: string, action: string): Promise<void> {
  const db = getFirestore();
  const docRef = db.collection('_cloudflarePoiProxyRateLimits').doc(`${uid}:${action}`);
  const now = Date.now();

  await db.runTransaction(async transaction => {
    const snap = await transaction.get(docRef);
    const current = snap.data() as Omit<RateLimitDoc, 'updatedAt'> | undefined;
    const withinWindow = current != null && now - current.windowStartedAt < CLOUDFLARE_POI_RATE_LIMIT_WINDOW_MS;
    const nextCount = withinWindow ? current.requestCount + 1 : 1;

    if (withinWindow && current.requestCount >= CLOUDFLARE_POI_RATE_LIMIT_MAX_REQUESTS) {
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
