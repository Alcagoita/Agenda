import { readFileSync } from 'fs';
import { join } from 'path';

import { resolvePoiIconType } from '../../src/components/AppIcon/poi';
import { getCopyLanguage, setCopyLanguage } from '../../src/constants/copy';
import {
  CLUSTER_LEISURE_TYPES,
  POI_CATALOG, POI_GEOFENCE_RADIUS, POI_OSM_TAGS, PoiType,
  QUICK_ACTIONABLE_POI_TYPES, isPoiApiServableType, poiCatalogLabel,
} from '../../src/types';

/**
 * KAN-412 — the guard.
 *
 * 64 classifier types accumulated holding 75,977 rows that no search could
 * request. Nobody noticed because nothing checked: `poiTypeCategories.json`
 * had 99 keys, the `PoiType` union had 33, and the gap was silent. Fixing
 * the 64 without this test only means the 65th arrives the same way.
 */
const ROOT = join(__dirname, '..', '..');

function classifierTypes(): string[] {
  const mapping = JSON.parse(
    readFileSync(join(ROOT, 'cloudflare', 'src', 'poiTypeCategories.json'), 'utf8'),
  ) as Record<string, { category_id?: string; category_name?: string }>;
  return Object.keys(mapping);
}

/** Every type a search can reach: the union, plus type_relation bridges. */
function reachable(): Set<string> {
  const schema = readFileSync(join(ROOT, 'cloudflare', 'type_relation_schema.sql'), 'utf8');
  const bridged = new Set<string>();
  for (const [, search, include] of schema.matchAll(/\(\s*'([\w]+)'\s*,\s*'([\w]+)'\s*\)/g)) {
    bridged.add(search);
    bridged.add(include);
  }
  const union = new Set<string>(POI_CATALOG.map(e => e.type));
  // A bridge only helps if the OTHER side of it is in the union — bridging
  // two types the app cannot express reaches nothing.
  const viaBridge = [...bridged].filter(t => {
    const partners = [...schema.matchAll(/\(\s*'([\w]+)'\s*,\s*'([\w]+)'\s*\)/g)]
      .filter(m => m[1] === t || m[2] === t)
      .flatMap(m => [m[1], m[2]]);
    return partners.some(p => union.has(p));
  });
  return new Set([...union, ...viaBridge]);
}

