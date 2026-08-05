/**
 * storeAutocomplete.test.ts — KAN-76
 *
 * Unit tests for searchPlacesAutocomplete (maps.ts) — establishment search,
 * still Google-backed via placesAutocompleteProxy (a Cloud Function proxy;
 * KAN-320 spike found no Nominatim equivalent for ranked establishment
 * search, only settlement/address geocoding).
 *
 * searchDestinationAutocomplete / searchAddressAutocomplete moved to
 * Nominatim in KAN-320 — see nominatimAutocomplete.test.ts for their
 * coverage; the request-body assertions here (locationBias, FieldMask,
 * includedPrimaryTypes) no longer apply to either since request shaping for
 * both moved server-side (proxy) / to Nominatim's own query params.
 */

const mockPlacesAutocompleteProxy = jest.fn();
jest.mock('../../src/services/placesFunctions', () => ({
  searchNearbyPlacesProxy: jest.fn(),
  placesAutocompleteProxy: (...args: unknown[]) => mockPlacesAutocompleteProxy(...args),
  getPlaceDetailsProxy:    jest.fn(),
}));
jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflareCoverageProxy: jest.fn(),
  cloudflarePoiAllProxy:   jest.fn(),
}));
jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedCity: jest.fn(() => ({ hit: false, city: null })),
  putCachedCity: jest.fn(),
}));

import { searchPlacesAutocomplete } from '../../src/services/maps';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockApiResponse(suggestions: unknown[]) {
  mockPlacesAutocompleteProxy.mockResolvedValueOnce({ suggestions });
}

function makeSuggestion(placeId: string, name: string, address: string) {
  return {
    placePrediction: {
      placeId,
      structuredFormat: {
        mainText:      { text: name    },
        secondaryText: { text: address },
      },
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => jest.clearAllMocks());

describe('searchPlacesAutocomplete', () => {
  it('returns empty array for empty query without calling the proxy', async () => {
    const results = await searchPlacesAutocomplete('');
    expect(mockPlacesAutocompleteProxy).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('returns empty array for whitespace-only query', async () => {
    const results = await searchPlacesAutocomplete('   ');
    expect(mockPlacesAutocompleteProxy).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('calls the proxy in establishment mode with query and lat/lng', async () => {
    mockApiResponse([]);
    await searchPlacesAutocomplete('coffee', 51.5, -0.1);
    expect(mockPlacesAutocompleteProxy).toHaveBeenCalledWith('coffee', 'establishment', 51.5, -0.1);
  });

  it('maps proxy response to PlaceAutocompleteSuggestion[]', async () => {
    mockApiResponse([
      makeSuggestion('gpl-1', 'Nike Store',  'Oxford Street, London'),
      makeSuggestion('gpl-2', 'Adidas Store', 'Bond Street, London'),
    ]);

    const results = await searchPlacesAutocomplete('nike');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      placeId: 'gpl-1',
      name:    'Nike Store',
      address: 'Oxford Street, London',
    });
    expect(results[1]).toEqual({
      placeId: 'gpl-2',
      name:    'Adidas Store',
      address: 'Bond Street, London',
    });
  });

  it('caps results at 5 even when the proxy returns more', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      makeSuggestion(`gpl-${i}`, `Store ${i}`, `Address ${i}`),
    );
    mockApiResponse(many);

    const results = await searchPlacesAutocomplete('store');
    expect(results).toHaveLength(5);
  });

  it('skips suggestions without a placeId', async () => {
    mockApiResponse([
      { placePrediction: {} },    // no placeId
      makeSuggestion('gpl-1', 'Nike Store', 'London'),
    ]);

    const results = await searchPlacesAutocomplete('nike');
    expect(results).toHaveLength(1);
    expect(results[0].placeId).toBe('gpl-1');
  });

  it('falls back to placeId as name when mainText is absent', async () => {
    mockApiResponse([
      { placePrediction: { placeId: 'gpl-1', structuredFormat: {} } },
    ]);

    const results = await searchPlacesAutocomplete('test');
    expect(results[0].name).toBe('gpl-1');
    expect(results[0].address).toBe('');
  });

  it('returns empty array when the proxy call throws', async () => {
    mockPlacesAutocompleteProxy.mockRejectedValueOnce(new Error('Network error'));
    const results = await searchPlacesAutocomplete('nike');
    expect(results).toEqual([]);
  });
});
