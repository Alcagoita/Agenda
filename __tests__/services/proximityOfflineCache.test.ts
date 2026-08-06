/**
 * KAN-229 — Cache-backed offline proximity.
 * KAN-236 — Offline expectations messaging (the "moved beyond coverage" toast).
 *
 * Covers:
 *   - a live searchNearbyPlaces failure while offline answers from the
 *     habitat cache instead of just queuing — hero split, notification and
 *     exit-prompt all run off the cache's Record<string, NearbyPlace[]>,
 *     exactly as they would off a live result (the AC's "impersonates the
 *     Places response")
 *   - the offline tick still enqueues the search so a live refresh replaces
 *     it on reconnect (KAN-205 queue untouched)
 *   - the offline tick does NOT feed the habitat cache's live-seed/refresh
 *     path — there's no live data to seed back into it
 *   - a live result already known to the cache (findExistingPlaceId returns
 *     a match) gets remapped to that stable internal id, so a place doesn't
 *     look "different" to the exit-prompt dwell tracker or the Nearby
 *     card's carousel after a source flip
 *   - a live result with NO cache match keeps its own Google placeId
 *     unchanged (regression guard: must never substitute a fresh throwaway
 *     id, which would defeat identity continuity for every not-yet-cached
 *     place)
 *   - alert dedup survives a source switch: a notification fired from a
 *     cache-answered tick suppresses the same notification from a
 *     live-answered tick for the same place/type later that day
 *   - a cache miss (offline, nothing cached for this area) does not call
 *     onUpdate at all — a transient "no answer" tick must not clear
 *     whatever hero/grey state was already on screen
 *   - identity reconciliation only reads the cache once per type (the
 *     nearest place), plus once more per extra place but ONLY for the
 *     type that actually won the hero slot — never for every place of
 *     every type (avoids an N+1 synchronous SQLite read per search)
 *   - a cache miss fires a one-time, once-per-session toast when the cache
 *     has data *somewhere* (the user has walked beyond its coverage) but
 *     stays silent when the cache is empty everywhere or when the cache
 *     actually answered (not a miss)
 */

jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);

const mockRecordLiveResult            = jest.fn();
const mockRefreshHabitatCacheIfStale  = jest.fn().mockResolvedValue(undefined);
const mockQueryHabitatCache           = jest.fn().mockReturnValue({});
const mockFindExistingPlaceId         = jest.fn().mockReturnValue(null);
const mockHasCachedPlaces             = jest.fn().mockReturnValue(false);

jest.mock('../../src/services/habitatCache', () => ({
  recordLiveResult:           (...args: unknown[]) => mockRecordLiveResult(...args),
  refreshHabitatCacheIfStale: (...args: unknown[]) => mockRefreshHabitatCacheIfStale(...args),
  queryHabitatCache:          (...args: unknown[]) => mockQueryHabitatCache(...args),
  findExistingPlaceId:        (...args: unknown[]) => mockFindExistingPlaceId(...args),
  hasCachedPlaces:            (...args: unknown[]) => mockHasCachedPlaces(...args),
}));

jest.mock('../../src/services/proximitySnapshot');

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
    offline: {
      genericBanner:       'Offline — changes may not sync',
      uncoveredAreaToast:  "You're outside the area I know by heart — I'll need a connection to spot places here.",
      uncoveredAreaInvitationToast:  "You're outside the area I know by heart. Next time, tell me before you go — I can learn a place ahead of time.",
      uncoveredAreaInvitationAction: 'Show me',
    },
    // placeTypeLabel() → poiCatalogLabel() reads this for every built-in
    // PoiType touched by these tests (exit prompts, notification bodies).
    poiCatalog: {
      atm: 'ATM', cafe: 'Café', supermarket: 'Market', pharmacy: 'Pharmacy',
      gas: 'Gas', gym: 'Gym', bank: 'Bank', restaurant: 'Restaurant',
      park: 'Park', library: 'Library', post: 'Post', store: 'Store',
      clinic: 'Clinic', salon: 'Salon', bus: 'Bus', school: 'School',
    },
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

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
const LAT_PER_METRE_OSM = 1 / 111_195;

