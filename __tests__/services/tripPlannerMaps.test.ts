/**
 * tripPlannerMaps.test.ts — KAN-234, KAN-321
 *
 * Unit tests for maps.ts's Trip Planner additions:
 *   - computeTripPreviewZoom: pure zoom-level math (no network) for the trip
 *     radius MapLibre preview — asserts the circle fits with padding and
 *     scales sanely with radius
 *   - buildTripPreviewCircle: pure GeoJSON circle-polygon construction (no
 *     network) for the radius overlay
 *     (KAN-321, replaced the Google Static Maps URL this used to build)
 */

// maps.ts pulls in Cloudflare and reverse-geocode dependencies unavailable in
// Jest. Stub them while testing the pure map-preview helpers.
jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflareCoverageProxy: jest.fn(),
  cloudflarePoiAllProxy:   jest.fn(),
}));
jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedCity: jest.fn(() => ({ hit: false, city: null })),
  putCachedCity: jest.fn(),
}));

import { computeTripPreviewZoom, buildTripPreviewCircle } from '../../src/services/maps';
import type { Position } from 'geojson';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('computeTripPreviewZoom', () => {
  it('produces a smaller zoom for a larger radius (zooms out to fit a bigger circle)', () => {
    const townZoom   = computeTripPreviewZoom(37.0179, 5_000, 320, 200);
    const regionZoom = computeTripPreviewZoom(37.0179, 40_000, 320, 200);

    expect(regionZoom).toBeLessThan(townZoom);
  });

  it('clamps to a sane range for an extreme radius', () => {
    expect(computeTripPreviewZoom(0, 10_000_000, 320, 200)).toBeGreaterThanOrEqual(1);
    expect(computeTripPreviewZoom(0, 1, 320, 200)).toBeLessThanOrEqual(20);
  });

  it('produces a smaller zoom at higher latitudes for the same radius (longitude degrees compress toward the poles)', () => {
    const equatorZoom = computeTripPreviewZoom(0, 5_000, 320, 200);
    const highLatZoom  = computeTripPreviewZoom(60, 5_000, 320, 200);

    expect(highLatZoom).toBeLessThan(equatorZoom);
  });
});

describe('buildTripPreviewCircle', () => {
  it('centers the polygon on the given lat/lng', () => {
    const circle = buildTripPreviewCircle(37.0179, -7.9304, 5_000);
    const coords = circle.geometry.coordinates[0];

    const lngs = coords.map(([lng]) => lng);
    const lats = coords.map(([, lat]) => lat);
    const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;

    expect(centerLng).toBeCloseTo(-7.9304, 3);
    expect(centerLat).toBeCloseTo(37.0179, 3);
  });

  it('closes the polygon ring (first point equals last)', () => {
    const circle = buildTripPreviewCircle(37.0179, -7.9304, 5_000);
    const coords = circle.geometry.coordinates[0];

    expect(coords[0]).toEqual(coords[coords.length - 1]);
  });

  it('scales the polygon extent with radius', () => {
    const small = buildTripPreviewCircle(37.0179, -7.9304, 5_000);
    const large = buildTripPreviewCircle(37.0179, -7.9304, 40_000);

    const extent = (coords: Position[]) =>
      Math.max(...coords.map(([lng]) => lng)) - Math.min(...coords.map(([lng]) => lng));

    expect(extent(large.geometry.coordinates[0])).toBeGreaterThan(extent(small.geometry.coordinates[0]));
  });
});
