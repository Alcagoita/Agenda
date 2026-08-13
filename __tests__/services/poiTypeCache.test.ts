/**
 * KAN-253 — poiTypeCache now resolves from bundled local JSON only.
 *
 * Covers:
 *   - English and pt-PT labels come from the active app language
 *   - Slug / prefix matching works locally with no network path
 *   - Generic Google types filtered out by the old live-search policy stay hidden
 *   - Legacy compatibility exports are harmless no-ops
 */

import { setCopyLanguage } from '../../src/constants/copy';
import {
  __resetPoiTypeCacheDbForTests,
  lookupPoiTypeCache,
  recordPoiTypeSearch,
  searchPlaceTypesCached,
  seedPoiTypeCacheIfEmpty,
} from '../../src/services/poiTypeCache';
import enDictionary from '../../src/constants/poiDictionary.en.json';
import { SUPPORTED_GOOGLE_PLACE_TYPES } from '../../src/constants/googlePlaceTypes';

jest.mock('../../src/config/keys', () => ({
  GOOGLE_PLACES_API_KEY: 'TEST_KEY',
}));

jest.mock('../../src/services/placesFunctions', () => ({
  getPlaceDetailsProxy: jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  searchNearbyPlacesProxy: jest.fn(),
  searchPlaceTypesProxy: jest.fn(),
}));
jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflareCoverageProxy: jest.fn(),
  cloudflarePoiAllProxy:   jest.fn(),
}));

jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedReverseGeocode: jest.fn(),
  setCachedReverseGeocode: jest.fn(),
  __resetReverseGeocodeCacheForTests: jest.fn(),
}));

beforeEach(() => {
  setCopyLanguage('en');
  __resetPoiTypeCacheDbForTests();
});

afterEach(() => {
  setCopyLanguage('en');
});

