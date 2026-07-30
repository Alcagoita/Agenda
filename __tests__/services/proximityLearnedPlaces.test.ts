/**
 * KAN-230 — learned places consumed by proximity ordering.
 *
 * Covers:
 *   - below-threshold behavior is identical to today (no learned places set
 *     → nearest-by-distance wins, same as before this ticket)
 *   - a learned place among a type's candidates is preferred as that type's
 *     representative "nearest" over an arbitrary closer stranger, as long
 *     as the learned place is itself within HERO_RADIUS_M — never demotes
 *     a genuinely hero-eligible type to grey/nothing by promoting a
 *     merely-grey learned candidate
 *   - a learned place outside HERO_RADIUS_M is NOT promoted over a closer
 *     hero-eligible stranger of the same type (correctness guard)
 *   - setLearnedPlaces(null) / resetProximityState() clear the ranking
 */

jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);

// KAN-228 — proximity.ts fire-and-forgets into the habitat cache, which
// pulls in expo-sqlite (ESM, breaks Jest's transform). Not under test here.
jest.mock('../../src/services/habitatCache');
jest.mock('../../src/services/proximitySnapshot');
jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedCity: jest.fn(() => ({ hit: false, city: null })),
  putCachedCity: jest.fn(),
}));

const mockSearchNearbyPlacesProxy = jest.fn();
jest.mock('../../src/services/placesFunctions', () => ({
  searchNearbyPlacesProxy: (...args: unknown[]) => mockSearchNearbyPlacesProxy(...args),
  placesAutocompleteProxy: jest.fn(),
  getPlaceDetailsProxy: jest.fn(),
}));

const mockDisplayNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel:       jest.fn().mockResolvedValue(undefined),
    displayNotification: (...args: unknown[]) => mockDisplayNotification(...args),
  },
  AndroidImportance: { HIGH: 4 },
  AndroidStyle:      { BIGTEXT: 'BIGTEXT' },
}));

jest.mock('react-native', () => ({
  Platform:            { OS: 'android' },
  NativeModules:       { WearNotificationModule: { sendProximityAlert: jest.fn() } },
  InteractionManager:  { runAfterInteractions: (cb: () => void) => cb() },
}));

jest.mock('../../src/services/firestore', () => ({
  markAllPoiAlertsSeen: jest.fn().mockResolvedValue(undefined),
  markPoiAlertSeen:     jest.fn().mockResolvedValue(undefined),
  markExitPromptSeen:   jest.fn().mockResolvedValue(undefined),
}));

const mockGetPosition = jest.fn();
jest.mock('../../src/services/geolocation', () => ({
  getPositionLowAccuracy:    (...args: unknown[]) => mockGetPosition(...args),
  requestLocationPermission: jest.fn().mockResolvedValue('granted'),
}));

jest.mock('../../src/services/notifications', () => ({
  fireExitPrompt: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/config/keys', () => ({
  GOOGLE_PLACES_API_KEY: 'TEST_KEY',
}));

jest.mock('../../src/native/WearNotificationModule', () => ({
  sendProximityAlert: jest.fn(),
}));

