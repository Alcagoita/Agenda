/**
 * KAN-342 — searchNearbyPlaces tries Brush's own Cloudflare POI database
 * first (covered cities), falls through to OSM (not Google) for anything
 * else. Google Places has no role in this function's path anymore.
 *
 * Covers:
 *   - covered: Cloudflare results used, bucketed by primary_poi_type,
 *     distance-sorted — OSM never called
 *   - not covered: falls through to OSM
 *   - Cloudflare poi/all throws: falls through to OSM, no throw
 *   - covered but genuinely empty results: trusted as final, OSM
 *     never called (an authoritative "nothing here" must not be second-guessed)
 */
import { searchNearbyPlaces } from '../../src/services/maps';
import { searchOsmPlacesStrict } from '../../src/services/osmPlaces';
import { cloudflarePoiAllProxy, cloudflareRequestCoverageProxy } from '../../src/services/cloudflarePoiFunctions';

jest.mock('../../src/services/placesFunctions', () => ({
  searchNearbyPlacesProxy: jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  getPlaceDetailsProxy:    jest.fn(),
}));

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

  it('uses Cloudflare results when the city is covered, bucketed by primary_poi_type and distance-sorted', async () => {
    mockPoiAll.mockResolvedValue({
      covered: true,
      cityId: 'lisboa',
      results: [
        { fsq_place_id: 'far', name: 'Far Cafe', lat: LAT, lng: LNG, primary_poi_type: 'cafe', brand: null, category_label: null, address: null, distanceMeters: 400 },
        { fsq_place_id: 'near', name: 'Near Cafe', lat: LAT, lng: LNG, primary_poi_type: 'cafe', brand: null, category_label: null, address: null, distanceMeters: 50 },
        { fsq_place_id: 'other-type', name: 'A Bank', lat: LAT, lng: LNG, primary_poi_type: 'bank', brand: null, category_label: null, address: null, distanceMeters: 10 },
      ],
    });

    const result = await searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS);

    expect(result.results.cafe.map(p => p.placeId)).toEqual(['near', 'far']);
    expect(mockOsmSearch).not.toHaveBeenCalled();
    expect(result.source).toBe('cloudflare');
    expect(result.coverageStatus).toBe('ready');
  });

  it('falls through to OSM when the city is not covered', async () => {
    mockPoiAll.mockResolvedValue({ covered: false, results: [] });
    mockOsmSearch.mockResolvedValue({
      cafe: [{ osmId: 'node/1', name: 'OSM Cafe', isGenericName: false, lat: LAT, lng: LNG, distanceMeters: 30, footprintAreaM2: 0 }],
    });

    const result = await searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS);

    expect(mockPoiAll).toHaveBeenCalledWith(LAT, LNG, RADIUS);
    expect(mockOsmSearch).toHaveBeenCalledWith(LAT, LNG, ['cafe'], RADIUS);
    expect(result.results.cafe.map(p => p.placeId)).toEqual(['node/1']);
    expect(result.source).toBe('osm');
    expect(result.coverageStatus).toBe('none');
  });

  it('falls through to OSM when the Cloudflare request throws', async () => {
    mockPoiAll.mockRejectedValue(new Error('network error'));

    await expect(searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS)).resolves.toBeDefined();
    expect(mockOsmSearch).toHaveBeenCalled();
  });

  it('trusts a genuinely empty covered result as final — does not fall through to OSM', async () => {
    mockPoiAll.mockResolvedValue({ covered: true, cityId: 'lisboa', results: [] });

    const result = await searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS);

    expect(result.results.cafe).toEqual([]);
    expect(mockOsmSearch).not.toHaveBeenCalled();
    expect(result.source).toBe('cloudflare');
    expect(result.coverageStatus).toBe('ready');
  });

  it('AC: coverageStatus "building" is carried through when Cloudflare reports a city mid-build', async () => {
    mockPoiAll.mockResolvedValue({ covered: false, status: 'building', results: [] });
    mockOsmSearch.mockResolvedValue({ cafe: [] });

    const result = await searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS);

    expect(result.source).toBe('osm');
    expect(result.coverageStatus).toBe('building');
  });

  it('AC: no Google path exists — Cloudflare failure + OSM failure never reaches a Google call (structurally, none is imported)', async () => {
    mockPoiAll.mockRejectedValue(new Error('network error'));
    mockOsmSearch.mockRejectedValue(new Error('Overpass: all endpoints failed'));

    await expect(searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS)).rejects.toThrow('Overpass: all endpoints failed');
    // No placesFunctions mock call assertion needed: maps.ts has no import of
    // placesFunctions/searchNearbyPlacesProxy in this file at all — the mock
    // above is registered only so unrelated code doesn't crash Jest.
  });

  // KAN-342 review: searchOsmPlacesStrict (not the lenient searchOsmPlaces)
  // is used deliberately — proximity.ts's offline retry-queue depends on
  // catching a real thrown error to distinguish "couldn't look" (retry
  // later) from "looked, found nothing" (a settled answer). Collapsing both
  // into an empty result would silently break that distinction. See
  // tripDownload.ts for the same choice made for the same reason.
  it('AC: a genuine OSM network failure propagates as a thrown error, not an empty result', async () => {
    mockPoiAll.mockResolvedValue({ covered: false, results: [] });
    mockOsmSearch.mockRejectedValue(new Error('Overpass: all endpoints failed'));

    await expect(searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS)).rejects.toThrow('Overpass: all endpoints failed');
  });

  it('AC: OSM genuinely finding zero results resolves normally (the settled path), not a throw', async () => {
    mockPoiAll.mockResolvedValue({ covered: false, results: [] });
    mockOsmSearch.mockResolvedValue({ cafe: [] });

    const result = await searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS);

    expect(result.results.cafe).toEqual([]);
  });
});

