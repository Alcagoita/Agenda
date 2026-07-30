/**
 * proximity.ts — POI proximity detection engine.
 *
 * Flow:
 *   1. On start: one background Places API search within NEARBY_RADIUS_M.
 *   2. Results split by distance:
 *        < HERO_RADIUS_M   → orange hero card (nearbyPoiType set)
 *        < NEARBY_RADIUS_M → grey "approaching" card (poiPlaces entry)
 *   3. Every POSITION_CHECK_INTERVAL_MS: get device position.
 *      If moved ≥ MIN_MOVEMENT_M from last search origin → re-run search.
 *      This keeps battery impact minimal — the API is never called unless
 *      the user has meaningfully changed location.
 *   4. No native geofences needed for card display — distance is computed
 *      directly from the search results.
 *
 * Notifications (KAN-28):
 *   Fires once when a type transitions INTO the hero zone (< HERO_RADIUS_M).
 *   Suppressed if the type was already alerted today or during quiet hours.
 *
 * Exit-prompt (KAN-119 / KAN-233):
 *   No native OS geofencing — the app only has foreground ("when in use")
 *   location permission. Instead: the first time a POI type's nearest place
 *   is within the hero zone (< HERO_RADIUS_M), a timestamp is recorded.
 *   Location is NOT re-checked during the following EXIT_PROMPT_MIN_DWELL_MS
 *   — whatever happens in between (moving away, the type briefly vanishing
 *   from results) is ignored. Once EXIT_PROMPT_MIN_DWELL_MS has elapsed, the
 *   very next tick where that place is still roughly nearby (hero zone
 *   again — no stricter check needed) fires the prompt. Only fires while
 *   the app is open, matching the rest of this engine's foreground-only
 *   model.
 *
 * Habitat POI cache (KAN-228):
 *   Every successful live search opportunistically feeds the offline habitat
 *   cache (habitatCache.ts) — Google hits seed its cross-source identity
 *   table, and a stale-check triggers a background OSM refresh around the
 *   same origin. Deferred via InteractionManager so the synchronous SQLite
 *   writes never delay this search's own hero-card/notification result.
 *
 * Cache-backed offline proximity (KAN-229):
 *   When a live search fails while offline, the cache answers instead
 *   (queryHabitatCache impersonates searchNearbyPlaces's return shape) and
 *   the search is queued (KAN-205) so a live refresh replaces it on
 *   reconnect. Live results are reconciled against the cache's cross-source
 *   identity table (findExistingPlaceId) before the hero split runs: a
 *   place already known to both sources gets the same internal id
 *   regardless of which one answered, so the Nearby card's carousel and the
 *   exit-prompt's per-place dwell timer don't reset on a source flip. A
 *   place with no cache counterpart yet keeps its own Google placeId
 *   unchanged (never invented — see findExistingPlaceId's docs).
 *
 * Offline expectations messaging (KAN-236):
 *   A cache miss (nothing cached near this position) fires a one-time,
 *   once-per-session toast telling the user they've walked beyond what the
 *   cache knows — but only when the cache has data *somewhere* (hasCachedPlaces).
 *   If the cache is empty everywhere (fresh install/new phone), that's a
 *   different, more persistent state — NetworkBanner handles it directly
 *   (it doesn't need a position, just "is there anything cached at all"), so
 *   this file doesn't duplicate that check into a toast.
 *
 * Learned places (KAN-230):
 *   setLearnedPlaces feeds in the on-device ranking computed elsewhere
 *   (learnedPlaces.ts, from completedPlaceId brush history). The learned
 *   venue only ever affects which PLACE represents the type that already
 *   won the cross-type hero race on true distance — applied strictly after
 *   heroType is locked in, so it can never change WHICH type wins by
 *   inflating the distance used for that comparison. Within the winning
 *   type, its learned venue is preferred as the displayed/notified place
 *   over an arbitrary closer stranger, but only when the learned venue is
 *   itself within HERO_RADIUS_M on its own real distance.
 *
 * Habitat cache prefetch — all POI types (KAN-238):
 *   The habitat cache's OSM-backed refresh (refreshHabitatCacheIfStale) is
 *   fed ALL_POI_TYPES plus the user's custom category place types
 *   (setCustomCategoryPoiTypes), not just this tick's open-task types — a
 *   task created after caching (e.g. "buy aspirin" offline, no prior
 *   pharmacy task) must still find candidates. Only the refresh/seed side
 *   changes; queryHabitatCache and the live Places search both stay
 *   filtered to this tick's actual open-task types, unchanged.
 */

import notifee, { AndroidImportance } from '@notifee/react-native';
import NetInfo from '@react-native-community/netinfo';
import { InteractionManager, Platform } from 'react-native';
import WearNotificationModule from '../native/WearNotificationModule';
import { Coordinates, getPositionLowAccuracy } from './geolocation';
import { getDistanceMeters, searchNearbyPlaces, NearbyPlace, placeTypeLabel } from './maps';
import { markAllPoiAlertsSeen } from './firestore';
import { Task, ALL_POI_TYPES, CLUSTER_LEISURE_TYPES, Trip, MallSnapshot } from '../types';
import { fireExitPrompt } from './notifications';
import { markExitPromptSeen } from './firestore';
import { COPY } from '../constants/copy';
import { todayISO } from '../utils/date';
import { recordLiveResult, refreshHabitatCacheIfStale, queryHabitatCache, findExistingPlaceId, hasCachedPlaces } from './habitatCache';
import { saveProximitySnapshot, loadProximitySnapshot } from './proximitySnapshot';
import { useToastStore } from '../store/toastStore';
import { getLearnedPlaceForPoiType, type LearnedBrand } from './learnedPlaces';
import {
  filterRestaurantPlacesForTasks,
  groupRestaurantPlaceCandidates,
  mergeRestaurantPlaceCandidates,
  parseRestaurantFoodTypeFavouriteName,
  restaurantPlaceMatchesFoodType,
  restaurantTaskFoodType,
  restaurantTaskMatchesPlaceName,
} from './restaurantFoodTypes';

// ─── Error reporting ──────────────────────────────────────────────────────────
//
// Single chokepoint for this module's non-fatal error logging (KAN-215) —
// previously each catch block called console.warn independently. Also the one
// place to wire in real crash/error reporting later.

function reportProximityError(context: string, err: unknown): void {
  console.warn(`[proximity] ${context}`, err);
}

