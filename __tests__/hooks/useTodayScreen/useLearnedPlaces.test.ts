/**
 * KAN-230 / KAN-240 — useLearnedPlaces: one-shot fetch of the per-place visit
 * counters + compute of the learned-place ranking, with a manual refresh()
 * for after a completion.
 *
 * Also covers the request-token guard: a uid change clears the ranking
 * immediately and discards whatever the previous uid's in-flight fetch
 * later resolves with — otherwise a shared device could briefly show one
 * account's learned places under a different signed-in account.
 */

const mockGetLearnedPlaceCounts = jest.fn();
const mockGetTaughtPlaces = jest.fn();

jest.mock('../../../src/services/firestore', () => ({
  getLearnedPlaceCounts: (...args: unknown[]) => mockGetLearnedPlaceCounts(...args),
  getTaughtPlaces: (...args: unknown[]) => mockGetTaughtPlaces(...args),
}));

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useLearnedPlaces } from '../../../src/hooks/useTodayScreen/useLearnedPlaces';
import type { LearnedPlacesState } from '../../../src/hooks/useTodayScreen/useLearnedPlaces';
import type { LearnedPlace } from '../../../src/services/learnedPlaces';

function count(placeId: string, name: string, poiType: string, visitCount: number): LearnedPlace {
  return { placeId, name, poiType, visitCount };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTaughtPlaces.mockResolvedValue([]);
});

describe('useLearnedPlaces', () => {
  it('returns an empty ranking when uid is undefined', async () => {
    const { result } = renderHook(() => useLearnedPlaces(undefined));
    await waitFor(() => expect(result.current.learnedPlaces).toEqual([]));
    expect(mockGetLearnedPlaceCounts).not.toHaveBeenCalled();
  });

  it('fetches and computes the ranking on mount for a given uid', async () => {
    mockGetLearnedPlaceCounts.mockResolvedValue([count('hp_1', 'Corner ATM', 'atm', 3)]);

    const { result } = renderHook(() => useLearnedPlaces('uid-1'));

    await waitFor(() => expect(result.current.learnedPlaces).toHaveLength(1));
    expect(result.current.learnedPlaces[0]).toEqual({
      name: 'Corner ATM', poiType: 'atm', visitCount: 3,
    });
    expect(mockGetLearnedPlaceCounts).toHaveBeenCalledWith('uid-1');
    expect(mockGetTaughtPlaces).toHaveBeenCalledWith('uid-1');
  });

  it('puts taught favourites before brush-learned places in the ranking feed', async () => {
    mockGetLearnedPlaceCounts.mockResolvedValue([count('hp_1', 'Random Sushi', 'restaurant', 3)]);
    mockGetTaughtPlaces.mockResolvedValue([
      { id: 'fav', poiType: 'restaurant', name: '__food_type__:sushi', createdAt: { toMillis: () => 1 } },
    ]);

    const { result } = renderHook(() => useLearnedPlaces('uid-1'));

    await waitFor(() => expect(result.current.learnedPlaces).toHaveLength(2));
    expect(result.current.learnedPlaces[0]).toEqual({
      poiType: 'restaurant',
      name: '__food_type__:sushi',
      visitCount: Number.MAX_SAFE_INTEGER,
    });
  });

  it('refresh() re-fetches and recomputes the ranking', async () => {
    mockGetLearnedPlaceCounts.mockResolvedValue([]);
    const { result } = renderHook(() => useLearnedPlaces('uid-1'));
    await waitFor(() => expect(mockGetLearnedPlaceCounts).toHaveBeenCalledTimes(1));
    expect(result.current.learnedPlaces).toEqual([]);

    mockGetLearnedPlaceCounts.mockResolvedValue([count('hp_1', 'Corner ATM', 'atm', 3)]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.learnedPlaces).toHaveLength(1);
    expect(mockGetLearnedPlaceCounts).toHaveBeenCalledTimes(2);
  });

  it('does not throw and logs a warning when the fetch fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetLearnedPlaceCounts.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useLearnedPlaces('uid-1'));

    await waitFor(() => expect(warnSpy).toHaveBeenCalledWith('[useLearnedPlaces] refresh failed', expect.any(Error)));
    expect(result.current.learnedPlaces).toEqual([]);
    warnSpy.mockRestore();
  });

  it('discards a stale in-flight fetch from the previous uid after uid changes', async () => {
    let resolveFirstFetch!: (counts: LearnedPlace[]) => void;
    mockGetLearnedPlaceCounts.mockImplementationOnce(
      () => new Promise<LearnedPlace[]>(resolve => { resolveFirstFetch = resolve; }),
    );

    const { result, rerender } = renderHook<LearnedPlacesState, { uid: string }>(
      ({ uid }) => useLearnedPlaces(uid),
      { initialProps: { uid: 'uid-A' } },
    );
    await waitFor(() => expect(mockGetLearnedPlaceCounts).toHaveBeenCalledWith('uid-A'));

    // Switch accounts before uid-A's fetch resolves — the ranking must
    // clear immediately, not keep showing uid-A's (still empty) state.
    mockGetLearnedPlaceCounts.mockResolvedValueOnce([count('hp_b', 'Uid B Cafe', 'cafe', 3)]);
    rerender({ uid: 'uid-B' });
    await waitFor(() => expect(result.current.learnedPlaces).toHaveLength(1));
    expect(result.current.learnedPlaces[0].name).toBe('Uid B Cafe');

    // uid-A's fetch finally resolves — must be ignored, not overwrite uid-B's ranking.
    resolveFirstFetch([count('hp_a', 'Uid A ATM', 'atm', 3)]);
    await act(async () => { await Promise.resolve(); });

    expect(result.current.learnedPlaces).toHaveLength(1);
    expect(result.current.learnedPlaces[0].name).toBe('Uid B Cafe');
  });

  it('ignores an overlapping refresh() response that resolves out of order', async () => {
    let resolveFirst!: (counts: LearnedPlace[]) => void;
    mockGetLearnedPlaceCounts.mockResolvedValueOnce([]); // initial mount fetch
    const { result } = renderHook(() => useLearnedPlaces('uid-1'));
    await waitFor(() => expect(mockGetLearnedPlaceCounts).toHaveBeenCalledTimes(1));

    // First manual refresh — left pending.
    mockGetLearnedPlaceCounts.mockImplementationOnce(
      () => new Promise<LearnedPlace[]>(resolve => { resolveFirst = resolve; }),
    );
    const firstRefresh = result.current.refresh();

    // Second manual refresh — resolves immediately, should win.
    mockGetLearnedPlaceCounts.mockResolvedValueOnce([count('hp_new', 'New Place', 'atm', 3)]);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.learnedPlaces[0]?.name).toBe('New Place');

    // The first (older) refresh finally resolves — must not overwrite the newer result.
    resolveFirst([count('hp_old', 'Old Place', 'cafe', 3)]);
    await act(async () => { await firstRefresh; });

    expect(result.current.learnedPlaces[0]?.name).toBe('New Place');
  });
});
