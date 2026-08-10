/**
 * Unit tests for POI_CATALOG and PoiType — KAN-143
 *
 * Covers:
 *   - The quick-actionable list drives new-task choices
 *   - Each catalog entry has a non-empty label
 *   - POI_GEOFENCE_RADIUS and POI_GOOGLE_TYPES preserve all built-in types
 *   - No duplicate types in catalog
 */

import {
  POI_CATALOG, POI_GEOFENCE_RADIUS, POI_GOOGLE_TYPES, PoiType,
  QUICK_ACTIONABLE_POI_TYPES, isQuickActionablePoiType, poiCatalogLabel,
} from '../../src/types';

const ALL_BUILT_IN_TYPES: PoiType[] = [
  'atm', 'cafe', 'supermarket', 'pharmacy',
  'gas', 'gym', 'bank', 'restaurant', 'park', 'library', 'post', 'store',
  'clinic', 'salon', 'bus', 'school',
];

const QUICK_ACTIONABLE_TYPES: PoiType[] = [
  'atm', 'cafe', 'supermarket', 'pharmacy', 'gas', 'gym', 'restaurant',
  'park', 'library', 'store', 'salon',
];

describe('POI_CATALOG', () => {
  it('keeps all built-in types available for legacy task support', () => {
    expect(POI_CATALOG).toHaveLength(16);
  });

  it('contains all built-in POI types', () => {
    const catalogTypes = POI_CATALOG.map(e => e.type);
    for (const type of ALL_BUILT_IN_TYPES) {
      expect(catalogTypes).toContain(type);
    }
  });

  it('uses one actionable list for quick selections', () => {
    expect(QUICK_ACTIONABLE_POI_TYPES).toEqual(QUICK_ACTIONABLE_TYPES);
  });

  it('only marks entries from the quick list as quick-actionable', () => {
    for (const type of QUICK_ACTIONABLE_TYPES) {
      expect(isQuickActionablePoiType(type)).toBe(true);
    }
    expect(isQuickActionablePoiType('bank')).toBe(false);
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
  it('has a radius for every POI type', () => {
    for (const type of ALL_BUILT_IN_TYPES) {
      expect(POI_GEOFENCE_RADIUS[type]).toBeGreaterThan(0);
    }
  });
});

describe('POI_GOOGLE_TYPES', () => {
  it('has a Google Places type string for every POI type', () => {
    for (const type of ALL_BUILT_IN_TYPES) {
      expect(typeof POI_GOOGLE_TYPES[type]).toBe('string');
      expect(POI_GOOGLE_TYPES[type].length).toBeGreaterThan(0);
    }
  });
});
