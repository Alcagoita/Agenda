/**
 * maps.ts — Google Places API (New) integration.
 *
 * Decision (KAN-21):
 *   We use the Google Places API (New) via REST — no native Maps SDK embedded
 *   in the app. The "Open in Maps" CTA deep-links to the device's native Maps
 *   application. This keeps the binary size small and avoids a heavy native
 *   dependency for v1.0.
 *
 *   API reference: https://developers.google.com/maps/documentation/places/web-service
 *
 * Nearby Search endpoint used:
 *   POST https://places.googleapis.com/v1/places:searchNearby
 *
 * Field mask (billing impact — only request what we need):
 *   places.id, places.displayName, places.location, places.types
 */

import { Linking, Platform } from 'react-native';
import type { Feature, Polygon } from 'geojson';
import {
  getPlaceDetailsProxy,
  placesAutocompleteProxy,
} from './placesFunctions';
import { cloudflareCoverageProxy, cloudflarePoiAllProxy } from './cloudflarePoiFunctions';
import { searchOsmPlacesStrict } from './osmPlaces';
import { getCachedCity, putCachedCity } from './reverseGeocodeCache';
import { Category, PoiType, poiCatalogLabel } from '../types';
import type { RestaurantFoodType } from './restaurantFoodTypes';
import type { StoreSubtype } from './storeSubtypes';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NearbyPlace {
  /** Google Places ID (use for place details, deep links, caching). */
  placeId: string;
  /** Human-readable place name. */
  name: string;
  /** Latitude of the place. */
  lat: number;
  /** Longitude of the place. */
  lng: number;
  /** Straight-line distance from the search origin in metres. */
  distanceMeters: number;
  /** Google Places' own `primaryType` field — a place can carry several
   *  secondary type tags (e.g. a supermarket occasionally also tagged
   *  shopping_mall), so anything that needs to trust a SPECIFIC type (not
   *  just "this place matched one of our requested types") should check
   *  this, not assume the bucket it landed in reflects its true kind. Comes
   *  straight from the API — reliable, unlike guessing from `types[0]`
   *  (that array's order isn't guaranteed to put the primary type first). */
  primaryType?: string;
  /** Google's full `types` array (KAN-282) — even a place whose primaryType
   *  IS shopping_mall can still be an individual store inside a real mall
   *  that Google (or OSM) mistagged, distinguishable by ALSO carrying a
   *  specific category type (e.g. "clothing_store", "supermarket") — a real
   *  mall entity's types are just shopping_mall + generic boilerplate. See
   *  isGenuineMallType (below), used by mallSnapshots.ts. */
  types?: string[];
  /** Approximate building-footprint area in m² (KAN-282), carried through
   *  from OSM (osmPlaces.OsmPlace / the habitat cache) — a real destination
   *  shopping mall is a large building; a small strip mall or a mistagged
   *  store is a tiny footprint or a bare point. Only ever set for OSM-sourced
   *  shopping_mall places; undefined for Google results (Nearby Search
   *  returns no geometry) and for point-only OSM nodes. */
  footprintAreaM2?: number;
  /** The place's own site, carried through from OSM's `website` tag via the
   *  habitat cache (KAN-293). Only ever populated for OSM-sourced rows —
   *  Google results never set it, since we don't request that field. Used
   *  solely to decide whether the cluster box's leisure line can offer a
   *  ticket link; undefined simply means "no known site", never "look one up". */
  website?: string;
  /** Stored offline subtype for restaurant places, when known from the local dictionary/cache. */
  restaurantFoodType?: RestaurantFoodType;
  /** Stored offline subtype for store places, when known from the local dictionary/cache. */
  storeSubtype?: StoreSubtype;
}

// ─── Haversine distance ────────────────────────────────────────────────────────
//
// Moved to geoDistance.ts (KAN-342) — osmPlaces.ts needs it and maps.ts now
// needs osmPlaces.ts (the OSM failsafe in searchNearbyPlaces below), so it
// can't live in either file without creating a cycle. Re-exported here so
// every existing `from './maps'` import site is unaffected.

const DEG_TO_RAD = Math.PI / 180;

export { getDistanceMeters } from './geoDistance';

// ─── Reverse geocoding — city / area name (KAN-301) ────────────────────────────
//
// Uses OpenStreetMap's free Nominatim service — no API key, no Google, and the
// same source the app already uses for places (osmPlaces.ts / Overpass). Called
// straight from the device (like Overpass), gated by useLanternState so it only
// fires when an Outside city label will actually be shown; volume is far under
// Nominatim's usage policy. Any failure falls back to "Outside" at the caller.

