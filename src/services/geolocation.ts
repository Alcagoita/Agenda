/**
 * geolocation.ts — Foreground location tracking service (KAN-22 / KAN-162 / KAN-209).
 *
 * Library: expo-location (replaces react-native-geolocation-service, KAN-162).
 *
 * Permissions requested:
 *   Android: FOREGROUND only (ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION)
 *   iOS:     When In Use (NSLocationWhenInUseUsageDescription)
 *
 * Proximity works while the app is alive (foreground + backgrounded), stops on kill.
 * No background location permission needed — matches the Google Maps model (KAN-209).
 */

import * as Location from 'expo-location';
import { Alert, Linking, Platform } from 'react-native';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Coordinates {
  lat: number;
  lng: number;
  /** Accuracy radius in metres. */
  accuracy: number;
  /** Unix timestamp (ms). */
  timestamp: number;
}

export type LocationCallback = (coords: Coordinates) => void;
export type LocationErrorCallback = (error: Error) => void;

export type PermissionStatus = 'granted' | 'denied' | 'blocked' | 'unavailable';

/**
 * The current environment context inferred by the indoor detection service
 * (KAN-73). Consumed by the indoor proximity engine (KAN-75) and Nearby card.
 *
 * outdoor         — normal GPS signal; outdoor geofence engine is active
 * indoor_unmapped — GPS degraded, indoor context detected but the venue is not
 *                   confirmed in Places; falls back to the outdoor engine
 * indoor_mapped   — GPS degraded AND Places confirmed a mapped shopping mall;
 *                   indoor proximity engine (KAN-75) takes over
 */
export type LocationContext = 'outdoor' | 'indoor_unmapped' | 'indoor_mapped';

// ─── Permission helpers ───────────────────────────────────────────────────────

/**
 * Checks and requests foreground location permission ("While using the app").
 *
 * Returns:
 *   'granted'     — foreground location granted
 *   'denied'      — user denied; can ask again
 *   'blocked'     — permanently denied; user must open Settings
 *   'unavailable' — device does not support location
 */
export async function requestLocationPermission(): Promise<PermissionStatus> {
  try {
    const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();

    if (status === 'granted') return 'granted';

    if (status === 'denied' && !canAskAgain) {
      showBlockedAlert();
      return 'blocked';
    }

    return 'denied';
  } catch {
    return 'unavailable';
  }
}

function showBlockedAlert(): void {
  Alert.alert(
    'Location permission required',
    'Brush needs location access while the app is in use to alert you when you\'re near a task\'s location. Please enable it in Settings.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Open Settings',
        onPress: () => Linking.openSettings(),
      },
    ],
  );
}

// ─── Adaptive accuracy (KAN-55) ───────────────────────────────────────────────

/**
 * Two-tier accuracy model:
 *
 * coarse — cell/WiFi triangulation. Used when all known POIs are > 500 m away.
 *          Low power draw; sufficient to detect when the user is approaching.
 *
 * fine   — GPS. Used when at least one cached POI is ≤ 500 m away.
 *          Higher power draw; required for 50–75 m geofence precision.
 */
export type AccuracyMode = 'coarse' | 'fine';

const FINE_ACCURACY_OPTIONS: Location.LocationOptions = {
  accuracy:       Location.Accuracy.High,
  distanceInterval: 25,
  timeInterval:   8_000,
};

const COARSE_ACCURACY_OPTIONS: Location.LocationOptions = {
  accuracy:       Location.Accuracy.Balanced,
  distanceInterval: 100,
  timeInterval:   30_000,
};

/** Currently active accuracy mode — module-level to avoid unnecessary restarts. */
let currentAccuracyMode: AccuracyMode = 'coarse';

/** Active location callback — stored so we can restart tracking on mode switch. */
let currentLocationCallback: LocationCallback | null = null;
let currentErrorCallback: LocationErrorCallback = defaultErrorHandler;

// ─── Tracking ─────────────────────────────────────────────────────────────────

let watchSubscription: Location.LocationSubscription | null = null;

/**
 * Guard incremented on every startTracking call. The .then() handler captures
 * the value at call time and discards the subscription if stopTracking() ran
 * while watchPositionAsync was still pending (race condition guard).
 */
let _trackingGeneration = 0;

/**
 * Starts continuous location tracking.
 *
 * Calls `onLocation` each time the device moves beyond the active distanceInterval.
 * Calls `onError` on any error (permission revoked, GPS off, etc.).
 *
 * Safe to call multiple times — stops the previous watcher automatically.
 * Bootstraps in coarse mode (KAN-55); call setTrackingAccuracy() to switch.
 */
