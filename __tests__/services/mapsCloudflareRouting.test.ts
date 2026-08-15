/**
 * KAN-342 — searchNearbyPlaces tries Brush's own Cloudflare POI database
 * first (covered cities), falls through to OSM (not Google) for anything
 * else. Google Places has no role in this function's path anymore.
 *
 * Covers:
 *   - global typed Cloudflare results used directly — OSM never called
 *   - global empty result: falls through to OSM
 *   - Cloudflare poi/all throws: falls through to OSM, no throw
 *   - a completed Cloudflare empty result plus OSM empty triggers coverage demand
 */
import { searchNearbyPlaces } from '../../src/services/maps';
import { searchOsmPlacesStrict } from '../../src/services/osmPlaces';
import { cloudflarePoiAllProxy, cloudflareRequestCoverageProxy } from '../../src/services/cloudflarePoiFunctions';

jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflarePoiAllProxy:         jest.fn(),
  cloudflareRequestCoverageProxy: jest.fn(),
}));

jest.mock('../../src/services/osmPlaces', () => ({
  searchOsmPlacesStrict: jest.fn(),
}));

// reverseGeocodeCache -> expo-sqlite, unavailable under Jest — stub it, same
// pattern as nominatimAutocomplete.test.ts / reverseGeocode.test.ts.
jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedCity: jest.fn(() => ({ hit: false, city: null })),
  putCachedCity: jest.fn(),
}));

const mockPoiAll = cloudflarePoiAllProxy as jest.Mock;
const mockOsmSearch = searchOsmPlacesStrict as jest.Mock;
const mockRequestCoverage = cloudflareRequestCoverageProxy as jest.Mock;

const LAT = 38.7223, LNG = -9.1393, RADIUS = 500;

