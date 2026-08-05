/**
 * KAN-234 — usePlacesIKnow hook tests.
 *
 * Covers:
 *   - refresh(): fetches trips + custom categories, computes habitat size,
 *     loading true → false
 *   - refreshTrip(): calls refreshTripArea, re-fetches, tracks refreshingTripId
 *   - deleteTrip(): deletes the Firestore doc + the habitat cache rows for
 *     that trip's cacheAreaId, removes it from local state
 *   - a failure in any of the three degrades safely (logs, doesn't throw)
 */

// A mutable mock (not a fixed arrow) so individual tests can override via
// mockGetAuth.mockReturnValueOnce(...) to exercise the no-uid guard (e.g.
// auth not ready yet, or the user signed out while this screen is mounted).
const mockGetAuth = jest.fn((): { currentUser: { uid: string } | null } => ({ currentUser: { uid: 'test-uid' } }));
jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => mockGetAuth(),
}));
jest.mock('@react-native-firebase/auth', () => ({}));

const mockGetTrips = jest.fn();
const mockDeleteTrip = jest.fn();
const mockGetCategories = jest.fn().mockResolvedValue([]);
jest.mock('../../src/services/firestore', () => ({
  getTrips: (...args: unknown[]) => mockGetTrips(...args),
  deleteTrip: (...args: unknown[]) => mockDeleteTrip(...args),
  getCategories: (...args: unknown[]) => mockGetCategories(...args),
}));

const mockEstimateHabitatAreaSizeBytes = jest.fn().mockReturnValue(0);
const mockDeleteTripAreaPlaces = jest.fn();
jest.mock('../../src/services/habitatCache', () => ({
  estimateHabitatAreaSizeBytes: (...args: unknown[]) => mockEstimateHabitatAreaSizeBytes(...args),
  deleteTripAreaPlaces: (...args: unknown[]) => mockDeleteTripAreaPlaces(...args),
}));

const mockRefreshTripArea = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/tripDownload', () => ({
  refreshTripArea: (...args: unknown[]) => mockRefreshTripArea(...args),
}));

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { usePlacesIKnow } from '../../src/hooks/usePlacesIKnow';
import type { Trip } from '../../src/types';

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-1', destination: 'Faro, Portugal', placeRef: 'place-abc',
    centerLat: 1, centerLng: 2, areaRadius: 15_000,
    cacheAreaId: 'ta_1', expiresAt: 1_800_000_000_000,
    createdAt: { toDate: () => new Date() } as unknown as Trip['createdAt'],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCategories.mockResolvedValue([]);
  mockEstimateHabitatAreaSizeBytes.mockReturnValue(0);
  // clearAllMocks() clears call history but not a persistent mockReturnValue
  // override from a prior test — restore the default explicitly so tests
  // that override this (the no-uid guard tests below) don't leak into others.
  mockGetAuth.mockReturnValue({ currentUser: { uid: 'test-uid' } });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('refresh (initial load)', () => {
  it('fetches trips + habitat size, then stops loading', async () => {
    mockGetTrips.mockResolvedValue([makeTrip()]);
    mockEstimateHabitatAreaSizeBytes.mockReturnValue(50_000);

    const { result } = renderHook(() => usePlacesIKnow());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.trips).toHaveLength(1);
    expect(result.current.habitatSizeBytes).toBe(50_000);
  });

  it('excludes expired trips from the list (data already purged elsewhere — nothing left to refresh/delete)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10'));
    const active  = makeTrip({ id: 'trip-active',  expiresAt: new Date('2026-08-01').getTime() });
    const expired = makeTrip({ id: 'trip-expired', expiresAt: new Date('2026-07-01').getTime() });
    mockGetTrips.mockResolvedValue([active, expired]);

    const { result } = renderHook(() => usePlacesIKnow());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.trips.map(t => t.id)).toEqual(['trip-active']);
  });

  it('degrades safely (empty state, loading false) when the fetch fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetTrips.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => usePlacesIKnow());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.trips).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith('[usePlacesIKnow] refresh failed', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('refreshTrip', () => {
  it('calls refreshTripArea, tracks refreshingTripId, and re-fetches on completion', async () => {
    const trip = makeTrip();
    mockGetTrips.mockResolvedValue([trip]);

    const { result } = renderHook(() => usePlacesIKnow());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let refreshPromise!: Promise<void>;
    act(() => { refreshPromise = result.current.refreshTrip(trip); });
    expect(result.current.refreshingTripId).toBe('trip-1');

    await act(async () => { await refreshPromise; });

    expect(mockRefreshTripArea).toHaveBeenCalledWith('test-uid', trip);
    expect(result.current.refreshingTripId).toBeNull();
    expect(mockGetTrips).toHaveBeenCalledTimes(2); // initial load + post-refresh re-fetch
  });

  it('clears refreshingTripId even when refreshTripArea fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const trip = makeTrip();
    mockGetTrips.mockResolvedValue([trip]);
    mockRefreshTripArea.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => usePlacesIKnow());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.refreshTrip(trip); });

    expect(result.current.refreshingTripId).toBeNull();
    warnSpy.mockRestore();
  });

  it('no-ops instead of calling refreshTripArea with an empty uid (KAN-234 review fix — auth not ready / signed out)', async () => {
    mockGetAuth.mockReturnValue({ currentUser: null });
    const trip = makeTrip();

    const { result } = renderHook(() => usePlacesIKnow());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.refreshTrip(trip); });

    expect(mockRefreshTripArea).not.toHaveBeenCalled();
    expect(result.current.refreshingTripId).toBeNull();
  });
});

describe('deleteTrip', () => {
  it('deletes the Firestore doc + habitat cache rows, and removes it locally', async () => {
    const trip = makeTrip();
    mockGetTrips.mockResolvedValue([trip]);

    const { result } = renderHook(() => usePlacesIKnow());
    await waitFor(() => expect(result.current.trips).toHaveLength(1));

    await act(async () => { await result.current.deleteTrip(trip); });

    expect(mockDeleteTrip).toHaveBeenCalledWith('test-uid', 'trip-1');
    expect(mockDeleteTripAreaPlaces).toHaveBeenCalledWith('ta_1');
    expect(result.current.trips).toHaveLength(0);
  });

  it('does not throw when the delete fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const trip = makeTrip();
    mockGetTrips.mockResolvedValue([trip]);
    mockDeleteTrip.mockRejectedValueOnce(new Error('offline'));

    const { result } = renderHook(() => usePlacesIKnow());
    await waitFor(() => expect(result.current.trips).toHaveLength(1));

    await expect(act(async () => { await result.current.deleteTrip(trip); })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith('[usePlacesIKnow] deleteTrip failed', expect.any(Error));
    warnSpy.mockRestore();
  });

  it('no-ops instead of calling deleteTrip with an empty uid (KAN-234 review fix — auth not ready / signed out)', async () => {
    mockGetAuth.mockReturnValue({ currentUser: null });
    const trip = makeTrip();

    const { result } = renderHook(() => usePlacesIKnow());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.deleteTrip(trip); });

    expect(mockDeleteTrip).not.toHaveBeenCalled();
    expect(mockDeleteTripAreaPlaces).not.toHaveBeenCalled();
  });
});
