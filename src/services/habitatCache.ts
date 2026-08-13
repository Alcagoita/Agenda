/**
 * habitatCache.ts — offline "habitat" POI cache (KAN-228).
 *
 * A local SQLite cache of POIs sourced from OpenStreetMap (see osmPlaces.ts),
 * refreshed opportunistically whenever the live proximity search runs online
 * (wired in proximity.ts). No separate "frequently visited area" detection —
 * caching around wherever the live search already runs means places the user
 * actually visits stay fresh (re-refreshed each time), while rarely-visited
 * ones simply go stale and get evicted under the size budget. "Habitat"
 * emerges as a property of the cache's contents rather than a tracked signal.
 *
 * Cross-source place identity: the same physical place may be seen via
 * Google (live search, has a placeId) or OSM (cache refresh, has an osmId).
 * `upsertPlace` is the single entry point both paths go through — it matches
 * an incoming candidate against existing rows (same POI type, within
 * IDENTITY_MATCH_RADIUS_M, similar normalized name) and merges the source ref
 * in rather than creating a duplicate, so a place seen via one source today
 * and the other tomorrow resolves to the same internal id. Consumers must
 * always key off this internal id, never a raw source id (KAN-228 AC).
 *
 * Google coordinates are never persisted long-term (Places ToS forbids it —
 * place IDs only): a Google-sourced candidate can only *merge into* an
 * already OSM-anchored row (updating its identity ref), never create a new
 * row or overwrite a row's lat/lng. Only OSM-sourced candidates create rows
 * or move a row's coordinates. `osm_fetched_at` tracks OSM freshness
 * specifically (for the 14-day staleness check) — `last_matched_at` tracks
 * any sighting (Google or OSM) for LRU eviction.
 *
 * Note: does NOT read from the cache to answer live proximity queries — that
 * wiring is KAN-229 ("cache-backed offline proximity"). This file only
 * builds and maintains the cache; queryHabitatCache is exposed for KAN-229
 * to call.
 *
 * Trip areas (KAN-234): a manually-downloaded travel area writes rows via
 * upsertTripPlace instead of upsertPlace, tagging them with a cache_area_id
 * (joins to the Trip Firestore doc) and an expires_at (date-tied to the
 * trip, instead of the opportunistic pool's osm_fetched_at/staleness
 * regime). Trip rows are exempt from enforceSizeBudget's LRU eviction —
 * only deleteExpiredTripPlaces or an explicit deleteTripAreaPlaces (trip
 * deletion) removes them — so an unrelated burst of opportunistic caching
 * elsewhere can never silently evict an unexpired trip's coverage.
 * queryHabitatCache is untouched: it already answers by lat/lng + poiType
 * regardless of cache_area_id, so a downloaded trip area transparently
 * serves offline queries once the user is physically there.
 */

import * as SQLite from 'expo-sqlite';
import NetInfo from '@react-native-community/netinfo';
import { normalize } from './poiInference';
import { searchOsmPlaces } from './osmPlaces';
import type { NearbyPlace } from './maps';
import { getDistanceMeters } from './maps';
import { POI_OSM_TAGS, SUPPLEMENTARY_OSM_TAGS } from '../types';
import {
  inferRestaurantFoodTypeFromPlaceName,
  listRestaurantFoodTypes,
  type RestaurantFoodType,
} from './restaurantFoodTypes';
import {
  inferStoreSubtypeFromPlaceName,
  listStoreSubtypes,
  type StoreSubtype,
} from './storeSubtypes';

// ─── Constants ────────────────────────────────────────────────────────────────

/** A cached place's OSM data is re-fetched once older than this. */
export const HABITAT_CACHE_STALE_MS = 14 * 24 * 60 * 60 * 1_000; // 14 days

/** Default query/refresh radius around a search origin. */
export const HABITAT_RADIUS_M = 5_000;

/** Hard cap on total cached rows — keeps the on-device footprint small. */
export const MAX_CACHED_PLACES = 2_000;

/**
 * Separate cap for `shopping_mall` rows (KAN-282). They're excluded from the
 * MAX_CACHED_PLACES pool because ordinary LRU eviction is the wrong signal
 * for them (see enforceSizeBudget) — but "exempt from LRU" must not mean
 * "unbounded", or a well-travelled user's mall rows would grow forever.
 * Generous relative to reality (a dense metro yields ~45 within 5 km), so it
 * only ever bites after many cities.
 */
export const MAX_CACHED_MALLS = 200;

/** Two candidates within this distance (same POI type, similar name) are treated as the same place. */
const IDENTITY_MATCH_RADIUS_M = 150;

/** Caps each query type bucket — a global top-N across the whole query
 *  radius. Kept generous (not 5) mainly for mall discovery (KAN-282):
 *  mallRoute reads ALL `shopping_mall` rows in range to size-filter them, so
 *  a low cap could return only the nearest few small galleries and never
 *  surface the big destination mall further out. Ordinary POI resolution is
 *  unaffected either way — it only ever reads the nearest ([0]) result. */
const MAX_RESULTS_PER_TYPE = 50;

const DB_NAME = 'habitat_cache.db';

const DEG_TO_RAD = Math.PI / 180;
const METRES_PER_DEGREE_LAT = 111_195;

/**
 * A bounding box (in degrees) around lat/lng covering radiusMeters in every
 * direction. Longitude degrees shrink toward the poles (they're only
 * equivalent to latitude degrees at the equator), so the longitude delta is
 * corrected by cos(latitude) — clamped away from 0 so it never blows up near
 * the poles.
 */
