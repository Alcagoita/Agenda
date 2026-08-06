/**
 * KAN-238/KAN-317 — habitat cache prefetch: curated POI allowlist, not just open-task types.
 *
 * Covers:
 *   - refreshHabitatCacheIfStale is fed the 16 built-ins plus the curated
 *     supported place types, not just this tick's uniquePoiTypes derived from
 *     open tasks — so a task created later for a never-before-seen type still
 *     finds cached candidates offline
 *   - supported custom category place types (setCustomCategoryPoiTypes) are
 *     folded into the same prefetch list; unsupported saved types are ignored
 *   - the live Places search and queryHabitatCache (the read/query side)
 *     stay filtered to this tick's actual open-task types, unchanged
 *   - setCustomCategoryPoiTypes(null) / resetProximityState() clear the
 *     custom types back to just the curated baseline
 */

jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);

const mockRecordLiveResult           = jest.fn();
const mockRefreshHabitatCacheIfStale = jest.fn().mockResolvedValue(undefined);
const mockQueryHabitatCache          = jest.fn().mockReturnValue({});
const mockFindExistingPlaceId        = jest.fn().mockReturnValue(null);
const mockHasCachedPlaces            = jest.fn().mockReturnValue(false);

jest.mock('../../src/services/habitatCache', () => ({
  recordLiveResult:           (...args: unknown[]) => mockRecordLiveResult(...args),
  refreshHabitatCacheIfStale: (...args: unknown[]) => mockRefreshHabitatCacheIfStale(...args),
  queryHabitatCache:          (...args: unknown[]) => mockQueryHabitatCache(...args),
  findExistingPlaceId:        (...args: unknown[]) => mockFindExistingPlaceId(...args),
  hasCachedPlaces:            (...args: unknown[]) => mockHasCachedPlaces(...args),
}));

jest.mock('../../src/services/proximitySnapshot');

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
    offline: { genericBanner: '', uncoveredAreaToast: '' },
    // poiCatalogLabel() reads this; a Proxy keeps the stub from having to
    // enumerate all 16 built-in types (plus shopping_mall) by hand.
    poiCatalog: new Proxy({}, { get: (_t, key) => String(key) }),
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// proximity imports maps.ts, which transitively pulls in placesFunctions ->
// @react-native-firebase/functions, a native module unavailable under Jest.
// Mock ONLY that native boundary so maps.ts's real helpers still load.
// The live Places search goes through the Cloud Function proxy, not raw
// fetch — mock it here (it also pulls in @react-native-firebase/functions, a
// native module unavailable under Jest). Resolves a well-formed empty
// response by default: maps.ts reads `.places` off it.
jest.mock('../../src/services/placesFunctions', () => ({
  searchNearbyPlacesProxy: jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  getPlaceDetailsProxy:    jest.fn(),
}));
jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflareCoverageProxy: jest.fn(),
  cloudflarePoiAllProxy:   jest.fn(),
}));
// KAN-342: live search is Cloudflare-first, OSM-failsafe — Google is no
// longer part of searchNearbyPlaces's path. cloudflareCoverageProxy above
// is left unconfigured (rejects to undefined -> caught -> falls through),
// so live-search fixtures are injected via the OSM mock instead.
const mockSearchOsmPlaces = jest.fn();
jest.mock('../../src/services/osmPlaces', () => ({
  searchOsmPlacesStrict: (...args: unknown[]) => mockSearchOsmPlaces(...args),
}));

jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedReverseGeocode: jest.fn(),
  setCachedReverseGeocode: jest.fn(),
  __resetReverseGeocodeCacheForTests: jest.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  runProximitySearch,
  resetProximityState,
  setCustomCategoryPoiTypes,
  getLastPoiSearchState,
} from '../../src/services/proximity';
import { ALL_POI_TYPES, CLUSTER_LEISURE_TYPES } from '../../src/types';
import { SUPPORTED_GOOGLE_PLACE_TYPES } from '../../src/constants/googlePlaceTypes';
import type { Task } from '../../src/types';
import NetInfo from '@react-native-community/netinfo';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ORIGIN = { lat: 0, lng: 0, accuracy: 10 };

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

