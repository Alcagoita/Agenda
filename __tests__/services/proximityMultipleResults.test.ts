/**
 * KAN-199 — Proximity service stores multiple POI results.
 *
 * Confirms that runProximitySearch stores all matching places within
 * NEARBY_RADIUS per POI type (not just the nearest one), so the hero card
 * can offer a "Try another place" button when multiple options exist.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch:            jest.fn(() => Promise.resolve({ isConnected: true })),
    addEventListener: jest.fn(() => jest.fn()),
  },
}));

// KAN-228 — proximity.ts now fire-and-forgets into the habitat cache, which
// pulls in expo-sqlite (ESM, breaks Jest's transform). Not under test here.
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
  getDistanceMeters: jest.fn(() => 0),
  searchNearbyPlaces: (...args: unknown[]) => mockSearchNearbyPlaces(...args),
  placeTypeLabel: jest.fn((t: string) => t),
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
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
  todayISO: jest.fn(() => '2026-06-27'),
}));

import { runProximitySearch, resetProximityState } from '../../src/services/proximity';
import { Task } from '../../src/types';

const makePosition = (lat: number, lng: number) => ({
  coords: { latitude: lat, longitude: lng, accuracy: 20 },
  timestamp: 1_700_000_000,
});

const makeTask = (id: string, poi: string, title: string = `Task ${id}`): Task => ({
  id,
  title,
  category: 'errands',
  done: false,
  date: '2026-06-27',
  poi: poi as Task['poi'],
  createdAt: { seconds: 0, nanoseconds: 0 } as unknown as Task['createdAt'],
});

const makePlace = (placeId: string, name: string, distanceMeters: number) => ({
  placeId,
  name,
  lat: 38.7,
  lng: -9.1,
  distanceMeters,
});

describe('runProximitySearch — multiple results per type', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetProximityState();
    mockGetCurrentPositionAsync.mockResolvedValue(makePosition(38.7, -9.1));
  });

  it('stores all matching places per type (not just nearest)', async () => {
    const pharmacies = [
      makePlace('ph1', 'Walgreens', 90),
      makePlace('ph2', 'CVS', 150),
      makePlace('ph3', 'Rite Aid', 300),
    ];
    mockSearchNearbyPlaces.mockResolvedValue({ pharmacy: pharmacies });

    const tasks = [makeTask('t1', 'pharmacy')];
    await runProximitySearch('uid-1', tasks, mockOnUpdate);

    const [, , allPlaces] = mockOnUpdate.mock.calls[0];
    expect(allPlaces.pharmacy).toHaveLength(3);
    expect(allPlaces.pharmacy[0].placeId).toBe('ph1');
    expect(allPlaces.pharmacy[1].placeId).toBe('ph2');
    expect(allPlaces.pharmacy[2].placeId).toBe('ph3');
  });

  it('hero type still uses nearest place (index 0) for notification/hero detection', async () => {
    const atms = [
      makePlace('atm1', 'Chase ATM', 40),
      makePlace('atm2', 'Wells ATM', 80),
    ];
    mockSearchNearbyPlaces.mockResolvedValue({ atm: atms });

    const tasks = [makeTask('t1', 'atm')];
    await runProximitySearch('uid-1', tasks, mockOnUpdate);

    const [heroType, heroPlace] = mockOnUpdate.mock.calls[0];
    expect(heroType).toBe('atm');
    expect(heroPlace?.placeId).toBe('atm1'); // nearest wins hero
  });

  it('does not store types where nearest place is outside NEARBY_RADIUS (400m)', async () => {
    const farCafe = [makePlace('c1', 'Remote Cafe', 450)];
    mockSearchNearbyPlaces.mockResolvedValue({ cafe: farCafe });

    const tasks = [makeTask('t1', 'cafe')];
    await runProximitySearch('uid-1', tasks, mockOnUpdate);

    const [, , allPlaces] = mockOnUpdate.mock.calls[0];
    expect(allPlaces.cafe).toBeUndefined();
  });

  it('keeps restaurant food-intent tasks matched to the bundled restaurant list', async () => {
    const restaurants = [
      makePlace('r1', 'Portugália', 30),
      makePlace('r2', 'Yakuza by Olivier', 80),
    ];
    mockSearchNearbyPlaces.mockResolvedValue({ restaurant: restaurants });

    await runProximitySearch('uid-1', [
      makeTask('t1', 'restaurant', 'Go out to sushi'),
    ], mockOnUpdate);

    const [heroType, heroPlace, allPlaces] = mockOnUpdate.mock.calls[0];
    expect(heroType).toBe('restaurant');
    expect(heroPlace?.name).toBe('Yakuza by Olivier');
    expect(allPlaces.restaurant).toEqual([restaurants[1]]);
  });

  it('preserves candidates for simultaneous restaurant food-intent tasks', async () => {
    const restaurants = [
      makePlace('r1', 'Portugália', 30),
      makePlace('r2', 'Yakuza by Olivier', 80),
    ];
    mockSearchNearbyPlaces.mockResolvedValue({ restaurant: restaurants });

    await runProximitySearch('uid-1', [
      makeTask('t1', 'restaurant', 'Go out to sushi'),
      makeTask('t2', 'restaurant', 'Comer comida portuguesa'),
    ], mockOnUpdate);

    const [heroType, heroPlace, allPlaces] = mockOnUpdate.mock.calls[0];
    expect(heroType).toBe('restaurant');
    expect(heroPlace?.name).toBe('Portugália');
    expect(allPlaces.restaurant).toEqual(restaurants);
  });

  it('does not show an unrelated restaurant for a food-intent restaurant task', async () => {
    mockSearchNearbyPlaces.mockResolvedValue({
      restaurant: [makePlace('r1', 'Portugália', 30)],
    });

    await runProximitySearch('uid-1', [
      makeTask('t1', 'restaurant', 'Go out to sushi'),
    ], mockOnUpdate);

    const [heroType, heroPlace, allPlaces] = mockOnUpdate.mock.calls[0];
    expect(heroType).toBeNull();
    expect(heroPlace).toBeNull();
    expect(allPlaces.restaurant).toBeUndefined();
  });
});
