/**
 * KAN-228 — habitatCache: SQLite-backed offline POI cache + cross-source
 * place identity resolution.
 *
 * expo-sqlite has no official Jest mock, so this file uses a small in-memory
 * mock DB that recognizes the exact queries habitatCache.ts issues (a full
 * SQL engine would be overkill for one module's fixed query set).
 *
 * Covers:
 *   - upsertPlace inserts a new row for OSM-sourced candidates only — a
 *     Google-only candidate with no existing match is never persisted with
 *     coordinates (Places ToS: no long-term Google coordinate caching)
 *   - upsertPlace merges into an existing row when proximity + type + name
 *     match, in both directions (Google-first-then-OSM and vice versa) —
 *     the ticket's key cross-source-identity AC
 *   - generic (nameless-fallback) OSM names only merge on an exact match,
 *     never via substring — a real name must not collide with a generic one
 *   - queryHabitatCache returns NearbyPlace-shaped results within radius,
 *     sorted by distance, capped at 50 per type unless a caller opts out
 *   - refreshHabitatCacheIfStale only fetches OSM for stale/missing types
 *     (judged by osm_fetched_at, not touched by Google-only seeding), and
 *     skips entirely when offline
 *   - enforceSizeBudget evicts the oldest (by last_matched_at) rows beyond
 *     the cap
 *   - findExistingPlaceId (KAN-229) is a read-only counterpart to upsertPlace:
 *     returns an already-established match's id, or null (never inserts, and
 *     never invents an id for an unmatched place)
 *   - every exported function degrades to a safe default (never throws)
 *     when the underlying DB call itself throws
 *   - refreshHabitatCacheIfStale (KAN-238 review) pre-filters to OSM-mappable
 *     types before deciding what's stale — a custom-category string with no
 *     POI_OSM_TAGS mapping can never produce a row, so it must never keep
 *     "staleTypes" non-empty forever; a mapped type that legitimately
 *     returns zero OSM results is throttled per (type, coarse area) instead
 *     of re-hitting Overpass on every single proximity tick; and
 *     enforceSizeBudget's full-table COUNT(*) is skipped when nothing was
 *     actually upserted
 *   - upsertTripPlace (KAN-234) stamps cache_area_id/expires_at: tags an
 *     untagged row on merge, never overwrites an existing trip's tag (first
 *     trip wins), but extends expires_at to the max of old/new; a plain
 *     upsertPlace call never touches an existing trip row's tag/expiry
 *   - enforceSizeBudget only counts/evicts within the cache_area_id IS NULL
 *     pool — a trip row survives LRU pressure regardless of last_matched_at
 *   - deleteTripAreaPlaces / deleteExpiredTripPlaces / estimateHabitatAreaSizeBytes
 *     scope correctly to cache_area_id / expires_at
 */

interface MockHabitatRow {
  id: string;
  poi_type: string;
  name: string;
  is_generic_name: number;
  lat: number;
  lng: number;
  google_place_id: string | null;
  osm_id: string | null;
  osm_fetched_at: number;
  last_matched_at: number;
  cache_area_id: string | null;
  expires_at: number | null;
  /** KAN-282 — OSM building-footprint area; null when unknown (see habitatCache). */
  footprint_area_m2?: number | null;
  /** KAN-293 — the place's own site from OSM's `website` tag; null when it has none. */
  website?: string | null;
  /** KAN-317 — restaurant subtype metadata persisted in the local cache. */
  restaurant_food_type?: string | null;
  /** KAN-317 — store subtype metadata persisted in the local cache. */
  store_subtype?: string | null;
}

// ─── In-memory expo-sqlite mock ────────────────────────────────────────────────

let rows: MockHabitatRow[] = [];

function matchesBox(row: MockHabitatRow, latMin: number, latMax: number, lngMin: number, lngMax: number): boolean {
  return row.lat >= latMin && row.lat <= latMax && row.lng >= lngMin && row.lng <= lngMax;
}