function boundingBoxDeg(lat: number, lng: number, radiusMeters: number) {
  const latDeg = radiusMeters / METRES_PER_DEGREE_LAT;
  const cosLat = Math.max(Math.cos(lat * DEG_TO_RAD), 0.01);
  const lngDeg = radiusMeters / (METRES_PER_DEGREE_LAT * cosLat);
  return {
    latMin: lat - latDeg, latMax: lat + latDeg,
    lngMin: lng - lngDeg, lngMax: lng + lngDeg,
  };
}

// ─── DB handle (lazy, cached) ─────────────────────────────────────────────────

let db: SQLite.SQLiteDatabase | null = null;

function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    // Only commit to the module-level `db` cache once every migration step
    // below has succeeded — assigning it upfront would mean a mid-migration
    // failure (e.g. the ALTER TABLE throwing on a real error) permanently
    // wedges the cache: `if (!db)` would be false forever after, so a later
    // call would never retry and would just hand back a half-migrated
    // handle for the rest of the process's lifetime.
    const database = SQLite.openDatabaseSync(DB_NAME);
    database.execSync(`
      CREATE TABLE IF NOT EXISTS habitat_places (
        id TEXT PRIMARY KEY,
        poi_type TEXT NOT NULL,
        name TEXT NOT NULL,
        is_generic_name INTEGER NOT NULL DEFAULT 0,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        google_place_id TEXT,
        osm_id TEXT,
        osm_fetched_at INTEGER NOT NULL,
        last_matched_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_habitat_poi_type ON habitat_places(poi_type);
    `);
    // KAN-234 migration — habitat_places predates the cache_area_id/expires_at
    // columns (trip-area tagging + date-tied expiry), and CREATE TABLE IF NOT
    // EXISTS won't retrofit columns onto an already-existing on-device DB.
    // Check the actual schema instead of blindly ALTER-then-catch, so a real
    // failure (disk full, corruption) surfaces instead of being masked by a
    // blanket catch.
    const existingColumns = new Set(
      database.getAllSync<{ name: string }>('PRAGMA table_info(habitat_places)').map(c => c.name),
    );
    if (!existingColumns.has('cache_area_id')) {
      database.execSync('ALTER TABLE habitat_places ADD COLUMN cache_area_id TEXT');
    }
    if (!existingColumns.has('expires_at')) {
      database.execSync('ALTER TABLE habitat_places ADD COLUMN expires_at INTEGER');
    }
    // KAN-282 migration — building-footprint area for OSM-sourced malls, used
    // to filter destination malls from small ones. Nullable, and the NULL is
    // meaningful: it marks a row cached BEFORE this field existed, whose area
    // is simply unknown. A row fetched with geometry always stores a number
    // (0 for a bare node — see osmPlaces.OsmPlace.footprintAreaM2).
    if (!existingColumns.has('footprint_area_m2')) {
      database.execSync('ALTER TABLE habitat_places ADD COLUMN footprint_area_m2 REAL');
    }
    // Backfill: a mall row with an unknown (NULL) area can never satisfy
    // mallRoute's size gate, so it would sit useless until it aged out
    // (HABITAT_CACHE_STALE_MS — up to 14 days). Force those rows stale so the
    // next refresh re-fetches them WITH geometry. Deliberately outside the
    // ADD COLUMN branch above: a device that already ran the build which
    // added the column still has NULL-area mall rows to repair. Self-
    // terminating — once refreshed every row holds a number (0 or an area),
    // so this matches nothing on later launches.
    database.runSync(
      `UPDATE habitat_places SET osm_fetched_at = 0
        WHERE poi_type = 'shopping_mall' AND footprint_area_m2 IS NULL AND osm_fetched_at > 0`,
    );
    // KAN-293 migration — the place's own site, from OSM's `website` tag. Only
    // ever read back to decide whether the cluster box's leisure line can
    // offer a ticket link; NULL simply means "OSM has no site for this place"
    // and the link is omitted. We never fetch to fill it.
    if (!existingColumns.has('website')) {
      database.execSync('ALTER TABLE habitat_places ADD COLUMN website TEXT');
    }
    // KAN-317 migration — subtype metadata lets offline nearby matching keep
    // restaurant/store precision without relying only on name matching.
    if (!existingColumns.has('restaurant_food_type')) {
      database.execSync('ALTER TABLE habitat_places ADD COLUMN restaurant_food_type TEXT');
    }
    if (!existingColumns.has('store_subtype')) {
      database.execSync('ALTER TABLE habitat_places ADD COLUMN store_subtype TEXT');
    }
    // KAN-342 migration — Foursquare (via Cloudflare) is now a third live
    // source, freely storable like OSM (Apache 2.0) — needs its own identity
    // column, not shoehorned into google_place_id or osm_id.
    if (!existingColumns.has('fsq_place_id')) {
      database.execSync('ALTER TABLE habitat_places ADD COLUMN fsq_place_id TEXT');
    }
    database.execSync('CREATE INDEX IF NOT EXISTS idx_habitat_cache_area ON habitat_places(cache_area_id);');
    db = database;
  }
  return db;
}

/** Test-only: drop the cached DB handle so the next call re-opens/re-migrates. */
export function __resetHabitatDbForTests(): void {
  db = null;
}

// ─── Row shape ────────────────────────────────────────────────────────────────

