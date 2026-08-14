/**
 * useLanternState — KAN-301.
 *
 * Covers the POI-independent one-shot position seed, foreground re-seed, the
 * home hysteresis surviving a mall/trip override, and the locating→unavailable
 * timing (min-visible floor, ceiling, never-regress).
 */
import { renderHook, act } from '@testing-library/react-native';
import { AppState } from 'react-native';

const mockGetHomeLocation = jest.fn();
const mockDistanceFromHome = jest.fn();
const mockGetPositionLowAccuracy = jest.fn();
/** What useOfflineCoverage reports. */
let mockOfflineCoverage: { offline: boolean; hasCache: boolean | null } = { offline: false, hasCache: null };

jest.mock('../../src/services/home', () => ({
  getHomeLocation:  () => mockGetHomeLocation(),
  distanceFromHome: (...a: unknown[]) => mockDistanceFromHome(...a),
}));
const mockGetLastKnownPosition = jest.fn().mockResolvedValue(null);
jest.mock('../../src/services/geolocation', () => ({
  getPositionLowAccuracy: () => mockGetPositionLowAccuracy(),
  getLastKnownPosition:   () => mockGetLastKnownPosition(),
}));
// maps pulls in firebase via placesFunctions.
const mockReverseGeocode = jest.fn().mockResolvedValue(null);
jest.mock('../../src/services/maps', () => ({ reverseGeocode: (...a: unknown[]) => mockReverseGeocode(...a) }));
jest.mock('../../src/hooks/useOfflineCoverage', () => ({
  useOfflineCoverage: () => mockOfflineCoverage,
}));
// proximity is imported for its PlaceContext type only (erased at runtime), but
// mocking it keeps firebase/notifee out of this file's graph regardless.
jest.mock('../../src/services/proximity', () => ({ NEARBY_RADIUS: 400 }));
const mockGetCachedAreaName = jest.fn<string | null, [number, number, number?]>(() => null);
jest.mock('../../src/services/habitatCache', () => ({
  getCachedAreaName: (lat: number, lng: number, radius?: number) => mockGetCachedAreaName(lat, lng, radius),
}));

import {
  useLanternState,
  LOCATING_MIN_MS,
  LOCATING_CEILING_MS,
  LOCATING_CEILING_OFFLINE_MS,
  FIX_RETRY_MS,
} from '../../src/hooks/useLanternState';
import type { PlaceContext } from '../../src/services/proximity';

const HOME = { address: 'home', lat: 38.72, lng: -9.14 };
const COORDS = { lat: 38.72, lng: -9.14 };
const mallCtx = { kind: 'mall', snapshot: { name: 'Colombo' } } as unknown as PlaceContext;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockOfflineCoverage = { offline: false, hasCache: null };
  mockGetCachedAreaName.mockReturnValue(null);
  mockReverseGeocode.mockResolvedValue(null);
  mockGetLastKnownPosition.mockResolvedValue(null);
});
afterEach(() => {
  jest.useRealTimers();
});

it('resolves to Home with no POI tasks (coords null) once its own one-shot fix lands (AC1)', async () => {
  mockGetHomeLocation.mockReturnValue(HOME);
  mockDistanceFromHome.mockReturnValue(40); // within 150 m
  mockGetPositionLowAccuracy.mockResolvedValue({ lat: 38.72, lng: -9.14 });

  const { result } = renderHook(() => useLanternState(null, null, true));
  expect(result.current).toEqual({ kind: 'locating' }); // before the fix: held, not Outside

  await act(async () => {});                                   // one-shot resolves
  await act(async () => { jest.advanceTimersByTime(LOCATING_MIN_MS); }); // clear the floor

  expect(result.current).toEqual({ kind: 'home' });
  expect(mockGetPositionLowAccuracy).toHaveBeenCalledTimes(1); // one read, no watcher
});

it('holds locating for the min-visible floor even when the fix is fast (no flash)', async () => {
  mockGetHomeLocation.mockReturnValue(HOME);
  mockDistanceFromHome.mockReturnValue(40);
  let resolveFix: (c: { lat: number; lng: number }) => void = () => {};
  mockGetPositionLowAccuracy.mockReturnValue(new Promise(r => { resolveFix = r; }));

  const { result } = renderHook(() => useLanternState(null, null, true));
  expect(result.current.kind).toBe('locating');

  await act(async () => { resolveFix({ lat: 38.72, lng: -9.14 }); }); // fast fix
  expect(result.current.kind).toBe('locating');                       // floor still holds

  await act(async () => { jest.advanceTimersByTime(LOCATING_MIN_MS); });
  expect(result.current.kind).toBe('home');
});