const mockDb = {
  execSync: jest.fn(),
  getAllSync: jest.fn(<T>(sql: string, params: unknown[] = []): T[] => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('PRAGMA table_info(habitat_places)')) {
      return [
        { name: 'id' }, { name: 'poi_type' }, { name: 'name' }, { name: 'is_generic_name' },
        { name: 'lat' }, { name: 'lng' }, { name: 'google_place_id' }, { name: 'osm_id' },
        { name: 'osm_fetched_at' }, { name: 'last_matched_at' }, { name: 'cache_area_id' }, { name: 'expires_at' },
        { name: 'footprint_area_m2' }, { name: 'website' }, { name: 'restaurant_food_type' }, { name: 'store_subtype' },
      ] as unknown as T[];
    }
    if (s.startsWith('SELECT MAX(last_matched_at) as maxTs FROM habitat_places WHERE cache_area_id IS NULL')) {
      const untagged = rows.filter(r => r.cache_area_id == null);
      const maxTs = untagged.length > 0 ? Math.max(...untagged.map(r => r.last_matched_at)) : null;
      return [{ maxTs }] as unknown as T[];
    }
    if (s.startsWith('SELECT COUNT(*) as count FROM habitat_places WHERE cache_area_id IS NULL')) {
      // KAN-282 — two budgets are counted separately: the ordinary pool
      // (malls excluded) and the malls' own.
      const mallsOnly = s.includes("poi_type = 'shopping_mall'");
      const excludesMalls = s.includes("poi_type != 'shopping_mall'");
      return [{
        count: rows.filter(r =>
          r.cache_area_id == null
          && (mallsOnly ? r.poi_type === 'shopping_mall' : true)
          && !(excludesMalls && r.poi_type === 'shopping_mall'),
        ).length,
      }] as unknown as T[];
    }
    if (s.startsWith('SELECT COUNT(*)')) {
      return [{ count: rows.length }] as unknown as T[];
    }
    if (s.startsWith('SELECT 1 as one FROM habitat_places')) {
      return (rows.length > 0 ? [{ one: 1 }] : []) as unknown as T[];
    }
    if (s.startsWith('SELECT poi_type FROM habitat_places WHERE poi_type IN')) {
      const inCount = (s.match(/\?/g) ?? []).length - 5; // poiTypes + 4 box bounds + 1 cutoff
      const poiTypes = params.slice(0, inCount) as string[];
      const [latMin, latMax, lngMin, lngMax, cutoff] = params.slice(inCount) as number[];
      return rows.filter(r =>
        poiTypes.includes(r.poi_type) && matchesBox(r, latMin, latMax, lngMin, lngMax)
        && r.osm_id != null && r.osm_fetched_at >= cutoff,
      ) as unknown as T[];
    }
    if (s.startsWith('SELECT * FROM habitat_places WHERE poi_type IN')) {
      const inCount = (s.match(/\?/g) ?? []).length - 4;
      const poiTypes = params.slice(0, inCount) as string[];
      const [latMin, latMax, lngMin, lngMax] = params.slice(inCount) as number[];
      return rows.filter(r => poiTypes.includes(r.poi_type) && matchesBox(r, latMin, latMax, lngMin, lngMax)) as unknown as T[];
    }
    if (s.startsWith('SELECT * FROM habitat_places WHERE poi_type = ?')) {
      const [poiType, latMin, latMax, lngMin, lngMax] = params as [string, number, number, number, number];
      return rows.filter(r => r.poi_type === poiType && matchesBox(r, latMin, latMax, lngMin, lngMax)) as unknown as T[];
    }
    throw new Error(`mockDb.getAllSync: unrecognized query: ${s}`);
  }),
  getFirstSync: jest.fn(<T>(sql: string, params: unknown[] = []): T | null => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM habitat_places WHERE id = ?')) {
      const [id] = params as [string];
      return (rows.find(r => r.id === id) ?? null) as T | null;
    }
    throw new Error(`mockDb.getFirstSync: unrecognized query: ${s}`);
  }),
  runSync: jest.fn((sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('INSERT INTO habitat_places')) {
      const [id, poi_type, name, is_generic_name, lat, lng, google_place_id, osm_id, osm_fetched_at, last_matched_at, cache_area_id, expires_at, footprint_area_m2, website, restaurant_food_type, store_subtype] =
        params as [string, string, string, number, number, number, string | null, string | null, number, number, string | null, number | null, number | null, string | null, string | null, string | null];
      rows.push({ id, poi_type, name, is_generic_name, lat, lng, google_place_id, osm_id, osm_fetched_at, last_matched_at, cache_area_id, expires_at, footprint_area_m2, website, restaurant_food_type, store_subtype });
      return {} as any;
    }
    if (s.startsWith('UPDATE habitat_places')) {
      const [
        google, osm, osmFlag1, lat, osmFlag2, lng, osmFlag3, osmFetchedAt,
        footprintAreaM2, website,
        restaurantFoodType, storeSubtype,
        tripCacheAreaId, tripExpiresAtA, tripExpiresAtB, tripExpiresAtC,
        lastMatchedAt, id,
      ] = params as [
        string | null, string | null, number, number, number, number, number, number,
        number | null, string | null,
        string | null, string | null,
        string | null, number | null, number | null, number | null,
        number, string,
      ];
      const row = rows.find(r => r.id === id);
      if (row) {
        row.google_place_id = row.google_place_id ?? google;
        row.osm_id = row.osm_id ?? osm;
        if (osmFlag1 === 1) { row.lat = lat; }
        if (osmFlag2 === 1) { row.lng = lng; }
        if (osmFlag3 === 1) { row.osm_fetched_at = osmFetchedAt; }
        // COALESCE(?, footprint_area_m2) — a known area fills an unknown one,
        // and a row that already has one is never downgraded to NULL.
        row.footprint_area_m2 = footprintAreaM2 ?? row.footprint_area_m2 ?? null;
        // COALESCE(?, website) — same shape: a discovered site fills an
        // unknown one, and a row that already has one is never cleared.
        row.website = website ?? row.website ?? null;
        row.restaurant_food_type = restaurantFoodType ?? row.restaurant_food_type ?? null;
        row.store_subtype = storeSubtype ?? row.store_subtype ?? null;
        row.cache_area_id = row.cache_area_id ?? tripCacheAreaId;
        if (tripExpiresAtA != null) {
          row.expires_at = row.expires_at == null ? tripExpiresAtB : Math.max(row.expires_at, tripExpiresAtC!);
        }
        row.last_matched_at = lastMatchedAt;
      }
      return {} as any;
    }
    if (s.startsWith('DELETE FROM habitat_places WHERE id IN')) {
      const [limit] = params as [number];
      // KAN-282 — two distinct eviction passes: the ordinary pool (malls
      // excluded, ordered by last_matched_at) and the malls' own budget
      // (malls only, ordered by osm_fetched_at — oldest DATA first).
      const mallsOnly = s.includes("poi_type = 'shopping_mall'");
      const excludesMalls = s.includes("poi_type != 'shopping_mall'");
      const pool = rows.filter(r =>
        r.cache_area_id == null
        && (mallsOnly ? r.poi_type === 'shopping_mall' : true)
        && !(excludesMalls && r.poi_type === 'shopping_mall'),
      );
      const oldestFirst = mallsOnly
        ? [...pool].sort((a, b) => a.osm_fetched_at - b.osm_fetched_at)
        : [...pool].sort((a, b) => a.last_matched_at - b.last_matched_at);
      const toDelete = new Set(oldestFirst.slice(0, limit).map(r => r.id));
      rows = rows.filter(r => !toDelete.has(r.id));
      return {} as any;
    }
    if (s.startsWith('DELETE FROM habitat_places WHERE cache_area_id = ?')) {
      const [cacheAreaId] = params as [string];
      rows = rows.filter(r => r.cache_area_id !== cacheAreaId);
      return {} as any;
    }
    if (s.startsWith('DELETE FROM habitat_places WHERE expires_at IS NOT NULL AND expires_at < ?')) {
      const [now] = params as [number];
      rows = rows.filter(r => !(r.expires_at != null && r.expires_at < now));
      return {} as any;
    }
    throw new Error(`mockDb.runSync: unrecognized query: ${s}`);
  }),
  // Mirrors expo-sqlite's real BEGIN/task/COMMIT-or-ROLLBACK+rethrow behavior
  // closely enough for tests: snapshot `rows` first, restore it if task()
  // throws, so a mid-batch failure genuinely undoes earlier deletes/inserts.
  withTransactionSync: jest.fn((task: () => void) => {
    const snapshot = rows.map(r => ({ ...r }));
    try {
      task();
    } catch (err) {
      rows = snapshot;
      throw err;
    }
  }),
};

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn(() => mockDb),
}));

const mockSearchOsmPlaces = jest.fn();
jest.mock('../../src/services/osmPlaces', () => ({
  searchOsmPlaces: (...args: unknown[]) => mockSearchOsmPlaces(...args),
}));

const mockNetInfoFetch = jest.fn();
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { fetch: (...args: unknown[]) => mockNetInfoFetch(...args) },
}));

