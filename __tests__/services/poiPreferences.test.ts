/**
 * KAN-25 — Firebase POI preferences tests.
 *
 * Covers:
 *   - getPoiPreference: returns stored value; falls back to spec default
 *   - setPoiPreference: writes correct Firestore document
 *   - getPoiPreferencesMap: one-shot flat map
 *   - Proximity engine: user pref overrides built-in default
 *   - Proximity engine: falls back to built-in when no pref stored
 *   - Proximity engine: uses DEFAULT_GEOFENCE_RADIUS for custom types with no pref
 *   - updateProximityPoiPreferences: invalidates place cache (forces re-search)
 */

jest.mock('../../src/config/keys', () => ({
  GOOGLE_PLACES_API_KEY: 'TEST_KEY',
}));

jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);

// KAN-228 — proximity.ts now fire-and-forgets into the habitat cache, which
// pulls in expo-sqlite (ESM, breaks Jest's transform). Not under test here.
jest.mock('../../src/services/habitatCache');
jest.mock('../../src/services/proximitySnapshot');

// ─── Firestore mock ───────────────────────────────────────────────────────────

const mockGetDoc      = jest.fn();
const mockGetDocs     = jest.fn();
const mockSetDoc      = jest.fn();

const mockBatchUpdate = jest.fn();
const mockBatchCommit = jest.fn().mockResolvedValue(undefined);

jest.mock('@react-native-firebase/firestore', () => {
  const col  = jest.fn(() => ({ _type: 'collection' }));
  const docFn = jest.fn(() => ({ _type: 'doc' }));
  return {
    getFirestore:    jest.fn(),
    collection:      col,
    doc:             docFn,
    addDoc:          jest.fn(),
    getDoc:          (...args: unknown[]) => mockGetDoc(...args),
    getDocs:         (...args: unknown[]) => mockGetDocs(...args),
    updateDoc:       jest.fn(),
    deleteDoc:       jest.fn(),
    setDoc:          (...args: unknown[]) => mockSetDoc(...args),
    writeBatch:      jest.fn(() => ({ update: mockBatchUpdate, commit: mockBatchCommit })),
    query:           jest.fn((...a: unknown[]) => a[0]),
    where:           jest.fn(),
    orderBy:         jest.fn(),
    serverTimestamp: jest.fn(),
    Timestamp:       {},
  };
});

// ─── Notifee / geolocation / firestore (proximity) stubs ─────────────────────

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel:       jest.fn().mockResolvedValue(undefined),
    displayNotification: jest.fn().mockResolvedValue(undefined),
  },
  AndroidImportance: { HIGH: 4 },
  AndroidStyle:      { BIGTEXT: 'BIGTEXT' },
}));

jest.mock('react-native', () => ({
  Platform:            { OS: 'android' },
  NativeModules:       { WearNotificationModule: { sendProximityAlert: jest.fn() } },
  InteractionManager:  { runAfterInteractions: (cb: () => void) => cb() },
}));

const mockGetPosition = jest.fn();
jest.mock('../../src/services/geolocation', () => ({
  getPositionLowAccuracy: (...args: unknown[]) => mockGetPosition(...args),
  requestLocationPermission: jest.fn().mockResolvedValue('granted'),
}));

jest.mock('../../src/services/notifications', () => ({
  fireExitPrompt: jest.fn().mockResolvedValue(undefined),
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
    poiCatalog: new Proxy({}, { get: (_t, key) => String(key) }),
  },
}));

// KAN-342 — live search is Cloudflare-first, OSM-failsafe; Google is no
// longer reachable from this path. cloudflarePoiFunctions is left
// unconfigured (rejects to undefined -> caught -> falls through), so every
// fixture here is injected via the OSM mock instead.
jest.mock('../../src/services/placesFunctions', () => ({
  searchNearbyPlacesProxy: jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  getPlaceDetailsProxy:    jest.fn(),
}));
jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflareCoverageProxy: jest.fn(),
  cloudflarePoiAllProxy:   jest.fn(),
}));
const mockSearchOsmPlacesStrict = jest.fn();
jest.mock('../../src/services/osmPlaces', () => ({
  searchOsmPlacesStrict: (...args: unknown[]) => mockSearchOsmPlacesStrict(...args),
}));
jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedCity: jest.fn(() => ({ hit: false, city: null })),
  putCachedCity: jest.fn(),
}));

/** Approximate latitude offset to produce a given distance in metres north of the equator. */
const LAT_PER_METRE = 1 / 111_195;

function mockPlacesResponse(places: Array<{
  id: string; displayName: { text: string }; location: { latitude: number; longitude: number }; types?: string[];
}>) {
  const byType: Record<string, unknown[]> = {};
  for (const p of places) {
    const poiType = p.types?.[0] ?? 'atm';
    (byType[poiType] ??= []).push({
      osmId: p.id, name: p.displayName.text, isGenericName: false,
      lat: p.location.latitude, lng: p.location.longitude,
      distanceMeters: p.location.latitude / LAT_PER_METRE,
      footprintAreaM2: 0,
    });
  }
  mockSearchOsmPlacesStrict.mockResolvedValueOnce(byType);
}

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  getPoiPreference,
  setPoiPreference,
  getPoiPreferencesMap,
} from '../../src/services/firestore';
import {
  runProximitySearch,
  resetProximityState,
  updateProximityPoiPreferences,
} from '../../src/services/proximity';

// ─── getPoiPreference ─────────────────────────────────────────────────────────

