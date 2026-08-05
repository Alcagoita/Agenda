/**
 * cloudflarePoi.ts — cloudflareCoverageProxy / cloudflarePoiAllProxy /
 * enforceUserRateLimit unit tests. firebase-admin/firestore and global.fetch
 * are mocked; business logic and error paths are exercised directly via
 * CallableFunction.run(), no emulator needed.
 */

const mockGet = jest.fn();
const mockSet = jest.fn();
const mockRunTransaction = jest.fn(async (fn: (t: { get: typeof mockGet; set: typeof mockSet }) => unknown) =>
  fn({ get: mockGet, set: mockSet }),
);
const mockDoc = jest.fn(() => ({}));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: mockCollection, runTransaction: mockRunTransaction }),
}));

const secretValue = jest.fn(() => 'test-api-key');
jest.mock('firebase-functions/params', () => ({
  defineSecret: () => ({ value: () => secretValue() }),
}));

import { cloudflareCoverageProxy, cloudflarePoiAllProxy, cloudflareRequestCoverageProxy } from '../cloudflarePoi';

const AUTH = { uid: 'uid-1' } as never;

function okFetchResponse(body: unknown = { covered: true, results: [] }) {
  return { ok: true, json: async () => body } as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  secretValue.mockReturnValue('test-api-key');
  mockGet.mockResolvedValue({ data: () => undefined }); // no rate-limit doc yet, by default
  global.fetch = jest.fn().mockResolvedValue(okFetchResponse());
});

describe('authentication', () => {
  it('rejects an unauthenticated coverage request', async () => {
    await expect(cloudflareCoverageProxy.run({ auth: undefined, data: { lat: 38.7, lng: -9.1 } } as never))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects an unauthenticated poi/all request', async () => {
    await expect(cloudflarePoiAllProxy.run({ auth: undefined, data: { lat: 38.7, lng: -9.1, radiusMeters: 200 } } as never))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('coordinate validation', () => {
  it.each([
    ['lat too high', { lat: 91, lng: 0 }],
    ['lat too low', { lat: -91, lng: 0 }],
    ['lng too high', { lat: 0, lng: 181 }],
    ['lng too low', { lat: 0, lng: -181 }],
    ['lat NaN', { lat: NaN, lng: 0 }],
  ])('rejects %s', async (_label, coords) => {
    await expect(cloudflareCoverageProxy.run({ auth: AUTH, data: coords } as never))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('accepts boundary coordinates (±90 lat, ±180 lng)', async () => {
    await expect(cloudflareCoverageProxy.run({ auth: AUTH, data: { lat: 90, lng: 180 } } as never)).resolves.toBeDefined();
    await expect(cloudflareCoverageProxy.run({ auth: AUTH, data: { lat: -90, lng: -180 } } as never)).resolves.toBeDefined();
  });
});

describe('radiusMeters validation (poi/all)', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['above the 4500 cap', 4501],
    ['non-integer', 200.5],
  ])('rejects %s', async (_label, radiusMeters) => {
    await expect(cloudflarePoiAllProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1, radiusMeters } } as never))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('accepts the 1 and 4500 boundaries', async () => {
    await expect(cloudflarePoiAllProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1, radiusMeters: 1 } } as never)).resolves.toBeDefined();
    await expect(cloudflarePoiAllProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1, radiusMeters: 4500 } } as never)).resolves.toBeDefined();
  });
});

describe('enforceUserRateLimit', () => {
  it('allows request 30 in the window (current count 29 before increment)', async () => {
    mockGet.mockResolvedValue({ data: () => ({ windowStartedAt: Date.now(), requestCount: 29 }) });
    await expect(cloudflareCoverageProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1 } } as never)).resolves.toBeDefined();
    expect(mockSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestCount: 30 }));
  });

  it('rejects request 31 in the window (current count already 30)', async () => {
    mockGet.mockResolvedValue({ data: () => ({ windowStartedAt: Date.now(), requestCount: 30 }) });
    await expect(cloudflareCoverageProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1 } } as never))
      .rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  it('resets the window once it has elapsed, ignoring the prior count', async () => {
    mockGet.mockResolvedValue({
      data: () => ({ windowStartedAt: Date.now() - 60_001, requestCount: 30 }),
    });
    await expect(cloudflareCoverageProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1 } } as never)).resolves.toBeDefined();
    expect(mockSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestCount: 1 }));
  });

  it('propagates a Firestore transaction failure', async () => {
    mockRunTransaction.mockRejectedValueOnce(new Error('firestore unavailable'));
    await expect(cloudflareCoverageProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1 } } as never))
      .rejects.toThrow('firestore unavailable');
  });
});

describe('upstream fetch handling', () => {
  it('wraps a network failure/timeout as an unavailable HttpsError', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('aborted'));
    await expect(cloudflareCoverageProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1 } } as never))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  it('wraps a non-ok upstream response as an unavailable HttpsError', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' } as Response);
    await expect(cloudflareCoverageProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1 } } as never))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects when the upstream response body is not valid JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token in JSON'); },
    } as unknown as Response);
    await expect(cloudflareCoverageProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1 } } as never)).rejects.toThrow();
  });

  it('passes lat/lng/radius through to the /poi/all URL', async () => {
    await cloudflarePoiAllProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1, radiusMeters: 200 } } as never);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/poi/all?lat=38.7&lng=-9.1&radius=200'),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Api-Key': 'test-api-key' }) }),
    );
  });
});

describe('cloudflareRequestCoverageProxy', () => {
  it('rejects an unauthenticated request', async () => {
    await expect(cloudflareRequestCoverageProxy.run({ auth: undefined, data: { lat: 38.7, lng: -9.1 } } as never))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it.each([
    ['lat too high', { lat: 91, lng: 0 }],
    ['lng too low', { lat: 0, lng: -181 }],
  ])('rejects %s', async (_label, coords) => {
    await expect(cloudflareRequestCoverageProxy.run({ auth: AUTH, data: coords } as never))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('POSTs lat/lng as a JSON body to /coverage/request with the API key header', async () => {
    await cloudflareRequestCoverageProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1 } } as never);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/coverage/request'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ lat: 38.7, lng: -9.1 }),
        headers: expect.objectContaining({ 'X-Api-Key': 'test-api-key', 'Content-Type': 'application/json' }),
      }),
    );
  });

  it('uses its own tighter rate-limit bucket — request 5 in the window is allowed, request 6 is rejected', async () => {
    mockGet.mockResolvedValue({ data: () => ({ windowStartedAt: Date.now(), requestCount: 4 }) });
    await expect(cloudflareRequestCoverageProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1 } } as never)).resolves.toBeDefined();
    expect(mockSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestCount: 5 }));

    mockGet.mockResolvedValue({ data: () => ({ windowStartedAt: Date.now(), requestCount: 5 }) });
    await expect(cloudflareRequestCoverageProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1 } } as never))
      .rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  it('does not share its rate-limit bucket with cloudflareCoverageProxy', async () => {
    await cloudflareRequestCoverageProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1 } } as never);
    expect(mockCollection).toHaveBeenCalledWith('_cloudflarePoiProxyRateLimits');
    expect(mockDoc).toHaveBeenCalledWith('uid-1:requestCoverage');
  });

  it('wraps a non-ok upstream response as an unavailable HttpsError', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' } as Response);
    await expect(cloudflareRequestCoverageProxy.run({ auth: AUTH, data: { lat: 38.7, lng: -9.1 } } as never))
      .rejects.toMatchObject({ code: 'unavailable' });
  });
});
