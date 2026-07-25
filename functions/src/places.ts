import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore } from 'firebase-admin/firestore';

const googlePlacesApiKey = defineSecret('GOOGLE_PLACES_API_KEY');

const FETCH_TIMEOUT_MS = 8_000;
const PLACES_NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACES_DETAILS_URL = 'https://places.googleapis.com/v1/places';
const PLACES_PROXY_MAX_INSTANCES = 10;
const PLACES_RATE_LIMIT_WINDOW_MS = 60_000;
const PLACES_RATE_LIMIT_MAX_REQUESTS = 30;

type AutocompleteMode = 'establishment' | 'cities' | 'address';

interface NearbySearchInput {
  lat: number;
  lng: number;
  poiTypes: string[];
  radiusMeters: number;
}

interface PlacesAutocompleteInput {
  query: string;
  mode: AutocompleteMode;
  lat?: number;
  lng?: number;
}

interface PlaceDetailsInput {
  placeId: string;
}

interface PlacesRateLimitDoc {
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

function assertString(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', `"${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpsError('invalid-argument', `"${field}" must not be empty.`);
  }
  if (trimmed.length > maxLen) {
    throw new HttpsError('invalid-argument', `"${field}" exceeds the maximum allowed length.`);
  }
  return trimmed;
}

function getApiKey(): string {
  const apiKey = googlePlacesApiKey.value();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'Google Places API key is not configured.');
  }
  return apiKey;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new HttpsError('unavailable', 'Google Places request failed.');
  } finally {
    clearTimeout(timer);
  }
}

async function requireOkJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetchWithTimeout(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error('[places] Upstream Google Places request failed', {
      url,
      status: response.status,
      body: text.slice(0, 500),
    });
    throw new HttpsError('unavailable', 'Google Places proxy request failed.');
  }
  return (await response.json()) as T;
}

async function enforceUserRateLimit(uid: string, action: string): Promise<void> {
  const db = getFirestore();
  const docRef = db.collection('_placesProxyRateLimits').doc(`${uid}:${action}`);
  const now = Date.now();

  await db.runTransaction(async transaction => {
    const snap = await transaction.get(docRef);
    const current = snap.data() as Omit<PlacesRateLimitDoc, 'updatedAt'> | undefined;
    const withinWindow = current != null && now - current.windowStartedAt < PLACES_RATE_LIMIT_WINDOW_MS;
    const nextCount = withinWindow ? current.requestCount + 1 : 1;

    if (withinWindow && current.requestCount >= PLACES_RATE_LIMIT_MAX_REQUESTS) {
      throw new HttpsError('resource-exhausted', 'Too many Places requests. Please try again soon.');
    }

    transaction.set(docRef, {
      windowStartedAt: withinWindow ? current!.windowStartedAt : now,
      requestCount: nextCount,
      updatedAt: new Date(),
    } satisfies PlacesRateLimitDoc);
  });
}

function buildAutocompleteBody(query: string, mode: AutocompleteMode, lat?: number, lng?: number): Record<string, unknown> {
  const body: Record<string, unknown> = { input: query };
  if (mode === 'establishment') {
    body.includedPrimaryTypes = ['establishment'];
  } else if (mode === 'cities') {
    body.includedPrimaryTypes = ['(cities)'];
  }

  if (lat != null && lng != null) {
    body.locationBias = {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: 50_000,
      },
    };
  }

  return body;
}

export const searchNearbyPlacesProxy = onCall(
  {
    secrets: [googlePlacesApiKey],
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: PLACES_PROXY_MAX_INSTANCES,
  },
  async (request) => {
    assertAuthenticated(request.auth);
    const data = request.data as NearbySearchInput;

    assertCoordinate(data?.lat, data?.lng);
    if (!Array.isArray(data?.poiTypes) || data.poiTypes.length === 0 || data.poiTypes.length > 10) {
      throw new HttpsError('invalid-argument', '"poiTypes" must contain between 1 and 10 entries.');
    }
    const poiTypes = data.poiTypes.map(type => assertString(type, 'poiTypes[]', 100));
    if (!Number.isInteger(data?.radiusMeters) || data.radiusMeters <= 0 || data.radiusMeters > 5_000) {
      throw new HttpsError('invalid-argument', '"radiusMeters" must be an integer between 1 and 5000.');
    }
    await enforceUserRateLimit(request.auth!.uid, 'nearby');

    return requireOkJson(
      PLACES_NEARBY_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': getApiKey(),
          'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.types,places.primaryType',
        },
        body: JSON.stringify({
          locationRestriction: {
            circle: {
              center: { latitude: data.lat, longitude: data.lng },
              radius: data.radiusMeters,
            },
          },
          includedTypes: poiTypes,
          maxResultCount: 20,
          rankPreference: 'DISTANCE',
        }),
      },
    );
  },
);

export const placesAutocompleteProxy = onCall(
  {
    secrets: [googlePlacesApiKey],
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: PLACES_PROXY_MAX_INSTANCES,
  },
  async (request) => {
    assertAuthenticated(request.auth);
    const data = request.data as PlacesAutocompleteInput;
    const query = assertString(data?.query, 'query', 120);
    if (!data?.mode || !['establishment', 'cities', 'address'].includes(data.mode)) {
      throw new HttpsError('invalid-argument', '"mode" must be one of establishment, cities, or address.');
    }
    if ((data.lat == null) !== (data.lng == null)) {
      throw new HttpsError('invalid-argument', '"lat" and "lng" must be provided together.');
    }
    if (data.lat != null && data.lng != null) {
      assertCoordinate(data.lat, data.lng);
    }
    await enforceUserRateLimit(request.auth!.uid, `autocomplete:${data.mode}`);

    return requireOkJson(
      PLACES_AUTOCOMPLETE_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': getApiKey(),
          'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat',
        },
        body: JSON.stringify(buildAutocompleteBody(query, data.mode, data.lat, data.lng)),
      },
    );
  },
);

export const getPlaceDetailsProxy = onCall(
  {
    secrets: [googlePlacesApiKey],
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: PLACES_PROXY_MAX_INSTANCES,
  },
  async (request) => {
    assertAuthenticated(request.auth);
    const data = request.data as PlaceDetailsInput;
    const placeId = assertString(data?.placeId, 'placeId', 200);
    await enforceUserRateLimit(request.auth!.uid, 'details');

    return requireOkJson(
      `${PLACES_DETAILS_URL}/${encodeURIComponent(placeId)}`,
      {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': getApiKey(),
          'X-Goog-FieldMask': 'location,displayName',
        },
      },
    );
  },
);
