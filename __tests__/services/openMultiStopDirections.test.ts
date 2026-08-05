/**
 * KAN-281 — maps.ts's openMultiStopDirections.
 *
 * Pure URL construction + Linking.openURL handoff — no network. We never
 * compute the route ourselves; this only orders/labels the stops for Maps.
 */

const mockOpenURL = jest.fn().mockResolvedValue(undefined);
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Linking:  { openURL: (...args: unknown[]) => mockOpenURL(...args) },
}));

// maps.ts also imports placesFunctions.ts, which pulls in
// @react-native-firebase/functions (native, unavailable under Jest) —
// mocked at the service boundary, same as elsewhere. Unused by this test.
jest.mock('../../src/services/placesFunctions', () => ({
  getPlaceDetailsProxy:    jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  searchNearbyPlacesProxy: jest.fn(),
  searchPlaceTypesProxy:   jest.fn(),
}));
jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflareCoverageProxy: jest.fn(),
  cloudflarePoiAllProxy:   jest.fn(),
}));

import { openMultiStopDirections } from '../../src/services/maps';

const ORIGIN = { lat: 38.7, lng: -9.1 };

describe('openMultiStopDirections', () => {
  beforeEach(() => jest.clearAllMocks());

  it('builds a directions URL with origin, destination (last stop), and waypoints (the rest)', async () => {
    const stops = [
      { lat: 38.71, lng: -9.11 },
      { lat: 38.72, lng: -9.12 },
      { lat: 38.73, lng: -9.13 },
    ];

    await openMultiStopDirections(ORIGIN, stops);

    const [url] = mockOpenURL.mock.calls[0];
    expect(url).toContain('https://www.google.com/maps/dir/?api=1');
    expect(url).toContain('origin=38.7,-9.1');
    expect(url).toContain('destination=38.73,-9.13');
    expect(url).toContain(encodeURIComponent('38.71,-9.11|38.72,-9.12'));
  });

  it('never includes a travelmode param — the user picks that inside Maps', async () => {
    await openMultiStopDirections(ORIGIN, [{ lat: 38.71, lng: -9.11 }]);
    const [url] = mockOpenURL.mock.calls[0];
    expect(url).not.toContain('travelmode=');
  });

  it('omits the waypoints param entirely when there is only one stop', async () => {
    await openMultiStopDirections(ORIGIN, [{ lat: 38.71, lng: -9.11 }]);
    const [url] = mockOpenURL.mock.calls[0];
    expect(url).not.toContain('waypoints=');
  });

  it('does nothing when there are no stops', async () => {
    await openMultiStopDirections(ORIGIN, []);
    expect(mockOpenURL).not.toHaveBeenCalled();
  });
});
