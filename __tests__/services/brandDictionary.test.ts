import {
  BRAND_SUGGESTION_LIMIT,
  getBrandSuggestions,
  getCanonicalBrand,
  findBrandInText,
  findRequiredBrandInText,
  brandTaskMatchesPlace,
  filterBrandPlacesForTasks,
  isCanonicalBrandForType,
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

  it('resolves Portuguese Bank aliases and title text to one canonical value', () => {
    expect(getCanonicalBrand('bank', 'CGD')).toBe('Caixa Geral de Depósitos');
    expect(findBrandInText('bank', 'Visit Caixa Geral de Depositos Alcobaça')).toBe('Caixa Geral de Depósitos');
    expect(findRequiredBrandInText('Go to Solinca after work')).toEqual({ poiType: 'gym', brand: 'Solinca' });
  });

  it('matches required-brand tasks only with the Worker-provided canonical brand', () => {
    expect(brandTaskMatchesPlace({ poi: 'gym', poiBrand: 'Solinca' }, { brand: 'Solinca' })).toBe(true);
    expect(brandTaskMatchesPlace({ poi: 'gym', poiBrand: 'Solinca' }, { brand: 'Fitness Hut' })).toBe(false);
    expect(brandTaskMatchesPlace({ poi: 'gym' }, { brand: 'Solinca' })).toBe(false);
    expect(isCanonicalBrandForType('gym', 'Solinca')).toBe(true);
    expect(isCanonicalBrandForType('bank', 'Solinca')).toBe(false);
  });

  it('preserves generic types and combines results for distinct required brands', () => {
    const places = [{ brand: 'Solinca' }, { brand: 'Fitness Hut' }, { brand: 'Holmes Place' }];
    expect(filterBrandPlacesForTasks('pharmacy', places, [{ poi: 'pharmacy' }])).toEqual(places);
    expect(filterBrandPlacesForTasks('gym', places, [
      { poi: 'gym', poiBrand: 'Solinca' },
      { poi: 'gym', poiBrand: 'Fitness Hut' },
    ])).toEqual([{ brand: 'Solinca' }, { brand: 'Fitness Hut' }]);
  });
});
