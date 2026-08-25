/**
 * KAN-23 — place type label tests.
 *
 * Covers:
 *   - placeTypeLabel: human-readable labels + fallback title-casing
 *
 * KAN-371 removed the "resolveCategoryPlaceType" describe block: categories
 * no longer carry a place type, so there is nothing left to map from.
 *
 * KAN-342 removed two describe blocks that lived here:
 *   - "searchNearbyPlaces — custom type" tested a direct Google Places fetch
 *     with an arbitrary `includedTypes` string. searchNearbyPlaces no longer
 *     calls Google at all (Cloudflare -> OSM only) and returns a
 *     { results, source, coverageStatus } shape, not a bare Record — see
 *     mapsCloudflareRouting.test.ts for current coverage of that function.
 *   - "proximity engine — custom POI types" drove the engine through
 *     startProximityMonitoring/stopProximityMonitoring and a startTracking
 *     location-callback — that watcher-based API doesn't exist anymore
 *     (proximity.ts now runs one-shot searches via runProximitySearch /
 *     runProximitySearchOrReuseSnapshot, no persistent watcher — KAN-231).
 *     OSM also doesn't do arbitrary custom-string type lookups the way
 *     Google's Places API did (POI_OSM_TAGS/SUPPLEMENTARY_OSM_TAGS are a
 *     fixed, known set) — a genuinely custom POI type now resolves to zero
 *     live results by design, not a Google fallback search. Removed rather
 *     than rewritten around a code path that no longer exists.
 */

import { placeTypeLabel } from '../../src/services/maps';
import { setCopyLanguage } from '../../src/constants/copy';

// searchNearbyPlaces (used by placeTypeLabel? no — but maps.ts as a whole)
// transitively imports placesFunctions.ts / cloudflarePoiFunctions.ts ->
// @react-native-firebase/functions, mocked globally in jest.setup.js.
// reverseGeocodeCache.ts (expo-sqlite) is also globally mocked there.

// ─── placeTypeLabel ───────────────────────────────────────────────────────────

describe('placeTypeLabel', () => {
  it('returns known labels for built-in POI types', () => {
    expect(placeTypeLabel('atm')).toBe('ATM');
    expect(placeTypeLabel('cafe')).toBe('Café');
    expect(placeTypeLabel('supermarket')).toBe('Market');
    expect(placeTypeLabel('pharmacy')).toBe('Pharmacy');
  });

  it('returns the mapped label for well-known custom types', () => {
    expect(placeTypeLabel('gym')).toBe('Gym');
    expect(placeTypeLabel('restaurant')).toBe('Restaurant');
    expect(placeTypeLabel('beauty_salon')).toBe('Beauty Salon');
    expect(placeTypeLabel('fitness_center')).toBe('Fitness Center');
  });

  it('title-cases unknown type strings as a fallback', () => {
    // nail_salon is a catalog type now (KAN-401), so it takes its own
    // sentence-case copy rather than this fallback.
    // `bowling_alley` used to stand here and became a catalog type in
    // KAN-408, taking its own sentence-case copy — the same thing that
    // happened to nail_salon above. Picked a string no catalog will claim,
    // so the next new type cannot quietly invalidate this again.
    expect(placeTypeLabel('artisan_cheese_cave')).toBe('Artisan Cheese Cave');
    expect(placeTypeLabel('ice_cream_shop')).toBe('Ice Cream Shop');
  });
});

describe('placeTypeLabel — pt-PT', () => {
  beforeEach(() => { setCopyLanguage('pt-PT'); });
  afterEach(() => { setCopyLanguage('en'); });

  it('reads built-in POI labels from the active pt-PT copy dictionary', () => {
    expect(placeTypeLabel('atm')).toBe('Multibanco');
    expect(placeTypeLabel('cafe')).toBe('Café');
    expect(placeTypeLabel('supermarket')).toBe('Mercado');
    expect(placeTypeLabel('pharmacy')).toBe('Farmácia');
  });
});