function mockOsmPlacesResponse(places: Array<{
  id: string; displayName: { text: string }; location: { latitude: number; longitude: number }; types?: string[];
}>) {
  const byType: Record<string, unknown[]> = {};
  for (const p of places) {
    const poiType = p.types?.[0] ?? 'atm';
    (byType[poiType] ??= []).push({
      osmId: p.id, name: p.displayName.text, isGenericName: false,
      lat: p.location.latitude, lng: p.location.longitude,
      distanceMeters: p.location.latitude / LAT_PER_METRE_OSM,
      footprintAreaM2: 0,
    });
  }
  mockSearchOsmPlacesStrict.mockResolvedValueOnce(byType);
}

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  runProximitySearch,
  resetProximityState,
  __getPendingQueue,
  __resetCoverageInvitationCount,
  setActiveTrips,
  setMallSnapshot,
  setPlaceContextTap,
  setNavigateToTripPlanner,
} from '../../src/services/proximity';
import type { Task, Trip, MallSnapshot } from '../../src/types';
import type { NearbyPlace } from '../../src/services/maps';
import NetInfo from '@react-native-community/netinfo';
import { useToastStore } from '../../src/store/toastStore';
import { COPY } from '../../src/constants/copy';

function goOffline(): void {
  (NetInfo.fetch as jest.Mock).mockResolvedValueOnce({ isConnected: false });
}

/** Connected but no real internet (captive portal) still counts as offline. */
function goCaptivePortal(): void {
  (NetInfo.fetch as jest.Mock).mockResolvedValueOnce({ isConnected: true, isInternetReachable: false });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ORIGIN = { lat: 0, lng: 0, accuracy: 10 };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id:        'task-1',
    title:     'Get cash',
    category:  'errands',
    done:      false,
    poi:       'atm',
    date:      '2026-07-04',
    createdAt: { toDate: () => new Date() } as unknown as Task['createdAt'],
    ...overrides,
  };
}

function cachedPlace(overrides: Partial<NearbyPlace> = {}): NearbyPlace {
  return { placeId: 'hp_cached_1', name: 'Cached ATM', lat: 0.0002, lng: 0, distanceMeters: 22, ...overrides };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-1', destination: 'Faro', placeRef: 'place-abc',
    centerLat: 0, centerLng: 0, areaRadius: 5_000,
    cacheAreaId: 'ta_1', expiresAt: Date.now() + 1_000_000,
    createdAt: {} as unknown as Trip['createdAt'],
    ...overrides,
  };
}

function makeMallSnapshot(overrides: Partial<MallSnapshot> = {}): MallSnapshot {
  return {
    placeId: 'mall-1', name: 'Test Mall', centerLat: 0, centerLng: 0, radius: 300,
    cacheAreaId: 'mall_snapshot', expiresAt: Date.now() + 1_000_000,
    createdAt: {} as unknown as MallSnapshot['createdAt'],
    ...overrides,
  };
}

/** Flushes the fire-and-forget notification promise chain (createChannel → displayNotification). */
async function flushAsync(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
  mockSearchOsmPlacesStrict.mockReset();
  mockGetPosition.mockResolvedValue(ORIGIN);
  mockQueryHabitatCache.mockReturnValue({});
  mockFindExistingPlaceId.mockReturnValue(null);
  mockHasCachedPlaces.mockReturnValue(false);
  useToastStore.setState({ message: null, action: null });
  // Pin the clock to business hours so isQuietHours() never suppresses
  // the notification assertions below.
  jest.spyOn(Date.prototype, 'getHours').mockReturnValue(10);
  resetProximityState();
  __resetCoverageInvitationCount();
});