// habitatCache imports maps.ts (for getDistanceMeters), which transitively
// pulls in placesFunctions -> @react-native-firebase/functions, a native
// module unavailable under Jest. Mock ONLY that native boundary, so maps.ts
// still contributes its real haversine — the identity-match radius and
// bounding-box assertions below depend on exact distance behaviour.
jest.mock('../../src/services/placesFunctions', () => ({
  searchNearbyPlacesProxy: jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  getPlaceDetailsProxy:    jest.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  upsertPlace,
  upsertTripPlace,
  queryHabitatCache,
  refreshHabitatCacheIfStale,
  enforceSizeBudget,
  refreshMallsIfDue,
  findExistingPlaceId,
  getHabitatPlaceById,
  hasCachedPlaces,
  getMostRecentHabitatUpdateAt,
  deleteTripAreaPlaces,
  deleteExpiredTripPlaces,
  writeTripAreaPlaces,
  estimateHabitatAreaSizeBytes,
  __resetHabitatDbForTests,
  __resetEmptyResultAttemptsForTests,
  MAX_CACHED_PLACES,
  MAX_CACHED_MALLS,
  HABITAT_CACHE_STALE_MS,
  HABITAT_BYTES_PER_ROW,
} from '../../src/services/habitatCache';

const ORIGIN = { lat: 0, lng: 0 };

beforeEach(() => {
  rows = [];
  jest.clearAllMocks();
  __resetHabitatDbForTests();
  __resetEmptyResultAttemptsForTests();
  mockNetInfoFetch.mockResolvedValue({ isConnected: true });
});

describe('migration (KAN-234 review fix — schema check instead of blanket catch)', () => {
  it('does not run ALTER TABLE when the columns already exist', () => {
    upsertPlace({ poiType: 'pharmacy', name: 'Corner Pharmacy', lat: 0, lng: 0, source: { osm: 'node/1' } });

    const alterCalls = mockDb.execSync.mock.calls.filter(([sql]) => String(sql).includes('ALTER TABLE'));
    expect(alterCalls).toHaveLength(0);
  });

  // KAN-282 — the footprint backfill runs on EVERY open, not only when the
  // column is first added: a device that already ran the build which added
  // the column still has NULL-area mall rows to repair. Forcing them stale
  // is what makes the next refresh re-fetch them WITH geometry.
  it('marks mall rows with an unknown footprint as stale, so they get re-fetched', () => {
    upsertPlace({ poiType: 'pharmacy', name: 'Corner Pharmacy', lat: 0, lng: 0, source: { osm: 'node/1' } });

    const backfill = mockDb.runSync.mock.calls.find(([sql]) =>
      String(sql).includes('SET osm_fetched_at = 0') && String(sql).includes("poi_type = 'shopping_mall'"),
    );

    expect(backfill).toBeDefined();
    expect(String(backfill![0])).toContain('footprint_area_m2 IS NULL');
  });

  it('runs ALTER TABLE only for columns missing from the real schema', () => {
    mockDb.getAllSync.mockImplementationOnce(() => [
      { name: 'id' }, { name: 'poi_type' }, { name: 'name' }, { name: 'is_generic_name' },
      { name: 'lat' }, { name: 'lng' }, { name: 'google_place_id' }, { name: 'osm_id' },
      { name: 'osm_fetched_at' }, { name: 'last_matched_at' },
      // cache_area_id / expires_at intentionally omitted — simulates a pre-KAN-234 on-device DB.
    ]);

    upsertPlace({ poiType: 'pharmacy', name: 'Corner Pharmacy', lat: 0, lng: 0, source: { osm: 'node/1' } });

    const alterCalls = mockDb.execSync.mock.calls.map(([sql]) => String(sql));
    expect(alterCalls.some(sql => sql.includes('ADD COLUMN cache_area_id'))).toBe(true);
    expect(alterCalls.some(sql => sql.includes('ADD COLUMN expires_at'))).toBe(true);
  });

  it('surfaces a genuine migration failure via a warning instead of silently swallowing it', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDb.getAllSync.mockImplementationOnce(() => []); // schema check reports nothing — both columns "missing"
    mockDb.execSync
      .mockImplementationOnce(() => {}) // CREATE TABLE ... ; CREATE INDEX ...
      .mockImplementationOnce(() => { throw new Error('disk full'); }); // ALTER TABLE cache_area_id — a real failure, not "column already exists"

    // upsertPlace's own outer try/catch keeps the module's existing
    // "never throws to callers" contract — but the migration failure must
    // now be logged (not silently discarded the way a blanket catch would).
    upsertPlace({ poiType: 'pharmacy', name: 'Corner Pharmacy', lat: 0, lng: 0, source: { osm: 'node/1' } });

    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] upsertPlace failed', expect.objectContaining({ message: 'disk full' }));
    warnSpy.mockRestore();
  });

  it('retries the migration on the next call instead of reusing a stuck db state after a failed migration', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // First call: schema check reports both columns missing, ALTER TABLE throws.
    mockDb.getAllSync.mockImplementationOnce(() => []);
    mockDb.execSync
      .mockImplementationOnce(() => {}) // CREATE TABLE ... ; CREATE INDEX ...
      .mockImplementationOnce(() => { throw new Error('disk full'); }); // ALTER TABLE cache_area_id

    upsertPlace({ poiType: 'pharmacy', name: 'First', lat: 0, lng: 0, source: { osm: 'node/1' } });
    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] upsertPlace failed', expect.objectContaining({ message: 'disk full' }));
    warnSpy.mockClear();

    // Second call: schema check again reports both columns missing (the
    // migration never committed) — this time everything succeeds. If `db`
    // had been wedged non-null after the first failure, this ALTER TABLE
    // would never even run.
    mockDb.getAllSync.mockImplementationOnce(() => []);

    upsertPlace({ poiType: 'cafe', name: 'Second', lat: 0, lng: 0, source: { osm: 'node/2' } });

    expect(warnSpy).not.toHaveBeenCalled();
    const alterCalls = mockDb.execSync.mock.calls.map(([sql]) => String(sql));
    expect(alterCalls.filter(sql => sql.includes('ADD COLUMN cache_area_id'))).toHaveLength(2);
    expect(rows.some(r => r.name === 'Second')).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('upsertPlace', () => {
  it('inserts a new row for an OSM-sourced candidate when no existing place matches', () => {
    const id = upsertPlace({
      poiType: 'pharmacy',
      name:    'Corner Pharmacy',
      lat:     0,
      lng:     0,
      source:  { osm: 'node/1' },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].osm_id).toBe('node/1');
    expect(rows[0].google_place_id).toBeNull();
  });

  it('does NOT persist a Google-only candidate with no existing match (never caches Google coordinates long-term)', () => {
    const id = upsertPlace({
      poiType: 'pharmacy',
      name:    'Corner Pharmacy',
      lat:     0,
      lng:     0,
      source:  { google: 'g-1' },
    });

    expect(rows).toHaveLength(0);
    expect(id).toMatch(/^hp_/); // still returns a usable (but unpersisted) id
  });

  it('merges a later OSM sighting into the same internal id as an earlier Google sighting', () => {
    // Seed an OSM-anchored row first (a Google-only candidate alone would
    // not persist — see the test above).
    const osmSeedId = upsertPlace({
      poiType: 'pharmacy', name: 'Corner Pharmacy', lat: 0, lng: 0, source: { osm: 'node/seed' },
    });

    const googleId = upsertPlace({
      poiType: 'pharmacy',
      name:    'Corner Pharmacy',
      lat:     0.0001,
      lng:     0,
      source:  { google: 'g-1' },
    });

    expect(googleId).toBe(osmSeedId);
    expect(rows).toHaveLength(1);
    expect(rows[0].google_place_id).toBe('g-1');
  });

  it('merges a later Google sighting into the same internal id as an earlier OSM sighting, without moving its coordinates', () => {
    const osmId = upsertPlace({
      poiType: 'cafe',
      name:    'Nice Café',
      lat:     0,
      lng:     0,
      source:  { osm: 'node/42' },
    });

    const googleId = upsertPlace({
      poiType: 'cafe',
      name:    'Nice Cafe', // accent-insensitive match via normalize()
      lat:     0.0001,       // a different coordinate than the OSM row
      lng:     0.0001,
      source:  { google: 'g-2' },
    });

    expect(googleId).toBe(osmId);
    expect(rows).toHaveLength(1);
    expect(rows[0].google_place_id).toBe('g-2');
    expect(rows[0].osm_id).toBe('node/42');
    // Coordinates stay OSM-anchored — the Google sighting's lat/lng never wins.
    expect(rows[0].lat).toBe(0);
    expect(rows[0].lng).toBe(0);
  });

  it('does not merge places of a different POI type at the same location', () => {
    const id1 = upsertPlace({ poiType: 'cafe', name: 'Spot', lat: 0, lng: 0, source: { osm: 'node/1' } });
    const id2 = upsertPlace({ poiType: 'bank', name: 'Spot', lat: 0, lng: 0, source: { osm: 'node/2' } });

    expect(id1).not.toBe(id2);
    expect(rows).toHaveLength(2);
  });

  it('does not merge places beyond the identity match radius', () => {
    const id1 = upsertPlace({ poiType: 'atm', name: 'Same Name', lat: 0, lng: 0, source: { osm: 'node/1' } });
    // ~1km away — well beyond the ~150m identity match radius.
    const id2 = upsertPlace({ poiType: 'atm', name: 'Same Name', lat: 0.009, lng: 0, source: { osm: 'node/2' } });

    expect(id1).not.toBe(id2);
    expect(rows).toHaveLength(2);
  });

  describe('generic (nameless-fallback) name matching', () => {
    it('does not merge a real name into a nearby generic-named row (substring collision guard)', () => {
      // "pharmacy" (generic OSM fallback) is trivially a substring of almost
      // every real pharmacy name — that must not cause a false merge.
      const genericId = upsertPlace({
        poiType: 'pharmacy', name: 'pharmacy', isGenericName: true, lat: 0, lng: 0, source: { osm: 'node/1' },
      });
      const namedId = upsertPlace({
        poiType: 'pharmacy', name: 'Corner Pharmacy', lat: 0.0001, lng: 0, source: { osm: 'node/2' },
      });

      expect(namedId).not.toBe(genericId);
      expect(rows).toHaveLength(2);
    });

    it('still merges the exact same generic name at the same place (re-fetch of the same unnamed OSM node)', () => {
      const firstId = upsertPlace({
        poiType: 'atm', name: 'atm', isGenericName: true, lat: 0, lng: 0, source: { osm: 'node/1' },
      });
      const secondId = upsertPlace({
        poiType: 'atm', name: 'atm', isGenericName: true, lat: 0.0001, lng: 0, source: { osm: 'node/1' },
      });

      expect(secondId).toBe(firstId);
      expect(rows).toHaveLength(1);
    });
  });

  it('returns a fresh id and logs a warning instead of throwing when the DB read fails', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDb.getAllSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    const id = upsertPlace({ poiType: 'atm', name: 'Test', lat: 0, lng: 0, source: { osm: 'node/1' } });

    expect(id).toMatch(/^hp_/);
    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] upsertPlace failed', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('findExistingPlaceId (KAN-229)', () => {
  it('returns the internal id of an already-established cross-source match', () => {
    const id = upsertPlace({ poiType: 'atm', name: 'Corner ATM', lat: 0, lng: 0, source: { osm: 'node/1' } });

    const found = findExistingPlaceId('atm', 'Corner ATM', 0.0001, 0);

    expect(found).toBe(id);
  });

  it('returns null when the place has no cache counterpart yet — never invents an id', () => {
    const found = findExistingPlaceId('atm', 'Some New Place', 0, 0);
    expect(found).toBeNull();
  });

  it('is read-only — never inserts or updates a row', () => {
    findExistingPlaceId('atm', 'Some New Place', 0, 0);
    expect(rows).toHaveLength(0);
    // Ignore the one-time footprint backfill that fires when the DB is first
    // opened (covered by its own migration test) — what matters here is that
    // findExistingPlaceId contributes no write of its own.
    const writes = mockDb.runSync.mock.calls.filter(([sql]) => !String(sql).includes('SET osm_fetched_at = 0'));
    expect(writes).toHaveLength(0);
  });

  it('returns null and logs a warning instead of throwing when the DB read fails', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDb.getAllSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    const found = findExistingPlaceId('atm', 'Corner ATM', 0, 0);

    expect(found).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] findExistingPlaceId failed', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('getHabitatPlaceById', () => {
  it('returns persisted footprint, website, and validated subtype fields', () => {
    const id = upsertPlace({
      poiType: 'restaurant',
      name: 'Yakuza by Olivier',
      lat: 0,
      lng: 0,
      source: { osm: 'way/restaurant' },
      footprintAreaM2: 1234,
      website: 'https://example.com',
    });

    expect(getHabitatPlaceById(id)).toEqual(expect.objectContaining({
      placeId: id,
      footprintAreaM2: 1234,
      website: 'https://example.com',
      restaurantFoodType: 'sushi',
    }));
  });
});

describe('queryHabitatCache', () => {
  it('returns NearbyPlace-shaped results within radius, sorted by distance', () => {
    upsertPlace({ poiType: 'atm', name: 'Near ATM', lat: 0.0003, lng: 0, source: { osm: 'node/1' } }); // ~33m
    upsertPlace({ poiType: 'atm', name: 'Far ATM', lat: 0.002, lng: 0, source: { osm: 'node/2' } }); // ~222m
    upsertPlace({ poiType: 'atm', name: 'Way Far ATM', lat: 0.1, lng: 0, source: { osm: 'node/3' } }); // ~11km

    const result = queryHabitatCache(ORIGIN.lat, ORIGIN.lng, ['atm'], 500);

    expect(result.atm).toHaveLength(2);
    expect(result.atm[0].name).toBe('Near ATM');
    expect(result.atm[1].name).toBe('Far ATM');
    expect(result.atm[0].distanceMeters).toBeLessThan(result.atm[1].distanceMeters);
    // placeId is the internal id, not a raw source id.
    expect(result.atm[0].placeId).toMatch(/^hp_/);
  });

  it('returns stored restaurant and store subtype metadata with cached places', () => {
    upsertPlace({ poiType: 'restaurant', name: 'Yakuza by Olivier', lat: 0.0003, lng: 0, source: { osm: 'node/restaurant' } });
    upsertPlace({ poiType: 'store', name: 'Zara', lat: 0.0004, lng: 0, source: { osm: 'node/store' } });

    const result = queryHabitatCache(ORIGIN.lat, ORIGIN.lng, ['restaurant', 'store'], 500);

    expect(rows.find(r => r.name === 'Yakuza by Olivier')?.restaurant_food_type).toBe('sushi');
    expect(rows.find(r => r.name === 'Zara')?.store_subtype).toBe('clothing');
    expect(result.restaurant[0]).toEqual(expect.objectContaining({ restaurantFoodType: 'sushi' }));
    expect(result.store[0]).toEqual(expect.objectContaining({ storeSubtype: 'clothing' }));
  });

  it('drops stale cached subtype keys at the read boundary', () => {
    upsertPlace({ poiType: 'restaurant', name: 'Yakuza by Olivier', lat: 0.0003, lng: 0, source: { osm: 'node/restaurant' } });
    rows[0].restaurant_food_type = 'not_real';

    const result = queryHabitatCache(ORIGIN.lat, ORIGIN.lng, ['restaurant'], 500);

    expect(result.restaurant[0].restaurantFoodType).toBeUndefined();
  });

  it('fills subtype metadata when a later sighting merges into an old row', () => {
    const id = upsertPlace({ poiType: 'store', name: 'Zara', lat: 0, lng: 0, source: { osm: 'node/old' } });
    rows[0].store_subtype = null; // Simulates a row created before KAN-317.

    const mergedId = upsertPlace({ poiType: 'store', name: 'Zara', lat: 0.0001, lng: 0, source: { google: 'g-zara' } });

    expect(mergedId).toBe(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].store_subtype).toBe('clothing');
  });

  // KAN-282 raised the per-type cap from 5 to 50. mallRoute reads ALL
  // shopping_mall rows in range to size-filter them, so a cap of 5 could
  // return only the nearest few small galleries and never surface the big
  // destination mall further out. Ordinary POI resolution reads [0] and is
  // unaffected either way.
  it('caps results at MAX_RESULTS_PER_TYPE (50) per type', () => {
    for (let i = 0; i < 60; i++) {
      upsertPlace({ poiType: 'atm', name: `ATM ${i}`, lat: i * 0.0001, lng: 0, source: { osm: `node/${i}` } });
    }

    const result = queryHabitatCache(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000);

    expect(result.atm).toHaveLength(50);
  });

  it('uses the default cap when maxResultsPerType is explicitly undefined', () => {
    for (let i = 0; i < 60; i++) {
      upsertPlace({ poiType: 'atm', name: `ATM ${i}`, lat: i * 0.002, lng: 0, source: { osm: `node/${i}` } });
    }

    const result = queryHabitatCache(ORIGIN.lat, ORIGIN.lng, ['atm'], 20_000, { maxResultsPerType: undefined });

    expect(result.atm).toHaveLength(50);
  });

  it('can opt out of the per-type cap for callers that rank beyond distance', () => {
    for (let i = 0; i < 60; i++) {
      upsertPlace({ poiType: 'attraction', name: `Attraction ${i}`, lat: i * 0.002, lng: 0, source: { osm: `way/${i}` } });
    }

    const result = queryHabitatCache(ORIGIN.lat, ORIGIN.lng, ['attraction'], 20_000, { maxResultsPerType: null });

    expect(result.attraction).toHaveLength(60);
    expect(result.attraction[0].distanceMeters).toBeLessThan(result.attraction[59].distanceMeters);
  });

  it('preserves explicitly provided integer caps', () => {
    for (let i = 0; i < 10; i++) {
      upsertPlace({ poiType: 'atm', name: `ATM ${i}`, lat: i * 0.0001, lng: 0, source: { osm: `node/${i}` } });
    }

    const result = queryHabitatCache(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000, { maxResultsPerType: 3 });

    expect(result.atm).toHaveLength(3);
  });

  it('rejects negative maxResultsPerType values before querying results', () => {
    expect(() => queryHabitatCache(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000, { maxResultsPerType: -1 }))
      .toThrow('maxResultsPerType must be a non-negative integer, null, or undefined');
    expect(mockDb.getAllSync).not.toHaveBeenCalled();
  });

  it('rejects fractional maxResultsPerType values before querying results', () => {
    expect(() => queryHabitatCache(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000, { maxResultsPerType: 1.5 }))
      .toThrow('maxResultsPerType must be a non-negative integer, null, or undefined');
    expect(mockDb.getAllSync).not.toHaveBeenCalled();
  });

  it('returns an empty array for a type with no cached rows', () => {
    const result = queryHabitatCache(ORIGIN.lat, ORIGIN.lng, ['school'], 5000);
    expect(result.school).toEqual([]);
  });

  it('returns an empty result and logs a warning instead of throwing when the DB read fails', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDb.getAllSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    const result = queryHabitatCache(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000);

    expect(result).toEqual({ atm: [] });
    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] queryHabitatCache failed', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('refreshHabitatCacheIfStale', () => {
  it('does nothing when offline', async () => {
    mockNetInfoFetch.mockResolvedValue({ isConnected: false });
    await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm']);
    expect(mockSearchOsmPlaces).not.toHaveBeenCalled();
  });

  it('fetches OSM data when the area has no cached rows yet', async () => {
    mockSearchOsmPlaces.mockResolvedValue({
      atm: [{ osmId: 'node/1', name: 'New ATM', isGenericName: false, lat: 0, lng: 0, distanceMeters: 0 }],
    });

    await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm']);

    expect(mockSearchOsmPlaces).toHaveBeenCalledWith(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000);
    expect(rows).toHaveLength(1);
  });

  it('does not re-fetch a type whose OSM data is still fresh', async () => {
    upsertPlace({ poiType: 'atm', name: 'Existing ATM', lat: 0, lng: 0, source: { osm: 'node/1' } });

    await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm']);

    expect(mockSearchOsmPlaces).not.toHaveBeenCalled();
  });

  it('re-fetches a type whose OSM data is older than the 14-day staleness window', async () => {
    upsertPlace({ poiType: 'atm', name: 'Stale ATM', lat: 0, lng: 0, source: { osm: 'node/1' } });
    rows[0].osm_fetched_at = Date.now() - HABITAT_CACHE_STALE_MS - 1000;
    mockSearchOsmPlaces.mockResolvedValue({ atm: [] });

    await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm']);

    expect(mockSearchOsmPlaces).toHaveBeenCalledWith(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000);
  });

  it('does not skip the OSM refresh just because a live Google hit was seeded for the same type', async () => {
    // Seed a Google-only candidate first — per the ToS-compliance fix this
    // never persists a row, so the area still has zero OSM-backed rows and
    // must still be treated as stale.
    upsertPlace({ poiType: 'atm', name: 'Live Hit', lat: 0, lng: 0, source: { google: 'g-1' } });
    mockSearchOsmPlaces.mockResolvedValue({ atm: [] });

    await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm']);

    expect(mockSearchOsmPlaces).toHaveBeenCalledWith(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000);
  });

  it('never calls searchOsmPlaces for a custom type with no OSM mapping — it would never satisfy the freshness check and stay stale forever otherwise', async () => {
    await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['my_custom_unmapped_type']);
    expect(mockSearchOsmPlaces).not.toHaveBeenCalled();
  });

  it('fetches only the OSM-mappable subset when poiTypes mixes mapped and unmapped types', async () => {
    mockSearchOsmPlaces.mockResolvedValue({ atm: [] });

    await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm', 'my_custom_unmapped_type']);

    expect(mockSearchOsmPlaces).toHaveBeenCalledWith(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000);
  });

  it('skips enforceSizeBudget\'s full-table COUNT(*) when OSM returned zero results for every fetched type', async () => {
    mockSearchOsmPlaces.mockResolvedValue({ atm: [] });

    await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm']);

    const countCalls = mockDb.getAllSync.mock.calls.filter(([sql]) => String(sql).includes('SELECT COUNT(*)'));
    expect(countCalls).toHaveLength(0);
  });

  it('still runs enforceSizeBudget when at least one place was upserted', async () => {
    mockSearchOsmPlaces.mockResolvedValue({
      atm: [{ osmId: 'node/1', name: 'New ATM', isGenericName: false, lat: 0, lng: 0, distanceMeters: 0 }],
    });

    await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm']);

    // Two counts, one per budget (KAN-282): the ordinary pool and the
    // separate shopping_mall cap.
    const countCalls = mockDb.getAllSync.mock.calls.filter(([sql]) => String(sql).includes('SELECT COUNT(*)'));
    expect(countCalls).toHaveLength(2);
  });

  describe('empty-result retry cooldown', () => {
    it('does not re-fetch a mapped type shortly after it returned zero OSM results', async () => {
      mockSearchOsmPlaces.mockResolvedValue({ atm: [] });
      await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm']);
      expect(mockSearchOsmPlaces).toHaveBeenCalledTimes(1);

      mockSearchOsmPlaces.mockClear();
      await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm']);
      expect(mockSearchOsmPlaces).not.toHaveBeenCalled();
    });

    it('retries once the cooldown window has passed', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      let now = 1_000_000;
      nowSpy.mockImplementation(() => now);

      mockSearchOsmPlaces.mockResolvedValue({ atm: [] });
      await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm']);
      expect(mockSearchOsmPlaces).toHaveBeenCalledTimes(1);

      mockSearchOsmPlaces.mockClear();
      now += 60 * 60 * 1_000 + 1; // just past the 1-hour cooldown
      await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm']);
      expect(mockSearchOsmPlaces).toHaveBeenCalledTimes(1);

      nowSpy.mockRestore();
    });

    it('throttles independently per area — a different location for the same type still fetches', async () => {
      mockSearchOsmPlaces.mockResolvedValue({ atm: [] });
      await refreshHabitatCacheIfStale(0, 0, ['atm']);
      expect(mockSearchOsmPlaces).toHaveBeenCalledTimes(1);

      mockSearchOsmPlaces.mockClear();
      await refreshHabitatCacheIfStale(10, 10, ['atm']); // far enough to be a different grid cell
      expect(mockSearchOsmPlaces).toHaveBeenCalledTimes(1);
    });
  });

  it('returns without throwing when the DB read fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDb.getAllSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    await expect(refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm'])).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] refreshHabitatCacheIfStale failed', expect.any(Error));
    warnSpy.mockRestore();
  });

  describe('force (KAN-241 — ContextChip manual "Refresh now")', () => {
    it('re-fetches a type even when its OSM data is still fresh', async () => {
      upsertPlace({ poiType: 'atm', name: 'Fresh ATM', lat: 0, lng: 0, source: { osm: 'node/1' } });
      mockSearchOsmPlaces.mockResolvedValue({ atm: [] });

      await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm'], true);

      expect(mockSearchOsmPlaces).toHaveBeenCalledWith(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000);
    });

    it('re-fetches a type even during its empty-result cooldown window', async () => {
      mockSearchOsmPlaces.mockResolvedValue({ atm: [] });
      await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm']);
      expect(mockSearchOsmPlaces).toHaveBeenCalledTimes(1);

      mockSearchOsmPlaces.mockClear();
      await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm'], true);
      expect(mockSearchOsmPlaces).toHaveBeenCalledTimes(1);
    });

    it('still does nothing when offline, even with force', async () => {
      mockNetInfoFetch.mockResolvedValue({ isConnected: false });
      await refreshHabitatCacheIfStale(ORIGIN.lat, ORIGIN.lng, ['atm'], true);
      expect(mockSearchOsmPlaces).not.toHaveBeenCalled();
    });
  });
});

