/**
 * Unit tests for POI_CATALOG and PoiType — KAN-143
 *
 * Covers:
 *   - The quick-actionable list drives new-task choices
 *   - Each catalog entry has a non-empty label
 *   - POI_GEOFENCE_RADIUS covers all built-in types; Google only covers its
 *     own legacy searchable types
 *   - No duplicate types in catalog
 */

import {
  POI_CATALOG, POI_GEOFENCE_RADIUS, POI_GOOGLE_TYPES, PoiType,
  QUICK_ACTIONABLE_POI_TYPES, isQuickActionablePoiType, poiCatalogLabel,
} from '../../src/types';

const ALL_BUILT_IN_TYPES: PoiType[] = [
  'atm', 'cafe', 'supermarket', 'pharmacy',
  'gas', 'gym', 'bank', 'restaurant', 'park', 'library', 'post', 'store',
  'clinic', 'salon', 'bus', 'school', 'bakery', 'florist', 'bar',
  'currency_exchange', 'money_transfer',
  'financial_service', 'ice_cream', 'tattoo',
  'barber', 'hairdresser', 'nail_salon',
  // KAN-411
  'phone_repair', 'shoe_repair', 'clothing_repair', 'lottery', 'tobacco', 'tea', 'juice',
  // KAN-412
  'butcher', 'fishmonger', 'laundry', 'veterinary_care', 'car_wash',
  'car_rental', 'movie_theater', 'yoga_studio', 'playground',
  'electric_vehicle_charging_station',
  // KAN-408
  'amusement_park', 'aquarium', 'art_gallery', 'beach',
  'botanical_garden', 'bowling_alley', 'brewery', 'campground',
  'casino', 'cemetery', 'church', 'community_center',
  'cultural_center', 'golf_course', 'hiking_area', 'historical_landmark',
  'mosque', 'museum', 'night_club', 'rv_park',
  'spa', 'stadium', 'synagogue', 'tennis_court',
  'tourist_attraction', 'water_park', 'winery', 'zoo',
  'viewpoint', 'waterfall', 'river', 'mountain',
  'lake', 'island', 'surf_spot', 'hot_spring',
  'nature_preserve', 'plaza', 'bridge', 'lighthouse',
  'marina', 'theatre', 'music_venue',
];

const QUICK_ACTIONABLE_TYPES: PoiType[] = [
  'supermarket', 'pharmacy', 'atm', 'cafe', 'restaurant', 'store', 'tobacco',
  'florist', 'bakery', 'ice_cream', 'park', 'gym', 'bar', 'library',
];

describe('POI_CATALOG', () => {
  it('keeps all built-in types available for legacy task support', () => {
    // Derived, not a magic number: a hardcoded length only ever tells you
    // that someone added a type, never that they added it correctly, and it
    // has to be edited every time regardless.
    expect(POI_CATALOG).toHaveLength(ALL_BUILT_IN_TYPES.length);
    expect(new Set(POI_CATALOG.map(e => e.type)).size).toBe(POI_CATALOG.length);
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
    for (const type of ['bank', 'post', 'clinic', 'bus', 'school']) {
      expect(isQuickActionablePoiType(type)).toBe(false);
    }
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
  it('does not map services Google cannot search distinctly to generic banks', () => {
    // Types added after the migration off Google (KAN-329-353) deliberately
    // have no Google mapping: Google Places is not in the data chain and is
    // being retired entirely (KAN-350), so mapping a new type into it would
    // be adding to a system we are deleting.
    const notGoogleBacked = [
      'currency_exchange', 'money_transfer', 'financial_service',
      'phone_repair', 'shoe_repair', 'clothing_repair', 'lottery', 'tobacco', 'tea', 'juice',
      'butcher', 'fishmonger', 'laundry', 'veterinary_care', 'car_wash',
      'car_rental', 'movie_theater', 'yoga_studio', 'playground',
      'electric_vehicle_charging_station',
      'amusement_park', 'aquarium', 'art_gallery', 'beach',
      'botanical_garden', 'bowling_alley', 'brewery', 'campground',
      'casino', 'cemetery', 'church', 'community_center',
      'cultural_center', 'golf_course', 'hiking_area', 'historical_landmark',
      'mosque', 'museum', 'night_club', 'rv_park',
      'spa', 'stadium', 'synagogue', 'tennis_court',
      'tourist_attraction', 'water_park', 'winery', 'zoo',
      'viewpoint', 'waterfall', 'river', 'mountain',
      'lake', 'island', 'surf_spot', 'hot_spring',
      'nature_preserve', 'plaza', 'bridge', 'lighthouse',
      'marina', 'theatre', 'music_venue',
    ];
    const googleBackedTypes = ALL_BUILT_IN_TYPES.filter(
      type => !notGoogleBacked.includes(type),
    );
    for (const type of googleBackedTypes) {
      const googleType = POI_GOOGLE_TYPES[type];
      expect(typeof googleType).toBe('string');
      expect(googleType?.length).toBeGreaterThan(0);
    }
    expect(POI_GOOGLE_TYPES.currency_exchange).toBeUndefined();
    expect(POI_GOOGLE_TYPES.money_transfer).toBeUndefined();
    expect(POI_GOOGLE_TYPES.financial_service).toBeUndefined();
  });
});