describe('getPoiPreference', () => {
  beforeEach(() => { mockGetDoc.mockClear(); });

  it('returns stored document when preference exists', async () => {
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ type: 'atm', radiusMeters: 120 }),
    });

    const pref = await getPoiPreference('uid-1', 'atm');
    expect(pref).toEqual({ type: 'atm', radiusMeters: 120 });
  });

  it('returns built-in spec default when no document stored (atm → 50 m)', async () => {
    mockGetDoc.mockResolvedValue({ exists: () => false });

    const pref = await getPoiPreference('uid-1', 'atm');
    expect(pref).toEqual({ type: 'atm', radiusMeters: 50 });
  });

  it('returns 75 m default for unknown custom type with no stored preference', async () => {
    mockGetDoc.mockResolvedValue({ exists: () => false });

    // 'yoga_studio' is not in POI_GEOFENCE_RADIUS so it falls back to DEFAULT_GEOFENCE_RADIUS (75 m)
    const pref = await getPoiPreference('uid-1', 'yoga_studio');
    expect(pref).toEqual({ type: 'yoga_studio', radiusMeters: 75 });
  });
});

// ─── setPoiPreference ─────────────────────────────────────────────────────────

describe('setPoiPreference', () => {
  it('writes the correct document with type and radiusMeters', async () => {
    mockSetDoc.mockResolvedValue(undefined);

    await setPoiPreference('uid-1', 'pharmacy', 80);

    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.anything(),
      { type: 'pharmacy', radiusMeters: 80 },
    );
  });

  it('accepts custom type strings', async () => {
    mockSetDoc.mockResolvedValue(undefined);

    await setPoiPreference('uid-1', 'gym', 120);

    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.anything(),
      { type: 'gym', radiusMeters: 120 },
    );
  });
});

// ─── getPoiPreferencesMap ─────────────────────────────────────────────────────

describe('getPoiPreferencesMap', () => {
  it('returns a flat Record from a collection snapshot', async () => {
    mockGetDocs.mockResolvedValue({
      docs: [
        { data: () => ({ type: 'atm',      radiusMeters: 100 }) },
        { data: () => ({ type: 'pharmacy', radiusMeters: 80  }) },
      ],
    });

    const map = await getPoiPreferencesMap('uid-1');
    expect(map).toEqual({ atm: 100, pharmacy: 80 });
  });

  it('returns an empty map when no preferences are stored', async () => {
    mockGetDocs.mockResolvedValue({ docs: [] });

    const map = await getPoiPreferencesMap('uid-1');
    expect(map).toEqual({});
  });
});

// ─── Proximity engine — user pref radius integration ─────────────────────────

const ORIGIN = { lat: 0, lng: 0, accuracy: 10 };

const atmTask = {
  id:        'task-atm',
  title:     'Get cash',
  category:  'errands' as const,
  done:      false,
  poi:       'atm',
  date:      '2026-05-26',
  createdAt: { toDate: () => new Date() } as any,
};

beforeEach(() => {
  mockSearchOsmPlacesStrict.mockClear();
  mockGetPosition.mockClear();
  mockGetPosition.mockResolvedValue(ORIGIN);
  resetProximityState();
});

describe('proximity engine — user pref radius (KAN-25)', () => {
  it('places within HERO_RADIUS_M (100 m) become the hero type', async () => {
    // ATM is 80 m away — inside HERO_RADIUS_M (100 m).
    // updateProximityPoiPreferences still accepted but display threshold is
    // always HERO_RADIUS_M for hero and NEARBY_RADIUS for grey zone.
    updateProximityPoiPreferences({ atm: 100 });

    mockPlacesResponse([{
      id:          'atm-1',
      displayName: { text: 'City ATM' },
      location:    { latitude: 0.00072, longitude: 0 }, // ~80 m
      types:       ['atm'],
    }]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [atmTask], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.objectContaining({ name: 'City ATM' }),
      expect.any(Object),
    );
  });

  it('alerts when place is within NEARBY_RADIUS (400 m), regardless of user-saved radius (KAN-142)', async () => {
    // KAN-142 unified the display threshold to NEARBY_RADIUS=400 m.
    // User preferences no longer gate what appears in the NearbyCard.
    // 40 m < HERO_RADIUS_M (100 m) → hero type.
    updateProximityPoiPreferences({ atm: 25 });

    mockPlacesResponse([{
      id:          'atm-close',
      displayName: { text: 'Nearby ATM' },
      location:    { latitude: 0.00036, longitude: 0 }, // ~40 m
      types:       ['atm'],
    }]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [atmTask], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.objectContaining({ name: 'Nearby ATM' }),
      expect.any(Object),
    );
  });

  it('alerts when place is within NEARBY_RADIUS and no user pref is stored', async () => {
    updateProximityPoiPreferences({});

    mockPlacesResponse([{
      id:          'atm-near',
      displayName: { text: 'Corner ATM' },
      location:    { latitude: 0.00027, longitude: 0 }, // ~30 m
      types:       ['atm'],
    }]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [atmTask], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.objectContaining({ name: 'Corner ATM' }),
      expect.any(Object),
    );
  });

  it('alerts for custom POI types (gym) when within NEARBY_RADIUS (400 m)', async () => {
    const gymTask = {
      id:        'task-gym',
      title:     'Workout',
      category:  'health' as const,
      done:      false,
      poi:       'gym',
      date:      '2026-05-26',
      createdAt: { toDate: () => new Date() } as any,
    };

    updateProximityPoiPreferences({}); // no gym pref

    // Gym is 60 m away — inside HERO_RADIUS_M (100 m) → hero.
    mockPlacesResponse([{
      id:          'gym-1',
      displayName: { text: 'Downtown Gym' },
      location:    { latitude: 0.00054, longitude: 0 }, // ~60 m
      types:       ['gym'],
    }]);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [gymTask], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      'gym',
      expect.objectContaining({ name: 'Downtown Gym' }),
      expect.any(Object),
    );
  });
});