// ─── Geofence ID helpers (exit-prompt, KAN-119) ───────────────────────────────

export function buildGeofenceId(poiType: string, placeId: string): string {
  return `brush_geo_${poiType}_${placeId}`;
}

export function parseGeofenceId(id: string): { poiType: string; placeId: string } | null {
  const prefix = 'brush_geo_';
  if (!id.startsWith(prefix)) { return null; }
  const rest = id.slice(prefix.length);
  const firstUnderscore = rest.indexOf('_');
  if (firstUnderscore === -1) { return null; }
  return {
    poiType: rest.slice(0, firstUnderscore),
    placeId: rest.slice(firstUnderscore + 1),
  };
}

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * All known nearby places per POI type string, ordered nearest-first.
 * A type is present only when ≥1 place was found within NEARBY_RADIUS_M.
 * Includes the hero type's places (< HERO_RADIUS_M) as well as grey-range
 * places (HERO_RADIUS_M–NEARBY_RADIUS_M).
 * Used by NearbyCard to display distance, place name, and "Try another place".
 */
export type PlacesMap = Partial<Record<string, NearbyPlace[]>>;

/**
 * KAN-242 — which place context (if any) the last position fell inside,
 * mall-first per the header context chip's display priority (mall > trip).
 * Distinct from findActiveCacheArea below: that one is a pure boolean
 * cache-routing signal for runProximitySearch, and its trip-then-mall check
 * order doesn't affect behavior (queryHabitatCache never keys off the
 * specific cacheAreaId) — this one's order is a real product requirement.
 */
export type PlaceContext =
  | { kind: 'mall'; snapshot: MallSnapshot }
  | { kind: 'trip'; trip: Trip }
  | null;

/** Callback fired whenever nearby state or place data changes. */
export type ProximityCallback = (
  nearbyPoiType: string | null,
  nearbyPlace:   NearbyPlace | null,
  allPlaces:     PlacesMap,
) => void;

// ─── Constants ────────────────────────────────────────────────────────────────

/** Under this distance: show orange hero card + fire notification. */
const HERO_RADIUS_M = 100;

/** Under this distance: show grey approaching card. Max search radius. */
export const NEARBY_RADIUS = 400; // metres — exported for copy.ts reference

/** How often we check the device position for movement. */
const POSITION_CHECK_INTERVAL_MS = 3 * 60 * 1_000; // 3 minutes

/** Minimum movement from last search origin before re-calling the Places API. */
const MIN_MOVEMENT_M = 200;

/**
 * KAN-285 — how close a persisted snapshot's origin must be to the current
 * position to reuse it instead of re-hitting the Places API on an
 * automatic/incidental re-check (screen mount, app reopen, a same-type task
 * added). Deliberately wider than MIN_MOVEMENT_M's 200m: that constant
 * governs the *background* freshness poll while the app stays open and the
 * user may be actively walking; this one governs "does a persisted result
 * from possibly hours or days ago still basically describe where I am."
 */
const SNAPSHOT_REUSE_RADIUS_M = 500;

/** Notifee Android channel id for proximity alerts. */
const CHANNEL_ID = 'proximity_alerts';

/** Queued searches older than this are discarded when connection returns. */
const QUEUE_STALE_MS = 5 * 60 * 1_000;

// ─── Internal state ───────────────────────────────────────────────────────────

/** Where the last Places API search was run from. Movement gate. */
let _lastSearchCoords: { lat: number; lng: number } | null = null;

/** Sorted, comma-joined POI types the last search covered (KAN-285) — the
 *  "did the POI list change" half of the snapshot-reuse gate. */
let _lastSearchPoiTypesKey: string | null = null;

/** Currently active orange-hero POI type. Null when nothing is < HERO_RADIUS_M. */
let _currentNearbyType: string | null = null;

/** Every POI type with ≥1 place within NEARBY_RADIUS_M from the last search —
 *  the same set NearbyCard's hero+grey lists are built from (KAN-279). */
let _lastAllPlaces: PlacesMap = {};

/** Count of undone POI tasks from the last search call. Detects new POI tasks. */
let _prevUndonePoiTaskCount = 0;

/**
 * POI types that have already triggered a notification today.
 * Prevents re-firing on every re-search when the user stays close.
 */
const _alertedTodayTypes = new Set<string>();

/** Guards against concurrent search calls. */
let _isSearching = false;

/** KAN-236 — the "you've moved beyond cached coverage" toast fires at most once per session. */
let _offlineUncoveredNoticeShown = false;

/**
 * KAN-244 — how many times the coverage toast has shown the Trip Planner
 * invitation variant (copy + "Show me" action) rather than the plain
 * apology. Deliberately NOT reset by resetProximityState() (sign-out/day
 * boundary) — an invitation repeated forever becomes marketing, so the cap
 * must survive across sessions within the same app install, unlike the
 * once-per-session `_offlineUncoveredNoticeShown` flag above. Resets only
 * on a fresh app process (no local-persistence layer exists in this app
 * yet to survive a full restart — acceptable for this ticket's scope).
 */
let _coverageInvitationShownCount = 0;

/** KAN-244 — invitation variant shows at most this many times (lifetime), then reverts to the plain apology copy. */
export const COVERAGE_INVITATION_LIFETIME_CAP = 3;

/** KAN-244 — pure cap check, exported for unit testing in isolation. */
export function shouldShowCoverageInvitation(invitationShownCount: number): boolean {
  return invitationShownCount < COVERAGE_INVITATION_LIFETIME_CAP;
}

/** KAN-230 — on-device learned-place ranking, fed in from outside (see setLearnedPlaces). */
let _learnedPlaces: LearnedBrand[] = [];

/** KAN-238 — user's custom category place types, fed in from outside (see setCustomCategoryPoiTypes). */
let _customCategoryPoiTypes: string[] = [];

/** KAN-237 — active trip areas, fed in from outside (see setActiveTrips). Used only to decide cache-first coverage, never for trip-specific business logic. */
let _activeTrips: Trip[] = [];

/** KAN-237 — the current mall snapshot, if any, fed in from outside (see setMallSnapshot). */
let _mallSnapshot: MallSnapshot | null = null;

/**
 * Optional tap into the GPS stream (KAN-75 indoor detection).
 * Every position fix is forwarded here so indoor detection can run without
 * a competing GPS watcher.
 */
