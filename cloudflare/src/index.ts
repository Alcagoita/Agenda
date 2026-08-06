import { haversineMeters, neighborPrefixes, precisionForRadius, requiredGridCells, MAX_GRID_CELLS_PER_AXIS, MAX_RADIUS_METERS } from './geohash';
import { ContainerProxy, getContainer } from '@cloudflare/containers';
import { ExtractionContainer } from './extractionContainer';

// Re-exported (not just imported) — the Workers runtime resolves the
// `durable_objects` binding's `class_name` against this module's exports,
// per wrangler.jsonc. See extractionContainer.ts for what it actually runs.
export { ContainerProxy, ExtractionContainer };

export interface Env {
  // One shared D1 database for everything — 10GB is D1's hard per-database
  // ceiling regardless of plan tier, so per-place databases don't scale.
  // Holds `place`, `country`, `poi`, `poi_type`, `poi_attribute`,
  // `type_relation`, and `build_log` (KAN-355 — see
  // docs/poi-coverage-model.md for the full model).
  REGISTRY_DB: D1Database;
  POI_EXPORTS: R2Bucket;
  API_KEY: string;
  // KAN-354 — the extraction Container. Its own D1/R2 access goes through
  // extractionContainer.ts's outboundByHost handlers, not a separate
  // Cloudflare API token; BUILD_TRIGGER_SECRET is what it uses to call back
  // /internal/* (passed to it as an env var when started — see triggerBuild).
  EXTRACTION_CONTAINER: DurableObjectNamespace<ExtractionContainer>;
  BUILD_TRIGGER_SECRET?: string;
  // Foursquare Places Portal JWT (expires, manual renewal — see
  // cloudflare/README.md's Extraction pipeline section). Passed to the
  // Container as an env var; the Worker itself never calls Foursquare.
  FOURSQUARE_JWT?: string;
}

/**
 * KAN-355 — renamed from CityRow/`city`. Internal DB status vocabulary is
 * 'none' | 'mapping' | 'mapped' (place_schema.sql); the public HTTP contract
 * below still speaks 'none' | 'building' | 'ready' (see toApiStatus) —
 * deliberately NOT renamed at the response boundary. The schema/identity
 * rework is the point of this ticket, not a client contract bump: every
 * existing caller (KAN-346's already-shipped Cloud Function proxy and app
 * client) keeps working unchanged.
 */
interface PlaceRow {
  place_id: string;
  country_code: string | null;
  status: 'none' | 'mapping' | 'mapped';
  place_kind: string | null;
  // The extent actually ingested — NULL until the worker (KAN-354) maps
  // this Place. A 'none'/'mapping' row has no bbox to fast-path lookups
  // against; only 'mapped' rows do (see findPlace).
  min_lat: number | null;
  max_lat: number | null;
  min_lng: number | null;
  max_lng: number | null;
  build_id: string | null;
  mapped_at: string | null;
  // KAN-346: demand recording — bumped every time a 'none' row is hit again
  // by a real zero-check request, so we know which unmapped Places to
  // prioritize. Not touched once a row leaves 'none'.
  request_count: number;
  first_requested_at: string | null;
  last_requested_at: string | null;
}