describe('offline branch answers from the habitat cache', () => {
  it('fires the hero card and notification off a cached hit when the live search fails offline', async () => {
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [cachedPlace()] });

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);
    await flushAsync();

    expect(mockQueryHabitatCache).toHaveBeenCalledWith(0, 0, ['atm'], 400);
    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.objectContaining({ placeId: 'hp_cached_1', name: 'Cached ATM' }),
      expect.objectContaining({ atm: [expect.objectContaining({ placeId: 'hp_cached_1' })] }),
    );
    expect(mockDisplayNotification).toHaveBeenCalledTimes(1);
  });

  it('still enqueues the search for a live refresh on reconnect', async () => {
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [cachedPlace()] });

    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(__getPendingQueue()).toHaveLength(1);
  });

  it('also answers from the cache when connected but unreachable (captive portal)', async () => {
    goCaptivePortal();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [cachedPlace()] });

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.objectContaining({ placeId: 'hp_cached_1' }),
      expect.anything(),
    );
    expect(__getPendingQueue()).toHaveLength(1);
  });

  it('does not seed the live-result cache or trigger a refresh from a cache-answered tick', async () => {
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [cachedPlace()] });

    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(mockRecordLiveResult).not.toHaveBeenCalled();
    expect(mockRefreshHabitatCacheIfStale).not.toHaveBeenCalled();
  });

  it('does not remap cache-sourced placeIds through findExistingPlaceId (already internal ids)', async () => {
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [cachedPlace()] });

    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(mockFindExistingPlaceId).not.toHaveBeenCalled();
  });

  it('does not call onUpdate on a cache miss — preserves whatever was already on screen', async () => {
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] }); // nothing cached for this area yet

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    expect(onUpdate).not.toHaveBeenCalled();
    expect(mockDisplayNotification).not.toHaveBeenCalled();
  });

  it('still enqueues for a live retry on a cache miss', async () => {
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });

    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(__getPendingQueue()).toHaveLength(1);
  });
});

describe('live results reconcile against the cache identity table', () => {
  it('remaps a live place to its existing internal id when the cache already knows it', async () => {
    mockOsmPlacesResponse([
      { id: 'ChIJlive1', displayName: { text: 'Live ATM' }, location: { latitude: 0.0002, longitude: 0 }, types: ['atm'] },
    ]);
    mockFindExistingPlaceId.mockReturnValue('hp_shared_1');

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    // heroPlace itself is assigned before reconciliation runs — the
    // reconciled id lands on the allPlaces entry, which is what the Nearby
    // card and exit-prompt dwell tracker actually read from.
    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.anything(),
      expect.objectContaining({ atm: [expect.objectContaining({ placeId: 'hp_shared_1' })] }),
    );
  });

  it('keeps a live place on its own Google placeId when the cache has no match yet', async () => {
    mockOsmPlacesResponse([
      { id: 'ChIJlive1', displayName: { text: 'Live ATM' }, location: { latitude: 0.0002, longitude: 0 }, types: ['atm'] },
    ]);
    mockFindExistingPlaceId.mockReturnValue(null);

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.objectContaining({ placeId: 'ChIJlive1' }),
      expect.anything(),
    );
  });

  it('reconciles only the nearest place per type, plus the hero type\'s remaining places — never every place of every type', async () => {
    const LAT_PER_METRE = 1 / 111_195;
    mockOsmPlacesResponse([
      { id: 'atm-near', displayName: { text: 'Near ATM' }, location: { latitude: LAT_PER_METRE * 30, longitude: 0 }, types: ['atm'] },
      { id: 'atm-far',  displayName: { text: 'Far ATM' },  location: { latitude: LAT_PER_METRE * 80, longitude: 0 }, types: ['atm'] },
      { id: 'cafe-near', displayName: { text: 'Near Cafe' }, location: { latitude: LAT_PER_METRE * 150, longitude: 0 }, types: ['cafe'] },
      { id: 'cafe-far',  displayName: { text: 'Far Cafe' },  location: { latitude: LAT_PER_METRE * 200, longitude: 0 }, types: ['cafe'] },
    ]);
    mockFindExistingPlaceId.mockReturnValue(null);

    const tasks = [makeTask({ id: 't1', poi: 'atm' }), makeTask({ id: 't2', poi: 'cafe' })];
    await runProximitySearch('uid-1', tasks, jest.fn());

    // atm is the hero type (nearest < HERO_RADIUS_M) — both its places get
    // reconciled (nearest in pass 1, "Far ATM" in the hero-only pass 2).
    // cafe is only a grey/"approaching" type — just its nearest place is
    // ever looked up; "Far Cafe" is never queried.
    expect(mockFindExistingPlaceId).toHaveBeenCalledTimes(3);
    expect(mockFindExistingPlaceId).toHaveBeenCalledWith('atm', 'Near ATM', expect.any(Number), expect.any(Number));
    expect(mockFindExistingPlaceId).toHaveBeenCalledWith('atm', 'Far ATM', expect.any(Number), expect.any(Number));
    expect(mockFindExistingPlaceId).toHaveBeenCalledWith('cafe', 'Near Cafe', expect.any(Number), expect.any(Number));
    expect(mockFindExistingPlaceId).not.toHaveBeenCalledWith('cafe', 'Far Cafe', expect.any(Number), expect.any(Number));
  });
});

