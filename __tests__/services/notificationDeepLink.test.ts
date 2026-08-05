/**
 * KAN-28 / KAN-142 — Notification deep-link data payload tests.
 *
 * KAN-142 changed proximity notifications from per-task to per-POI-type.
 * The data payload now contains only `{ screen: 'Today' }` — there is no
 * single taskId or date because one notification covers all tasks of a type.
 *
 * KAN-231 (DECIDED): foreground-only, no native geofences. Notifications now
 * fire from runProximitySearch's own tick logic (proximity.ts) when a POI
 * type enters the hero zone, not from a native OS geofence-crossing event —
 * this file previously drove the (removed) startProximityMonitoring +
 * geolocation startTracking watcher API via a simulated native
 * 'onGeofenceEntry' broadcast, which doesn't exist anymore. Rewritten to
 * call the real one-shot search directly.
 *
 * Covers:
 *   - data.screen is always 'Today' (navigates to the Today screen)
 *   - No taskId or date in the payload (per-type notification, not per-task)
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockCreateChannel       = jest.fn().mockResolvedValue(undefined);
const mockDisplayNotification = jest.fn().mockResolvedValue(undefined);

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel:       (...args: unknown[]) => mockCreateChannel(...args),
    displayNotification: (...args: unknown[]) => mockDisplayNotification(...args),
  },
  AndroidImportance: { HIGH: 4 },
  AndroidStyle:      { BIGTEXT: 'BIGTEXT' },
}));

// KAN-228 — proximity.ts now fire-and-forgets into the habitat cache, which
// pulls in expo-sqlite (ESM, breaks Jest's transform). Not under test here.
jest.mock('../../src/services/habitatCache');
jest.mock('../../src/services/proximitySnapshot');
jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);

jest.mock('react-native', () => ({
  Platform:            { OS: 'android' },
  NativeModules:       { WearNotificationModule: { sendProximityAlert: jest.fn() } },
  InteractionManager:  { runAfterInteractions: (cb: () => void) => cb() },
}));

jest.mock('../../src/services/firestore', () => ({
  markAllPoiAlertsSeen: jest.fn().mockResolvedValue(undefined),
  markPoiAlertSeen:     jest.fn().mockResolvedValue(undefined),
}));

const mockGetPositionLowAccuracy = jest.fn();
jest.mock('../../src/services/geolocation', () => ({
  getPositionLowAccuracy: (...args: unknown[]) => mockGetPositionLowAccuracy(...args),
}));

jest.mock('../../src/services/placesFunctions', () => ({
  searchNearbyPlacesProxy: jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  getPlaceDetailsProxy:    jest.fn(),
}));
jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflareCoverageProxy: jest.fn(),
  cloudflarePoiAllProxy:   jest.fn(),
}));

// live search falls through Cloudflare (unconfigured -> caught -> falls
// through) to OSM — inject the fixture via the OSM mock, same pattern as
// mapsCloudflareRouting.test.ts.
const mockSearchOsmPlacesStrict = jest.fn();
jest.mock('../../src/services/osmPlaces', () => ({
  searchOsmPlacesStrict: (...args: unknown[]) => mockSearchOsmPlacesStrict(...args),
}));

jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedCity: jest.fn(() => ({ hit: false, city: null })),
  putCachedCity: jest.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { runProximitySearch, resetProximityState } from '../../src/services/proximity';
import type { Task } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ORIGIN = { lat: 0, lng: 0, accuracy: 10 };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id:        'task-abc',
    title:     'Get cash',
    category:  'errands',
    done:      false,
    poi:       'atm',
    date:      '2026-05-29',
    createdAt: { toDate: () => new Date() } as any,
    ...overrides,
  };
}

/** ~30m north of ORIGIN — well inside HERO_RADIUS_M (100m). */
function mockNearbyAtm() {
  mockSearchOsmPlacesStrict.mockResolvedValueOnce({
    atm: [{ osmId: 'atm-1', name: 'Corner ATM', isGenericName: false, lat: 0.00027, lng: 0, distanceMeters: 30, footprintAreaM2: 0 }],
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('notification deep-link data payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPositionLowAccuracy.mockResolvedValue(ORIGIN);
    jest.spyOn(Date.prototype, 'getHours').mockReturnValue(10); // outside quiet hours (22-8)
    resetProximityState();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('data payload is exactly { screen: "Today" } — no taskId or date', async () => {
    // KAN-142: one notification covers all tasks of the POI type; the
    // deep-link payload must be exactly { screen: 'Today' } so any drift
    // (new unexpected keys, missing keys) fails this test immediately.
    mockNearbyAtm();

    await runProximitySearch('uid-1', [makeTask({ id: 'task-abc', date: '2026-06-15' })], jest.fn());
    // fireNotification is fire-and-forget (not awaited by runProximitySearch
    // itself) — flush the pending microtask/macrotask queue so its own
    // internal awaits (ensureChannel, displayNotification) land.
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(mockDisplayNotification).toHaveBeenCalledTimes(1);
    const payload = mockDisplayNotification.mock.calls[0][0];
    expect(payload.data).toEqual({ screen: 'Today' });
  });
});