let _locationTap: ((lat: number, lng: number, accuracy: number) => void) | null = null;

/** Whether nearby-POI notifications are enabled (KAN-142). */
let notifNearbyEnabled = true;

/** Whether exit-prompt notifications are enabled. */
let exitPromptEnabled = true;

/** User-saved POI radius preferences (KAN-25). */
let poiRadiusPrefs: Record<string, number> = {};

// ─── Offline queue (KAN-205) ──────────────────────────────────────────────────

type PendingSearch = {
  uid:         string;
  tasks:       Task[];
  onUpdate:    ProximityCallback;
  enqueuedAt:  number;
};

let _pendingQueue:        PendingSearch[]  = [];
let _netInfoUnsubscribe:  (() => void) | null = null;

function _ensureNetInfoListener(): void {
  if (_netInfoUnsubscribe) { return; }
  _netInfoUnsubscribe = NetInfo.addEventListener(state => {
    if (state.isConnected) {
      void _flushQueue().catch(err => reportProximityError('flush failed', err));
    }
  });
}

async function _flushQueue(): Promise<void> {
  const now   = Date.now();
  // Snapshot + clear before iterating so new enqueues during flush go to a fresh queue.
  const snapshot = _pendingQueue.filter(e => now - e.enqueuedAt < QUEUE_STALE_MS);
  _pendingQueue  = [];

  for (const entry of snapshot) {
    if (_isSearching) {
      // Search engine busy — restore remaining entries and retry after current search.
      _pendingQueue.unshift(entry, ...(snapshot.slice(snapshot.indexOf(entry) + 1)));
      setTimeout(
        () => void _flushQueue().catch(err => reportProximityError('flush retry failed', err)),
        250,
      );
      return;
    }
    try {
      await runProximitySearch(entry.uid, entry.tasks, entry.onUpdate);
    } catch (err) {
      reportProximityError('flush entry failed', err);
      // Don't re-enqueue — runProximitySearch already re-enqueues on offline.
    }
  }

  // Tear down listener when queue is fully drained.
  if (_pendingQueue.length === 0) {
    _netInfoUnsubscribe?.();
    _netInfoUnsubscribe = null;
  }
}

function _enqueueSearch(uid: string, tasks: Task[], onUpdate: ProximityCallback): void {
  _pendingQueue.push({ uid, tasks, onUpdate, enqueuedAt: Date.now() });
  _ensureNetInfoListener();
}

// ─── Foreground geofence state (exit-prompt only, KAN-119 / KAN-233) ─────────

const geofenceEntryTimes = new Map<string, number>();
const EXIT_PROMPT_MIN_DWELL_MS = 5 * 60 * 1_000;

// ─── Public flag helpers ──────────────────────────────────────────────────────

export function updateNotifNearbyEnabled(enabled: boolean): void {
  notifNearbyEnabled = enabled;
}

/** KAN-230 — feed in the on-device learned-place ranking. Pass null/empty to clear (e.g. on sign-out). */
export function setLearnedPlaces(places: LearnedBrand[] | null): void {
  _learnedPlaces = places ?? [];
}

/** KAN-238 — feed in the user's custom category place types for the habitat cache's all-types prefetch. */
export function setCustomCategoryPoiTypes(types: string[] | null): void {
  _customCategoryPoiTypes = types ?? [];
}

/** KAN-237 — feed in the user's active (unexpired) trip areas, for cache-first coverage. Pass null/empty to clear (e.g. on sign-out). */
export function setActiveTrips(trips: Trip[] | null): void {
  _activeTrips = trips ?? [];
}

/** KAN-237 — feed in the current mall snapshot (or null when there isn't one / the toggle is off), for cache-first coverage. */
export function setMallSnapshot(snapshot: MallSnapshot | null): void {
  _mallSnapshot = snapshot;
}

export function updateExitPromptPref(enabled: boolean): void {
  exitPromptEnabled = enabled;
  if (!enabled) {
    // Don't let a stale dwell timer (accrued while disabled) resurrect an
    // exit prompt the instant the user re-enables the setting.
    geofenceEntryTimes.clear();
  }
}

export function updateProximityPoiPreferences(prefs: Record<string, number>): void {
  poiRadiusPrefs = prefs;
  // Force a re-search on next position check by resetting the movement gate.
  _lastSearchCoords = null;
}

export function isQuietHours(): boolean {
  const hour = new Date().getHours();
  return hour >= 22 || hour < 8;
}

// ─── Notification channel ─────────────────────────────────────────────────────

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') { return; }
  await notifee.createChannel({
    id:         CHANNEL_ID,
    name:       'Nearby Task Alerts',
    importance: AndroidImportance.HIGH,
    sound:      'default',
    vibration:  true,
  });
}

async function fireNotification(poiLabel: string, taskCount: number): Promise<void> {
  await ensureChannel();
  await notifee.displayNotification({
    title: COPY.notification.proximityTitle(poiLabel),
    body:  COPY.notification.proximityBody(taskCount),
    data:  { screen: 'Today' },
    android: {
      channelId:   CHANNEL_ID,
      importance:  AndroidImportance.HIGH,
      pressAction: { id: 'default' },
    },
    ios: { sound: 'default' },
  });

  if (Platform.OS === 'android') {
    WearNotificationModule?.sendProximityAlert(
      COPY.notification.proximityTitle(poiLabel),
      COPY.notification.proximityBody(taskCount),
      '',
    );
  }
}

// ─── Exit-prompt geofence handler (KAN-119) ───────────────────────────────────

export async function handleGeofenceExit(
  geofenceId: string,
  uid: string,
  tasks: Task[],
): Promise<void> {
  const entryTime = geofenceEntryTimes.get(geofenceId);
  geofenceEntryTimes.delete(geofenceId);

  if (!exitPromptEnabled) { return; }
  if (!entryTime || Date.now() - entryTime < EXIT_PROMPT_MIN_DWELL_MS) { return; }

  const parsed = parseGeofenceId(geofenceId);
  if (!parsed) { return; }

  const { poiType } = parsed;
  const today = todayISO();
  const task  = tasks.find(t => !t.done && t.poi === poiType && t.exitPromptSeenDate !== today);
  if (!task) { return; }

  try {
    await fireExitPrompt({ taskId: task.id, taskTitle: task.title });
    await markExitPromptSeen(uid, task.id, today);
  } catch (err) {
    reportProximityError('exit prompt failed', err);
  }
}

