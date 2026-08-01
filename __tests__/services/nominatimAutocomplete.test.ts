/**
 * nominatimAutocomplete.test.ts — KAN-320
 *
 * Unit tests for searchDestinationAutocomplete / searchAddressAutocomplete,
 * migrated from Google Places to OSM Nominatim. Covers:
 *   - empty/whitespace query short-circuits (no network)
 *   - response mapping to PlaceAutocompleteSuggestion[] (with lat/lng)
 *   - searchDestinationAutocomplete restricts to settlement addresstype values
 *   - searchAddressAutocomplete keeps every result, no class filter
 *   - the autocomplete rate limit (1 req/s) waits out the window instead of
 *     dropping the call, on its OWN clock — independent of reverseGeocode's,
 *     which fires on every GPS fix and must not starve a user's search
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
  reverseGeocode,
  __resetReverseGeocodeForTests,
  __resetNominatimAutocompleteForTests,
} from '../../src/services/maps';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function nominatimResult(overrides: Partial<{
  place_id: number; display_name: string; lat: string; lon: string; addresstype: string; name: string;
}> = {}) {
  return {
    place_id:     1,
    display_name: 'Faro, Distrito de Faro, Portugal',
    lat:          '37.0179',
    lon:          '-7.9304',
    addresstype:  'city',
    ...overrides,
  };
}

function mockOk(results: unknown[]) {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => results });
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetReverseGeocodeForTests();
  __resetNominatimAutocompleteForTests();
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

  it('excludes non-settlement results (addresstype not city/town/village/hamlet/municipality)', async () => {
    mockOk([
      nominatimResult({ place_id: 1, addresstype: 'city' }),
      nominatimResult({ place_id: 2, addresstype: 'shop', display_name: 'Faro Bakery, Faro, Portugal' }),
      nominatimResult({ place_id: 3, addresstype: 'county', display_name: 'Faro, Portugal' }),
    ]);

    const results = await searchDestinationAutocomplete('faro');

    expect(results).toHaveLength(1);
    expect(results[0].placeId).toBe('osm:1');
  });

  it('includes town/village/hamlet/municipality, not just city (real Nominatim tags settlements differently by size)', async () => {
    mockOk([
      nominatimResult({ place_id: 1, addresstype: 'town' }),
      nominatimResult({ place_id: 2, addresstype: 'village' }),
      nominatimResult({ place_id: 3, addresstype: 'hamlet' }),
      nominatimResult({ place_id: 4, addresstype: 'municipality' }),
    ]);

    const results = await searchDestinationAutocomplete('faro');

    expect(results.map(r => r.placeId)).toEqual(['osm:1', 'osm:2', 'osm:3', 'osm:4']);
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
    mockOk([nominatimResult({ place_id: 2, addresstype: 'shop', display_name: '221B Baker Street, London, UK' })]);

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

describe('autocomplete rate limit (KAN-320)', () => {
  it('waits out the remaining window instead of dropping a call made within 1 s of the previous request', async () => {
    jest.useFakeTimers();
    mockOk([nominatimResult({ place_id: 1 })]);
    mockOk([nominatimResult({ place_id: 2 })]);

    const firstPromise = searchDestinationAutocomplete('faro');
    await Promise.resolve(); // let the first request's own microtasks settle
    const secondPromise = searchAddressAutocomplete('lisbon');

    // Second call is now blocked on waitForAutocompleteSlot — nothing fetched yet.
    await Promise.resolve();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first[0].placeId).toBe('osm:1');
    expect(second[0].placeId).toBe('osm:2');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  it('fires immediately when called more than 1 s after the previous request', async () => {
    jest.useFakeTimers();
    mockOk([nominatimResult({ place_id: 1 })]);
    await searchDestinationAutocomplete('faro');

    jest.advanceTimersByTime(1_000);
    mockOk([nominatimResult({ place_id: 2 })]);
    const results = await searchAddressAutocomplete('lisbon');

    expect(results[0].placeId).toBe('osm:2');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  it('does not wait on reverseGeocode\'s clock — a background GPS-driven call cannot starve a user search (KAN-320 review)', async () => {
    // Simulate useLanternState's background reverseGeocode firing right
    // before the user's search — this used to burn the shared clock's 1s
    // window and force the search to wait (or, before that, drop it).
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ address: { city: 'Lisboa' } }) });
    await reverseGeocode(38.7223, -9.1393);

    mockOk([nominatimResult({ place_id: 1 })]);
    const results = await searchDestinationAutocomplete('faro');

    expect(results[0].placeId).toBe('osm:1');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
