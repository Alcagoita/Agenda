/**
 * extractCityName — KAN-301 reverse-geocode display-name picker (OSM Nominatim).
 *
 * The async reverseGeocode() wraps a Nominatim fetch; the interesting,
 * deterministic logic is which address field wins, which is pure and lives here.
 */

// maps.ts pulls in placesFunctions -> @react-native-firebase/functions, a
// native module unavailable under Jest. We only exercise the pure extractor.
jest.mock('../../src/services/placesFunctions', () => ({}));

import { extractCityName } from '../../src/services/maps';

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
    // state/country are deliberately not in the priority list.
    expect(extractCityName({} as never)).toBeNull();
  });

  it('returns null for null / undefined', () => {
    expect(extractCityName(null)).toBeNull();
    expect(extractCityName(undefined)).toBeNull();
  });
});