describe('alert dedup survives a source switch', () => {
  it('does not re-fire a notification from a live hit for a type already alerted from a cache hit', async () => {
    // Tick 1 — offline, cache answers, fires the notification.
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [cachedPlace()] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());
    await flushAsync();
    expect(mockDisplayNotification).toHaveBeenCalledTimes(1);

    // Tick 2 — back online, live search finds the same place (remapped to
    // the same internal id via findExistingPlaceId) — must not re-fire.
    mockDisplayNotification.mockClear();
    mockFindExistingPlaceId.mockReturnValue('hp_cached_1');
    mockOsmPlacesResponse([
      { id: 'ChIJlive1', displayName: { text: 'Live ATM' }, location: { latitude: 0.0002, longitude: 0 }, types: ['atm'] },
    ]);

    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(mockDisplayNotification).not.toHaveBeenCalled();
  });
});

describe('offline expectations messaging — "moved beyond coverage" toast (KAN-236 / KAN-244)', () => {
  it('fires the invitation-variant toast (under the lifetime cap) on a cache miss when the cache has data elsewhere', async () => {
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    mockHasCachedPlaces.mockReturnValue(true);

    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(useToastStore.getState().message).toBe(COPY.offline.uncoveredAreaInvitationToast);
    expect(useToastStore.getState().action?.label).toBe(COPY.offline.uncoveredAreaInvitationAction);
  });

  it('the invitation action navigates to the Trip Planner flow via the injected callback', async () => {
    const mockNavigate = jest.fn();
    setNavigateToTripPlanner(mockNavigate);

    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    mockHasCachedPlaces.mockReturnValue(true);

    await runProximitySearch('uid-1', [makeTask()], jest.fn());
    useToastStore.getState().action?.onPress();

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    setNavigateToTripPlanner(null);
  });

  it('the invitation action is a safe no-op when no navigate callback is registered', async () => {
    setNavigateToTripPlanner(null);

    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    mockHasCachedPlaces.mockReturnValue(true);

    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(() => useToastStore.getState().action?.onPress()).not.toThrow();
  });

  it('does not fire the toast on a cache miss when the cache is empty everywhere', async () => {
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    mockHasCachedPlaces.mockReturnValue(false);

    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(useToastStore.getState().message).toBeNull();
  });

  it('does not fire the toast when the cache actually answers (not a miss)', async () => {
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [cachedPlace()] });
    mockHasCachedPlaces.mockReturnValue(true);

    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(useToastStore.getState().message).toBeNull();
  });

  it('fires at most once per session across repeated cache misses', async () => {
    mockHasCachedPlaces.mockReturnValue(true);

    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());
    expect(useToastStore.getState().message).toBe(COPY.offline.uncoveredAreaInvitationToast);

    // Dismiss it, then hit another cache miss in the same session.
    useToastStore.getState().hideToast();
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(useToastStore.getState().message).toBeNull();
  });

  it('does not re-check the cache once the notice has already fired this session', async () => {
    mockHasCachedPlaces.mockReturnValue(true);

    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());
    expect(mockHasCachedPlaces).toHaveBeenCalledTimes(1);

    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    // The already-shown flag short-circuits before the DB read.
    expect(mockHasCachedPlaces).toHaveBeenCalledTimes(1);
  });

  it('can fire again after resetProximityState (new session)', async () => {
    mockHasCachedPlaces.mockReturnValue(true);

    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());
    expect(useToastStore.getState().message).toBe(COPY.offline.uncoveredAreaInvitationToast);

    useToastStore.getState().hideToast();
    resetProximityState();

    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(useToastStore.getState().message).toBe(COPY.offline.uncoveredAreaInvitationToast);
  });

  it('KAN-244 — reverts to the plain copy once the invitation lifetime cap is reached, even across new sessions', async () => {
    mockHasCachedPlaces.mockReturnValue(true);

    // Three sessions, each fires the invitation variant (count 0 → 1 → 2 → 3).
    for (let i = 0; i < 3; i += 1) {
      goOffline();
      mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
      mockQueryHabitatCache.mockReturnValue({ atm: [] });
      await runProximitySearch('uid-1', [makeTask()], jest.fn());
      expect(useToastStore.getState().message).toBe(COPY.offline.uncoveredAreaInvitationToast);

      useToastStore.getState().hideToast();
      resetProximityState(); // new session — only resets the once-per-session flag, NOT the lifetime cap
    }

    // Fourth session, cap now reached — plain apology copy, no action.
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(useToastStore.getState().message).toBe(COPY.offline.uncoveredAreaToast);
    expect(useToastStore.getState().action).toBeNull();
  });
});

