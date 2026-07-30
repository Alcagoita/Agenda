/**
 * KAN-257 — useWhereWeveBeen hook tests.
 *
 * Covers:
 *   - groupTripsByYear: pure grouping/sorting logic
 *   - refresh(): fetches trips, keeps only past + non-off-grid, loading true → false
 *   - forgetTrip(): deletes the Firestore doc + habitat cache rows, removes it locally
 *   - a failure in either degrades safely (logs, doesn't throw)
 */

const mockGetAuth = jest.fn((): { currentUser: { uid: string } | null } => ({ currentUser: { uid: 'test-uid' } }));
jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => mockGetAuth(),
}));
jest.mock('@react-native-firebase/auth', () => ({}));

const mockGetTrips = jest.fn();
const mockDeleteTrip = jest.fn();
jest.mock('../../src/services/firestore', () => ({
  getTrips: (...args: unknown[]) => mockGetTrips(...args),
  deleteTrip: (...args: unknown[]) => mockDeleteTrip(...args),
}));

const mockDeleteTripAreaPlaces = jest.fn();
jest.mock('../../src/services/habitatCache', () => ({
  deleteTripAreaPlaces: (...args: unknown[]) => mockDeleteTripAreaPlaces(...args),
}));

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useWhereWeveBeen, groupTripsByYear } from '../../src/hooks/useWhereWeveBeen';
import type { Trip } from '../../src/types';

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-1', destination: 'Faro, Portugal', placeRef: 'place-abc',
    centerLat: 1, centerLng: 2, areaRadius: 15_000,
    cacheAreaId: 'ta_1', expiresAt: 1_800_000_000_000,
    startDate: '2025-05-01', endDate: '2025-05-10',
    createdAt: { toDate: () => new Date() } as unknown as Trip['createdAt'],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date(2026, 5, 16)); // local calendar day, not UTC midnight
  mockGetAuth.mockReturnValue({ currentUser: { uid: 'test-uid' } });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('groupTripsByYear', () => {
  it('groups trips by the year of their endDate', () => {
    const groups = groupTripsByYear([
      makeTrip({ id: 't1', endDate: '2025-05-10' }),
      makeTrip({ id: 't2', endDate: '2024-11-20' }),
    ]);
    expect(groups.map(g => g.year)).toEqual(['2025', '2024']);
  });

  it('orders years most-recent-first', () => {
    const groups = groupTripsByYear([
      makeTrip({ id: 't1', endDate: '2023-01-01' }),
      makeTrip({ id: 't2', endDate: '2025-01-01' }),
      makeTrip({ id: 't3', endDate: '2024-01-01' }),
    ]);
    expect(groups.map(g => g.year)).toEqual(['2025', '2024', '2023']);
  });

  it('orders trips within a year most-recent-first', () => {
    const groups = groupTripsByYear([
      makeTrip({ id: 't1', endDate: '2025-02-01' }),
      makeTrip({ id: 't2', endDate: '2025-08-01' }),
      makeTrip({ id: 't3', endDate: '2025-05-01' }),
    ]);
    expect(groups[0].trips.map(t => t.id)).toEqual(['t2', 't3', 't1']);
  });

  it('drops trips with no endDate — nothing to group them by', () => {
    const groups = groupTripsByYear([
      makeTrip({ id: 't1', endDate: '2025-05-10' }),
      makeTrip({ id: 't2', endDate: undefined }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].trips.map(t => t.id)).toEqual(['t1']);
  });

  it('returns an empty array for an empty input', () => {
    expect(groupTripsByYear([])).toEqual([]);
  });
});

describe('useWhereWeveBeen — refresh (initial load)', () => {
  it('keeps a past, non-off-grid trip and stops loading', async () => {
    mockGetTrips.mockResolvedValue([makeTrip({ endDate: '2026-05-01' })]);

    const { result } = renderHook(() => useWhereWeveBeen());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.yearGroups).toHaveLength(1);
    expect(result.current.yearGroups[0].trips).toHaveLength(1);
  });

  it('excludes a trip whose dates are still in the future', async () => {
    mockGetTrips.mockResolvedValue([makeTrip({ startDate: '2026-07-01', endDate: '2026-07-10' })]);

    const { result } = renderHook(() => useWhereWeveBeen());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.yearGroups).toEqual([]);
  });

  it('excludes an off-grid trip even if its (nonexistent) dates would otherwise qualify', async () => {
    mockGetTrips.mockResolvedValue([makeTrip({ kind: 'offgrid', startDate: undefined, endDate: undefined })]);

    const { result } = renderHook(() => useWhereWeveBeen());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.yearGroups).toEqual([]);
  });

  it('excludes a trip whose endDate is today (not yet past)', async () => {
    mockGetTrips.mockResolvedValue([makeTrip({ startDate: '2026-06-10', endDate: '2026-06-16' })]);

    const { result } = renderHook(() => useWhereWeveBeen());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.yearGroups).toEqual([]);
  });

  it('degrades safely (empty state, loading false) when the fetch fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetTrips.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useWhereWeveBeen());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.yearGroups).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith('[useWhereWeveBeen] refresh failed', expect.any(Error));
    warnSpy.mockRestore();
  });

  it('no-ops instead of fetching with an empty uid (auth not ready / signed out)', async () => {
    mockGetAuth.mockReturnValue({ currentUser: null });

    const { result } = renderHook(() => useWhereWeveBeen());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockGetTrips).not.toHaveBeenCalled();
    expect(result.current.yearGroups).toEqual([]);
  });
});

describe('useWhereWeveBeen — forgetTrip', () => {
  it('deletes the Firestore doc + habitat cache rows, and removes it locally', async () => {
    const trip = makeTrip({ endDate: '2026-05-01' });
    mockGetTrips.mockResolvedValue([trip]);

    const { result } = renderHook(() => useWhereWeveBeen());
    await waitFor(() => expect(result.current.yearGroups).toHaveLength(1));

    await act(async () => { await result.current.forgetTrip(trip); });

    expect(mockDeleteTrip).toHaveBeenCalledWith('test-uid', 'trip-1');
    expect(mockDeleteTripAreaPlaces).toHaveBeenCalledWith('ta_1');
    expect(result.current.yearGroups).toEqual([]);
  });

  it('does not throw when the delete fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const trip = makeTrip({ endDate: '2026-05-01' });
    mockGetTrips.mockResolvedValue([trip]);
    mockDeleteTrip.mockRejectedValueOnce(new Error('offline'));

    const { result } = renderHook(() => useWhereWeveBeen());
    await waitFor(() => expect(result.current.yearGroups).toHaveLength(1));

    // Await the call INSIDE act so the (now one-hop-deeper) forgetTrip →
    // forgetTripAction → deleteTrip rejection fully flushes before we assert.
    await act(async () => {
      await expect(result.current.forgetTrip(trip)).resolves.toBeUndefined();
    });

    expect(warnSpy).toHaveBeenCalledWith('[useWhereWeveBeen] forgetTrip failed', expect.any(Error));
    warnSpy.mockRestore();
  });

  it('no-ops instead of calling deleteTrip with an empty uid (auth not ready / signed out)', async () => {
    mockGetAuth.mockReturnValue({ currentUser: null });
    const trip = makeTrip({ endDate: '2026-05-01' });

    const { result } = renderHook(() => useWhereWeveBeen());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.forgetTrip(trip); });

    expect(mockDeleteTrip).not.toHaveBeenCalled();
    expect(mockDeleteTripAreaPlaces).not.toHaveBeenCalled();
  });
});
