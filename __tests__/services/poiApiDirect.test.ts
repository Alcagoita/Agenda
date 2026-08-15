/**
 * KAN-367 — the app calls the Cloudflare POI Worker directly with a Firebase
 * ID token, instead of going through the three Firebase callables. These
 * tests pin the transport contract the Worker validates against: bearer auth
 * on every request, the Worker's own field names, and a thrown error (never
 * a silent empty result) on failure — maps.ts's OSM fallback depends on
 * failures surfacing.
 */

// jest.setup.js's global auth mock exposes getAuth as a plain wrapper, not a
// jest.Mock, so this suite owns its own auth module mock to swap currentUser.
jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: jest.fn(),
  connectAuthEmulator: jest.fn(),
}));

import { getAuth } from '@react-native-firebase/auth/lib/modular';
import {
  cloudflareCoverageProxy,
  cloudflarePoiAllProxy,
  cloudflareRequestCoverageProxy,
} from '../../src/services/cloudflarePoiFunctions';
import { POI_API_BASE_URL, PoiApiError } from '../../src/services/poiApi';

const mockGetIdToken = jest.fn(async () => 'id-token-abc');
const mockFetch = jest.fn();

function lastRequest(): { url: string; init: RequestInit } {
  const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return { url, init };
}

function headerValue(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (getAuth as jest.Mock).mockReturnValue({ currentUser: { uid: 'uid-1', getIdToken: mockGetIdToken } });
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('direct POI API transport', () => {
  it('sends the Firebase ID token as a bearer credential', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'ready', cityId: 'lisboa', buildId: 'b1' }));

    await cloudflareCoverageProxy(38.7, -9.1);

    const { url, init } = lastRequest();
    expect(url).toBe(`${POI_API_BASE_URL}/coverage?lat=38.7&lng=-9.1`);
    expect(init.method).toBe('GET');
    expect(headerValue(init, 'Authorization')).toBe('Bearer id-token-abc');
    expect(mockGetIdToken).toHaveBeenCalled();
  });

  it('returns the coverage payload unchanged', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'ready', cityId: 'lisboa', buildId: 'b1' }));
    await expect(cloudflareCoverageProxy(38.7, -9.1)).resolves.toEqual({
      status: 'ready', cityId: 'lisboa', buildId: 'b1',
    });
  });

  it('posts nearby searches using the Worker\'s own radius field name', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: { cafe: [] }, placeName: 'Lisboa' }));

    const requests = [
      { key: 'cafe', type: 'cafe' },
      { key: 'sushi', type: 'restaurant', attribute: { dimension: 'food_cuisine' as const, values: ['sushi'] as [string] } },
      { key: 'gym-fitness', type: 'gym', brand: 'Fitness Hut' },
    ];
    const response = await cloudflarePoiAllProxy(38.7, -9.1, 1_200, requests, 15);

    const { url, init } = lastRequest();
    expect(url).toBe(`${POI_API_BASE_URL}/poi/nearby`);
    expect(init.method).toBe('POST');
    expect(headerValue(init, 'Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      lat: 38.7, lng: -9.1, radius: 1_200, requests, limitPerRequest: 15,
    });
    expect(response).toEqual({ results: { cafe: [] }, placeName: 'Lisboa' });
  });

  it('defaults limitPerRequest to 20, as the callable did', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ results: {} }));
    await cloudflarePoiAllProxy(38.7, -9.1, 1_000, [{ key: 'cafe', type: 'cafe' }]);
    expect(JSON.parse(lastRequest().init.body as string).limitPerRequest).toBe(20);
  });

  it('posts coverage demand to /coverage/request', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ coverageStatus: 'none', cityId: null }));

    await expect(cloudflareRequestCoverageProxy(38.7, -9.1)).resolves.toEqual({
      coverageStatus: 'none', cityId: null,
    });
    const { url, init } = lastRequest();
    expect(url).toBe(`${POI_API_BASE_URL}/coverage/request`);
    expect(JSON.parse(init.body as string)).toEqual({ lat: 38.7, lng: -9.1 });
  });

  it('throws PoiApiError on a non-2xx response', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockResolvedValue(jsonResponse({ error: 'rate limit exceeded' }, 429));

    await expect(cloudflarePoiAllProxy(38.7, -9.1, 1_000, [{ key: 'cafe', type: 'cafe' }]))
      .rejects.toBeInstanceOf(PoiApiError);
  });

  it('surfaces a 401 rather than returning an empty result', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));

    await expect(cloudflareCoverageProxy(38.7, -9.1)).rejects.toMatchObject({ status: 401 });
  });

  it('propagates a transport failure', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    await expect(cloudflareCoverageProxy(38.7, -9.1)).rejects.toThrow('network down');
  });

  it('never calls the API without a signed-in user', async () => {
    (getAuth as jest.Mock).mockReturnValue({ currentUser: null });
    await expect(cloudflareCoverageProxy(38.7, -9.1)).rejects.toThrow(/signed-in user/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
