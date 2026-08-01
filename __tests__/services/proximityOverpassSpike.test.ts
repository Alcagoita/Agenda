/**
 * KAN-322 — Overpass vs Google live nearby search comparison spike.
 *
 * Covers runProximitySearch's shadow dual-run:
 *   - fires searchNearbyPlacesOsm alongside a successful live Google search
 *   - logs a per-type comparison (counts, top result, heroMatch heuristic)
 *   - heroMatch true when both sources' nearest result are within 30m
 *   - heroMatch false when they're far apart or one source has no result
 *   - never awaited by the live search path — onUpdate fires before the
 *     Overpass call resolves, and a slow/failing Overpass call never affects
 *     the real result
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch:            jest.fn(() => Promise.resolve({ isConnected: true })),
    addEventListener: jest.fn(() => jest.fn()),
  },
}));

jest.mock('../../src/services/habitatCache');
jest.mock('../../src/services/proximitySnapshot');

const mockGetCurrentPositionAsync = jest.fn();
const mockOnUpdate = jest.fn();

jest.mock('expo-location', () => ({
  Accuracy: { High: 4, Balanced: 3, Low: 2 },
  requestForegroundPermissionsAsync: jest.fn(),
  requestBackgroundPermissionsAsync: jest.fn(),
  watchPositionAsync: jest.fn(),
  stopGeofencingAsync: jest.fn().mockResolvedValue(undefined),
  getCurrentPositionAsync: (...args: unknown[]) => mockGetCurrentPositionAsync(...args),
}));

jest.mock('react-native', () => ({
  Alert:              { alert: jest.fn() },
  Linking:            { openSettings: jest.fn() },
  Platform:           { OS: 'android' },
  InteractionManager: { runAfterInteractions: (cb: () => void) => cb() },
}));

const mockSearchNearbyPlaces = jest.fn();
jest.mock('../../src/services/maps', () => ({
  getDistanceMeters: (lat1: number, lng1: number, lat2: number, lng2: number) => {
    // Simple, deterministic, good enough for the 30m heroMatch threshold —
    // 1 degree ~ 111_195m, matches maps.ts's own constant.
    const dLat = (lat2 - lat1) * 111_195;
    const dLng = (lng2 - lng1) * 111_195;
    return Math.sqrt(dLat * dLat + dLng * dLng);
  },
  searchNearbyPlaces: (...args: unknown[]) => mockSearchNearbyPlaces(...args),
  placeTypeLabel: jest.fn((t: string) => t),
}));

const mockSearchNearbyPlacesOsm = jest.fn();
jest.mock('../../src/services/osmPlaces', () => ({
  searchNearbyPlacesOsm: (...args: unknown[]) => mockSearchNearbyPlacesOsm(...args),
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: { createChannel: jest.fn(), displayNotification: jest.fn() },
  AndroidImportance: { HIGH: 4 },
}));

jest.mock('../../src/services/firestore', () => ({
  markAllPoiAlertsSeen: jest.fn().mockResolvedValue(undefined),
  markExitPromptSeen:   jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/notifications', () => ({
  fireExitPrompt: jest.fn(),
}));

jest.mock('../../src/native/WearNotificationModule', () => null);

jest.mock('../../src/utils/date', () => ({
  todayISO: jest.fn(() => '2026-06-27'),
}));

import { runProximitySearch, resetProximityState } from '../../src/services/proximity';
import { Task } from '../../src/types';

const makePosition = (lat: number, lng: number) => ({
  coords: { latitude: lat, longitude: lng, accuracy: 20 },
  timestamp: 1_700_000_000,
});

const makeTask = (id: string, poi: string): Task => ({
  id,
  title: `Task ${id}`,
  category: 'errands',
  done: false,
  date: '2026-06-27',
  poi: poi as Task['poi'],
  createdAt: { seconds: 0, nanoseconds: 0 } as unknown as Task['createdAt'],
});

const makePlace = (placeId: string, name: string, lat: number, lng: number, distanceMeters: number) => ({
  placeId, name, lat, lng, distanceMeters,
});

const makeOsmPlace = (osmId: string, name: string, lat: number, lng: number, distanceMeters: number) => ({
  osmId, name, isGenericName: false, lat, lng, distanceMeters, footprintAreaM2: 0,
});

/** Flushes the fire-and-forget spike's promise chain without relying on timers. */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('KAN-322 Overpass comparison spike', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    resetProximityState();
    mockGetCurrentPositionAsync.mockResolvedValue(makePosition(38.7, -9.1));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('does not block onUpdate — fires before the Overpass call resolves', async () => {
    mockSearchNearbyPlaces.mockResolvedValue({ pharmacy: [makePlace('ph1', 'Walgreens', 38.7, -9.1, 90)] });
    let resolveOsm: (v: unknown) => void = () => {};
    mockSearchNearbyPlacesOsm.mockReturnValue(new Promise(resolve => { resolveOsm = resolve; }));

    await runProximitySearch('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate);

    expect(mockOnUpdate).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled(); // Overpass still pending

    resolveOsm({ pharmacy: [] });
    await flushMicrotasks();
    expect(logSpy).toHaveBeenCalled();
  });

  it('logs heroMatch: true when both sources agree within 30m', async () => {
    mockSearchNearbyPlaces.mockResolvedValue({ pharmacy: [makePlace('ph1', 'Walgreens', 38.7, -9.1, 90)] });
    mockSearchNearbyPlacesOsm.mockResolvedValue({
      pharmacy: [makeOsmPlace('node/1', 'Walgreens', 38.70015, -9.1, 90)], // ~16.7m away
    });

    await runProximitySearch('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate);
    await flushMicrotasks();

    const [, payload] = logSpy.mock.calls.find(call => call[0] === '[KAN-322 spike] nearby search comparison')!;
    expect(payload.perType[0]).toMatchObject({ poiType: 'pharmacy', heroMatch: true });
    expect(payload.retried).toBe(false);
    expect(mockSearchNearbyPlacesOsm).toHaveBeenCalledTimes(1); // non-empty first attempt — no retry needed
  });

  it('retries once when the first attempt returns empty across every type (KAN-322 review — likely a timeout, not a real empty area)', async () => {
    mockSearchNearbyPlaces.mockResolvedValue({ pharmacy: [makePlace('ph1', 'Walgreens', 38.7, -9.1, 90)] });
    mockSearchNearbyPlacesOsm
      .mockResolvedValueOnce({ pharmacy: [] })
      .mockResolvedValueOnce({ pharmacy: [makeOsmPlace('node/1', 'Walgreens', 38.70015, -9.1, 90)] });

    await runProximitySearch('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate);
    await flushMicrotasks();

    expect(mockSearchNearbyPlacesOsm).toHaveBeenCalledTimes(2);
    const [, payload] = logSpy.mock.calls.find(call => call[0] === '[KAN-322 spike] nearby search comparison')!;
    expect(payload.retried).toBe(true);
    expect(payload.perType[0]).toMatchObject({ poiType: 'pharmacy', osmCount: 1, heroMatch: true });
  });

  it('does not retry when at least one requested type already has a result', async () => {
    mockSearchNearbyPlaces.mockResolvedValue({
      pharmacy: [makePlace('ph1', 'Walgreens', 38.7, -9.1, 90)],
      atm:      [makePlace('a1', 'Chase ATM', 38.7, -9.1, 50)],
    });
    mockSearchNearbyPlacesOsm.mockResolvedValue({
      pharmacy: [makeOsmPlace('node/1', 'Walgreens', 38.70015, -9.1, 90)],
      atm:      [], // this one type is empty, but pharmacy isn't — no retry
    });

    await runProximitySearch('uid-1', [makeTask('t1', 'pharmacy'), makeTask('t2', 'atm')], mockOnUpdate);
    await flushMicrotasks();

    expect(mockSearchNearbyPlacesOsm).toHaveBeenCalledTimes(1);
  });

  it('logs heroMatch: false when the sources disagree by more than 30m', async () => {
    mockSearchNearbyPlaces.mockResolvedValue({ pharmacy: [makePlace('ph1', 'Walgreens', 38.7, -9.1, 90)] });
    mockSearchNearbyPlacesOsm.mockResolvedValue({
      pharmacy: [makeOsmPlace('node/1', 'Some Other Pharmacy', 38.705, -9.1, 90)], // ~557m away
    });

    await runProximitySearch('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate);
    await flushMicrotasks();

    const [, payload] = logSpy.mock.calls.find(call => call[0] === '[KAN-322 spike] nearby search comparison')!;
    expect(payload.perType[0]).toMatchObject({ poiType: 'pharmacy', heroMatch: false });
  });

  it('logs heroMatch: false when Overpass has no result even after retrying', async () => {
    mockSearchNearbyPlaces.mockResolvedValue({ pharmacy: [makePlace('ph1', 'Walgreens', 38.7, -9.1, 90)] });
    mockSearchNearbyPlacesOsm.mockResolvedValue({ pharmacy: [] }); // both attempts empty

    await runProximitySearch('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate);
    await flushMicrotasks();

    expect(mockSearchNearbyPlacesOsm).toHaveBeenCalledTimes(2);
    const [, payload] = logSpy.mock.calls.find(call => call[0] === '[KAN-322 spike] nearby search comparison')!;
    expect(payload.retried).toBe(true);
    expect(payload.perType[0]).toMatchObject({ poiType: 'pharmacy', osmCount: 0, heroMatch: false });
  });

  it('does not fire the spike when the live search itself fails (falls back to cache)', async () => {
    mockSearchNearbyPlaces.mockRejectedValue(new Error('network down'));

    await runProximitySearch('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate);
    await flushMicrotasks();

    expect(mockSearchNearbyPlacesOsm).not.toHaveBeenCalled();
  });

  it('never throws or surfaces when the Overpass shadow call itself fails', async () => {
    mockSearchNearbyPlaces.mockResolvedValue({ pharmacy: [makePlace('ph1', 'Walgreens', 38.7, -9.1, 90)] });
    mockSearchNearbyPlacesOsm.mockRejectedValue(new Error('overpass down'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runProximitySearch('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate)).resolves.not.toThrow();
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith('[proximity] KAN-322 Overpass comparison spike failed', expect.any(Error));
    warnSpy.mockRestore();
  });
});
