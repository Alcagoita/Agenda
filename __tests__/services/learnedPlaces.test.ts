/**
 * KAN-230 / KAN-240 / KAN-304 — learnedPlaces: on-device ranking of the brands
 * the user actually brushes tasks at.
 *
 * Raw per-place-id visit counts arrive pre-tallied from
 * `/users/{uid}/learnedPlaceCounts` (kept current by setTaskDone's
 * transaction). KAN-304: this module aggregates them by (POI type, name) into
 * learned BRANDS, so branches of the same brand count together, and never
 * yields two entries with the same type + name.
 *
 * Covers (fixtures only):
 *   - a brand below LEARNED_PLACE_THRESHOLD total visits is not learned
 *   - a brand at exactly the threshold is promoted
 *   - visits across distinct place ids sharing type + name aggregate (AC1)
 *   - the ranking never contains two rows with the same type + name (AC2)
 *   - ranking sorted by total visit count descending
 *   - getLearnedPlaceForPoiType returns the best-ranked brand for a type
 */

import { computeLearnedPlaces, getLearnedPlaceForPoiType, LEARNED_PLACE_THRESHOLD } from '../../src/services/learnedPlaces';
import type { LearnedPlace } from '../../src/services/learnedPlaces';

function count(placeId: string, name: string, poiType: string, visitCount: number): LearnedPlace {
  return { placeId, name, poiType, visitCount };
}

describe('LEARNED_PLACE_THRESHOLD', () => {
  it('defaults to 3', () => {
    expect(LEARNED_PLACE_THRESHOLD).toBe(3);
  });
});

describe('computeLearnedPlaces (brand aggregation)', () => {
  it('does not promote a brand below the threshold', () => {
    expect(computeLearnedPlaces([count('hp_1', 'Corner ATM', 'atm', 2)])).toEqual([]);
  });

  it('promotes a brand at exactly LEARNED_PLACE_THRESHOLD visits', () => {
    expect(computeLearnedPlaces([count('hp_1', 'Corner ATM', 'atm', 3)])).toEqual([
      { poiType: 'atm', name: 'Corner ATM', visitCount: 3 },
    ]);
  });

  it('aggregates visits across distinct place ids sharing type + name (AC1)', () => {
    // Three brushes at three different Whole Foods — one preferred brand.
    const counts = [
      count('wf_1', 'Whole Foods', 'supermarket', 1),
      count('wf_2', 'Whole Foods', 'supermarket', 1),
      count('wf_3', 'Whole Foods', 'supermarket', 1),
    ];
    expect(computeLearnedPlaces(counts)).toEqual([
      { poiType: 'supermarket', name: 'Whole Foods', visitCount: 3 },
    ]);
  });

  it('never yields two rows with the same type + name (AC2)', () => {
    const counts = [
      count('wf_1', 'Whole Foods', 'supermarket', 2),
      count('wf_2', 'Whole Foods', 'supermarket', 2),
    ];
    const ranked = computeLearnedPlaces(counts);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toEqual({ poiType: 'supermarket', name: 'Whole Foods', visitCount: 4 });
  });

  it('keeps a same-name brand of a DIFFERENT type separate', () => {
    const counts = [
      count('a', 'Central', 'cafe', 3),
      count('b', 'Central', 'pharmacy', 3),
    ];
    expect(computeLearnedPlaces(counts)).toHaveLength(2);
  });

  it('ranks brands by total visit count descending', () => {
    const ranked = computeLearnedPlaces([
      count('hp_1', 'Corner ATM', 'atm', 3),
      count('hp_2', 'Sightglass', 'cafe', 5),
    ]);
    expect(ranked).toEqual([
      { poiType: 'cafe', name: 'Sightglass', visitCount: 5 },
      { poiType: 'atm', name: 'Corner ATM', visitCount: 3 },
    ]);
  });

  it('returns an empty array for no counts', () => {
    expect(computeLearnedPlaces([])).toEqual([]);
  });
});

describe('getLearnedPlaceForPoiType', () => {
  const learned = [
    { poiType: 'cafe', name: 'Sightglass', visitCount: 5 },
    { poiType: 'atm', name: 'Corner ATM', visitCount: 3 },
  ];

  it('returns the learned brand matching the given POI type', () => {
    expect(getLearnedPlaceForPoiType(learned, 'cafe')).toEqual(learned[0]);
  });

  it('returns null when no learned brand matches the type', () => {
    expect(getLearnedPlaceForPoiType(learned, 'pharmacy')).toBeNull();
  });

  it('returns null for an empty ranking', () => {
    expect(getLearnedPlaceForPoiType([], 'cafe')).toBeNull();
  });
});
