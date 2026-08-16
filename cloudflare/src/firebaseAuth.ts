/**
 * firebaseAuth.ts — Firebase ID token verification at the edge (KAN-367).
 *
 * The app used to reach this Worker through three Firebase callables
 * (cloudflareCoverageProxy / cloudflarePoiAllProxy /
 * cloudflareRequestCoverageProxy), whose only real job was holding the
 * X-Api-Key secret and asserting `request.auth`. Verifying the same Firebase
 * ID token here removes that hop entirely — identity still comes from
 * Firebase Auth, it is just checked where the data already lives.
 *
 * Verification is deliberately hand-rolled against WebCrypto rather than
 * firebase-admin: that SDK targets Node (crypto, fs, grpc) and cannot run in
 * a Worker isolate. The checks below are the full set the Firebase docs
 * require for a session-cookie-free ID token:
 *
 *   alg  RS256                    (never 'none', never HS256 — a token signed
 *                                  with a symmetric key we know nothing about
 *                                  must not validate)
 *   kid  present, matches a published Google signing key
 *   sig  verified against that key
 *   iss  https://securetoken.google.com/<projectId>
 *   aud  <projectId>              (a token minted for another Firebase
 *                                  project is otherwise a perfectly valid
 *                                  Google-signed token)
 *   exp  in the future
 *   iat  not in the future
 *   sub  non-empty — this is the uid, and the ONLY source of it. Nothing
 *        here ever reads a uid from the request body or a header.
 */

/**
 * Google's public JWKs for Firebase ID tokens. The x509 endpoint is the one
 * the Firebase docs name, but it serves PEM certificates, which WebCrypto's
 * importKey cannot take (it accepts spki/pkcs8/raw/jwk, not X.509). This JWK
 * form of the same key set is directly importable.
 */
const FIREBASE_JWK_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/** Small tolerance for clock skew between Google's signer and this isolate. */
const CLOCK_SKEW_SECONDS = 60;

/** Used only when the JWK response carries no usable Cache-Control max-age. */
const DEFAULT_KEY_CACHE_TTL_MS = 60 * 60 * 1_000;

/**
 * Floor between key fetches triggered by an unknown `kid` against an
 * otherwise-fresh cache. Google rotating early is the case worth refreshing
 * for; without this floor, anyone can also force one googleapis round trip
 * per request by sending tokens with random kids — the claim checks that run
 * first are all forgeable without a signature, so that path must not be free.
 */
const MIN_KEY_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

interface JwkSet {
  keys: Array<JsonWebKey & { kid?: string }>;
}

interface KeyCache {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
  expiresAt: number;
}

/**
 * Module scope, so the keys survive for the life of the isolate and the
 * fetch happens once per key rotation rather than once per request (a
 * per-request round trip to googleapis.com would add more latency than the
 * Firebase hop this ticket removes).
 */
let keyCache: KeyCache | null = null;
/** In-flight refresh, so a burst of concurrent requests triggers one fetch, not N. */
let keyRefresh: Promise<KeyCache> | null = null;

/** Test seam — resets both the cache and any in-flight refresh. */
export function __resetFirebaseKeyCacheForTests(): void {
  keyCache = null;
  keyRefresh = null;
}

function parseMaxAgeMs(cacheControl: string | null): number | null {
  if (!cacheControl) return null;
  const match = /max-age\s*=\s*(\d+)/i.exec(cacheControl);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null;
}

async function fetchSigningKeys(now: number): Promise<KeyCache> {
  const response = await fetch(FIREBASE_JWK_URL);
  if (!response.ok) {
    throw new Error(`firebase jwk fetch failed with ${response.status}`);
  }
  const body = (await response.json()) as JwkSet;
  if (!body || !Array.isArray(body.keys)) {
    throw new Error('firebase jwk response has no keys');
  }

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    if (!jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }
  if (keys.size === 0) {
    throw new Error('firebase jwk response contained no usable keys');
  }

  // Google publishes the rotation deadline as this response's own max-age —
  // honouring it is what keeps a rotated-out key from being trusted past its
  // published life, and a still-valid key from being re-fetched every hour
  // for nothing.
  const ttlMs = parseMaxAgeMs(response.headers.get('Cache-Control')) ?? DEFAULT_KEY_CACHE_TTL_MS;
  return { keys, fetchedAt: now, expiresAt: now + ttlMs };
}

async function getSigningKey(kid: string, now: number): Promise<CryptoKey | null> {
  if (keyCache && keyCache.expiresAt > now) {
    const cached = keyCache.keys.get(kid);
    if (cached) return cached;
    // Unknown kid against a still-fresh cache: Google may have rotated early,
    // so refresh — but no more often than MIN_KEY_REFRESH_INTERVAL_MS, or
    // junk kids become a free amplifier. Between refreshes, an unknown kid is
    // simply not a published signing key.
    if (now - keyCache.fetchedAt < MIN_KEY_REFRESH_INTERVAL_MS) return null;
  }

  if (!keyRefresh) {
    keyRefresh = fetchSigningKeys(now).finally(() => { keyRefresh = null; });
  }
  try {
    keyCache = await keyRefresh;
  } catch (err) {
    console.error('[firebaseAuth] signing key refresh failed', err);
    return null;
  }
  return keyCache.keys.get(kid) ?? null;
}

/**
 * Returns null rather than throwing on invalid Base64URL. `atob` throws on
 * any character outside the alphabet, and every caller here is decoding an
 * attacker-supplied token segment — junk must answer "this token does not
 * verify", not escape as an exception the gate never catches.
 */
function base64UrlToBytes(value: string): Uint8Array | null {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(segment);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Returns the verified uid, or null for any token that fails any check.
 * Never throws and never distinguishes failure reasons to the caller — every
 * rejection is the same 401 to the client, so a probe cannot learn whether a
 * token was expired, wrong-project, or forged.
 */
export async function verifyFirebaseIdToken(
  token: string,
  projectId: string,
  now: number = Date.now(),
): Promise<string | null> {
  if (!projectId) {
    console.error('[firebaseAuth] FIREBASE_PROJECT_ID is not configured');
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  const header = decodeJson(headerSegment);
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    return null;
  }

  const payload = decodeJson(payloadSegment);
  if (!payload) return null;

  const nowSeconds = Math.floor(now / 1_000);
  const { iss, aud, exp, iat, sub } = payload as {
    iss?: unknown; aud?: unknown; exp?: unknown; iat?: unknown; sub?: unknown;
  };
  if (iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (aud !== projectId) return null;
  if (typeof exp !== 'number' || exp <= nowSeconds - CLOCK_SKEW_SECONDS) return null;
  if (typeof iat !== 'number' || iat > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  if (typeof sub !== 'string' || sub.trim() === '') return null;

  const signature = base64UrlToBytes(signatureSegment);
  if (!signature) return null;

  const key = await getSigningKey(header.kid, now);
  if (!key) return null;

  // Claims are checked before the signature above only to fail cheap cases
  // without a possible network round trip; nothing is trusted until this
  // verify() returns true.
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature,
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );
  return verified ? sub : null;
}

/** Extracts the bearer token from an Authorization header, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
