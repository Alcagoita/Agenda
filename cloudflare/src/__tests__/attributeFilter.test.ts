import { describe, it, expect, vi } from 'vitest';

// index.ts imports getContainer/Container at module load (KAN-354) — mock so
// importing the pure helper under test doesn't need a Container runtime.
vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: vi.fn() }),
  Container: class {},
}));

import { buildAttributeFilterClause } from '../index';

describe('buildAttributeFilterClause (KAN-344 cuisine groups)', () => {
  it('matches a classified cuisine against poi_attribute, unchanged', () => {
    const { clause, binds } = buildAttributeFilterClause({ dimension: 'food_cuisine', values: ['sushi'] });
    expect(clause).toContain('FROM poi_attribute');
    expect(clause).not.toContain('raw_category_labels');
    expect(binds).toEqual(['food_cuisine', 'sushi']);
  });

  it('resolves an umbrella group (asian) against the raw label path', () => {
    const { clause, binds } = buildAttributeFilterClause({ dimension: 'food_cuisine', values: ['asian'] });
    expect(clause).toBe('(poi.raw_category_labels LIKE ?)');
    expect(binds).toEqual(['%Asian Restaurant%']);
  });

  it('pizza returns Pizzerias plus Italian restaurants', () => {
    const { clause, binds } = buildAttributeFilterClause({ dimension: 'food_cuisine', values: ['pizza'] });
    expect(clause).toBe('(poi.raw_category_labels LIKE ? OR poi.raw_category_labels LIKE ?)');
    expect(binds).toEqual(['%Pizzeria%', '%Italian Restaurant%']);
  });

  it('maps each straightforward 1:1 group to its own label fragment', () => {
    for (const [value, fragment] of [
      ['seafood', '%Seafood Restaurant%'],
      ['brazilian', '%Brazilian Restaurant%'],
      ['mediterranean', '%Mediterranean Restaurant%'],
      ['bbq', '%BBQ Joint%'],
    ] as const) {
      const { clause, binds } = buildAttributeFilterClause({ dimension: 'food_cuisine', values: [value] });
      expect(clause).toBe('(poi.raw_category_labels LIKE ?)');
      expect(binds).toEqual([fragment]);
    }
  });

  it('ORs a group value together with a classified value', () => {
    const { clause, binds } = buildAttributeFilterClause({ dimension: 'food_cuisine', values: ['asian', 'italian'] });
    expect(clause).toBe(
      '(poi.raw_category_labels LIKE ? OR EXISTS (SELECT 1 FROM poi_attribute WHERE poi_attribute.fsq_place_id = poi.fsq_place_id AND poi_attribute.dimension = ? AND poi_attribute.value = ?))',
    );
    expect(binds).toEqual(['%Asian Restaurant%', 'food_cuisine', 'italian']);
  });

  it('only applies groups on the food_cuisine dimension', () => {
    // 'pizza' is a group name, but under store_kind it must stay a plain
    // poi_attribute lookup — groups are food-cuisine-only.
    const { clause, binds } = buildAttributeFilterClause({ dimension: 'store_kind', values: ['pizza'] });
    expect(clause).toContain('FROM poi_attribute');
    expect(clause).not.toContain('raw_category_labels');
    expect(binds).toEqual(['store_kind', 'pizza']);
  });
});
