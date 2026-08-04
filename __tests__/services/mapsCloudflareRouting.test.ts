/**
 * KAN-342 — searchNearbyPlaces tries Brush's own Cloudflare POI database
 * first (covered cities), falls through to Google on anything else.
 *
 * Covers:
 *   - covered + ready: Cloudflare results used, bucketed by primary_poi_type,
 *     distance-sorted — Google never called
 *   - not covered (status 'none'/'building'): falls through to Google
 *   - Cloudflare coverage check throws: falls through to Google, no throw
 *   - Cloudflare poi/all throws after a ready coverage check: falls through to Google
 *   - covered + ready but genuinely empty results: trusted as final, Google
 *     never called (an authoritative "nothing here" must not be second-guessed)
 */
import { searchNearbyPlaces } from '../../src/services/maps';
import { searchNearbyPlacesProxy } from '../../src/services/placesFunctions';
import { cloudflareCoverageProxy, cloudflarePoiAllProxy } from '../../src/services/cloudflarePoiFunctions';

jest.mock('../../src/services/placesFunctions', () => ({
  searchNearbyPlacesProxy: jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  getPlaceDetailsProxy:    jest.fn(),
}));

jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflareCoverageProxy: jest.fn(),
  cloudflarePoiAllProxy:   jest.fn(),
}));

// reverseGeocodeCache -> expo-sqlite, unavailable under Jest — stub it, same
// pattern as nominatimAutocomplete.test.ts / reverseGeocode.test.ts.
jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedCity: jest.fn(() => ({ hit: false, city: null })),
  putCachedCity: jest.fn(),
}));

const mockCoverage = cloudflareCoverageProxy as jest.Mock;
const mockPoiAll = cloudflarePoiAllProxy as jest.Mock;
const mockGoogleSearch = searchNearbyPlacesProxy as jest.Mock;

const LAT = 38.7223, LNG = -9.1393, RADIUS = 500;

describe('searchNearbyPlaces — Cloudflare-first routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses Cloudflare results when the city is covered and ready, bucketed by primary_poi_type and distance-sorted', async () => {
    mockCoverage.mockResolvedValue({ status: 'ready', cityId: 'lisboa' });
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

    expect(result.cafe.map(p => p.placeId)).toEqual(['near', 'far']);
    expect(mockGoogleSearch).not.toHaveBeenCalled();
  });

  it('falls through to Google when the city is not covered', async () => {
    mockCoverage.mockResolvedValue({ status: 'none', cityId: null });
    mockGoogleSearch.mockResolvedValue({ places: [] });

    await searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS);

    expect(mockPoiAll).not.toHaveBeenCalled();
    expect(mockGoogleSearch).toHaveBeenCalled();
  });

  it('falls through to Google when the coverage check itself throws', async () => {
    mockCoverage.mockRejectedValue(new Error('network error'));
    mockGoogleSearch.mockResolvedValue({ places: [] });

    await expect(searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS)).resolves.toBeDefined();
    expect(mockGoogleSearch).toHaveBeenCalled();
  });

  it('falls through to Google when poi/all throws after a ready coverage check', async () => {
    mockCoverage.mockResolvedValue({ status: 'ready', cityId: 'lisboa' });
    mockPoiAll.mockRejectedValue(new Error('radius rejected'));
    mockGoogleSearch.mockResolvedValue({ places: [] });

    await searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS);

    expect(mockGoogleSearch).toHaveBeenCalled();
  });

  it('trusts a genuinely empty covered result as final — does not fall through to Google', async () => {
    mockCoverage.mockResolvedValue({ status: 'ready', cityId: 'lisboa' });
    mockPoiAll.mockResolvedValue({ covered: true, cityId: 'lisboa', results: [] });

    const result = await searchNearbyPlaces(LAT, LNG, ['cafe'], RADIUS);

    expect(result.cafe).toEqual([]);
    expect(mockGoogleSearch).not.toHaveBeenCalled();
  });
});
