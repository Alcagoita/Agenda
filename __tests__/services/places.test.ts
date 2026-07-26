/**
 * places.ts — KAN-304 merge + cap for the Places-I-know list.
 *
 * Covers: taught-before-learned ordering and marker (AC6/AC3), never two rows
 * for the same brand (AC2), the 5-row cap + overflow (AC5), and the all-empty
 * case (AC9, data level).
 */
import { mergePlaces, capPlaces, PLACES_SECTION_CAP } from '../../src/services/places';
import type { LearnedBrand } from '../../src/services/learnedPlaces';
import type { TaughtPlace } from '../../src/services/firestore/taughtPlaces';

const ts = { toMillis: () => 0 } as unknown as TaughtPlace['createdAt'];
const taught = (id: string, poiType: string, name: string): TaughtPlace => ({ id, poiType, name, createdAt: ts });
const learned = (poiType: string, name: string, visitCount = 3): LearnedBrand => ({ poiType, name, visitCount });

describe('mergePlaces', () => {
  it('puts taught brands first, then learned', () => {
    const merged = mergePlaces([taught('t1', 'cafe', 'Sightglass')], [learned('supermarket', 'Whole Foods')]);
    expect(merged).toEqual([
      { poiType: 'cafe', name: 'Sightglass', taught: true, id: 't1' },
      { poiType: 'supermarket', name: 'Whole Foods', taught: false },
    ]);
  });

  it('never yields two rows for the same brand — a taught brand hides its learned twin (AC2)', () => {
    const merged = mergePlaces([taught('t1', 'cafe', 'Sightglass')], [learned('cafe', 'Sightglass', 9)]);
    expect(merged).toEqual([{ poiType: 'cafe', name: 'Sightglass', taught: true, id: 't1' }]);
  });

  it('treats brand identity case/space-insensitively', () => {
    const merged = mergePlaces([taught('t1', 'cafe', 'Sightglass')], [learned('cafe', '  sightglass ', 9)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].taught).toBe(true);
  });

  it('keeps a same-name brand of a different type separate', () => {
    const merged = mergePlaces([], [learned('cafe', 'Central'), learned('pharmacy', 'Central')]);
    expect(merged).toHaveLength(2);
  });

  it('returns [] for the all-empty fixture (AC9)', () => {
    expect(mergePlaces([], [])).toEqual([]);
  });
});

describe('capPlaces (AC5)', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ poiType: 'cafe', name: `Brand ${i}`, taught: false }));

  it('caps at the section cap and flags overflow with the true total', () => {
    const { visible, total, hasOverflow } = capPlaces(many);
    expect(visible).toHaveLength(PLACES_SECTION_CAP);
    expect(total).toBe(7);
    expect(hasOverflow).toBe(true);
  });

  it('shows no overflow when everything fits', () => {
    const { visible, hasOverflow } = capPlaces(many.slice(0, PLACES_SECTION_CAP));
    expect(visible).toHaveLength(PLACES_SECTION_CAP);
    expect(hasOverflow).toBe(false);
  });

  it('handles the empty list', () => {
    expect(capPlaces([])).toEqual({ visible: [], total: 0, hasOverflow: false });
  });
});