// KAN-355 zero check: a coverage-demand request fires only on a genuine
// zero — Cloudflare uncovered AND OSM also found nothing — and only when
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

  it('fires a background coverage-request on a genuine zero (uncovered + OSM empty) in a real settlement', async () => {
    mockPoiAll.mockResolvedValue({ covered: false, results: [] });

    await searchNearbyPlaces(10.0, 10.0, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).toHaveBeenCalledWith(10.0, 10.0);
  });

  it('does not fire when OSM actually found something — not a genuine zero', async () => {
    mockPoiAll.mockResolvedValue({ covered: false, results: [] });
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
    mockPoiAll.mockResolvedValue({ covered: false, results: [] });

    await searchNearbyPlaces(10.6, 10.6, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).not.toHaveBeenCalled();
  });

  it('does not fire when the point has no country at all — ocean/Antarctica', async () => {
    mockClassifyFetch(NO_COUNTRY_GEOCODE);
    mockPoiAll.mockResolvedValue({ covered: false, results: [] });

    await searchNearbyPlaces(10.7, 10.7, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).not.toHaveBeenCalled();
  });

  it('does not fire a coverage-request when status is building', async () => {
    mockPoiAll.mockResolvedValue({ covered: false, status: 'building', results: [] });

    await searchNearbyPlaces(11.0, 11.0, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).not.toHaveBeenCalled();
  });

  it('does not fire a coverage-request when the location is covered and ready', async () => {
    mockPoiAll.mockResolvedValue({ covered: true, cityId: 'lisboa', results: [] });

    await searchNearbyPlaces(12.0, 12.0, ['cafe'], RADIUS);
    await flushZeroCheck();

    expect(mockRequestCoverage).not.toHaveBeenCalled();
  });

  it('dedupes repeat requests within the same ~1km cell — fires once, not once per tick', async () => {
    mockPoiAll.mockResolvedValue({ covered: false, results: [] });

    await searchNearbyPlaces(13.0, 13.0, ['cafe'], RADIUS);
    await searchNearbyPlaces(13.001, 13.001, ['cafe'], RADIUS); // same ~1km cell after rounding
    await flushZeroCheck();

    expect(mockRequestCoverage).toHaveBeenCalledTimes(1);
  });

  it('still resolves normally when the fire-and-forget coverage-request itself rejects', async () => {
    mockPoiAll.mockResolvedValue({ covered: false, results: [] });
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
    mockPoiAll.mockResolvedValue({ covered: false, results: [] });
    mockOsmSearch.mockResolvedValue({ cafe: [] });

    const result = await searchNearbyPlaces(15.0, 15.0, ['cafe'], RADIUS);

    expect(result.results.cafe).toEqual([]);
    expect(result.source).toBe('osm');
  });
});
