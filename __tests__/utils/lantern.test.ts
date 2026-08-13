/**
 * lantern.ts — KAN-301 state resolver + home hysteresis.
 *
 * Covers all states (incl. the unset no-home path and the `locating` held state
 * for home-set-but-no-fix), the mall > trip > home/outside priority, the
 * off-grid-trip exclusion, the online/offline label rule, and the enter-fast /
 * leave-slow home buffer (AC9).
 */
import {
  resolveLanternState,
  resolveHomeProximity,
  resolveOfflineDot,
  HOME_ENTER_M,
  HOME_LEAVE_M,
} from '../../src/utils/lantern';
import type { PlaceContext } from '../../src/services/proximity';
import type { PoiCoverageStatus, PoiSearchSource } from '../../src/services/maps';

const mallCtx = (name: string): PlaceContext =>
  ({ kind: 'mall', snapshot: { name } } as unknown as PlaceContext);

const tripCtx = (
  destination: string,
  extra: { kind?: string; startDate?: string; endDate?: string } = {},
): PlaceContext =>
  ({ kind: 'trip', trip: { destination, kind: 'trip', ...extra } } as unknown as PlaceContext);

const TODAY = '2026-07-25';
const base = {
  placeContext: null as PlaceContext,
  todayIso: TODAY,
  homeSet: true,
  homeDistanceM: null as number | null,
  wasHome: false,
  cityName: null as string | null,
  offline: false,
  offlineDot: false,
};

describe('resolveLanternState — states (KAN-301 AC1)', () => {
  it('Home when within the buffer and a home is set', () => {
    expect(resolveLanternState({ ...base, homeDistanceM: 40 })).toEqual({ kind: 'home', offlineDot: false });
  });

  it('Outside (city name) when away and online', () => {
    expect(resolveLanternState({ ...base, homeDistanceM: 4000, cityName: 'Porto' }))
      .toEqual({ kind: 'outside', cityName: 'Porto', offlineDot: false });
  });

  it('Outside with null cityName when offline — never a guessed/stale name (AC2)', () => {
    expect(resolveLanternState({ ...base, homeDistanceM: 4000, cityName: 'Porto', offline: true }))
      .toEqual({ kind: 'outside', cityName: null, offlineDot: false });
  });

  it('Mall when placeContext is a mall — offlineDot carries the resolved gate (KAN-316)', () => {
    expect(resolveLanternState({ ...base, placeContext: mallCtx('Colombo'), homeDistanceM: 4000, offline: true, offlineDot: true }))
      .toEqual({ kind: 'mall', name: 'Colombo', offlineDot: true });
  });

  it('Trip when today is within the trip dates', () => {
    expect(resolveLanternState({ ...base, placeContext: tripCtx('Faro', { startDate: '2026-07-20', endDate: '2026-07-30' }), homeSet: false }))
      .toEqual({ kind: 'trip', destination: 'Faro', offlineDot: false });
  });

  it('unset when no home is stored (regardless of position)', () => {
    expect(resolveLanternState({ ...base, homeSet: false, homeDistanceM: 40 })).toEqual({ kind: 'unset' });
    expect(resolveLanternState({ ...base, homeSet: false, homeDistanceM: null })).toEqual({ kind: 'unset' });
  });

  it('locating when home is set but the position is not known yet (no Outside flash)', () => {
    expect(resolveLanternState({ ...base, homeSet: true, homeDistanceM: null })).toEqual({ kind: 'locating' });
  });
});

describe('resolveLanternState — priority & filtering', () => {
  it('mall beats trip', () => {
    expect(resolveLanternState({ ...base, placeContext: mallCtx('Colombo'), homeDistanceM: 4000 }).kind).toBe('mall');
  });

  it('trip beats home/outside', () => {
    expect(resolveLanternState({ ...base, placeContext: tripCtx('Faro'), homeDistanceM: 10, wasHome: true }).kind).toBe('trip');
  });

  it('off-grid "trips" are not a trip state — fall through to home/outside', () => {
    expect(resolveLanternState({ ...base, placeContext: tripCtx('Hike', { kind: 'offgrid' }), homeDistanceM: 4000, cityName: 'Sintra' }))
      .toEqual({ kind: 'outside', cityName: 'Sintra', offlineDot: false });
  });

  it('a trip whose dates are in the past does not fire', () => {
    expect(resolveLanternState({ ...base, placeContext: tripCtx('Faro', { startDate: '2026-01-01', endDate: '2026-01-10' }), homeDistanceM: 4000, cityName: 'Porto' }))
      .toEqual({ kind: 'outside', cityName: 'Porto', offlineDot: false });
  });
});