// KAN-282 review — refreshHabitatCacheIfStale treats a POI type as fresh if
// ANY row of it exists in the 5km box, so one cached small gallery would mark
// shopping_mall fresh for the whole area and a genuinely big mall that was
// never cached could stay invisible for the full 14-day staleness window.
// refreshMallsIfDue therefore forces the sweep, on its own cooldown.
describe('refreshMallsIfDue (KAN-282)', () => {
  beforeEach(() => {
    mockNetInfoFetch.mockResolvedValue({ isConnected: true });
    mockSearchOsmPlaces.mockResolvedValue({ shopping_mall: [] });
  });

  it('sweeps even when a fresh shopping_mall row already exists in the area', async () => {
    // A small gallery, cached just now — enough to make the plain staleness
    // check consider the whole type fresh.
    upsertPlace({
      poiType: 'shopping_mall', name: 'Galeria Uruguai',
      lat: 0, lng: 0, source: { osm: 'node/11883971544' }, footprintAreaM2: 0,
    });

    await refreshMallsIfDue(0, 0);

    expect(mockSearchOsmPlaces).toHaveBeenCalledTimes(1);
    const [, , poiTypes] = mockSearchOsmPlaces.mock.calls[0];
    expect(poiTypes).toEqual(['shopping_mall']);
  });

  it('does not sweep the same area twice inside the cooldown', async () => {
    await refreshMallsIfDue(0, 0);
    await refreshMallsIfDue(0, 0);

    expect(mockSearchOsmPlaces).toHaveBeenCalledTimes(1);
  });

  it('still sweeps a different area during another area\'s cooldown', async () => {
    await refreshMallsIfDue(0, 0);
    await refreshMallsIfDue(10, 10);

    expect(mockSearchOsmPlaces).toHaveBeenCalledTimes(2);
  });

  it('never throws when the underlying refresh fails', async () => {
    mockSearchOsmPlaces.mockRejectedValue(new Error('Overpass unreachable'));
    await expect(refreshMallsIfDue(0, 0)).resolves.toBeUndefined();
  });
});

