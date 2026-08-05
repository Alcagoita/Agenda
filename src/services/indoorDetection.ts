/**
 * indoorDetection.ts — KAN-73
 *
 * Two-signal indoor environment detector.
 *
 * ── Signal 1: GPS accuracy degradation ───────────────────────────────────────
 * A rolling 30-second window tracks incoming accuracy readings.
 *   "Degraded" : ≥ 70% of readings have accuracy > 50 m  → indoor candidate
 *   "Recovered": ≥ 70% of readings have accuracy ≤ 50 m  → outdoor
 *
 * ── Signal 2: Google Places shopping-mall lookup ──────────────────────────────
 * Triggered once the accuracy signal has been degraded for 15 consecutive
 * seconds (debounce). If a shopping mall is found within 300 m, the context
 * upgrades indoor_unmapped → indoor_mapped.
 *
 * ── State machine ─────────────────────────────────────────────────────────────
 *
 *   outdoor ──(degraded ≥ 15 s)──→ indoor_unmapped
 *                                         │
 *                        (mall found) ────┤──── (no mall / error)
 *                                         ↓                      ↓
 *                               indoor_mapped          indoor_unmapped
 *                                    │                        │
 *               (recovered ≥ 15 s)  ─┴────────────────────── ┘
 *                                    ↓
 *                                outdoor
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   // In LocationProvider / outdoor engine:
 *   const stopDetection = startIndoorDetection(ctx => {
 *     dispatch({ type: 'SET_LOCATION_CONTEXT', ctx });
 *   });
 *   // On each GPS tick:
 *   feedLocation(lat, lng, accuracy);
 *   // On unmount:
 *   stopDetection();
 *
 * ── Design constraint (KAN-75) ────────────────────────────────────────────────
 * The outdoor engine (KAN-56) and indoor proximity engine (KAN-75) must
 * NEVER run simultaneously. The consumer must start/stop the appropriate
 * engine in response to onContextChange callbacks.
 *
 * ── Testability ───────────────────────────────────────────────────────────────
 * feedLocation() accepts an optional `nowMs` parameter so unit tests can
 * drive the clock without monkey-patching Date.now(). The mall lookup
 * function is injectable via __setMallLookup (test-only export).
 */

import { searchNearbyPlaces } from './maps';
import type { NearbyPlace } from './maps';
import type { LocationContext } from './geolocation';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Width of the rolling accuracy window (ms). */
export const WINDOW_MS = 30_000;

/**
 * Fraction threshold: if at least this many readings in the window are
 * high-accuracy (≤ ACCURACY_THRESHOLD_M), signal is "recovered".
 * Mirror: if at least this many are low-accuracy, signal is "degraded".
 */
export const SIGNAL_RATIO = 0.7;

/** Accuracy boundary (metres). Readings above this value are "degraded". */
export const ACCURACY_THRESHOLD_M = 50;

/** Debounce: the signal must be stable for this many ms before we transition. */
export const DEBOUNCE_MS = 15_000;

/** Radius (metres) used for the shopping-mall Places lookup. */
export const MALL_SEARCH_RADIUS_M = 300;

/** Minimum readings in the window before any classification is attempted. */
const MIN_READINGS = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

interface AccuracyReading {
  accuracy: number;
  ts: number; // Unix ms
}

/** Injectable mall lookup (swapped in tests via __setMallLookup). */
type MallLookupFn = (
  lat: number,
  lng: number,
  type: string,
  radiusMeters: number,
) => Promise<NearbyPlace[]>;

// ─── Module-level state ───────────────────────────────────────────────────────

let _onContextChange: ((ctx: LocationContext) => void) | null = null;
let _currentContext: LocationContext = 'outdoor';

/** Rolling window of the last WINDOW_MS accuracy readings. */
let _window: AccuracyReading[] = [];

/** Pending state-machine transition waiting out the debounce. */
let _pending: { target: LocationContext; since: number } | null = null;

/** Most recent coordinates (used for the async mall lookup). */
let _lastLat = 0;
let _lastLng = 0;

/** Guards against concurrent mall lookups. */
let _mallLookupInFlight = false;

