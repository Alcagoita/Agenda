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
import { GOOGLE_MAPS_STATIC_ANDROID_API_KEY, GOOGLE_MAPS_STATIC_IOS_API_KEY } from '../config/keys';
import {
  getPlaceDetailsProxy,
  placesAutocompleteProxy,
  searchNearbyPlacesProxy,
} from './placesFunctions';
import { getCachedCity, putCachedCity } from './reverseGeocodeCache';
import { Category, PoiType, POI_GOOGLE_TYPES, poiCatalogLabel } from '../types';
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

// ─── Internal Places API types ─────────────────────────────────────────────────

interface PlacesApiPlace {
  id: string;
  displayName?: { text: string; languageCode?: string };
  location?: { latitude: number; longitude: number };
  types?: string[];
  /** Google's own single "this IS its type" field — unlike `types` (whose
   *  order isn't guaranteed to put the primary type first), this is the
   *  reliable one for anything that needs to trust a SPECIFIC type. */
  primaryType?: string;
}

interface PlacesApiResponse {
  places?: PlacesApiPlace[];
}

// ─── Haversine distance ────────────────────────────────────────────────────────

const DEG_TO_RAD = Math.PI / 180;

/**
 * Returns the great-circle distance in metres between two lat/lng pairs.
 * Accurate enough for geofence radii of 50–75 m.
 */
export function getDistanceMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6_371_000; // Earth radius in metres
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
 * Search for places of all given POI types within `radiusMeters` of `lat`/`lng`
 * in a SINGLE Places API call.
 *
 * `poiTypes` accepts our internal PoiType keys (mapped via POI_GOOGLE_TYPES) or
 * arbitrary Google Places primary type strings for custom categories. All types
 * are sent together in `includedTypes` so the API returns matches for any of
 * them in one round-trip.
 *
 * Returns a map keyed by the original poiType, each entry sorted ascending by
 * straight-line distance (up to 5 candidates per type).
 *
 * Throws on network error, timeout (8 s), or non-200 response.
 */
export async function searchNearbyPlaces(
  lat: number,
  lng: number,
  poiTypes: string[],
  radiusMeters: number,
): Promise<Record<string, NearbyPlace[]>> {
  if (poiTypes.length === 0) { return {}; }

  // Map internal type keys → Google Places primary type strings.
  const googleTypes = poiTypes.map(t => POI_GOOGLE_TYPES[t as PoiType] ?? t);

  // Reverse map for grouping results back by our internal key.
  const googleToInternal: Record<string, string> = {};
  for (let i = 0; i < poiTypes.length; i++) {
    googleToInternal[googleTypes[i]] = poiTypes[i];
  }

  const data = await searchNearbyPlacesProxy(lat, lng, googleTypes, radiusMeters) as PlacesApiResponse;

  // Initialise result buckets for every requested type.
  const result: Record<string, NearbyPlace[]> = {};
  for (const poiType of poiTypes) { result[poiType] = []; }

  for (const p of data.places ?? []) {
    if (!p.location) { continue; }
    const placeLat = p.location.latitude;
    const placeLng = p.location.longitude;
    const nearbyPlace: NearbyPlace = {
      placeId:        p.id,
      name:           p.displayName?.text ?? 'Unknown',
      lat:            placeLat,
      lng:            placeLng,
      distanceMeters: getDistanceMeters(lat, lng, placeLat, placeLng),
      primaryType:    p.primaryType,
      types:          p.types,
    };

    // Assign this place to the first requested type it matches — this is
    // "did it match ANY of what we asked for", not "this IS its type"; see
    // NearbyPlace.primaryType for anything that needs the latter.
    for (const placeType of (p.types ?? [])) {
      const internalType = googleToInternal[placeType];
      if (internalType && result[internalType]) {
        result[internalType].push(nearbyPlace);
        break;
      }
    }
  }

  // Sort each bucket — no extra cap here. Google's own searchNearby request
  // already caps at maxResultCount: 20 (functions/src/places.ts) and returns
  // them ranked by distance; re-truncating to 5 on top of that (KAN-282
  // review) meant a POI type's nearest 5 instances across the WHOLE radius
  // could all be elsewhere, shutting out the one actually inside a specific
  // venue (e.g. a shopping mall) that a caller like resolveTaskDestination
  // would otherwise have found further down Google's own top-20.
  for (const poiType of poiTypes) {
    result[poiType].sort((a, b) => a.distanceMeters - b.distanceMeters);
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

/** A place class Nominatim tags settlements with — city/town/village/etc. */
const NOMINATIM_SETTLEMENT_CLASS = 'place';

interface NominatimSearchResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  class?: string;
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
    const filtered = citiesOnly ? raw.filter(r => r.class === NOMINATIM_SETTLEMENT_CLASS) : raw;

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

// ─── Static map preview (KAN-234) ─────────────────────────────────────────────

const STATIC_MAP_URL = 'https://maps.googleapis.com/maps/api/staticmap';

/**
 * A trip radius circle should occupy roughly this fraction of the preview
 * frame's smaller half-dimension, leaving visible padding around it rather
 * than touching the image edges.
 */
export const CIRCLE_FRACTION_OF_HALF_DIM = 0.4;

/**
 * Builds a Google Static Maps API URL centered on `lat`/`lng`, at a zoom
 * level chosen so a circle of `radiusMeters` (drawn separately, as an
 * overlay View on top of this image — see TripPlannerScreen) visually fits
 * within the given frame. Deliberately doesn't use the Static Maps `path=`
 * polygon param to draw the circle itself (avoids query-length limits and
 * true-circle-from-lat/lng-offsets math) — the image is just the backdrop.
 *
 * Uses GOOGLE_MAPS_STATIC_ANDROID_API_KEY / GOOGLE_MAPS_STATIC_IOS_API_KEY —
 * NOT the shared GOOGLE_PLACES_API_KEY. This request goes out through
 * <Image>, a real app request an Android/iOS-app-restricted key can verify
 * (unlike the plain fetch() REST calls elsewhere in this file, which need an
 * app-unrestricted key since fetch carries no app signature).
 *
 * Zoom is derived from the standard Web Mercator meters-per-pixel formula:
 *   metersPerPixel = 156543.03392 * cos(lat) / 2^zoom
 * solved for the zoom that makes the desired radius match
 * CIRCLE_FRACTION_OF_HALF_DIM of the frame's half-dimension.
 *
 * KAN-21 still applies — this is a single static image request, not an
 * embedded interactive map SDK.
 */
export function buildStaticMapPreviewUrl(
  lat: number,
  lng: number,
  radiusMeters: number,
  width: number,
  height: number,
): string {
  const halfDim = Math.min(width, height) / 2;
  const desiredMetersPerPixel = radiusMeters / (halfDim * CIRCLE_FRACTION_OF_HALF_DIM);
  const metersPerPixelAtZoom0 = 156_543.03392 * Math.cos(lat * DEG_TO_RAD);
  const zoom = Math.round(Math.log2(metersPerPixelAtZoom0 / desiredMetersPerPixel));
  const clampedZoom = Math.max(1, Math.min(20, zoom));

  const params = new URLSearchParams({
    center:  `${lat},${lng}`,
    zoom:    String(clampedZoom),
    size:    `${Math.round(width)}x${Math.round(height)}`,
    maptype: 'roadmap',
    key:     Platform.OS === 'ios' ? GOOGLE_MAPS_STATIC_IOS_API_KEY : GOOGLE_MAPS_STATIC_ANDROID_API_KEY,
  });
  return `${STATIC_MAP_URL}?${params.toString()}`;
}