export interface HabitatRow {
  id: string;
  poi_type: string;
  name: string;
  is_generic_name: number;
  lat: number;
  lng: number;
  google_place_id: string | null;
  osm_id: string | null;
  /** Foursquare id via Cloudflare (KAN-342) — null for rows never matched to a live Cloudflare result. */
  fsq_place_id: string | null;
  osm_fetched_at: number;
  last_matched_at: number;
  /** Non-null when this row belongs to a KAN-234 trip download — joins to Trip.cacheAreaId. Null for ordinary opportunistic habitat rows. */
  cache_area_id: string | null;
  /** Epoch ms this row is valid until (trip rows only) — null for ordinary habitat rows, which are governed by osm_fetched_at/HABITAT_CACHE_STALE_MS instead. */
  expires_at: number | null;
  /** OSM building-footprint area in m² (KAN-282) — only set for OSM way/relation malls; null for everything else. */
  footprint_area_m2: number | null;
  /** The place's own site from OSM's `website` tag (KAN-293); null when OSM has none. */
  website: string | null;
  /** Restaurant food subtype inferred at cache-write time (KAN-317). */
  restaurant_food_type: RestaurantFoodType | null;
  /** Store subtype inferred at cache-write time (KAN-317). */
  store_subtype: StoreSubtype | null;
}

