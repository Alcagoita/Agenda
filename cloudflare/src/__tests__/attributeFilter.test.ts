import { describe, it, expect, vi } from 'vitest';

// index.ts imports getContainer/Container at module load (KAN-354) — mock so
// importing the pure helper under test doesn't need a Container runtime.
vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: vi.fn() }),
  Container: class {},
}));

import { buildAttributeFilterClause } from '../index';

const EXISTS = 'EXISTS (SELECT 1 FROM overture_poi_attribute WHERE overture_poi_attribute.overture_id = overture_poi.overture_id AND overture_poi_attribute.dimension = ? AND overture_poi_attribute.value = ?)';

describe('buildAttributeFilterClause (KAN-344 cuisine groups, KAN-438 on Overture)', () => {
  it('matches a classified cuisine against the attribute table', () => {
    const { clause, binds } = buildAttributeFilterClause({ dimension: 'food_cuisine', values: ['sushi'] });
    expect(clause).toBe(`(${EXISTS})`);
    expect(binds).toEqual(['food_cuisine', 'sushi']);
  });

  it('resolves an umbrella group to the cuisines it covers', () => {
    // Until KAN-438 this was a LIKE against Foursquare's own label path
    // (`poi.raw_category_labels LIKE '%Asian Restaurant%'`). Overture has no
    // such path, and its categories are classified one-to-one onto the app's
    // 87 cuisines, so an umbrella is a set of real values rather than a text
    // search.
    const { clause, binds } = buildAttributeFilterClause({ dimension: 'food_cuisine', values: ['asian'] });
    expect(clause.startsWith('(EXISTS')).toBe(true);
    const values = binds.filter((_, index) => index % 2 === 1);
    expect(values).toContain('asian');
    expect(values).toContain('japanese');
    expect(values).toContain('thai');
    expect(binds.filter((_, index) => index % 2 === 0).every(d => d === 'food_cuisine')).toBe(true);
  });

  it('pizza is pizza, and no longer drags in Italian', () => {
    // The old group was ['Pizzeria', 'Italian Restaurant'], which made
    // Telepizza an Italian restaurant. They are different cuisines and the
    // app carries both.
    const { clause, binds } = buildAttributeFilterClause({ dimension: 'food_cuisine', values: ['pizza'] });
    expect(clause).toBe(`(${EXISTS})`);
    expect(binds).toEqual(['food_cuisine', 'pizza']);
  });

  it('an umbrella always covers its own name', () => {
    // `seafood`, `brazilian` and `mediterranean` are themselves among the 87
    // classified cuisines, so a row classified exactly as one must still be
    // found by a request for it.
    for (const value of ['seafood', 'brazilian', 'mediterranean'] as const) {
      const { binds } = buildAttributeFilterClause({ dimension: 'food_cuisine', values: [value] });
      expect(binds.filter((_, index) => index % 2 === 1)).toContain(value);
    }
  });

  it('ORs a group value together with a classified value', () => {
    const { clause, binds } = buildAttributeFilterClause({ dimension: 'food_cuisine', values: ['asian', 'italian'] });
    expect(clause.split(' OR ').length).toBeGreaterThan(2);
    expect(binds.filter((_, index) => index % 2 === 1)).toContain('italian');
  });

  it('only applies groups on the food_cuisine dimension', () => {
    // 'pizza' is a group name, but under store_kind it must stay a plain
    // attribute lookup — groups are food-cuisine-only.
    const { clause, binds } = buildAttributeFilterClause({ dimension: 'store_kind', values: ['pizza'] });
    expect(clause).toBe(`(${EXISTS})`);
    expect(binds).toEqual(['store_kind', 'pizza']);
  });

  it('never reaches for a Foursquare column', () => {
    for (const dimension of ['food_cuisine', 'store_kind'] as const) {
      const { clause } = buildAttributeFilterClause({ dimension, values: ['asian', 'sushi'] });
      expect(clause).not.toContain('raw_category_labels');
      expect(clause).not.toContain('fsq_place_id');
    }
  });
});