describe('enforceSizeBudget', () => {
  it('evicts the oldest (by last_matched_at) rows beyond MAX_CACHED_PLACES', () => {
    for (let i = 0; i < MAX_CACHED_PLACES + 5; i++) {
      const id = upsertPlace({ poiType: 'atm', name: `ATM ${i}`, lat: i * 0.01, lng: 0, source: { osm: `node/${i}` } });
      const row = rows.find(r => r.id === id);
      if (row) { row.last_matched_at = i; } // ascending — first inserted is oldest
    }

    enforceSizeBudget();

    expect(rows).toHaveLength(MAX_CACHED_PLACES);
    // The 5 oldest (lowest last_matched_at, i.e. i=0..4) should be gone.
    expect(rows.some(r => r.name === 'ATM 0')).toBe(false);
    expect(rows.some(r => r.name === `ATM ${MAX_CACHED_PLACES + 4}`)).toBe(true);
  });

  it('does nothing when under the cap', () => {
    upsertPlace({ poiType: 'atm', name: 'Only ATM', lat: 0, lng: 0, source: { osm: 'node/1' } });
    enforceSizeBudget();
    expect(rows).toHaveLength(1);
  });

  it('does not throw when the DB read fails', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDb.getAllSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => enforceSizeBudget()).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] enforceSizeBudget failed', expect.any(Error));
    warnSpy.mockRestore();
  });

  // KAN-282 regression: proximity's live searches bump last_matched_at for
  // ordinary task POI types but NEVER for shopping_mall, so mall rows always
  // sort oldest and were the first evicted every time the pool crossed the
  // cap — the mall card worked once, then silently lost all its data.
  it('never evicts a shopping_mall row, however stale its last_matched_at (KAN-282)', () => {
    const mallId = upsertPlace({
      poiType: 'shopping_mall', name: 'Centro Comercial Colombo',
      lat: 0, lng: 0, source: { osm: 'way/42645796' }, footprintAreaM2: 116_791,
    });
    const mallRow = rows.find(r => r.id === mallId);
    if (mallRow) { mallRow.last_matched_at = -1; } // older than every other row

    for (let i = 0; i < MAX_CACHED_PLACES + 5; i++) {
      const id = upsertPlace({ poiType: 'atm', name: `ATM ${i}`, lat: (i + 1) * 0.01, lng: 0, source: { osm: `node/${i}` } });
      const row = rows.find(r => r.id === id);
      if (row) { row.last_matched_at = i; }
    }

    enforceSizeBudget();

    expect(rows.some(r => r.id === mallId)).toBe(true);
    // ...and the mall didn't consume budget either: the ordinary pool is
    // trimmed to exactly the cap, rather than the cap minus the mall.
    expect(rows.filter(r => r.poi_type === 'atm')).toHaveLength(MAX_CACHED_PLACES);
  });

  // KAN-282 review — "exempt from LRU" must not mean "unbounded": mall rows
  // get their own cap, trimmed by osm_fetched_at (oldest DATA first), since
  // last_matched_at is meaningless for a type nothing ever re-matches.
  it('trims shopping_mall rows beyond MAX_CACHED_MALLS, oldest-fetched first', () => {
    for (let i = 0; i < MAX_CACHED_MALLS + 3; i++) {
      const id = upsertPlace({
        poiType: 'shopping_mall', name: `Mall ${i}`,
        lat: (i + 1) * 0.01, lng: 0, source: { osm: `way/${i}` }, footprintAreaM2: 30_000,
      });
      const row = rows.find(r => r.id === id);
      if (row) { row.osm_fetched_at = i; } // ascending — Mall 0 has the oldest data
    }

    enforceSizeBudget();

    expect(rows.filter(r => r.poi_type === 'shopping_mall')).toHaveLength(MAX_CACHED_MALLS);
    expect(rows.some(r => r.name === 'Mall 0')).toBe(false);
    expect(rows.some(r => r.name === `Mall ${MAX_CACHED_MALLS + 2}`)).toBe(true);
  });

  it('leaves malls alone while under their own cap, even when the ordinary pool overflows', () => {
    upsertPlace({
      poiType: 'shopping_mall', name: 'Colombo', lat: 0, lng: 0,
      source: { osm: 'way/42645796' }, footprintAreaM2: 116_791,
    });
    for (let i = 0; i < MAX_CACHED_PLACES + 5; i++) {
      upsertPlace({ poiType: 'atm', name: `ATM ${i}`, lat: (i + 1) * 0.01, lng: 0, source: { osm: `node/${i}` } });
    }

    enforceSizeBudget();

    expect(rows.some(r => r.name === 'Colombo')).toBe(true);
    expect(rows.filter(r => r.poi_type === 'atm')).toHaveLength(MAX_CACHED_PLACES);
  });

  it('never evicts a trip-tagged row (KAN-234) — only counts/evicts within the cache_area_id IS NULL pool', () => {
    const tripId = upsertTripPlace({
      poiType: 'atm', name: 'Trip ATM', lat: 0, lng: 0, source: { osm: 'node/trip' },
      cacheAreaId: 'trip-1', expiresAt: Date.now() + 1_000_000,
    });

    for (let i = 0; i < MAX_CACHED_PLACES + 5; i++) {
      const id = upsertPlace({ poiType: 'atm', name: `ATM ${i}`, lat: (i + 1) * 0.01, lng: 0, source: { osm: `node/${i}` } });
      const row = rows.find(r => r.id === id);
      if (row) { row.last_matched_at = i; } // ascending — first inserted is oldest, would normally be evicted first
    }

    enforceSizeBudget();

    expect(rows).toHaveLength(MAX_CACHED_PLACES + 1); // the cap only applies to the untagged pool
    expect(rows.some(r => r.id === tripId)).toBe(true);
  });
});