function generateId(): string {
  return `hp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Identity resolution ──────────────────────────────────────────────────────

export interface PlaceCandidate {
  poiType: string;
  name: string;
  /** True when `name` is a generic tag-value fallback, not a real identifying name (see osmPlaces.ts). */
  isGenericName?: boolean;
  lat: number;
  lng: number;
  /**
   * `google` is never written by any live code path anymore (KAN-342 —
   * Google Places has no role in live search) — kept in the type only
   * because existing on-device rows from before that change may still carry
   * a real value there, and this type still needs to describe them. `osm`
   * and `fsq` (Foursquare, via Cloudflare) are the two sources that can
   * actually create/move a row today — both are freely storable (ODbL,
   * Apache 2.0 respectively), unlike Google's restricted coordinate-caching
   * terms, which is why Google could only ever merge into an existing row,
   * never create one (see upsertPlaceCore).
   */
  source: { google?: string; osm?: string; fsq?: string };
  /** OSM building-footprint area in m² (KAN-282) — only OSM way/relation malls carry this; omitted otherwise. */
  footprintAreaM2?: number;
  /** The place's own site from OSM's `website` tag (KAN-293); omitted when OSM has none. */
  website?: string;
  /** Optional subtype metadata for restaurant rows (KAN-317). */
  restaurantFoodType?: RestaurantFoodType | null;
  /** Optional subtype metadata for store rows (KAN-317). */
  storeSubtype?: StoreSubtype | null;
}

function candidateRestaurantFoodType(candidate: PlaceCandidate): RestaurantFoodType | null {
  if (candidate.poiType !== 'restaurant') { return null; }
  return candidate.restaurantFoodType ?? inferRestaurantFoodTypeFromPlaceName(candidate.name);
}

function candidateStoreSubtype(candidate: PlaceCandidate): StoreSubtype | null {
  if (candidate.poiType !== 'store') { return null; }
  return candidate.storeSubtype ?? inferStoreSubtypeFromPlaceName(candidate.name);
}

function normalizeCachedRestaurantFoodType(value: RestaurantFoodType | string | null): RestaurantFoodType | undefined {
  if (value == null) { return undefined; }
  return (listRestaurantFoodTypes() as string[]).includes(value) ? value as RestaurantFoodType : undefined;
}

function normalizeCachedStoreSubtype(value: StoreSubtype | string | null): StoreSubtype | undefined {
  if (value == null) { return undefined; }
  return (listStoreSubtypes() as string[]).includes(value) ? value as StoreSubtype : undefined;
}

/**
 * Resolve `candidate` to a stable internal place id: if an existing row of
 * the same POI type within IDENTITY_MATCH_RADIUS_M has a matching name,
 * merges the candidate's source ref into that row and returns its id.
 * Otherwise inserts a new row (OSM-sourced candidates only — see module
 * docs on why Google coordinates never create/move a row) and returns the
 * new id, or a transient (unpersisted) id for a Google-only candidate with
 * no existing match.
 *
 * Name matching: when either the candidate or the matched row has a generic
 * fallback name, only an exact normalized match counts — substring/contains
 * matching is reserved for real names, since a generic name like "pharmacy"
 * is a substring of nearly every real pharmacy's name and would otherwise
 * wrongly merge unrelated places.
 *
 * Never throws — a DB failure logs and returns a fresh (unpersisted) id
 * rather than blocking the caller (same "never blocks the app" contract as
 * the rest of the proximity stack).
 */
function findMatchingRow(
  database: SQLite.SQLiteDatabase,
  poiType: string,
  name: string,
  isGenericName: boolean | undefined,
  lat: number,
  lng: number,
): HabitatRow | null {
  const box = boundingBoxDeg(lat, lng, IDENTITY_MATCH_RADIUS_M);
  const rows = database.getAllSync<HabitatRow>(
    `SELECT * FROM habitat_places
     WHERE poi_type = ?
       AND lat BETWEEN ? AND ?
       AND lng BETWEEN ? AND ?`,
    [poiType, box.latMin, box.latMax, box.lngMin, box.lngMax],
  );

  const candidateName = normalize(name);
  const candidateIsGeneric = isGenericName === true;
  return rows.find(row => {
    const dist = getDistanceMeters(lat, lng, row.lat, row.lng);
    if (dist > IDENTITY_MATCH_RADIUS_M) { return false; }
    const rowName = normalize(row.name);
    if (candidateIsGeneric || row.is_generic_name === 1) {
      return rowName === candidateName;
    }
    return rowName === candidateName || rowName.includes(candidateName) || candidateName.includes(rowName);
  }) ?? null;
}

/**
 * Read-only lookup: returns the internal id of an already-established
 * cross-source identity match, or null if this place has no counterpart in
 * the cache yet. Unlike `upsertPlace`, never inserts/updates a row — used by
 * KAN-229 to reconcile a live Google result with its cache identity (when
 * one already exists) without minting a throwaway id for places that have no
 * match yet, which would defeat the whole point (a fresh random id on every
 * search instead of the place's own stable Google placeId).
 *
 * Never throws — a DB failure returns null (caller falls back to the
 * place's own source id, same as if no match existed).
 */
export function findExistingPlaceId(
  poiType: string,
  name: string,
  lat: number,
  lng: number,
  isGenericName?: boolean,
): string | null {
  try {
    const match = findMatchingRow(getDb(), poiType, name, isGenericName, lat, lng);
    return match?.id ?? null;
  } catch (err) {
    console.warn('[habitatCache] findExistingPlaceId failed', err);
    return null;
  }
}

/** Only set on a KAN-234 trip download's writes — plain upsertPlace calls never pass this. */
interface TripStamp { cacheAreaId: string; expiresAt: number; }

/**
 * Does the actual identity-merge/insert. Never catches — callers choose how
 * failures should behave: upsertPlaceInternal (below) swallows them for the
 * opportunistic never-throws contract; writeTripAreaPlaces lets them abort
 * (and roll back) a trip download's transaction instead.
 */
function upsertPlaceCore(candidate: PlaceCandidate, trip?: TripStamp): string {
  const database = getDb();
  const now = Date.now();
  // Both OSM (ODbL) and Foursquare-via-Cloudflare (Apache 2.0) are freely
  // storable — either can create a new row or move an existing one's
  // coordinates. Google cannot (restricted coordinate-caching terms), which
  // is the entire reason this flag exists: it's the gate on "may this
  // candidate actually persist its own lat/lng", not just "is this a live
  // hit". A Google-sourced candidate (source.google set, only possible on
  // pre-KAN-342 rows re-merging) can still update OTHER fields below, just
  // never lat/lng/fetched_at.
  const isFreelyStorable = candidate.source.osm != null || candidate.source.fsq != null;
  const match = findMatchingRow(
    database, candidate.poiType, candidate.name, candidate.isGenericName,
    candidate.lat, candidate.lng,
  );

  if (match) {
    const storableFlag = isFreelyStorable ? 1 : 0;
    const tripCacheAreaId = trip?.cacheAreaId ?? null;
    const tripExpiresAt = trip?.expiresAt ?? null;
    const restaurantFoodType = match.restaurant_food_type == null ? candidateRestaurantFoodType(candidate) : null;
    const storeSubtype = match.store_subtype == null ? candidateStoreSubtype(candidate) : null;
    database.runSync(
      `UPDATE habitat_places
       SET google_place_id   = COALESCE(google_place_id, ?),
           osm_id            = COALESCE(osm_id, ?),
           fsq_place_id      = COALESCE(fsq_place_id, ?),
           lat               = CASE WHEN ? = 1 THEN ? ELSE lat END,
           lng               = CASE WHEN ? = 1 THEN ? ELSE lng END,
           osm_fetched_at    = CASE WHEN ? = 1 THEN ? ELSE osm_fetched_at END,
           footprint_area_m2 = COALESCE(?, footprint_area_m2),
           website           = COALESCE(?, website),
           restaurant_food_type = COALESCE(?, restaurant_food_type),
           store_subtype        = COALESCE(?, store_subtype),
           cache_area_id     = COALESCE(cache_area_id, ?),
           expires_at        = CASE
                                WHEN ? IS NULL THEN expires_at
                                WHEN expires_at IS NULL THEN ?
                                ELSE MAX(expires_at, ?)
                              END,
           last_matched_at   = ?
       WHERE id = ?`,
      [
        candidate.source.google ?? null, candidate.source.osm ?? null, candidate.source.fsq ?? null,
        storableFlag, candidate.lat, storableFlag, candidate.lng, storableFlag, now,
        candidate.footprintAreaM2 ?? null,
        candidate.website ?? null,
        restaurantFoodType,
        storeSubtype,
        tripCacheAreaId,
        tripExpiresAt, tripExpiresAt, tripExpiresAt,
        now, match.id,
      ],
    );
    return match.id;
  }

  // No existing row. Google coordinates are never persisted long-term
  // (Places ToS) — only an OSM- or Foursquare-anchored candidate may create
  // a new row.
  if (!isFreelyStorable) { return generateId(); }

  const id = generateId();
  const restaurantFoodType = candidateRestaurantFoodType(candidate);
  const storeSubtype = candidateStoreSubtype(candidate);
  database.runSync(
    `INSERT INTO habitat_places
       (id, poi_type, name, is_generic_name, lat, lng, google_place_id, osm_id, fsq_place_id, osm_fetched_at, last_matched_at, cache_area_id, expires_at, footprint_area_m2, website, restaurant_food_type, store_subtype)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, candidate.poiType, candidate.name, candidate.isGenericName === true ? 1 : 0, candidate.lat, candidate.lng,
      candidate.source.google ?? null, candidate.source.osm ?? null, candidate.source.fsq ?? null, now, now,
      trip?.cacheAreaId ?? null, trip?.expiresAt ?? null, candidate.footprintAreaM2 ?? null,
      candidate.website ?? null, restaurantFoodType, storeSubtype],
  );
  return id;
}

