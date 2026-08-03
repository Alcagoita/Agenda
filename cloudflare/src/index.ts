import { haversineMeters, neighborPrefixes, precisionForRadius, MAX_RADIUS_METERS } from './geohash';

export interface Env {
  // One shared D1 database for everything — 10GB is D1's hard per-database
  // ceiling regardless of plan tier, so per-city databases don't scale.
  // Holds `city`, `poi` (all cities, keyed by city_id), and `build_log`.
  REGISTRY_DB: D1Database;
  POI_EXPORTS: R2Bucket;
  API_KEY: string;
  BUILD_TRIGGER_URL?: string;
  BUILD_TRIGGER_SECRET?: string;
}

interface CityRow {
  city_id: string;
  status: 'none' | 'building' | 'ready';
  center_lat: number;
  center_lng: number;
  radius_km: number;
  current_build_id: string | null;
  last_built_at: string | null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authenticate(request: Request, env: Env): Response | null {
  const key = request.headers.get('X-Api-Key');
  if (key !== env.API_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

interface ParsedCoords { lat: number; lng: number; }
interface ParsedCoordsAndRadius extends ParsedCoords { radius: number; }

/** Validates lat/lng are present, finite, and within real coordinate bounds — a value like lat=999 passed Number.isNaN before but was never a real coordinate. */
function parseCoords(url: URL): ParsedCoords | Response {
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return json({ error: 'lat must be a finite number between -90 and 90' }, 400);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return json({ error: 'lng must be a finite number between -180 and 180' }, 400);
  return { lat, lng };
}

/** parseCoords plus radius bounds — must be finite, positive, and within what the geohash 3x3 window can safely cover (see MAX_RADIUS_METERS). A NaN/negative/oversized radius previously fell through to an always-empty or silently-incomplete result instead of a clear error. */
function parseCoordsAndRadius(url: URL): ParsedCoordsAndRadius | Response {
  const coords = parseCoords(url);
  if (coords instanceof Response) return coords;
  const radius = Number(url.searchParams.get('radius') ?? '1000');
  if (!Number.isFinite(radius) || radius <= 0) return json({ error: 'radius must be a finite positive number' }, 400);
  if (radius > MAX_RADIUS_METERS) return json({ error: `radius must be <= ${MAX_RADIUS_METERS}m` }, 400);
  return { ...coords, radius };
}

/**
 * Finds the city whose coverage circle contains (lat, lng). Cities can
 * legitimately overlap (e.g. Odivelas sits inside Lisboa's wider radius) —
 * picks the nearest center among all matches, not just the first row, so a
 * point inside a suburb's own smaller circle resolves to the suburb, not the
 * larger city it happens to also be inside. Linear scan — fine while the
 * city table is small; revisit with geohash bucketing on `city` itself once
 * city count grows.
 */
async function findCoveringCity(env: Env, lat: number, lng: number): Promise<CityRow | null> {
  const { results } = await env.REGISTRY_DB.prepare('SELECT * FROM city').all<CityRow>();
  let best: CityRow | null = null;
  let bestDistanceM = Infinity;
  for (const row of results) {
    const distanceM = haversineMeters(lat, lng, row.center_lat, row.center_lng);
    if (distanceM <= row.radius_km * 1000 && distanceM < bestDistanceM) {
      best = row;
      bestDistanceM = distanceM;
    }
  }
  return best;
}

/**
 * Merge rules as data (KAN-337) — see type_relation_schema.sql for the full
 * rationale (directional, not symmetric; genuine synonyms vs. structural
 * containment vs. deliberately-isolated types) and the seed rows.
 *
 * Loaded once per Worker isolate, cached in module scope — an isolate can
 * serve many requests, and merge rules change rarely enough that
 * re-querying D1 on every request would be pure waste. A newly-deployed
 * isolate always sees the current table; an existing isolate picks up a
 * table edit only after it's recycled (not on a fixed schedule — whenever
 * the Workers runtime naturally cycles it), same tradeoff as any
 * module-scope cache in a serverless runtime.
 */
let typeRelationCache: Record<string, string[]> | null = null;

async function loadTypeRelations(db: D1Database): Promise<Record<string, string[]>> {
  if (typeRelationCache) return typeRelationCache;
  const { results } = await db.prepare('SELECT search_type, include_type FROM type_relation').all<{
    search_type: string; include_type: string;
  }>();
  const map: Record<string, string[]> = {};
  for (const row of results) {
    (map[row.search_type] ??= []).push(row.include_type);
  }
  typeRelationCache = map;
  return map;
}

async function typesForSearch(db: D1Database, poiType: string): Promise<string[]> {
  const relations = await loadTypeRelations(db);
  return Object.hasOwn(relations, poiType) ? relations[poiType] : [poiType];
}

/**
 * KAN-335: a place can match more than one type (poi_type table, one row
 * per matched type), so filtering by type is an EXISTS subquery against
 * poi_type, not a column comparison on poi itself — a plain INNER JOIN
 * would return the same poi row once per matching poi_type row (e.g. a
 * place matching both searched types 'bakery' and 'cafe' would come back
 * twice); EXISTS just checks presence, never multiplies rows.
 *
 * Filters by geohash prefix first, type second (WHERE geohash IN (...) AND
 * EXISTS(...type check...)). Benchmarked against live Lisboa data (121
 * matching rows either way, same result set both forms): this ordering
 * averaged ~23ms vs ~38ms for a type-first JOIN (poi_type driving, geohash
 * filtered after) — consistently faster across repeated runs.
 *
 * Real caveat found while benchmarking, not yet fixed here: EXPLAIN QUERY
 * PLAN shows neither form actually uses idx_poi_city_geo for the geohash
 * filter — substr(geohash, 1, n) IN (...) is a function over the column,
 * which SQLite/D1 can't serve from a b-tree index, so both forms fall back
 * to a city_id-filtered scan. Correctness is unaffected, but a real
 * geohash >= ? AND geohash < ? range condition (index-sargable, unlike
 * substr()) would likely be meaningfully faster still — worth its own
 * follow-up, out of scope for this ticket (multi-type support, not a
 * geohash-indexing rewrite).
 */
async function queryPoiDb(
  db: D1Database,
  cityId: string,
  lat: number,
  lng: number,
  radiusMeters: number,
  poiType: string | null,
) {
  const precision = precisionForRadius(radiusMeters);
  const prefixes = neighborPrefixes(lat, lng, precision);
  const placeholders = prefixes.map(() => '?').join(',');

  const types = poiType ? await typesForSearch(db, poiType) : null;
  const typePlaceholders = types?.map(() => '?').join(',');

  const sql = types
    ? `SELECT * FROM poi WHERE city_id = ? AND substr(geohash, 1, ${precision}) IN (${placeholders}) ` +
      `AND EXISTS (SELECT 1 FROM poi_type WHERE poi_type.city_id = poi.city_id AND poi_type.fsq_place_id = poi.fsq_place_id AND poi_type.poi_type IN (${typePlaceholders}))`
    : `SELECT * FROM poi WHERE city_id = ? AND substr(geohash, 1, ${precision}) IN (${placeholders})`;
  const binds = types ? [cityId, ...prefixes, ...types] : [cityId, ...prefixes];

  const { results } = await db.prepare(sql).bind(...binds).all<{
    fsq_place_id: string; name: string; lat: number; lng: number;
    primary_poi_type: string; brand: string | null;
    category_label: string | null; address: string | null;
  }>();

  return results
    .map(r => ({ ...r, distanceMeters: haversineMeters(lat, lng, r.lat, r.lng) }))
    .filter(r => r.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Internal, server-to-server only — its own stronger secret, not the
    // public X-Api-Key gate below.
    if (url.pathname === '/internal/build-complete' && request.method === 'POST') {
      if (request.headers.get('X-Build-Secret') !== env.BUILD_TRIGGER_SECRET) {
        return json({ error: 'unauthorized' }, 401);
      }
      const body = await request.json<{
        cityId?: unknown; buildId?: unknown; rowsLoaded?: unknown; rowsSkipped?: unknown; status?: unknown; r2Key?: unknown;
      }>();
      if (typeof body.cityId !== 'string' || body.cityId.trim() === '') {
        return json({ error: 'cityId must be a non-empty string' }, 400);
      }
      if (typeof body.buildId !== 'string' || body.buildId.trim() === '') {
        return json({ error: 'buildId must be a non-empty string' }, 400);
      }
      const now = new Date().toISOString();

      // A crashed/errored extraction run (classify_and_load.py raised, the
      // D1 load failed, etc.) previously had no way to close out its
      // build_log row at all — it stayed 'building' forever with nothing
      // to explain why. This path marks it 'failed' without touching
      // `city` — a failed re-build of an already-served city must not
      // un-ready it; the last successful build's data is still valid and
      // still being served.
      if (body.status === 'failed') {
        const buildLogResult = await env.REGISTRY_DB.prepare(
          "UPDATE build_log SET status = 'failed', finished_at = ? WHERE build_id = ? AND city_id = ?",
        ).bind(now, body.buildId, body.cityId).run();
        if (buildLogResult.meta.changes !== 1) {
          return json({ error: `no build_log row matched buildId '${body.buildId}' for cityId '${body.cityId}'` }, 404);
        }
        return json({ ok: true, status: 'failed' });
      }

      // Batched so both updates either both apply or both roll back on a
      // genuine execution error — previously two separate .run() calls
      // could leave city flipped to 'ready' while build_log's update threw
      // and never ran at all. Batch atomicity only covers real execution
      // failures, not "0 rows matched" (a successful UPDATE that matched
      // nothing isn't a batch error) — those are still checked afterward.
      const [cityResult, buildLogResult] = await env.REGISTRY_DB.batch([
        env.REGISTRY_DB.prepare(
          "UPDATE city SET status = 'ready', current_build_id = ?, last_built_at = ? WHERE city_id = ?",
        ).bind(body.buildId, now, body.cityId),
        env.REGISTRY_DB.prepare(
          "UPDATE build_log SET status = 'ready', finished_at = ?, rows_loaded = ?, rows_skipped = ?, raw_extract_r2_key = COALESCE(?, raw_extract_r2_key) WHERE build_id = ? AND city_id = ?",
        ).bind(
          now,
          typeof body.rowsLoaded === 'number' ? body.rowsLoaded : null,
          typeof body.rowsSkipped === 'number' ? body.rowsSkipped : null,
          typeof body.r2Key === 'string' && body.r2Key.trim() !== '' ? body.r2Key : null,
          body.buildId, body.cityId,
        ),
      ]);

      if (cityResult.meta.changes !== 1) {
        // Silent no-op success previously masked a bad cityId (typo, unknown
        // city) — the build pipeline would report success while coverage
        // stayed stuck in 'building' forever with nothing to explain why.
        return json({ error: `no city row matched cityId '${body.cityId}'` }, 404);
      }
      if (buildLogResult.meta.changes !== 1) {
        // The city row already flipped to 'ready' above — don't roll that
        // back over a missing build_log row (e.g. an older loader run that
        // predates this table). Surface it, don't fail the whole request.
        return json({ ok: true, warning: `no build_log row matched buildId '${body.buildId}' for cityId '${body.cityId}'` });
      }
      return json({ ok: true });
    }

    const authError = authenticate(request, env);
    if (authError) return authError;

    // GET /poi?lat=&lng=&radius=&type=  — POIs of one type within a radius
    if (url.pathname === '/poi' && request.method === 'GET') {
      const poiType = url.searchParams.get('type');
      if (!poiType) return json({ error: 'type is required' }, 400);
      const parsed = parseCoordsAndRadius(url);
      if (parsed instanceof Response) return parsed;
      const { lat, lng, radius } = parsed;

      const city = await findCoveringCity(env, lat, lng);
      if (!city || city.status !== 'ready') {
        return json({ covered: false, status: city?.status ?? 'none', results: [] });
      }
      const results = await queryPoiDb(env.REGISTRY_DB, city.city_id, lat, lng, radius, poiType);
      return json({ covered: true, cityId: city.city_id, results });
    }

    // GET /poi/all?lat=&lng=&radius=  — all cached POI types within a radius
    if (url.pathname === '/poi/all' && request.method === 'GET') {
      const parsed = parseCoordsAndRadius(url);
      if (parsed instanceof Response) return parsed;
      const { lat, lng, radius } = parsed;

      const city = await findCoveringCity(env, lat, lng);
      if (!city || city.status !== 'ready') {
        return json({ covered: false, status: city?.status ?? 'none', results: [] });
      }
      const results = await queryPoiDb(env.REGISTRY_DB, city.city_id, lat, lng, radius, null);
      return json({ covered: true, cityId: city.city_id, results });
    }

    // GET /coverage?lat=&lng=  — is this location ready / building / none?
    if (url.pathname === '/coverage' && request.method === 'GET') {
      const parsed = parseCoords(url);
      if (parsed instanceof Response) return parsed;
      const { lat, lng } = parsed;

      const city = await findCoveringCity(env, lat, lng);
      return json({ status: city?.status ?? 'none', cityId: city?.city_id ?? null });
    }

    // POST /coverage/request  { lat, lng }  — trigger a build for an uncovered area
    if (url.pathname === '/coverage/request' && request.method === 'POST') {
      const body = await request.json<{ lat: number; lng: number }>();
      const { lat, lng } = body;
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        return json({ error: 'lat/lng required' }, 400);
      }

      const existing = await findCoveringCity(env, lat, lng);
      if (existing) {
        // Already covered or already building — dedup, no-op.
        return json({ status: existing.status, cityId: existing.city_id });
      }

      // No city for this area at all yet. Real auto-provisioning (new city
      // row + Cloud Function trigger) is follow-up work — for now this just
      // reports that nothing exists so the client falls back to OSM
      // locally, without creating a phantom city row.
      return json({ status: 'none', cityId: null, note: 'auto-provisioning not yet implemented' });
    }

    return json({ error: 'not found' }, 404);
  },
};
