/**
 * indoorProximity.ts — KAN-75
 *
 * Indoor proximity engine: polling-based store detection active while
 * storeTuningState === 'active'.
 *
 * ── Design ────────────────────────────────────────────────────────────────────
 * Unlike the outdoor engine (proximity.ts) which relies on native OS geofences
 * for notification delivery, this engine polls every 15 seconds. On each tick:
 *   1. One-shot getCurrentPosition() — no long-running watcher.
 *   2. Feeds the position to indoorDetection.feedLocation() for recovery detection.
 *   3. If the user moved ≥ 2 m since the last tick, queries the Places API
 *      for stores within 50 m; otherwise reuses the cached result (stationary
 *      optimisation).
 *   4. Checks each nearby store against undone tasks that carry a `store` tag,
 *      matching on placeId (authoritative) or name (case-insensitive fallback).
 *   5. If a match is found AND the task has not already been alerted today,
 *      fires a local notification and writes `store.alertSeenDate` to Firestore.
 *
 * ── Mutual exclusion ──────────────────────────────────────────────────────────
 * The indoor and outdoor engines MUST NOT run simultaneously (KAN-75 spec).
 * The caller (useTodayScreen) is responsible for stopping the outdoor engine
 * before starting this one, and vice versa.
 *
 * ── Testability ───────────────────────────────────────────────────────────────
 * All external I/O is injectable via __set* helpers. `__pollOnce()` lets tests
 * drive a single tick synchronously without real timers.
 */

import notifee, { AndroidImportance } from '@notifee/react-native';
import { feedLocation } from './indoorDetection';
import { markExitPromptSeen } from './firestore';
import { searchNearbyPlaces, getDistanceMeters, NearbyPlace } from './maps';
import { getCurrentPosition } from './geolocation';
import { fireExitPrompt } from './notifications';
import { Task } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Milliseconds between polls while the indoor engine is active. */
export const INDOOR_POLL_INTERVAL_MS      = 15_000;

/** Maximum distance (m) from a store to trigger an alert. */
export const INDOOR_MATCH_RADIUS_M        = 10;

/** Minimum movement (m) needed to invalidate the Places cache. */
export const INDOOR_STATIONARY_THRESHOLD_M = 2;

/** Places API search radius (m) — deliberately generous for indoor accuracy. */
const INDOOR_SEARCH_RADIUS_M              = 50;

/** Notifee Android channel id for indoor store alerts. */
const INDOOR_CHANNEL_ID                   = 'indoor_proximity_alerts';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Callback fired on every poll tick.
 * Receives `(task, place)` when a nearby store matches an undone task that
 * hasn't been alerted today; `(null, null)` when nothing matches.
 */
export type IndoorProximityCallback = (
  task:  Task | null,
  place: NearbyPlace | null,
) => void;

// ─── Injectable dependencies ──────────────────────────────────────────────────

type GetCurrentPositionFn = () => Promise<{ lat: number; lng: number; accuracy: number }>;
type SearchPlacesFn       = (lat: number, lng: number, type: string, radius: number) => Promise<NearbyPlace[]>;
type FireNotifFn          = (task: Task, place: NearbyPlace) => Promise<void>;
type MarkSeenFn           = (uid: string, taskId: string, date: string) => Promise<void>;
type GetTodayFn           = () => string;

let _getPosition:   GetCurrentPositionFn = async () => {
  const c = await getCurrentPosition();
  return { lat: c.lat, lng: c.lng, accuracy: c.accuracy };
};
let _searchPlaces:  SearchPlacesFn       = async (lat, lng, type, radius) => {
  const { results } = await searchNearbyPlaces(lat, lng, [type], radius);
  return results[type] ?? [];
};
let _fireNotif:     FireNotifFn          = _defaultFireNotif;
let _markSeen:      MarkSeenFn           = async () => {}; // store field removed — KAN-143
let _getToday:      GetTodayFn           = () => new Date().toISOString().slice(0, 10);

async function _defaultFireNotif(task: Task, place: NearbyPlace): Promise<void> {
  await notifee.createChannel({
    id:         INDOOR_CHANNEL_ID,
    name:       'Store alerts',
    importance: AndroidImportance.HIGH,
  });
  await notifee.displayNotification({
    title: task.title,
    body:  `You're near ${place.name} — time to brush this away!`,
    android: {
      channelId: INDOOR_CHANNEL_ID,
      smallIcon: 'ic_notification',
    },
  });
}