describe('searchNearbyPlaces — Cloudflare-first, OSM-failsafe routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOsmSearch.mockResolvedValue({});
    mockRequestCoverage.mockResolvedValue({ coverageStatus: 'none', cityId: null });
  });

  it('uses globally returned, pre-bucketed Cloudflare results without an OSM request', async () => {
    mockPoiAll.mockResolvedValue({
      results: { cafe: [
        { poi_id: 'near', fsq_place_id: 'near', name: 'Near Cafe', lat: LAT, lng: LNG, primary_poi_type: 'cafe', brand: null, category_label: null, address: null, distanceMeters: 50 },
        { poi_id: 'far', fsq_place_id: 'far', name: 'Far Cafe', lat: LAT, lng: LNG, primary_poi_type: 'cafe', brand: null, category_label: null, address: null, distanceMeters: 400 },
      ] },
    });

    const result = await searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS);

    expect(result.results.cafe.map(p => p.placeId)).toEqual(['near', 'far']);
    expect(mockOsmSearch).not.toHaveBeenCalled();
    expect(result.source).toBe('cloudflare');
    expect(result.coverageStatus).toBe('ready');
  });

  it('splits more than 32 nearby buckets so a large Store-brand task list stays searchable', async () => {
    const requests = Array.from({ length: 33 }, (_, index) => ({
      key: `store:brand:Brand ${index + 1}`,
      type: 'store',
      brand: `Brand ${index + 1}`,
    }));
    mockPoiAll
      .mockResolvedValueOnce({ results: { 'store:brand:Brand 1': [
        { poi_id: 'one', fsq_place_id: 'one', name: 'Brand 1', lat: LAT, lng: LNG, primary_poi_type: 'store', brand: 'Brand 1', category_label: null, address: null, distanceMeters: 20 },
      ] } })
      .mockResolvedValueOnce({ results: { 'store:brand:Brand 33': [
        { poi_id: 'thirty-three', fsq_place_id: 'thirty-three', name: 'Brand 33', lat: LAT, lng: LNG, primary_poi_type: 'store', brand: 'Brand 33', category_label: null, address: null, distanceMeters: 30 },
      ] } });

    const result = await searchNearbyPlaces(LAT, LNG, ['store'], RADIUS, requests);

    expect(mockPoiAll.mock.calls.map(call => call[3])).toHaveLength(2);
    expect(mockPoiAll.mock.calls.map(call => call[3].length)).toEqual([32, 1]);
    expect(result.results.store.map(place => place.name)).toEqual(['Brand 1', 'Brand 33']);
    expect(mockOsmSearch).not.toHaveBeenCalled();
  });

  it('uses the explicit community POI identity when a moderated record has no Foursquare id', async () => {
    mockPoiAll.mockResolvedValue({
      results: { restaurant: [
        { poi_id: 'community:the-sushi-soul', fsq_place_id: null, name: 'The Sushi Soul', lat: LAT, lng: LNG, primary_poi_type: 'restaurant', brand: null, category_label: null, address: null, distanceMeters: 50, attributes: { food_cuisine: ['sushi'] } },
      ] },
    });

    const result = await searchNearbyPlaces(LAT, LNG, ['restaurant'], RADIUS);

    expect(result.results.restaurant).toMatchObject([{ placeId: 'community:the-sushi-soul', name: 'The Sushi Soul' }]);
    expect(mockOsmSearch).not.toHaveBeenCalled();
  });

  it('merges request-keyed subtype buckets into the broad app type with stored attributes', async () => {
    mockPoiAll.mockResolvedValue({
      results: {
        'restaurant:food_cuisine:sushi': [
          { poi_id: 'sushi', fsq_place_id: 'sushi', name: 'Sushi Near', lat: LAT, lng: LNG, primary_poi_type: 'restaurant', brand: null, category_label: null, address: null, distanceMeters: 40, attributes: { food_cuisine: ['sushi'] } },
        ],
        'restaurant:food_cuisine:vegetarian': [
          { poi_id: 'sushi', fsq_place_id: 'sushi', name: 'Sushi Near', lat: LAT, lng: LNG, primary_poi_type: 'restaurant', brand: null, category_label: null, address: null, distanceMeters: 40, attributes: { food_cuisine: ['vegetarian'] } },
        ],
      },
    });

    const result = await searchNearbyPlaces(LAT, LNG, ['restaurant'], RADIUS, [
      { key: 'restaurant:food_cuisine:sushi', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['sushi'] } },
      { key: 'restaurant:food_cuisine:vegetarian', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['vegetarian'] } },
    ]);

    expect(result.results.restaurant).toHaveLength(1);
    expect(result.results.restaurant).toMatchObject([{
      placeId: 'sushi',
      restaurantFoodType: 'sushi',
      restaurantFoodTypes: expect.arrayContaining(['sushi', 'vegetarian']),
    }]);
    expect(mockOsmSearch).not.toHaveBeenCalled();
  });

  it('propagates a group subtype onto both singular and plural fields for a generic-first pizzeria (KAN-344)', async () => {
    // Pizzeria appears first in the broad bucket with NO classified cuisine,
    // then again in the pizza subtype bucket (server-matched via raw label).
    // The merge must set both restaurantFoodTypes and restaurantFoodType.
    const pizzeria = { poi_id: 'pz', fsq_place_id: 'pz', name: 'Tutto Pizza', lat: LAT, lng: LNG, primary_poi_type: 'restaurant', brand: null, category_label: 'Dining and Drinking > Restaurant > Pizzeria', address: null, distanceMeters: 40 };
    mockPoiAll.mockResolvedValue({
      results: {
        restaurant: [pizzeria],
        'restaurant:food_cuisine:pizza': [pizzeria],
      },
    });

    const result = await searchNearbyPlaces(LAT, LNG, ['restaurant'], RADIUS, [
      { key: 'restaurant', type: 'restaurant' },
      { key: 'restaurant:food_cuisine:pizza', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['pizza'] } },
    ]);

    expect(result.results.restaurant).toHaveLength(1);
    expect(result.results.restaurant[0]).toMatchObject({
      placeId: 'pz',
      restaurantFoodType: 'pizza',
      restaurantFoodTypes: ['pizza'],
    });
    expect(mockOsmSearch).not.toHaveBeenCalled();
  });

  it('falls through to OSM when the global query is empty', async () => {
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });
    mockOsmSearch.mockResolvedValue({
      cafe: [{ osmId: 'node/1', name: 'OSM Cafe', isGenericName: false, lat: LAT, lng: LNG, distanceMeters: 30, footprintAreaM2: 0 }],
    });

    const result = await searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS);

    expect(mockPoiAll).toHaveBeenCalledWith(LAT, LNG, RADIUS, [{ key: 'cafe', type: 'cafe' }]);
    expect(mockOsmSearch).toHaveBeenCalledWith(LAT, LNG, ['cafe'], RADIUS);
    expect(result.results.cafe.map(p => p.placeId)).toEqual(['node/1']);
    expect(result.source).toBe('osm');
    expect(result.coverageStatus).toBeUndefined();
  });

  it('carries an OSM canonical brand through the fallback result', async () => {
    mockPoiAll.mockResolvedValue({ results: { store: [] } });
    mockOsmSearch.mockResolvedValue({
      store: [{ osmId: 'node/zara', name: 'Zara', isGenericName: false, lat: LAT, lng: LNG, distanceMeters: 30, footprintAreaM2: 0, brand: 'Zara' }],
    });

    const result = await searchNearbyPlaces(LAT, LNG, ['store'], RADIUS);

    expect(result.results.store).toMatchObject([{ placeId: 'node/zara', brand: 'Zara' }]);
  });

  it('falls through to OSM when the Cloudflare request throws', async () => {
    mockPoiAll.mockRejectedValue(new Error('network error'));

    await expect(searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS)).resolves.toBeDefined();
    expect(mockOsmSearch).toHaveBeenCalled();
  });

  it('uses OSM when the global query has no requested POIs', async () => {
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });
    mockOsmSearch.mockResolvedValue({ cafe: [{ osmId: 'node/2', name: 'OSM Cafe', isGenericName: false, lat: LAT, lng: LNG, distanceMeters: 25, footprintAreaM2: 0 }] });

    const result = await searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS);

    expect(result.results.cafe.map(p => p.placeId)).toEqual(['node/2']);
    expect(mockOsmSearch).toHaveBeenCalled();
    expect(result.source).toBe('osm');
  });

  it('AC: no Google path exists — Cloudflare failure + OSM failure never reaches a Google call (structurally, none is imported)', async () => {
    mockPoiAll.mockRejectedValue(new Error('network error'));
    mockOsmSearch.mockRejectedValue(new Error('Overpass: all endpoints failed'));

    await expect(searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS)).rejects.toThrow('Overpass: all endpoints failed');
    // Importing maps without a Google-client mock proves this path cannot
    // reach Google after a Cloudflare failure.
  });

  // KAN-342 review: searchOsmPlacesStrict (not the lenient searchOsmPlaces)
  // is used deliberately — proximity.ts's offline retry-queue depends on
  // catching a real thrown error to distinguish "couldn't look" (retry
  // later) from "looked, found nothing" (a settled answer). Collapsing both
  // into an empty result would silently break that distinction. See
  // tripDownload.ts for the same choice made for the same reason.
  it('AC: a genuine OSM network failure propagates as a thrown error, not an empty result', async () => {
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });
    mockOsmSearch.mockRejectedValue(new Error('Overpass: all endpoints failed'));

    await expect(searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS)).rejects.toThrow('Overpass: all endpoints failed');
  });

  it('AC: OSM genuinely finding zero results resolves normally (the settled path), not a throw', async () => {
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });
    mockOsmSearch.mockResolvedValue({ cafe: [] });

    const result = await searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS);

    expect(result.results.cafe).toEqual([]);
  });
});

