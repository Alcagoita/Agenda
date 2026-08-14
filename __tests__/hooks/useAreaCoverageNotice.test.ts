/**
 * useAreaCoverageNotice — KAN-349.
 *
 * The line promises a fix, so these tests are mostly about the loop that keeps
 * it: the server's own backoff, foreground, manual refresh, and — the one that
 * must NOT exist — location updates.
 */
import { renderHook, act } from '@testing-library/react-native';
import { AppState } from 'react-native';

const mockCheckAreaCoverage = jest.fn();
const mockPoiSearchState = jest.fn<{ source: 'cloudflare' | 'osm' | 'cache' | null }, []>(
  () => ({ source: 'osm' }),
);

jest.mock('../../src/services/maps', () => ({
  checkAreaCoverage: (...a: unknown[]) => mockCheckAreaCoverage(...a),
}));
jest.mock('../../src/services/proximity', () => ({
  getLastPoiSearchState: () => mockPoiSearchState(),
}));

import { useAreaCoverageNotice, RETRY_FALLBACK_MS } from '../../src/hooks/useAreaCoverageNotice';

const HERE = { lat: 38.72, lng: -9.14 };

/**
 * AppState is spied for the whole file, never restored per-test. mockRestore()
 * does NOT give this RN preset's AppState.addEventListener back: after a
 * restore it returns undefined, so the next hook that subscribes crashes on
 * cleanup. Installing one spy for every test avoids the trap entirely.
 */
let appStateHandler: ((s: string) => void) | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  appStateHandler = undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, cb: (s: string) => void) => {
    appStateHandler = cb;
    return { remove: jest.fn() };
  }) as never);
  mockPoiSearchState.mockReturnValue({ source: 'osm' });
  mockCheckAreaCoverage.mockResolvedValue({ coverageStatus: 'building', retryAfterSeconds: 30 });
});
afterEach(() => { jest.useRealTimers(); });

const renderNotice = (refresh = jest.fn().mockResolvedValue(true)) => ({
  refresh,
  ...renderHook(() => useAreaCoverageNotice(HERE, refresh)),
});

it('shows the building line once the server says the area is being prepared (AC1)', async () => {
  const { result } = renderNotice();
  await act(async () => {});
  expect(result.current.notice).toBe('building');
});

it('shows the degraded line when we are on the fallback source for any other reason', async () => {
  mockCheckAreaCoverage.mockResolvedValue({ coverageStatus: 'none' });
  const { result } = renderNotice();
  await act(async () => {});
  expect(result.current.notice).toBe('degraded');
});

it('shows nothing at all when our own API answered (AC2)', async () => {
  mockPoiSearchState.mockReturnValue({ source: 'cloudflare' });
  const { result } = renderNotice();
  await act(async () => {});
  expect(result.current.notice).toBeNull();
  expect(mockCheckAreaCoverage).not.toHaveBeenCalled();
});

describe('the refresh loop (AC6/AC7/AC8)', () => {
  it('re-checks on the server’s retryAfterSeconds, not on a fixed interval', async () => {
    const { result } = renderNotice();
    await act(async () => {});
    expect(mockCheckAreaCoverage).toHaveBeenCalledTimes(1);

    // Nothing at 29 s; the second check lands exactly on the server's 30.
    await act(async () => { jest.advanceTimersByTime(29_000); });
    expect(mockCheckAreaCoverage).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(1_000); });
    expect(mockCheckAreaCoverage).toHaveBeenCalledTimes(2);
    expect(result.current.notice).toBe('building');
  });

  it('keeps re-checking when the answer does not change', async () => {
    // Regression: identical answers must still reschedule. A loop that stops
    // silently leaves the line promising a refresh that is no longer running.
    renderNotice();
    await act(async () => {});
    for (let i = 2; i <= 4; i++) {
      await act(async () => { jest.advanceTimersByTime(30_000); });
      expect(mockCheckAreaCoverage).toHaveBeenCalledTimes(i);
    }
  });

  it('falls back to its own backoff when the server offers no ETA', async () => {
    mockCheckAreaCoverage.mockResolvedValue({ coverageStatus: 'building' });
    renderNotice();
    await act(async () => {});
    await act(async () => { jest.advanceTimersByTime(RETRY_FALLBACK_MS - 1); });
    expect(mockCheckAreaCoverage).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(mockCheckAreaCoverage).toHaveBeenCalledTimes(2);
  });

  it('re-checks on app foreground', async () => {
    renderNotice();
    await act(async () => {});
    expect(mockCheckAreaCoverage).toHaveBeenCalledTimes(1);

    await act(async () => { appStateHandler?.('active'); });
    expect(mockCheckAreaCoverage).toHaveBeenCalledTimes(2);
  });

  it('re-checks on manual refresh', async () => {
    const { result } = renderNotice();
    await act(async () => {});
    await act(async () => { result.current.recheck(); });
    expect(mockCheckAreaCoverage).toHaveBeenCalledTimes(2);
  });

  it('does NOT re-check on ordinary location updates (AC6)', async () => {
    const refresh = jest.fn().mockResolvedValue(true);
    const { rerender } = renderHook(
      ({ c }: { c: { lat: number; lng: number } }) => useAreaCoverageNotice(c, refresh),
      { initialProps: { c: HERE } },
    );
    await act(async () => {});
    expect(mockCheckAreaCoverage).toHaveBeenCalledTimes(1);

    // The proximity engine reports new coords repeatedly as the user walks.
    for (const c of [{ lat: 38.73, lng: -9.15 }, { lat: 38.74, lng: -9.16 }, { lat: 38.75, lng: -9.17 }]) {
      await act(async () => { rerender({ c }); });
    }
    expect(mockCheckAreaCoverage).toHaveBeenCalledTimes(1);
  });

  it('refreshes nearby places and clears the line by itself once coverage is ready (AC7/AC8)', async () => {
    const { result, refresh } = renderNotice();
    await act(async () => {});
    expect(result.current.notice).toBe('building');

    // The area finishes; the next re-check finds it ready.
    mockCheckAreaCoverage.mockResolvedValue({ coverageStatus: 'ready' });
    // That re-run of the search is what makes the user's own radius served —
    // the engine then reports a non-osm source.
    refresh.mockImplementation(async () => {
      mockPoiSearchState.mockReturnValue({ source: 'cloudflare' });
      return true;
    });

    await act(async () => { jest.advanceTimersByTime(30_000); });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.notice).toBeNull();
  });

  it('leaves the line alone when a re-check fails — no twitching on a blip', async () => {
    const { result } = renderNotice();
    await act(async () => {});
    expect(result.current.notice).toBe('building');

    mockCheckAreaCoverage.mockResolvedValue(null); // transport failure
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(result.current.notice).toBe('building');
  });

  it('never runs two checks at once', async () => {
    let resolveCheck: (v: unknown) => void = () => {};
    mockCheckAreaCoverage.mockReturnValue(new Promise(r => { resolveCheck = r; }));

    const { result } = renderNotice();
    await act(async () => {});
    await act(async () => { result.current.recheck(); result.current.recheck(); });
    expect(mockCheckAreaCoverage).toHaveBeenCalledTimes(1);

    await act(async () => { resolveCheck({ coverageStatus: 'building', retryAfterSeconds: 30 }); });
  });
});
