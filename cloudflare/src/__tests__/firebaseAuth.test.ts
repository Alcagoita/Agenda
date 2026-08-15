import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bearerToken, verifyFirebaseIdToken, __resetFirebaseKeyCacheForTests } from '../firebaseAuth';

/**
 * KAN-367 — the Worker verifies Firebase ID tokens itself, so these tests
 * mint real RS256 tokens with a generated key pair and serve that key's
 * public half as Google's JWK set. Nothing is stubbed inside the verifier:
 * the signature path exercised here is the same crypto.subtle.verify a
 * production token goes through.
 */

const PROJECT_ID = 'brush-away';
const KID = 'test-key-1';

/** workers-types declares JsonWebKey without `kid`; the JWK set Google serves carries one. */
type SigningJwk = JsonWebKey & { kid: string };

let keyPair: CryptoKeyPair;
let publicJwk: SigningJwk;

const RSA_PARAMS = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
} as const;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeSegment(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function mintToken(options: {
  payload?: Record<string, unknown>;
  header?: Record<string, unknown>;
  signWith?: CryptoKey;
} = {}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const header = { alg: 'RS256', kid: KID, typ: 'JWT', ...options.header };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: 'uid-123',
    iat: nowSeconds - 10,
    exp: nowSeconds + 3_600,
    ...options.payload,
  };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    options.signWith ?? keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function jwkResponse(keys: SigningJwk[], maxAgeSeconds = 3_600): Response {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { 'Cache-Control': `public, max-age=${maxAgeSeconds}` },
  });
}