describe('"Can\'t find you" means we gave up, never "still trying" (KAN-377 AC3)', () => {
  it('a slow fix is never called a failure — a pending call holds locating indefinitely', async () => {
    // The KAN-377 bug: offline, a cold GPS fix routinely outlives the old 10 s
    // timer, so the app claimed it couldn't find a user it was about to find.
    mockGetHomeLocation.mockReturnValue(HOME);
    mockGetPositionLowAccuracy.mockReturnValue(new Promise(() => {})); // still looking

    const { result } = renderHook(() => useLanternState(null, null, true));
    expect(result.current).toEqual({ kind: 'locating' });

    await act(async () => { jest.advanceTimersByTime(LOCATING_CEILING_MS * 10); });
    expect(result.current).toEqual({ kind: 'locating' });
  });

  it('admits it only once the position call actually failed, past the budget', async () => {
    mockGetHomeLocation.mockReturnValue(HOME);
    mockGetPositionLowAccuracy.mockRejectedValue(new Error('no fix'));

    const { result } = renderHook(() => useLanternState(null, null, true));
    await act(async () => {});
    expect(result.current).toEqual({ kind: 'locating' }); // failed, but still within budget

    await act(async () => { jest.advanceTimersByTime(LOCATING_CEILING_MS); });
    expect(result.current).toEqual({ kind: 'unavailable' });
  });

  it('offline gets the longer budget — the online ceiling alone never triggers it', async () => {
    mockOfflineCoverage = { offline: true, hasCache: true };
    mockGetHomeLocation.mockReturnValue(HOME);
    mockGetPositionLowAccuracy.mockRejectedValue(new Error('no fix'));

    const { result } = renderHook(() => useLanternState(null, null, true));
    await act(async () => {});

    await act(async () => { jest.advanceTimersByTime(LOCATING_CEILING_MS * 2); });
    expect(result.current).toEqual({ kind: 'locating' });

    await act(async () => { jest.advanceTimersByTime(LOCATING_CEILING_OFFLINE_MS); });
    expect(result.current).toEqual({ kind: 'unavailable' });
  });

  it('retries after a rejection instead of giving up silently, and recovers', async () => {
    // Before KAN-377 one rejection ended the seed for good: the effect's deps
    // could not change without a fix, so nothing ever asked again.
    mockGetHomeLocation.mockReturnValue(HOME);
    mockDistanceFromHome.mockReturnValue(40);
    mockGetPositionLowAccuracy
      .mockRejectedValueOnce(new Error('no fix'))
      .mockRejectedValueOnce(new Error('no fix'))
      .mockResolvedValue({ lat: 38.72, lng: -9.14 });

    const { result } = renderHook(() => useLanternState(null, null, true));
    await act(async () => {});
    expect(mockGetPositionLowAccuracy).toHaveBeenCalledTimes(1);

    await act(async () => { jest.advanceTimersByTime(FIX_RETRY_MS); });
    expect(mockGetPositionLowAccuracy).toHaveBeenCalledTimes(2);

    await act(async () => { jest.advanceTimersByTime(FIX_RETRY_MS); });
    await act(async () => { jest.advanceTimersByTime(LOCATING_MIN_MS); });

    expect(mockGetPositionLowAccuracy).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual({ kind: 'home' }); // recovered, no "Can't find you"
  });
});