// ─── Module state ─────────────────────────────────────────────────────────────

let _isMonitoring:   boolean                      = false;
let _pollTimer:      ReturnType<typeof setInterval> | null = null;
let _uid:            string                       = '';
let _latestTasks:    Task[]                       = [];
let _onNearby:       IndoorProximityCallback | null = null;
let _lastPos:        { lat: number; lng: number } | null = null;
let _cachedPlaces:   NearbyPlace[]                = [];

// ── Exit prompt state (KAN-119) ──────────────────────────────────────────────
/** Whether the exit-prompt notification is enabled (mirrors userPreferences). */
let _exitPromptEnabled        = true;
/** Task ID of the last indoor match, used to detect the transition to "no match". */
let _lastMatchedTaskId:       string | null = null;
/** Timestamp (ms) when the current indoor match was first detected. */
let _indoorMatchEntryTime:    number | null = null;
/** Number of consecutive poll ticks with no match after having had a match. */
let _indoorConsecutiveMisses  = 0;
/** Polls with no match required before treating it as an exit (3 × 15 s = 45 s). */
const INDOOR_EXIT_MISS_COUNT  = 3;
/** Minimum dwell time (ms) before an indoor exit prompt may fire. */
const INDOOR_EXIT_MIN_DWELL_MS = 5 * 60 * 1000; // 5 minutes

/** Update the exit-prompt enabled flag from a userPreferences subscription. */
export function updateIndoorExitPromptPref(enabled: boolean): void {
  _exitPromptEnabled = enabled;
}

// ─── Core poll tick ───────────────────────────────────────────────────────────

