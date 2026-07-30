import {
  BRAND_SUGGESTION_LIMIT,
  getBrandSuggestions,
  getCanonicalBrand,
} from '../../src/services/brandDictionary';

describe('brandDictionary', () => {
  it('filters suggestions case- and accent-insensitively for a POI type', () => {
    expect(getBrandSuggestions('cafe', 'brasileira')).toEqual(['Café A Brasileira']);
    expect(getBrandSuggestions('cafe', 'CAFE')).toEqual(['Café A Brasileira']);
  });

  it('orders suggestions by visible brand correspondence', () => {
    expect(getBrandSuggestions('cafe', 'co').slice(0, 3)).toEqual([
      'Costa Coffee',
      'Copenhagen Coffee Lab',
      'Fabrica Coffee Roasters',
    ]);
    expect(getBrandSuggestions('cafe', 'po')).toEqual(['A Padaria Portuguesa']);
  });

  it('returns canonical spelling for exact normalized matches', () => {
    expect(getCanonicalBrand('restaurant', 'mcdonalds')).toBe("McDonald's");
    expect(getCanonicalBrand('supermarket', 'pingo doce')).toBe('Pingo Doce');
    expect(getCanonicalBrand('supermarket', 'pingodoce')).toBe('Pingo Doce');
  });

  it('limits empty-query suggestions for a POI type', () => {
    expect(getBrandSuggestions('cafe', '')).toHaveLength(BRAND_SUGGESTION_LIMIT);
  });

  it('does not match brands from another POI type', () => {
    expect(getBrandSuggestions('gym', 'pingo')).toEqual([]);
    expect(getCanonicalBrand('gym', 'Pingo Doce')).toBeNull();
  });
});