describe('off-grid window suppresses the coverage toast for free (KAN-246 — via KAN-237 cache-first, no dedicated check)', () => {
  afterEach(() => { setActiveTrips(null); });

  it('does not fire the toast anywhere inside an active off-grid window\'s area', async () => {
    mockHasCachedPlaces.mockReturnValue(true);
    setActiveTrips([makeTrip({
      kind: 'offgrid', centerLat: 0, centerLng: 0, areaRadius: 15_000, expiresAt: Date.now() + 1_000_000,
    })]);

    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(useToastStore.getState().message).toBeNull();
  });

  it('does not consume the once-per-session flag or the invitation cap while suppressed', async () => {
    mockHasCachedPlaces.mockReturnValue(true);
    setActiveTrips([makeTrip({
      kind: 'offgrid', centerLat: 0, centerLng: 0, areaRadius: 15_000, expiresAt: Date.now() + 1_000_000,
    })]);

    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());
    expect(useToastStore.getState().message).toBeNull();

    // Once outside the window's area, the toast fires normally — proving
    // the earlier tick didn't quietly mark the session/notice as "shown".
    setActiveTrips(null);
    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(useToastStore.getState().message).toBe(COPY.offline.uncoveredAreaInvitationToast);
  });

  it('fires the toast normally once the off-grid window has expired', async () => {
    mockHasCachedPlaces.mockReturnValue(true);
    setActiveTrips([makeTrip({
      kind: 'offgrid', centerLat: 0, centerLng: 0, areaRadius: 15_000, expiresAt: Date.now() - 1_000,
    })]);

    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(useToastStore.getState().message).toBe(COPY.offline.uncoveredAreaInvitationToast);
  });

  it('fires the toast normally outside the off-grid window\'s area radius', async () => {
    mockHasCachedPlaces.mockReturnValue(true);
    setActiveTrips([makeTrip({
      kind: 'offgrid', centerLat: 50, centerLng: 50, areaRadius: 15_000, expiresAt: Date.now() + 1_000_000,
    })]);

    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn()); // position is (0,0) per ORIGIN

    expect(useToastStore.getState().message).toBe(COPY.offline.uncoveredAreaInvitationToast);
  });

  it('a regular (non-offgrid) trip suppresses it the same way — both kinds route through findActiveCacheArea', async () => {
    mockHasCachedPlaces.mockReturnValue(true);
    setActiveTrips([makeTrip({ centerLat: 0, centerLng: 0, areaRadius: 15_000, expiresAt: Date.now() + 1_000_000 })]);

    goOffline();
    mockSearchOsmPlacesStrict.mockRejectedValueOnce(new Error('network down'));
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(useToastStore.getState().message).toBeNull();
  });
});