describe('resolveLanternState — offlineDot reaches home and outside (KAN-316 AC4)', () => {
  it('stamps the dot onto Home', () => {
    expect(resolveLanternState({ ...base, homeDistanceM: 40, offline: true, offlineDot: true }))
      .toEqual({ kind: 'home', offlineDot: true });
  });

  it('stamps the dot onto Outside', () => {
    expect(resolveLanternState({ ...base, homeDistanceM: 4000, offline: true, offlineDot: true }))
      .toEqual({ kind: 'outside', cityName: null, offlineDot: true });
  });

  it('stamps it onto trip as well, and never onto the placeless states', () => {
    expect(resolveLanternState({ ...base, placeContext: tripCtx('Faro'), offline: true, offlineDot: true }))
      .toEqual({ kind: 'trip', destination: 'Faro', offlineDot: true });
    // unset / locating have no place to know, so they carry no dot at all.
    expect(resolveLanternState({ ...base, homeSet: false, offline: true, offlineDot: true }))
      .toEqual({ kind: 'unset' });
    expect(resolveLanternState({ ...base, homeDistanceM: null, offline: true, offlineDot: true }))
      .toEqual({ kind: 'locating' });
  });
});

describe('resolveOfflineDot — the coverage gate (KAN-316 AC1/AC2/AC3/AC6)', () => {
  /** The real-world offline case: cached ground here, last tick served from cache. */
  const offlineHere = {
    offline: true,
    knowsHere: true as boolean | null,
    source: 'cache' as PoiSearchSource | null,
    coverageStatus: undefined as PoiCoverageStatus | undefined,
  };

  it('shows offline over ground we hold, even though the tick came from the cache (AC1)', () => {
    // The whole point of the dot. A cache-sourced answer is "degraded" by
    // maps.ts's definition, which is why degraded is NOT the gate — offline
    // always means the cache answered.
    expect(resolveOfflineDot(offlineHere)).toBe(true);
  });

  it('shows when the last online answer was Cloudflare + ready as well', () => {
    expect(resolveOfflineDot({ ...offlineHere, source: 'cloudflare', coverageStatus: 'ready' })).toBe(true);
  });

  it('online never shows the dot', () => {
    expect(resolveOfflineDot({ ...offlineHere, offline: false })).toBe(false);
  });

  it('building and none render no dot — KAN-349 speaks for those (AC2)', () => {
    expect(resolveOfflineDot({ ...offlineHere, coverageStatus: 'building' })).toBe(false);
    expect(resolveOfflineDot({ ...offlineHere, coverageStatus: 'none' })).toBe(false);
  });

  it('an OSM-sourced answer renders no dot — that is the degraded line, not this (AC2)', () => {
    expect(resolveOfflineDot({ ...offlineHere, source: 'osm' })).toBe(false);
  });

  it('a cache seeded for a DIFFERENT location produces no dot (AC3)', () => {
    // knowsHere is the per-location probe: places cached in Lisbon, standing in
    // Tokyo → false, whatever the global cache holds.
    expect(resolveOfflineDot({ ...offlineHere, knowsHere: false })).toBe(false);
  });

  it('knowsHere === null suppresses the dot — no flash on the first offline render (AC6)', () => {
    expect(resolveOfflineDot({ ...offlineHere, knowsHere: null })).toBe(false);
  });

  it('no search has run yet (source null) but we hold this ground — still shows', () => {
    // A user with no POI tasks never triggers a search, so source stays null.
    // That is an absence of refusals, not a refusal.
    expect(resolveOfflineDot({ ...offlineHere, source: null })).toBe(true);
  });
});

describe('resolveHomeProximity — hysteresis buffer (KAN-301 AC9, KAN-342 follow-up)', () => {
  it('enters Home at ≤1000 m, leaves only past 1200 m', () => {
    expect(resolveHomeProximity(HOME_ENTER_M, false)).toBe(true);   // 1000 → enter
    expect(resolveHomeProximity(1001, false)).toBe(false);          // 1001 → stay out
    expect(resolveHomeProximity(HOME_LEAVE_M, true)).toBe(true);    // 1200 → still home
    expect(resolveHomeProximity(1201, true)).toBe(false);           // 1201 → leave
  });

  it('a position oscillating between 950 m and 1150 m produces no change after the first entry', () => {
    const samples = [1200, 950, 1150, 950, 1150, 950]; // starts outside, enters, then jitters across the boundary
    let wasHome = false;
    const kinds: string[] = [];
    for (const d of samples) {
      const state = resolveLanternState({ ...base, homeDistanceM: d, wasHome });
      wasHome = state.kind === 'home';
      kinds.push(state.kind);
    }
    // 1200 = outside; entry at the first 950; every later 1150/950 stays Home
    // because leaving needs >1200. One transition, total.
    expect(kinds).toEqual(['outside', 'home', 'home', 'home', 'home', 'home']);
  });
});
