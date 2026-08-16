import { encodeGeohash, haversineMeters, neighborPrefixes, precisionForRadius, requiredGridCells, MAX_GRID_CELLS_PER_AXIS, MAX_RADIUS_METERS } from './geohash';
import { ContainerProxy, getContainer } from '@cloudflare/containers';
import { ExtractionContainer } from './extractionContainer';
import { MANUAL_POI_TYPES, MANUAL_SUBTYPE_FILTERS, normalizePoiName, parseManualPoiInput, isManualPoiInput, type ManualPoiAttribute } from './manualPoi';
import { bearerToken, verifyFirebaseIdToken } from './firebaseAuth';
import brandDictionary from '../../src/constants/brandDictionary.json';
import financialServiceKindDictionary from '../../src/constants/financialServiceKindDictionary.json';

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
  /** KAN-362: server-side only; verifies the public community submission widget. */
  TURNSTILE_SECRET?: string;
  /** Cloudflare Access configuration for moderation-only API routes. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Access audience for the same-origin reviewer route on brushaway.app. */
  ACCESS_REVIEW_AUD?: string;
  MANUAL_POI_ADMIN_EMAILS?: string;
  /**
   * KAN-367 — the Firebase project whose ID tokens this Worker accepts. A
   * plain var, not a secret: it is the public project id, and it must be
   * wrong-project-proof by comparison, not by concealment.
   */
  FIREBASE_PROJECT_ID?: string;
  /** Per-uid limits, replacing the Firestore counters the removed Firebase proxy kept. */
  POI_RATE_LIMITER?: RateLimit;
  COVERAGE_REQUEST_RATE_LIMITER?: RateLimit;
}

/** Shape of a Workers `ratelimits` binding (no ambient type ships with workers-types yet). */
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
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
  /** The settlement's own name (place_schema.sql — NOT NULL). */
  name: string;
  status: 'none' | 'mapping' | 'mapped';
  place_kind: string | null;
  // A mapped Place's area: normally the Foursquare extraction extent, or a
  // real OSM settlement boundary supplied by KAN-378's registry importer.
  // A 'none'/'mapping' demand row has no bbox to fast-path lookups against.
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

// KAN-362's public form is intentionally a narrow CORS surface.  The POI
// API itself remains Firebase-authenticated and must not become browser-open.
const MANUAL_POI_PUBLIC_ORIGIN = 'https://brushaway.app';
const MANUAL_POI_DUPLICATE_DISTANCE_METERS = 20;
const MANUAL_POI_RATE_LIMIT_MAX = 5;
const MANUAL_POI_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;

function manualPoiCorsHeaders(request: Request): Record<string, string> {
  return request.headers.get('Origin') === MANUAL_POI_PUBLIC_ORIGIN
    ? {
      'Access-Control-Allow-Origin': MANUAL_POI_PUBLIC_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    }
    : {};
}

function manualPoiJson(request: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...manualPoiCorsHeaders(request) },
  });
}

const MAX_MANUAL_POI_BODY_BYTES = 32 * 1_024;

async function parseManualPoiJsonBody(request: Request): Promise<unknown | Response> {
  const declaredLength = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MANUAL_POI_BODY_BYTES) {
    return manualPoiJson(request, { error: 'request body is too large' }, 413);
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_MANUAL_POI_BODY_BYTES) {
    return manualPoiJson(request, { error: 'request body is too large' }, 413);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return manualPoiJson(request, { error: 'body must be valid JSON' }, 400);
  }
}

interface ManualPoiSubmissionRow {
  submission_id: string;
  name: string;
  dedupe_name: string;
  lat: number;
  lng: number;
  poi_type: string;
  attributes_json: string;
  address: string | null;
  contributor_note: string | null;
  status: 'pending' | 'approved' | 'rejected';
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
  approved_poi_id: string | null;
}

interface ManualPoiDuplicate {
  poiId: string;
  source: 'foursquare' | 'community';
  name: string;
  lat: number;
  lng: number;
}

function storedManualPoiAttributes(value: string): ManualPoiAttribute[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): ManualPoiAttribute[] => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const attribute = entry as Record<string, unknown>;
      if ((attribute.dimension !== 'food_cuisine' && attribute.dimension !== 'store_kind') || typeof attribute.value !== 'string') return [];
      return [{ dimension: attribute.dimension, value: attribute.value }];
    });
  } catch {
    return [];
  }
}

async function findManualPoiDuplicate(
  db: D1Database,
  dedupeName: string,
  lat: number,
  lng: number,
): Promise<ManualPoiDuplicate | null> {
  const [{ results: foursquareRows }, { results: curatedRows }] = await Promise.all([
    db.prepare('SELECT fsq_place_id AS poi_id, name, lat, lng FROM poi WHERE dedupe_name = ?').bind(dedupeName).all<{ poi_id: string; name: string; lat: number; lng: number }>(),
    db.prepare("SELECT poi_id, name, lat, lng FROM curated_poi WHERE dedupe_name = ? AND status = 'active'").bind(dedupeName).all<{ poi_id: string; name: string; lat: number; lng: number }>(),
  ]);
  const candidates: ManualPoiDuplicate[] = [
    ...foursquareRows.map(row => ({ poiId: row.poi_id, source: 'foursquare' as const, name: row.name, lat: row.lat, lng: row.lng })),
    ...curatedRows.map(row => ({ poiId: row.poi_id, source: 'community' as const, name: row.name, lat: row.lat, lng: row.lng })),
  ];
  return candidates.find(candidate => haversineMeters(lat, lng, candidate.lat, candidate.lng) <= MANUAL_POI_DUPLICATE_DISTANCE_METERS) ?? null;
}

function manualPoiSubmissionResponse(row: Pick<ManualPoiSubmissionRow, 'submission_id' | 'status' | 'approved_poi_id'>) {
  return {
    submissionId: row.submission_id,
    status: row.status,
    ...(row.approved_poi_id ? { approvedPoiId: row.approved_poi_id } : {}),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

function requestIpHash(request: Request): Promise<string> {
  const forwarded = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
  return sha256(forwarded);
}

async function claimManualPoiRateLimit(db: D1Database, ipHash: string): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - MANUAL_POI_RATE_LIMIT_WINDOW_MS).toISOString();
  // The rate-limit table is keyed by a one-hour window. Prune expired rows on
  // the same low-volume public write path so one-off visitors cannot make it
  // grow forever; this happens before the claim and does not affect a current
  // window's count.
  await db.prepare('DELETE FROM manual_poi_rate_limit WHERE window_started_at < ?').bind(cutoffIso).run();
  const result = await db.prepare(
    `INSERT INTO manual_poi_rate_limit (ip_hash, window_started_at, request_count)
     VALUES (?, ?, 1)
     ON CONFLICT(ip_hash) DO UPDATE SET
       window_started_at = CASE WHEN manual_poi_rate_limit.window_started_at < ? THEN excluded.window_started_at ELSE manual_poi_rate_limit.window_started_at END,
       request_count = CASE WHEN manual_poi_rate_limit.window_started_at < ? THEN 1 ELSE manual_poi_rate_limit.request_count + 1 END
     WHERE manual_poi_rate_limit.window_started_at < ? OR manual_poi_rate_limit.request_count < ?`,
  ).bind(ipHash, nowIso, cutoffIso, cutoffIso, cutoffIso, MANUAL_POI_RATE_LIMIT_MAX).run();
  return result.meta.changes === 1;
}

interface TurnstileResult {
  success?: unknown;
  action?: unknown;
  hostname?: unknown;
}

/** Fail closed: a valid Turnstile token is single-use and must belong to the
 * public form's exact action and production hostname. */
async function verifyManualPoiTurnstile(request: Request, env: Env, token: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return false;
  const remoteIp = request.headers.get('CF-Connecting-IP') ?? undefined;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
    });
    if (!response.ok) return false;
    const result = await response.json() as TurnstileResult;
    return result.success === true && result.action === 'manual_poi_submit' && result.hostname === 'brushaway.app';
  } catch {
    return false;
  }
}