function upsertPlaceInternal(candidate: PlaceCandidate, trip?: TripStamp): string {
  try {
    return upsertPlaceCore(candidate, trip);
  } catch (err) {
    console.warn('[habitatCache] upsertPlace failed', err);
    return generateId();
  }
}

export function upsertPlace(candidate: PlaceCandidate): string {
  return upsertPlaceInternal(candidate);
}

export interface TripPlaceCandidate extends PlaceCandidate {
  /** Joins this row to Trip.cacheAreaId. */
  cacheAreaId: string;
  /** Epoch ms — merging into an already trip-tagged row extends this to the max of old/new rather than overwriting, so a place shared between two trips (or re-discovered by a refresh) keeps the longest-lived expiry. */
  expiresAt: number;
}

/**
 * Same identity-merge as upsertPlace, but stamps cache_area_id/expires_at
 * (KAN-234). Merging into an existing untagged row tags it with this trip's
 * cacheAreaId (the place is now known to be inside an active trip's
 * coverage); merging into an already trip-tagged row never overwrites its
 * cache_area_id (first trip wins) — only extends expires_at to the max of
 * old/new. A plain (non-trip) upsertPlace call never touches an existing
 * row's cache_area_id/expires_at at all.
 */
export function upsertTripPlace(candidate: TripPlaceCandidate): string {
  const { cacheAreaId, expiresAt, ...rest } = candidate;
  return upsertPlaceInternal(rest, { cacheAreaId, expiresAt });
}

/**
 * Replaces every row tagged with cacheAreaId with the given places, as a
 * single SQLite transaction (KAN-234 review fix). Trip downloads/refreshes
 * are user-initiated foreground actions where data integrity matters — unlike
 * the opportunistic upsertPlace/upsertTripPlace above, this does NOT swallow
 * DB errors: if any delete/insert fails, withTransactionSync rolls back the
 * whole batch and this throws, so a previously-good trip cache is never left
 * half-deleted by a failed refresh. Returns the number of places written on
 * success.
 */
export function writeTripAreaPlaces(
  cacheAreaId: string,
  expiresAt: number,
  places: PlaceCandidate[],
): number {
  const database = getDb();
  let written = 0;
  database.withTransactionSync(() => {
    database.runSync('DELETE FROM habitat_places WHERE cache_area_id = ?', [cacheAreaId]);
    for (const place of places) {
      upsertPlaceCore(place, { cacheAreaId, expiresAt });
      written += 1;
    }
  });
  return written;
}

/**
 * Feeds a live search hit into the cache's identity table — source-aware
 * (KAN-342): the caller (proximity.ts) passes exactly one of `osm`/`fsq`
 * depending on which chain actually answered that tick. There is no
 * `google` option here anymore — Google Places has no role in live search
 * — but upsertPlace/PlaceCandidate still accept it as a type, since
 * pre-KAN-342 rows may carry a real google_place_id and this same merge
 * path is still what reconciles them going forward.
 *
 * Both osm and fsq candidates may create a new row or move an existing
 * one's coordinates (see upsertPlaceCore) — both sources are freely
 * storable, unlike Google's restricted terms.
 */
export function recordLiveResult(candidate: {
  poiType: string;
  name: string;
  lat: number;
  lng: number;
  source: { osm?: string; fsq?: string };
}): void {
  upsertPlace({
    poiType: candidate.poiType,
    name:    candidate.name,
    lat:     candidate.lat,
    lng:     candidate.lng,
    source:  candidate.source,
  });
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Query the cache for places of the given POI types within `radiusMeters` of
 * `lat`/`lng`. Shaped identically to maps.ts's searchNearbyPlaces (internal
 * id in the `placeId` field, capped at 5 results per type) so consumers stay
 * source-agnostic and KAN-229 can swap this in without changing call sites.
 *
 * Never throws — a DB failure returns an empty result per type.
 */
export function queryHabitatCache(
  lat: number,
  lng: number,
  poiTypes: string[],
  radiusMeters: number = HABITAT_RADIUS_M,
  options: { maxResultsPerType?: number | null } = {},
): Record<string, NearbyPlace[]> {
  if (
    options.maxResultsPerType != null
    && (!Number.isInteger(options.maxResultsPerType) || options.maxResultsPerType < 0)
  ) {
    throw new RangeError('maxResultsPerType must be a non-negative integer, null, or undefined');
  }

  const result: Record<string, NearbyPlace[]> = {};
  for (const poiType of poiTypes) { result[poiType] = []; }
  if (poiTypes.length === 0) { return result; }

  try {
    const database = getDb();
    const box = boundingBoxDeg(lat, lng, radiusMeters);
    const placeholders = poiTypes.map(() => '?').join(',');
    const rows = database.getAllSync<HabitatRow>(
      `SELECT * FROM habitat_places
       WHERE poi_type IN (${placeholders})
         AND lat BETWEEN ? AND ?
         AND lng BETWEEN ? AND ?`,
      [...poiTypes, box.latMin, box.latMax, box.lngMin, box.lngMax],
    );

    for (const row of rows) {
      const distanceMeters = getDistanceMeters(lat, lng, row.lat, row.lng);
      if (distanceMeters > radiusMeters) { continue; }
      result[row.poi_type]?.push({
        placeId: row.id,
        name:    row.name,
        lat:     row.lat,
        lng:     row.lng,
        distanceMeters,
        footprintAreaM2: row.footprint_area_m2 ?? undefined,
        website:         row.website ?? undefined,
        restaurantFoodType: normalizeCachedRestaurantFoodType(row.restaurant_food_type),
        storeSubtype:       normalizeCachedStoreSubtype(row.store_subtype),
      });
    }

    for (const poiType of poiTypes) {
      result[poiType].sort((a, b) => a.distanceMeters - b.distanceMeters);
      const maxResults = options.maxResultsPerType === undefined
        ? MAX_RESULTS_PER_TYPE
        : options.maxResultsPerType;
      if (maxResults != null && result[poiType].length > maxResults) {
        result[poiType] = result[poiType].slice(0, maxResults);
      }
    }
  } catch (err) {
    console.warn('[habitatCache] queryHabitatCache failed', err);
  }

  return result;
}

