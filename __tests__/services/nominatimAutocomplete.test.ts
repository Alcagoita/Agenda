/**
 * nominatimAutocomplete.test.ts — KAN-320
 *
 * Unit tests for searchDestinationAutocomplete / searchAddressAutocomplete,
 * migrated from Google Places to OSM Nominatim. Covers:
 *   - empty/whitespace query short-circuits (no network)
 *   - response mapping to PlaceAutocompleteSuggestion[] (with lat/lng)
 *   - searchDestinationAutocomplete restricts to class:"place" results
 *   - searchAddressAutocomplete keeps every result, no class filter
 *   - the shared Nominatim rate limit (1 req/s) drops a call instead of
 *     queuing it — same policy as reverseGeocode
 *   - location bias (viewbox) included only when lat/lng are given
 *   - network/non-OK failures return [] (best-effort, never throws)
 */

// maps.ts pulls in placesFunctions -> @react-native-firebase/functions (native,
// unavailable under Jest) and reverseGeocodeCache -> expo-sqlite. Stub both —
// same pattern as reverseGeocode.test.ts.
jest.mock('../../src/services/placesFunctions', () => ({}));
jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedCity: jest.fn(() => ({ hit: false, city: null })),
  putCachedCity: jest.fn(),
}));

import {
  searchDestinationAutocomplete,
  searchAddressAutocomplete,
  __resetReverseGeocodeForTests,
} from '../../src/services/maps';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function nominatimResult(overrides: Partial<{
  place_id: number; display_name: string; lat: string; lon: string; class: string; name: string;
}> = {}) {
  return {
    place_id:     1,
    display_name: 'Faro, Distrito de Faro, Portugal',
    lat:          '37.0179',
    lon:          '-7.9304',
    class:        'place',
    ...overrides,
  };
}

function mockOk(results: unknown[]) {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => results });
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetReverseGeocodeForTests();
});

describe('searchDestinationAutocomplete (KAN-320, Nominatim)', () => {
  it('returns empty array for empty query without calling the network', async () => {
    const results = await searchDestinationAutocomplete('');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('returns empty array for whitespace-only query', async () => {
    const results = await searchDestinationAutocomplete('   ');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('maps a Nominatim result to a PlaceAutocompleteSuggestion with lat/lng', async () => {
    mockOk([nominatimResult()]);

    const results = await searchDestinationAutocomplete('faro');

    expect(results).toEqual([{
      placeId: 'osm:1',
      name:    'Faro',
      address: 'Distrito de Faro, Portugal',
      lat:     37.0179,
      lng:     -7.9304,
    }]);
  });

  it('excludes non-settlement results (class !== "place")', async () => {
    mockOk([
      nominatimResult({ place_id: 1, class: 'place' }),
      nominatimResult({ place_id: 2, class: 'shop', display_name: 'Faro Bakery, Faro, Portugal' }),
    ]);

    const results = await searchDestinationAutocomplete('faro');

    expect(results).toHaveLength(1);
    expect(results[0].placeId).toBe('osm:1');
  });

  it('caps results at 5 even when the API returns more', async () => {
    const many = Array.from({ length: 8 }, (_, i) => nominatimResult({ place_id: i }));
    mockOk(many);

    const results = await searchDestinationAutocomplete('faro');
    expect(results).toHaveLength(5);
  });

  it('includes a viewbox bias in the request when lat/lng are provided', async () => {
    mockOk([]);
    await searchDestinationAutocomplete('faro', 37.0179, -7.9304);

    const [url] = mockFetch.mock.calls[0];
    const params = new URL(url as string).searchParams;
    const [minLon, maxLat, maxLon, minLat] = (params.get('viewbox') ?? '').split(',').map(Number);
    expect(minLon).toBeCloseTo(-8.4304);
    expect(maxLat).toBeCloseTo(37.5179);
    expect(maxLon).toBeCloseTo(-7.4304);
    expect(minLat).toBeCloseTo(36.5179);
    expect(params.get('bounded')).toBe('0');
  });

  it('omits viewbox when lat/lng are not provided', async () => {
    mockOk([]);
    await searchDestinationAutocomplete('faro');

    const [url] = mockFetch.mock.calls[0];
    expect(new URL(url as string).searchParams.has('viewbox')).toBe(false);
  });

  it('returns empty array on a non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    expect(await searchDestinationAutocomplete('faro')).toEqual([]);
  });

  it('returns empty array on a network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    expect(await searchDestinationAutocomplete('faro')).toEqual([]);
  });

  it('sends the identifying User-Agent header Nominatim requires', async () => {
    mockOk([]);
    await searchDestinationAutocomplete('faro');

    const [, options] = mockFetch.mock.calls[0];
    expect((options as RequestInit).headers).toMatchObject({ 'User-Agent': expect.stringContaining('BrushApp/') });
  });
});

describe('searchAddressAutocomplete (KAN-320, Nominatim)', () => {
  it('keeps non-settlement results — no class restriction', async () => {
    mockOk([nominatimResult({ place_id: 2, class: 'shop', display_name: '221B Baker Street, London, UK' })]);

    const results = await searchAddressAutocomplete('221b baker street');

    expect(results).toEqual([{
      placeId: 'osm:2',
      name:    '221B Baker Street',
      address: 'London, UK',
      lat:     37.0179,
      lng:     -7.9304,
    }]);
  });

  it('returns empty array for empty query without calling the network', async () => {
    const results = await searchAddressAutocomplete('');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});

describe('Nominatim rate limit (KAN-320, shared with reverseGeocode)', () => {
  it('drops a call made within 1 s of the previous Nominatim request', async () => {
    mockOk([nominatimResult()]);
    mockOk([nominatimResult()]);

    const first = await searchDestinationAutocomplete('faro');
    const second = await searchAddressAutocomplete('lisbon');

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
