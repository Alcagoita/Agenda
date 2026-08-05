/**
 * KAN-23 — Category-to-POI type mapping tests.
 *
 * Covers:
 *   - resolveCategoryPlaceType: maps Category.poi to the Google Places type string
 *   - placeTypeLabel:           human-readable labels + fallback title-casing
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

import { resolveCategoryPlaceType, placeTypeLabel } from '../../src/services/maps';
import { setCopyLanguage } from '../../src/constants/copy';
import { Category } from '../../src/types';

// searchNearbyPlaces (used by placeTypeLabel? no — but maps.ts as a whole)
// transitively imports placesFunctions.ts / cloudflarePoiFunctions.ts ->
// @react-native-firebase/functions, mocked globally in jest.setup.js.
// reverseGeocodeCache.ts (expo-sqlite) is also globally mocked there.

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id:        'cat-1',
    name:      'Test',
    color:     '#ff0000',
    poi:       null,
    isBuiltIn: false,
    ...overrides,
  };
}

// ─── resolveCategoryPlaceType ─────────────────────────────────────────────────

describe('resolveCategoryPlaceType', () => {
  it('returns null for a category with no location association', () => {
    expect(resolveCategoryPlaceType(makeCategory({ poi: null }))).toBeNull();
  });

  it('returns the poi string unchanged for a built-in type', () => {
    expect(resolveCategoryPlaceType(makeCategory({ poi: 'pharmacy' }))).toBe('pharmacy');
    expect(resolveCategoryPlaceType(makeCategory({ poi: 'atm' }))).toBe('atm');
    expect(resolveCategoryPlaceType(makeCategory({ poi: 'cafe' }))).toBe('cafe');
  });

  it('returns the poi string unchanged for a custom Google Places type', () => {
    expect(resolveCategoryPlaceType(makeCategory({ poi: 'gym' }))).toBe('gym');
    expect(resolveCategoryPlaceType(makeCategory({ poi: 'restaurant' }))).toBe('restaurant');
    expect(resolveCategoryPlaceType(makeCategory({ poi: 'beauty_salon' }))).toBe('beauty_salon');
  });
});

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
    expect(placeTypeLabel('nail_salon')).toBe('Nail Salon');
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