async function _pollTick(): Promise<void> {
  if (!_isMonitoring || !_uid) { return; }

  // ── 1. Acquire position ──────────────────────────────────────────────────
  let pos: { lat: number; lng: number; accuracy: number };
  try {
    pos = await _getPosition();
  } catch {
    return; // GPS unavailable — skip this tick without crashing
  }
  const { lat, lng, accuracy } = pos;

  // ── 2. Feed indoor detection for recovery signal (KAN-73) ───────────────
  feedLocation(lat, lng, accuracy);

  // ── 3. Stationary optimisation ───────────────────────────────────────────
  // Reuse the cached Places result if the user hasn't moved enough to warrant
  // a new API call. This keeps the Places API spend low while indoors.
  const moved = _lastPos
    ? getDistanceMeters(_lastPos.lat, _lastPos.lng, lat, lng)
    : Infinity;

  if (moved >= INDOOR_STATIONARY_THRESHOLD_M) {
    _lastPos = { lat, lng };
    try {
      _cachedPlaces = await _searchPlaces(lat, lng, 'store', INDOOR_SEARCH_RADIUS_M);
    } catch {
      _cachedPlaces = []; // Places API error — treat as empty
    }
  }

  // ── 4. Store-based matching removed (KAN-143 — Task.store field deleted).
  //       POI-type proximity will be rebuilt in KAN-142.
  const today        = _getToday();
  const matchedTask:  Task | null        = null;
  const matchedPlace: NearbyPlace | null = null;

  // ── 5. Notify callback ───────────────────────────────────────────────────
  _onNearby?.(matchedTask, matchedPlace);

  // ── 6. Fire notification + persist deduplication date ───────────────────
  if (matchedTask && matchedPlace) {
    try {
      await _fireNotif(matchedTask, matchedPlace);
      await _markSeen(_uid, matchedTask.id, today);

    } catch (err) {
      console.warn('[indoorProximity] notification failed', err);
    }
  }

  // ── 7. Indoor exit prompt tracking (KAN-119) ─────────────────────────────
  if (matchedTask) {
    // New or continuing match.
    if (_lastMatchedTaskId !== matchedTask.id) {
      // First tick matching this task — record dwell start.
      _lastMatchedTaskId    = matchedTask.id;
      _indoorMatchEntryTime = Date.now();
    }
    _indoorConsecutiveMisses = 0;
  } else if (_lastMatchedTaskId !== null) {
    // We had a match but it's gone now — count consecutive misses.
    _indoorConsecutiveMisses += 1;

    if (_indoorConsecutiveMisses >= INDOOR_EXIT_MISS_COUNT) {
      // Enough consecutive misses — treat as a store exit.
      const exitedTaskId   = _lastMatchedTaskId;
      const entryTime      = _indoorMatchEntryTime;

      // Reset state before any async work to prevent double-firing.
      _lastMatchedTaskId      = null;
      _indoorMatchEntryTime   = null;
      _indoorConsecutiveMisses = 0;

      if (
        _exitPromptEnabled &&
        entryTime !== null &&
        Date.now() - entryTime >= INDOOR_EXIT_MIN_DWELL_MS
      ) {
        const exitedTask = _latestTasks.find(
          t => t.id === exitedTaskId &&
               !t.done &&
               t.exitPromptSeenDate !== today,
        );

        if (exitedTask) {
          fireExitPrompt({ taskId: exitedTask.id, taskTitle: exitedTask.title, storeName: undefined })
            .then(() => markExitPromptSeen(_uid, exitedTask.id, today))
            .catch(err => console.warn('[indoorProximity] exit prompt failed', err));
        }
      }
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the indoor proximity engine.
 *
 * **Important:** stop the outdoor engine (`stopProximityMonitoring`) before
 * calling this. Both engines MUST NOT run simultaneously.
 *
 * @param uid       Firebase user ID — used for Firestore writes.
 * @param tasks     Current task list (today's tasks, effective state).
 * @param onNearby  Callback fired on each poll: `(task, place)` when a nearby
 *                  store matches an undone task; `(null, null)` otherwise.
 * @returns         Cleanup function — call when switching back to outdoor mode.
 */
export function startIndoorProximityMonitoring(
  uid:      string,
  tasks:    Task[],
  onNearby: IndoorProximityCallback,
): () => void {
  if (_isMonitoring) { stopIndoorProximityMonitoring(); }

  _uid          = uid;
  _latestTasks  = tasks;
  _onNearby     = onNearby;
  _lastPos      = null;
  _cachedPlaces = [];
  _isMonitoring = true;

  // Ticks fire on the interval — the first poll runs at T+15s.
  // (In production the 15s delay is acceptable; callers that need an immediate
  // check can call __pollOnce() — or the interval fires on its own schedule.)
  _pollTimer = setInterval(() => void _pollTick(), INDOOR_POLL_INTERVAL_MS);

  return stopIndoorProximityMonitoring;
}

/**
 * Push a fresh task list to the running engine without restarting it.
 * Safe to call when the engine is not active (no-op).
 */
export function updateIndoorTasks(tasks: Task[]): void {
  _latestTasks = tasks;
}

/** Stop the indoor proximity engine and reset all module state. */
export function stopIndoorProximityMonitoring(): void {
  _isMonitoring             = false;
  _onNearby                 = null;
  _uid                      = '';
  _lastPos                  = null;
  _cachedPlaces             = [];
  _lastMatchedTaskId        = null;
  _indoorMatchEntryTime     = null;
  _indoorConsecutiveMisses  = 0;

  if (_pollTimer != null) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────
// These are __prefixed and must only be called from test files.

/** Override the position provider (default: `getCurrentPosition`). */
export function __setGetPosition(fn: GetCurrentPositionFn): void {
  _getPosition = fn;
}
/** Override the Places search function (default: `searchNearbyPlaces`). */
export function __setSearchPlaces(fn: SearchPlacesFn): void {
  _searchPlaces = fn;
}
/** Override the notification function (default: notifee). */
export function __setFireNotif(fn: FireNotifFn): void {
  _fireNotif = fn;
}
/** Override the Firestore write (no-op default since store field was removed in KAN-143). */
export function __setMarkSeen(fn: MarkSeenFn): void {
  _markSeen = fn;
}
/** Override the today-date provider (default: `Date`). */
export function __setGetToday(fn: GetTodayFn): void {
  _getToday = fn;
}
/** Restore all dependencies to their production defaults. */
export function __resetDeps(): void {
  _getPosition  = async () => { const c = await getCurrentPosition(); return { lat: c.lat, lng: c.lng, accuracy: c.accuracy }; };
  _searchPlaces = async (lat, lng, type, radius) => {
    const { results } = await searchNearbyPlaces(lat, lng, [type], radius);
    return results[type] ?? [];
  };
  _fireNotif    = _defaultFireNotif;
  _markSeen     = async () => {};
  _getToday     = () => new Date().toISOString().slice(0, 10);
}
/** Expose the current monitoring flag (for assertions). */
export function __isMonitoring(): boolean {
  return _isMonitoring;
}
/**
 * Manually drive a single poll tick — used in tests to avoid real timers.
 * Returns the same Promise as the internal tick so tests can await it.
 */
export function __pollOnce(): Promise<void> {
  return _pollTick();
}