describe('upsertTripPlace / trip areas (KAN-234)', () => {
  it('inserts a new row tagged with cacheAreaId and expiresAt', () => {
    const expiresAt = Date.now() + 1_000_000;
    const id = upsertTripPlace({
      poiType: 'atm', name: 'Trip ATM', lat: 0, lng: 0, source: { osm: 'node/1' },
      cacheAreaId: 'trip-1', expiresAt,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].cache_area_id).toBe('trip-1');
    expect(rows[0].expires_at).toBe(expiresAt);
  });

  it('tags an existing untagged (ordinary habitat) row when a trip download rediscovers it', () => {
    const habitatId = upsertPlace({ poiType: 'atm', name: 'Corner ATM', lat: 0, lng: 0, source: { osm: 'node/1' } });
    expect(rows[0].cache_area_id).toBeNull();

    const expiresAt = Date.now() + 1_000_000;
    const tripId = upsertTripPlace({
      poiType: 'atm', name: 'Corner ATM', lat: 0.0001, lng: 0, source: { osm: 'node/1' },
      cacheAreaId: 'trip-1', expiresAt,
    });

    expect(tripId).toBe(habitatId);
    expect(rows[0].cache_area_id).toBe('trip-1');
    expect(rows[0].expires_at).toBe(expiresAt);
  });

  it('never overwrites an already trip-tagged row\'s cacheAreaId (first trip wins), but extends expiresAt to the max of old/new', () => {
    const firstExpiry = Date.now() + 1_000_000;
    const id = upsertTripPlace({
      poiType: 'atm', name: 'Shared ATM', lat: 0, lng: 0, source: { osm: 'node/1' },
      cacheAreaId: 'trip-1', expiresAt: firstExpiry,
    });

    const laterExpiry = firstExpiry + 5_000_000;
    upsertTripPlace({
      poiType: 'atm', name: 'Shared ATM', lat: 0.0001, lng: 0, source: { osm: 'node/1' },
      cacheAreaId: 'trip-2', expiresAt: laterExpiry,
    });

    expect(rows.find(r => r.id === id)?.cache_area_id).toBe('trip-1'); // unchanged — first trip wins
    expect(rows.find(r => r.id === id)?.expires_at).toBe(laterExpiry); // extended
  });

  it('a plain upsertPlace call never touches an existing trip row\'s cacheAreaId/expiresAt', () => {
    const expiresAt = Date.now() + 1_000_000;
    const id = upsertTripPlace({
      poiType: 'atm', name: 'Trip ATM', lat: 0, lng: 0, source: { osm: 'node/1' },
      cacheAreaId: 'trip-1', expiresAt,
    });

    upsertPlace({ poiType: 'atm', name: 'Trip ATM', lat: 0.0001, lng: 0, source: { google: 'g-1' } });

    expect(rows.find(r => r.id === id)?.cache_area_id).toBe('trip-1');
    expect(rows.find(r => r.id === id)?.expires_at).toBe(expiresAt);
  });

  it('returns a fresh id and logs a warning instead of throwing when the DB read fails', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDb.getAllSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    const id = upsertTripPlace({
      poiType: 'atm', name: 'Trip ATM', lat: 0, lng: 0, source: { osm: 'node/1' },
      cacheAreaId: 'trip-1', expiresAt: Date.now(),
    });

    expect(id).toMatch(/^hp_/);
    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] upsertPlace failed', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('deleteTripAreaPlaces', () => {
  it('deletes only rows tagged with the given cacheAreaId', () => {
    upsertTripPlace({ poiType: 'atm', name: 'A', lat: 0, lng: 0, source: { osm: 'node/1' }, cacheAreaId: 'trip-1', expiresAt: Date.now() });
    upsertTripPlace({ poiType: 'cafe', name: 'B', lat: 10, lng: 10, source: { osm: 'node/2' }, cacheAreaId: 'trip-2', expiresAt: Date.now() });
    upsertPlace({ poiType: 'bank', name: 'C', lat: 20, lng: 20, source: { osm: 'node/3' } }); // ordinary habitat row

    deleteTripAreaPlaces('trip-1');

    expect(rows).toHaveLength(2);
    expect(rows.some(r => r.cache_area_id === 'trip-1')).toBe(false);
    expect(rows.some(r => r.cache_area_id === 'trip-2')).toBe(true);
    expect(rows.some(r => r.cache_area_id == null)).toBe(true);
  });

  it('does not throw when the DB call fails', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDb.runSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => deleteTripAreaPlaces('trip-1')).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] deleteTripAreaPlaces failed', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('writeTripAreaPlaces (KAN-234 review fix — atomic delete+reinsert)', () => {
  it('replaces existing rows for cacheAreaId with the new places, in one transaction', () => {
    upsertTripPlace({ poiType: 'atm', name: 'Old ATM', lat: 0, lng: 0, source: { osm: 'node/old' }, cacheAreaId: 'trip-1', expiresAt: 1 });

    const written = writeTripAreaPlaces('trip-1', 2_000, [
      { poiType: 'cafe', name: 'New Cafe', lat: 1, lng: 1, source: { osm: 'node/new1' } },
      { poiType: 'bank', name: 'New Bank', lat: 2, lng: 2, source: { osm: 'node/new2' } },
    ]);

    expect(written).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.cache_area_id === 'trip-1' && r.expires_at === 2_000)).toBe(true);
    expect(rows.some(r => r.name === 'Old ATM')).toBe(false);
  });

  it('rolls back the delete when an insert fails partway — the previous cache is left intact, not half-deleted', () => {
    upsertTripPlace({ poiType: 'atm', name: 'Old ATM', lat: 0, lng: 0, source: { osm: 'node/old' }, cacheAreaId: 'trip-1', expiresAt: 1 });

    // Wrap the real dispatcher so the 2nd INSERT within the transaction throws.
    const realRunSync = mockDb.runSync.getMockImplementation()!;
    let insertCount = 0;
    mockDb.runSync.mockImplementation((sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('INSERT INTO habitat_places')) {
        insertCount += 1;
        if (insertCount === 2) { throw new Error('disk full'); }
      }
      return realRunSync(sql, params);
    });

    expect(() => writeTripAreaPlaces('trip-1', 2_000, [
      { poiType: 'cafe', name: 'New Cafe', lat: 1, lng: 1, source: { osm: 'node/new1' } },
      { poiType: 'bank', name: 'New Bank', lat: 2, lng: 2, source: { osm: 'node/new2' } },
    ])).toThrow('disk full');

    // Rollback restored the original row — the delete never actually "stuck".
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Old ATM');
  });

  it('propagates the underlying error instead of swallowing it', () => {
    mockDb.getAllSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => writeTripAreaPlaces('trip-1', 2_000, [
      { poiType: 'cafe', name: 'New Cafe', lat: 1, lng: 1, source: { osm: 'node/new1' } },
    ])).toThrow('disk full');
  });
});