/**
 * Foreground dwell check for exit-prompt (KAN-233). The first time a POI
 * type's nearest place is in the hero zone (< HERO_RADIUS_M), records a
 * timestamp and stops — location is deliberately NOT re-checked on every
 * tick during the following EXIT_PROMPT_MIN_DWELL_MS. Once that much time
 * has elapsed, the next tick where the same place is roughly nearby again
 * (hero zone — no stricter distance check) fires the prompt directly, with
 * no "left the area" transition required.
 */
function trackExitPromptGeofence(
  poiType: string,
  nearest: NearbyPlace | null,
  uid: string,
  tasks: Task[],
): void {
  if (!exitPromptEnabled || !nearest || nearest.distanceMeters >= HERO_RADIUS_M) { return; }

  const geofenceId = buildGeofenceId(poiType, nearest.placeId);
  const entryTime = geofenceEntryTimes.get(geofenceId);

  if (!entryTime) {
    geofenceEntryTimes.set(geofenceId, Date.now()); // first sighting — start the clock
    return;
  }

  if (Date.now() - entryTime < EXIT_PROMPT_MIN_DWELL_MS) { return; }

  // handleGeofenceExit does its own entryTime lookup + deletion — don't
  // delete it here first, or its internal check finds nothing and no-ops.
  handleGeofenceExit(geofenceId, uid, tasks).catch(err =>
    reportProximityError('dwell-prompt check failed', err),
  );
}

// ─── Cache-first coverage (KAN-237) ───────────────────────────────────────────

/**
 * Returns the cacheAreaId to query if `lat`/`lng` falls inside an active
 * (unexpired) trip area or the current mall snapshot — trip areas checked
 * first, mall snapshot second (arbitrary but stable order; the two are never
 * expected to overlap in practice). Returns null if neither applies, meaning
 * the caller should fall through to the normal live-API-first flow.
 *
 * Deliberately narrow: only these two deliberately-downloaded, bounded areas
 * trigger cache-first. The opportunistic habitat pool (KAN-228/229) is
 * unaffected — it still only answers on a live-search failure, same as
 * before this ticket.
 */
function findActiveCacheArea(lat: number, lng: number): string | null {
  const now = Date.now();
  for (const trip of _activeTrips) {
    if (trip.expiresAt < now) { continue; }
    if (getDistanceMeters(lat, lng, trip.centerLat, trip.centerLng) <= trip.areaRadius) {
      return trip.cacheAreaId;
    }
  }
  if (_mallSnapshot && _mallSnapshot.expiresAt >= now) {
    if (getDistanceMeters(lat, lng, _mallSnapshot.centerLat, _mallSnapshot.centerLng) <= _mallSnapshot.radius) {
      return _mallSnapshot.cacheAreaId;
    }
  }
  return null;
}

/** KAN-246 — the active off-grid window, if any (not yet expired). At most one is expected — the setup flow doesn't allow starting a second while one is active. */
function getActiveOffGridTrip(now: number = Date.now()): Trip | null {
  return _activeTrips.find(t => t.kind === 'offgrid' && t.expiresAt >= now) ?? null;
}

/**
 * KAN-246 — exposes the active off-grid window (destination label + expiry)
 * for the ContextChip, independent of exact position (shown whenever the
 * window is active, not just while physically inside its area).
 */
export function getActiveOffGridWindow(): { destination: string; expiresAt: number } | null {
  const trip = getActiveOffGridTrip();
  return trip ? { destination: trip.destination, expiresAt: trip.expiresAt } : null;
}

/**
 * KAN-245 — "does the app already know this area?" Broader than
 * findActiveCacheArea above (trip/mall bounded downloads only): also true
 * for any point within the ambient habitat pool (KAN-228/229) — anywhere
 * the user has organically used the app, not just paid/downloaded areas.
 * This is the same "known" the coverage-invitation toast (KAN-236/244)
 * means by "the area I know by heart," just location-scoped instead of
 * evaluated at the current position.
 */
export function isLocationKnown(lat: number, lng: number): boolean {
  if (findActiveCacheArea(lat, lng) !== null) { return true; }
  const nearby = queryHabitatCache(lat, lng, ALL_POI_TYPES);
  return Object.values(nearby).some(places => places.length > 0);
}

/** KAN-242 — see PlaceContext's doc comment for why this mall-first order is distinct from findActiveCacheArea's above. */
function findActivePlaceContext(lat: number, lng: number): PlaceContext {
  const now = Date.now();
  if (_mallSnapshot && _mallSnapshot.expiresAt >= now &&
      getDistanceMeters(lat, lng, _mallSnapshot.centerLat, _mallSnapshot.centerLng) <= _mallSnapshot.radius) {
    return { kind: 'mall', snapshot: _mallSnapshot };
  }
  for (const trip of _activeTrips) {
    if (trip.expiresAt < now) { continue; }
    if (getDistanceMeters(lat, lng, trip.centerLat, trip.centerLng) <= trip.areaRadius) {
      return { kind: 'trip', trip };
    }
  }
  return null;
}

let _placeContextTap: ((ctx: PlaceContext) => void) | null = null;

/** KAN-304 — the place context resolved at the last position fix. Read at brush
 *  time to stamp the active trip id onto a completed task. */
let _lastPlaceContext: PlaceContext = null;

/** The mall/trip context (or null) from the last position fix. */
export function getActivePlaceContext(): PlaceContext {
  return _lastPlaceContext;
}

/**
 * KAN-242 — register a tap fired with the resolved place context on every
 * position fix taken by runProximitySearch, independent of onUpdate/
 * ProximityCallback (mirrors setLocationTap below). Feeds the header context
 * chip without changing ProximityCallback's signature or any of its existing
 * call-site tests. Pass null to unregister.
 */
export function setPlaceContextTap(cb: ((ctx: PlaceContext) => void) | null): void {
  _placeContextTap = cb;
}

/**
 * KAN-244 — navigates to the Trip Planner flow from the coverage-invitation
 * toast action. Injected via setNavigateToTripPlanner rather than importing
 * navigationRef directly — this file must stay usable from plain Jest unit
 * tests that only stub `react-native`'s bare essentials, and importing
 * `@react-navigation/native` here would pull its full theming/container code
 * into every test that touches this module. Pass null to unregister.
 */
