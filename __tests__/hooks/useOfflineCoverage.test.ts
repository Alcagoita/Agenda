/**
 * KAN-241 — useOfflineCoverage: shared offline/habitat-coverage detection.
 *
 * Verifies:
 *   - online → { offline: false, hasCache: null }, never checks the cache
 *   - offline + cache has data somewhere → { offline: true, hasCache: true }
 *   - offline + cache empty everywhere → { offline: true, hasCache: false }
 *   - isInternetReachable: false counts as offline even when isConnected is true
 *   - connectivity state not yet known (null) → stays offline: false
 *   - hasCache is null (not false) on the render before the cache check
 *     resolves — callers must not treat "unknown" as "no cache"
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { useOfflineCoverage } from '../../src/hooks/useOfflineCoverage';

const mockUseNetInfo = jest.fn();
jest.mock('@react-native-community/netinfo', () => ({
  useNetInfo: () => mockUseNetInfo(),
}));

const mockHasCachedPlaces = jest.fn();
const mockHasCachedPlacesNear = jest.fn();
jest.mock('../../src/services/habitatCache', () => ({
  hasCachedPlaces: () => mockHasCachedPlaces(),
  hasCachedPlacesNear: (...a: unknown[]) => mockHasCachedPlacesNear(...a),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockHasCachedPlaces.mockReturnValue(true);
  mockHasCachedPlacesNear.mockReturnValue(true);
});

describe('useOfflineCoverage', () => {
  it('reports online, never checking the habitat cache', async () => {
    mockUseNetInfo.mockReturnValue({ isConnected: true, isInternetReachable: true });

    const { result } = renderHook(() => useOfflineCoverage());

    expect(result.current).toEqual({ offline: false, hasCache: null, knowsHere: null });
    expect(mockHasCachedPlaces).not.toHaveBeenCalled();
  });

  it('resets hasCache back to null when connectivity returns (not stale false/true from before)', async () => {
    mockUseNetInfo.mockReturnValue({ isConnected: false, isInternetReachable: false });
    mockHasCachedPlaces.mockReturnValue(true);
    const { result, rerender } = renderHook(() => useOfflineCoverage());
    await waitFor(() => expect(result.current.hasCache).toBe(true));

    mockUseNetInfo.mockReturnValue({ isConnected: true, isInternetReachable: true });
    rerender({});

    expect(result.current.hasCache).toBeNull();
  });

  it('reports offline + hasCache true when the cache has data somewhere', async () => {
    mockUseNetInfo.mockReturnValue({ isConnected: false, isInternetReachable: false });
    mockHasCachedPlaces.mockReturnValue(true);

    const { result } = renderHook(() => useOfflineCoverage());

    await waitFor(() => expect(result.current.hasCache).toBe(true));
    expect(result.current.offline).toBe(true);
  });

  it('reports offline + hasCache false when the cache is empty everywhere', async () => {
    mockUseNetInfo.mockReturnValue({ isConnected: false, isInternetReachable: false });
    mockHasCachedPlaces.mockReturnValue(false);

    const { result } = renderHook(() => useOfflineCoverage());

    await waitFor(() => expect(result.current.offline).toBe(true));
    expect(result.current.hasCache).toBe(false);
  });

  it('treats isInternetReachable: false as offline even when isConnected is true', async () => {
    mockUseNetInfo.mockReturnValue({ isConnected: true, isInternetReachable: false });

    const { result } = renderHook(() => useOfflineCoverage());

    await waitFor(() => expect(result.current.offline).toBe(true));
  });

  it('stays offline: false when connectivity state is not yet known (null)', () => {
    mockUseNetInfo.mockReturnValue({ isConnected: null, isInternetReachable: null });

    const { result } = renderHook(() => useOfflineCoverage());

    expect(result.current.offline).toBe(false);
    expect(mockHasCachedPlaces).not.toHaveBeenCalled();
  });
});

describe('useOfflineCoverage — knowsHere, the per-location probe (KAN-316)', () => {
  const HERE = { lat: 38.72, lng: -9.14 };

  it('answers for the position it was given, within the radius it was given', async () => {
    mockUseNetInfo.mockReturnValue({ isConnected: false, isInternetReachable: false });
    mockHasCachedPlacesNear.mockReturnValue(true);

    const { result } = renderHook(() => useOfflineCoverage(HERE, 400));

    await waitFor(() => expect(result.current.knowsHere).toBe(true));
    expect(mockHasCachedPlacesNear).toHaveBeenCalledWith(HERE.lat, HERE.lng, 400);
  });

  it('false when the cache holds places, but none around here', async () => {
    mockUseNetInfo.mockReturnValue({ isConnected: false, isInternetReachable: false });
    mockHasCachedPlaces.mockReturnValue(true);   // seeded somewhere (Lisbon)
    mockHasCachedPlacesNear.mockReturnValue(false); // but not here (Tokyo)

    const { result } = renderHook(() => useOfflineCoverage(HERE, 400));

    await waitFor(() => expect(result.current.knowsHere).toBe(false));
    expect(result.current.hasCache).toBe(true);
  });

  it('stays null with no position — nothing to answer about', async () => {
    mockUseNetInfo.mockReturnValue({ isConnected: false, isInternetReachable: false });

    const { result } = renderHook(() => useOfflineCoverage(null, 400));

    await waitFor(() => expect(result.current.hasCache).toBe(true));
    expect(result.current.knowsHere).toBeNull();
    expect(mockHasCachedPlacesNear).not.toHaveBeenCalled();
  });

  it('never touches SQLite while online', async () => {
    mockUseNetInfo.mockReturnValue({ isConnected: true, isInternetReachable: true });

    const { result } = renderHook(() => useOfflineCoverage(HERE, 400));

    expect(result.current.knowsHere).toBeNull();
    expect(mockHasCachedPlacesNear).not.toHaveBeenCalled();
  });

  it('re-probes when the position changes, not on every render', async () => {
    mockUseNetInfo.mockReturnValue({ isConnected: false, isInternetReachable: false });

    const { result, rerender } = renderHook(
      ({ c }: { c: { lat: number; lng: number } }) => useOfflineCoverage(c, 400),
      { initialProps: { c: HERE } },
    );
    await waitFor(() => expect(result.current.knowsHere).toBe(true));
    expect(mockHasCachedPlacesNear).toHaveBeenCalledTimes(1);

    // Same coordinates, new object identity → no new query.
    rerender({ c: { ...HERE } });
    expect(mockHasCachedPlacesNear).toHaveBeenCalledTimes(1);

    // Actually moved → one more.
    rerender({ c: { lat: 35.68, lng: 139.76 } });
    await waitFor(() => expect(mockHasCachedPlacesNear).toHaveBeenCalledTimes(2));
  });
});