const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_TIMEOUT_MS = 8_000;
// Nominatim (like Overpass) asks every client to identify itself; unlabeled
// traffic risks being rate-limited or blocked. Shared by reverse geocoding
// (this section) and the destination/address autocomplete below.
const NOMINATIM_USER_AGENT = `BrushApp/${require('../../package.json').version}`;
// Nominatim's usage policy caps traffic at 1 request/second per caller.
const NOMINATIM_MIN_INTERVAL_MS = 1_000;
// reverseGeocode and the autocomplete search below get their OWN clock each
// (KAN-320 review) — they used to share one, and reverseGeocode fires on
// every GPS fix from useLanternState's background polling (TodayScreen stays
// mounted under a pushed Trip Planner/off-grid screen, so it keeps ticking
// even while the user is searching). Sharing a clock meant a user's search
// almost always lost the race against that ambient background traffic and
// came back with zero results. Two independent 1 req/s clocks are still
// trivially inside Nominatim's policy for this app's real-world volume.
let lastReverseGeocodeRequestAt = 0;

// In-memory cache of resolved cells for this session (the fast path; the
// SQLite layer below makes a name survive restarts). Keyed on coords rounded to
// ~3 decimals (≈100 m) so nearby fixes reuse one result. `null` = resolved, no
// name — cached too, so we don't re-hit Nominatim for the same empty cell.
const reverseGeocodeMem = new Map<string, string | null>();