/** DB status -> public API status. See PlaceRow's doc comment for why these differ. */
function toApiStatus(status: PlaceRow['status']): 'none' | 'building' | 'ready' {
  if (status === 'mapping') return 'building';
  if (status === 'mapped') return 'ready';
  return 'none';
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

/** All /internal/* routes use this instead of authenticate() — a stronger, separate secret, never the public X-Api-Key. */
function authenticateInternal(request: Request, env: Env): Response | null {
  if (request.headers.get('X-Build-Secret') !== env.BUILD_TRIGGER_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

interface ParsedCoords { lat: number; lng: number; }
interface ParsedCoordsAndRadius extends ParsedCoords { radius: number; }
interface AttributeFilter { dimension: string; values: string[]; }

/** attribute+value are optional but must appear together — e.g. attribute=food_cuisine&value=sushi, or value=sushi,italian for an OR match. Capped at 2 values (matches the current real use case: a place tagged with two cuisines, not an open-ended list). */
function parseAttributeFilter(url: URL): AttributeFilter | null | Response {
  const dimension = url.searchParams.get('attribute');
  const rawValue = url.searchParams.get('value');
  if (!dimension && !rawValue) return null;
  if (!dimension || !rawValue) {
    return json({ error: 'attribute and value must be provided together' }, 400);
  }
  const values = [...new Set(rawValue.split(',').map(v => v.trim()).filter(v => v !== ''))];
  if (values.length === 0) {
    return json({ error: 'value must contain at least one non-empty value' }, 400);
  }
  if (values.length > 2) {
    return json({ error: 'value accepts at most 2 comma-separated values' }, 400);
  }
  return { dimension, values };
}

/** Validates lat/lng are present, finite, and within real coordinate bounds — a value like lat=999 passed Number.isNaN before but was never a real coordinate. */
function parseCoords(url: URL): ParsedCoords | Response {
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return json({ error: 'lat must be a finite number between -90 and 90' }, 400);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return json({ error: 'lng must be a finite number between -180 and 180' }, 400);
  return { lat, lng };
}

/**
 * parseCoords plus radius bounds — must be finite, positive, within
 * MAX_RADIUS_METERS (a sanity cap on query size), and within the geohash
 * grid's per-axis cell budget at this specific latitude (see geohash.ts's
 * requiredGridCells/MAX_GRID_CELLS_PER_AXIS — lng cell width shrinks toward
 * the poles, so a radius/precision that's a small grid at the equator can
 * need a much bigger one at extreme latitudes; rejected here explicitly
 * rather than neighborPrefixes silently truncating the search grid and
 * returning incomplete results). Not reachable by this product's actual
 * Portugal-only usage today — Lisbon's latitude needs at most 2 cells out
 * even at MAX_RADIUS_METERS — but a real, if currently theoretical, request
 * that would exceed the budget must fail loudly, not silently.
 */
function parseCoordsAndRadius(url: URL): ParsedCoordsAndRadius | Response {
  const coords = parseCoords(url);
  if (coords instanceof Response) return coords;
  const radius = Number(url.searchParams.get('radius') ?? '1000');
  if (!Number.isFinite(radius) || radius <= 0) return json({ error: 'radius must be a finite positive number' }, 400);
  if (radius > MAX_RADIUS_METERS) return json({ error: `radius must be <= ${MAX_RADIUS_METERS}m` }, 400);
  const { cellsLat, cellsLng } = requiredGridCells(coords.lat, precisionForRadius(radius), radius);
  if (cellsLat > MAX_GRID_CELLS_PER_AXIS || cellsLng > MAX_GRID_CELLS_PER_AXIS) {
    return json({ error: `radius ${radius}m at this latitude needs a search grid larger than supported (max ${MAX_GRID_CELLS_PER_AXIS} cells/axis)` }, 400);
  }
  return { ...coords, radius };
}

/**
 * KAN-355 — finds the Place whose ingested extent (min/max lat/lng) contains
 * (lat, lng). Only 'mapped' Places ever carry a real extent (place_schema.sql
 * — NULL until the worker actually ingests one), so this is inherently a
 * fast-path for already-mapped areas only; a 'none'/'mapping' row (recorded
 * demand, no extent yet) is never matched here and always falls through to
 * resolvePlaceIdentity + a lookup by stable id instead (see
 * POST /coverage/request). Places can legitimately overlap (a suburb inside
 * a wider neighbour) — picks the smallest-area match among all containing
 * rows, not just the first, so a point inside a suburb's own tighter extent
 * resolves to the suburb. Linear scan — fine while the place table is small;
 * revisit with geohash bucketing on `place` itself once place count grows
 * (same accepted tradeoff as the pre-KAN-355 circle version).
 */
async function findPlace(env: Env, lat: number, lng: number): Promise<PlaceRow | null> {
  const { results } = await env.REGISTRY_DB.prepare(
    'SELECT * FROM place WHERE min_lat IS NOT NULL AND ? BETWEEN min_lat AND max_lat AND ? BETWEEN min_lng AND max_lng',
  ).bind(lat, lng).all<PlaceRow>();
  let best: PlaceRow | null = null;
  let bestAreaDeg2 = Infinity;
  for (const row of results) {
    const areaDeg2 = (row.max_lat! - row.min_lat!) * (row.max_lng! - row.min_lng!);
    if (areaDeg2 < bestAreaDeg2) {
      best = row;
      bestAreaDeg2 = areaDeg2;
    }
  }
  return best;
}

// ─── KAN-355: reverse-geocode to a stable Place identity ──────────────────
//
// Server-side only — the client never resolves its own Place identity, so
// it can't be spoofed/mismatched against what the Worker dedupes on. Same
// Nominatim service the app already uses client-side (maps.ts), same
// User-Agent policy requirement.
//
// No shared 1req/s throttle across isolates (would need a Durable Object or
// KV-backed token bucket — real infra, out of scope here). Acceptable for
// now: this only runs on a genuinely new Place resolution, which findPlace's
// bbox fast-path and the app's own zero-check already make rare. Revisit
// with a real global limiter before this traffic grows.

const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_USER_AGENT = 'BrushPoiBackend/1 (poi-api.brushaway.app)';
const NOMINATIM_TIMEOUT_MS = 8_000;

/**
 * Zoom levels to try, finest first. A single fixed zoom does not reliably
 * resolve "the settlement" worldwide — verified live against Nominatim
 * 2026-08-05: zoom=10 correctly resolves small/mid settlements with no
 * sub-municipal layer (Sertã, Odivelas), but for a city with freguesia
 * (parish) subdivisions it resolves to the freguesia instead of the
 * municipality — e.g. a point in central Lisboa returns "Arroios" at
 * zoom=10, and Porto returns a merged freguesia-union name, not "Porto".
 * zoom=8 fixes both of those but is too coarse for Sertã (returns its
 * district, "Castelo Branco", not the town). See resolvePlaceIdentity for
 * how the retry actually picks the right one per point rather than
 * guessing a single zoom for every place on earth.
 */
const NOMINATIM_ZOOM_CANDIDATES = [10, 9, 8] as const;

interface PlaceGeo {
  placeId: string;
  name: string;
  countryCode: string | null;
  countryName: string | null;
  placeKind: string | null;
}

/** Same preference order as the app's own extractCityName (maps.ts) — most specific populated-place field wins. Do not write this twice; keep in sync if either changes. */
const SETTLEMENT_FIELD_PRIORITY = ['city', 'town', 'village', 'municipality', 'suburb', 'county'] as const;

/** Case/diacritic-insensitive: address.city and a feature's own `name` come from the same OSM source but aren't always byte-identical (accents, casing). Same normalization shape as extraction/classify_and_load.py's normalize_text — kept independent since this compares whole names, not tokenizing for substring matching. */
function normalizeSettlementName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

interface NominatimReverseResult {
  osmType: string;
  osmId: string | number;
  name: string;
  addresstype: string | null;
  countryCode: string | null;
  countryName: string | null;
  settlementName: string | null;
}

async function nominatimReverse(lat: number, lng: number, zoom: number): Promise<NominatimReverseResult | null> {
  const url = `${NOMINATIM_REVERSE_URL}?lat=${lat}&lon=${lng}&format=jsonv2&zoom=${zoom}&addressdetails=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);
  let data: unknown;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_USER_AGENT }, signal: controller.signal });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;

  const osmType = record.osm_type;
  const osmId = record.osm_id;
  const name = record.name;
  if (typeof osmType !== 'string' || !osmType) return null;
  if (typeof osmId !== 'number' && typeof osmId !== 'string') return null;
  if (typeof name !== 'string' || !name) return null;

  const address = (typeof record.address === 'object' && record.address !== null
    ? record.address
    : {}) as Record<string, unknown>;

  let settlementName: string | null = null;
  for (const field of SETTLEMENT_FIELD_PRIORITY) {
    const value = address[field];
    if (typeof value === 'string' && value) { settlementName = value; break; }
  }

  return {
    osmType,
    osmId,
    name,
    addresstype: typeof record.addresstype === 'string' ? record.addresstype : null,
    countryCode: typeof address.country_code === 'string' ? address.country_code.toUpperCase() : null,
    countryName: typeof address.country === 'string' ? address.country : null,
    settlementName,
  };
}

/**
 * Resolves (lat, lng) to a stable Place identity via Nominatim's own
 * osm_type+osm_id — never a display name (renames/translations would
 * silently fork one settlement into two rows) and never a coordinate-
 * derived id (many coordinates inside one settlement must dedupe to the
 * same row).
 *
 * Tries NOMINATIM_ZOOM_CANDIDATES finest-first, stopping at the first zoom
 * whose own resolved feature IS the settlement — i.e. address doesn't name
 * a narrower city/town/village than the feature's own name (the common
 * case, one call), or does but it happens to already match (still one
 * call). Only a city with an extra sub-municipal layer (Lisboa, Porto) pays
 * for a second/third call, and only on a genuinely new Place resolution —
 * rare by construction (findPlace's bbox fast-path already short-circuits
 * every repeat request in an already-mapped area before this ever runs).
 *
 * Returns null on any transport failure, or when no candidate zoom
 * resolves cleanly — callers must treat that as "genuinely unknown, don't
 * record", not as an empty administrative area.
 */
async function resolvePlaceIdentity(lat: number, lng: number): Promise<PlaceGeo | null> {
  for (const zoom of NOMINATIM_ZOOM_CANDIDATES) {
    const result = await nominatimReverse(lat, lng, zoom);
    if (!result) return null; // transport/parse failure — do not retry a coarser zoom on a broken call
    // address carrying no narrower settlement name than the feature's own
    // name means the feature itself already IS the settlement (the common
    // case — Sertã/Odivelas resolve here on the first, finest zoom).
    // Otherwise the resolved feature is a sub-unit of a NAMED settlement
    // (a freguesia inside Lisboa) — try a coarser zoom.
    if (!result.settlementName || normalizeSettlementName(result.settlementName) === normalizeSettlementName(result.name)) {
      return {
        placeId: `osm-${result.osmType}-${result.osmId}`,
        name: result.settlementName ?? result.name,
        countryCode: result.countryCode,
        countryName: result.countryName,
        placeKind: result.addresstype,
      };
    }
  }
  return null;
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
 * Filters by geohash prefix first, type second (WHERE geohash range OR ...
 * EXISTS(...type check...)). Benchmarked against live Lisboa data (121
 * matching rows either way, same result set both forms): this ordering
 * averaged ~23ms vs ~38ms for a type-first JOIN (poi_type driving, geohash
 * filtered after) — consistently faster across repeated runs. KAN-355
 * renamed city_id -> place_id on this predicate; not re-benchmarked, since
 * it's the same column doing the same job under a new name — see
 * place_schema.sql's note on where this should be re-measured if that
 * assumption ever needs checking.
 *
 * Each prefix is expressed as an inclusive/exclusive lexical range rather
 * than `substr(geohash, 1, n)`: applying a function to the indexed column
 * prevents SQLite/D1 using idx_poi_place_geo beyond place_id. `~` sorts after
 * every base32 geohash character, so [prefix, prefix + '~') contains exactly
 * the full geohash subtree for that prefix and is index-sargable.
 */
async function queryPoiDb(
  db: D1Database,
  lat: number,
  lng: number,
  radiusMeters: number,
  poiType: string | null,
  attributeFilter: AttributeFilter | null,
) {
  const precision = precisionForRadius(radiusMeters);
  const prefixes = neighborPrefixes(lat, lng, precision, radiusMeters);
  const geohashClauses = prefixes.map(() => '(geohash >= ? AND geohash < ?)');

  const types = poiType ? await typesForSearch(db, poiType) : null;
  const typePlaceholders = types?.map(() => '?').join(',');

  const clauses = [`(${geohashClauses.join(' OR ')})`];
  const binds: unknown[] = [...prefixes.flatMap(prefix => [prefix, `${prefix}~`])];

  if (types) {
    clauses.push(
      `EXISTS (SELECT 1 FROM poi_type WHERE poi_type.fsq_place_id = poi.fsq_place_id AND poi_type.poi_type IN (${typePlaceholders}))`,
    );
    binds.push(...types);
  }

  // Same EXISTS shape as the poi_type filter above — a place can carry more
  // than one value per dimension (KAN-336), so this is presence, not a
  // plain join that would multiply rows.
  if (attributeFilter) {
    const valuePlaceholders = attributeFilter.values.map(() => '?').join(',');
    clauses.push(
      `EXISTS (SELECT 1 FROM poi_attribute WHERE poi_attribute.fsq_place_id = poi.fsq_place_id AND poi_attribute.dimension = ? AND poi_attribute.value IN (${valuePlaceholders}))`,
    );
    binds.push(attributeFilter.dimension, ...attributeFilter.values);
  }

  const sql = `SELECT * FROM poi WHERE ${clauses.join(' AND ')}`;

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

// KAN-346/355: ceiling on how many not-yet-mapped ('none') Places can be
// recorded at once, worldwide — recording demand is nearly free (one D1 row,
// one-to-three Nominatim calls), but unbounded growth from abuse or a client
// bug still isn't free. A 'none' row is normally short-lived now (KAN-354
// promotes it to 'mapping' and starts the Container in the same request),
// but this still guards the window before that start actually lands.
const MAX_PENDING_DEMAND_PLACES = 50;
// How long the client should wait before checking again while a Place is
// 'mapping' (KAN-354). Not measured against a real build yet — revisit once
// actual Container run durations are known; a flat guess is fine for now
// since there's no latency target for this pipeline (docs/poi-coverage-model.md).
const COVERAGE_BUILDING_RETRY_AFTER_SECONDS = 60;

async function bumpCoverageDemand(env: Env, place: PlaceRow): Promise<void> {
  // Only 'none' rows are demand signal — a 'mapped'/'mapping' row being
  // requested again isn't telling us anything new to prioritize.
  if (place.status !== 'none') return;
  // WHERE status = 'none' too — defense in depth against a concurrent
  // request flipping this row's status between our read and this write;
  // the JS check above alone only guards against the row we already read.
  await env.REGISTRY_DB.prepare(
    "UPDATE place SET request_count = request_count + 1, last_requested_at = ? WHERE place_id = ? AND status = 'none'",
  ).bind(new Date().toISOString(), place.place_id).run();
}

function respondCoverageRequest(place: PlaceRow | null): Response {
  if (!place) return json({ coverageStatus: 'none', cityId: null });
  return json({
    coverageStatus: toApiStatus(place.status),
    cityId: place.place_id,
    ...(place.status === 'mapping' ? { retryAfterSeconds: COVERAGE_BUILDING_RETRY_AFTER_SECONDS } : {}),
  });
}

/**
 * KAN-354 — starts the extraction Container in-process (no separate service
 * to reach over the network — see extractionContainer.ts) and forgets.
 * Never awaited by a caller that needs to respond promptly
 * (POST /coverage/request must return immediately per its own contract —
 * never extract inline). A fresh Durable Object key per call
 * (`${mode}:${target}:${timestamp}`) — each invocation is a one-shot batch
 * job, never resumed, so there's no reason to route repeat calls for the
 * same Place/country to the same instance.
 */
function triggerBuild(
  env: Env,
  ctx: ExecutionContext | undefined,
  mode: 'place' | 'country',
  target: string,
): void {
  const key = `${mode}:${target}:${Date.now()}`;
  const container = getContainer(env.EXTRACTION_CONTAINER, key);
  const startup = container.start({
    envVars: {
      MODE: mode,
      TARGET: target,
      BUILD_TRIGGER_SECRET: env.BUILD_TRIGGER_SECRET ?? '',
      FOURSQUARE_JWT: env.FOURSQUARE_JWT ?? '',
    },
  }).catch(async (error) => {
    // A detached promise is cancelled when the Worker finishes the request.
    // Keep it alive via waitUntil below, and make a startup failure retryable
    // instead of stranding the Place/country in its in-progress state.
    console.error('[extraction] Container failed to start', { mode, target, error: String(error) });
    if (mode === 'place') {
      await env.REGISTRY_DB.prepare(
        "UPDATE place SET status = 'none' WHERE place_id = ? AND status = 'mapping' AND build_id IS NULL",
      ).bind(target).run();
    } else {
      await env.REGISTRY_DB.prepare(
        "UPDATE country SET status = 'none' WHERE country_code = ? AND status = 'mapping'",
      ).bind(target).run();
    }
  });

  // Container startup is asynchronous, but must outlive this fast coverage
  // response. In production Workers always supplies ctx; the fallback keeps
  // the pure route tests usable when they call fetch() directly.
  if (ctx) ctx.waitUntil(startup);
}

/**
 * Atomically promotes a 'none' Place to 'mapping' and fires the build
 * trigger exactly once — WHERE status = 'none' in the UPDATE is what makes
 * "exactly once per Place" (KAN-354 AC4) hold under concurrent requests:
 * only the request that actually wins the race (changes === 1) triggers;
 * every other concurrent/later request for the same Place just re-reads
 * the now-'mapping' row and does nothing further. A no-op for a Place
 * that's already 'mapping' or 'mapped'.
 */
async function startPlaceMapping(env: Env, ctx: ExecutionContext | undefined, place: PlaceRow): Promise<PlaceRow> {
  if (place.status !== 'none') return place;
  const result = await env.REGISTRY_DB.prepare(
    "UPDATE place SET status = 'mapping' WHERE place_id = ? AND status = 'none'",
  ).bind(place.place_id).run();
  if (result.meta.changes === 1) {
    triggerBuild(env, ctx, 'place', place.place_id);
    return { ...place, status: 'mapping' };
  }
  // Lost the race — another concurrent request already promoted it (or it
  // moved further already). Re-read rather than assume: it could be
  // 'mapping' (don't re-trigger) or already 'mapped' (a very fast build,
  // or this request was simply slow).
  const current = await env.REGISTRY_DB.prepare('SELECT * FROM place WHERE place_id = ?')
    .bind(place.place_id).first<PlaceRow>();
  return current ?? place;
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Internal, server-to-server only — its own stronger secret, not the
    // public X-Api-Key gate below.
    if (url.pathname === '/internal/build-complete' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{
        cityId?: unknown; buildId?: unknown; rowsLoaded?: unknown; rowsSkipped?: unknown; status?: unknown; r2Key?: unknown;
        minLat?: unknown; maxLat?: unknown; minLng?: unknown; maxLng?: unknown;
      }>();
      if (typeof body.cityId !== 'string' || body.cityId.trim() === '') {
        return json({ error: 'cityId must be a non-empty string' }, 400);
      }
      if (typeof body.buildId !== 'string' || body.buildId.trim() === '') {
        return json({ error: 'buildId must be a non-empty string' }, 400);
      }
      const now = new Date().toISOString();
      // KAN-354 AC3 — "the extent actually ingested", written here rather
      // than assumed from any pre-extraction bbox (place_schema.sql's own
      // contract). Optional per-field: a failed extent computation upstream
      // shouldn't block the whole build from closing out successfully —
      // COALESCE keeps whatever the row already had (NULL on a first build)
      // rather than writing a partial/inconsistent extent.
      const hasExtent = [body.minLat, body.maxLat, body.minLng, body.maxLng].every(v => typeof v === 'number');

      // A crashed/errored extraction run (classify_and_load.py raised, the
      // D1 load failed, etc.) previously had no way to close out its
      // build_log row at all — it stayed 'building' forever with nothing
      // to explain why. This path marks it 'failed'.
      //
      // KAN-354: also reverts `place` to 'none' — but ONLY when this Place
      // was never successfully mapped before (build_id is still null). A
      // failed FIRST build must not strand the row in 'mapping' forever
      // (KAN-354 AC6); a failed RE-map of an already-mapped Place must NOT
      // un-map it — the last successful build's data is still valid and
      // still being served, exactly the KAN-346-era reasoning this
      // preserves. Reverting to 'none' (not leaving 'mapping') means a
      // future zero-check naturally retries it — no separate retry queue
      // needed.
      if (body.status === 'failed') {
        const place = await env.REGISTRY_DB.prepare('SELECT * FROM place WHERE place_id = ?')
          .bind(body.cityId).first<PlaceRow>();
        if (place && place.build_id === null) {
          await env.REGISTRY_DB.prepare(
            "UPDATE place SET status = 'none' WHERE place_id = ? AND status = 'mapping'",
          ).bind(body.cityId).run();
        }
        const buildLogResult = await env.REGISTRY_DB.prepare(
          "UPDATE build_log SET status = 'failed', finished_at = ? WHERE build_id = ? AND place_id = ?",
        ).bind(now, body.buildId, body.cityId).run();
        if (buildLogResult.meta.changes !== 1) {
          return json({ error: `no build_log row matched buildId '${body.buildId}' for cityId '${body.cityId}'` }, 404);
        }
        return json({ ok: true, status: 'failed' });
      }

      // Batched so both updates either both apply or both roll back on a
      // genuine execution error — previously two separate .run() calls
      // could leave place flipped to 'mapped' while build_log's update threw
      // and never ran at all. Batch atomicity only covers real execution
      // failures, not "0 rows matched" (a successful UPDATE that matched
      // nothing isn't a batch error) — those are still checked afterward.
      const [placeResult, buildLogResult] = await env.REGISTRY_DB.batch([
        env.REGISTRY_DB.prepare(
          `UPDATE place SET status = 'mapped', build_id = ?, mapped_at = ?,
             min_lat = COALESCE(?, min_lat), max_lat = COALESCE(?, max_lat),
             min_lng = COALESCE(?, min_lng), max_lng = COALESCE(?, max_lng)
           WHERE place_id = ?`,
        ).bind(
          body.buildId, now,
          hasExtent ? body.minLat : null, hasExtent ? body.maxLat : null,
          hasExtent ? body.minLng : null, hasExtent ? body.maxLng : null,
          body.cityId,
        ),
        env.REGISTRY_DB.prepare(
          "UPDATE build_log SET status = 'ready', finished_at = ?, rows_loaded = ?, rows_skipped = ?, raw_extract_r2_key = COALESCE(?, raw_extract_r2_key) WHERE build_id = ? AND place_id = ?",
        ).bind(
          now,
          typeof body.rowsLoaded === 'number' ? body.rowsLoaded : null,
          typeof body.rowsSkipped === 'number' ? body.rowsSkipped : null,
          typeof body.r2Key === 'string' && body.r2Key.trim() !== '' ? body.r2Key : null,
          body.buildId, body.cityId,
        ),
      ]);

      if (placeResult.meta.changes !== 1) {
        // Silent no-op success previously masked a bad cityId (typo, unknown
        // Place) — the build pipeline would report success while coverage
        // stayed stuck in 'mapping' forever with nothing to explain why.
        return json({ error: `no place row matched cityId '${body.cityId}'` }, 404);
      }
      if (buildLogResult.meta.changes !== 1) {
        // The place row already flipped to 'mapped' above — don't roll that
        // back over a missing build_log row (e.g. an older loader run that
        // predates this table). Surface it, don't fail the whole request.
        return json({ ok: true, warning: `no build_log row matched buildId '${body.buildId}' for cityId '${body.cityId}'` });
      }
      return json({ ok: true });
    }

    // POST /internal/place-failed  { cityId, stage?, error? }  — a lighter-weight failure
    // signal than /internal/build-complete {status:'failed'}: usable at ANY
    // point in the Job's run, even before a build_id/build_log row exists
    // (e.g. the Foursquare extraction itself failed, before classification
    // ever started). Same "never strand it" reasoning as the other failure
    // paths — reverts 'mapping' -> 'none' only for a Place never previously
    // mapped, so a future zero-check retries it; leaves an already-mapped
    // Place's last-good state untouched. No build_log row to close out
    // here — the Containers dashboard's own logs are the diagnosable
    // record for a failure this early.
    if (url.pathname === '/internal/place-failed' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{ cityId?: unknown; stage?: unknown; error?: unknown }>().catch(() => null);
      if (typeof body?.cityId !== 'string' || body.cityId.trim() === '') {
        return json({ error: 'cityId must be a non-empty string' }, 400);
      }
      // A one-shot Container's stdout is not surfaced by `wrangler tail`.
      // Log only bounded, structured failure metadata from the trusted
      // internal callback: enough to diagnose the failed stage without
      // allowing a large traceback or any unbounded payload into logs.
      if (typeof body.stage === 'string' || typeof body.error === 'string') {
        console.error('[extraction] Place job failed', {
          cityId: body.cityId,
          stage: typeof body.stage === 'string' ? body.stage.slice(0, 100) : 'unknown',
          error: typeof body.error === 'string' ? body.error.slice(0, 1_000) : 'unknown',
        });
      }
      const place = await env.REGISTRY_DB.prepare('SELECT * FROM place WHERE place_id = ?')
        .bind(body.cityId).first<PlaceRow>();
      if (place && place.build_id === null) {
        await env.REGISTRY_DB.prepare(
          "UPDATE place SET status = 'none' WHERE place_id = ? AND status = 'mapping'",
        ).bind(body.cityId).run();
      }
      return json({ ok: true });
    }

    // Country mode discovers Places before it maps them. Keep creation in the
    // Worker so the Container never owns a second copy of Place schema rules.
    // Existing mapped Places are intentionally left untouched: their last
    // good coverage remains usable while a country refresh runs.
    if (url.pathname === '/internal/place/ensure' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{
        placeId?: unknown; countryCode?: unknown; name?: unknown; placeKind?: unknown;
      }>().catch(() => null);
      if (typeof body?.placeId !== 'string' || body.placeId.trim() === '' ||
          typeof body.countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(body.countryCode) ||
          typeof body.name !== 'string' || body.name.trim() === '') {
        return json({ error: 'placeId, two-letter countryCode, and name are required' }, 400);
      }
      const countryCode = body.countryCode.toUpperCase();
      const country = await env.REGISTRY_DB.prepare('SELECT * FROM country WHERE country_code = ?')
        .bind(countryCode).first<{ country_code: string }>();
      if (!country) return json({ error: `no country row matched countryCode '${countryCode}'` }, 404);
      await env.REGISTRY_DB.prepare(
        `INSERT INTO place (place_id, country_code, name, place_kind, status, request_count)
         VALUES (?, ?, ?, ?, 'mapping', 0)
         ON CONFLICT(place_id) DO UPDATE SET status =
           CASE WHEN place.status = 'none' THEN 'mapping' ELSE place.status END`,
      ).bind(body.placeId, countryCode, body.name, typeof body.placeKind === 'string' ? body.placeKind : null).run();
      const place = await env.REGISTRY_DB.prepare('SELECT * FROM place WHERE place_id = ?')
        .bind(body.placeId).first<PlaceRow>();
      return json({ ok: true, status: place ? toApiStatus(place.status) : 'none' });
    }

    // POST /internal/country/queue  { countryCode }  — KAN-354's country
    // pre-build trigger. Operational: queued by whoever decides which
    // country goes next (docs/poi-coverage-model.md — "Country: operational"),
    // not automatically. Idempotent: queuing an already-mapping/mapped
    // country is a no-op that just reports its current state, never a
    // second job.
    //
    if (url.pathname === '/internal/country/queue' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{ countryCode?: unknown }>().catch(() => null);
      if (typeof body?.countryCode !== 'string' || body.countryCode.trim() === '') {
        return json({ error: 'countryCode must be a non-empty string' }, 400);
      }
      const countryCode = body.countryCode.toUpperCase();
      const result = await env.REGISTRY_DB.prepare(
        "UPDATE country SET status = 'mapping', place_count = 0 WHERE country_code = ? AND status = 'none'",
      ).bind(countryCode).run();
      if (result.meta.changes === 1) triggerBuild(env, ctx, 'country', countryCode);
      const country = await env.REGISTRY_DB.prepare('SELECT * FROM country WHERE country_code = ?')
        .bind(countryCode).first<{ status: string }>();
      if (!country) return json({ error: `no country row for '${countryCode}' — it must exist before it can be queued` }, 404);
      return json({ ok: true, status: country.status });
    }

    // POST /internal/country-progress  { countryCode }  — called by the
    // country-mode Job once per Place it finishes mapping, so place_count
    // reflects real progress rather than only flipping at the very end
    // (KAN-354 AC1: "progress visible on the country row").
    if (url.pathname === '/internal/country-progress' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{ countryCode?: unknown }>().catch(() => null);
      if (typeof body?.countryCode !== 'string' || body.countryCode.trim() === '') {
        return json({ error: 'countryCode must be a non-empty string' }, 400);
      }
      const result = await env.REGISTRY_DB.prepare(
        'UPDATE country SET place_count = place_count + 1 WHERE country_code = ?',
      ).bind(body.countryCode.toUpperCase()).run();
      if (result.meta.changes !== 1) {
        return json({ error: `no country row matched countryCode '${body.countryCode}'` }, 404);
      }
      return json({ ok: true });
    }

    // POST /internal/country-complete  { countryCode, buildId }  — the whole
    // country finished (every Place attempted, per-Place results already
    // recorded via /internal/build-complete + /internal/country-progress).
    if (url.pathname === '/internal/country-complete' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{ countryCode?: unknown; buildId?: unknown }>().catch(() => null);
      if (typeof body?.countryCode !== 'string' || body.countryCode.trim() === '') {
        return json({ error: 'countryCode must be a non-empty string' }, 400);
      }
      if (typeof body.buildId !== 'string' || body.buildId.trim() === '') {
        return json({ error: 'buildId must be a non-empty string' }, 400);
      }
      const result = await env.REGISTRY_DB.prepare(
        "UPDATE country SET status = 'mapped', build_id = ?, mapped_at = ? WHERE country_code = ?",
      ).bind(body.buildId, new Date().toISOString(), body.countryCode.toUpperCase()).run();
      if (result.meta.changes !== 1) {
        return json({ error: `no country row matched countryCode '${body.countryCode}'` }, 404);
      }
      return json({ ok: true });
    }

    // POST /internal/country-failed  { countryCode }  — the whole run
    // errored (e.g. the Foursquare JWT expired mid-run). Reverts to 'none'
    // so the country can be re-queued — same "never strand it" reasoning as
    // /internal/build-complete's per-Place failure path. WHERE status =
    // 'mapping' guards against a stale/duplicate failure callback clobbering
    // a country that a later, successful run already completed.
    if (url.pathname === '/internal/country-failed' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{ countryCode?: unknown }>().catch(() => null);
      if (typeof body?.countryCode !== 'string' || body.countryCode.trim() === '') {
        return json({ error: 'countryCode must be a non-empty string' }, 400);
      }
      await env.REGISTRY_DB.prepare(
        "UPDATE country SET status = 'none' WHERE country_code = ? AND status = 'mapping'",
      ).bind(body.countryCode.toUpperCase()).run();
      return json({ ok: true });
    }

    const authError = authenticate(request, env);
    if (authError) return authError;

    // GET /poi?lat=&lng=&radius=&type=&attribute=&value=  — POIs of one type
    // within a radius, optionally narrowed to 1-2 attribute values (e.g.
    // type=restaurant&attribute=food_cuisine&value=sushi)
    if (url.pathname === '/poi' && request.method === 'GET') {
      const poiType = url.searchParams.get('type');
      if (!poiType) return json({ error: 'type is required' }, 400);
      const parsed = parseCoordsAndRadius(url);
      if (parsed instanceof Response) return parsed;
      const { lat, lng, radius } = parsed;
      const attributeFilter = parseAttributeFilter(url);
      if (attributeFilter instanceof Response) return attributeFilter;

      const place = await findPlace(env, lat, lng);
      if (!place || place.status !== 'mapped') {
        return json({ covered: false, status: toApiStatus(place?.status ?? 'none'), results: [] });
      }
      const results = await queryPoiDb(env.REGISTRY_DB, lat, lng, radius, poiType, attributeFilter);
      return json({ covered: true, cityId: place.place_id, results });
    }

    // GET /poi/all?lat=&lng=&radius=  — all cached POI types within a radius
    if (url.pathname === '/poi/all' && request.method === 'GET') {
      const parsed = parseCoordsAndRadius(url);
      if (parsed instanceof Response) return parsed;
      const { lat, lng, radius } = parsed;

      const place = await findPlace(env, lat, lng);
      if (!place || place.status !== 'mapped') {
        return json({ covered: false, status: toApiStatus(place?.status ?? 'none'), results: [] });
      }
      const results = await queryPoiDb(env.REGISTRY_DB, lat, lng, radius, null, null);
      return json({ covered: true, cityId: place.place_id, results });
    }

    // GET /coverage?lat=&lng=  — is this location ready / building / none?
    // buildId (KAN-339): lets the client compare against its locally cached
    // download's build_id and skip re-downloading /export/:cityId when
    // nothing changed, without fetching the export file just to check.
    if (url.pathname === '/coverage' && request.method === 'GET') {
      const parsed = parseCoords(url);
      if (parsed instanceof Response) return parsed;
      const { lat, lng } = parsed;

      const place = await findPlace(env, lat, lng);
      return json({ status: toApiStatus(place?.status ?? 'none'), cityId: place?.place_id ?? null, buildId: place?.build_id ?? null });
    }

    // GET /export/:cityId  — the current build's client-download SQLite
    // export (KAN-339), streamed straight from R2. Not a public R2 URL —
    // goes through the same X-Api-Key gate as every other endpoint here,
    // for the same reason: no anonymous access to the POI dataset. Route
    // and param name are unchanged by KAN-355 on purpose — the /export/:cityId
    // -> /export/:placeId rename is explicitly KAN-343's scope, not this
    // ticket's.
    if (url.pathname.startsWith('/export/') && request.method === 'GET') {
      let cityId: string;
      try {
        cityId = decodeURIComponent(url.pathname.slice('/export/'.length));
      } catch {
        // Malformed percent-encoding (e.g. a lone '%' followed by non-hex,
        // or an incomplete UTF-8 sequence) throws URIError — previously
        // unhandled, surfaced as Cloudflare's generic 500 instead of this
        // API's usual clean 400 JSON error.
        return json({ error: 'cityId is not validly percent-encoded' }, 400);
      }
      if (!cityId) return json({ error: 'cityId is required' }, 400);

      const place = await env.REGISTRY_DB.prepare('SELECT * FROM place WHERE place_id = ?').bind(cityId).first<PlaceRow>();
      if (!place || place.status !== 'mapped' || !place.build_id) {
        return json({ error: `city '${cityId}' is not ready` }, 404);
      }

      const object = await env.POI_EXPORTS.get(`exports/${cityId}/${place.build_id}.sqlite`);
      if (!object) {
        // The place row is 'mapped' but the export object is missing — an
        // older build (predating KAN-339) or an upload step that was
        // skipped. Distinct from "not ready" so it's clear this needs a
        // re-run of the export step, not a re-map of the whole Place.
        return json({ error: `export not found for city '${cityId}' build '${place.build_id}'` }, 404);
      }
      return new Response(object.body, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${cityId}-${place.build_id}.sqlite"`,
          'X-Build-Id': place.build_id,
        },
      });
    }

    // POST /coverage/request  { lat, lng }  — record demand for an unmapped
    // area, start mapping it (KAN-354), and answer this location's coverage.
    // A brand new or previously-recorded-but-unmapped Place is atomically
    // promoted 'none' -> 'mapping' and the extraction trigger fires exactly
    // once (startPlaceMapping) — every other concurrent/later request for
    // the same Place just observes 'mapping' and does nothing further.
    // Never extracts inline: this handler always returns promptly, whether
    // or not BUILD_TRIGGER_URL is even configured (a no-op trigger still
    // leaves the row correctly marked 'mapping', just with nothing yet to
    // move it forward — see triggerBuild).
    if (url.pathname === '/coverage/request' && request.method === 'POST') {
      const body = await request.json<{ lat: number; lng: number }>().catch(() => null);
      if (!body || typeof body.lat !== 'number' || typeof body.lng !== 'number') {
        return json({ error: 'lat/lng required' }, 400);
      }
      const { lat, lng } = body;
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        return json({ error: 'lat must be a finite number between -90 and 90' }, 400);
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        return json({ error: 'lng must be a finite number between -180 and 180' }, 400);
      }

      const existing = await findPlace(env, lat, lng);
      if (existing) {
        // findPlace only ever matches a real bbox — i.e. a 'mapped' Place
        // (place_schema.sql) — so this is never a candidate for
        // startPlaceMapping; that only applies to the 'none'/byStableId
        // branches below.
        await bumpCoverageDemand(env, existing);
        return respondCoverageRequest(existing);
      }

      const geo = await resolvePlaceIdentity(lat, lng);
      if (!geo) {
        // Transport failure or an unresolvable point — genuinely unknown,
        // not a real Place. Don't fabricate a demand record without a
        // stable id to dedupe on.
        return respondCoverageRequest(null);
      }

      // findPlace's bbox test above only matches 'mapped' rows (see its own
      // doc comment) — an already-recorded-but-unmapped ('none') Place has
      // no bbox to test against, so dedupe on the stable id itself before
      // considering this "new".
      const byStableId = await env.REGISTRY_DB.prepare('SELECT * FROM place WHERE place_id = ?')
        .bind(geo.placeId).first<PlaceRow>();
      if (byStableId) {
        await bumpCoverageDemand(env, byStableId);
        return respondCoverageRequest(await startPlaceMapping(env, ctx, byStableId));
      }

      // Brand new Place. Budget guard: cap total not-yet-mapped ('none')
      // demand rows so abuse (or a bug hammering distinct coords) can't
      // grow the place table unboundedly before KAN-354 exists to work any
      // of it off. Count-then-insert is best-effort under a concurrent
      // burst, not a hard atomic guarantee — acceptable for a soft budget,
      // not a security boundary.
      const { results: pendingCountRows } = await env.REGISTRY_DB
        .prepare("SELECT COUNT(*) as n FROM place WHERE status = 'none'")
        .all<{ n: number }>();
      if ((pendingCountRows[0]?.n ?? 0) >= MAX_PENDING_DEMAND_PLACES) {
        return json({ error: 'coverage demand budget exceeded, try again later' }, 429);
      }

      const now = new Date().toISOString();
      // Ensure the country row exists before place.country_code can
      // reference it — place_id resolution can hit a country before KAN-354
      // ever queues it (country.status stays 'none' until it does). INSERT
      // OR IGNORE: a race with another request for the same country, or the
      // country pre-build already having created it, must not clobber it.
      if (geo.countryCode) {
        await env.REGISTRY_DB.prepare(
          "INSERT OR IGNORE INTO country (country_code, name, status) VALUES (?, ?, 'none')",
        ).bind(geo.countryCode, geo.countryName ?? geo.countryCode).run();
      }

      // ON CONFLICT DO UPDATE (not INSERT OR IGNORE) so a request that loses
      // the race to a concurrent identical request still counts as demand —
      // both requests bump request_count instead of the loser's demand
      // signal being silently dropped. WHERE status = 'none' guards against
      // clobbering a row that became 'mapped'/'mapping' between our
      // byStableId check and this insert. No bbox is set here — see
      // PlaceRow's doc comment: not a boundary chosen in advance, only ever
      // the extent the worker actually ingests.
      await env.REGISTRY_DB.prepare(
        `INSERT INTO place
           (place_id, country_code, name, place_kind, status, request_count, first_requested_at, last_requested_at)
         VALUES (?, ?, ?, ?, 'none', 1, ?, ?)
         ON CONFLICT(place_id) DO UPDATE SET request_count = request_count + 1, last_requested_at = excluded.last_requested_at
         WHERE status = 'none'`,
      ).bind(
        geo.placeId, geo.countryCode, geo.name, geo.placeKind, now, now,
      ).run();

      const created = await env.REGISTRY_DB.prepare('SELECT * FROM place WHERE place_id = ?')
        .bind(geo.placeId).first<PlaceRow>();
      if (!created) return respondCoverageRequest(null);
      return respondCoverageRequest(await startPlaceMapping(env, ctx, created));
    }

    return json({ error: 'not found' }, 404);
  },
};
