import { haversineMeters, neighborPrefixes, precisionForRadius, MAX_RADIUS_METERS } from './geohash';

export interface Env {
  // One shared D1 database for everything — Cloudflare Free plan caps at 10
  // databases/account, so per-city databases don't scale past 10 cities.
  // Holds both `coverage` (registry) and `poi` (all cities, keyed by
  // tile_id) tables.
  REGISTRY_DB: D1Database;
  POI_EXPORTS: R2Bucket;
  API_KEY: string;
  BUILD_TRIGGER_URL?: string;
  BUILD_TRIGGER_SECRET?: string;
}

interface CoverageRow {
  tile_id: string;
  status: 'none' | 'building' | 'ready';
  center_lat: number;
  center_lng: number;
  radius_km: number;
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
 * Finds the registry tile whose coverage circle contains (lat, lng). Tiles can
 * legitimately overlap (e.g. Odivelas sits inside Lisboa's wider radius) —
 * picks the nearest center among all matches, not just the first row, so a
 * point inside a suburb's own smaller circle resolves to the suburb, not the
 * larger city it happens to also be inside. Linear scan — fine while the
 * registry is small; revisit with geohash bucketing on `coverage` itself once
 * city count grows.
 */
async function findCoveringTile(env: Env, lat: number, lng: number): Promise<CoverageRow | null> {
  const { results } = await env.REGISTRY_DB.prepare('SELECT * FROM coverage').all<CoverageRow>();
  let best: CoverageRow | null = null;
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
 * Directional type-merge rules, not symmetric groups. Foursquare's taxonomy
 * splits some real-world-equivalent venues into sibling leaf categories
 * (a "supermarket" and a "grocery_store" are the same kind of place to a
 * shopper, just inconsistently labeled — see Minipreço/My Auchan, both
 * classified grocery_store, KAN-329 field test) and genuinely contains one
 * type inside another (every bank branch has an ATM; a standalone ATM is
 * not a bank). The merge direction follows real-world intent, not the
 * category tree:
 *   - searching a broad/containing type also returns the narrower type it
 *     structurally contains (atm -> atm+bank)
 *   - searching the narrower type does NOT pull in the broader one (bank
 *     search must not return standalone ATMs with no other bank services)
 *   - genuine synonyms merge both ways (supermarket <-> grocery_store)
 *   - a distinct real intent never merges with a nearby type even if
 *     Foursquare's tree puts them close together (convenience_store is a
 *     deliberately different "quick top-up" intent from "the weekly
 *     grocery run" — searching either must not pull in the other)
 */
const TYPE_MERGE_INCLUDES: Record<string, string[]> = {
  atm: ['atm', 'bank'],
  supermarket: ['supermarket', 'grocery_store'],
  grocery_store: ['supermarket', 'grocery_store'],
  // fitness_center/gym and hotel/lodging are distinct PoiTypes in our own
  // catalog, but Foursquare has exactly one leaf category for each real
  // concept ("Gym and Studio", "Hotel") — classification can only assign a
  // place to one or the other (see the collision warning in
  // extraction/classify_and_load.py's build_reverse_map), so both sides
  // need to be queried together or one of the two PoiTypes silently never
  // returns anything.
  fitness_center: ['fitness_center', 'gym'],
  gym: ['fitness_center', 'gym'],
  hotel: ['hotel', 'lodging'],
  lodging: ['hotel', 'lodging'],
};

function typesForSearch(poiType: string): string[] {
  return Object.hasOwn(TYPE_MERGE_INCLUDES, poiType) ? TYPE_MERGE_INCLUDES[poiType] : [poiType];
}

async function queryPoiDb(
  db: D1Database,
  tileId: string,
  lat: number,
  lng: number,
  radiusMeters: number,
  poiType: string | null,
) {
  const precision = precisionForRadius(radiusMeters);
  const prefixes = neighborPrefixes(lat, lng, precision);
  const placeholders = prefixes.map(() => '?').join(',');

  const types = poiType ? typesForSearch(poiType) : null;
  const typePlaceholders = types?.map(() => '?').join(',');

  const sql = types
    ? `SELECT * FROM poi WHERE tile_id = ? AND poi_type IN (${typePlaceholders}) AND substr(geohash, 1, ${precision}) IN (${placeholders})`
    : `SELECT * FROM poi WHERE tile_id = ? AND substr(geohash, 1, ${precision}) IN (${placeholders})`;
  const binds = types ? [tileId, ...types, ...prefixes] : [tileId, ...prefixes];

  const { results } = await db.prepare(sql).bind(...binds).all<{
    fsq_place_id: string; name: string; lat: number; lng: number;
    poi_type: string; store_subtype: string | null; food_subtype: string | null;
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
      const body = await request.json<{ tileId?: unknown }>();
      if (typeof body.tileId !== 'string' || body.tileId.trim() === '') {
        return json({ error: 'tileId must be a non-empty string' }, 400);
      }
      const result = await env.REGISTRY_DB.prepare(
        "UPDATE coverage SET status = 'ready', last_built_at = ? WHERE tile_id = ?",
      ).bind(new Date().toISOString(), body.tileId).run();
      if (result.meta.changes !== 1) {
        // Silent no-op success previously masked a bad tileId (typo, unknown
        // city) — the build pipeline would report success while coverage
        // stayed stuck in 'building' forever with nothing to explain why.
        return json({ error: `no coverage row matched tileId '${body.tileId}'` }, 404);
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

      const tile = await findCoveringTile(env, lat, lng);
      if (!tile || tile.status !== 'ready') {
        return json({ covered: false, status: tile?.status ?? 'none', results: [] });
      }
      const results = await queryPoiDb(env.REGISTRY_DB, tile.tile_id, lat, lng, radius, poiType);
      return json({ covered: true, tileId: tile.tile_id, results });
    }

    // GET /poi/all?lat=&lng=&radius=  — all cached POI types within a radius
    if (url.pathname === '/poi/all' && request.method === 'GET') {
      const parsed = parseCoordsAndRadius(url);
      if (parsed instanceof Response) return parsed;
      const { lat, lng, radius } = parsed;

      const tile = await findCoveringTile(env, lat, lng);
      if (!tile || tile.status !== 'ready') {
        return json({ covered: false, status: tile?.status ?? 'none', results: [] });
      }
      const results = await queryPoiDb(env.REGISTRY_DB, tile.tile_id, lat, lng, radius, null);
      return json({ covered: true, tileId: tile.tile_id, results });
    }

    // GET /coverage?lat=&lng=  — is this location ready / building / none?
    if (url.pathname === '/coverage' && request.method === 'GET') {
      const parsed = parseCoords(url);
      if (parsed instanceof Response) return parsed;
      const { lat, lng } = parsed;

      const tile = await findCoveringTile(env, lat, lng);
      return json({ status: tile?.status ?? 'none', tileId: tile?.tile_id ?? null });
    }

    // POST /coverage/request  { lat, lng }  — trigger a build for an uncovered area
    if (url.pathname === '/coverage/request' && request.method === 'POST') {
      const body = await request.json<{ lat: number; lng: number }>();
      const { lat, lng } = body;
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        return json({ error: 'lat/lng required' }, 400);
      }

      const existing = await findCoveringTile(env, lat, lng);
      if (existing) {
        // Already covered or already building — dedup, no-op.
        return json({ status: existing.status, tileId: existing.tile_id });
      }

      // No tile for this area at all yet. Real auto-provisioning (new D1 DB +
      // wrangler binding + Cloud Function trigger) is follow-up work — for
      // now this just reports that nothing exists so the client falls back
      // to OSM locally, without creating a phantom registry row.
      return json({ status: 'none', tileId: null, note: 'auto-provisioning not yet implemented' });
    }

    return json({ error: 'not found' }, 404);
  },
};
