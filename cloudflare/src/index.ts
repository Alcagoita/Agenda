import { encodeGeohash, haversineMeters, neighborPrefixes, precisionForRadius } from './geohash';

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
};

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

  const types = poiType ? (TYPE_MERGE_INCLUDES[poiType] ?? [poiType]) : null;
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
      const body = await request.json<{ tileId: string }>();
      await env.REGISTRY_DB.prepare(
        "UPDATE coverage SET status = 'ready', last_built_at = ? WHERE tile_id = ?",
      ).bind(new Date().toISOString(), body.tileId).run();
      return json({ ok: true });
    }

    const authError = authenticate(request, env);
    if (authError) return authError;

    // GET /poi?lat=&lng=&radius=&type=  — POIs of one type within a radius
    if (url.pathname === '/poi' && request.method === 'GET') {
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lng'));
      const radius = Number(url.searchParams.get('radius') ?? '1000');
      const poiType = url.searchParams.get('type');
      if (!poiType) return json({ error: 'type is required' }, 400);
      if (Number.isNaN(lat) || Number.isNaN(lng)) return json({ error: 'lat/lng required' }, 400);

      const tile = await findCoveringTile(env, lat, lng);
      if (!tile || tile.status !== 'ready') {
        return json({ covered: false, status: tile?.status ?? 'none', results: [] });
      }
      const results = await queryPoiDb(env.REGISTRY_DB, tile.tile_id, lat, lng, radius, poiType);
      return json({ covered: true, tileId: tile.tile_id, results });
    }

    // GET /poi/all?lat=&lng=&radius=  — all cached POI types within a radius
    if (url.pathname === '/poi/all' && request.method === 'GET') {
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lng'));
      const radius = Number(url.searchParams.get('radius') ?? '1000');
      if (Number.isNaN(lat) || Number.isNaN(lng)) return json({ error: 'lat/lng required' }, 400);

      const tile = await findCoveringTile(env, lat, lng);
      if (!tile || tile.status !== 'ready') {
        return json({ covered: false, status: tile?.status ?? 'none', results: [] });
      }
      const results = await queryPoiDb(env.REGISTRY_DB, tile.tile_id, lat, lng, radius, null);
      return json({ covered: true, tileId: tile.tile_id, results });
    }

    // GET /coverage?lat=&lng=  — is this location ready / building / none?
    if (url.pathname === '/coverage' && request.method === 'GET') {
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lng'));
      if (Number.isNaN(lat) || Number.isNaN(lng)) return json({ error: 'lat/lng required' }, 400);

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