// KAN-347 zero check: a coverage-demand request fires only on a genuine
// zero — the global query AND OSM both found nothing — and only when
// the location reverse-geocodes to a real, unmapped settlement (not the
// ocean, not farmland with no settlement). Deduped per coarse (~1km) cell
// for the app's session; never retried for 'building'/'ready'. Distinct
// coordinates per test (never LAT/LNG above) so the module-scope dedupe Set
// doesn't leak state across tests in this file.
describe('searchNearbyPlaces — KAN-355 zero check / coverage demand recording', () => {
  const SETTLEMENT_GEOCODE = { address: { city: 'Somewhereton', country_code: 'pt' } };
  const NO_SETTLEMENT_GEOCODE = { address: { country_code: 'pt' } }; // country, no city/town/village — desert/farmland
  const NO_COUNTRY_GEOCODE = { address: {} }; // ocean/Antarctica — Nominatim returns no country_code at all

  function mockClassifyFetch(body: unknown) {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body } as Response);
  }

  /** classifyLocation's fetch->json->then chain needs more than one microtask tick to settle after searchNearbyPlaces already returned. */
  async function flushZeroCheck() {
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockOsmSearch.mockResolvedValue({ cafe: [] });
    mockRequestCoverage.mockResolvedValue({ coverageStatus: 'none', cityId: null });
    mockClassifyFetch(SETTLEMENT_GEOCODE);
  });

  it('fires a background coverage-request on a genuine zero (global empty + OSM empty) in a real settlement', async () => {
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });

    await searchNearbyPlaces(10.0, 10.0, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).toHaveBeenCalledWith(10.0, 10.0);
  });

  it('does not fire when Nominatim rejects the classification request', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });

    await searchNearbyPlaces(10.2, 10.2, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).not.toHaveBeenCalled();
  });

  it('does not fire when Nominatim responds not-ok during classification', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false } as Response);
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });

    await searchNearbyPlaces(10.3, 10.3, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).not.toHaveBeenCalled();
  });

  it('does not fire when OSM actually found something — not a genuine zero', async () => {
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });
    mockOsmSearch.mockResolvedValue({
      cafe: [{ osmId: 'node/1', name: 'OSM Cafe', isGenericName: false, lat: 10.5, lng: 10.5, distanceMeters: 20, footprintAreaM2: 0 }],
    });

    await searchNearbyPlaces(10.5, 10.5, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled(); // never even classifies — no zero to check
  });

  it('does not fire when the point has no settlement — desert/farmland between towns', async () => {
    mockClassifyFetch(NO_SETTLEMENT_GEOCODE);
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });

    await searchNearbyPlaces(10.6, 10.6, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).not.toHaveBeenCalled();
  });

  it('does not fire when the point has no country at all — ocean/Antarctica', async () => {
    mockClassifyFetch(NO_COUNTRY_GEOCODE);
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });

    await searchNearbyPlaces(10.7, 10.7, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).not.toHaveBeenCalled();
  });

  it('does not fire a coverage-request when the global request itself fails', async () => {
    mockPoiAll.mockRejectedValue(new Error('network error'));

    await searchNearbyPlaces(11.0, 11.0, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).not.toHaveBeenCalled();
  });

  it('does not fire a coverage-request when the global query found a POI', async () => {
    mockPoiAll.mockResolvedValue({ results: { cafe: [{ poi_id: 'global-1', fsq_place_id: 'global-1', name: 'Global Cafe', lat: 12, lng: 12, primary_poi_type: 'cafe', brand: null, category_label: null, address: null, distanceMeters: 10 }] } });

    await searchNearbyPlaces(12.0, 12.0, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).not.toHaveBeenCalled();
  });

  it('dedupes repeat requests within the same ~1km cell — fires once, not once per tick', async () => {
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });

    await searchNearbyPlaces(13.0, 13.0, ['cafe'], RADIUS);
    await searchNearbyPlaces(13.001, 13.001, ['cafe'], RADIUS); // same ~1km cell after rounding
    await flushZeroCheck();

    expect(mockRequestCoverage).toHaveBeenCalledTimes(1);
  });

  it('still resolves normally when the fire-and-forget coverage-request itself rejects', async () => {
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });
    mockRequestCoverage.mockRejectedValue(new Error('network error'));

    const result = await searchNearbyPlaces(14.0, 14.0, ['cafe'], RADIUS);

    expect(result.results.cafe).toEqual([]);
    expect(result.source).toBe('osm');
    await flushZeroCheck();
    expect(mockRequestCoverage).toHaveBeenCalledWith(14.0, 14.0);
    // Observe the rejection explicitly — if requestCoverageDemandOnce ever
    // lost its own .catch(), this would surface as an unhandled rejection
    // here instead of the assertion above silently passing.
    await expect(mockRequestCoverage.mock.results[0].value).rejects.toThrow('network error');
  });

  it('still resolves with real OSM fallback results when a genuine zero check runs in the background', async () => {
    mockPoiAll.mockResolvedValue({ results: { cafe: [] } });
    mockOsmSearch.mockResolvedValue({ cafe: [] });

    const result = await searchNearbyPlaces(15.0, 15.0, ['cafe'], RADIUS);

    expect(result.results.cafe).toEqual([]);
    expect(result.source).toBe('osm');
  });
});
