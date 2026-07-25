/**
 * lantern.ts — KAN-301 Lantern state resolver + home hysteresis.
 *
 * Pure decision logic for the Today header "Lantern": given the current place
 * context (mall/trip, already prioritized by proximity.ts's
 * findActivePlaceContext), the distance to the stored home, connectivity and a
 * reverse-geocoded city name, it decides the single state to render.
 *
 * Kept independent of geolocation/Firestore/theme so the mall > trip >
 * home/outside priority, the unset (no-home) branch and the home-boundary
 * hysteresis are all unit-testable without mocking any of them — mirroring
 * contextChip.ts, whose priority order this deliberately reuses.
 *
 * The resolver returns a copy-free discriminated union (raw names, not
 * localized strings); the Lantern component maps each kind to its icon, halo
 * token and localized label, exactly as ContextChip maps ContextChipView.
 */
import type { PlaceContext } from '../services/proximity';
import { isTodayWithinTripDates } from './contextChip';

export type LanternStateKind = 'mall' | 'trip' | 'home' | 'outside' | 'unset';

export type LanternState =
  | { kind: 'mall'; name: string; offlineDot: boolean }
  | { kind: 'trip'; destination: string; offlineDot: boolean }
  | { kind: 'home' }
  | { kind: 'outside'; cityName: string | null }
  | { kind: 'unset' };

/**
 * Home-boundary hysteresis (KAN-301). GPS jitter at a boundary would otherwise
 * flip Home → Outside → Home every few seconds, so we use a distance buffer,
 * not a timer: enter Home at ≤150 m, but leave only past 200 m.
 */
export const HOME_ENTER_M = 150;
export const HOME_LEAVE_M = 200;

/**
 * Applies the enter-fast / leave-slow buffer to a raw home distance.
 * Returns:
 *   - `null`  when no home is stored (distance unknown) → the unset state,
 *   - `true`  when the user should read as Home,
 *   - `false` when the user should read as Outside.
 */
export function resolveHomeProximity(distanceM: number | null, wasHome: boolean): boolean | null {
  if (distanceM == null) { return null; }
  return wasHome ? distanceM <= HOME_LEAVE_M : distanceM <= HOME_ENTER_M;
}

export interface ResolveLanternStateInput {
  /** Mall/trip context for the last position fix, or null (from proximity.ts). */
  placeContext: PlaceContext;
  todayIso: string;
  /** Distance in metres from the current position to the stored home, or null when no home is set. */
  homeDistanceM: number | null;
  /** Whether the previous render resolved to Home — feeds the hysteresis buffer. */
  wasHome: boolean;
  /** Reverse-geocoded city / area name, or null (offline / unknown). */
  cityName: string | null;
  /** True when the device is offline — a quiet modifier, never its own state. */
  offline: boolean;
}

/**
 * Priority: mall > trip > home/outside; unset when no home is stored.
 * Exactly one kind is ever returned — never two indicators (doctrine §9).
 * Off-grid trips are excluded (they're a distinct concept, KAN-246), matching
 * resolveContextChipView.
 */
export function resolveLanternState({
  placeContext, todayIso, homeDistanceM, wasHome, cityName, offline,
}: ResolveLanternStateInput): LanternState {
  if (placeContext?.kind === 'mall') {
    // The mall name comes from the stored snapshot, so it's correct offline too
    // — the offlineDot just marks that the surrounding data is cached.
    return { kind: 'mall', name: placeContext.snapshot.name, offlineDot: offline };
  }

  if (
    placeContext?.kind === 'trip' &&
    placeContext.trip.kind !== 'offgrid' &&
    isTodayWithinTripDates(placeContext.trip, todayIso)
  ) {
    return { kind: 'trip', destination: placeContext.trip.destination, offlineDot: offline };
  }

  const homeProximity = resolveHomeProximity(homeDistanceM, wasHome);
  if (homeProximity === null) { return { kind: 'unset' }; }
  if (homeProximity === true) { return { kind: 'home' }; }

  // Outside. Never show a guessed or stale name: offline forces the literal
  // "Outside" (the component substitutes it for a null cityName).
  return { kind: 'outside', cityName: offline ? null : cityName };
}
