/**
 * lantern.ts — KAN-301 state resolver + home hysteresis.
 *
 * Covers all five states (incl. the null/unset home path), the mall > trip >
 * home/outside priority, the off-grid-trip exclusion, the online/offline label
 * rule, and the enter-fast / leave-slow home buffer (AC9).
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

describe('resolveLanternState — states (KAN-301 AC1)', () => {
  it('Home when within the buffer and a home is set', () => {
    expect(
      resolveLanternState({ placeContext: null, todayIso: TODAY, homeDistanceM: 40, wasHome: false, cityName: 'Lisboa', offline: false }),
    ).toEqual({ kind: 'home' });
  });

  it('Outside (city name) when away and online', () => {
    expect(
      resolveLanternState({ placeContext: null, todayIso: TODAY, homeDistanceM: 4000, wasHome: false, cityName: 'Porto', offline: false }),
    ).toEqual({ kind: 'outside', cityName: 'Porto' });
  });

  it('Outside with null cityName when offline — never a guessed/stale name (AC2)', () => {
    expect(
      resolveLanternState({ placeContext: null, todayIso: TODAY, homeDistanceM: 4000, wasHome: false, cityName: 'Porto', offline: true }),
    ).toEqual({ kind: 'outside', cityName: null });
  });

  it('Mall when placeContext is a mall — name present, offlineDot mirrors offline (AC2)', () => {
    expect(
      resolveLanternState({ placeContext: mallCtx('Colombo'), todayIso: TODAY, homeDistanceM: 4000, wasHome: false, cityName: null, offline: true }),
    ).toEqual({ kind: 'mall', name: 'Colombo', offlineDot: true });
  });

  it('Trip when today is within the trip dates', () => {
    expect(
      resolveLanternState({ placeContext: tripCtx('Faro', { startDate: '2026-07-20', endDate: '2026-07-30' }), todayIso: TODAY, homeDistanceM: null, wasHome: false, cityName: null, offline: false }),
    ).toEqual({ kind: 'trip', destination: 'Faro', offlineDot: false });
  });

  it('unset when no home is stored (isNearHome → null path)', () => {
    expect(
      resolveLanternState({ placeContext: null, todayIso: TODAY, homeDistanceM: null, wasHome: false, cityName: null, offline: false }),
    ).toEqual({ kind: 'unset' });
  });
});

describe('resolveLanternState — priority & filtering', () => {
  it('mall beats trip', () => {
    const ctx = { kind: 'mall', snapshot: { name: 'Colombo' } } as unknown as PlaceContext;
    const state = resolveLanternState({ placeContext: ctx, todayIso: TODAY, homeDistanceM: 4000, wasHome: false, cityName: 'x', offline: false });
    expect(state.kind).toBe('mall');
  });

  it('trip beats home/outside', () => {
    const state = resolveLanternState({ placeContext: tripCtx('Faro'), todayIso: TODAY, homeDistanceM: 10, wasHome: true, cityName: null, offline: false });
    expect(state.kind).toBe('trip');
  });

  it('off-grid "trips" are not a trip state — fall through to home/outside', () => {
    const state = resolveLanternState({ placeContext: tripCtx('Hike', { kind: 'offgrid' }), todayIso: TODAY, homeDistanceM: 4000, wasHome: false, cityName: 'Sintra', offline: false });
    expect(state).toEqual({ kind: 'outside', cityName: 'Sintra' });
  });

  it('a trip whose dates are in the past does not fire', () => {
    const state = resolveLanternState({ placeContext: tripCtx('Faro', { startDate: '2026-01-01', endDate: '2026-01-10' }), todayIso: TODAY, homeDistanceM: 4000, wasHome: false, cityName: 'Porto', offline: false });
    expect(state).toEqual({ kind: 'outside', cityName: 'Porto' });
  });
});

describe('resolveHomeProximity — hysteresis buffer (KAN-301 AC9)', () => {
  it('enters Home at ≤150 m, leaves only past 200 m', () => {
    expect(resolveHomeProximity(HOME_ENTER_M, false)).toBe(true);   // 150 → enter
    expect(resolveHomeProximity(151, false)).toBe(false);           // 151 → stay out
    expect(resolveHomeProximity(HOME_LEAVE_M, true)).toBe(true);    // 200 → still home
    expect(resolveHomeProximity(201, true)).toBe(false);            // 201 → leave
  });

  it('null distance (no home stored) stays null regardless of wasHome', () => {
    expect(resolveHomeProximity(null, false)).toBeNull();
    expect(resolveHomeProximity(null, true)).toBeNull();
  });

  it('a position oscillating between 140 m and 190 m produces no change after the first entry', () => {
    const samples = [200, 140, 190, 140, 190, 140]; // starts outside, enters, then jitters across the boundary
    let wasHome = false;
    const kinds: ('home' | 'outside')[] = [];
    for (const d of samples) {
      const state = resolveLanternState({ placeContext: null, todayIso: TODAY, homeDistanceM: d, wasHome, cityName: 'x', offline: false });
      wasHome = state.kind === 'home';
      kinds.push(state.kind as 'home' | 'outside');
    }
    // First sample (200) is outside; entry happens at the first 140; every later
    // 190/140 stays Home because leaving needs >200. One transition, total.
    expect(kinds).toEqual(['outside', 'home', 'home', 'home', 'home', 'home']);
  });
});
