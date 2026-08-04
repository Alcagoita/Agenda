/**
 * KAN-285 — runProximitySearchOrReuseSnapshot: don't re-hit the Places API
 * (or even the offline habitat cache) on an automatic/incidental proximity
 * check — screen mount, app reopen, a same-type task added — when neither
 * of the two things that would make a persisted snapshot wrong has
 * happened: the position hasn't moved more than 500m from the snapshot's
 * origin, and the set of open POI-task types is unchanged.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch:            jest.fn(() => Promise.resolve({ isConnected: true })),
    addEventListener: jest.fn(() => jest.fn()),
  },
}));

// proximity.ts fire-and-forgets into the habitat cache, which pulls in
// expo-sqlite (ESM, breaks Jest's transform). Not under test here.
jest.mock('../../src/services/habitatCache');

const mockSaveProximitySnapshot = jest.fn();
const mockLoadProximitySnapshot = jest.fn().mockReturnValue(null);
jest.mock('../../src/services/proximitySnapshot', () => ({
  saveProximitySnapshot: (...args: unknown[]) => mockSaveProximitySnapshot(...args),
  loadProximitySnapshot: (...args: unknown[]) => mockLoadProximitySnapshot(...args),
}));

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
  // Flat-earth approximation, same simplification used elsewhere in this
  // suite (e.g. oneTripForAll.test.ts) — plenty accurate at these small
  // test distances, and avoids pulling in the real maps.ts (which drags
  // in placesFunctions.ts -> @react-native-firebase/functions).
  getDistanceMeters: (lat1: number, lng1: number, lat2: number, lng2: number) =>
    Math.round(Math.hypot(lat2 - lat1, lng2 - lng1) * 111_000),
  searchNearbyPlaces: (...args: unknown[]) => mockSearchNearbyPlaces(...args),
  placeTypeLabel: jest.fn((t: string) => t),
  isPoiSearchDegraded: jest.fn(() => true),
}));

jest.mock('@notifee/react-native', () => ({
  default: { createChannel: jest.fn(), displayNotification: jest.fn() },
  AndroidImportance: { HIGH: 4 },
}));

jest.mock('../../src/services/firestore', () => ({
  markAllPoiAlertsSeen: jest.fn().mockResolvedValue(undefined),
  markExitPromptSeen: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/notifications', () => ({
  fireExitPrompt: jest.fn(),
}));

jest.mock('../../src/native/WearNotificationModule', () => null);

jest.mock('../../src/utils/date', () => ({
  todayISO: jest.fn(() => '2026-07-17'),
}));

import { runProximitySearchOrReuseSnapshot, resetProximityState } from '../../src/services/proximity';
import { Task } from '../../src/types';

// ~5m and ~600m north of ORIGIN (same latitude-degree math used elsewhere in this suite).
const ORIGIN       = { lat: 38.7, lng: -9.1 };
const NEARBY_POS    = makePosition(38.70005, -9.1);
const FAR_POS        = makePosition(38.7054, -9.1);

function makePosition(lat: number, lng: number) {
  return { coords: { latitude: lat, longitude: lng, accuracy: 20 }, timestamp: 1_700_000_000 };
}

function makeTask(id: string, poi: string): Task {
  return {
    id,
    title: `Task ${id}`,
    category: 'errands',
    done: false,
    date: '2026-07-17',
    poi: poi as Task['poi'],
    createdAt: { seconds: 0, nanoseconds: 0 } as unknown as Task['createdAt'],
  };
}

function makeSnapshot(overrides: Partial<{
  lat: number; lng: number; poiTypesKey: string;
}> = {}) {
  return {
    lat: ORIGIN.lat, lng: ORIGIN.lng, poiTypesKey: 'pharmacy',
    nearbyPoiType: 'pharmacy',
    nearbyPlace: { placeId: 'p1', name: 'Cached Pharmacy', lat: ORIGIN.lat, lng: ORIGIN.lng, distanceMeters: 50 },
    poiPlaces: { pharmacy: [{ placeId: 'p1', name: 'Cached Pharmacy', lat: ORIGIN.lat, lng: ORIGIN.lng, distanceMeters: 50 }] },
    ...overrides,
  };
}

describe('runProximitySearchOrReuseSnapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetProximityState();
    mockGetCurrentPositionAsync.mockResolvedValue(NEARBY_POS);
    mockSearchNearbyPlaces.mockResolvedValue({ results: {}, source: 'osm' });
  });

  it('reuses the snapshot (no Places API call) when position and POI types are unchanged', async () => {
    mockLoadProximitySnapshot.mockReturnValue(makeSnapshot());

    await runProximitySearchOrReuseSnapshot('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate);

    expect(mockSearchNearbyPlaces).not.toHaveBeenCalled();
    expect(mockOnUpdate).toHaveBeenCalledWith(
      'pharmacy',
      expect.objectContaining({ placeId: 'p1' }),
      expect.objectContaining({ pharmacy: expect.any(Array) }),
    );
  });

  it('falls through to a real search when the position moved more than 500m', async () => {
    mockGetCurrentPositionAsync.mockResolvedValue(FAR_POS);
    mockLoadProximitySnapshot.mockReturnValue(makeSnapshot());
    mockSearchNearbyPlaces.mockResolvedValue({
      results: { pharmacy: [{ placeId: 'p2', name: 'Live Pharmacy', lat: 38.7054, lng: -9.1, distanceMeters: 30 }] },
      source: 'osm',
    });

    await runProximitySearchOrReuseSnapshot('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate);

    expect(mockSearchNearbyPlaces).toHaveBeenCalledTimes(1);
  });

  it('falls through to a real search when the POI type set changed', async () => {
    mockLoadProximitySnapshot.mockReturnValue(makeSnapshot({ poiTypesKey: 'atm' }));

    await runProximitySearchOrReuseSnapshot('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate);

    expect(mockSearchNearbyPlaces).toHaveBeenCalledTimes(1);
  });

  it('falls through to a real search when no snapshot has ever been saved, and saves one after', async () => {
    mockLoadProximitySnapshot.mockReturnValue(null);
    mockSearchNearbyPlaces.mockResolvedValue({
      results: { pharmacy: [{ placeId: 'p3', name: 'Fresh Pharmacy', lat: ORIGIN.lat, lng: ORIGIN.lng, distanceMeters: 50 }] },
      source: 'osm',
    });

    await runProximitySearchOrReuseSnapshot('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate);

    expect(mockSearchNearbyPlaces).toHaveBeenCalledTimes(1);
    expect(mockSaveProximitySnapshot).toHaveBeenCalledWith('uid-1', expect.objectContaining({
      poiTypesKey: 'pharmacy',
      nearbyPoiType: 'pharmacy',
    }));
  });

  it('never checks the snapshot or fetches a position when there are no open POI tasks', async () => {
    await runProximitySearchOrReuseSnapshot('uid-1', [], mockOnUpdate);

    expect(mockLoadProximitySnapshot).not.toHaveBeenCalled();
    expect(mockGetCurrentPositionAsync).not.toHaveBeenCalled();
    expect(mockOnUpdate).toHaveBeenCalledWith(null, null, {});
  });

  it('recomputes distances against the CURRENT position when reusing a snapshot, not the stale stored ones', async () => {
    // Snapshot origin === place location: was hero (0m). Move ~150m away —
    // still within the 500m reuse radius (so the API call is still skipped),
    // but 150m crosses HERO_RADIUS_M (100m): the place must demote to grey,
    // not keep replaying its stale 0m/hero status from capture time.
    mockGetCurrentPositionAsync.mockResolvedValue(makePosition(38.7 + 150 / 111_000, -9.1));
    mockLoadProximitySnapshot.mockReturnValue(makeSnapshot({
      // Overriding the default fixture's place/nearbyPlace directly since
      // makeSnapshot's overrides param only covers lat/lng/poiTypesKey.
    }));

    await runProximitySearchOrReuseSnapshot('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate);

    expect(mockSearchNearbyPlaces).not.toHaveBeenCalled();
    const [heroType, heroPlace, allPlaces] = mockOnUpdate.mock.calls[0];
    expect(heroType).toBeNull(); // demoted — no longer within HERO_RADIUS_M
    expect(heroPlace).toBeNull();
    expect(allPlaces.pharmacy[0].placeId).toBe('p1'); // still nearby (grey), just not hero
    expect(allPlaces.pharmacy[0].distanceMeters).toBeGreaterThanOrEqual(100);
    expect(allPlaces.pharmacy[0].distanceMeters).toBeLessThan(400);
  });

  it('promotes a snapshot place into hero when the CURRENT position is closer than the stored distance', async () => {
    // Snapshot captured the place at 300m (grey, not hero). Reusing it from
    // 50m away must promote it to hero — the opposite direction of the
    // demotion case above, same underlying bug (replaying stale distances).
    mockGetCurrentPositionAsync.mockResolvedValue(makePosition(38.7 + 50 / 111_000, -9.1));
    mockLoadProximitySnapshot.mockReturnValue({
      lat: ORIGIN.lat, lng: ORIGIN.lng, poiTypesKey: 'pharmacy',
      nearbyPoiType: null,
      nearbyPlace: null,
      poiPlaces: { pharmacy: [{ placeId: 'p1', name: 'Cached Pharmacy', lat: ORIGIN.lat, lng: ORIGIN.lng, distanceMeters: 300 }] },
    });

    await runProximitySearchOrReuseSnapshot('uid-1', [makeTask('t1', 'pharmacy')], mockOnUpdate);

    expect(mockSearchNearbyPlaces).not.toHaveBeenCalled();
    const [heroType, heroPlace] = mockOnUpdate.mock.calls[0];
    expect(heroType).toBe('pharmacy');
    expect(heroPlace?.placeId).toBe('p1');
    expect(heroPlace?.distanceMeters).toBeLessThan(100);
  });
});