describe('the cached OS fix answers first (KAN-377)', () => {
  it('resolves immediately from the cached fix while the live one is still acquiring', async () => {
    // Offline this is the difference between a minute of "Looking around…" and
    // the Lantern being right straight away.
    mockGetHomeLocation.mockReturnValue(HOME);
    mockDistanceFromHome.mockReturnValue(40);
    mockGetLastKnownPosition.mockResolvedValue({ lat: 38.72, lng: -9.14 });
    mockGetPositionLowAccuracy.mockReturnValue(new Promise(() => {})); // still acquiring

    const { result } = renderHook(() => useLanternState(null, null, true));
    await act(async () => {});
    await act(async () => { jest.advanceTimersByTime(LOCATING_MIN_MS); });

    expect(result.current).toEqual({ kind: 'home' });
  });

  it('a later live fix replaces the cached one — the head start does not cancel the race', async () => {
    // Regression: seeding from the cached fix used to change the seed effect's
    // dependencies, which tore down the live request still in flight. The app
    // then kept a five-minute-old position and never took the fresh one.
    mockGetHomeLocation.mockReturnValue(HOME);
    mockDistanceFromHome.mockReturnValue(40);
    mockGetLastKnownPosition.mockResolvedValue({ lat: 1, lng: 1 });
    let resolveLive: (c: { lat: number; lng: number }) => void = () => {};
    mockGetPositionLowAccuracy.mockReturnValue(new Promise(r => { resolveLive = r; }));

    renderHook(() => useLanternState(null, null, true));
    await act(async () => {});
    expect(mockDistanceFromHome).toHaveBeenLastCalledWith({ lat: 1, lng: 1 }); // cached first

    await act(async () => { resolveLive({ lat: 2, lng: 2 }); });
    await act(async () => { jest.advanceTimersByTime(LOCATING_MIN_MS); });

    expect(mockDistanceFromHome).toHaveBeenLastCalledWith({ lat: 2, lng: 2 }); // live wins
  });

  it('never overrides a live fix with the cached one', async () => {
    mockGetHomeLocation.mockReturnValue(HOME);
    mockDistanceFromHome.mockReturnValue(40);
    // The cached fix resolves after the live one — it must not clobber it.
    let releaseCached: (v: unknown) => void = () => {};
    mockGetLastKnownPosition.mockReturnValue(new Promise(r => { releaseCached = r; }));
    mockGetPositionLowAccuracy.mockResolvedValue({ lat: 10, lng: 10 });

    const { result } = renderHook(() => useLanternState(null, null, true));
    await act(async () => {});
    await act(async () => { releaseCached({ lat: 99, lng: 99 }); });
    await act(async () => { jest.advanceTimersByTime(LOCATING_MIN_MS); });

    expect(mockDistanceFromHome).toHaveBeenLastCalledWith({ lat: 10, lng: 10 });
    expect(result.current).toEqual({ kind: 'home' });
  });
});

describe('naming the area from stored places (KAN-377 AC5/AC6)', () => {
  const AWAY = { lat: 41.15, lng: -8.61 };

  const renderOutside = () => {
    mockGetHomeLocation.mockReturnValue(HOME);
    mockDistanceFromHome.mockReturnValue(4000); // Outside
    return renderHook(() => useLanternState(null, AWAY, true));
  };

  it('names the area offline from the settlement stored with the cached POIs', async () => {
    // The KAN-377 case: POI coverage is kilometres wide, so the name should be
    // too — not just the ~100 m cells the user stood in while online.
    mockOfflineCoverage = { offline: true, hasCache: true };
    mockGetCachedAreaName.mockReturnValue('Porto');

    const { result } = renderOutside();
    await act(async () => {});

    expect(result.current).toEqual({ kind: 'outside', cityName: 'Porto' });
    expect(mockGetCachedAreaName).toHaveBeenCalledWith(AWAY.lat, AWAY.lng, 400);
  });

  it('adds no geocoding call offline — the fallback is a local read (AC6)', async () => {
    mockOfflineCoverage = { offline: true, hasCache: true };
    mockGetCachedAreaName.mockReturnValue('Porto');

    renderOutside();
    await act(async () => {});

    expect(mockReverseGeocode).not.toHaveBeenCalled();
  });

  it('falls back to the stored name when a live geocode comes back empty', async () => {
    mockReverseGeocode.mockResolvedValue(null);
    mockGetCachedAreaName.mockReturnValue('Porto');

    const { result } = renderOutside();
    await act(async () => {});

    expect(result.current).toEqual({ kind: 'outside', cityName: 'Porto' });
  });

  it('prefers the live geocode when it answers — the stored name is the fallback, not the source', async () => {
    mockReverseGeocode.mockResolvedValue('Matosinhos');
    mockGetCachedAreaName.mockReturnValue('Porto');

    const { result } = renderOutside();
    await act(async () => {});

    expect(result.current).toEqual({ kind: 'outside', cityName: 'Matosinhos' });
    expect(mockGetCachedAreaName).not.toHaveBeenCalled();
  });

  it('still reads "Outside" when nothing can name the area', async () => {
    mockOfflineCoverage = { offline: true, hasCache: true };
    mockGetCachedAreaName.mockReturnValue(null);

    const { result } = renderOutside();
    await act(async () => {});

    expect(result.current).toEqual({ kind: 'outside', cityName: null });
  });
});