/**
 * Look up a single cached place by its internal id — the same id
 * `queryHabitatCache`/`upsertPlace` key off (KAN-228 cross-source identity),
 * and what `LearnedPlace.placeId` (learnedPlaces.ts) carries. Unlike
 * `queryHabitatCache`, this doesn't need a search origin — a learned place's
 * location is resolved from the id alone, independent of current distance
 * (KAN-279: "your place wins even if farther").
 *
 * Never throws — a DB failure or missing row returns null.
 */
export function getHabitatPlaceById(id: string): NearbyPlace | null {
  try {
    const database = getDb();
    const row = database.getFirstSync<HabitatRow>(
      'SELECT * FROM habitat_places WHERE id = ?',
      [id],
    );
    if (!row) { return null; }
    return {
      placeId: row.id,
      name: row.name,
      lat: row.lat,
      lng: row.lng,
      distanceMeters: 0,
      footprintAreaM2: row.footprint_area_m2 ?? undefined,
      website:         row.website ?? undefined,
      restaurantFoodType: normalizeCachedRestaurantFoodType(row.restaurant_food_type),
      storeSubtype:       normalizeCachedStoreSubtype(row.store_subtype),
    };
  } catch (err) {
    console.warn('[habitatCache] getHabitatPlaceById failed', err);
    return null;
  }
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

/**
 * A type with no OSM tag mapping (arbitrary custom-category Google Places
 * strings) can never produce an OSM-backed row, so it would never satisfy
 * the freshness check below and would stay "stale" — and get re-fetched —
 * forever. Filtering to mappable types up front is what makes staleTypes
 * capable of ever reaching empty for a custom-only request (KAN-238 review).
 */
function isOsmMappable(poiType: string): boolean {
  return poiType in POI_OSM_TAGS || poiType in SUPPLEMENTARY_OSM_TAGS;
}

/** Refetch cooldown for a (poiType, area) pair that came back with zero OSM
 * results last time — a mapped type can legitimately have nothing nearby
 * (e.g. no bus stop in this suburb); without this, a sparse area would hit
 * Overpass again on every single proximity tick indefinitely. */
const EMPTY_RESULT_RETRY_COOLDOWN_MS = 60 * 60 * 1_000; // 1 hour

/** ~5.5 km per cell at the equator — coarser than IDENTITY_MATCH_RADIUS_M on
 * purpose; this only throttles re-fetch attempts, not identity matching. */
const EMPTY_RESULT_GRID_CELL_DEG = 0.05;

/**
 * In-memory only (not persisted — resets on app restart, which just means
 * one extra retry, not a correctness issue). Keyed by poiType + coarse grid
 * cell; unbounded growth isn't a concern since the key space is naturally
 * capped by (POI types) × (cells the user actually visits).
 */
const _emptyResultAttempts = new Map<string, number>();

function emptyResultAttemptKey(poiType: string, lat: number, lng: number): string {
  const cellLat = Math.round(lat / EMPTY_RESULT_GRID_CELL_DEG);
  const cellLng = Math.round(lng / EMPTY_RESULT_GRID_CELL_DEG);
  return `${poiType}@${cellLat},${cellLng}`;
}

/** Test-only: clears the empty-result retry throttle between test cases. */
export function __resetEmptyResultAttemptsForTests(): void {
  _emptyResultAttempts.clear();
  _mallSweepAttempts.clear();
}

/** How long before another full mall sweep of the same area is allowed (see refreshMallsIfDue). */
const MALL_SWEEP_COOLDOWN_MS = 6 * 60 * 60 * 1_000; // 6 hours

/** Same in-memory, coarse-grid throttle as _emptyResultAttempts above. */
const _mallSweepAttempts = new Map<string, number>();

/**
 * Forces a `shopping_mall` re-fetch for this area, at most once per
 * MALL_SWEEP_COOLDOWN_MS (KAN-282 review).
 *
 * Why forced rather than a plain refreshHabitatCacheIfStale call: that
 * function treats a POI type as fresh if ANY row of it exists in the 5 km
 * box. One cached small gallery therefore marks `shopping_mall` fresh for
 * the whole area, so a plain call would no-op and a genuinely big mall that
 * was never cached could stay invisible for the full HABITAT_CACHE_STALE_MS
 * (14 days) — the exact "mall card never appears" failure this ticket
 * chased. Presence of *a* mall says nothing about whether we ever swept the
 * area for *all* of them, so the sweep needs its own cadence.
 *
 * Never throws; safe to call fire-and-forget.
 */
export async function refreshMallsIfDue(lat: number, lng: number): Promise<void> {
  const key = emptyResultAttemptKey('shopping_mall_sweep', lat, lng);
  const lastAttempt = _mallSweepAttempts.get(key);
  if (lastAttempt != null && Date.now() - lastAttempt < MALL_SWEEP_COOLDOWN_MS) { return; }
  _mallSweepAttempts.set(key, Date.now());

  await refreshHabitatCacheIfStale(lat, lng, ['shopping_mall'], true);
}

/**
 * Opportunistically refreshes the cache around `lat`/`lng` for `poiTypes`:
 * if online and the area has no OSM-fetched rows or any are older than
 * HABITAT_CACHE_STALE_MS, fetches fresh data from OSM and upserts it, then
 * enforces the size budget.
 *
 * Freshness is judged by `osm_fetched_at` specifically, not by any live
 * Google sighting — otherwise seeding Google results (which also touch a
 * row's last_matched_at, but never osm_fetched_at) could never itself mask a
 * genuinely stale OSM refresh.
 *
 * `force` (KAN-241, ContextChip's manual "Refresh now") skips both the
 * staleness check and the empty-result retry cooldown — a deliberate,
 * human-triggered tap shouldn't silently no-op just because the area was
 * already fresh or recently came back empty, unlike the opportunistic
 * background path this function otherwise serves.
 *
 * Fire-and-forget from the caller's perspective — never throws.
 */
export async function refreshHabitatCacheIfStale(
  lat: number,
  lng: number,
  poiTypes: string[],
  force = false,
): Promise<void> {
  const mappableTypes = poiTypes.filter(isOsmMappable);
  if (mappableTypes.length === 0) { return; }

  try {
    let isConnected: boolean | null = null;
    try { isConnected = (await NetInfo.fetch()).isConnected; } catch { /* treat as unknown */ }
    if (isConnected === false) { return; }

    const now = Date.now();
    let typesToFetch: string[];
    if (force) {
      typesToFetch = mappableTypes;
    } else {
      const database = getDb();
      const box = boundingBoxDeg(lat, lng, HABITAT_RADIUS_M);
      const placeholders = mappableTypes.map(() => '?').join(',');
      const staleCutoff = now - HABITAT_CACHE_STALE_MS;

      const freshRows = database.getAllSync<{ poi_type: string }>(
        `SELECT poi_type FROM habitat_places
         WHERE poi_type IN (${placeholders})
           AND lat BETWEEN ? AND ?
           AND lng BETWEEN ? AND ?
           AND osm_id IS NOT NULL
           AND osm_fetched_at >= ?`,
        [...mappableTypes, box.latMin, box.latMax, box.lngMin, box.lngMax, staleCutoff],
      );
      const freshTypes = new Set(freshRows.map(r => r.poi_type));
      const staleTypes = mappableTypes.filter(t => !freshTypes.has(t));
      if (staleTypes.length === 0) { return; }

      typesToFetch = staleTypes.filter(t => {
        const lastAttempt = _emptyResultAttempts.get(emptyResultAttemptKey(t, lat, lng));
        return lastAttempt == null || now - lastAttempt >= EMPTY_RESULT_RETRY_COOLDOWN_MS;
      });
      if (typesToFetch.length === 0) { return; }
    }

    const osmResults = await searchOsmPlaces(lat, lng, typesToFetch, HABITAT_RADIUS_M);
    let didUpsert = false;
    for (const poiType of typesToFetch) {
      const places = osmResults[poiType] ?? [];
      if (places.length === 0) {
        _emptyResultAttempts.set(emptyResultAttemptKey(poiType, lat, lng), now);
        continue;
      }
      for (const place of places) {
        upsertPlace({
          poiType,
          name:            place.name,
          isGenericName:   place.isGenericName,
          lat:             place.lat,
          lng:             place.lng,
          source:          { osm: place.osmId },
          footprintAreaM2: place.footprintAreaM2,
          website:         place.website,
        });
        didUpsert = true;
      }
    }

    // Skip the full-table COUNT(*) when nothing was actually written.
    if (didUpsert) { enforceSizeBudget(); }
  } catch (err) {
    console.warn('[habitatCache] refreshHabitatCacheIfStale failed', err);
  }
}

/**
 * True if the cache has any row at all, anywhere — a cheap, position-free
 * check used to tell "nothing cached yet" (fresh install/new phone) apart
 * from "nothing cached near here" (KAN-236's offline-messaging states).
 *
 * Never throws — a DB failure returns false (the more cautious of the two
 * states to assume).
 */
export function hasCachedPlaces(): boolean {
  try {
    const rows = getDb().getAllSync<{ one: number }>('SELECT 1 as one FROM habitat_places LIMIT 1');
    return rows.length > 0;
  } catch (err) {
    console.warn('[habitatCache] hasCachedPlaces failed', err);
    return false;
  }
}

/**
 * True if the cache holds any place within `radiusMeters` of `lat`/`lng` — the
 * "nothing cached near here" half of the distinction hasCachedPlaces() above
 * can't make (KAN-316).
 *
 * Type-blind on purpose: this answers "is there cached ground where you're
 * standing", not "can I solve one of your tasks here". A place of any type
 * within reach means we learned this area while we had a connection.
 *
 * Never throws — a DB failure returns false (the cautious answer: claim
 * nothing).
 */
export function hasCachedPlacesNear(
  lat: number,
  lng: number,
  radiusMeters: number = HABITAT_RADIUS_M,
): boolean {
  try {
    const box = boundingBoxDeg(lat, lng, radiusMeters);
    const rows = getDb().getAllSync<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM habitat_places
       WHERE lat BETWEEN ? AND ?
         AND lng BETWEEN ? AND ?`,
      [box.latMin, box.latMax, box.lngMin, box.lngMax],
    );
    // The bounding box is a square around a circle, so the corners still need
    // the real distance check before we claim anything.
    return rows.some(row => getDistanceMeters(lat, lng, row.lat, row.lng) <= radiusMeters);
  } catch (err) {
    console.warn('[habitatCache] hasCachedPlacesNear failed', err);
    return false;
  }
}

/**
 * Epoch ms of the most recent sighting anywhere in the ambient habitat pool
 * (`cache_area_id IS NULL` — excludes trip areas, which have their own
 * separate lifecycle), or null if the cache is empty. Powers ContextChip's
 * "learned {date}" line (KAN-241).
 */
export function getMostRecentHabitatUpdateAt(): number | null {
  try {
    const [{ maxTs } = { maxTs: null }] = getDb().getAllSync<{ maxTs: number | null }>(
      'SELECT MAX(last_matched_at) as maxTs FROM habitat_places WHERE cache_area_id IS NULL',
    );
    return maxTs ?? null;
  } catch (err) {
    console.warn('[habitatCache] getMostRecentHabitatUpdateAt failed', err);
    return null;
  }
}

// ─── Size budget ──────────────────────────────────────────────────────────────

/**
 * Deletes the oldest (by last_matched_at) rows beyond MAX_CACHED_PLACES —
 * scoped to `cache_area_id IS NULL` (the ordinary opportunistic habitat
 * pool) only. KAN-234 trip rows are deliberately exempt from LRU eviction:
 * they have their own explicit expiry contract (deleteExpiredTripPlaces),
 * so a burst of opportunistic caching elsewhere could otherwise silently
 * evict an unexpired trip's coverage mid-trip with no user-facing signal —
 * breaking the "I'll know it until <date>" promise.
 *
 * `shopping_mall` rows are held out of that pool (KAN-282) and trimmed under
 * their own MAX_CACHED_MALLS budget instead, because both halves of ordinary
 * LRU are wrong for them:
 *
 *   - As a BUDGET: `last_matched_at` is bumped by proximity's ordinary live
 *     searches, which cover the user's TASK POI types (pharmacy, cafe, ...)
 *     and never shopping_mall. Mall rows are therefore never re-matched,
 *     always sort oldest, and were evicted first every time the pool crossed
 *     the cap — the mall card worked once, then silently lost all its data.
 *   - As an ORDER: for the same reason, `last_matched_at` says nothing about
 *     a mall's usefulness. Malls are trimmed by `osm_fetched_at` instead —
 *     oldest DATA first, which is the only age that means anything here.
 *
 * Trip rows stay exempt from both budgets (see above).
 */
export function enforceSizeBudget(): void {
  try {
    const database = getDb();

    const [{ count } = { count: 0 }] = database.getAllSync<{ count: number }>(
      "SELECT COUNT(*) as count FROM habitat_places WHERE cache_area_id IS NULL AND poi_type != 'shopping_mall'",
    );
    if (count > MAX_CACHED_PLACES) {
      database.runSync(
        `DELETE FROM habitat_places WHERE id IN (
           SELECT id FROM habitat_places
            WHERE cache_area_id IS NULL AND poi_type != 'shopping_mall'
            ORDER BY last_matched_at ASC LIMIT ?
         )`,
        [count - MAX_CACHED_PLACES],
      );
    }

    const [{ count: mallCount } = { count: 0 }] = database.getAllSync<{ count: number }>(
      "SELECT COUNT(*) as count FROM habitat_places WHERE cache_area_id IS NULL AND poi_type = 'shopping_mall'",
    );
    if (mallCount > MAX_CACHED_MALLS) {
      database.runSync(
        `DELETE FROM habitat_places WHERE id IN (
           SELECT id FROM habitat_places
            WHERE cache_area_id IS NULL AND poi_type = 'shopping_mall'
            ORDER BY osm_fetched_at ASC LIMIT ?
         )`,
        [mallCount - MAX_CACHED_MALLS],
      );
    }
  } catch (err) {
    console.warn('[habitatCache] enforceSizeBudget failed', err);
  }
}

// ─── Trip areas (KAN-234) ─────────────────────────────────────────────────────

/** Rough per-row on-device storage cost (SQLite row + index overhead) — illustrative, not measured. Shared by estimateHabitatAreaSizeBytes below and tripDownload.ts's pre-download size estimate. */
export const HABITAT_BYTES_PER_ROW = 200;

/** Deletes every row tagged with cacheAreaId. Used when a trip is deleted. */
export function deleteTripAreaPlaces(cacheAreaId: string): void {
  try {
    getDb().runSync('DELETE FROM habitat_places WHERE cache_area_id = ?', [cacheAreaId]);
  } catch (err) {
    console.warn('[habitatCache] deleteTripAreaPlaces failed', err);
  }
}

/** Deletes any row (trip or not) whose expires_at has passed. Ordinary habitat rows have expires_at IS NULL and are never touched here — run once per boot alongside the trip pre-refresh check. */
export function deleteExpiredTripPlaces(): void {
  try {
    getDb().runSync(
      'DELETE FROM habitat_places WHERE expires_at IS NOT NULL AND expires_at < ?',
      [Date.now()],
    );
  } catch (err) {
    console.warn('[habitatCache] deleteExpiredTripPlaces failed', err);
  }
}

/** Rough size estimate for the always-on habitat area (cache_area_id IS NULL rows only) — shown in the "Places I Know" list. */
export function estimateHabitatAreaSizeBytes(): number {
  try {
    const [{ count } = { count: 0 }] = getDb().getAllSync<{ count: number }>(
      'SELECT COUNT(*) as count FROM habitat_places WHERE cache_area_id IS NULL',
    );
    return count * HABITAT_BYTES_PER_ROW;
  } catch (err) {
    console.warn('[habitatCache] estimateHabitatAreaSizeBytes failed', err);
    return 0;
  }
}