/** Rounds a coordinate to a ~100 m cache cell key. */
function reverseGeocodeCell(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

/** The subset of Nominatim's `address` object we consider for a city label. */
export interface OsmAddress {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  suburb?: string;
  county?: string;
}

/**
 * Preference order for the Lantern's "Outside" label: the most specific
 * populated-place field Nominatim returns wins. We stop at `county` — never a
 * state or country, since a bare region name is worse than the "Outside"
 * fallback the caller supplies. Exported (with the extractor) for unit testing.
 */
const CITY_FIELD_PRIORITY: (keyof OsmAddress)[] = [
  'city', 'town', 'village', 'municipality', 'suburb', 'county',
];

/** Pure extractor — the best display name from a Nominatim `address`, or null. */
export function extractCityName(address: OsmAddress | null | undefined): string | null {
  if (!address) { return null; }
  for (const field of CITY_FIELD_PRIORITY) {
    const value = address[field];
    if (value) { return value; }
  }
  return null;
}

/**
 * Reverse-geocode a coordinate to a city / area name for the Lantern's
 * "Outside" state via OSM Nominatim. Cached (session memory + SQLite) and rate
 * limited to 1 request/second per Nominatim's usage policy. Returns null on a
 * cache/rate-limit skip or any failure (offline, no result) — the caller shows
 * "Outside" instead. Never throws.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const cell = reverseGeocodeCell(lat, lng);

  // 1) Session cache — free, no network, no rate-limit cost.
  if (reverseGeocodeMem.has(cell)) { return reverseGeocodeMem.get(cell) ?? null; }

  // 2) Persistent cache — a name resolved in a previous session/before a restart.
  const persisted = getCachedCity(cell);
  if (persisted.hit) {
    reverseGeocodeMem.set(cell, persisted.city);
    return persisted.city;
  }

  // 3) Rate limit — never two reverse-geocode requests within 1 s. Skips
  // rather than waits: this is a background label refresh, not a user action
  // waiting on a result — see the autocomplete search below for the
  // user-facing counterpart, which waits instead.
  const now = Date.now();
  if (now - lastReverseGeocodeRequestAt < NOMINATIM_MIN_INTERVAL_MS) { return null; }
  lastReverseGeocodeRequestAt = now;

  const url = `${NOMINATIM_REVERSE_URL}?format=jsonv2&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) { return null; }
    const json = (await res.json()) as { address?: OsmAddress };
    const city = extractCityName(json.address);
    reverseGeocodeMem.set(cell, city);
    putCachedCity(cell, city);
    return city;
  } catch {
    // Transient failure — don't cache, so a later attempt can retry.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Test-only: clears the session reverse-geocode cache and rate-limit clock. */
export function __resetReverseGeocodeForTests(): void {
  reverseGeocodeMem.clear();
  lastReverseGeocodeRequestAt = 0;
}

// ─── Places API — Nearby Search ───────────────────────────────────────────────

/**
 * KAN-342: Brush's own Cloudflare-backed POI database (poi-api.brushaway.app)
 * for cities it covers — Google Places stays the permanent fallback for
 * everywhere else (small/rural areas we haven't built a city database for).
 * Tried first on every call; any failure (not covered, API error, rejected
 * radius — our Worker's own MAX_RADIUS_METERS is 4500m, tighter than some
 * callers' radii like destinationResolver's 5000m ROUTE_MAX_RADIUS_M) falls
 * straight through to the existing Google path below, silently — this must
 * never be the reason a search comes back empty when Google would have
 * answered.
 *
 * Buckets by `primary_poi_type` only, not the full multi-type match a place
 * can have server-side (poi_type table) — /poi/all doesn't join that table,
 * it's a single flat query across all types in range. A place matching two
 * of our requested types under a secondary type would only bucket under its
 * primary one here. Acceptable simplification for live search (same
 * "matched into the first type it hit" imprecision Google's own bucketing
 * below already has); a caller that needs true multi-type filtering should
 * use the Cloudflare API's own `/poi?type=&attribute=&value=` directly, not
 * this general-purpose function.
 */
async function searchNearbyPlacesCloudflare(
  lat: number,
  lng: number,
  poiTypes: string[],
  radiusMeters: number,
): Promise<Record<string, NearbyPlace[]> | null> {
  try {
    const coverage = await cloudflareCoverageProxy(lat, lng);
    if (coverage.status !== 'ready') { return null; }

    const data = await cloudflarePoiAllProxy(lat, lng, radiusMeters);
    if (!data.covered) { return null; }

    const result: Record<string, NearbyPlace[]> = {};
    for (const poiType of poiTypes) { result[poiType] = []; }

    for (const p of data.results) {
      if (!result[p.primary_poi_type]) { continue; }
      result[p.primary_poi_type].push({
        placeId:        p.fsq_place_id,
        name:           p.name,
        lat:            p.lat,
        lng:            p.lng,
        distanceMeters: p.distanceMeters,
        primaryType:    p.primary_poi_type,
      });
    }

    for (const poiType of poiTypes) {
      result[poiType].sort((a, b) => a.distanceMeters - b.distanceMeters);
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Search for places of all given POI types within `radiusMeters` of `lat`/`lng`.
 *
 * `poiTypes` accepts our internal PoiType keys.
 *
 * Returns a map keyed by the original poiType, each entry sorted ascending by
 * straight-line distance.
 *
 * KAN-342: tries Brush's own Cloudflare POI database first (see
 * searchNearbyPlacesCloudflare) for cities it covers. Falls through to OSM
 * — not Google — for everywhere else: OSM is the failsafe, Google Places is
 * no longer part of this function's path.
 *
 * Uses searchOsmPlacesStrict, not the lenient searchOsmPlaces (same choice
 * tripDownload.ts already made, for the same reason — see there) — this
 * function's only caller, proximity.ts, distinguishes "couldn't look"
 * (network failure — retry later, meanwhile answer from the habitat cache)
 * from "looked, found nothing" (a settled, real answer) by catching a
 * thrown error here. Collapsing both into the same empty-result value would
 * silently break that distinction, not just look different: the offline
 * retry-queue and messaging both depend on it. The Cloudflare attempt above
 * still never throws (a covered city's own failure isn't "we're offline",
 * it's "fall back to OSM and let OSM's real network state decide").
 * Background/best-effort callers (habitatCache.ts's own prefetch) still use
 * the lenient searchOsmPlaces, unchanged — silence is correct there.
 */
export async function searchNearbyPlaces(
  lat: number,
  lng: number,
  poiTypes: string[],
  radiusMeters: number,
): Promise<Record<string, NearbyPlace[]>> {
  if (poiTypes.length === 0) { return {}; }

  const cloudflareResult = await searchNearbyPlacesCloudflare(lat, lng, poiTypes, radiusMeters);
  if (cloudflareResult) { return cloudflareResult; }

  const osmResults = await searchOsmPlacesStrict(lat, lng, poiTypes, radiusMeters);

  const result: Record<string, NearbyPlace[]> = {};
  for (const poiType of poiTypes) {
    result[poiType] = (osmResults[poiType] ?? []).map(place => ({
      placeId:         place.osmId,
      name:            place.name,
      lat:             place.lat,
      lng:             place.lng,
      distanceMeters:  place.distanceMeters,
      footprintAreaM2: place.footprintAreaM2,
      website:         place.website,
    }));
  }
  return result;
}

/** Google types carried by every place regardless of what it actually is —
 *  seeing ONLY these (plus shopping_mall itself) alongside shopping_mall is
 *  what a real mall entity looks like. Anything else present means the
 *  place has its own specific category too (e.g. "clothing_store",
 *  "supermarket") — almost always an individual store inside a mall that
 *  got mistagged/miscategorized as shopping_mall as a secondary type, not
 *  the mall itself. */
const MALL_GENERIC_TYPES = new Set(['shopping_mall', 'point_of_interest', 'establishment']);

/**
 * True only when `place.primaryType` is genuinely `shopping_mall` AND its
 * full `types` array carries nothing else beyond generic boilerplate
 * (KAN-282 — primaryType alone wasn't enough: a store inside a real mall,
 * like an anchor clothing retailer, can have `primaryType: 'shopping_mall'`
 * as a genuine-looking but wrong Google data quirk, while ALSO carrying its
 * own real category like `clothing_store` in `types` — a real mall entity
 * never does). `types` is optional on NearbyPlace (not populated by every
 * caller); treated as failing this check if absent, since we can't verify.
 */
export function isGenuineMallType(place: NearbyPlace): boolean {
  if (place.primaryType !== 'shopping_mall') { return false; }
  if (!place.types) { return false; }
  return place.types.every(t => MALL_GENERIC_TYPES.has(t));
}

// ─── Deep-link to native Maps ─────────────────────────────────────────────────

/**
 * Opens the device's native Maps application and starts navigation to the
 * given coordinates.
 *
 * Android: `geo:0,0?q={lat},{lng}({label})`  — opens Google Maps or default
 * iOS:     `maps://?daddr={lat},{lng}`        — opens Apple Maps
 *          Falls back to Google Maps URL if Apple Maps cannot open.
 */
export async function openInMaps(
  lat: number,
  lng: number,
  label: string,
): Promise<void> {
  const encodedLabel = encodeURIComponent(label);

  let url: string;
  if (Platform.OS === 'android') {
    url = `geo:0,0?q=${lat},${lng}(${encodedLabel})`;
  } else {
    // Try Apple Maps first; fall back to Google Maps if unavailable.
    const appleMapsUrl = `maps://?daddr=${lat},${lng}`;
    const canOpenApple = await Linking.canOpenURL(appleMapsUrl);
    url = canOpenApple
      ? appleMapsUrl
      : `https://maps.google.com/?daddr=${lat},${lng}&q=${encodedLabel}`;
  }

  const canOpen = await Linking.canOpenURL(url);
  if (!canOpen) {
    // Last resort: open Google Maps in browser.
    url = `https://maps.google.com/?daddr=${lat},${lng}&q=${encodedLabel}`;
  }

  await Linking.openURL(url);
}

/**
 * Opens the device's native Maps app with a text search for `queryText`
 * anchored near `lat`/`lng` — Maps resolves the nearest matching place
 * itself (KAN-279). Unlike `openInMaps`, this never pins a specific place
 * we picked; the app deliberately doesn't rank/resolve a destination.
 *
 * Android: `geo:{lat},{lng}?q={queryText}` — a search, not a pin
 * iOS:     `maps://?q={queryText}&near={lat},{lng}` — Apple Maps search
 *          Falls back to a Google Maps search URL if Apple Maps can't open.
 */
export async function openMapsSearch(
  lat: number,
  lng: number,
  queryText: string,
): Promise<void> {
  const encodedQuery = encodeURIComponent(queryText);

  let url: string;
  if (Platform.OS === 'android') {
    url = `geo:${lat},${lng}?q=${encodedQuery}`;
  } else {
    const appleMapsUrl = `maps://?q=${encodedQuery}&near=${lat},${lng}`;
    const canOpenApple = await Linking.canOpenURL(appleMapsUrl);
    url = canOpenApple
      ? appleMapsUrl
      : `https://www.google.com/maps/search/?api=1&query=${encodedQuery}+near+${lat},${lng}`;
  }

  const canOpen = await Linking.canOpenURL(url);
  if (!canOpen) {
    url = `https://www.google.com/maps/search/?api=1&query=${encodedQuery}+near+${lat},${lng}`;
  }

  await Linking.openURL(url);
}

/**
 * Opens a multi-stop Google Maps directions URL (KAN-281) — origin, ordered
 * waypoints, and a final destination, handed off to whatever Maps app the
 * device resolves the universal link to. We never compute the route
 * ourselves; this is purely a stop-order handoff.
 *
 * `stops` must already be in the desired visit order (see oneTripForAll.ts's
 * greedy ordering) and capped to Maps' own ~9-waypoint limit by the caller.
 */
export async function openMultiStopDirections(
  origin: { lat: number; lng: number },
  stops: { lat: number; lng: number }[],
): Promise<void> {
  if (stops.length === 0) { return; }

  const destination = stops[stops.length - 1];
  const waypoints = stops.slice(0, -1);

  // No travelmode param — Maps opens with its own default and the user
  // picks walking/driving/etc. themselves inside the app.
  let url = `https://www.google.com/maps/dir/?api=1`
    + `&origin=${origin.lat},${origin.lng}`
    + `&destination=${destination.lat},${destination.lng}`;

  if (waypoints.length > 0) {
    const waypointsParam = waypoints.map(w => `${w.lat},${w.lng}`).join('|');
    url += `&waypoints=${encodeURIComponent(waypointsParam)}`;
  }

  await Linking.openURL(url);
}

// ─── Distance display helper ───────────────────────────────────────────────────

/**
 * Formats a distance in metres for display.
 *   < 1000 m → "850 m"
 *   ≥ 1000 m → "1.2 km"
 */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

// ─── Place type search ────────────────────────────────────────────────────────

/**
 * Generic place type strings that convey no useful information to a user
 * (returned by the Places API alongside specific types like "gym").
 * We filter these out before displaying search results.
 */
const GENERIC_PLACE_TYPES = new Set([
  'establishment', 'point_of_interest', 'food', 'store', 'health', 'finance',
  'service', 'political', 'locality', 'sublocality', 'country', 'route',
  'street_address', 'premise', 'subpremise', 'postal_code', 'natural_feature',
  'transit_station', 'place_of_worship', 'geocode',
]);

/**
 * True for a generic Google Places type that conveys no useful information to
 * a user (see GENERIC_PLACE_TYPES above). Exported so other callers building
 * their own type list — e.g. poiTypeCache.ts's seed step — apply the exact
 * same exclusion policy as searchPlaceTypes' live results, instead of a
 * separately-maintained copy that can drift out of sync.
 */
export function isGenericPlaceType(type: string): boolean {
  return GENERIC_PLACE_TYPES.has(type);
}

/**
 * Human-readable labels for common Google Places primary types.
 * Covers the full taxonomy that users are likely to search for as
 * category location types.
 */
export const PLACE_TYPE_LABELS: Record<string, string> = {
  // Food & drink
  atm:                  'ATM',
  bakery:               'Bakery',
  bank:                 'Bank',
  bar:                  'Bar',
  cafe:                 'Café',
  fast_food_restaurant: 'Fast Food',
  night_club:           'Night Club',
  restaurant:           'Restaurant',

  // Health
  dentist:              'Dentist',
  doctor:               'Doctor',
  drugstore:            'Drugstore',
  gym:                  'Gym',
  fitness_center:       'Fitness Center',
  hospital:             'Hospital',
  pharmacy:             'Pharmacy',
  physiotherapist:      'Physiotherapist',
  spa:                  'Spa',
  sports_complex:       'Sports Complex',
  veterinary_care:      'Veterinary',

  // Shopping & retail
  beauty_salon:         'Beauty Salon',
  bicycle_store:        'Bicycle Store',
  book_store:           'Book Store',
  car_dealer:           'Car Dealer',
  car_rental:           'Car Rental',
  clothing_store:       'Clothing Store',
  convenience_store:    'Convenience Store',
  department_store:     'Department Store',
  electronics_store:    'Electronics Store',
  florist:              'Florist',
  grocery_store:        'Grocery Store',
  hair_care:            'Hair Salon',
  hardware_store:       'Hardware Store',
  home_goods_store:     'Home Goods',
  jewelry_store:        'Jewelry Store',
  laundry:              'Laundry',
  liquor_store:         'Liquor Store',
  locksmith:            'Locksmith',
  meal_delivery:        'Delivery',
  meal_takeaway:        'Takeaway',
  pet_store:            'Pet Store',
  shoe_store:           'Shoe Store',
  shopping_mall:        'Shopping Mall',
  storage:              'Storage',
  supermarket:          'Supermarket',

  // Services & finance
  accounting:           'Accounting',
  car_repair:           'Car Repair',
  car_wash:             'Car Wash',
  city_hall:            'City Hall',
  gas_station:          'Gas Station',
  insurance_agency:     'Insurance',
  post_office:          'Post Office',
  real_estate_agency:   'Real Estate',

  // Transport
  airport:              'Airport',
  bus_station:          'Bus Station',
  light_rail_station:   'Light Rail',
  subway_station:       'Subway Station',
  taxi_stand:           'Taxi',
  train_station:        'Train Station',
  transit_station:      'Transit Station',

  // Education & culture
  art_gallery:          'Art Gallery',
  library:              'Library',
  museum:               'Museum',
  primary_school:       'Primary School',
  school:               'School',
  secondary_school:     'Secondary School',
  university:           'University',

  // Outdoor & leisure
  amusement_park:       'Amusement Park',
  aquarium:             'Aquarium',
  campground:           'Campground',
  lodging:              'Hotel',
  movie_theater:        'Movie Theater',
  park:                 'Park',
  stadium:              'Stadium',
  tourist_attraction:   'Tourist Attraction',
  zoo:                  'Zoo',
};

/**
 * Returns a human-readable label for a Google Places type string.
 * Falls back to title-casing the raw type (e.g. "fitness_center" → "Fitness Center").
 */
export function placeTypeLabel(type: string): string {
  return (
    poiCatalogLabel(type as PoiType) ??
    PLACE_TYPE_LABELS[type] ??
    type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
  );
}

// ─── Category → place type mapping ───────────────────────────────────────────

/**
 * Returns the Google Places primary type string to use for proximity searches
 * for tasks that belong to `category`.
 *
 * This is the formal mapping layer (KAN-23): because `category.poi` is already
 * stored as a Google Places primary type string, the mapping is an identity
 * pass-through. The function exists as the single place to put any future
 * translation logic (e.g. aliasing, overrides) without touching call sites.
 *
 * Returns null when the category has no location association.
 */
export function resolveCategoryPlaceType(category: Category): string | null {
  return category.poi ?? null;
}

// ─── Places Autocomplete (KAN-76) ─────────────────────────────────────────────

/** A single autocomplete suggestion returned by an autocomplete search. */
export interface PlaceAutocompleteSuggestion {
  /** Google Places ID (establishment search) or `osm:<place_id>` (Nominatim). */
  placeId: string;
  /** Display name of the place (e.g. "Nike Store", "Faro"). */
  name: string;
  /** Formatted secondary address line (e.g. "Oxford Street, London"). */
  address: string;
  /**
   * Coordinates, when the search source already returns them (Nominatim —
   * see searchDestinationAutocomplete/searchAddressAutocomplete). Absent for
   * Google establishment results, which require a separate getPlaceDetails
   * call.
   */
  lat?: number;
  lng?: number;
}

interface AutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      structuredFormat?: {
        mainText?:      { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }>;
}

/**
 * Search for establishments matching the user-typed `query` string.
 * Results are optionally biased towards `lat`/`lng` when the device location
 * is available (50 km radius — covers most metro areas).
 *
 * Returns up to 5 establishment suggestions, sorted by relevance.
 * Returns an empty array on API error (search is best-effort).
 *
 * Uses the Places Autocomplete (New) API:
 *   POST https://places.googleapis.com/v1/places:autocomplete
 *
 * Stays on Google (KAN-320 spike, KAN-278) — Nominatim has no equivalent
 * ranked establishment search, only geocoding of named/addressed places.
 */
export async function searchPlacesAutocomplete(
  query: string,
  lat?: number,
  lng?: number,
): Promise<PlaceAutocompleteSuggestion[]> {
  if (!query.trim()) { return []; }

  let data: AutocompleteResponse;
  try {
    data = await placesAutocompleteProxy(query, 'establishment', lat, lng) as AutocompleteResponse;
  } catch {
    return [];
  }

  const results: PlaceAutocompleteSuggestion[] = [];
  for (const s of data.suggestions ?? []) {
    const pred = s.placePrediction;
    if (!pred?.placeId) { continue; }
    results.push({
      placeId: pred.placeId,
      name:    pred.structuredFormat?.mainText?.text      ?? pred.placeId,
      address: pred.structuredFormat?.secondaryText?.text ?? '',
    });
    if (results.length >= 5) { break; }
  }
  return results;
}

// ─── Nominatim search — destination / address autocomplete (KAN-320) ─────────
//
// Google Places' free establishment autocomplete has no OSM equivalent, but
// city and free-form address geocoding do — Nominatim's /search endpoint,
// same service already used for reverse geocoding above. Unlike Google
// Places, Nominatim returns lat/lon directly in the search response, so
// these two search functions need no follow-up getPlaceDetails call.

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

/**
 * `addresstype` values that mean "this result IS a settlement" — city/town/
 * village/etc, as opposed to a street, POI, or a bigger administrative region
 * (county/state/country) that also comes back tagged `category: "boundary"`.
 * Verified against live Nominatim responses (KAN-320 review) — `category`
 * alone can't distinguish these: Lisboa, Faro, and "Beja" (a county) all come
 * back as `category: "boundary", type: "administrative"`; `addresstype` is
 * the field that actually says "city" vs "county" vs "state".
 */
const NOMINATIM_SETTLEMENT_ADDRESS_TYPES = new Set([
  'city', 'town', 'village', 'hamlet', 'municipality',
]);

interface NominatimSearchResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  addresstype?: string;
  name?: string;
}

// Own clock, independent of reverseGeocode's (KAN-320 review) — see the
// NOMINATIM_MIN_INTERVAL_MS comment above for why these must not share one.
let lastAutocompleteRequestAt = 0;

/**
 * Blocks until it's safe to fire the next autocomplete request. Unlike
 * reverseGeocode's skip-and-return-null (fine for a background "Outside"
 * label refresh), a user-initiated search must not be silently dropped —
 * that read as "search is broken, no results ever come back" (KAN-320
 * review). Re-checks after each wait in case a concurrent search call
 * claimed the slot first.
 */
async function waitForAutocompleteSlot(): Promise<void> {
  for (;;) {
    const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastAutocompleteRequestAt);
    if (wait <= 0) { return; }
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}

async function fetchNominatimAutocomplete(
  query: string,
  citiesOnly: boolean,
  lat?: number,
  lng?: number,
): Promise<PlaceAutocompleteSuggestion[]> {
  if (!query.trim()) { return []; }

  await waitForAutocompleteSlot();
  lastAutocompleteRequestAt = Date.now();

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '8',
  });
  // Soft bias (not a hard restriction) toward the caller's current region,
  // same intent as the lat/lng bias on searchPlacesAutocomplete.
  if (lat != null && lng != null) {
    const delta = 0.5; // ~55 km at the equator — plenty for a soft bias box
    params.set('viewbox', `${lng - delta},${lat + delta},${lng + delta},${lat - delta}`);
    params.set('bounded', '0');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);
  try {
    const res = await fetch(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
      method: 'GET',
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) { return []; }

    const raw = (await res.json()) as NominatimSearchResult[];
    const filtered = citiesOnly
      ? raw.filter(r => !!r.addresstype && NOMINATIM_SETTLEMENT_ADDRESS_TYPES.has(r.addresstype))
      : raw;

    return filtered.slice(0, 5).map((r) => {
      const parts = r.display_name.split(', ');
      return {
        placeId: `osm:${r.place_id}`,
        name:    r.name || parts[0],
        address: parts.slice(1).join(', '),
        lat:     parseFloat(r.lat),
        lng:     parseFloat(r.lon),
      };
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search for cities/towns/regions matching the user-typed `query` string
 * (KAN-234 Trip Planner destination search) — excludes individual businesses/
 * landmarks/street addresses, unlike searchAddressAutocomplete.
 *
 * `lat`/`lng`, when available, bias ambiguous queries (e.g. "Faro" — several
 * exist worldwide) toward the caller's current region — a soft bias, it
 * doesn't exclude far-away matches, just ranks nearby ones higher.
 *
 * Uses OSM Nominatim (KAN-320) — replaces the former Google Places `(cities)`
 * search. Results carry lat/lng directly, no getPlaceDetails follow-up needed.
 */
export async function searchDestinationAutocomplete(
  query: string,
  lat?: number,
  lng?: number,
): Promise<PlaceAutocompleteSuggestion[]> {
  return fetchNominatimAutocomplete(query, true, lat, lng);
}

/**
 * Free-form address search for the Settings "Home" flow (KAN-247) — no
 * settlement-only restriction, so a specific street address/premise resolves
 * just as well as a named place. Same 5-result cap and best-effort (never
 * throws) contract as the rest of this file's search functions.
 *
 * Uses OSM Nominatim (KAN-320) — replaces the former Google Places free-form
 * search. Results carry lat/lng directly, no getPlaceDetails follow-up needed.
 */
export async function searchAddressAutocomplete(
  query: string,
  lat?: number,
  lng?: number,
): Promise<PlaceAutocompleteSuggestion[]> {
  return fetchNominatimAutocomplete(query, false, lat, lng);
}

/** Test-only: clears the autocomplete rate-limit clock. */
export function __resetNominatimAutocompleteForTests(): void {
  lastAutocompleteRequestAt = 0;
}

// ─── Place Details (KAN-234) ──────────────────────────────────────────────────

/** Resolved coordinates + display name for a Places Autocomplete suggestion. */
export interface PlaceDetails {
  lat: number;
  lng: number;
  name: string;
}

/**
 * Resolves a Places Autocomplete `placeId` (which carries no coordinates —
 * see `searchPlacesAutocomplete`) to its lat/lng, for centering a Trip
 * Planner download on the chosen destination.
 *
 * Uses the Places Details (New) API:
 *   GET https://places.googleapis.com/v1/places/{placeId}
 *
 * Returns null on any error/non-200 response — best-effort, same contract
 * as the rest of this file's search functions. Never throws.
 */
export async function getPlaceDetails(placeId: string): Promise<PlaceDetails | null> {
  interface PlaceDetailsResponse {
    location?: { latitude?: number; longitude?: number };
    displayName?: { text?: string };
  }

  try {
    const data = await getPlaceDetailsProxy(placeId) as PlaceDetailsResponse;
    if (data.location?.latitude == null || data.location?.longitude == null) { return null; }

    return {
      lat:  data.location.latitude,
      lng:  data.location.longitude,
      name: data.displayName?.text ?? placeId,
    };
  } catch {
    return null;
  }
}

// ─── Trip radius map preview (KAN-321) ────────────────────────────────────────
//
// Renders via @maplibre/maplibre-react-native against OpenFreeMap's free,
// keyless vector tiles (https://openfreemap.org) — no Google dependency on
// either platform, unlike react-native-maps (which has no non-Google native
// provider on Android). See TripPlannerScreen for the <Map>/<Camera>/
// <GeoJSONSource> usage.

const METERS_PER_DEGREE_LAT = 111_195;

/** OpenFreeMap's "Liberty" style — free, keyless vector tiles, no usage limits. */
export const TRIP_PREVIEW_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * A trip radius circle should occupy roughly this fraction of the preview
 * frame's smaller half-dimension, leaving visible padding around it rather
 * than touching the frame's edges.
 */
export const CIRCLE_FRACTION_OF_HALF_DIM = 0.4;

/**
 * Computes the MapLibre zoom level that fits a `radiusMeters` circle at
 * `lat` inside a `width`×`height` frame, leaving CIRCLE_FRACTION_OF_HALF_DIM
 * padding on the frame's smaller dimension — same visual contract as the
 * Google Static Maps preview this replaced (KAN-321/KAN-234).
 *
 * Standard Web Mercator meters-per-pixel formula:
 *   metersPerPixel = 156543.03392 * cos(lat) / 2^zoom
 * solved for the zoom that makes the desired radius match the padding
 * fraction of the frame's half-dimension.
 */
export function computeTripPreviewZoom(
  lat: number,
  radiusMeters: number,
  width: number,
  height: number,
): number {
  const halfDim = Math.min(width, height) / 2;
  const desiredMetersPerPixel = radiusMeters / (halfDim * CIRCLE_FRACTION_OF_HALF_DIM);
  const metersPerPixelAtZoom0 = 156_543.03392 * Math.cos(lat * DEG_TO_RAD);
  const zoom = Math.log2(metersPerPixelAtZoom0 / desiredMetersPerPixel);
  return Math.max(1, Math.min(20, zoom));
}

const CIRCLE_POLYGON_STEPS = 64;

/**
 * Builds a geographic circle polygon (GeoJSON Feature) centered on
 * `lat`/`lng` with the given `radiusMeters` — for a MapLibre <GeoJSONSource>/
 * <Layer type="fill"|"line"> radius overlay, which (unlike react-native-maps'
 * meters-based <Circle>) has no built-in geographic circle primitive; a
 * circle-radius paint property is always in screen pixels, not meters.
 *
 * Equirectangular approximation (same quality bar as getDistanceMeters/
 * osmPlaces.ts elsewhere in this file) — accurate enough for a small preview
 * circle, not meant for precise geodesy at any radius/latitude.
 */
export function buildTripPreviewCircle(
  lat: number,
  lng: number,
  radiusMeters: number,
): Feature<Polygon> {
  const latDegPerMeter = 1 / METERS_PER_DEGREE_LAT;
  const lngDegPerMeter = 1 / (METERS_PER_DEGREE_LAT * Math.cos(lat * DEG_TO_RAD));

  const coordinates: [number, number][] = [];
  for (let i = 0; i <= CIRCLE_POLYGON_STEPS; i++) {
    const angle = (i / CIRCLE_POLYGON_STEPS) * 2 * Math.PI;
    coordinates.push([
      lng + radiusMeters * Math.sin(angle) * lngDegPerMeter,
      lat + radiusMeters * Math.cos(angle) * latDegPerMeter,
    ]);
  }

  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [coordinates] },
  };
}
