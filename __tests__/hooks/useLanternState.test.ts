/**
 * useLanternState — KAN-301 review fix: the Lantern's home/outside resolution
 * must not depend on POI tasks existing.
 *
 * When the proximity engine reports no coords (no open POI tasks → it never
 * searches), the hook takes ONE low-accuracy fix of its own, so a user standing
 * in their kitchen with nothing to brush still reads "Home" — never a stuck
 * "Outside".
 */
import { renderHook, act } from '@testing-library/react-native';
import { AppState } from 'react-native';

const mockGetHomeLocation = jest.fn();
const mockDistanceFromHome = jest.fn();
const mockGetPositionLowAccuracy = jest.fn();

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
  useOfflineCoverage: () => ({ offline: false, hasCache: null }),
}));

import { useLanternState } from '../../src/hooks/useLanternState';
import type { PlaceContext } from '../../src/services/proximity';

const HOME = { address: 'home', lat: 38.72, lng: -9.14 };
const COORDS = { lat: 38.72, lng: -9.14 };
const mallCtx = { kind: 'mall', snapshot: { name: 'Colombo' } } as unknown as PlaceContext;

beforeEach(() => {
  jest.clearAllMocks();
});

it('resolves to Home with no POI tasks (coords null) once its own one-shot fix lands (AC1)', async () => {
  mockGetHomeLocation.mockReturnValue(HOME);
  mockDistanceFromHome.mockReturnValue(40); // within 150 m
  mockGetPositionLowAccuracy.mockResolvedValue({ lat: 38.72, lng: -9.14 });

  const { result } = renderHook(() => useLanternState(null, null, true));

  // Before the fix lands: held, not Outside.
  expect(result.current).toEqual({ kind: 'locating' });

  await act(async () => {}); // flush the one-shot getPositionLowAccuracy

  expect(result.current).toEqual({ kind: 'home' });
  expect(mockGetPositionLowAccuracy).toHaveBeenCalledTimes(1); // one read, no watcher
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

it('uses engine coords directly when present (no one-shot needed)', async () => {
  mockGetHomeLocation.mockReturnValue(HOME);
  mockDistanceFromHome.mockReturnValue(4000); // away
  const { result } = renderHook(() => useLanternState(null, { lat: 1, lng: 2 }, true));
  await act(async () => {});
  expect(result.current.kind).toBe('outside');
  expect(mockGetPositionLowAccuracy).not.toHaveBeenCalled();
});

it('keeps Home through a mall/trip override within the leave threshold (KAN-301 review)', async () => {
  mockGetHomeLocation.mockReturnValue(HOME);
  // Start at home (40 m), then 190 m — inside the 200 m leave threshold — for
  // the mall and the following no-context render.
  mockDistanceFromHome.mockReturnValueOnce(40).mockReturnValue(190);

  const { result, rerender } = renderHook(
    ({ ctx }: { ctx: PlaceContext | null }) => useLanternState(ctx, COORDS, true),
    { initialProps: { ctx: null as PlaceContext | null } },
  );
  await act(async () => {});
  expect(result.current.kind).toBe('home'); // 40 m → Home, buffer now true

  await act(async () => { rerender({ ctx: mallCtx }); }); // enter mall at 190 m
  expect(result.current.kind).toBe('mall');

  await act(async () => { rerender({ ctx: null }); });     // leave mall, still 190 m
  // Still inside the 200 m leave threshold → the home buffer must have survived
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
