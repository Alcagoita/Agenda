/**
 * Unit tests for POI_CATALOG and PoiType — KAN-143
 *
 * Covers:
 *   - Only actionable types are present in POI_CATALOG
 *   - Each catalog entry has a non-empty label
 *   - POI_GEOFENCE_RADIUS covers every catalog type
 *   - POI_GOOGLE_TYPES covers every catalog type
 *   - No duplicate types in catalog
 */

import {
  POI_CATALOG, POI_GEOFENCE_RADIUS, POI_GOOGLE_TYPES, PoiType,
  isRetiredQuickPoiType, poiCatalogLabel,
} from '../../src/types';

const EXPECTED_TYPES: PoiType[] = [
  'atm', 'cafe', 'supermarket', 'pharmacy',
  'gas', 'gym', 'restaurant', 'park', 'library', 'store', 'salon',
];

const RETIRED_QUICK_TYPES: PoiType[] = ['bank', 'post', 'clinic', 'bus', 'school'];

describe('POI_CATALOG', () => {
  it('contains exactly 11 actionable entries', () => {
    expect(POI_CATALOG).toHaveLength(11);
  });

  it('contains all expected POI types', () => {
    const catalogTypes = POI_CATALOG.map(e => e.type);
    for (const type of EXPECTED_TYPES) {
      expect(catalogTypes).toContain(type);
    }
  });

  it('does not offer retired non-actionable types as quick selections', () => {
    const catalogTypes = POI_CATALOG.map(entry => entry.type);
    for (const type of RETIRED_QUICK_TYPES) {
      expect(catalogTypes).not.toContain(type);
    }
  });

  it('marks retired types as ineligible for quick suggestions', () => {
    for (const type of RETIRED_QUICK_TYPES) {
      expect(isRetiredQuickPoiType(type)).toBe(true);
    }
    expect(isRetiredQuickPoiType('restaurant')).toBe(false);
  });

  it('has no duplicate types', () => {
    const types = POI_CATALOG.map(e => e.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('every entry has a non-empty label', () => {
    // Labels moved off POI_CATALOG itself and live in COPY.poiCatalog
    // (KAN-252, language-aware) — read live via poiCatalogLabel().
    for (const entry of POI_CATALOG) {
      expect(poiCatalogLabel(entry.type).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('POI_GEOFENCE_RADIUS', () => {
  it('has a radius for every catalog POI type', () => {
    for (const type of EXPECTED_TYPES) {
      expect(POI_GEOFENCE_RADIUS[type]).toBeGreaterThan(0);
    }
  });
});

describe('POI_GOOGLE_TYPES', () => {
  it('has a Google Places type string for every catalog POI type', () => {
    for (const type of EXPECTED_TYPES) {
      expect(typeof POI_GOOGLE_TYPES[type]).toBe('string');
      expect(POI_GOOGLE_TYPES[type].length).toBeGreaterThan(0);
    }
  });
});
