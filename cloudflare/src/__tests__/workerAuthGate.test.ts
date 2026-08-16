import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * KAN-367 — the request-level half of direct Firebase auth: which
 * credentials get past the gate, and that rate limiting is keyed on the
 * VERIFIED uid rather than anything the client asserts. Token verification
 * itself is covered end-to-end (real RS256 signatures) in
 * firebaseAuth.test.ts; it is mocked here so these tests stay about routing.
 */
const { mockVerify } = vi.hoisted(() => ({ mockVerify: vi.fn() }));
vi.mock('../firebaseAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../firebaseAuth')>();
  return { ...actual, verifyFirebaseIdToken: mockVerify };
});
vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: vi.fn() }),
  Container: class {},
}));

import worker, { type Env } from '../index';

const API_KEY = 'test-api-key';

/** Minimal D1 stand-in: /coverage issues one findPlace query and reads first(). */
function fakeDb() {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({}),
      }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
  } as unknown as D1Database;
}

let limitCalls: Array<{ key: string }>;
let limitAllows: boolean;

function makeEnv(overrides: Partial<Env> = {}): Env {
  limitCalls = [];
  const limiter = {
    limit: async (options: { key: string }) => {
      limitCalls.push(options);
      return { success: limitAllows };
    },
  };
  return {
    REGISTRY_DB: fakeDb(),
    POI_EXPORTS: {} as R2Bucket,
    API_KEY,
    FIREBASE_PROJECT_ID: 'brush-away',
    POI_RATE_LIMITER: limiter,
    COVERAGE_REQUEST_RATE_LIMITER: limiter,
    EXTRACTION_CONTAINER: {} as Env['EXTRACTION_CONTAINER'],
    ...overrides,
  } as Env;
}

function coverageRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://poi-api.brushaway.app/coverage?lat=38.7&lng=-9.1', { headers });
}

beforeEach(() => {
  limitAllows = true;
  mockVerify.mockReset();
});

describe('worker auth gate', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await worker.fetch(coverageRequest(), makeEnv());
    expect(response.status).toBe(401);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('accepts a verified Firebase ID token', async () => {
    mockVerify.mockResolvedValue('uid-abc');
    const response = await worker.fetch(coverageRequest({ Authorization: 'Bearer good.token' }), makeEnv());
    expect(response.status).toBe(200);
    expect(mockVerify).toHaveBeenCalledWith('good.token', 'brush-away');
  });

  it('rejects an invalid or expired token with 401', async () => {
    mockVerify.mockResolvedValue(null);
    const response = await worker.fetch(coverageRequest({ Authorization: 'Bearer bad.token' }), makeEnv());
    expect(response.status).toBe(401);
  });

  it('does not fall back to the API key when a bearer token fails verification', async () => {
    mockVerify.mockResolvedValue(null);
    const response = await worker.fetch(
      coverageRequest({ Authorization: 'Bearer bad.token', 'X-Api-Key': API_KEY }),
      makeEnv(),
    );
    expect(response.status).toBe(401);
  });

  it('still accepts the API key, so the Firebase proxy remains a rollback path', async () => {
    const response = await worker.fetch(coverageRequest({ 'X-Api-Key': API_KEY }), makeEnv());
    expect(response.status).toBe(200);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('rejects a wrong API key', async () => {
    const response = await worker.fetch(coverageRequest({ 'X-Api-Key': 'nope' }), makeEnv());
    expect(response.status).toBe(401);
  });
});

describe('per-uid rate limiting', () => {
  it('keys the limiter on the verified uid, not on request content', async () => {
    mockVerify.mockResolvedValue('uid-abc');
    const request = new Request('https://poi-api.brushaway.app/coverage?lat=38.7&lng=-9.1&uid=uid-spoofed', {
      headers: { Authorization: 'Bearer good.token', 'X-Uid': 'uid-spoofed' },
    });
    await worker.fetch(request, makeEnv());
    expect(limitCalls).toEqual([{ key: 'uid-abc:coverage' }]);
  });

  it('returns 429 once the limiter denies', async () => {
    mockVerify.mockResolvedValue('uid-abc');
    limitAllows = false;
    const response = await worker.fetch(coverageRequest({ Authorization: 'Bearer good.token' }), makeEnv());
    expect(response.status).toBe(429);
  });

  it('uses the tighter coverage-demand limiter for POST /coverage/request', async () => {
    mockVerify.mockResolvedValue('uid-abc');
    limitAllows = false;
    const response = await worker.fetch(
      new Request('https://poi-api.brushaway.app/coverage/request', {
        method: 'POST',
        headers: { Authorization: 'Bearer good.token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: 38.7, lng: -9.1 }),
      }),
      makeEnv(),
    );
    expect(response.status).toBe(429);
    expect(limitCalls).toEqual([{ key: 'uid-abc:requestCoverage' }]);
  });

  it('limits POST /poi/nearby before parsing the body', async () => {
    mockVerify.mockResolvedValue('uid-abc');
    limitAllows = false;
    const response = await worker.fetch(
      new Request('https://poi-api.brushaway.app/poi/nearby', {
        method: 'POST',
        headers: { Authorization: 'Bearer good.token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: 38.7, lng: -9.1, radius: 1_000, requests: [{ key: 'cafe', type: 'cafe' }], limitPerRequest: 20 }),
      }),
      makeEnv(),
    );
    expect(response.status).toBe(429);
    expect(limitCalls).toEqual([{ key: 'uid-abc:poiAll' }]);
  });

  it('limits the remaining read routes a token holder can reach', async () => {
    mockVerify.mockResolvedValue('uid-abc');
    const env = makeEnv();
    for (const [path, action] of [
      ['/poi?lat=38.7&lng=-9.1&radius=500&type=cafe', 'poi'],
      ['/poi/all?lat=38.7&lng=-9.1&radius=500', 'poiAll'],
    ] as const) {
      await worker.fetch(
        new Request(`https://poi-api.brushaway.app${path}`, { headers: { Authorization: 'Bearer good.token' } }),
        env,
      );
      expect(limitCalls.at(-1)).toEqual({ key: `uid-abc:${action}` });
    }
  });

  it('limits /export on the tighter budget — each hit streams megabytes', async () => {
    mockVerify.mockResolvedValue('uid-abc');
    limitAllows = false;
    const response = await worker.fetch(
      new Request('https://poi-api.brushaway.app/export/lisboa', { headers: { Authorization: 'Bearer good.token' } }),
      makeEnv(),
    );
    expect(response.status).toBe(429);
    expect(limitCalls).toEqual([{ key: 'uid-abc:export' }]);
  });

  it('does not rate-limit key-authenticated callers — there is no user to key on', async () => {
    await worker.fetch(coverageRequest({ 'X-Api-Key': API_KEY }), makeEnv());
    expect(limitCalls).toEqual([]);
  });

  it('serves the request when no limiter binding is configured', async () => {
    mockVerify.mockResolvedValue('uid-abc');
    const env = makeEnv({ POI_RATE_LIMITER: undefined });
    const response = await worker.fetch(coverageRequest({ Authorization: 'Bearer good.token' }), env);
    expect(response.status).toBe(200);
  });
});
