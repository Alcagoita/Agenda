/**
 * Manual Jest mock for habitatCache.ts (KAN-228).
 *
 * proximity.ts fire-and-forgets into this module, which pulls in
 * expo-sqlite (ESM, breaks Jest's transform). Every test file that
 * transitively imports proximity.ts but isn't testing the habitat cache
 * itself should `jest.mock('.../services/habitatCache')` with no factory —
 * Jest picks up this file automatically — instead of redefining the same
 * stub inline.
 */

export const recordLiveResult = jest.fn();
export const refreshHabitatCacheIfStale = jest.fn().mockResolvedValue(undefined);
export const upsertPlace = jest.fn().mockReturnValue('hp_mock');
export const upsertTripPlace = jest.fn().mockReturnValue('hp_mock_trip');
export const writeTripAreaPlaces = jest.fn().mockReturnValue(0);
export const queryHabitatCache = jest.fn().mockReturnValue({});
export const getHabitatPlaceById = jest.fn().mockReturnValue(null);
export const findExistingPlaceId = jest.fn().mockReturnValue(null);
export const hasCachedPlaces = jest.fn().mockReturnValue(false);
export const hasCachedPlacesNear = jest.fn().mockReturnValue(false);
export const enforceSizeBudget = jest.fn();
export const deleteTripAreaPlaces = jest.fn();
export const deleteExpiredTripPlaces = jest.fn();
export const estimateHabitatAreaSizeBytes = jest.fn().mockReturnValue(0);
export const __resetHabitatDbForTests = jest.fn();
export const HABITAT_CACHE_STALE_MS = 14 * 24 * 60 * 60 * 1_000;
export const HABITAT_RADIUS_M = 5_000;
export const MAX_CACHED_PLACES = 2_000;
export const HABITAT_BYTES_PER_ROW = 200;