/** Production implementation — replaced in tests via __setMallLookup. */
let _mallLookup: MallLookupFn = async (lat, lng, type, radius) => {
  const { results } = await searchNearbyPlaces(lat, lng, [type], radius);
  return results[type] ?? [];
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the detector and register a context-change callback.
 *
 * Returns a cleanup function — pass it to useEffect's return or call it on
 * unmount to stop the detector and reset all internal state.
 *
 * Safe to call multiple times; each call resets and re-initialises.
 */
export function startIndoorDetection(
  onContextChange: (ctx: LocationContext) => void,
): () => void {
  _reset();
  _onContextChange = onContextChange;
  return stopIndoorDetection;
}

/**
 * Feed a GPS reading into the detector's rolling window and run the state
 * machine. Call this on every location tick from the GPS watcher.
 *
 * This function DOES NOT start its own GPS watcher — it is intentionally
 * passive so it cannot compete with the outdoor engine's watcher.
 *
 * @param lat       WGS-84 latitude
 * @param lng       WGS-84 longitude
 * @param accuracy  Horizontal accuracy radius in metres (lower = better)
 * @param nowMs     Current time in Unix ms; defaults to Date.now().
 *                  Pass a value in unit tests to drive the clock manually.
 */
export function feedLocation(
  lat: number,
  lng: number,
  accuracy: number,
  nowMs: number = Date.now(),
): void {
  if (!_onContextChange) { return; } // detector not started

  _lastLat = lat;
  _lastLng = lng;

  // 1. Update and prune the rolling window.
  _window.push({ accuracy, ts: nowMs });
  _window = _window.filter(r => nowMs - r.ts <= WINDOW_MS);

  // 2. Need a minimum number of readings before classifying.
  if (_window.length < MIN_READINGS) { return; }

  // 3. Classify the current signal.
  const degradedCount = _window.filter(r => r.accuracy > ACCURACY_THRESHOLD_M).length;
  const ratio = degradedCount / _window.length;
  const isDegraded  = ratio >= SIGNAL_RATIO;
  const isRecovered = ratio <= (1 - SIGNAL_RATIO);

  // 4. Determine the target context given the signal and current state.
  let desiredTarget: LocationContext | null = null;
  if (isDegraded && _currentContext === 'outdoor') {
    desiredTarget = 'indoor_unmapped';
  } else if (isRecovered && _currentContext !== 'outdoor') {
    desiredTarget = 'outdoor';
  }

  // 5. No desired transition — cancel any pending and return.
  if (desiredTarget === null) {
    _pending = null;
    return;
  }

  // 6. Signal is pointing at desiredTarget.
  //    If the pending direction changed, restart the debounce timer.
  if (_pending?.target !== desiredTarget) {
    _pending = { target: desiredTarget, since: nowMs };
    return;
  }

  // 7. Debounce in progress for the same target — check if elapsed.
  if (nowMs - _pending.since < DEBOUNCE_MS) { return; }

  // 8. Debounce complete — commit the transition.
  _pending = null;
  _commitTransition(desiredTarget, lat, lng);
}

/**
 * Stop the detector and reset all internal state.
 * Any in-flight mall lookup will be silently discarded when it resolves.
 */
export function stopIndoorDetection(): void {
  _reset();
}

// ─── Test-only exports (prefixed __ by convention) ───────────────────────────

/**
 * Replace the mall-lookup function used when entering indoor_unmapped.
 * Call with the real implementation to restore production behaviour.
 *
 * Must be called AFTER startIndoorDetection (which resets the lookup to the
 * production default).
 */
export function __setMallLookup(fn: MallLookupFn): void {
  _mallLookup = fn;
}

/**
 * Read the current LocationContext without triggering any transition.
 * Useful for assertions in unit tests.
 */
export function __getCurrentContext(): LocationContext {
  return _currentContext;
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function _reset(): void {
  _onContextChange    = null;
  _currentContext     = 'outdoor';
  _window             = [];
  _pending            = null;
  _lastLat            = 0;
  _lastLng            = 0;
  _mallLookupInFlight = false;
  // Restore production mall lookup so __setMallLookup from a prior test
  // doesn't leak into a fresh startIndoorDetection call.
  _mallLookup = async (lat, lng, type, radius) => {
    const { results } = await searchNearbyPlaces(lat, lng, [type], radius);
    return results[type] ?? [];
  };
}

function _commitTransition(target: LocationContext, lat: number, lng: number): void {
  _currentContext = target;
  _onContextChange?.(target);

  if (target === 'indoor_unmapped') {
    _triggerMallLookup(lat, lng);
  }
}

function _triggerMallLookup(lat: number, lng: number): void {
  if (_mallLookupInFlight) { return; }
  _mallLookupInFlight = true;

  _mallLookup(lat, lng, 'shopping_mall', MALL_SEARCH_RADIUS_M)
    .then(results => {
      _mallLookupInFlight = false;
      // Only upgrade if still in indoor_unmapped — the user might have
      // recovered (walked outside) before the network call returned.
      if (_currentContext === 'indoor_unmapped' && results.length > 0) {
        _currentContext = 'indoor_mapped';
        _onContextChange?.('indoor_mapped');
      }
    })
    .catch(() => {
      _mallLookupInFlight = false;
      // Network failure — stay in indoor_unmapped; outdoor engine fallback
      // remains active as per KAN-77 decision doc.
    });
}
