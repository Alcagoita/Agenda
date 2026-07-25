/**
 * extractCityName — KAN-301 reverse-geocode display-name picker.
 *
 * The async reverseGeocode() wraps a cloud-function call (covered by the
 * function's own tests); the interesting, deterministic logic is which address
 * component wins, which is pure and lives here.
 */
// maps.ts pulls in placesFunctions -> @react-native-firebase/functions, a
// native module unavailable under Jest. We only exercise the pure extractor.
jest.mock('../../src/services/placesFunctions', () => ({
  reverseGeocodeProxy: jest.fn(),
}));

import { extractCityName } from '../../src/services/maps';
import type { GeocodeAddressComponent } from '../../src/services/placesFunctions';

const comp = (long_name: string, types: string[]): GeocodeAddressComponent => ({ long_name, types });

describe('extractCityName (KAN-301)', () => {
  it('prefers locality (the city proper) over broader areas', () => {
    const components = [
      comp('Lisboa', ['locality', 'political']),
      comp('Lisbon District', ['administrative_area_level_1', 'political']),
      comp('Portugal', ['country', 'political']),
    ];
    expect(extractCityName(components)).toBe('Lisboa');
  });

  it('falls back to postal_town when there is no locality', () => {
    const components = [
      comp('Reading', ['postal_town']),
      comp('England', ['administrative_area_level_1', 'political']),
    ];
    expect(extractCityName(components)).toBe('Reading');
  });

  it('falls back to sublocality, then administrative_area_level_2', () => {
    expect(extractCityName([comp('Benfica', ['sublocality', 'political'])])).toBe('Benfica');
    expect(extractCityName([comp('Grande Porto', ['administrative_area_level_2'])])).toBe('Grande Porto');
  });

  it('returns null when only a country / postcode is present (never label with those)', () => {
    const components = [
      comp('Portugal', ['country', 'political']),
      comp('1000-001', ['postal_code']),
    ];
    expect(extractCityName(components)).toBeNull();
  });

  it('returns null for empty / undefined components', () => {
    expect(extractCityName([])).toBeNull();
    expect(extractCityName(undefined)).toBeNull();
  });
});
