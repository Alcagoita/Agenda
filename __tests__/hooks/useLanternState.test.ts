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
jest.mock('../../src/services/geolocation', () => ({
  getPositionLowAccuracy: () => mockGetPositionLowAccuracy(),
}));
// maps pulls in firebase via placesFunctions; we never need a city here.
jest.mock('../../src/services/maps', () => ({ reverseGeocode: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/hooks/useOfflineCoverage', () => ({
  useOfflineCoverage: () => mockOfflineCoverage,
}));
// proximity is imported for its PlaceContext type only (erased at runtime), but
// mocking it keeps firebase/notifee out of this file's graph regardless.
jest.mock('../../src/services/proximity', () => ({}));

import { useLanternState, LOCATING_MIN_MS, LOCATING_CEILING_MS } from '../../src/hooks/useLanternState';
import type { PlaceContext } from '../../src/services/proximity';

const HOME = { address: 'home', lat: 38.72, lng: -9.14 };
const COORDS = { lat: 38.72, lng: -9.14 };
const mallCtx = { kind: 'mall', snapshot: { name: 'Colombo' } } as unknown as PlaceContext;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockOfflineCoverage = { offline: false, hasCache: null };
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

it('falls through to unavailable after the ceiling when no fix arrives', async () => {
  mockGetHomeLocation.mockReturnValue(HOME);
  mockGetPositionLowAccuracy.mockReturnValue(new Promise(() => {})); // never resolves

  const { result } = renderHook(() => useLanternState(null, null, true));
  expect(result.current).toEqual({ kind: 'locating' });

  await act(async () => { jest.advanceTimersByTime(LOCATING_CEILING_MS); });
  expect(result.current).toEqual({ kind: 'unavailable' });
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