export function startTracking(
  onLocation: LocationCallback,
  onError: LocationErrorCallback = defaultErrorHandler,
): void {
  currentLocationCallback = onLocation;
  currentErrorCallback    = onError;
  stopTracking();

  const generation = ++_trackingGeneration;
  const opts = currentAccuracyMode === 'fine' ? FINE_ACCURACY_OPTIONS : COARSE_ACCURACY_OPTIONS;

  Location.watchPositionAsync(opts, (position) => {
    onLocation({
      lat:       position.coords.latitude,
      lng:       position.coords.longitude,
      accuracy:  position.coords.accuracy ?? 999,
      timestamp: position.timestamp,
    });
  }).then((sub) => {
    if (generation !== _trackingGeneration) {
      // stopTracking() was called while the promise was in-flight; discard.
      sub.remove();
      return;
    }
    watchSubscription = sub;
  }).catch(onError);
}

/**
 * Stops continuous location tracking and clears the watcher.
 * Safe to call when no watcher is active.
 */
export function stopTracking(): void {
  _trackingGeneration++; // invalidates any in-flight watchPositionAsync promise
  if (watchSubscription !== null) {
    watchSubscription.remove();
    watchSubscription = null;
  }
}

/**
 * Switches the GPS accuracy mode and restarts the watcher if needed (KAN-55).
 *
 * No-op if the requested mode matches the current mode — avoids restarting
 * the watcher on every location tick.
 */
export function setTrackingAccuracy(mode: AccuracyMode): void {
  if (mode === currentAccuracyMode) { return; }
  currentAccuracyMode = mode;

  if (watchSubscription !== null && currentLocationCallback) {
    startTracking(currentLocationCallback, currentErrorCallback);
  }
}

/**
 * One-shot current position query (high accuracy — GPS).
 * Resolves with the device's current coordinates or rejects with a GeoError.
 * Use only when GPS-level accuracy is required (e.g. turn-by-turn).
 */
export function getCurrentPosition(): Promise<Coordinates> {
  return Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
  }).then((position) => ({
    lat:       position.coords.latitude,
    lng:       position.coords.longitude,
    accuracy:  position.coords.accuracy ?? 999,
    timestamp: position.timestamp,
  }));
}

/**
 * How old a cached OS fix may be before we stop trusting it (KAN-377).
 *
 * Sized for the questions we ask of it — which area am I in, which places are
 * around me — not for turn-by-turn. Five minutes of walking is ~400 m, inside
 * the Lantern's 1000/1200 m home hysteresis and comparable to the movement
 * that triggers a search anyway. Anything older is thrown away rather than
 * shown: a fix from this morning's commute would name the wrong place with
 * total confidence.
 */
export const LAST_KNOWN_MAX_AGE_MS = 5 * 60_000;

/**
 * The OS's own cached fix, or null if there isn't a recent enough one.
 *
 * Costs no radio, no satellites and no network — it's a read of what the
 * platform already had. That makes it the one position source that answers
 * instantly while offline, which is the whole point: a cold GNSS fix with no
 * assistance data takes 30–60 s, and for most of that time the phone is
 * holding a perfectly good answer from minutes ago.
 *
 * Never throws — no cached fix is an ordinary answer, not an error.
 */
export async function getLastKnownPosition(
  maxAgeMs: number = LAST_KNOWN_MAX_AGE_MS,
): Promise<Coordinates | null> {
  try {
    const position = await Location.getLastKnownPositionAsync({ maxAge: maxAgeMs });
    if (!position) { return null; }
    return {
      lat:       position.coords.latitude,
      lng:       position.coords.longitude,
      accuracy:  position.coords.accuracy ?? 999,
      timestamp: position.timestamp,
    };
  } catch {
    return null;
  }
}

/**
 * One-shot position query using network/cell location when available.
 *
 * Tries Balanced accuracy (WiFi/cell, low power) first. If network-based
 * positioning is unavailable (e.g. device is offline), falls back to GPS
 * so proximity checks continue working with no internet connection.
 *
 * Use this for all background proximity checks.
 */
export async function getPositionLowAccuracy(): Promise<Coordinates> {
  const toCoords = (position: Location.LocationObject): Coordinates => ({
    lat:       position.coords.latitude,
    lng:       position.coords.longitude,
    accuracy:  position.coords.accuracy ?? 999,
    timestamp: position.timestamp,
  });

  try {
    const position = await Location.getCurrentPositionAsync({
      accuracy:    Location.Accuracy.Balanced,
      timeInterval: 3_000,
      mayShowUserSettingsDialog: false,
    });
    return toCoords(position);
  } catch {
    // Network-based positioning failed (offline) — fall back to GPS.
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
      mayShowUserSettingsDialog: false,
    });
    return toCoords(position);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultErrorHandler(error: Error): void {
  console.warn('[geolocation] error', error.message);
}