let _navigateToTripPlanner: (() => void) | null = null;

export function setNavigateToTripPlanner(cb: (() => void) | null): void {
  _navigateToTripPlanner = cb;
}

// ─── Core: one-shot proximity search ─────────────────────────────────────────

/**
 * Get current position, search Places API for all needed POI types within
 * NEARBY_RADIUS_M, split results by distance, and fire onUpdate.
 *
 * Non-blocking: always called as fire-and-forget (`.catch` at call sites).
 * Returns immediately if a search is already in progress.
 */
async function runProximitySearch(
  uid: string,
  tasks: Task[],
  onUpdate: ProximityCallback,
  presetCoords?: Coordinates,
): Promise<void> {
  if (_isSearching) { return; }
  _isSearching = true;

  try {
    // KAN-285 review fix — runProximitySearchOrReuseSnapshot's fallback path
    // already has a position fix by the time it falls through here; passing
    // it through avoids a second GPS read for the same tick.
    const coords = presetCoords ?? await getPositionLowAccuracy();

    const undonePoiTasks = tasks.filter(t => !t.done && t.poi != null);
    const uniquePoiTypes = [...new Set(undonePoiTasks.map(t => t.poi as string))];
    const poiTypesKey = [...uniquePoiTypes].sort().join(',');

    if (uniquePoiTypes.length === 0) {
      _locationTap?.(coords.lat, coords.lng, coords.accuracy);
      _lastPlaceContext = findActivePlaceContext(coords.lat, coords.lng);
      _placeContextTap?.(_lastPlaceContext);
      _currentNearbyType = null;
      _lastAllPlaces = {};
      // No undone POI tasks left to prompt for — nothing to fire, just
      // clear any in-progress dwell tracking.
      geofenceEntryTimes.clear();
      onUpdate(null, null, {});
      _lastSearchCoords = { lat: coords.lat, lng: coords.lng };
      _lastSearchPoiTypesKey = poiTypesKey;
      return;
    }

    // One API call covers all POI types.
    let results: Record<string, NearbyPlace[]> = {};
    let answeredFromCache = false;
    // True only for the "live call failed, falling back to cache" path below
    // — distinct from the KAN-237 cache-first hit, where an empty result is
    // a confident "nothing here" (the snapshot was downloaded specifically
    // to answer this), not an ambiguous cache-miss to bail out on.
    let isConnectivityFallback = false;

    // KAN-237 — inside an active trip area or the current mall snapshot,
    // skip the live API entirely: this is a deliberately-downloaded, bounded
    // area, so the cache is trusted the same way the offline fallback below
    // already trusts it, without needing a failed live call first.
    const cacheAreaId = findActiveCacheArea(coords.lat, coords.lng);
    if (cacheAreaId != null) {
      results = queryHabitatCache(coords.lat, coords.lng, uniquePoiTypes, NEARBY_RADIUS);
      answeredFromCache = true;
    } else {
      try {
        results = await searchNearbyPlaces(coords.lat, coords.lng, uniquePoiTypes, NEARBY_RADIUS);
      } catch (err) {
        // If offline, queue this search for retry when connection returns, and
        // answer from the habitat cache in the meantime (KAN-229) — the cache
        // impersonates the Places response, so hero split, notification,
        // exit-prompt and wear alert all run unchanged below. Otherwise
        // (timeout, API error while online) keep showing whatever was shown
        // before.
        reportProximityError('searchNearbyPlaces failed', err);
        // Same offline predicate as NetworkBanner — isConnected===true but
        // isInternetReachable===false (captive portal, no real internet) must
        // still fall back to the cache, not sit on a silent "keep showing
        // what's there" state that never resolves.
        let offline = false;
        try {
          const state = await NetInfo.fetch();
          offline = state.isConnected === false || state.isInternetReachable === false;
        } catch { /* treat as unknown — not offline */ }
        if (!offline) { return; }

        _enqueueSearch(uid, tasks, onUpdate);
        results = queryHabitatCache(coords.lat, coords.lng, uniquePoiTypes, NEARBY_RADIUS);
        answeredFromCache = true;
        isConnectivityFallback = true;
      }
    }

    _lastSearchCoords = { lat: coords.lat, lng: coords.lng };

    // A cache miss (nothing cached for this area yet) is not the same as
    // "nothing nearby" — it just means this tick has no answer. Bail out
    // before onUpdate so whatever hero/grey state was already on screen
    // (and any in-progress exit-prompt dwell clock) survives untouched; the
    // search stays queued above for a live retry on reconnect. Only applies
    // to the connectivity-fallback path — a KAN-237 cache-first empty result
    // is a confident "nothing here," not an ambiguous miss, so it proceeds
    // through to onUpdate normally (hero clears like any other empty tick).
    //
    // KAN-246 note: this also means an active off-grid window already
    // suppresses the toast below for free — off-grid windows are stored as
    // Trip docs, so findActiveCacheArea (above) already routes any position
    // inside one through the cache-first branch, which never reaches here.
    // No dedicated off-grid check needed; see proximityOfflineCache.test.ts's
    // "off-grid window suppresses the coverage toast" suite for the proof.
    if (isConnectivityFallback && uniquePoiTypes.every(t => (results[t] ?? []).length === 0)) {
      // KAN-236 — only worth telling the user if the cache has data
      // *somewhere* (they've genuinely walked past its coverage); if it's
      // empty everywhere, NetworkBanner's own "still learning your area"
      // copy already covers that — no need to also fire a toast for it.
      if (!_offlineUncoveredNoticeShown && hasCachedPlaces()) {
        _offlineUncoveredNoticeShown = true;
        // KAN-244 — the user who just felt the offline gap is the most
        // receptive audience for the fix: teach it instead of just
        // apologizing, up to the lifetime cap, then fall back to the
        // plain copy so the invitation doesn't repeat forever.
        if (shouldShowCoverageInvitation(_coverageInvitationShownCount)) {
          _coverageInvitationShownCount += 1;
          useToastStore.getState().showToast(COPY.offline.uncoveredAreaInvitationToast, {
            label: COPY.offline.uncoveredAreaInvitationAction,
            onPress: () => _navigateToTripPlanner?.(),
          });
        } else {
          useToastStore.getState().showToast(COPY.offline.uncoveredAreaToast);
        }
      }
      return;
    }

    // Habitat cache (KAN-228): seed the cross-source identity table with
    // these live Google hits, and opportunistically refresh the OSM-backed
    // cache around this origin. Deferred until after interactions settle —
    // the seeding loop's synchronous SQLite writes must not delay the
    // hero-card/notification logic below, which needs this tick's result now.
    // Skipped when this tick was itself answered by the cache — there's no
    // new live data to feed back into it.
    if (!answeredFromCache) {
      InteractionManager.runAfterInteractions(() => {
        try {
          for (const poiType of uniquePoiTypes) {
            for (const place of results[poiType] ?? []) {
              recordLiveResult({
                poiType,
                name:          place.name,
                lat:           place.lat,
                lng:           place.lng,
                googlePlaceId: place.placeId,
              });
            }
          }
          // KAN-238 — refresh ALL built-in types + the user's custom
          // category types, not just this tick's open-task types
          // (uniquePoiTypes), so a task created after caching (no prior
          // task of that type) still finds cached candidates offline.
          // KAN-282 — also shopping_mall, so "One trip for all of these"
          // can find a nearby mall purely from the offline cache once the
          // area's been visited even once, no live call needed at check time.
          // KAN-293 — and the leisure/cultural types the cluster box may
          // mention. Same single Overpass request: searchOsmPlaces emits one
          // clause per type into one query, so these ride along at the cost
          // of a few extra clauses, never an extra round-trip.
          const prefetchTypes = [...new Set([
            ...ALL_POI_TYPES, ..._customCategoryPoiTypes, 'shopping_mall', ...CLUSTER_LEISURE_TYPES,
          ])];
          refreshHabitatCacheIfStale(coords.lat, coords.lng, prefetchTypes).catch(err =>
            reportProximityError('habitat cache refresh failed', err),
          );
        } catch (err) {
          reportProximityError('habitat cache seed failed', err);
        }
      });
    }

    processProximityTick(uid, tasks, undonePoiTasks, uniquePoiTypes, poiTypesKey, coords, results, answeredFromCache, onUpdate);
  } finally {
    _isSearching = false;
  }
}

