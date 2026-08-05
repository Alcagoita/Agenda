/**
 * KAN-27 / KAN-142 / KAN-153 / KAN-233 — Geo-triggered local notification tests.
 *
 * Architecture after KAN-153:
 *   - Notifications fire inside runProximitySearch when a new POI type enters
 *     the hero zone (< HERO_RADIUS_M = 100 m) for the first time this session.
 *   - No geofence ENTRY *notification* events are needed for the hero card —
 *     the one-shot search handles both display (onUpdate) and notification
 *     delivery for that.
 *
 * Exit-prompt (KAN-233): since the app only has foreground ("when in use")
 * location permission, there's no native OS geofencing. Entry/exit for the
 * exit-prompt is instead detected inside this same search loop — each tick
 * compares distance against getGeofenceRadius(poiType) and hands off to
 * handleGeofenceExit() on a transition to outside.
 *
 * Covers:
 *   - Notification fires when runProximitySearch finds a hero-zone place
 *   - Notification does NOT fire for done tasks / seen-today tasks
 *   - markAllPoiAlertsSeen called for ALL eligible tasks of the POI type
 *   - Android channel created before displayNotification
 *   - NEARBY_RADIUS = 400 m (display threshold, exported constant)
 *   - notif_nearby_enabled = false → no notification
 *   - Quiet hours (10pm–8am) → no notification
 *   - Multiple tasks same POI → one notification, all marked seen
 *   - Singular/plural "thing(s)" in body copy
 *   - a/an article in title ("an ATM" not "a ATM")
 *   - Exit-prompt foreground enter/exit detection (KAN-233)
 */

// ─── Notifee mock ─────────────────────────────────────────────────────────────

const mockCreateChannel       = jest.fn().mockResolvedValue(undefined);
const mockDisplayNotification = jest.fn().mockResolvedValue(undefined);

jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);

// KAN-228 — proximity.ts now fire-and-forgets into the habitat cache, which
// pulls in expo-sqlite (ESM, breaks Jest's transform). Not under test here.
jest.mock('../../src/services/habitatCache');
jest.mock('../../src/services/proximitySnapshot');

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel:       (...args: unknown[]) => mockCreateChannel(...args),
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

// ─── Firebase / service mocks ─────────────────────────────────────────────────

const mockMarkAllPoiAlertsSeen = jest.fn().mockResolvedValue(undefined);
const mockMarkExitPromptSeen   = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/firestore', () => ({
  markAllPoiAlertsSeen: (...args: unknown[]) => mockMarkAllPoiAlertsSeen(...args),
  markPoiAlertSeen:     jest.fn().mockResolvedValue(undefined),
  markExitPromptSeen:   (...args: unknown[]) => mockMarkExitPromptSeen(...args),
}));

const mockGetPosition = jest.fn();
jest.mock('../../src/services/geolocation', () => ({
  getPositionLowAccuracy: (...args: unknown[]) => mockGetPosition(...args),
  requestLocationPermission: jest.fn().mockResolvedValue('granted'),
}));

jest.mock('../../src/config/keys', () => ({
  GOOGLE_PLACES_API_KEY: 'TEST_KEY',
}));

const mockFireExitPrompt = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/notifications', () => ({
  fireExitPrompt: (...args: unknown[]) => mockFireExitPrompt(...args),
}));