function mockAtmSearchResponse() {
  mockSearchOsmPlaces.mockResolvedValueOnce({
    atm: [{ osmId: 'atm-1', name: 'Corner ATM', isGenericName: false, lat: 0.0002, lng: 0, distanceMeters: 22, footprintAreaM2: 0 }],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
  mockSearchOsmPlaces.mockReset();
  mockSearchOsmPlaces.mockResolvedValue({});
  mockGetPosition.mockResolvedValue(ORIGIN);
  jest.spyOn(Date.prototype, 'getHours').mockReturnValue(10);
  resetProximityState();
});

describe('habitat cache prefetch covers all POI types', () => {
  it('feeds refreshHabitatCacheIfStale ALL_POI_TYPES, not just the open task\'s single type', async () => {
    mockAtmSearchResponse();

    await runProximitySearch('uid-1', [makeTask({ poi: 'atm' })], jest.fn());

    expect(mockRefreshHabitatCacheIfStale).toHaveBeenCalledTimes(1);
    const [, , prefetchedTypes] = mockRefreshHabitatCacheIfStale.mock.calls[0];
    // KAN-282 — shopping_mall is prefetched alongside the built-ins so the
    // "All in one place" mall card has OSM data (footprints included) to work
    // from offline. It isn't in ALL_POI_TYPES: it's never a task category.
    // KAN-293 — the leisure types ride along in the SAME request for the same
    // reason: the cluster box's companion line reads them purely from the
    // cache, so they must already be there. `park` is absent from this extra
    // set because it's a real PoiType, already inside ALL_POI_TYPES.
    expect(new Set(prefetchedTypes)).toEqual(
      new Set([...ALL_POI_TYPES, ...SUPPORTED_GOOGLE_PLACE_TYPES, 'shopping_mall', ...CLUSTER_LEISURE_TYPES]),
    );
    expect(ALL_POI_TYPES).toHaveLength(16);
    // Not an exact target count — SUPPORTED_GOOGLE_PLACE_TYPES is a curated
    // list ("~100 entries" per its own doc comment), free to grow/shrink as
    // the taxonomy is tuned. Pinned to today's actual length so a future
    // accidental edit is still caught, without asserting a number nothing
    // in the source ever committed to.
    expect(SUPPORTED_GOOGLE_PLACE_TYPES).toHaveLength(90);
    // Explicitly proves the fix: pharmacy has no open task this tick, yet
    // it's still prefetched — this is exactly the "buy aspirin later" gap.
    expect(prefetchedTypes).toContain('pharmacy');
  });

  it('filters unsupported saved custom category types before habitat prefetch', async () => {
    setCustomCategoryPoiTypes(['gym', 'my_custom_type', 'coffee_shop']);
    mockAtmSearchResponse();

    await runProximitySearch('uid-1', [makeTask({ poi: 'atm' })], jest.fn());

    const [, , prefetchedTypes] = mockRefreshHabitatCacheIfStale.mock.calls[0];
    expect(SUPPORTED_GOOGLE_PLACE_TYPES).toContain('coffee_shop');
    expect(SUPPORTED_GOOGLE_PLACE_TYPES).not.toContain('my_custom_type');
    expect(prefetchedTypes).toContain('coffee_shop');
    expect(prefetchedTypes).not.toContain('my_custom_type');
    // 'gym' is already a built-in — must not be duplicated.
    expect(prefetchedTypes.filter((t: string) => t === 'gym')).toHaveLength(1);
    expect(new Set(prefetchedTypes).size).toBe(prefetchedTypes.length);
  });

  it('leaves the live Places search filtered to the tick\'s actual open-task types', async () => {
    mockAtmSearchResponse();

    await runProximitySearch('uid-1', [makeTask({ poi: 'atm' })], jest.fn());

    // Guards the KAN-282 prefetch change specifically: broadening the habitat
    // prefetch (which now includes shopping_mall) must NOT leak into the
    // live search call itself, which stays scoped to this tick's open tasks.
    const [, , searchedTypes] = mockSearchOsmPlaces.mock.calls[0];
    expect(searchedTypes).toEqual(['atm']);
  });

  it('leaves queryHabitatCache (the offline read path) filtered to the tick\'s open-task types', async () => {
    (NetInfo.fetch as jest.Mock).mockResolvedValueOnce({ isConnected: false });
    mockSearchOsmPlaces.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });

    await runProximitySearch('uid-1', [makeTask({ poi: 'atm' })], jest.fn());

    expect(mockQueryHabitatCache).toHaveBeenCalledWith(0, 0, ['atm'], 400);
  });

  it('setCustomCategoryPoiTypes(null) clears back to just the built-ins', async () => {
    setCustomCategoryPoiTypes(['my_custom_type']);
    setCustomCategoryPoiTypes(null);
    mockAtmSearchResponse();

    await runProximitySearch('uid-1', [makeTask({ poi: 'atm' })], jest.fn());

    const [, , prefetchedTypes] = mockRefreshHabitatCacheIfStale.mock.calls[0];
    expect(prefetchedTypes).not.toContain('my_custom_type');
  });

  it('resetProximityState() clears custom category types', async () => {
    setCustomCategoryPoiTypes(['my_custom_type']);
    resetProximityState();
    mockAtmSearchResponse();

    await runProximitySearch('uid-1', [makeTask({ poi: 'atm' })], jest.fn());

    const [, , prefetchedTypes] = mockRefreshHabitatCacheIfStale.mock.calls[0];
    expect(prefetchedTypes).not.toContain('my_custom_type');
  });
});

describe('KAN-342: source-aware identity + source/coverageStatus threading', () => {
  it('AC: an OSM live hit is recorded with source.osm, never googlePlaceId', async () => {
    mockAtmSearchResponse();

    await runProximitySearch('uid-1', [makeTask({ poi: 'atm' })], jest.fn());

    expect(mockRecordLiveResult).toHaveBeenCalledWith(
      expect.objectContaining({ poiType: 'atm', source: { osm: 'atm-1' } }),
    );
    const call = mockRecordLiveResult.mock.calls[0][0];
    expect(call.source.google).toBeUndefined();
    expect(call).not.toHaveProperty('googlePlaceId');
  });

  it('AC: source and coverageStatus are exposed via getLastPoiSearchState, degraded computed not stored', async () => {
    mockAtmSearchResponse();

    await runProximitySearch('uid-1', [makeTask({ poi: 'atm' })], jest.fn());

    const state = getLastPoiSearchState();
    expect(state.source).toBe('osm');
    // cloudflarePoiAllProxy is unconfigured here (undefined -> caught -> falls
    // through), so coverageStatus is genuinely unknown for this tick.
    expect(state.degraded).toBe(true);
    expect(state).not.toHaveProperty('_degraded');
  });
});