describe('searchPlaceTypesCached', () => {
  it('keeps the bundled POI dictionary to the curated allowlist plus Brush-only financial types', () => {
    expect(Object.keys(enDictionary)).toHaveLength(SUPPORTED_GOOGLE_PLACE_TYPES.length + 3);
    expect(enDictionary).toHaveProperty('cafe');
    expect(enDictionary).toHaveProperty('coffee_shop');
    expect(enDictionary).not.toHaveProperty('coffee_roastery');
    expect(enDictionary).not.toHaveProperty('sushi_restaurant');
    expect(enDictionary).not.toHaveProperty('book_store');
    expect(enDictionary).not.toHaveProperty('electronics_store');
    expect(enDictionary).not.toHaveProperty('pet_store');
    expect(enDictionary).toMatchObject({
      currency_exchange: 'Currency exchange',
      money_transfer: 'Money transfer',
      financial_service: 'Financial service',
    });
  });

  it.each([
    ['currency exchange', 'currency_exchange', 'Currency exchange'],
    ['transferir dinheiro', 'money_transfer', 'Money transfer'],
    ['crédito ao consumo', 'financial_service', 'Financial service'],
    ['seguros', 'financial_service', 'Financial service'],
  ])('finds the worker-backed financial type for %p', async (query, type, label) => {
    await expect(searchPlaceTypesCached(query)).resolves.toContainEqual({ type, label });
  });

  it('returns English labels from the bundled dictionary', async () => {
    await expect(searchPlaceTypesCached('gym')).resolves.toEqual([
      { type: 'gym', label: 'Gym' },
    ]);
  });

  it('returns pt-PT labels from the bundled dictionary', async () => {
    setCopyLanguage('pt-PT');

    await expect(searchPlaceTypesCached('ginasio')).resolves.toEqual([
      { type: 'gym', label: 'Ginásio' },
    ]);
  });

  it('matches a kept raw type slug locally', async () => {
    const results = await searchPlaceTypesCached('restaurant');

    expect(results[0]).toEqual({ type: 'restaurant', label: 'Restaurant' });
  });

  it('does not surface trimmed cuisine microtypes', async () => {
    const results = await searchPlaceTypesCached('sushi');

    expect(results.some(result => result.type === 'restaurant')).toBe(true);
    expect(results.some(result => result.type === 'sushi_restaurant')).toBe(false);
  });

  it('routes book shopping through the broad store POI', async () => {
    const results = await searchPlaceTypesCached('buy a book');

    expect(results[0]).toEqual({ type: 'store', label: 'Store' });
  });

  it('handles filler words in longer retail phrasing', async () => {
    const results = await searchPlaceTypesCached('buy a new book');

    expect(results[0]).toEqual({ type: 'store', label: 'Store' });
  });

  it('generalizes book shopping beyond the original phrase', async () => {
    const results = await searchPlaceTypesCached('purchase a novel');

    expect(results[0]).toEqual({ type: 'store', label: 'Store' });
  });

  it('does not treat verb-style booking phrases as shopping intent', async () => {
    const results = await searchPlaceTypesCached('book a flight');

    expect(results[0]?.type).not.toBe('store');
  });

  it('prefers bakery over broad retail buckets for bread shopping intent', async () => {
    const results = await searchPlaceTypesCached('buy some bread');

    expect(results[0]).toEqual({ type: 'bakery', label: 'Bakery' });
    const marketIndex = results.findIndex(result => result.type === 'market');
    if (marketIndex !== -1) {
      expect(results.findIndex(result => result.type === 'bakery')).toBeLessThan(marketIndex);
    }
  });

  it('generalizes bakery matching for other bread-like nouns', async () => {
    const results = await searchPlaceTypesCached('get a loaf of bread');

    expect(results[0]).toEqual({ type: 'bakery', label: 'Bakery' });
  });

  it('prefers park for jogging intent', async () => {
    const results = await searchPlaceTypesCached('find a place to jog');

    expect(results[0]).toEqual({ type: 'park', label: 'Park' });
  });

  it('prefers park for running-place phrasing', async () => {
    const results = await searchPlaceTypesCached('place to run');

    expect(results[0]).toEqual({ type: 'park', label: 'Park' });
  });

  it('prefers park for relaxing-place phrasing', async () => {
    const results = await searchPlaceTypesCached('relaxing place');

    expect(results[0]).toEqual({ type: 'park', label: 'Park' });
  });

  it('surfaces gym for direct work-out phrasing', async () => {
    const results = await searchPlaceTypesCached('work out');

    expect(results[0]).toEqual({ type: 'gym', label: 'Gym' });
  });

  it('surfaces gym for training phrasing', async () => {
    const results = await searchPlaceTypesCached('place to train');

    expect(results[0]).toEqual({ type: 'gym', label: 'Gym' });
  });

  it('prefers florist for flower-buying intent', async () => {
    const results = await searchPlaceTypesCached('buy flowers');

    expect(results[0]).toEqual({ type: 'florist', label: 'Florist' });
  });

  it('prefers cafe for generic coffee intent', async () => {
    const results = await searchPlaceTypesCached('get coffee');

    expect(results[0]).toEqual({ type: 'cafe', label: 'Café' });
  });

  it('does not surface trimmed cafe microtypes for explicit roastery phrasing', async () => {
    const results = await searchPlaceTypesCached('go to a coffee roastery');

    expect(results.some(result => result.type === 'cafe')).toBe(true);
    expect(results.some(result => result.type === 'coffee_roastery')).toBe(false);
  });

  it('keeps cafe for generic coffee outings', async () => {
    const results = await searchPlaceTypesCached('go out for coffee');

    expect(results[0]).toEqual({ type: 'cafe', label: 'Café' });
  });

  it('prefers cafe for generic Portuguese coffee intent', async () => {
    setCopyLanguage('pt-PT');

    const results = await searchPlaceTypesCached('beber café');

    expect(results[0]).toEqual({ type: 'cafe', label: 'Café' });
  });

  it('does not surface trimmed cafe microtypes in Portuguese search', async () => {
    setCopyLanguage('pt-PT');

    const results = await searchPlaceTypesCached('ir a um café roastery');

    expect(results.some(result => result.type === 'coffee_roastery')).toBe(false);
  });

  it('prefers pharmacy for medicine pickup intent', async () => {
    const results = await searchPlaceTypesCached('pick up medicine');

    expect(results[0]).toEqual({ type: 'pharmacy', label: 'Pharmacy' });
  });

  it('does not surface trimmed store microtypes for shoe-buying intent', async () => {
    const results = await searchPlaceTypesCached('buy shoes');

    expect(results.some(result => result.type === 'store')).toBe(true);
    expect(results.some(result => result.type === 'shoe_store')).toBe(false);
  });

  it('matches built-in labels inside longer task phrasing', async () => {
    const results = await searchPlaceTypesCached('go to the gym');

    expect(results[0]).toEqual({ type: 'gym', label: 'Gym' });
  });

  it('supports Portuguese synonym ranking offline', async () => {
    setCopyLanguage('pt-PT');

    const results = await searchPlaceTypesCached('comprar um livro');

    expect(results[0]).toEqual({ type: 'store', label: 'Loja' });
  });

  it('supports Portuguese bakery intent offline', async () => {
    setCopyLanguage('pt-PT');

    const results = await searchPlaceTypesCached('comprar pão');

    expect(results[0]).toEqual({ type: 'bakery', label: 'Padaria' });
  });

  it('supports Portuguese gym intent offline', async () => {
    setCopyLanguage('pt-PT');

    const results = await searchPlaceTypesCached('treinar');

    expect(results[0]).toEqual({ type: 'gym', label: 'Ginásio' });
  });

  it('surfaces post office for package-mail phrasing', async () => {
    const results = await searchPlaceTypesCached('send package');

    expect(results[0]).toEqual({ type: 'post_office', label: 'Post Office' });
  });

  it('surfaces post office for mail phrasing', async () => {
    const results = await searchPlaceTypesCached('mail');

    expect(results[0]).toEqual({ type: 'post_office', label: 'Post Office' });
  });

  it('keeps exact built-in label matches stable', async () => {
    await expect(searchPlaceTypesCached('library')).resolves.toEqual([
      { type: 'library', label: 'Library' },
    ]);
  });

  it('returns an empty list on a miss', async () => {
    await expect(searchPlaceTypesCached('totally made up poi xyz')).resolves.toEqual([]);
  });

  it('keeps generic Google types hidden from results', async () => {
    const results = await searchPlaceTypesCached('country');

    expect(results.some(result => result.type === 'country')).toBe(false);
  });
});

describe('lookupPoiTypeCache', () => {
  it('returns null on a miss', () => {
    expect(lookupPoiTypeCache('nothing here')).toBeNull();
  });

  it('returns local bundled suggestions on a hit', () => {
    expect(lookupPoiTypeCache('florist')).toEqual([
      { type: 'florist', label: 'Florist' },
    ]);
  });
});

describe('legacy compatibility exports', () => {
  it('keeps the old seed/record/reset exports as harmless no-ops', () => {
    expect(() => seedPoiTypeCacheIfEmpty()).not.toThrow();
    expect(() => recordPoiTypeSearch('gym', [{ type: 'gym', label: 'Gym' }])).not.toThrow();
    expect(() => __resetPoiTypeCacheDbForTests()).not.toThrow();
  });
});
