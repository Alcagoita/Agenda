/**
 * KAN-342 — Overpass retry/backoff behaviour (fetchOverpass, internal to
 * osmPlaces.ts, exercised here through searchOsmPlacesStrict).
 *
 * Covers:
 *   - a transient failure (5xx) is retried on the same endpoint with
 *     exponential backoff (500ms, 1000ms, ...) before succeeding
 *   - a 429 stops immediately — no retry, no trying the next endpoint
 *   - a non-retryable 4xx (e.g. 400) moves straight to the next endpoint,
 *     no backoff wait
 */

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

jest.mock('../../src/services/placesFunctions', () => ({
  searchNearbyPlacesProxy: jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  getPlaceDetailsProxy:    jest.fn(),
}));

jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedCity: jest.fn(),
  putCachedCity: jest.fn(),
}));

import { searchOsmPlacesStrict, OverpassRateLimitedError } from '../../src/services/osmPlaces';

const ORIGIN = { lat: 0, lng: 0 };

function okResponse(elements: unknown[] = []) {
  return { ok: true, status: 200, json: async () => ({ elements }) };
}

function statusResponse(status: number) {
  return { ok: false, status, json: async () => ({}) };
}

beforeEach(() => {
  mockFetch.mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

it('AC: retries a transient 5xx on the same endpoint with exponential backoff, then succeeds', async () => {
  mockFetch
    .mockResolvedValueOnce(statusResponse(503))
    .mockResolvedValueOnce(statusResponse(503))
    .mockResolvedValueOnce(okResponse());

  const promise = searchOsmPlacesStrict(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000, 60_000);

  // 1st attempt fails immediately (mocked fetch resolves synchronously).
  await Promise.resolve();
  await Promise.resolve();
  expect(mockFetch).toHaveBeenCalledTimes(1);

  // Backoff before retry 1: RETRY_BACKOFF_BASE_MS * 2^0 = 500ms.
  await jest.advanceTimersByTimeAsync(500);
  expect(mockFetch).toHaveBeenCalledTimes(2);

  // Backoff before retry 2: RETRY_BACKOFF_BASE_MS * 2^1 = 1000ms.
  await jest.advanceTimersByTimeAsync(1000);
  expect(mockFetch).toHaveBeenCalledTimes(3);

  const result = await promise;
  expect(result.atm).toEqual([]);
  // Same endpoint (first in OVERPASS_ENDPOINTS) for all 3 attempts — a
  // retryable failure retries the SAME endpoint before moving on, not the
  // other way round.
  expect(mockFetch.mock.calls[0][0]).toBe(mockFetch.mock.calls[1][0]);
  expect(mockFetch.mock.calls[0][0]).toBe(mockFetch.mock.calls[2][0]);
});

it('AC: a 429 stops immediately — no retry, no second endpoint tried', async () => {
  mockFetch.mockResolvedValueOnce(statusResponse(429));

  await expect(
    searchOsmPlacesStrict(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000, 60_000),
  ).rejects.toBeInstanceOf(OverpassRateLimitedError);

  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it('a non-retryable 4xx moves to the next endpoint without a backoff wait', async () => {
  mockFetch
    .mockResolvedValueOnce(statusResponse(400))
    .mockResolvedValueOnce(okResponse());

  const result = await searchOsmPlacesStrict(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000, 60_000);

  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(mockFetch.mock.calls[0][0]).not.toBe(mockFetch.mock.calls[1][0]);
  expect(result.atm).toEqual([]);
});