it('never regresses to locating once a real state has resolved', async () => {
  mockGetHomeLocation.mockReturnValue(HOME);
  mockDistanceFromHome.mockReturnValue(40);
  const { result, rerender } = renderHook(
    ({ c }: { c: typeof COORDS | null }) => useLanternState(null, c, true),
    { initialProps: { c: COORDS as typeof COORDS | null } },
  );
  await act(async () => {});
  expect(result.current.kind).toBe('home');

  // Engine coords disappear (a later tick with no fix) — must hold Home, not blink to locating.
  mockGetPositionLowAccuracy.mockReturnValue(new Promise(() => {}));
  await act(async () => { rerender({ c: null }); });
  expect(result.current.kind).toBe('home');
});

it('uses engine coords directly when present — warm start never shows locating (AC)', async () => {
  mockGetHomeLocation.mockReturnValue(HOME);
  mockDistanceFromHome.mockReturnValue(4000); // away
  const { result } = renderHook(() => useLanternState(null, { lat: 1, lng: 2 }, true));
  expect(result.current.kind).toBe('outside'); // real from the first render, no locating
  await act(async () => {});
  expect(result.current.kind).toBe('outside');
  expect(mockGetPositionLowAccuracy).not.toHaveBeenCalled();
});

it('does not read a position when permission is not granted — stays locating', async () => {
  mockGetHomeLocation.mockReturnValue(HOME);
  const { result } = renderHook(() => useLanternState(null, null, false));
  await act(async () => {});
  expect(result.current).toEqual({ kind: 'locating' });
  expect(mockGetPositionLowAccuracy).not.toHaveBeenCalled();
});

it('shows unset when no home is stored, without needing a fix', async () => {
  mockGetHomeLocation.mockReturnValue(null);
  const { result } = renderHook(() => useLanternState(null, null, true));
  await act(async () => {});
  expect(result.current).toEqual({ kind: 'unset' });
});

it('keeps Home through a mall/trip override within the leave threshold (KAN-301 review)', async () => {
  mockGetHomeLocation.mockReturnValue(HOME);
  // Start at home (40 m), then 1150 m — inside the 1200 m leave threshold —
  // for the mall and the following no-context render.
  mockDistanceFromHome.mockReturnValueOnce(40).mockReturnValue(1150);

  const { result, rerender } = renderHook(
    ({ ctx }: { ctx: PlaceContext | null }) => useLanternState(ctx, COORDS, true),
    { initialProps: { ctx: null as PlaceContext | null } },
  );
  await act(async () => {});
  expect(result.current.kind).toBe('home'); // 40 m → Home, buffer now true

  await act(async () => { rerender({ ctx: mallCtx }); }); // enter mall at 1150 m
  expect(result.current.kind).toBe('mall');

  await act(async () => { rerender({ ctx: null }); });     // leave mall, still 1150 m
  // Still inside the 1200 m leave threshold → the home buffer must have survived
  // the mall override, so we read Home, not Outside.
  expect(result.current.kind).toBe('home');
});

describe('foreground re-seed (KAN-301 review)', () => {
  it('re-reads position on background→active with no POI coords — exactly one more call', async () => {
    mockGetHomeLocation.mockReturnValue(HOME);
    mockDistanceFromHome.mockReturnValue(40);
    mockGetPositionLowAccuracy.mockResolvedValue({ lat: 38.72, lng: -9.14 });

    let appStateHandler: ((s: string) => void) | undefined;
    const addSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, cb: (s: string) => void) => {
      appStateHandler = cb;
      return { remove: jest.fn() };
    }) as never);

    renderHook(() => useLanternState(null, null, true));
    await act(async () => {}); // mount one-shot
    expect(mockGetPositionLowAccuracy).toHaveBeenCalledTimes(1);

    await act(async () => { appStateHandler?.('active'); }); // foreground
    expect(mockGetPositionLowAccuracy).toHaveBeenCalledTimes(2);

    addSpy.mockRestore();
  });

  it('does not re-read on foreground when engine coords are present', async () => {
    mockGetHomeLocation.mockReturnValue(HOME);
    mockDistanceFromHome.mockReturnValue(40);

    let appStateHandler: ((s: string) => void) | undefined;
    const addSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, cb: (s: string) => void) => {
      appStateHandler = cb;
      return { remove: jest.fn() };
    }) as never);

    renderHook(() => useLanternState(null, { lat: 1, lng: 2 }, true));
    await act(async () => {});
    await act(async () => { appStateHandler?.('active'); });
    expect(mockGetPositionLowAccuracy).not.toHaveBeenCalled();

    addSpy.mockRestore();
  });
});
