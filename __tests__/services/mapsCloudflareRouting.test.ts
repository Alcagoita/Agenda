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
import { cloudflarePoiAllProxy } from '../../src/services/cloudflarePoiFunctions';

jest.mock('../../src/services/placesFunctions', () => ({
  searchNearbyPlacesProxy: jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  getPlaceDetailsProxy:    jest.fn(),
}));

jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflarePoiAllProxy:   jest.fn(),
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

const LAT = 38.7223, LNG = -9.1393, RADIUS = 500;

describe('searchNearbyPlaces — Cloudflare-first, OSM-failsafe routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOsmSearch.mockResolvedValue({});
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
