/**
 * places.ts — KAN-304 split + next-up selection.
 *
 * Covers: Favourites (taught) vs Your usuals (learned) never merge and dedup by
 * brand (AC4), and the single "Next up" trip selection (AC9).
 */
import { splitPlaces, nextUpTripId } from '../../src/services/places';
import type { LearnedBrand } from '../../src/services/learnedPlaces';
import type { TaughtPlace } from '../../src/services/firestore/taughtPlaces';
import type { Trip } from '../../src/types';

const ts = { toMillis: () => 0 } as unknown as TaughtPlace['createdAt'];
const taught = (id: string, poiType: string, name: string): TaughtPlace => ({ id, poiType, name, createdAt: ts });
const learned = (poiType: string, name: string, visitCount = 3): LearnedBrand => ({ poiType, name, visitCount });
const trip = (id: string, startDate?: string): Trip => ({ id, destination: id, startDate } as unknown as Trip);

describe('splitPlaces', () => {
  it('keeps Favourites (taught) and Your usuals (learned) as separate lists (AC4)', () => {
    const { favourites, usuals } = splitPlaces([taught('t1', 'cafe', 'Sightglass')], [learned('supermarket', 'Whole Foods')]);
    expect(favourites).toEqual([{ poiType: 'cafe', name: 'Sightglass', taught: true, id: 't1' }]);
    expect(usuals).toEqual([{ poiType: 'supermarket', name: 'Whole Foods', taught: false }]);
  });

  it('a taught brand does not also appear under usuals (explicit beats inferred)', () => {
    const { favourites, usuals } = splitPlaces([taught('t1', 'cafe', 'Sightglass')], [learned('cafe', 'sightglass', 9)]);
    expect(favourites).toHaveLength(1);
    expect(usuals).toHaveLength(0);
  });

  it('returns two empty lists for the all-empty fixture', () => {
    expect(splitPlaces([], [])).toEqual({ favourites: [], usuals: [] });
  });
});

describe('nextUpTripId', () => {
  it('returns null for no planned trips', () => {
    expect(nextUpTripId([])).toBeNull();
  });

  it('returns the only trip when there is one', () => {
    expect(nextUpTripId([trip('a', '2026-08-01')])).toBe('a');
  });

  it('picks the earliest-starting trip among several', () => {
    expect(nextUpTripId([trip('late', '2026-09-10'), trip('soon', '2026-08-02'), trip('mid', '2026-08-20')])).toBe('soon');
  });

  it('sorts trips without a start date last', () => {
    expect(nextUpTripId([trip('nodate'), trip('dated', '2026-08-02')])).toBe('dated');
  });
});