function base64UrlBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const raw = atob(padded);
    return Uint8Array.from(raw, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

interface AccessJwtHeader { alg?: unknown; kid?: unknown; }
interface AccessJwtClaims { aud?: unknown; exp?: unknown; nbf?: unknown; email?: unknown; }
interface AccessJwk { kid?: string; kty?: string; n?: string; e?: string; alg?: string; }

let accessJwkCache: { expiresAt: number; keys: AccessJwk[] } | null = null;

async function accessJwks(teamDomain: string): Promise<AccessJwk[] | null> {
  if (accessJwkCache && accessJwkCache.expiresAt > Date.now()) return accessJwkCache.keys;
  try {
    const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const data = await response.json() as { keys?: unknown };
    if (!Array.isArray(data.keys)) return null;
    const keys = data.keys.filter((key): key is AccessJwk => !!key && typeof key === 'object');
    accessJwkCache = { keys, expiresAt: Date.now() + 5 * 60 * 1_000 };
    return keys;
  } catch {
    return null;
  }
}

/** Verifies the Access assertion itself rather than trusting spoofable email
 * headers. The Access application still protects the route at Cloudflare's
 * edge; this is defense in depth for the Worker handler. */
async function verifyManualPoiAdmin(request: Request, env: Env): Promise<string | null> {
  const expectedAudiences = [env.ACCESS_AUD, env.ACCESS_REVIEW_AUD]
    .filter((audience): audience is string => typeof audience === 'string' && audience.trim() !== '');
  if (!env.ACCESS_TEAM_DOMAIN || expectedAudiences.length === 0 || !env.MANUAL_POI_ADMIN_EMAILS) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const headerBytes = base64UrlBytes(encodedHeader);
  const claimBytes = base64UrlBytes(encodedClaims);
  const signature = base64UrlBytes(encodedSignature);
  if (!headerBytes || !claimBytes || !signature) return null;
  let header: AccessJwtHeader;
  let claims: AccessJwtClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes)) as AccessJwtHeader;
    claims = JSON.parse(new TextDecoder().decode(claimBytes)) as AccessJwtClaims;
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  const keys = await accessJwks(env.ACCESS_TEAM_DOMAIN);
  const jwk = keys?.find(key => key.kid === header.kid && key.kty === 'RSA' && key.alg === 'RS256');
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`));
    if (!valid) return null;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1_000);
  if (typeof claims.exp !== 'number' || claims.exp <= now || (typeof claims.nbf === 'number' && claims.nbf > now)) return null;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.some(audience => expectedAudiences.includes(audience)) || typeof claims.email !== 'string') return null;
  const allowedEmails = new Set(env.MANUAL_POI_ADMIN_EMAILS.split(',').map(email => email.trim().toLowerCase()).filter(Boolean));
  return allowedEmails.has(claims.email.toLowerCase()) ? claims.email.toLowerCase() : null;
}

/**
 * The review page and its API share a hostname so the browser uses the same
 * Cloudflare Access session. The Worker keeps its existing API route too, but
 * treats this local route as the identical moderation endpoint.
 */
function manualPoiAdminPathname(pathname: string): string {
  const reviewApiPrefix = '/manual-poi/review/api';
  return pathname.startsWith(`${reviewApiPrefix}/`)
    ? `/manual-poi/admin/${pathname.slice(reviewApiPrefix.length + 1)}`
    : pathname;
}

/**
 * A caller that passed the gate below. `uid` is set only for a verified
 * Firebase ID token — never for the X-Api-Key path, and never from anything
 * the client can assert about itself (KAN-367).
 */
interface Caller { uid: string | null; }

/**
 * Two accepted credentials, in priority order:
 *
 *   Authorization: Bearer <Firebase ID token>  — the app (KAN-367)
 *   X-Api-Key: <API_KEY>                       — the Firebase POI proxy,
 *                                                kept as the rollback path
 *                                                until the direct build is
 *                                                verified in production, plus
 *                                                server-side/ops callers.
 *
 * A bearer token that fails verification is rejected outright rather than
 * falling through to the key check: a client sending a bad token is a client
 * whose token expired or was forged, and silently downgrading it would hide
 * exactly the case this gate exists to catch.
 */
async function authenticate(request: Request, env: Env): Promise<Caller | Response> {
  const token = bearerToken(request);
  if (token) {
    const uid = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID ?? '');
    if (!uid) return json({ error: 'unauthorized' }, 401);
    return { uid };
  }

  if (request.headers.get('X-Api-Key') !== env.API_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }
  return { uid: null };
}

/**
 * Per-user rate limiting on the verified uid, replacing the Firestore
 * transaction the removed Firebase proxy ran per request. Same budgets as
 * that proxy: 30/min for the read-only POI paths, 5/min for coverage demand
 * (which can make the Worker reverse-geocode a brand new municipality).
 *
 * Key-authenticated callers are not limited here — they are our own server
 * side, already limited upstream, and there is no user to key on. Skipping is
 * also the honest failure mode when the binding is absent (local `wrangler
 * dev` without the binding configured): rate limiting is a guard rail, not
 * the authentication boundary.
 */
async function enforceUserRateLimit(caller: Caller, limiter: RateLimit | undefined, action: string): Promise<Response | null> {
  if (!caller.uid || !limiter) return null;
  const { success } = await limiter.limit({ key: `${caller.uid}:${action}` });
  if (success) return null;
  return json({ error: 'rate limit exceeded' }, 429);
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
interface NearbySearchParams extends ParsedCoordsAndRadius { types: string[]; limitPerType: number; }
interface NearbySearchRequest {
  key: string;
  type: string;
  attributeFilter: AttributeFilter | null;
  brand: string | null;
}
interface NearbySearchBody extends ParsedCoordsAndRadius {
  requests: NearbySearchRequest[];
  limitPerRequest: number;
}

const DEFAULT_NEARBY_LIMIT_PER_TYPE = 20;
const MAX_NEARBY_TYPES = 10;
const MAX_NEARBY_REQUESTS = 32;
const MAX_NEARBY_LIMIT_PER_TYPE = 50;

// KAN-344 groups (pizza/asian/…) resolve from raw category labels at query
// time. KAN-362 reuses this exact allowlist for community submissions.
const SUBTYPE_FILTERS: Record<string, { dimension: string; values: readonly string[] }> = {
  ...MANUAL_SUBTYPE_FILTERS,
  financial_service: {
    dimension: 'financial_service_kind',
    values: Object.keys(financialServiceKindDictionary),
  },
};
const BRAND_FILTER_TYPES = new Set(['gym', 'bank', 'store']);
const CANONICAL_BRANDS = new Map(
  Object.entries(brandDictionary).map(([type, brands]) => [
    type,
    new Set((brands as Array<{ name: string }>).map(brand => brand.name)),
  ]),
);

/** Resolve a community submission name to the same canonical value the importer writes. */
function inferCanonicalBrand(poiType: string, name: string): string | null {
  const normalizedName = normalizePoiName(name);
  if (!normalizedName) return null;
  const haystack = ` ${normalizedName} `;
  for (const brand of (brandDictionary[poiType as keyof typeof brandDictionary] ?? []) as Array<{ name: string; aliases: string[] }>) {
    for (const candidate of [brand.name, ...brand.aliases]) {
      const normalizedCandidate = normalizePoiName(candidate);
      if (normalizedCandidate && haystack.includes(` ${normalizedCandidate} `)) return brand.name;
    }
  }
  return null;
}

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

/** Public global-search contract. Types are de-duplicated so a caller cannot
 * accidentally multiply a bucket or its D1 bind parameters. */
function parseNearbySearch(url: URL): NearbySearchParams | Response {
  const parsed = parseCoordsAndRadius(url);
  if (parsed instanceof Response) return parsed;
  const types = [...new Set((url.searchParams.get('types') ?? '').split(',').map(type => type.trim()).filter(Boolean))];
  if (types.length === 0 || types.length > MAX_NEARBY_TYPES) {
    return json({ error: `types must contain between 1 and ${MAX_NEARBY_TYPES} comma-separated values` }, 400);
  }
  const rawLimit = url.searchParams.get('limitPerType');
  const limitPerType = rawLimit === null ? DEFAULT_NEARBY_LIMIT_PER_TYPE : Number(rawLimit);
  if (!Number.isInteger(limitPerType) || limitPerType < 1 || limitPerType > MAX_NEARBY_LIMIT_PER_TYPE) {
    return json({ error: `limitPerType must be an integer between 1 and ${MAX_NEARBY_LIMIT_PER_TYPE}` }, 400);
  }
  return { ...parsed, types, limitPerType };
}

/** Validates the structured POST request used by the authenticated Firebase
 * proxy. A subtype filter is deliberately constrained to the supported
 * and dictionary values the importer writes; this endpoint is not a general
 * arbitrary-attribute query surface. */
function parseNearbySearchBody(body: unknown): NearbySearchBody | Response {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'body must be an object' }, 400);
  }
  const data = body as Record<string, unknown>;
  const lat = data.lat;
  const lng = data.lng;
  const radius = data.radius;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return json({ error: 'lat must be a finite number between -90 and 90' }, 400);
  }
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return json({ error: 'lng must be a finite number between -180 and 180' }, 400);
  }
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0 || radius > MAX_RADIUS_METERS) {
    return json({ error: `radius must be a finite positive number <= ${MAX_RADIUS_METERS}` }, 400);
  }
  const { cellsLat, cellsLng } = requiredGridCells(lat, precisionForRadius(radius), radius);
  if (cellsLat > MAX_GRID_CELLS_PER_AXIS || cellsLng > MAX_GRID_CELLS_PER_AXIS) {
    return json({ error: `radius ${radius}m at this latitude needs a search grid larger than supported (max ${MAX_GRID_CELLS_PER_AXIS} cells/axis)` }, 400);
  }
  if (!Array.isArray(data.requests) || data.requests.length === 0 || data.requests.length > MAX_NEARBY_REQUESTS) {
    return json({ error: `requests must contain between 1 and ${MAX_NEARBY_REQUESTS} entries` }, 400);
  }
  const limitPerRequest = data.limitPerRequest;
  if (typeof limitPerRequest !== 'number' || !Number.isInteger(limitPerRequest) || limitPerRequest < 1 || limitPerRequest > MAX_NEARBY_LIMIT_PER_TYPE) {
    return json({ error: `limitPerRequest must be an integer between 1 and ${MAX_NEARBY_LIMIT_PER_TYPE}` }, 400);
  }

  const keys = new Set<string>();
  const requests: NearbySearchRequest[] = [];
  for (const rawRequest of data.requests) {
    if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
      return json({ error: 'each request must be an object' }, 400);
    }
    const request = rawRequest as Record<string, unknown>;
    if (typeof request.key !== 'string' || request.key.trim() === '' || request.key.length > 80 || keys.has(request.key)) {
      return json({ error: 'each request needs a unique non-empty key of at most 80 characters' }, 400);
    }
    if (typeof request.type !== 'string' || request.type.trim() === '') {
      return json({ error: 'each request needs a non-empty type' }, 400);
    }
    keys.add(request.key);

    let attributeFilter: AttributeFilter | null = null;
    if (request.attribute !== undefined) {
      if (!request.attribute || typeof request.attribute !== 'object' || Array.isArray(request.attribute)) {
        return json({ error: 'attribute must be an object when provided' }, 400);
      }
      const attribute = request.attribute as Record<string, unknown>;
      const allowed = SUBTYPE_FILTERS[request.type];
      if (!allowed || attribute.dimension !== allowed.dimension || !Array.isArray(attribute.values) || attribute.values.length !== 1 || typeof attribute.values[0] !== 'string' || !allowed.values.includes(attribute.values[0])) {
        return json({ error: 'attribute is not a supported subtype filter for this type' }, 400);
      }
      attributeFilter = { dimension: allowed.dimension, values: [attribute.values[0]] };
    }
    let brand: string | null = null;
    if (request.brand !== undefined) {
      if (typeof request.brand !== 'string' || !BRAND_FILTER_TYPES.has(request.type) || !CANONICAL_BRANDS.get(request.type)?.has(request.brand)) {
        return json({ error: 'brand is not a supported canonical brand filter for this type' }, 400);
      }
      brand = request.brand;
    }
    requests.push({ key: request.key, type: request.type, attributeFilter, brand });
  }
  return { lat, lng, radius, requests, limitPerRequest };
}

/**
 * KAN-355/KAN-378 — finds the mapped Place whose stored real extent (min/max
 * lat/lng) contains (lat, lng). The extent comes from either a completed
 * Foursquare extraction or the settlement-metadata registry. A
 * 'none'/'mapping' demand row has no bbox and always falls through to
 * resolvePlaceIdentity + a lookup by stable id instead (see
 * POST /coverage/request). Places can legitimately overlap (a suburb inside
 * a wider neighbour) — picks the smallest-area match among all containing
 * rows, not just the first, so a point inside a suburb's own tighter extent
 * resolves to the suburb. A typed settlement always outranks an untyped
 * legacy row: old extraction records have rectangular Foursquare extents,
 * which can overlap a real settlement far beyond its actual boundary.
 * Linear scan — fine while the place table is small;
 * revisit with geohash bucketing on `place` itself once place count grows
 * (same accepted tradeoff as the pre-KAN-355 circle version).
 */
/**
 * The name to hand a client as "the area you are in", or null when the row we
 * matched is not an area in any useful sense (KAN-377 follow-up).
 *
 * findPlace returns the smallest extent containing the point, which is right
 * for coverage but not for naming: where no settlement row exists yet, the
 * smallest match can be a country. Telling someone in Porto they are in
 * "Portugal" is true and useless, and the client cannot tell the difference,
 * so the judgement belongs here.
 *
 * This is the same rule the extraction pipeline already applies when it
 * refuses country-kind localities (extraction/run_job.py) and gives the
 * country-wide catch-all no extent. `place_kind` is documented in
 * place_schema.sql as reporting-only; that comment predates run_job.py using
 * it for exactly this decision, and this is the same decision.
 */
function areaNameForClient(place: PlaceRow | null): string | null {
  if (!place || place.place_kind === 'country' || place.place_kind === 'generic') { return null; }
  return place.name;
}

async function findPlace(env: Env, lat: number, lng: number): Promise<PlaceRow | null> {
  const { results } = await env.REGISTRY_DB.prepare(
    'SELECT * FROM place WHERE min_lat IS NOT NULL AND ? BETWEEN min_lat AND max_lat AND ? BETWEEN min_lng AND max_lng',
  ).bind(lat, lng).all<PlaceRow>();
  let best: PlaceRow | null = null;
  let bestKindRank = Infinity;
  let bestAreaDeg2 = Infinity;
  for (const row of results) {
    // Country/generic rows are coverage fallbacks. Untyped rows are retained
    // for historical builds, but must not win over a real settlement because
    // their coarse rectangular extent can overlap neighbouring municipalities.
    const kindRank = row.place_kind === 'country' || row.place_kind === 'generic'
      ? 2
      : row.place_kind === null
        ? 1
        : 0;
    const areaDeg2 = (row.max_lat! - row.min_lat!) * (row.max_lng! - row.min_lng!);
    if (kindRank < bestKindRank || (kindRank === bestKindRank && areaDeg2 < bestAreaDeg2)) {
      best = row;
      bestKindRank = kindRank;
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
 * KAN-344: query-time cuisine "groups" for the food_cuisine dimension.
 *
 * These cuisines were never added to the classifier's food dictionary
 * (cloudflare/src/foodSubtypeCategories.json), so no poi_attribute
 * (dimension='food_cuisine', value='pizza'|'asian'|…) row is ever written
 * for them. But the raw Foursquare category is preserved verbatim on every
 * poi row (poi.raw_category_labels — the full taxonomy path), so the
 * umbrella is derivable at read time with no re-classification and no
 * rebuild. Each fragment matches a segment of that path, so 'Asian
 * Restaurant' catches every '… > Asian Restaurant > Chinese/Japanese/Korean
 * /…' leaf in a single clause. 'pizza' returns Pizzerias plus Italian
 * restaurants, the asymmetric relationship the product wants (a Pizzeria is
 * always pizza; an Italian place commonly sells it too).
 *
 * Values NOT listed here (sushi, italian, portuguese, …) keep matching the
 * classified poi_attribute rows exactly as before — this only adds the
 * umbrella cuisines that classification doesn't produce.
 */
const FOOD_CUISINE_LABEL_GROUPS: Record<string, string[]> = {
  asian: ['Asian Restaurant'],
  pizza: ['Pizzeria', 'Italian Restaurant'],
  seafood: ['Seafood Restaurant'],
  brazilian: ['Brazilian Restaurant'],
  mediterranean: ['Mediterranean Restaurant'],
  bbq: ['BBQ Joint'],
};

/**
 * Builds the WHERE fragment for an attribute filter. Each requested value is
 * one OR-branch: a food_cuisine value naming a KAN-344 group matches the raw
 * Foursquare label path (poi.raw_category_labels LIKE '%fragment%'), every
 * other value matches a classified poi_attribute row. Exported (pure, no DB)
 * so the value→SQL routing is unit-testable without a D1. `?` placeholders
 * and `binds` stay positionally aligned — callers splice binds in clause
 * order.
 */
export function buildAttributeFilterClause(filter: AttributeFilter): { clause: string; binds: unknown[] } {
  const orBranches: string[] = [];
  const binds: unknown[] = [];
  for (const value of filter.values) {
    const fragments = filter.dimension === 'food_cuisine'
      ? FOOD_CUISINE_LABEL_GROUPS[value]
      : undefined;
    if (fragments) {
      for (const fragment of fragments) {
        orBranches.push('poi.raw_category_labels LIKE ?');
        binds.push(`%${fragment}%`);
      }
    } else {
      orBranches.push(
        'EXISTS (SELECT 1 FROM poi_attribute WHERE poi_attribute.fsq_place_id = poi.fsq_place_id AND poi_attribute.dimension = ? AND poi_attribute.value = ?)',
      );
      binds.push(filter.dimension, value);
    }
  }
  return { clause: `(${orBranches.join(' OR ')})`, binds };
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
    const attr = buildAttributeFilterClause(attributeFilter);
    clauses.push(attr.clause);
    binds.push(...attr.binds);
  }

  const sql = `SELECT * FROM poi WHERE ${clauses.join(' AND ')}`;

  const { results } = await db.prepare(sql).bind(...binds).all<{
    fsq_place_id: string; name: string; lat: number; lng: number;
    primary_poi_type: string; brand: string | null;
    category_label: string | null; address: string | null;
    open_min: number | null; close_min: number | null;
  }>();

  return results
    .map(r => ({ ...r, distanceMeters: haversineMeters(lat, lng, r.lat, r.lng) }))
    .filter(r => r.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

type NearbyPoi = {
  /** Stable API identity. Foursquare rows use their real fsq_place_id; curated rows use community:<uuid>. */
  poi_id: string;
  /** Present only when Foursquare supplied this POI. Never contains a generated id. */
  fsq_place_id: string | null;
  name: string; lat: number; lng: number;
  primary_poi_type: string; brand: string | null;
  category_label: string | null; address: string | null;
  /** KAN-318: default opening window, minutes from local midnight; null = always open. */
  open_min: number | null; close_min: number | null;
  source?: 'foursquare' | 'community' | 'manual';
  distanceMeters: number;
  attributes: Record<string, string[]>;
};

interface NearbyQueryResult {
  results: Record<string, NearbyPoi[]>;
  timings: { d1Ms: number; filterMs: number };
}

/**
 * KAN-344: matches one attribute value against a nearby-search candidate.
 * A food_cuisine value naming a group (pizza/asian/…) is matched against the
 * candidate's raw Foursquare label path — the same umbrella GET /poi resolves
 * in SQL via buildAttributeFilterClause — because those cuisines have no
 * classified poi_attribute row. Every other value matches a classified
 * poi_attribute value exactly as before.
 */
function attributeValueMatches(
  dimension: string,
  value: string,
  candidate: { attributes: Record<string, string[]>; rawCategoryLabels: string | null },
): boolean {
  if (dimension === 'food_cuisine') {
    const fragments = FOOD_CUISINE_LABEL_GROUPS[value];
    if (fragments) {
      const labels = candidate.rawCategoryLabels ?? '';
      return fragments.some(fragment => labels.includes(fragment));
    }
  }
  return candidate.attributes[dimension]?.includes(value) ?? false;
}

/**
 * KAN-347: global, typed nearby search. POIs are deliberately never joined
 * to Place: the Place that first imported a venue is only coverage metadata.
 * The join is restricted to requested/related types before candidates reach
 * the Worker, then a POI is assigned to each requested type it matches.
 */
async function queryNearbyPoiDb(
  db: D1Database,
  lat: number,
  lng: number,
  radiusMeters: number,
  requestedSearches: NearbySearchRequest[],
  limitPerRequest: number,
): Promise<NearbyQueryResult> {
  const relatedTypes = await Promise.all(requestedSearches.map(request => typesForSearch(db, request.type)));
  const precision = precisionForRadius(radiusMeters);
  const prefixes = neighborPrefixes(lat, lng, precision, radiusMeters);
  const geohashClauses = prefixes.map(() => '(poi.geohash >= ? AND poi.geohash < ?)');
  const curatedGeohashClauses = prefixes.map(() => '(curated_poi.geohash >= ? AND curated_poi.geohash < ?)');
  // Keep a brand-only Gym/Bank request in D1's predicate. A generic request
  // for the same type legitimately broadens its own bucket, but a sole
  // branded request never materialises unrelated candidates in Worker memory.
  const poiRequestClauses: string[] = [];
  const poiRequestBinds: unknown[] = [];
  const curatedRequestClauses: string[] = [];
  const curatedRequestBinds: unknown[] = [];
  for (let index = 0; index < requestedSearches.length; index++) {
    const request = requestedSearches[index];
    const types = relatedTypes[index];
    const placeholders = types.map(() => '?').join(',');
    poiRequestClauses.push(`(poi_type.poi_type IN (${placeholders})${request.brand ? ' AND poi.brand = ?' : ''})`);
    poiRequestBinds.push(...types, ...(request.brand ? [request.brand] : []));
    curatedRequestClauses.push(`(curated_poi.primary_poi_type IN (${placeholders})${request.brand ? ' AND curated_poi.brand = ?' : ''})`);
    curatedRequestBinds.push(...types, ...(request.brand ? [request.brand] : []));
  }
  const d1StartedAt = performance.now();
  const { results: rows } = await db.prepare(
    `SELECT poi.fsq_place_id, poi.dedupe_name, poi.name, poi.lat, poi.lng, poi.primary_poi_type,
            poi.brand, poi.category_label, poi.raw_category_labels, poi.address,
            poi.open_min, poi.close_min, poi_type.poi_type AS matched_type
            , poi_attribute.dimension AS attribute_dimension, poi_attribute.value AS attribute_value
     FROM poi
     INNER JOIN poi_type ON poi_type.fsq_place_id = poi.fsq_place_id
     LEFT JOIN poi_attribute ON poi_attribute.fsq_place_id = poi.fsq_place_id
       AND poi_attribute.dimension IN ('food_cuisine', 'store_kind', 'financial_service_kind')
     WHERE (${geohashClauses.join(' OR ')}) AND (${poiRequestClauses.join(' OR ')})`,
  ).bind(...prefixes.flatMap(prefix => [prefix, `${prefix}~`]), ...poiRequestBinds).all<{
    fsq_place_id: string; dedupe_name: string; name: string; lat: number; lng: number;
    primary_poi_type: string; brand: string | null; category_label: string | null;
    raw_category_labels: string | null;
    address: string | null; open_min: number | null; close_min: number | null; matched_type: string;
    attribute_dimension: string | null; attribute_value: string | null;
  }>();
  const { results: curatedRows } = await db.prepare(
    `SELECT curated_poi.poi_id, curated_poi.dedupe_name, curated_poi.name, curated_poi.lat, curated_poi.lng,
            curated_poi.primary_poi_type, curated_poi.brand, curated_poi.address,
            curated_poi_attribute.dimension AS attribute_dimension, curated_poi_attribute.value AS attribute_value
     FROM curated_poi
     LEFT JOIN curated_poi_attribute ON curated_poi_attribute.poi_id = curated_poi.poi_id
     WHERE curated_poi.status = 'active'
       AND (${curatedGeohashClauses.join(' OR ')})
       AND (${curatedRequestClauses.join(' OR ')})`,
  ).bind(...prefixes.flatMap(prefix => [prefix, `${prefix}~`]), ...curatedRequestBinds).all<{
    poi_id: string; dedupe_name: string; name: string; lat: number; lng: number;
    primary_poi_type: string; brand: string | null; address: string | null;
    attribute_dimension: string | null; attribute_value: string | null;
  }>();
  const d1Ms = performance.now() - d1StartedAt;

  const filteringStartedAt = performance.now();
  const candidates = new Map<string, NearbyPoi & { dedupeName: string; matchedTypes: Set<string>; rawCategoryLabels: string | null }>();
  for (const row of rows) {
    const distanceMeters = haversineMeters(lat, lng, row.lat, row.lng);
    if (distanceMeters > radiusMeters) continue;
    const candidateKey = `foursquare:${row.fsq_place_id}`;
    const existing = candidates.get(candidateKey);
    if (existing) {
      existing.matchedTypes.add(row.matched_type);
      if (row.attribute_dimension && row.attribute_value) {
        const values = existing.attributes[row.attribute_dimension] ??= [];
        if (!values.includes(row.attribute_value)) values.push(row.attribute_value);
      }
    } else {
      candidates.set(candidateKey, {
        poi_id: row.fsq_place_id, fsq_place_id: row.fsq_place_id, name: row.name, lat: row.lat, lng: row.lng,
        primary_poi_type: row.primary_poi_type, brand: row.brand,
        category_label: row.category_label, address: row.address,
        open_min: row.open_min, close_min: row.close_min,
        source: 'foursquare', dedupeName: row.dedupe_name,
        distanceMeters, attributes: row.attribute_dimension && row.attribute_value
          ? { [row.attribute_dimension]: [row.attribute_value] }
          : {},
        matchedTypes: new Set([row.matched_type]),
        rawCategoryLabels: row.raw_category_labels,
      });
    }
  }

  for (const row of curatedRows) {
    const distanceMeters = haversineMeters(lat, lng, row.lat, row.lng);
    if (distanceMeters > radiusMeters) continue;
    const candidateKey = `curated:${row.poi_id}`;
    const existing = candidates.get(candidateKey);
    if (existing) {
      if (row.attribute_dimension && row.attribute_value) {
        const values = existing.attributes[row.attribute_dimension] ??= [];
        if (!values.includes(row.attribute_value)) values.push(row.attribute_value);
      }
    } else {
      candidates.set(candidateKey, {
        poi_id: row.poi_id, fsq_place_id: null, name: row.name, lat: row.lat, lng: row.lng,
        primary_poi_type: row.primary_poi_type, brand: row.brand, category_label: null,
        // Community rows do not carry curated hours yet: NULL keeps KAN-318's
        // safe always-open behaviour rather than hiding an approved POI.
        address: row.address, open_min: null, close_min: null, source: 'community', dedupeName: row.dedupe_name,
        distanceMeters, attributes: row.attribute_dimension && row.attribute_value
          ? { [row.attribute_dimension]: [row.attribute_value] }
          : {},
        matchedTypes: new Set([row.primary_poi_type]), rawCategoryLabels: null,
      });
    }
  }

  // A later Foursquare import may use coordinates a few metres away from the
  // approved community correction. Suppress the curated twin at read time so
  // the user never gets duplicate nearby results; Foursquare wins as the
  // primary data source while the curated audit history stays intact.
  const foursquareCandidates = [...candidates.values()].filter(candidate => candidate.source === 'foursquare');
  for (const [key, candidate] of candidates) {
    if (candidate.source === 'foursquare') continue;
    if (foursquareCandidates.some(foursquare => foursquare.dedupeName === candidate.dedupeName && haversineMeters(foursquare.lat, foursquare.lng, candidate.lat, candidate.lng) <= MANUAL_POI_DUPLICATE_DISTANCE_METERS)) {
      candidates.delete(key);
    }
  }

  const result = Object.fromEntries(requestedSearches.map(request => [request.key, [] as NearbyPoi[]])) as Record<string, NearbyPoi[]>;
  const nearestCandidates = [...candidates.values()].sort((a, b) => a.distanceMeters - b.distanceMeters);
  for (const candidate of nearestCandidates) {
    const poi: NearbyPoi = {
      poi_id: candidate.poi_id, fsq_place_id: candidate.fsq_place_id,
      name: candidate.name, lat: candidate.lat, lng: candidate.lng,
      primary_poi_type: candidate.primary_poi_type, brand: candidate.brand,
      category_label: candidate.category_label, address: candidate.address,
      open_min: candidate.open_min, close_min: candidate.close_min,
      source: candidate.source,
      distanceMeters: candidate.distanceMeters, attributes: candidate.attributes,
    };
    for (let index = 0; index < requestedSearches.length; index++) {
      const request = requestedSearches[index];
      if (result[request.key].length >= limitPerRequest) continue;
      const matchesType = relatedTypes[index].some(type => candidate.matchedTypes.has(type));
      const matchesAttribute = request.attributeFilter == null || request.attributeFilter.values
        .some(value => attributeValueMatches(request.attributeFilter!.dimension, value, candidate));
      const matchesBrand = request.brand == null || candidate.brand === request.brand;
      if (matchesType && matchesAttribute && matchesBrand) {
        result[request.key].push(poi);
      }
    }
  }
  return { results: result, timings: { d1Ms, filterMs: performance.now() - filteringStartedAt } };
}

function jsonWithServerTiming(data: unknown, timings: Record<string, number>): Response {
  const serializationStartedAt = performance.now();
  const body = JSON.stringify(data);
  const serializationMs = performance.now() - serializationStartedAt;
  const timingEntries: Array<[string, number]> = [...Object.entries(timings), ['serialize', serializationMs]];
  const serverTiming = timingEntries
    .map(([name, duration]) => `${name};dur=${duration.toFixed(1)}`)
    .join(', ');
  return new Response(body, { headers: { 'Content-Type': 'application/json', 'Server-Timing': serverTiming } });
}

/** One in sixteen requests emits structured timing to Workers Logs. The event
 * intentionally includes no coordinates, identifiers, or user data. */
function logNearbyTiming(timings: Record<string, number>): void {
  const sample = new Uint8Array(1);
  crypto.getRandomValues(sample);
  if (sample[0] >= 16) return;
  console.log(JSON.stringify({ event: 'poi_nearby_timing', ...timings }));
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
  mode: 'place' | 'country' | 'country-reconcile' | 'settlements',
  target: string,
  countrySourceR2Key?: string,
  countryRunId?: string,
): void {
  const key = `${mode}:${target}:${Date.now()}`;
  const container = getContainer(env.EXTRACTION_CONTAINER, key);
  const startup = container.start({
    envVars: {
      MODE: mode,
      TARGET: target,
      BUILD_TRIGGER_SECRET: env.BUILD_TRIGGER_SECRET ?? '',
      FOURSQUARE_JWT: env.FOURSQUARE_JWT ?? '',
      ...(countrySourceR2Key ? { COUNTRY_SOURCE_R2_KEY: countrySourceR2Key } : {}),
      ...(countryRunId ? { COUNTRY_RUN_ID: countryRunId } : {}),
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
    } else if (mode === 'settlements') {
      await env.REGISTRY_DB.prepare(
        "UPDATE settlement_registry_import SET status = 'failed', completed_at = ?, last_error = ? WHERE country_code = ? AND status = 'mapping'",
      ).bind(new Date().toISOString(), 'container start failed', target).run();
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

/** Queue the metadata-only settlement registry exactly once per country run. */
async function queueSettlementRegistry(
  env: Env,
  ctx: ExecutionContext | undefined,
  countryCode: string,
): Promise<'none' | 'mapping' | 'mapped' | 'failed'> {
  const result = await env.REGISTRY_DB.prepare(
    `INSERT INTO settlement_registry_import (country_code, status, started_at, completed_at, last_error)
     VALUES (?, 'mapping', ?, NULL, NULL)
     ON CONFLICT(country_code) DO UPDATE SET
       status = 'mapping', started_at = excluded.started_at, completed_at = NULL, last_error = NULL
     WHERE settlement_registry_import.status IN ('none', 'failed')`,
  ).bind(countryCode, new Date().toISOString()).run();
  if (result.meta.changes === 1) triggerBuild(env, ctx, 'settlements', countryCode);
  const registry = await env.REGISTRY_DB.prepare(
    'SELECT status FROM settlement_registry_import WHERE country_code = ?',
  ).bind(countryCode).first<{ status: 'none' | 'mapping' | 'mapped' | 'failed' }>();
  return registry?.status ?? 'none';
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
    const manualAdminPath = manualPoiAdminPathname(url.pathname);

    // KAN-362: the public contribution form is the only browser-open surface
    // on this Worker. Keep it ahead of the API-key gate and narrowly CORSed to
    // brushaway.app; every existing POI endpoint remains authenticated below.
    if (url.pathname.startsWith('/manual-poi/') && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: manualPoiCorsHeaders(request) });
    }

    if (url.pathname === '/manual-poi/meta' && request.method === 'GET') {
      return manualPoiJson(request, {
        poiTypes: MANUAL_POI_TYPES,
        subtypeFilters: MANUAL_SUBTYPE_FILTERS,
      });
    }

    if (url.pathname === '/manual-poi/duplicates' && request.method === 'GET') {
      const name = url.searchParams.get('name') ?? '';
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lng'));
      const dedupeName = normalizePoiName(name);
      if (!dedupeName || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        return manualPoiJson(request, { error: 'name, lat, and lng are required' }, 400);
      }
      const duplicate = await findManualPoiDuplicate(env.REGISTRY_DB, dedupeName, lat, lng);
      // This is only a form warning. It exposes no IDs or addresses and does
      // not stop a contributor from submitting a correction for review.
      return manualPoiJson(request, { duplicate: duplicate ? { name: duplicate.name, source: duplicate.source } : null });
    }

    if (url.pathname === '/manual-poi/submissions' && request.method === 'POST') {
      const rawBody = await parseManualPoiJsonBody(request);
      if (rawBody instanceof Response) return rawBody;
      const parsed = parseManualPoiInput(rawBody);
      if (!isManualPoiInput(parsed)) return manualPoiJson(request, { error: parsed.error }, 400);

      // Check idempotency before consuming a single-use Turnstile token or a
      // rate-limit slot. This makes a lost HTTP response safe to retry.
      const existing = await env.REGISTRY_DB.prepare(
        'SELECT submission_id, status, approved_poi_id FROM manual_poi_submission WHERE idempotency_key = ?',
      ).bind(parsed.idempotencyKey).first<Pick<ManualPoiSubmissionRow, 'submission_id' | 'status' | 'approved_poi_id'>>();
      if (existing) return manualPoiJson(request, { ...manualPoiSubmissionResponse(existing), idempotent: true });

      const ipHash = await requestIpHash(request);
      if (!await claimManualPoiRateLimit(env.REGISTRY_DB, ipHash)) {
        return manualPoiJson(request, { error: 'too many submissions, try again later' }, 429);
      }
      if (!await verifyManualPoiTurnstile(request, env, parsed.turnstileToken)) {
        return manualPoiJson(request, { error: 'verification failed; please try again' }, 400);
      }

      const submittedAt = new Date().toISOString();
      const submissionId = crypto.randomUUID();
      await env.REGISTRY_DB.batch([
        env.REGISTRY_DB.prepare(
          `INSERT INTO manual_poi_submission
             (submission_id, idempotency_key, name, dedupe_name, lat, lng, poi_type, attributes_json, address, contributor_note, ip_hash, status, submitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ).bind(
          submissionId, parsed.idempotencyKey, parsed.name, normalizePoiName(parsed.name), parsed.lat, parsed.lng,
          parsed.poiType, JSON.stringify(parsed.attributes), parsed.address, parsed.contributorNote, ipHash, submittedAt,
        ),
        env.REGISTRY_DB.prepare(
          'INSERT INTO manual_poi_audit (audit_id, target_kind, target_id, action, actor, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).bind(crypto.randomUUID(), 'submission', submissionId, 'submitted', 'public', JSON.stringify({ poiType: parsed.poiType }), submittedAt),
      ]);
      return manualPoiJson(request, { submissionId, status: 'pending' }, 202);
    }

    if (manualAdminPath === '/manual-poi/admin/submissions' && request.method === 'GET') {
      const reviewer = await verifyManualPoiAdmin(request, env);
      if (!reviewer) return manualPoiJson(request, { error: 'forbidden' }, 403);
      const status = url.searchParams.get('status') ?? 'pending';
      if (status !== 'pending' && status !== 'approved' && status !== 'rejected') {
        return manualPoiJson(request, { error: 'status must be pending, approved, or rejected' }, 400);
      }
      const { results } = await env.REGISTRY_DB.prepare(
        `SELECT submission_id, name, dedupe_name, lat, lng, poi_type, attributes_json, address, contributor_note,
                status, submitted_at, reviewed_at, reviewed_by, rejection_reason, approved_poi_id
         FROM manual_poi_submission WHERE status = ? ORDER BY submitted_at ASC LIMIT 100`,
      ).bind(status).all<ManualPoiSubmissionRow>();
      return manualPoiJson(request, {
        submissions: results.map(row => ({
          ...manualPoiSubmissionResponse(row), name: row.name, lat: row.lat, lng: row.lng, poiType: row.poi_type,
          attributes: storedManualPoiAttributes(row.attributes_json), address: row.address, contributorNote: row.contributor_note,
          submittedAt: row.submitted_at, reviewedAt: row.reviewed_at, reviewedBy: row.reviewed_by, rejectionReason: row.rejection_reason,
        })),
      });
    }

    const manualAdminMatch = manualAdminPath.match(/^\/manual-poi\/admin\/submissions\/([^/]+)$/);
    if (manualAdminMatch && request.method === 'PATCH') {
      const reviewer = await verifyManualPoiAdmin(request, env);
      if (!reviewer) return manualPoiJson(request, { error: 'forbidden' }, 403);
      let submissionId: string;
      try {
        submissionId = decodeURIComponent(manualAdminMatch[1]);
      } catch {
        return manualPoiJson(request, { error: 'submission id is invalid' }, 400);
      }
      if (!submissionId) return manualPoiJson(request, { error: 'submission id is required' }, 400);
      const rawBody = await parseManualPoiJsonBody(request);
      if (rawBody instanceof Response) return rawBody;
      if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) return manualPoiJson(request, { error: 'body must be an object' }, 400);
      const body = rawBody as Record<string, unknown>;
      if (body.action !== 'approve' && body.action !== 'reject') return manualPoiJson(request, { error: 'action must be approve or reject' }, 400);
      const reason = body.reason === undefined || body.reason === null ? null : typeof body.reason === 'string' ? body.reason.trim() : null;
      if (body.reason !== undefined && body.reason !== null && (reason === null || reason.length > 600)) {
        return manualPoiJson(request, { error: 'reason must be a string of at most 600 characters' }, 400);
      }
      const submission = await env.REGISTRY_DB.prepare('SELECT * FROM manual_poi_submission WHERE submission_id = ?')
        .bind(submissionId).first<ManualPoiSubmissionRow>();
      if (!submission) return manualPoiJson(request, { error: 'submission not found' }, 404);
      if (submission.status !== 'pending') return manualPoiJson(request, { error: 'submission has already been reviewed' }, 409);

      const reviewedAt = new Date().toISOString();
      if (body.action === 'reject') {
        await env.REGISTRY_DB.batch([
          env.REGISTRY_DB.prepare(
            "UPDATE manual_poi_submission SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, rejection_reason = ? WHERE submission_id = ? AND status = 'pending'",
          ).bind(reviewedAt, reviewer, reason, submissionId),
          env.REGISTRY_DB.prepare(
            'INSERT INTO manual_poi_audit (audit_id, target_kind, target_id, action, actor, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).bind(crypto.randomUUID(), 'submission', submissionId, 'rejected', reviewer, JSON.stringify({ reason }), reviewedAt),
        ]);
        return manualPoiJson(request, { submissionId, status: 'rejected' });
      }

      const duplicate = await findManualPoiDuplicate(env.REGISTRY_DB, submission.dedupe_name, submission.lat, submission.lng);
      if (duplicate) {
        await env.REGISTRY_DB.batch([
          env.REGISTRY_DB.prepare(
            "UPDATE manual_poi_submission SET status = 'approved', reviewed_at = ?, reviewed_by = ?, approved_poi_id = ? WHERE submission_id = ? AND status = 'pending'",
          ).bind(reviewedAt, reviewer, duplicate.poiId, submissionId),
          env.REGISTRY_DB.prepare(
            'INSERT INTO manual_poi_audit (audit_id, target_kind, target_id, action, actor, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).bind(crypto.randomUUID(), 'submission', submissionId, 'merged_duplicate', reviewer, JSON.stringify({ poiId: duplicate.poiId, source: duplicate.source }), reviewedAt),
        ]);
        return manualPoiJson(request, { submissionId, status: 'approved', approvedPoiId: duplicate.poiId, mergedDuplicate: true });
      }

      const poiId = `community:${crypto.randomUUID()}`;
      const attributes = storedManualPoiAttributes(submission.attributes_json);
      const brand = inferCanonicalBrand(submission.poi_type, submission.name);
      const statements = [
        env.REGISTRY_DB.prepare(
          `INSERT INTO curated_poi
             (poi_id, source, source_submission_id, name, dedupe_name, lat, lng, geohash, primary_poi_type, brand, address, status, created_at, created_by, updated_at, updated_by)
           VALUES (?, 'community', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        ).bind(poiId, submissionId, submission.name, submission.dedupe_name, submission.lat, submission.lng, encodeGeohash(submission.lat, submission.lng, 7), submission.poi_type, brand, submission.address, reviewedAt, reviewer, reviewedAt, reviewer),
        ...attributes.map(attribute => env.REGISTRY_DB.prepare(
          'INSERT INTO curated_poi_attribute (poi_id, dimension, value) VALUES (?, ?, ?)',
        ).bind(poiId, attribute.dimension, attribute.value)),
        env.REGISTRY_DB.prepare(
          "UPDATE manual_poi_submission SET status = 'approved', reviewed_at = ?, reviewed_by = ?, approved_poi_id = ? WHERE submission_id = ? AND status = 'pending'",
        ).bind(reviewedAt, reviewer, poiId, submissionId),
        env.REGISTRY_DB.prepare(
          'INSERT INTO manual_poi_audit (audit_id, target_kind, target_id, action, actor, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).bind(crypto.randomUUID(), 'submission', submissionId, 'approved', reviewer, JSON.stringify({ poiId, brand }), reviewedAt),
        env.REGISTRY_DB.prepare(
          'INSERT INTO manual_poi_audit (audit_id, target_kind, target_id, action, actor, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).bind(crypto.randomUUID(), 'curated_poi', poiId, 'created', reviewer, JSON.stringify({ submissionId }), reviewedAt),
      ];
      await env.REGISTRY_DB.batch(statements);
      return manualPoiJson(request, { submissionId, status: 'approved', approvedPoiId: poiId });
    }

    // Internal, server-to-server only — its own stronger secret, not the
    // public X-Api-Key gate below.
    if (url.pathname === '/internal/build-complete' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{
        cityId?: unknown; buildId?: unknown; rowsLoaded?: unknown; rowsSkipped?: unknown; deduplicated?: unknown; status?: unknown; r2Key?: unknown;
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
    // not automatically. Queuing an already-mapping/mapped country is a
    // no-op. A stopped run must use the reconciliation route below, which
    // resumes from its durable source rather than starting over.
    //
    if (url.pathname === '/internal/country/queue' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{ countryCode?: unknown }>().catch(() => null);
      if (typeof body?.countryCode !== 'string' || body.countryCode.trim() === '') {
        return json({ error: 'countryCode must be a non-empty string' }, 400);
      }
      const countryCode = body.countryCode.toUpperCase();
      const now = new Date().toISOString();
      const runId = crypto.randomUUID();
      const result = await env.REGISTRY_DB.prepare(
        `UPDATE country
         SET status = 'mapping', place_count = 0, last_run_started_at = ?,
             last_failure_stage = NULL, last_failure_error = NULL, last_failed_at = NULL, active_run_id = ?
         WHERE country_code = ? AND status = 'none'`,
      ).bind(now, runId, countryCode).run();
      if (result.meta.changes === 1) triggerBuild(env, ctx, 'country', countryCode, undefined, runId);
      const country = await env.REGISTRY_DB.prepare('SELECT * FROM country WHERE country_code = ?')
        .bind(countryCode).first<{ status: string }>();
      if (!country) return json({ error: `no country row for '${countryCode}' — it must exist before it can be queued` }, 404);
      return json({ ok: true, status: country.status });
    }

    // POST /internal/settlement-registry/queue { countryCode } — imports
    // only bounded OSM settlement metadata after a country's Foursquare POIs
    // are already mapped. This is deliberately a separate job: it never
    // reads, reclassifies, or reloads those POIs.
    if (url.pathname === '/internal/settlement-registry/queue' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{ countryCode?: unknown }>().catch(() => null);
      if (typeof body?.countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(body.countryCode)) {
        return json({ error: 'countryCode must be a two-letter ISO code' }, 400);
      }
      const countryCode = body.countryCode.toUpperCase();
      const country = await env.REGISTRY_DB.prepare('SELECT * FROM country WHERE country_code = ?')
        .bind(countryCode).first<{ status: string }>();
      if (!country) return json({ error: `no country row for '${countryCode}'` }, 404);
      if (country.status !== 'mapped') {
        return json({ error: `country '${countryCode}' must be mapped before settlement metadata is queued` }, 409);
      }
      return json({ ok: true, status: await queueSettlementRegistry(env, ctx, countryCode) });
    }

    // POST /internal/country-source — records the raw country extract as
    // soon as it exists. Later recovery uses this artifact, never Foursquare.
    if (url.pathname === '/internal/country-source' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{ countryCode?: unknown; runId?: unknown; rawExtractR2Key?: unknown }>().catch(() => null);
      if (typeof body?.countryCode !== 'string' || typeof body.runId !== 'string' || typeof body.rawExtractR2Key !== 'string' || !body.rawExtractR2Key.startsWith('country-sources/')) {
        return json({ error: 'countryCode, runId, and a country-sources rawExtractR2Key are required' }, 400);
      }
      await env.REGISTRY_DB.prepare(
        "UPDATE country SET source_raw_extract_r2_key = ? WHERE country_code = ? AND status = 'mapping' AND active_run_id = ?",
      ).bind(body.rawExtractR2Key, body.countryCode.toUpperCase(), body.runId).run();
      return json({ ok: true });
    }

    // POST /internal/country/reconcile — starts only the missing generic,
    // audit, and completion tail from a previously saved country source.
    if (url.pathname === '/internal/country/reconcile' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{ countryCode?: unknown; rawExtractR2Key?: unknown }>().catch(() => null);
      if (typeof body?.countryCode !== 'string' || typeof body.rawExtractR2Key !== 'string' || body.rawExtractR2Key.trim() === '') {
        return json({ error: 'countryCode and rawExtractR2Key are required' }, 400);
      }
      const countryCode = body.countryCode.toUpperCase();
      const rawExtractR2Key = body.rawExtractR2Key;
      const runId = crypto.randomUUID();
      const result = await env.REGISTRY_DB.prepare(
        `UPDATE country
         SET status = 'mapping', source_raw_extract_r2_key = ?, last_run_started_at = ?,
             last_failure_stage = NULL, last_failure_error = NULL, last_failed_at = NULL, active_run_id = ?
         WHERE country_code = ? AND status IN ('none', 'mapping')`,
      ).bind(rawExtractR2Key, new Date().toISOString(), runId, countryCode).run();
      if (result.meta.changes === 1) triggerBuild(env, ctx, 'country-reconcile', countryCode, rawExtractR2Key, runId);
      const country = await env.REGISTRY_DB.prepare('SELECT * FROM country WHERE country_code = ?')
        .bind(countryCode).first<{ status: string }>();
      if (!country) return json({ error: `no country row for '${countryCode}'` }, 404);
      return json({ ok: true, status: country.status });
    }

    // POST /internal/country-progress  { countryCode }  — called by the
    // country-mode Job once per Place it finishes mapping, so place_count
    // reflects real progress rather than only flipping at the very end
    // (KAN-354 AC1: "progress visible on the country row").
    if (url.pathname === '/internal/country-progress' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{ countryCode?: unknown; runId?: unknown; placeId?: unknown }>().catch(() => null);
      if (typeof body?.countryCode !== 'string' || body.countryCode.trim() === '' ||
          typeof body.runId !== 'string' || body.runId.trim() === '' ||
          typeof body.placeId !== 'string' || body.placeId.trim() === '') {
        return json({ error: 'countryCode, runId, and placeId must be non-empty strings' }, 400);
      }
      const countryCode = body.countryCode.toUpperCase();
      const delivery = await env.REGISTRY_DB.prepare(
        `INSERT OR IGNORE INTO country_progress_delivery (country_code, run_id, place_id)
         SELECT ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM country WHERE country_code = ? AND status = 'mapping' AND active_run_id = ?
         )`,
      ).bind(countryCode, body.runId, body.placeId, countryCode, body.runId).run();
      if (delivery.meta.changes === 1) {
        await env.REGISTRY_DB.prepare(
          "UPDATE country SET place_count = place_count + 1 WHERE country_code = ? AND status = 'mapping' AND active_run_id = ?",
        ).bind(countryCode, body.runId).run();
      }
      return json({ ok: true, applied: delivery.meta.changes === 1 });
    }

    // POST /internal/country-audit — the country Container submits its
    // full-source accounting after the mandatory generic pass. Persist it
    // before marking coverage ready: logs expire, this proof must not.
    if (url.pathname === '/internal/country-audit' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<Record<string, unknown>>().catch(() => null);
      const numericFields = ['sourceRows', 'rowsWithLocality', 'rowsWithoutLocality', 'rowsLoaded', 'rowsSkipped', 'resolvedLocalities', 'unresolvedLocalities', 'failedPlaces'] as const;
      if (!body || typeof body.countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(body.countryCode) ||
          typeof body.runId !== 'string' || body.runId.trim() === '' ||
          typeof body.buildId !== 'string' || body.buildId.trim() === '' ||
          numericFields.some(field => typeof body[field] !== 'number' || !Number.isSafeInteger(body[field]) || (body[field] as number) < 0)) {
        return json({ error: 'countryCode, runId, buildId, and non-negative integer audit counts are required' }, 400);
      }
      const sourceRows = body.sourceRows as number;
      const rowsWithLocality = body.rowsWithLocality as number;
      const rowsWithoutLocality = body.rowsWithoutLocality as number;
      const rowsLoaded = body.rowsLoaded as number;
      const rowsSkipped = body.rowsSkipped as number;
      const failedPlaces = body.failedPlaces as number;
      if (failedPlaces > 0) {
        return json({ error: 'country audit cannot be complete with failed Places' }, 409);
      }
      if (sourceRows !== rowsLoaded + rowsSkipped || sourceRows !== rowsWithLocality + rowsWithoutLocality) {
        return json({ error: 'country audit counts do not reconcile' }, 409);
      }
      const countryCode = body.countryCode.toUpperCase();
      const inserted = await env.REGISTRY_DB.prepare(
        `INSERT OR IGNORE INTO country_import_audit
          (build_id, country_code, source_rows, rows_with_locality, rows_without_locality, rows_loaded, rows_skipped, resolved_localities, unresolved_localities, failed_places, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM country WHERE country_code = ? AND status = 'mapping' AND active_run_id = ?
         )`,
      ).bind(
        body.buildId, countryCode, sourceRows, rowsWithLocality, rowsWithoutLocality,
        rowsLoaded, rowsSkipped, body.resolvedLocalities, body.unresolvedLocalities,
        failedPlaces, new Date().toISOString(), countryCode, body.runId,
      ).run();
      if (inserted.meta.changes === 1) return json({ ok: true, applied: true });
      const existing = await env.REGISTRY_DB.prepare(
        'SELECT build_id FROM country_import_audit WHERE build_id = ? AND country_code = ?',
      ).bind(body.buildId, countryCode).first<{ build_id: string }>();
      if (existing) return json({ ok: true, applied: false });
      const country = await env.REGISTRY_DB.prepare('SELECT country_code FROM country WHERE country_code = ?')
        .bind(countryCode).first<{ country_code: string }>();
      if (!country) return json({ error: `no country row matched countryCode '${countryCode}'` }, 404);
      return json({ ok: true, applied: false, ignored: true });
    }

    // POST /internal/country-complete  { countryCode, buildId }  — the whole
    // country finished (every Place attempted, per-Place results already
    // recorded via /internal/build-complete + /internal/country-progress).
    if (url.pathname === '/internal/country-complete' && request.method === 'POST') {
      const internalAuthError = authenticateInternal(request, env);
      if (internalAuthError) return internalAuthError;
      const body = await request.json<{ countryCode?: unknown; runId?: unknown; buildId?: unknown }>().catch(() => null);
      if (typeof body?.countryCode !== 'string' || body.countryCode.trim() === '') {
        return json({ error: 'countryCode must be a non-empty string' }, 400);
      }
      if (typeof body.buildId !== 'string' || body.buildId.trim() === '') {
        return json({ error: 'buildId must be a non-empty string' }, 400);
      }
      if (typeof body.runId !== 'string' || body.runId.trim() === '') {
        return json({ error: 'runId must be a non-empty string' }, 400);
      }
      const result = await env.REGISTRY_DB.prepare(
        `UPDATE country SET status = 'mapped', build_id = ?, mapped_at = ?
         WHERE country_code = ? AND status = 'mapping' AND active_run_id = ?
           AND EXISTS (
             SELECT 1 FROM country_import_audit
             WHERE country_code = ? AND build_id = ? AND failed_places = 0
           )`,
      ).bind(body.buildId, new Date().toISOString(), body.countryCode.toUpperCase(), body.runId, body.countryCode.toUpperCase(), body.buildId).run();
      if (result.meta.changes !== 1) {
        return json({ error: `no mapping country with a valid audit matched '${body.countryCode}'` }, 409);
      }
      // A Foursquare country run may have no locality field at all. Start
      // the independent registry now so a green country import never masks
      // a missing settlement/area-name backfill.
      const countryCode = body.countryCode.toUpperCase();
      const settlementRegistryStatus = await queueSettlementRegistry(env, ctx, countryCode);
      return json({ ok: true, settlementRegistryStatus });
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
      const body = await request.json<{ countryCode?: unknown; runId?: unknown; stage?: unknown; error?: unknown }>().catch(() => null);
      if (typeof body?.countryCode !== 'string' || body.countryCode.trim() === '') {
        return json({ error: 'countryCode must be a non-empty string' }, 400);
      }
      if (typeof body.runId !== 'string' || body.runId.trim() === '') {
        return json({ error: 'runId must be a non-empty string' }, 400);
      }
      await env.REGISTRY_DB.prepare(
        `UPDATE country SET status = 'none', last_failure_stage = ?, last_failure_error = ?, last_failed_at = ?
         WHERE country_code = ? AND status = 'mapping' AND active_run_id = ?`,
      ).bind(
        typeof body.stage === 'string' ? body.stage.slice(0, 100) : 'unknown',
        typeof body.error === 'string' ? body.error.slice(0, 1_000) : 'unknown',
        new Date().toISOString(), body.countryCode.toUpperCase(), body.runId,
      ).run();
      return json({ ok: true });
    }

    const caller = await authenticate(request, env);
    if (caller instanceof Response) return caller;

    // GET /poi/nearby?lat=&lng=&radius=&types=cafe,pharmacy&limitPerType=20
    // Backwards-compatible KAN-347 hot path. Coverage/Place resolution is
    // intentionally absent and happens only after a settled zero result.
    if (url.pathname === '/poi/nearby' && request.method === 'GET') {
      const limited = await enforceUserRateLimit(caller, env.POI_RATE_LIMITER, 'poiAll');
      if (limited) return limited;
      const parsed = parseNearbySearch(url);
      if (parsed instanceof Response) return parsed;
      const { lat, lng, radius, types, limitPerType } = parsed;
      const startedAt = performance.now();
      const searches = types.map(type => ({ key: type, type, attributeFilter: null, brand: null }));
      const { results, timings } = await queryNearbyPoiDb(env.REGISTRY_DB, lat, lng, radius, searches, limitPerType);
      const totalMs = performance.now() - startedAt;
      logNearbyTiming({ d1: timings.d1Ms, filter: timings.filterMs, total: totalMs });
      return jsonWithServerTiming(
        { results },
        { d1: timings.d1Ms, filter: timings.filterMs, total: totalMs },
      );
    }

    // POST /poi/nearby — structured, request-keyed subtype search, called
    // directly by the app with its Firebase ID token (KAN-367). Each request
    // has its own limit, so a broad restaurant bucket cannot crowd out a
    // requested cuisine.
    if (url.pathname === '/poi/nearby' && request.method === 'POST') {
      const limited = await enforceUserRateLimit(caller, env.POI_RATE_LIMITER, 'poiAll');
      if (limited) return limited;
      const body = await request.json().catch(() => null);
      const parsed = parseNearbySearchBody(body);
      if (parsed instanceof Response) return parsed;
      const { lat, lng, radius, requests, limitPerRequest } = parsed;
      const startedAt = performance.now();
      // KAN-377 — the settlement's name rides along with the POIs it belongs
      // to, so the client can name an area offline anywhere it holds places,
      // instead of only the ~100m cells it reverse-geocoded while online.
      // Run alongside the POI query, never after it: findPlace is a separate
      // D1 read and this is the hottest endpoint here, so it must not add its
      // latency to the response.
      const [{ results, timings }, place] = await Promise.all([
        queryNearbyPoiDb(env.REGISTRY_DB, lat, lng, radius, requests, limitPerRequest),
        findPlace(env, lat, lng),
      ]);
      const totalMs = performance.now() - startedAt;
      logNearbyTiming({ d1: timings.d1Ms, filter: timings.filterMs, total: totalMs });
      return jsonWithServerTiming(
        { results, placeName: areaNameForClient(place) },
        { d1: timings.d1Ms, filter: timings.filterMs, total: totalMs },
      );
    }

    // GET /poi?lat=&lng=&radius=&type=&attribute=&value=  — POIs of one type
    // within a radius, optionally narrowed to 1-2 attribute values (e.g.
    // type=restaurant&attribute=food_cuisine&value=sushi)
    if (url.pathname === '/poi' && request.method === 'GET') {
      const limited = await enforceUserRateLimit(caller, env.POI_RATE_LIMITER, 'poi');
      if (limited) return limited;
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
      const limited = await enforceUserRateLimit(caller, env.POI_RATE_LIMITER, 'poiAll');
      if (limited) return limited;
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
      const limited = await enforceUserRateLimit(caller, env.POI_RATE_LIMITER, 'coverage');
      if (limited) return limited;
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
      // Its own budget rather than the shared read one: each hit streams a
      // multi-megabyte R2 object, by far the most expensive thing a token
      // holder can ask for repeatedly.
      const limited = await enforceUserRateLimit(caller, env.COVERAGE_REQUEST_RATE_LIMITER, 'export');
      if (limited) return limited;
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
      const limited = await enforceUserRateLimit(caller, env.COVERAGE_REQUEST_RATE_LIMITER, 'requestCoverage');
      if (limited) return limited;
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

      // Country-wide rows are coverage fallbacks, not a new Place to map.
      // A country bbox would make the on-demand worker extract the whole
      // country for one coordinate. Country provisioning owns that lifecycle.
      if (geo.placeKind === 'country') return respondCoverageRequest(null);

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