jest.mock('../../src/constants/copy', () => ({
  COPY: {
    notification: {
      proximityTitle: (label: string) => `You're near ${label}`,
      proximityBody:  (count: number) => `${count} task(s) nearby`,
    },
    offline: { genericBanner: '', noCacheYetBanner: '', uncoveredAreaToast: '' },
    poiCatalog: new Proxy({}, { get: (_t, key) => String(key) }),
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { runProximitySearch, resetProximityState, setLearnedPlaces } from '../../src/services/proximity';
import { restaurantFoodTypeFavouriteName } from '../../src/services/restaurantFoodTypes';
import type { Task } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ORIGIN = { lat: 0, lng: 0, accuracy: 10 };
const LAT_PER_METRE = 1 / 111_195;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id:        'task-1',
    title:     'Get cash',
    category:  'errands',
    done:      false,
    poi:       'atm',
    date:      '2026-07-05',
    createdAt: { toDate: () => new Date() } as unknown as Task['createdAt'],
    ...overrides,
  };
}

function mockAtmPlaces(places: Array<{ id: string; name: string; distanceMeters: number }>) {
  mockPlacesResponse(places.map(p => ({ ...p, type: 'atm' })));
}

function mockRestaurantPlaces(places: Array<{ id: string; name: string; distanceMeters: number }>) {
  mockPlacesResponse(places.map(p => ({ ...p, type: 'restaurant' })));
}

function mockPlacesResponse(places: Array<{ id: string; name: string; distanceMeters: number; type: string }>) {
  mockSearchNearbyPlacesProxy.mockResolvedValueOnce({
    places: places.map(p => ({
      id: p.id,
      displayName: { text: p.name },
      location: { latitude: LAT_PER_METRE * p.distanceMeters, longitude: 0 },
      types: [p.type],
    })),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
  mockSearchNearbyPlacesProxy.mockReset();
  mockGetPosition.mockResolvedValue(ORIGIN);
  jest.spyOn(Date.prototype, 'getHours').mockReturnValue(10);
  resetProximityState();
});

describe('below-threshold behavior is unchanged', () => {
  it('picks the nearest place by distance when no learned places are set', async () => {
    mockAtmPlaces([
      { id: 'atm-near', name: 'Random ATM', distanceMeters: 20 },
      { id: 'atm-far',  name: 'Other ATM',  distanceMeters: 80 },
    ]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.objectContaining({ placeId: 'atm-near' }),
      expect.anything(),
    );
  });
});

describe('a learned place gets top priority within its own hero range', () => {
  it('prefers the learned place over a closer stranger of the same type, when the learned place is itself within HERO_RADIUS_M', async () => {
    setLearnedPlaces([{ name: 'My Usual ATM', poiType: 'atm', visitCount: 5 }]);
    mockAtmPlaces([
      { id: 'atm-stranger', name: 'Random ATM',  distanceMeters: 20 }, // closer, but not learned
      { id: 'atm-learned',  name: 'My Usual ATM', distanceMeters: 90 }, // learned, still hero-eligible (<100m)
    ]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.objectContaining({ placeId: 'atm-learned' }),
      expect.objectContaining({ atm: expect.arrayContaining([expect.objectContaining({ placeId: 'atm-learned' })]) }),
    );
  });

  it('promotes any branch of the learned brand — matches by name, not place id (KAN-304)', async () => {
    setLearnedPlaces([{ name: 'My Usual ATM', poiType: 'atm', visitCount: 5 }]);
    mockAtmPlaces([
      { id: 'atm-stranger', name: 'Random ATM',  distanceMeters: 20 },
      // A DIFFERENT branch id than anything ever brushed — same brand name, so
      // the brand preference must still promote it.
      { id: 'atm-other-branch', name: 'My Usual ATM', distanceMeters: 90 },
    ]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.objectContaining({ placeId: 'atm-other-branch', name: 'My Usual ATM' }),
      expect.anything(),
    );
  });

  it('does not duplicate the learned place in the carousel after promoting it from a later position', async () => {
    setLearnedPlaces([{ name: 'My Usual ATM', poiType: 'atm', visitCount: 5 }]);
    mockAtmPlaces([
      { id: 'atm-stranger', name: 'Random ATM',  distanceMeters: 20 },
      { id: 'atm-learned',  name: 'My Usual ATM', distanceMeters: 90 },
    ]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    const allPlaces = onUpdate.mock.calls[0][2];
    const learnedCount = allPlaces.atm.filter((p: { placeId: string }) => p.placeId === 'atm-learned').length;
    expect(learnedCount).toBe(1);
  });

  it('does not promote a learned place that is outside HERO_RADIUS_M over a closer hero-eligible stranger', async () => {
    setLearnedPlaces([{ name: 'My Usual ATM', poiType: 'atm', visitCount: 5 }]);
    mockAtmPlaces([
      { id: 'atm-stranger', name: 'Random ATM',  distanceMeters: 20 },  // hero-eligible on its own
      { id: 'atm-learned',  name: 'My Usual ATM', distanceMeters: 150 }, // learned, but NOT hero-eligible
    ]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    // The genuinely-closer, hero-eligible stranger must still win — the
    // learned place's own distance can't demote it to grey/nothing.
    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.objectContaining({ placeId: 'atm-stranger' }),
      expect.anything(),
    );
  });

  it('a type whose TRUE nearest already wins the cross-type hero race keeps winning after its own learned-place promotion (regression: promotion must not feed an inflated distance back into cross-type comparison)', async () => {
    setLearnedPlaces([{ name: 'My Usual ATM', poiType: 'atm', visitCount: 5 }]);
    // atm's TRUE nearest (20 m) already beats cafe's nearest (50 m) — that
    // must decide the cross-type race BEFORE atm's own learned place (90 m,
    // still hero-eligible) gets swapped in for display.
    mockPlacesResponse([
      { id: 'atm-near',    name: 'Random ATM',  distanceMeters: 20, type: 'atm' },
      { id: 'atm-learned', name: 'My Usual ATM', distanceMeters: 90, type: 'atm' },
      { id: 'cafe-near',   name: 'Some Cafe',    distanceMeters: 50, type: 'cafe' },
    ]);

    const onUpdate = jest.fn();
    await runProximitySearch(
      'uid-1',
      [makeTask({ id: 't1', poi: 'atm' }), makeTask({ id: 't2', poi: 'cafe' })],
      onUpdate,
    );

    // atm still wins hero (its true 20 m beat cafe's 50 m) — cafe must not
    // win just because atm's post-promotion displayed distance (90 m) looks
    // farther than cafe's 50 m.
    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.objectContaining({ placeId: 'atm-learned' }),
      expect.anything(),
    );
  });

  it('prefers the favourite restaurant food type for a generic restaurant task', async () => {
    setLearnedPlaces([{ name: restaurantFoodTypeFavouriteName('sushi'), poiType: 'restaurant', visitCount: 5 }]);
    mockRestaurantPlaces([
      { id: 'restaurant-portuguese', name: 'Portugália', distanceMeters: 20 },
      { id: 'restaurant-sushi', name: 'Yakuza by Olivier', distanceMeters: 80 },
    ]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [
      makeTask({ id: 'dinner', poi: 'restaurant', title: 'Book dinner' }),
    ], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      'restaurant',
      expect.objectContaining({ placeId: 'restaurant-sushi', name: 'Yakuza by Olivier' }),
      expect.anything(),
    );
  });

  it('ignores favourite food type when the restaurant task already has a food type', async () => {
    setLearnedPlaces([{ name: restaurantFoodTypeFavouriteName('portuguese'), poiType: 'restaurant', visitCount: 5 }]);
    mockRestaurantPlaces([
      { id: 'restaurant-portuguese', name: 'Portugália', distanceMeters: 20 },
      { id: 'restaurant-sushi', name: 'Yakuza by Olivier', distanceMeters: 80 },
    ]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [
      makeTask({ id: 'sushi', poi: 'restaurant', title: 'Go out to sushi' }),
    ], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      'restaurant',
      expect.objectContaining({ placeId: 'restaurant-sushi', name: 'Yakuza by Olivier' }),
      expect.anything(),
    );
  });
});

describe('clearing the learned-place ranking', () => {
  it('setLearnedPlaces(null) reverts to plain distance ordering', async () => {
    setLearnedPlaces([{ name: 'My Usual ATM', poiType: 'atm', visitCount: 5 }]);
    setLearnedPlaces(null);

    mockAtmPlaces([
      { id: 'atm-stranger', name: 'Random ATM',  distanceMeters: 20 },
      { id: 'atm-learned',  name: 'My Usual ATM', distanceMeters: 90 },
    ]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith('atm', expect.objectContaining({ placeId: 'atm-stranger' }), expect.anything());
  });

  it('resetProximityState() clears the learned-place ranking', async () => {
    setLearnedPlaces([{ name: 'My Usual ATM', poiType: 'atm', visitCount: 5 }]);
    resetProximityState();

    mockAtmPlaces([
      { id: 'atm-stranger', name: 'Random ATM',  distanceMeters: 20 },
      { id: 'atm-learned',  name: 'My Usual ATM', distanceMeters: 90 },
    ]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith('atm', expect.objectContaining({ placeId: 'atm-stranger' }), expect.anything());
  });
});