/**
 * Shared result-processing path (KAN-285 review fix): location-context taps,
 * hero/grey split, KAN-230 learned-place preference, notification
 * eligibility, exit-prompt dwell tracking, firing onUpdate, and persisting
 * the new snapshot — everything a proximity tick is responsible for once it
 * has per-type place candidates and a position, regardless of where those
 * candidates came from.
 *
 * Used by both runProximitySearch (fresh live/cache results) and
 * runProximitySearchOrReuseSnapshot's reuse path (candidates recovered from
 * a persisted snapshot, with distances recomputed against the CURRENT
 * position) — reusing a snapshot must never mean skipping this. Only the
 * "hit the Places API" step is what the snapshot actually saves.
 */
function processProximityTick(
  uid: string,
  tasks: Task[],
  undonePoiTasks: Task[],
  uniquePoiTypes: string[],
  poiTypesKey: string,
  coords: { lat: number; lng: number; accuracy?: number },
  results: Record<string, NearbyPlace[]>,
  answeredFromCache: boolean,
  onUpdate: ProximityCallback,
): void {
  _locationTap?.(coords.lat, coords.lng, coords.accuracy ?? 0);
  // Store before tapping so getActivePlaceContext() (task completion's
  // completedTripId stamp) reads this tick's context, not a stale one — the
  // empty-POI branch above does the same.
  _lastPlaceContext = findActivePlaceContext(coords.lat, coords.lng);
  _placeContextTap?.(_lastPlaceContext);

  // Split results: orange hero (< 100 m) vs. grey approaching (100–400 m).
  let heroType:  string | null = null;
  let heroPlace: NearbyPlace | null = null;
  let heroDistance = Infinity;
  const allPlaces: PlacesMap = {};

  for (const poiType of uniquePoiTypes) {
    const rawPlaces = results[poiType] ?? [];
    const restaurantGroups = groupRestaurantPlaceCandidates(poiType, rawPlaces, undonePoiTasks);
    const places = poiType === 'restaurant'
      ? mergeRestaurantPlaceCandidates(restaurantGroups)
      : filterRestaurantPlacesForTasks(poiType, rawPlaces, undonePoiTasks);

    // Reconcile live results against the cache's cross-source identity
    // (KAN-229): a place already known to both Google and the OSM cache
    // gets its stable internal id instead of this tick's raw Google
    // placeId, so a later source flip (cache ↔ live) doesn't look like a
    // different place downstream (exit-prompt dwell clock, hero card's
    // carousel). A place with no cache counterpart yet keeps its own
    // Google placeId — findExistingPlaceId never invents a new identity.
    //
    // Only the nearest place is reconciled here (one sync SQLite read per
    // type, not per place) — that's the only one trackExitPromptGeofence
    // and a potential heroPlace ever look at. The rest of a type's list
    // only matters once we know it's the hero type and its carousel is
    // actually shown — reconciled in a second pass below.
    let nearest = places[0] ?? null;
    if (!answeredFromCache && nearest) {
      const existingId = findExistingPlaceId(poiType, nearest.name, nearest.lat, nearest.lng);
      if (existingId) { nearest = { ...nearest, placeId: existingId }; }
    }

    // Exit-prompt dwell check runs for every type regardless of the
    // display threshold below. A type with zero results this tick is
    // simply skipped here (nothing to check) — an in-progress dwell clock
    // is left untouched, not reset; see trackExitPromptGeofence's docs.
    trackExitPromptGeofence(poiType, nearest, uid, tasks);

    if (!nearest) { continue; }

    const dist = nearest.distanceMeters;
    if (dist >= NEARBY_RADIUS) { continue; }

    // Store all places within NEARBY_RADIUS, ordered nearest-first (index
    // 0 already reconciled above; the rest keep their raw ids for now).
    allPlaces[poiType] = [nearest, ...places.slice(1)];

    // Closest place under HERO_RADIUS_M wins the orange hero. Decided on
    // the TRUE nearest distance only — KAN-230's learned-place preference
    // (below) must never influence which TYPE wins the cross-type race,
    // only which specific PLACE represents the type that already won.
    const heroCandidateLists = poiType === 'restaurant'
      ? restaurantGroups.map(group => group.places)
      : [places];
    for (const candidates of heroCandidateLists) {
      const candidateNearest = candidates[0];
      if (!candidateNearest) { continue; }
      const candidateDist = candidateNearest.distanceMeters;
      if (candidateDist < HERO_RADIUS_M && candidateDist < heroDistance) {
        heroType     = poiType;
        heroPlace    = candidateNearest;
        heroDistance = candidateDist;
      }
    }
  }

  // Reconcile the rest of the hero type's carousel now that it's known —
  // NearbyCard's "Try another place" carousel only ever shows the winning
  // hero type's list, so there's no reason to pay for the other ≤4 places
  // of every non-hero type too.
  if (!answeredFromCache && heroType !== null) {
    const winningType = heroType;
    allPlaces[winningType] = (allPlaces[winningType] ?? []).map((place, i) => {
      if (i === 0) { return place; } // already reconciled above
      const existingId = findExistingPlaceId(winningType, place.name, place.lat, place.lng);
      return existingId ? { ...place, placeId: existingId } : place;
    });
  }

  // KAN-230 — now that the hero type is locked in on true distance alone,
  // see if ITS OWN learned venue (≥3 brushes) is among its candidates and
  // still within HERO_RADIUS_M on its own real distance. If so, prefer it
  // as the displayed/notified place for this type — "top priority" only
  // ever affects which place represents the type that already won, never
  // which type wins. Non-hero (grey) types are left alone: nothing to
  // prioritize for a type that isn't being shown as the hero anyway.
  if (heroType !== null) {
    const winningType = heroType;
    const learnedForType = getLearnedPlaceForPoiType(_learnedPlaces, winningType);
    const currentPlaces = allPlaces[winningType] ?? [];
    const learnedFoodType = winningType === 'restaurant' && learnedForType
      ? parseRestaurantFoodTypeFavouriteName(learnedForType.name)
      : null;
    const hasExplicitRestaurantFoodType = winningType === 'restaurant' &&
      undonePoiTasks.some(t => t.poi === 'restaurant' && restaurantTaskFoodType(t) != null);
    // KAN-304 — prefer the learned BRAND (by name), not a specific place id, so
    // any branch of the user's preferred brand represents the type.
    if (learnedFoodType && !hasExplicitRestaurantFoodType) {
      for (const candidate of currentPlaces) {
        if (
          restaurantPlaceMatchesFoodType(candidate.name, learnedFoodType) &&
          candidate.distanceMeters < HERO_RADIUS_M
        ) {
          allPlaces[winningType] = [candidate, ...currentPlaces.filter(p => p !== candidate)];
          heroPlace = candidate;
          break;
        }
      }
    } else if (learnedForType && !learnedFoodType && currentPlaces[0]?.name !== learnedForType.name) {
      for (const candidate of currentPlaces.slice(1)) {
        if (candidate.name === learnedForType.name && candidate.distanceMeters < HERO_RADIUS_M) {
          allPlaces[winningType] = [candidate, ...currentPlaces.filter(p => p !== candidate)];
          heroPlace = candidate;
          break;
        }
      }
    }
  }

  // Fire notification when a new type enters the hero zone.
  if (heroType !== null && heroType !== _currentNearbyType) {
    const today    = todayISO();
    const eligible = undonePoiTasks.filter(
      t => t.poi === heroType &&
        t.poiAlertSeenDate !== today &&
        (!heroPlace || restaurantTaskMatchesPlaceName(t, heroPlace.name)),
    );
    if (
      eligible.length > 0 &&
      notifNearbyEnabled &&
      !isQuietHours() &&
      !_alertedTodayTypes.has(heroType)
    ) {
      _alertedTodayTypes.add(heroType);
      fireNotification(placeTypeLabel(heroType), eligible.length).catch(err =>
        reportProximityError('notification failed', err),
      );
      markAllPoiAlertsSeen(uid, eligible.map(t => t.id), today).catch(err =>
        reportProximityError('markAllPoiAlertsSeen failed', err),
      );
    }
  }

  // Reset today-alert tracking when hero clears (user walked away).
  if (heroType === null && _currentNearbyType !== null) {
    _alertedTodayTypes.delete(_currentNearbyType);
  }

  _currentNearbyType = heroType;
  _lastAllPlaces = allPlaces;
  _lastSearchPoiTypesKey = poiTypesKey;
  _lastSearchCoords = { lat: coords.lat, lng: coords.lng };
  onUpdate(heroType, heroPlace, allPlaces);
  // KAN-285 — persist so the next automatic check (screen mount, app
  // reopen) can reuse this instead of re-hitting the Places API when
  // neither condition (moved >500m, POI types changed) actually holds.
  saveProximitySnapshot(uid, {
    lat: coords.lat, lng: coords.lng, poiTypesKey,
    nearbyPoiType: heroType, nearbyPlace: heroPlace, poiPlaces: allPlaces,
  });
}