describe('cache-first coverage (KAN-237) — trip areas and the mall snapshot skip the live API entirely', () => {
  afterEach(() => {
    setActiveTrips(null);
    setMallSnapshot(null);
  });

  it('answers from the cache with zero live API calls while inside an active trip area, even online', async () => {
    setActiveTrips([makeTrip({ centerLat: 0, centerLng: 0, areaRadius: 5_000 })]);
    mockQueryHabitatCache.mockReturnValue({ atm: [cachedPlace()] });

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    expect(mockSearchOsmPlacesStrict).not.toHaveBeenCalled();
    expect(mockQueryHabitatCache).toHaveBeenCalledWith(0, 0, ['atm'], expect.any(Number));
    expect(onUpdate).toHaveBeenCalledWith('atm', expect.objectContaining({ placeId: 'hp_cached_1' }), expect.anything());
  });

  it('answers from the cache with zero live API calls while inside the mall snapshot, even online', async () => {
    setMallSnapshot(makeMallSnapshot({ centerLat: 0, centerLng: 0, radius: 300 }));
    mockQueryHabitatCache.mockReturnValue({ atm: [cachedPlace()] });

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    expect(mockSearchOsmPlacesStrict).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledWith('atm', expect.objectContaining({ placeId: 'hp_cached_1' }), expect.anything());
  });

  it('falls through to the live API when outside any trip/mall area', async () => {
    setActiveTrips([makeTrip({ centerLat: 10, centerLng: 10, areaRadius: 5_000 })]); // far away
    mockSearchOsmPlacesStrict.mockResolvedValueOnce({});

    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(mockSearchOsmPlacesStrict).toHaveBeenCalledTimes(1);
    expect(mockQueryHabitatCache).not.toHaveBeenCalled();
  });

  it('falls through to the live API when the trip has already expired', async () => {
    setActiveTrips([makeTrip({ centerLat: 0, centerLng: 0, areaRadius: 5_000, expiresAt: Date.now() - 1_000 })]);
    mockSearchOsmPlacesStrict.mockResolvedValueOnce({});

    await runProximitySearch('uid-1', [makeTask()], jest.fn());

    expect(mockSearchOsmPlacesStrict).toHaveBeenCalledTimes(1);
  });

  it('a cache-first empty result proceeds through to onUpdate (confident "nothing here"), unlike the ambiguous offline-cache-miss path', async () => {
    setActiveTrips([makeTrip({ centerLat: 0, centerLng: 0, areaRadius: 5_000 })]);
    mockQueryHabitatCache.mockReturnValue({ atm: [] });
    mockHasCachedPlaces.mockReturnValue(true); // would otherwise be eligible for the "beyond coverage" toast

    const onUpdate = jest.fn();
    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    // Must clear the hero via onUpdate, not bail out silently, and must not
    // fire the offline "moved beyond coverage" toast — this isn't offline.
    expect(onUpdate).toHaveBeenCalledWith(null, null, {});
    expect(useToastStore.getState().message).toBeNull();
  });
});

describe('place context tap (KAN-242) — feeds the header ContextChip, mall-first on overlap', () => {
  afterEach(() => {
    setActiveTrips(null);
    setMallSnapshot(null);
    setPlaceContextTap(null);
  });

  it('reports the mall when both an active trip and the mall snapshot cover the same position', () => {
    const trip = makeTrip({ centerLat: 0, centerLng: 0, areaRadius: 5_000 });
    const mall = makeMallSnapshot({ centerLat: 0, centerLng: 0, radius: 300 });
    setActiveTrips([trip]);
    setMallSnapshot(mall);

    const tap = jest.fn();
    setPlaceContextTap(tap);

    return runProximitySearch('uid-1', [makeTask()], jest.fn()).then(() => {
      expect(tap).toHaveBeenCalledWith({ kind: 'mall', snapshot: mall });
    });
  });

  it('reports the trip when only a trip area covers the position', () => {
    const trip = makeTrip({ centerLat: 0, centerLng: 0, areaRadius: 5_000 });
    setActiveTrips([trip]);

    const tap = jest.fn();
    setPlaceContextTap(tap);

    return runProximitySearch('uid-1', [makeTask()], jest.fn()).then(() => {
      expect(tap).toHaveBeenCalledWith({ kind: 'trip', trip });
    });
  });

  it('reports null when neither a trip nor the mall snapshot covers the position', () => {
    setActiveTrips([makeTrip({ centerLat: 10, centerLng: 10, areaRadius: 5_000 })]); // far away
    mockSearchOsmPlacesStrict.mockResolvedValueOnce({});

    const tap = jest.fn();
    setPlaceContextTap(tap);

    return runProximitySearch('uid-1', [makeTask()], jest.fn()).then(() => {
      expect(tap).toHaveBeenCalledWith(null);
    });
  });
});
