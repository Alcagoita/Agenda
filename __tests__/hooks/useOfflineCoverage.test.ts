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
jest.mock('../../src/services/habitatCache', () => ({
  hasCachedPlaces: () => mockHasCachedPlaces(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockHasCachedPlaces.mockReturnValue(true);
});

describe('useOfflineCoverage', () => {
  it('reports online, never checking the habitat cache', async () => {
    mockUseNetInfo.mockReturnValue({ isConnected: true, isInternetReachable: true });

    const { result } = renderHook(() => useOfflineCoverage());

    expect(result.current).toEqual({ offline: false, hasCache: null });
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