jest.mock('../../src/native/WearNotificationModule', () => ({
  sendProximityAlert: jest.fn(),
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
  id: string;
  displayName: { text: string };
  location: { latitude: number; longitude: number };
  types?: string[];
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
  runProximitySearch,
  resetProximityState,
  updateNotifNearbyEnabled,
  updateExitPromptPref,
  isQuietHours,
  NEARBY_RADIUS,
} from '../../src/services/proximity';
import type { Task } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ORIGIN = { lat: 0, lng: 0, accuracy: 10 };

/** ATM ~30 m north — inside HERO_RADIUS_M (100 m). */
const ATM_NEARBY = {
  id:          'atm-1',
  displayName: { text: 'Corner ATM' },
  location:    { latitude: 0.00027, longitude: 0 },
  types:       ['atm'],
};

/** Supermarket ~55 m north — inside HERO_RADIUS_M (100 m). */
const SUPERMARKET_NEARBY = {
  id:          'sm-1',
  displayName: { text: 'Fresh Mart' },
  location:    { latitude: 0.0005, longitude: 0 },
  types:       ['supermarket'],
};

/** ATM ~556 m north — outside NEARBY_RADIUS (400 m). */
const ATM_FAR = {
  id:          'atm-far',
  displayName: { text: 'Faraway ATM' },
  location:    { latitude: 0.005, longitude: 0 },
  types:       ['atm'],
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id:        'task-1',
    title:     'Get cash',
    category:  'errands',
    done:      false,
    poi:       'atm',
    date:      '2026-05-28',
    createdAt: { toDate: () => new Date() } as any,
    ...overrides,
  };
}

/**
 * Flush fire-and-forget notification Promises queued during runProximitySearch.
 * setImmediate runs after all pending microtasks, so all mocked async chains
 * (createChannel → displayNotification → markAllPoiAlertsSeen) are settled.
 */
async function flushAsync(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('geo-triggered notifications', () => {
  beforeEach(() => {
    jest.restoreAllMocks(); // restore any spies from the previous test
    jest.clearAllMocks();
    mockSearchOsmPlacesStrict.mockReset();
    mockGetPosition.mockResolvedValue(ORIGIN);
    resetProximityState();
    updateNotifNearbyEnabled(true);
    updateExitPromptPref(true);
    // Pin the clock to business hours so isQuietHours() never suppresses
    // notifications in tests that don't explicitly test quiet-hours logic.
    jest.spyOn(Date.prototype, 'getHours').mockReturnValue(10);
  });

  // ── NEARBY_RADIUS constant ──────────────────────────────────────────────────

  it('exports NEARBY_RADIUS = 400', () => {
    expect(NEARBY_RADIUS).toBe(400);
  });

  // ── Notification fires on hero entry ────────────────────────────────────────

  it('fires a notification when runProximitySearch finds a hero-zone place (<100 m)', async () => {
    mockPlacesResponse([ATM_NEARBY]);

    await runProximitySearch('uid-1', [makeTask()], jest.fn());
    await flushAsync();

    expect(mockDisplayNotification).toHaveBeenCalledTimes(1);
    const call = mockDisplayNotification.mock.calls[0][0];
    expect(call.title).toContain('ATM');
    expect(call.body).toContain('thing');
  });

  it('creates the Android notification channel before firing', async () => {
    mockPlacesResponse([ATM_NEARBY]);

    await runProximitySearch('uid-1', [makeTask()], jest.fn());
    await flushAsync();

    const createOrder  = mockCreateChannel.mock.invocationCallOrder[0];
    const displayOrder = mockDisplayNotification.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(displayOrder);
  });

  // ── Suppression: done task ───────────────────────────────────────────────────

  it('does NOT fire when all tasks for the POI type are done', async () => {
    mockPlacesResponse([ATM_NEARBY]);

    await runProximitySearch('uid-1', [makeTask({ done: true })], jest.fn());
    await flushAsync();

    expect(mockDisplayNotification).not.toHaveBeenCalled();
  });

  // ── Suppression: seen today ─────────────────────────────────────────────────

  it('does NOT fire when poiAlertSeenDate equals today', async () => {
    const today = new Date().toISOString().split('T')[0];
    mockPlacesResponse([ATM_NEARBY]);

    await runProximitySearch('uid-1', [makeTask({ poiAlertSeenDate: today })], jest.fn());
    await flushAsync();

    expect(mockDisplayNotification).not.toHaveBeenCalled();
  });

  // ── markAllPoiAlertsSeen ────────────────────────────────────────────────────

  it('calls markAllPoiAlertsSeen with all eligible task IDs after firing', async () => {
    mockPlacesResponse([ATM_NEARBY]);
    const today = new Date().toISOString().split('T')[0];

    const tasks = [
      makeTask({ id: 'task-1' }),
      makeTask({ id: 'task-2' }),
    ];

    await runProximitySearch('uid-1', tasks, jest.fn());
    await flushAsync();

    expect(mockMarkAllPoiAlertsSeen).toHaveBeenCalledTimes(1);
    expect(mockMarkAllPoiAlertsSeen).toHaveBeenCalledWith(
      'uid-1',
      expect.arrayContaining(['task-1', 'task-2']),
      today,
    );
  });

  // ── Notification copy format ─────────────────────────────────────────────────

  it('uses "an" before vowel-starting POI labels (e.g. "an ATM")', async () => {
    mockPlacesResponse([ATM_NEARBY]);
    await runProximitySearch('uid-1', [makeTask()], jest.fn());
    await flushAsync();

    const call = mockDisplayNotification.mock.calls[0][0];
    expect(call.title).toBe("You're near an ATM");
  });

  it('uses "a" before consonant-starting POI labels (e.g. "a Market")', async () => {
    const supermarketTask = makeTask({ id: 'sm', poi: 'supermarket', category: 'errands' });
    mockPlacesResponse([SUPERMARKET_NEARBY]);
    await runProximitySearch('uid-1', [supermarketTask], jest.fn());
    await flushAsync();

    const call = mockDisplayNotification.mock.calls[0][0];
    expect(call.title).toBe("You're near a Market");
  });

  it('notification body says "You have N thing(s) to brush away."', async () => {
    mockPlacesResponse([ATM_NEARBY]);
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];
    await runProximitySearch('uid-1', tasks, jest.fn());
    await flushAsync();

    const call = mockDisplayNotification.mock.calls[0][0];
    expect(call.body).toBe('You have 2 things to brush away.');
  });

  it('uses singular "thing" when there is exactly 1 task', async () => {
    mockPlacesResponse([ATM_NEARBY]);
    await runProximitySearch('uid-1', [makeTask()], jest.fn());
    await flushAsync();

    const call = mockDisplayNotification.mock.calls[0][0];
    expect(call.body).toBe('You have 1 thing to brush away.');
  });

  // ── Deep-link payload ────────────────────────────────────────────────────────

  it('data payload is exactly { screen: "Today" } — no taskId or date', async () => {
    mockPlacesResponse([ATM_NEARBY]);
    await runProximitySearch('uid-1', [makeTask({ id: 'task-abc', date: '2026-06-15' })], jest.fn());
    await flushAsync();

    const call = mockDisplayNotification.mock.calls[0][0];
    expect(call.data).toEqual({ screen: 'Today' });
  });

  // ── NEARBY_RADIUS = 400 m (display threshold) ────────────────────────────────

  it('marks a place as nearby when within 400 m and updates onUpdate', async () => {
    const onUpdate = jest.fn();
    mockPlacesResponse([ATM_NEARBY]); // ~30 m, inside hero zone

    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      'atm',
      expect.objectContaining({ name: 'Corner ATM' }),
      expect.any(Object),
    );
  });

  it('does NOT mark a place as nearby when beyond 400 m', async () => {
    const onUpdate = jest.fn();
    mockPlacesResponse([ATM_FAR]); // ~556 m

    await runProximitySearch('uid-1', [makeTask()], onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(null, null, {});
  });

  // ── notif_nearby_enabled = false ────────────────────────────────────────────

  it('does NOT fire when notif_nearby_enabled is false', async () => {
    mockPlacesResponse([ATM_NEARBY]);
    updateNotifNearbyEnabled(false);

    await runProximitySearch('uid-1', [makeTask()], jest.fn());
    await flushAsync();

    expect(mockDisplayNotification).not.toHaveBeenCalled();
  });

  // ── Quiet hours ─────────────────────────────────────────────────────────────

  describe('isQuietHours()', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    it('returns true at 22:00', () => {
      jest.spyOn(Date.prototype, 'getHours').mockReturnValue(22);
      expect(isQuietHours()).toBe(true);
    });

    it('returns true at 03:00', () => {
      jest.spyOn(Date.prototype, 'getHours').mockReturnValue(3);
      expect(isQuietHours()).toBe(true);
    });

    it('returns false at 09:00', () => {
      jest.spyOn(Date.prototype, 'getHours').mockReturnValue(9);
      expect(isQuietHours()).toBe(false);
    });

    it('returns false at 20:00', () => {
      jest.spyOn(Date.prototype, 'getHours').mockReturnValue(20);
      expect(isQuietHours()).toBe(false);
    });
  });

  it('does NOT fire during quiet hours (10pm–8am)', async () => {
    mockPlacesResponse([ATM_NEARBY]);
    jest.spyOn(Date.prototype, 'getHours').mockReturnValue(23);

    await runProximitySearch('uid-1', [makeTask()], jest.fn());
    await flushAsync();

    expect(mockDisplayNotification).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  // ── Exit-prompt foreground dwell detection (KAN-233) ────────────────────────
  //
  // No native OS geofencing (foreground-only location permission). Instead:
  // the first tick where a POI type's nearest place is in the hero zone
  // (< HERO_RADIUS_M) starts a clock. Location is deliberately NOT
  // re-checked during the following EXIT_PROMPT_MIN_DWELL_MS (5 min) —
  // whatever happens in between is ignored. Once that much time has
  // elapsed, the next tick where the place is roughly nearby again (hero
  // zone — no stricter check) fires the prompt directly, with no "left the
  // area" transition required.

  describe('exit-prompt dwell detection', () => {
    const T0 = 1_800_000_000_000; // arbitrary fixed epoch ms

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('does not fire before 5 minutes have passed, even while still close', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(T0);
      mockPlacesResponse([ATM_NEARBY]); // ~30 m — inside the hero zone
      await runProximitySearch('uid-1', [makeTask()], jest.fn());

      jest.spyOn(Date, 'now').mockReturnValue(T0 + 2 * 60 * 1000); // +2 min, still close
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());
      await flushAsync();

      expect(mockFireExitPrompt).not.toHaveBeenCalled();
    });

    it('fires once 5+ minutes have passed and the place is still roughly nearby', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(T0);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());

      jest.spyOn(Date, 'now').mockReturnValue(T0 + 6 * 60 * 1000);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());
      await flushAsync();

      expect(mockFireExitPrompt).toHaveBeenCalledTimes(1);
      const [opts] = mockFireExitPrompt.mock.calls[0];
      expect(opts.taskId).toBe('task-1');
      expect(mockMarkExitPromptSeen).toHaveBeenCalledWith('uid-1', 'task-1', expect.any(String));
    });

    it('does NOT re-check location during the 5-minute window — moving far away mid-window still fires once seen close again after 5 min', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(T0);
      mockPlacesResponse([ATM_NEARBY]); // arrival — clock starts
      await runProximitySearch('uid-1', [makeTask()], jest.fn());

      // Wanders far away 2 minutes in — must NOT reset the clock.
      jest.spyOn(Date, 'now').mockReturnValue(T0 + 2 * 60 * 1000);
      mockPlacesResponse([ATM_FAR]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());
      await flushAsync();
      expect(mockFireExitPrompt).not.toHaveBeenCalled(); // only 2 min elapsed regardless

      // Back close again at +6 min total — clock was never reset, so this
      // already clears the 5-minute mark and fires.
      jest.spyOn(Date, 'now').mockReturnValue(T0 + 6 * 60 * 1000);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());
      await flushAsync();

      expect(mockFireExitPrompt).toHaveBeenCalledTimes(1);
    });

    it('does not fire at a 5+ minute check tick if the place is not close at that exact moment', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(T0);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());

      // Past 5 minutes, but far away right now — must not fire this tick.
      jest.spyOn(Date, 'now').mockReturnValue(T0 + 6 * 60 * 1000);
      mockPlacesResponse([ATM_FAR]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());
      await flushAsync();
      expect(mockFireExitPrompt).not.toHaveBeenCalled();

      // Back close a minute later — the original clock is still intact
      // (never reset), so this fires right away.
      jest.spyOn(Date, 'now').mockReturnValue(T0 + 7 * 60 * 1000);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());
      await flushAsync();

      expect(mockFireExitPrompt).toHaveBeenCalledTimes(1);
    });

    it('a POI type disappearing from results mid-window does not reset the clock', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(T0);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());

      jest.spyOn(Date, 'now').mockReturnValue(T0 + 2 * 60 * 1000);
      mockPlacesResponse([]); // no ATM results at all this tick
      await runProximitySearch('uid-1', [makeTask()], jest.fn());

      jest.spyOn(Date, 'now').mockReturnValue(T0 + 6 * 60 * 1000);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());
      await flushAsync();

      expect(mockFireExitPrompt).toHaveBeenCalledTimes(1);
    });

    it('does not refire on every subsequent tick after already firing once', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(T0);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());

      jest.spyOn(Date, 'now').mockReturnValue(T0 + 6 * 60 * 1000); // fires here
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());
      await flushAsync();
      expect(mockFireExitPrompt).toHaveBeenCalledTimes(1);

      // One minute later, still there — the clock restarted after firing, so
      // this must not fire again immediately.
      jest.spyOn(Date, 'now').mockReturnValue(T0 + 7 * 60 * 1000);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());
      await flushAsync();

      expect(mockFireExitPrompt).toHaveBeenCalledTimes(1);
    });

    it('does not track or fire anything while exitPromptEnabled is false', async () => {
      updateExitPromptPref(false);

      jest.spyOn(Date, 'now').mockReturnValue(T0);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());

      jest.spyOn(Date, 'now').mockReturnValue(T0 + 6 * 60 * 1000);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());
      await flushAsync();

      expect(mockFireExitPrompt).not.toHaveBeenCalled();
    });

    it('re-enabling exitPrompt after being off starts a fresh clock, not a stale one', async () => {
      updateExitPromptPref(false);
      jest.spyOn(Date, 'now').mockReturnValue(T0);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());

      // Re-enable much later — if a stale dwell timer survived, this tick
      // would incorrectly look like it already dwelled ≥5 min.
      updateExitPromptPref(true);
      jest.spyOn(Date, 'now').mockReturnValue(T0 + 6 * 60 * 1000);
      mockPlacesResponse([ATM_NEARBY]); // fresh entry recorded now
      await runProximitySearch('uid-1', [makeTask()], jest.fn());
      await flushAsync();

      expect(mockFireExitPrompt).not.toHaveBeenCalled();
    });

    it('clears tracked dwell state without crashing when there are no undone POI tasks left', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(T0);
      mockPlacesResponse([ATM_NEARBY]);
      await runProximitySearch('uid-1', [makeTask()], jest.fn());

      jest.spyOn(Date, 'now').mockReturnValue(T0 + 6 * 60 * 1000);
      await expect(runProximitySearch('uid-1', [], jest.fn())).resolves.toBeUndefined();
      await flushAsync();

      expect(mockFireExitPrompt).not.toHaveBeenCalled();
    });
  });
});
