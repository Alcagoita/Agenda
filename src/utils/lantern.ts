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
 * token and localized label.
 */
import type { PlaceContext } from '../services/proximity';
import type { PoiCoverageStatus, PoiSearchSource } from '../services/maps';
import { isTodayWithinTripDates } from './contextChip';

export type LanternStateKind =
  | 'mall' | 'trip' | 'home' | 'outside' | 'locating' | 'unavailable' | 'unset';

export type LanternState =
  | { kind: 'mall'; name: string }
  | { kind: 'trip'; destination: string }
  | { kind: 'home' }
  | { kind: 'outside'; cityName: string | null }
  /** Home IS set but the position isn't known yet (no fix). A held state with
   *  its own visual ("Looking around…") — never Outside, which would flash on
   *  cold start and stick for a no-POI-task user until a fix arrives. Produced
   *  by the resolver; useLanternState owns the timing around it. */
  | { kind: 'locating' }
  /** The fix never arrived (past the ceiling). "Can't find you." Produced by
   *  useLanternState's timing, never the resolver. */
  | { kind: 'unavailable' }
  | { kind: 'unset' };

/**
 * Home-boundary hysteresis (KAN-301). GPS jitter at a boundary would otherwise
 * flip Home → Outside → Home every few seconds, so we use a distance buffer,
 * not a timer: enter Home at ≤1000 m, but leave only past 1200 m.
 *
 * Scaled up from the original 150 m / 200 m test values (KAN-342 follow-up):
 * Home is meant to represent the area the user lives in, not the building —
 * see HOME_RADIUS_M in services/home.ts. The buffer scales with the radius so
 * the boundary still sits well clear of normal walking-around jitter.
 */
export const HOME_ENTER_M = 1000;
export const HOME_LEAVE_M = 1200;

/**
 * Applies the enter-fast / leave-slow buffer to a known home distance.
 * Enter Home at ≤1000 m; once Home, leave only past 1200 m.
 */
export function resolveHomeProximity(distanceM: number, wasHome: boolean): boolean {
  return wasHome ? distanceM <= HOME_LEAVE_M : distanceM <= HOME_ENTER_M;
}

/** What the Lantern zone owes the user an explanation about (KAN-349). */
export type AreaNotice = 'building' | 'degraded';

export interface ResolveAreaNoticeInput {
  /** Which source answered the last search (getLastPoiSearchState). */
  source: PoiSearchSource | null;
  /** The Worker's latest answer for this location, from checkAreaCoverage — undefined until one lands. */
  coverageStatus: PoiCoverageStatus | undefined;
}

/**
 * Which line, if any, the Lantern zone shows (KAN-349).
 *
 * Only an `osm` answer can produce a line at all. That is the whole of the
 * "never on a normal empty result" rule: a Cloudflare answer with zero places
 * is a settled, complete answer about a covered area — an empty answer IS an
 * answer — and it reports `cloudflare`, so it falls straight through here.
 *
 * Given we are on the fallback source, the Worker's own coverage answer says
 * which of the two situations it is:
 *   • `building` — the area is being prepared. Temporary, progressing.
 *   • anything else, or no answer yet — a fault: our API didn't serve us and
 *     we are running thin. Not progress, so it gets the other line.
 *
 * `cache` (offline) and `null` (no search yet) produce nothing: offline is the
 * KAN-316 dot's territory, and that dot requires `source !== 'osm'` while both
 * lines here require `source === 'osm'`. The two are mutually exclusive by
 * construction — verified in the tests, never enforced by suppression logic.
 */
export function resolveAreaNotice({ source, coverageStatus }: ResolveAreaNoticeInput): AreaNotice | null {
  if (source !== 'osm') { return null; }
  return coverageStatus === 'building' ? 'building' : 'degraded';
}

export interface ResolveLanternStateInput {
  /** Mall/trip context for the last position fix, or null (from proximity.ts). */
  placeContext: PlaceContext;
  todayIso: string;
  /** Whether a home address is stored at all (services/home). Drives unset vs. home/outside. */
  homeSet: boolean;
  /** Distance in metres from the current position to the stored home, or null when the position isn't known yet. */
  homeDistanceM: number | null;
  /** Whether the previous render resolved to Home — feeds the hysteresis buffer. */
  wasHome: boolean;
  /** Reverse-geocoded city / area name, or null (offline / unknown). */
  cityName: string | null;
  /** True when the device is offline — a quiet modifier, never its own state. */
  offline: boolean;
}

/**
 * Priority: mall > trip > home/outside. Mall and trip never need a position
 * fix. When there's no mall/trip context: unset if no home is stored; locating
 * if a home is stored but the position isn't known yet (never guess Outside —
 * that would flash on cold start and stick for a no-POI-task user); otherwise
 * home/outside via the hysteresis buffer.
 *
 * Exactly one kind is ever returned — never two indicators (doctrine §9).
 * Off-grid trips are excluded (a distinct concept, KAN-246).
 */
export function resolveLanternState({
  placeContext, todayIso, homeSet, homeDistanceM, wasHome, cityName, offline,
}: ResolveLanternStateInput): LanternState {
  if (placeContext?.kind === 'mall') {
    // The mall name comes from the stored snapshot, so it's correct offline too.
    return { kind: 'mall', name: placeContext.snapshot.name };
  }

  if (
    placeContext?.kind === 'trip' &&
    placeContext.trip.kind !== 'offgrid' &&
    isTodayWithinTripDates(placeContext.trip, todayIso)
  ) {
    return { kind: 'trip', destination: placeContext.trip.destination };
  }

  if (!homeSet) { return { kind: 'unset' }; }
  if (homeDistanceM == null) { return { kind: 'locating' }; }

  if (resolveHomeProximity(homeDistanceM, wasHome)) { return { kind: 'home' }; }

  // Outside. Never show a guessed or stale name: offline forces the literal
  // "Outside" (the component substitutes it for a null cityName).
  return { kind: 'outside', cityName: offline ? null : cityName };
}