beforeEach(async () => {
  __resetFirebaseKeyCacheForTests();
  keyPair = await crypto.subtle.generateKey(RSA_PARAMS, true, ['sign', 'verify']) as CryptoKeyPair;
  // exportKey's return type is the union across all formats; 'jwk' is the JsonWebKey arm.
  publicJwk = { ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey) as JsonWebKey), kid: KID };
  vi.stubGlobal('fetch', vi.fn(async () => jwkResponse([publicJwk])));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('verifyFirebaseIdToken', () => {
  it('returns the uid for a valid token', async () => {
    await expect(verifyFirebaseIdToken(await mintToken(), PROJECT_ID)).resolves.toBe('uid-123');
  });

  it('rejects a token signed by another key', async () => {
    const otherPair = await crypto.subtle.generateKey(RSA_PARAMS, true, ['sign', 'verify']) as CryptoKeyPair;
    const forged = await mintToken({ signWith: otherPair.privateKey });
    await expect(verifyFirebaseIdToken(forged, PROJECT_ID)).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const token = await mintToken({ payload: { iat: nowSeconds - 7_200, exp: nowSeconds - 3_600 } });
    await expect(verifyFirebaseIdToken(token, PROJECT_ID)).resolves.toBeNull();
  });

  it('rejects a token minted for another Firebase project', async () => {
    const token = await mintToken({
      payload: { aud: 'someone-elses-project', iss: 'https://securetoken.google.com/someone-elses-project' },
    });
    await expect(verifyFirebaseIdToken(token, PROJECT_ID)).resolves.toBeNull();
  });

  it('rejects a token whose issuer does not match the audience project', async () => {
    const token = await mintToken({ payload: { iss: 'https://securetoken.google.com/other-project' } });
    await expect(verifyFirebaseIdToken(token, PROJECT_ID)).resolves.toBeNull();
  });

  it('rejects alg=none and symmetric algorithms', async () => {
    for (const alg of ['none', 'HS256']) {
      const token = await mintToken({ header: { alg } });
      await expect(verifyFirebaseIdToken(token, PROJECT_ID)).resolves.toBeNull();
    }
  });

  it('rejects a token with no subject', async () => {
    await expect(verifyFirebaseIdToken(await mintToken({ payload: { sub: '' } }), PROJECT_ID)).resolves.toBeNull();
  });

  it('rejects malformed tokens without fetching keys', async () => {
    for (const malformed of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', 'header.payload.signature']) {
      await expect(verifyFirebaseIdToken(malformed, PROJECT_ID)).resolves.toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects every token when no project id is configured', async () => {
    await expect(verifyFirebaseIdToken(await mintToken(), '')).resolves.toBeNull();
  });

  it('fetches the signing keys once and serves later tokens from cache', async () => {
    await verifyFirebaseIdToken(await mintToken(), PROJECT_ID);
    await verifyFirebaseIdToken(await mintToken(), PROJECT_ID);
    await verifyFirebaseIdToken(await mintToken(), PROJECT_ID);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fetches once for concurrent first requests', async () => {
    const tokens = await Promise.all([mintToken(), mintToken(), mintToken()]);
    const results = await Promise.all(tokens.map(token => verifyFirebaseIdToken(token, PROJECT_ID)));
    expect(results).toEqual(['uid-123', 'uid-123', 'uid-123']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('re-fetches the keys once the published max-age has passed', async () => {
    const start = Date.now();
    vi.stubGlobal('fetch', vi.fn(async () => jwkResponse([publicJwk], 600)));

    await verifyFirebaseIdToken(await mintToken(), PROJECT_ID, start);
    await verifyFirebaseIdToken(await mintToken(), PROJECT_ID, start + 599_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    await verifyFirebaseIdToken(await mintToken(), PROJECT_ID, start + 601_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes when a fresh cache does not hold the token kid (early rotation)', async () => {
    // First fetch publishes only the old key; the cache is then populated and
    // still inside its max-age when a token signed by the newly-rotated-in
    // key arrives.
    const oldJwk = { ...publicJwk, kid: 'old-key' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jwkResponse([oldJwk]))
      .mockResolvedValueOnce(jwkResponse([publicJwk]));
    vi.stubGlobal('fetch', fetchMock);

    const start = Date.now();
    await expect(verifyFirebaseIdToken(await mintToken({ header: { kid: 'old-key' } }), PROJECT_ID, start)).resolves.toBe('uid-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the refresh floor, so the unknown kid is allowed to trigger one refetch.
    await expect(verifyFirebaseIdToken(await mintToken(), PROJECT_ID, start + 6 * 60 * 1_000)).resolves.toBe('uid-123');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not refetch keys for unknown kids inside the refresh floor', async () => {
    const start = Date.now();
    await verifyFirebaseIdToken(await mintToken(), PROJECT_ID, start);
    expect(fetch).toHaveBeenCalledTimes(1);

    // A burst of tokens with junk kids must not become one googleapis fetch each.
    for (let i = 0; i < 5; i++) {
      const token = await mintToken({ header: { kid: `junk-${i}` } });
      await expect(verifyFirebaseIdToken(token, PROJECT_ID, start + 1_000)).resolves.toBeNull();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown kid that is still unknown after a permitted refresh', async () => {
    const start = Date.now();
    await verifyFirebaseIdToken(await mintToken(), PROJECT_ID, start);
    const token = await mintToken({ header: { kid: 'never-published' } });
    await expect(verifyFirebaseIdToken(token, PROJECT_ID, start + 6 * 60 * 1_000)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects rather than throws when key retrieval fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(verifyFirebaseIdToken(await mintToken(), PROJECT_ID)).resolves.toBeNull();
  });

  it('recovers after a failed key fetch instead of caching the failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockResolvedValueOnce(jwkResponse([publicJwk]));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(verifyFirebaseIdToken(await mintToken(), PROJECT_ID)).resolves.toBeNull();
    await expect(verifyFirebaseIdToken(await mintToken(), PROJECT_ID)).resolves.toBe('uid-123');
  });
});

describe('bearerToken', () => {
  it('reads the token from an Authorization header', () => {
    expect(bearerToken(new Request('https://x/', { headers: { Authorization: 'Bearer abc.def.ghi' } }))).toBe('abc.def.ghi');
    expect(bearerToken(new Request('https://x/', { headers: { Authorization: 'bearer abc' } }))).toBe('abc');
  });

  it('returns null when there is no usable bearer token', () => {
    expect(bearerToken(new Request('https://x/'))).toBeNull();
    expect(bearerToken(new Request('https://x/', { headers: { Authorization: 'Basic abc' } }))).toBeNull();
    expect(bearerToken(new Request('https://x/', { headers: { Authorization: 'Bearer' } }))).toBeNull();
  });
});
