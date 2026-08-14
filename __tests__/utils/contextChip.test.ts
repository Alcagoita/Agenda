/**
 * contextChip.ts — trip date predicates.
 *
 * The resolver this file was written for (resolveContextChipView) and its
 * component are gone (KAN-349). What remains under test is the trip-date logic
 * CalendarScreen, useWhereWeveBeen, usePlaces and utils/lantern still call.
 */
import { isTodayWithinTripDates, isTripPast } from '../../src/utils/contextChip';
import type { Trip } from '../../src/types';

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-1',
    destination: 'Faro',
    placeRef: 'place-1',
    centerLat: 0,
    centerLng: 0,
    areaRadius: 5_000,
    cacheAreaId: 'area-1',
    expiresAt: Date.now() + 1_000_000,
    createdAt: {} as Trip['createdAt'],
    ...overrides,
  };
}

describe('isTodayWithinTripDates', () => {
  it('is true for a dateless trip (both skipped)', () => {
    expect(isTodayWithinTripDates(makeTrip({ startDate: undefined, endDate: undefined }), '2026-07-06')).toBe(true);
  });

  it('is true when today falls within start/end', () => {
    const trip = makeTrip({ startDate: '2026-07-01', endDate: '2026-07-24' });
    expect(isTodayWithinTripDates(trip, '2026-07-06')).toBe(true);
  });

  it('is false before the start date', () => {
    const trip = makeTrip({ startDate: '2026-07-10', endDate: '2026-07-24' });
    expect(isTodayWithinTripDates(trip, '2026-07-06')).toBe(false);
  });

  it('is false after the end date', () => {
    const trip = makeTrip({ startDate: '2026-07-01', endDate: '2026-07-04' });
    expect(isTodayWithinTripDates(trip, '2026-07-06')).toBe(false);
  });
});

describe('isTripPast (KAN-257)', () => {
  it('is true when endDate is before today', () => {
    const trip = makeTrip({ startDate: '2026-06-01', endDate: '2026-06-10' });
    expect(isTripPast(trip, '2026-07-06')).toBe(true);
  });

  it('is false when endDate is today', () => {
    const trip = makeTrip({ startDate: '2026-07-01', endDate: '2026-07-06' });
    expect(isTripPast(trip, '2026-07-06')).toBe(false);
  });

  it('is false when endDate is in the future', () => {
    const trip = makeTrip({ startDate: '2026-07-01', endDate: '2026-07-24' });
    expect(isTripPast(trip, '2026-07-06')).toBe(false);
  });

  it('is false for a dateless trip', () => {
    const trip = makeTrip({ startDate: undefined, endDate: undefined });
    expect(isTripPast(trip, '2026-07-06')).toBe(false);
  });

  it('is false for a trip with only a startDate (no endDate)', () => {
    const trip = makeTrip({ startDate: '2026-06-01', endDate: undefined });
    expect(isTripPast(trip, '2026-07-06')).toBe(false);
  });

  it('is evaluated purely from endDate, regardless of kind (off-grid or otherwise) — kind filtering is the caller\'s job', () => {
    const trip = makeTrip({ kind: 'offgrid', startDate: '2026-06-01', endDate: '2026-06-10' });
    expect(isTripPast(trip, '2026-07-06')).toBe(true);
  });
});