describe('KAN-412 type reachability', () => {
  it('every catalog type has a geofence radius', () => {
    // POI_GEOFENCE_RADIUS is Record<PoiType, number>, so tsc enforces this —
    // asserted anyway because a Partial<> slipped in later would not.
    for (const { type } of POI_CATALOG) {
      expect(typeof POI_GEOFENCE_RADIUS[type]).toBe('number');
    }
  });

  it('every catalog type has an OSM tag', () => {
    // A catalog type with no OSM tag can only ever be filled by Foursquare.
    for (const { type } of POI_CATALOG) {
      expect(POI_OSM_TAGS[type]).toBeDefined();
      expect(POI_OSM_TAGS[type].key.length).toBeGreaterThan(0);
    }
  });

  it('every catalog type has a non-empty label in both locales', () => {
    // poiCatalogLabel reads the ACTIVE language and takes no second argument.
    // Passing one was silently ignored, so this asserted the default locale
    // twice and never once checked pt-PT.
    const original = getCopyLanguage();
    try {
      for (const lang of ['en', 'pt-PT'] as const) {
        setCopyLanguage(lang);
        for (const { type } of POI_CATALOG) {
          expect(poiCatalogLabel(type).trim().length).toBeGreaterThan(0);
        }
      }
      // The two locales must not be the same object of English strings.
      setCopyLanguage('en');
      const en = poiCatalogLabel('butcher');
      setCopyLanguage('pt-PT');
      expect(poiCatalogLabel('butcher')).not.toBe(en);
    } finally {
      setCopyLanguage(original);
    }
  });

  it('the quick-actionable list stays a subset of the catalog', () => {
    const catalog = new Set(POI_CATALOG.map(e => e.type));
    for (const type of QUICK_ACTIONABLE_POI_TYPES) {
      expect(catalog.has(type)).toBe(true);
    }
  });

  it('KAN-412 types are catalog-only, never quick-actionable', () => {
    // Product decision: people reach for these specifically ("find a vet for
    // today"), never by browsing. The carousel stays short.
    const catalogOnly: PoiType[] = [
      'butcher', 'fishmonger', 'laundry', 'veterinary_care', 'car_wash',
      'car_rental', 'movie_theater', 'yoga_studio', 'playground',
      'electric_vehicle_charging_station',
    ];
    const quick = new Set<string>(QUICK_ACTIONABLE_POI_TYPES);
    const catalog = new Set(POI_CATALOG.map(e => e.type));
    for (const type of catalogOnly) {
      expect(catalog.has(type)).toBe(true);
      expect(quick.has(type)).toBe(false);
    }
  });

  it('the new types keep their own icon instead of being remapped', () => {
    // resolvePoiIconType's heuristics exist for UNKNOWN strings. They were
    // swallowing eight of the ten icons this ticket drew: `..._station` made
    // the EV charger a bus stop, `car_wash` fell into the fuel branch,
    // `veterinary_care` into the medical branch, `playground` into `park`,
    // `movie_theater` into `library`. A hand-drawn icon nothing can reach is
    // the same defect as a type nothing can search.
    const selfDrawn: PoiType[] = [
      'butcher', 'fishmonger', 'laundry', 'veterinary_care', 'car_wash',
      'car_rental', 'movie_theater', 'yoga_studio', 'playground',
      'electric_vehicle_charging_station',
    ];
    for (const type of selfDrawn) {
      expect(resolvePoiIconType(type)).toBe(type);
    }
  });

  it('leaves the deliberate icon borrowings alone', () => {
    // Guards the fix above from over-reaching. `florist` and `bar` have no
    // case of their own and are MEANT to borrow these.
    expect(resolvePoiIconType('florist')).toBe('park');
    expect(resolvePoiIconType('bar')).toBe('cafe');
  });

  it('the leisure types our API can answer are all servable (KAN-407)', () => {
    // The habitat prefetch admits a type on this predicate. Every leisure
    // type must pass it, or the leisure companion silently cannot see that
    // type's rows — which is exactly how historical_landmark (1,865 rows) and
    // tourist_attraction (128) stayed invisible behind the old OSM-only gate.
    for (const type of CLUSTER_LEISURE_TYPES) {
      expect(isPoiApiServableType(type)).toBe(true);
    }
  });

  it('every catalog type is servable, and free text is not', () => {
    for (const { type } of POI_CATALOG) {
      expect(isPoiApiServableType(type)).toBe(true);
    }
    // The runaway-refetch guard: a POI the user typed themselves matches
    // nothing in either source, so it must never reach the prefetch.
    for (const freeText of ['o meu sitio secreto', 'grandma house', '']) {
      expect(isPoiApiServableType(freeText)).toBe(false);
    }
  });

  it('pins exactly which classifier types no search can reach', () => {
    // Asserting "zero unreachable" would be wrong — leaving a type
    // unreachable is a legitimate outcome, and several here are deliberate.
    // What must never happen again is a type becoming unreachable without
    // anyone DECIDING, which is how 64 accumulated silently.
    //
    // So the set is pinned. Adding a classifier type without a consumer
    // fails this test, and the fix is to make it reachable or to add it here
    // with a reason — which is the decision being recorded.
    const DELIBERATELY_UNREACHABLE = [
      // Searched by name at a specific address, never stumbled upon (KAN-412).
      'car_repair', 'dentist', 'hospital', 'medical_lab', 'physiotherapist',
      // Owned by KAN-408 / KAN-410 — the Nature and Landmarks grouping.
      // Deciding them here would decide them twice.
      'amusement_park', 'aquarium', 'art_gallery', 'beach', 'botanical_garden',
      'bowling_alley', 'brewery', 'campground', 'casino', 'cemetery', 'church',
      'community_center', 'cultural_center', 'golf_course', 'hiking_area',
      'historical_landmark', 'mosque', 'museum', 'night_club', 'rv_park',
      'spa', 'stadium', 'synagogue', 'tennis_court', 'tourist_attraction',
      'water_park', 'winery', 'zoo',
      // Deliberately dormant pending a use case (KAN-404).
      'lodging', 'hotel',
      // Transport. Same call as bus stops: a location without routes or
      // timetables tells the user only that the thing exists.
      'airport', 'ferry_terminal', 'subway_station', 'taxi_stand',
      'train_station', 'transit_station',
      // Not errands — nobody writes a task about going to a car park.
      'parking', 'movie_rental',
      // Government and institutional. "Renovar o cartão de cidadão" is a real
      // errand, so these are revisitable — but not decided in this ticket.
      'accounting', 'city_hall', 'courthouse', 'embassy', 'fire_station',
      'local_government_office', 'police', 'primary_school', 'university',
      // Product calls left standing: convenience_store was deliberately kept
      // apart from supermarket, car_dealer is not an errand, and liquor_store
      // wants to become store + store_kind=drinks rather than its own type.
      'convenience_store', 'car_dealer', 'liquor_store',
      // Already consumed outside PoiType: SUPPLEMENTARY_OSM_TAGS uses this
      // for KAN-282's mall detection, so it is reachable in the way that
      // matters and does not need a catalog entry.
      'shopping_mall',
    ].sort();

    const reach = reachable();
    const unreachable = classifierTypes().filter(t => !reach.has(t)).sort();
    expect(unreachable).toEqual(DELIBERATELY_UNREACHABLE);
  });
});
