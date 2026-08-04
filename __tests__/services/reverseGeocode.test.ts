/**
 * reverseGeocode — KAN-301 OSM Nominatim reverse-geocoder.
 *
 * Covers the pure city-name extractor, plus the Nominatim usage-policy
 * guarantees: results are cached per ~100 m cell, and no two requests ever fire
 * within 1 second.
 */

// maps.ts pulls in placesFunctions -> @react-native-firebase/functions (native,
// unavailable under Jest), and reverseGeocodeCache -> expo-sqlite. Stub both.
jest.mock('../../src/services/placesFunctions', () => ({}));
jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflareCoverageProxy: jest.fn(),
  cloudflarePoiAllProxy:   jest.fn(),
}));
jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedCity: jest.fn(() => ({ hit: false, city: null })),
  putCachedCity: jest.fn(),
}));
jest.mock('../../src/services/osmPlaces', () => ({
  searchOsmPlaces:       jest.fn(),
  searchOsmPlacesStrict: jest.fn(),
}));

import { extractCityName, reverseGeocode, __resetReverseGeocodeForTests } from '../../src/services/maps';
import { cloudflareCoverageProxy, cloudflarePoiAllProxy } from '../../src/services/cloudflarePoiFunctions';
import { searchOsmPlaces, searchOsmPlacesStrict } from '../../src/services/osmPlaces';

describe('extractCityName (KAN-301, Nominatim address)', () => {
  it('prefers city over broader fields', () => {
    expect(extractCityName({ city: 'Lisboa', county: 'Lisboa', suburb: 'Alfama' })).toBe('Lisboa');
  });

  it('falls back to town, then village, then municipality', () => {
    expect(extractCityName({ town: 'Reading' })).toBe('Reading');
    expect(extractCityName({ village: 'Sintra' })).toBe('Sintra');
    expect(extractCityName({ municipality: 'Cascais' })).toBe('Cascais');
  });

  it('falls back to suburb, then county, as a last resort', () => {
    expect(extractCityName({ suburb: 'Benfica' })).toBe('Benfica');
    expect(extractCityName({ county: 'Grande Porto' })).toBe('Grande Porto');
  });

  it('returns null when no populated-place field is present (never a state/country)', () => {
    expect(extractCityName({} as never)).toBeNull();
  });

  it('returns null for null / undefined', () => {
    expect(extractCityName(null)).toBeNull();
    expect(extractCityName(undefined)).toBeNull();
  });
});

describe('reverseGeocode — caching + rate limit (KAN-301, Nominatim policy)', () => {
  const okResponse = { ok: true, json: async () => ({ address: { city: 'Lisboa' } }) };

  beforeEach(() => {
    __resetReverseGeocodeForTests();
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue(okResponse);
  });

  it('hits the network once when the position moves within the same ~100 m cell', async () => {
    // Three fixes that all round to 38.722,-9.139.
    expect(await reverseGeocode(38.7223, -9.1393)).toBe('Lisboa');
    expect(await reverseGeocode(38.7224, -9.1394)).toBe('Lisboa');
    expect(await reverseGeocode(38.7222, -9.1392)).toBe('Lisboa');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('never fires a second request within 1 second (different cells)', async () => {
    await reverseGeocode(38.722, -9.139);   // cell A → one request
    await reverseGeocode(40.000, -8.000);   // cell B, immediately → rate-limited, no request
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null (user sees "Outside") when the request fails', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockRejectedValue(new Error('offline'));
    expect(await reverseGeocode(41.15, -8.61)).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null on a non-OK response', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await reverseGeocode(41.15, -8.61)).toBeNull();
  });

  // KAN-342 item 5 — Lantern independence. The city label must stay resolvable
  // through Nominatim even when the POI chain (Cloudflare, OSM) is entirely
  // broken — a POI-source outage must never change the user's location label.
  // Asserted behaviorally (reverseGeocode still resolves) AND structurally
  // (none of the POI-chain functions are ever touched), so a future refactor
  // that accidentally routes reverseGeocode through the POI chain fails loudly
  // here instead of only showing up as a confusing outage in the field.
  it('AC: resolves the city via Nominatim even when every POI-chain function throws — never calls them', async () => {
    (cloudflareCoverageProxy as jest.Mock).mockRejectedValue(new Error('cloudflare down'));
    (cloudflarePoiAllProxy as jest.Mock).mockRejectedValue(new Error('cloudflare down'));
    (searchOsmPlaces as jest.Mock).mockRejectedValue(new Error('overpass down'));
    (searchOsmPlacesStrict as jest.Mock).mockRejectedValue(new Error('overpass down'));

    expect(await reverseGeocode(38.7223, -9.1393)).toBe('Lisboa');

    expect(cloudflareCoverageProxy).not.toHaveBeenCalled();
    expect(cloudflarePoiAllProxy).not.toHaveBeenCalled();
    expect(searchOsmPlaces).not.toHaveBeenCalled();
    expect(searchOsmPlacesStrict).not.toHaveBeenCalled();
  });
});
