/**
 * reverseGeocodeCache.ts — persistent cache for OSM Nominatim reverse-geocode
 * results (KAN-301).
 *
 * Nominatim's usage policy *mandates* client-side caching of results — this is
 * a compliance requirement, not an optimisation. OSM data is ODbL-licensed and
 * cacheable long-term (unlike Google Places results), so a resolved city name
 * is stored keyed on the position rounded to ~3 decimal places (≈100 m) and
 * kept across restarts and offline periods.
 *
 * SQLite (same choice as habitatCache.ts / proximitySnapshot.ts): works fully
 * offline, survives restarts, no new native dependency. Every call is
 * best-effort and never throws — the in-memory layer in maps.ts is the fast
 * path and the source of truth for a single session; this just lets a name
 * survive a cold start. A null city is cached too (a resolved "no name here"),
 * so we don't re-hit Nominatim for the same empty cell.
 */
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'reverse_geocode_cache.db';

export interface CachedCity {
  /** True when this cell has a resolved entry (the city may still be null). */
  hit: boolean;
  /** The resolved city name, or null when the cell resolved to no name. */
  city: string | null;
}

const MISS: CachedCity = { hit: false, city: null };

let db: SQLite.SQLiteDatabase | null = null;

function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    const database = SQLite.openDatabaseSync(DB_NAME);
    database.execSync(`
      CREATE TABLE IF NOT EXISTS reverse_geocode (
        cell       TEXT PRIMARY KEY,
        city       TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    db = database;
  }
  return db;
}

/** Returns the cached entry for `cell`, or a miss (also on any error). */
export function getCachedCity(cell: string): CachedCity {
  try {
    const row = getDb().getFirstSync<{ city: string | null }>(
      'SELECT city FROM reverse_geocode WHERE cell = ?',
      [cell],
    );
    if (!row) { return MISS; }
    return { hit: true, city: row.city ?? null };
  } catch {
    return MISS;
  }
}

/** Upserts the resolved city (or null) for `cell`. Fire-and-forget; never throws. */
export function putCachedCity(cell: string, city: string | null): void {
  try {
    getDb().runSync(
      `INSERT INTO reverse_geocode (cell, city, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(cell) DO UPDATE SET city = excluded.city, updated_at = excluded.updated_at`,
      [cell, city, Date.now()],
    );
  } catch {
    /* best-effort — the in-memory cache still holds for this session */
  }
}

/** Test-only: drops the cached db handle so the next call re-opens fresh. */
export function __resetReverseGeocodeCacheDbForTests(): void {
  db = null;
}