// ─── Position check (runs on 3-minute timer) ──────────────────────────────────

async function checkPositionAndMaybeSearch(
  uid: string,
  getLatestTasks: () => Task[],
  onUpdate: ProximityCallback,
): Promise<void> {
  let coords: Coordinates;
  try {
    coords = await getPositionLowAccuracy();
  } catch {
    return; // location unavailable — skip this tick silently
  }

  _locationTap?.(coords.lat, coords.lng, coords.accuracy);

  // Always search on first tick (no previous origin).
  if (!_lastSearchCoords) {
    await runProximitySearch(uid, getLatestTasks(), onUpdate);
    return;
  }

  const moved = getDistanceMeters(
    coords.lat, coords.lng,
    _lastSearchCoords.lat, _lastSearchCoords.lng,
  );

  if (moved >= MIN_MOVEMENT_M) {
    await runProximitySearch(uid, getLatestTasks(), onUpdate);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a one-shot proximity search.
 *
 * Gets the device position, queries the Places API for all POI types needed by
 * the given tasks, splits results by distance (hero < 100 m, grey 100–400 m),
 * fires a notification on first hero entry, and calls onUpdate with the results.
 *
 * Guards against concurrent calls with an internal flag — safe to call from
 * multiple places (effect, task-add trigger, movement poll) without risk of
 * duplicate in-flight searches.
 *
 * Called directly by useTodayScreen — no monitoring lifecycle needed here.
 */
export { runProximitySearch };

/**
 * KAN-285 — entry point for an *automatic* proximity check: screen mount,
 * app reopen, or a same-type task being added. Reuses a persisted snapshot
 * instead of calling runProximitySearch (and therefore the Places API — or
 * even the offline habitat cache) when NEITHER of the two things that would
 * make the snapshot wrong has happened: the position hasn't moved more than
 * SNAPSHOT_REUSE_RADIUS_M from the snapshot's origin, and the set of open
 * POI-task types is identical to what that snapshot covered.
 *
 * Deliberately NOT used by runProximitySearch's other callers — the
 * periodic movement-poll timer (already gates itself on MIN_MOVEMENT_M) and
 * the explicit manual "refresh location" action (an intentional request for
 * a fresh check, not an incidental one) both call runProximitySearch
 * directly and always hit the real path.
 */
export async function runProximitySearchOrReuseSnapshot(
  uid: string,
  tasks: Task[],
  onUpdate: ProximityCallback,
): Promise<void> {
  const undonePoiTasks = tasks.filter(t => !t.done && t.poi != null);
  const uniquePoiTypes = [...new Set(undonePoiTasks.map(t => t.poi as string))];

  if (uniquePoiTypes.length === 0) {
    // Nothing to search for — settle immediately without even a position
    // fix (runProximitySearch always takes one first, needed for its
    // other callers, but this entry point has no use for it here).
    _currentNearbyType = null;
    _lastAllPlaces = {};
    onUpdate(null, null, {});
    return;
  }

  const poiTypesKey = [...uniquePoiTypes].sort().join(',');

  let coords: Coordinates;
  try {
    coords = await getPositionLowAccuracy();
  } catch {
    // No position available — let runProximitySearch handle this failure
    // the same way it always has (it'll hit the same error itself).
    await runProximitySearch(uid, tasks, onUpdate);
    return;
  }

  const snapshot = loadProximitySnapshot(uid);
  if (snapshot && snapshot.poiTypesKey === poiTypesKey) {
    const moved = getDistanceMeters(coords.lat, coords.lng, snapshot.lat, snapshot.lng);
    if (moved <= SNAPSHOT_REUSE_RADIUS_M) {
      // KAN-285 review fix — a snapshot within the reuse radius can still be
      // up to SNAPSHOT_REUSE_RADIUS_M (500m) away from the CURRENT position,
      // easily enough to cross the much tighter HERO_RADIUS_M/NEARBY_RADIUS
      // thresholds (~100m/400m). Replaying the snapshot's already-computed
      // hero/allPlaces verbatim would show stale results — instead, recover
      // each candidate place's raw lat/lng from the snapshot, recompute its
      // distance against the CURRENT coords, and run the exact same
      // processProximityTick every other path uses, so hero/grey selection,
      // notification eligibility, and exit-prompt dwell tracking all react
      // to where the user actually is right now. Only the "was there an
      // API/cache call this tick" step is what's actually skipped.
      const results: Record<string, NearbyPlace[]> = {};
      for (const [poiType, places] of Object.entries(snapshot.poiPlaces)) {
        results[poiType] = (places ?? [])
          .map(p => ({ ...p, distanceMeters: getDistanceMeters(coords.lat, coords.lng, p.lat, p.lng) }))
          .sort((a, b) => a.distanceMeters - b.distanceMeters);
      }
      processProximityTick(uid, tasks, undonePoiTasks, uniquePoiTypes, poiTypesKey, coords, results, true, onUpdate);
      return;
    }
  }

  await runProximitySearch(uid, tasks, onUpdate, coords);
}

/**
 * Returns the coordinates of the last completed search, or null if no search
 * has run yet. Used by the movement gate in useTodayScreen to decide whether
 * to re-search.
 */
export function getLastSearchCoords(): { lat: number; lng: number } | null {
  return _lastSearchCoords;
}

/**
 * Is `poiType` currently in the Nearby list — the same hero+grey set
 * NearbyCard renders (anything with ≥1 place within NEARBY_RADIUS_M), not
 * just the single orange-hero type. Used by KAN-279's "Take me there"
 * action so a task showing in the Nearby card's grey ("also close") rows
 * never gets flagged as far away too.
 */
export function isPoiTypeNearby(poiType: string): boolean {
  return !!_lastAllPlaces[poiType]?.length;
}

/** Reset deduplication state (call on sign-out or day boundary). */
export function resetProximityState(): void {
  _currentNearbyType      = null;
  _lastAllPlaces          = {};
  _lastSearchCoords       = null;
  _lastSearchPoiTypesKey  = null;
  _isSearching            = false;
  _prevUndonePoiTaskCount = 0;
  _alertedTodayTypes.clear();
  poiRadiusPrefs = {};
  _pendingQueue   = [];
  _netInfoUnsubscribe?.();
  _netInfoUnsubscribe = null;
  _offlineUncoveredNoticeShown = false;
  _learnedPlaces = [];
  _customCategoryPoiTypes = [];
  _activeTrips = [];
  _mallSnapshot = null;
  _lastPlaceContext = null;

  geofenceEntryTimes.clear();
}

/**
 * Register a callback that receives every GPS fix (KAN-75 indoor detection).
 * Pass null to unregister.
 */
export function setLocationTap(
  cb: ((lat: number, lng: number, accuracy: number) => void) | null,
): void {
  _locationTap = cb;
}

/**
 * Trigger an on-demand search (e.g. user taps a retry button).
 * Resets the movement gate so the search always runs.
 */
export async function scanNow(
  uid: string,
  tasks: Task[],
  onUpdate: ProximityCallback,
): Promise<void> {
  _lastSearchCoords = null; // force search regardless of movement
  await runProximitySearch(uid, tasks, onUpdate);
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

export function __setGeofenceEntryTime(geofenceId: string, timestamp: number): void {
  geofenceEntryTimes.set(geofenceId, timestamp);
}

export function __clearGeofenceEntryTimes(): void {
  geofenceEntryTimes.clear();
}

export function __getPendingQueue(): PendingSearch[] { return _pendingQueue; }
export function __clearPendingQueue(): void { _pendingQueue = []; }
export function __setNetInfoUnsubscribe(fn: (() => void) | null): void { _netInfoUnsubscribe = fn; }
/** KAN-244 — test-only: resetProximityState() deliberately doesn't touch the lifetime cap counter (see its declaration). */
export function __resetCoverageInvitationCount(): void { _coverageInvitationShownCount = 0; }
