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
  HOME_ENTER_M,
  HOME_LEAVE_M,
} from '../../src/utils/lantern';
import type { PlaceContext } from '../../src/services/proximity';

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
};

describe('resolveLanternState — states (KAN-301 AC1)', () => {
  it('Home when within the buffer and a home is set', () => {
    expect(resolveLanternState({ ...base, homeDistanceM: 40 })).toEqual({ kind: 'home' });
  });

  it('Outside (city name) when away and online', () => {
    expect(resolveLanternState({ ...base, homeDistanceM: 4000, cityName: 'Porto' }))
      .toEqual({ kind: 'outside', cityName: 'Porto' });
  });

  it('Outside with null cityName when offline — never a guessed/stale name (AC2)', () => {
    expect(resolveLanternState({ ...base, homeDistanceM: 4000, cityName: 'Porto', offline: true }))
      .toEqual({ kind: 'outside', cityName: null });
  });

  it('Mall when placeContext is a mall — offlineDot mirrors offline (AC2)', () => {
    expect(resolveLanternState({ ...base, placeContext: mallCtx('Colombo'), homeDistanceM: 4000, offline: true }))
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
      .toEqual({ kind: 'outside', cityName: 'Sintra' });
  });

  it('a trip whose dates are in the past does not fire', () => {
    expect(resolveLanternState({ ...base, placeContext: tripCtx('Faro', { startDate: '2026-01-01', endDate: '2026-01-10' }), homeDistanceM: 4000, cityName: 'Porto' }))
      .toEqual({ kind: 'outside', cityName: 'Porto' });
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