describe('deleteExpiredTripPlaces', () => {
  it('deletes only rows whose expiresAt has passed', () => {
    const expiredId = upsertTripPlace({ poiType: 'atm', name: 'Expired', lat: 0, lng: 0, source: { osm: 'node/1' }, cacheAreaId: 'trip-1', expiresAt: Date.now() - 1_000 });
    const activeId = upsertTripPlace({ poiType: 'cafe', name: 'Active', lat: 10, lng: 10, source: { osm: 'node/2' }, cacheAreaId: 'trip-2', expiresAt: Date.now() + 1_000_000 });
    const habitatId = upsertPlace({ poiType: 'bank', name: 'Habitat', lat: 20, lng: 20, source: { osm: 'node/3' } }); // expires_at NULL

    deleteExpiredTripPlaces();

    expect(rows.some(r => r.id === expiredId)).toBe(false);
    expect(rows.some(r => r.id === activeId)).toBe(true);
    expect(rows.some(r => r.id === habitatId)).toBe(true);
  });

  it('does not throw when the DB call fails', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDb.runSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => deleteExpiredTripPlaces()).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] deleteExpiredTripPlaces failed', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('estimateHabitatAreaSizeBytes', () => {
  it('returns 0 for an empty cache', () => {
    expect(estimateHabitatAreaSizeBytes()).toBe(0);
  });

  it('scales with the number of untagged (ordinary habitat) rows', () => {
    upsertPlace({ poiType: 'atm', name: 'A', lat: 0, lng: 0, source: { osm: 'node/1' } });
    upsertPlace({ poiType: 'cafe', name: 'B', lat: 10, lng: 10, source: { osm: 'node/2' } });

    expect(estimateHabitatAreaSizeBytes()).toBe(2 * HABITAT_BYTES_PER_ROW);
  });

  it('excludes trip-tagged rows', () => {
    upsertPlace({ poiType: 'atm', name: 'A', lat: 0, lng: 0, source: { osm: 'node/1' } });
    upsertTripPlace({ poiType: 'cafe', name: 'B', lat: 10, lng: 10, source: { osm: 'node/2' }, cacheAreaId: 'trip-1', expiresAt: Date.now() });

    expect(estimateHabitatAreaSizeBytes()).toBe(1 * HABITAT_BYTES_PER_ROW);
  });

  it('returns 0 and logs a warning instead of throwing when the DB read fails', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDb.getAllSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(estimateHabitatAreaSizeBytes()).toBe(0);

    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] estimateHabitatAreaSizeBytes failed', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('hasCachedPlaces (KAN-236)', () => {
  it('returns false when the cache is empty', () => {
    expect(hasCachedPlaces()).toBe(false);
  });

  it('returns true when the cache has at least one row, anywhere', () => {
    upsertPlace({ poiType: 'atm', name: 'Some ATM', lat: 40, lng: -70, source: { osm: 'node/1' } });
    expect(hasCachedPlaces()).toBe(true);
  });

  it('returns false and logs a warning instead of throwing when the DB read fails', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDb.getAllSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(hasCachedPlaces()).toBe(false);

    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] hasCachedPlaces failed', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('getMostRecentHabitatUpdateAt (KAN-241)', () => {
  it('returns null for an empty cache', () => {
    expect(getMostRecentHabitatUpdateAt()).toBeNull();
  });

  it('returns the most recent last_matched_at among untagged rows', () => {
    const dateSpy = jest.spyOn(Date, 'now');
    dateSpy.mockReturnValue(1_000);
    upsertPlace({ poiType: 'atm', name: 'A', lat: 0, lng: 0, source: { osm: 'node/1' } });
    dateSpy.mockReturnValue(2_000);
    upsertPlace({ poiType: 'cafe', name: 'B', lat: 10, lng: 10, source: { osm: 'node/2' } });

    expect(getMostRecentHabitatUpdateAt()).toBe(2_000);
    dateSpy.mockRestore();
  });

  it('excludes trip-tagged rows even when they are more recent than any untagged row', () => {
    const dateSpy = jest.spyOn(Date, 'now');
    dateSpy.mockReturnValue(1_000);
    upsertPlace({ poiType: 'atm', name: 'A', lat: 0, lng: 0, source: { osm: 'node/1' } });

    dateSpy.mockReturnValue(9_999_999); // far more recent, but trip-tagged
    upsertTripPlace({ poiType: 'cafe', name: 'B', lat: 10, lng: 10, source: { osm: 'node/2' }, cacheAreaId: 'trip-1', expiresAt: 9_999_999 });

    expect(getMostRecentHabitatUpdateAt()).toBe(1_000);
    dateSpy.mockRestore();
  });

  it('returns null and logs a warning instead of throwing when the DB read fails', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDb.getAllSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(getMostRecentHabitatUpdateAt()).toBeNull();

    expect(warnSpy).toHaveBeenCalledWith('[habitatCache] getMostRecentHabitatUpdateAt failed', expect.any(Error));
    warnSpy.mockRestore();
  });
});
