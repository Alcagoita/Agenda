/**
 * KAN-228 — searchOsmPlaces: Overpass API integration for the habitat cache.
 *
 * Verifies:
 *   - Builds one node[...] Overpass clause per requested POI type
 *   - Parses elements[] into OsmPlace[], grouped by type, sorted by distance
 *   - Falls back to the POI type's human-readable label when OSM has no name tag
 *   - Unrecognized POI types (no OSM tag mapping) are skipped, not errored
 *   - Never throws: empty poiTypes, non-200 response, network failure, timeout
 */

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// osmPlaces imports maps.ts (getDistanceMeters, placeTypeLabel), which
// transitively pulls in placesFunctions -> @react-native-firebase/functions,
// a native module unavailable under Jest. Mock ONLY that native boundary, so
// maps.ts still contributes its real distance/label helpers.
jest.mock('../../src/services/placesFunctions', () => ({
  searchNearbyPlacesProxy: jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  getPlaceDetailsProxy:    jest.fn(),
}));

jest.mock('../../src/services/reverseGeocodeCache', () => ({
  getCachedCity: jest.fn(),
  putCachedCity: jest.fn(),
}));

import { searchOsmPlaces, searchOsmPlacesStrict } from '../../src/services/osmPlaces';

const ORIGIN = { lat: 0, lng: 0 };

function mockOverpassResponse(elements: Array<{
  type?: string; id: number; lat: number; lon: number; tags: Record<string, string>;
}>) {
  mockFetch.mockResolvedValueOnce({
    ok:   true,
    json: async () => ({
      elements: elements.map(e => ({ type: e.type ?? 'node', ...e })),
    }),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('searchOsmPlaces', () => {
  it('returns an empty result for each type without calling fetch when poiTypes is empty', async () => {
    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, [], 5000);
    expect(result).toEqual({});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // KAN-282 — `nwr` (node+way+relation), not `node`: large venues, shopping
  // malls especially, are mapped as a building-footprint way/relation and
  // were structurally invisible to a node-only query. `out center bb;`
  // returns the bounding box those need for a location and a footprint area.
  // KAN-406 — a concept with no single tag value. "A historic place" is
  // castle OR monument OR ruins OR ...; mapping it to any one of them would
  // silently drop the rest, which is the defect this ticket was about.
  it('builds a regex alternation for a multi-value selector, and matches every value in it', async () => {
    mockOverpassResponse([]);
    await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['historical_landmark'], 5000);

    const [, options] = mockFetch.mock.calls[0];
    const body = decodeURIComponent((options.body as string).replace(/^data=/, ''));
    expect(body).toContain('nwr["historic"~"^(');
    expect(body).toContain('castle');
    expect(body).toContain('monument');
    // Not an equality clause — that is what could only ever match one value.
    expect(body).not.toContain('nwr["historic"="castle"]');
  });

  it('returns an element whose tag value is not the selector primary', async () => {
    // `historic=monument` is in the accepted set but is not `value`. Filtering
    // the response against `value` alone would throw away everything the
    // alternation above deliberately asked for.
    mockOverpassResponse([
      { id: 1, lat: 0.0001, lon: 0, tags: { historic: 'monument', name: 'Padrão dos Descobrimentos' } },
    ]);

    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['historical_landmark'], 5000);

    expect(result.historical_landmark).toHaveLength(1);
    expect(result.historical_landmark[0].name).toBe('Padrão dos Descobrimentos');
  });

  it('still rejects an element whose tag value is outside the accepted set', async () => {
    // Guards the alternation from becoming "any historic=* at all" — the
    // filter must stay as narrow as the query.
    mockOverpassResponse([
      { id: 2, lat: 0.0001, lon: 0, tags: { historic: 'wayside_cross', name: 'Cruzeiro' } },
    ]);

    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['historical_landmark'], 5000);

    expect(result.historical_landmark).toHaveLength(0);
  });

  it('builds one nwr clause per requested POI type using POI_OSM_TAGS', async () => {
    mockOverpassResponse([]);
    await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['pharmacy', 'cafe'], 5000);

    const [, options] = mockFetch.mock.calls[0];
    const body = decodeURIComponent((options.body as string).replace(/^data=/, ''));
    expect(body).toContain('nwr["amenity"="pharmacy"](around:5000,0,0);');
    expect(body).toContain('nwr["amenity"="cafe"](around:5000,0,0);');
    expect(body).toContain('out center bb;');
  });

  it('skips POI types with no OSM tag mapping instead of erroring', async () => {
    mockOverpassResponse([]);
    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['not-a-real-type'], 5000);
    expect(result).toEqual({ 'not-a-real-type': [] });
  });

  it('parses elements into OsmPlace[], grouped by type and sorted by distance', async () => {
    // ~30m and ~55m north of the origin (same latitude math used elsewhere in this suite).
    mockOverpassResponse([
      { id: 1, lat: 0.0005, lon: 0, tags: { amenity: 'cafe', name: 'Far Cafe' } },
      { id: 2, lat: 0.00027, lon: 0, tags: { amenity: 'cafe', name: 'Near Cafe' } },
    ]);

    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['cafe'], 5000);

    expect(result.cafe).toHaveLength(2);
    expect(result.cafe[0].name).toBe('Near Cafe');
    expect(result.cafe[0].osmId).toBe('node/2');
    expect(result.cafe[1].name).toBe('Far Cafe');
    expect(result.cafe[0].distanceMeters).toBeLessThan(result.cafe[1].distanceMeters);
  });

  it('maps an explicit OSM brand tag to a canonical local Store brand', async () => {
    mockOverpassResponse([
      { id: 10, lat: 0.0002, lon: 0, tags: { shop: 'convenience', name: 'Zara Colombo', brand: 'Zara' } },
    ]);

    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['store'], 5000);

    expect(result.store[0]).toMatchObject({ name: 'Zara Colombo', brand: 'Zara' });
  });

  it('falls back to the human-readable POI type label (not the raw lowercase tag) when OSM has no name tag', async () => {
    mockOverpassResponse([
      { id: 3, lat: 0.0001, lon: 0, tags: { amenity: 'pharmacy' } },
    ]);

    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['pharmacy'], 5000);
    expect(result.pharmacy[0].name).toBe('Pharmacy');
    expect(result.pharmacy[0].isGenericName).toBe(true);
  });

  it('ignores elements missing lat/lon or tags', async () => {
    mockOverpassResponse([
      { id: 4, lat: undefined as unknown as number, lon: 0, tags: { amenity: 'atm' } },
    ]);

    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000);
    expect(result.atm).toEqual([]);
  });

  it('returns empty results on a non-200 response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000);
    expect(result).toEqual({ atm: [] });
  });

  it('returns empty results on a network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000);
    expect(result).toEqual({ atm: [] });
  });

  it('sends a User-Agent header identifying the app', async () => {
    mockOverpassResponse([]);
    await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['User-Agent']).toMatch(/^BrushApp\//);
  });

  it('aborts and returns empty results when the request exceeds the timeout', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementationOnce((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
    }));

    const resultPromise = searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000);
    jest.advanceTimersByTime(8_001);
    const result = await resultPromise;

    expect(result).toEqual({ atm: [] });
    jest.useRealTimers();
  });

  it('honors an explicit timeoutMs override (KAN-234 trip downloads) instead of the 8s default', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementationOnce((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
    }));

    const resultPromise = searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000, 20_000);

    jest.advanceTimersByTime(8_001); // past the default — must NOT have aborted yet
    let settled = false;
    resultPromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(12_000); // past the 20s override
    const result = await resultPromise;
    expect(result).toEqual({ atm: [] });

    jest.useRealTimers();
  });

  // KAN-342 — a chunk-level failure now retries each of the 2 endpoints up
  // to MAX_RETRIES_PER_ENDPOINT+1 times (3 attempts each = 6 total) before
  // giving up on that chunk, instead of one attempt per endpoint (2 total).
  it('keeps successful chunk results when a later chunk exhausts every endpoint/retry', async () => {
    jest.useFakeTimers();
    const poiTypes = Array.from({ length: 26 }, () => 'pharmacy');
    mockOverpassResponse([{ id: 8, lat: 0.0001, lon: 0, tags: { amenity: 'pharmacy', name: 'Open Pharmacy' } }]);
    mockFetch.mockRejectedValue(new Error('chunk failed')); // every subsequent call fails

    const resultPromise = searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, poiTypes, 5000);
    await jest.advanceTimersByTimeAsync(0);      // chunk 1 succeeds immediately
    await jest.advanceTimersByTimeAsync(500);     // chunk 2, endpoint 1, backoff before retry 1
    await jest.advanceTimersByTimeAsync(1000);    // endpoint 1, backoff before retry 2
    await jest.advanceTimersByTimeAsync(500);     // endpoint 2, backoff before retry 1
    await jest.advanceTimersByTimeAsync(1000);    // endpoint 2, backoff before retry 2
    const result = await resultPromise;
    jest.useRealTimers();

    expect(mockFetch).toHaveBeenCalledTimes(1 + 6); // 1 (chunk 1) + 2 endpoints x 3 attempts (chunk 2)
    const firstBody = decodeURIComponent((mockFetch.mock.calls[0][1].body as string).replace(/^data=/, ''));
    const secondBody = decodeURIComponent((mockFetch.mock.calls[1][1].body as string).replace(/^data=/, ''));
    expect(firstBody.match(/nwr\[/g)).toHaveLength(25);
    expect(secondBody.match(/nwr\[/g)).toHaveLength(1);
    expect(result.pharmacy).toHaveLength(1);
    expect(result.pharmacy[0].name).toBe('Open Pharmacy');
  });
});

describe('searchOsmPlacesStrict (KAN-234 trip downloads)', () => {
  it('parses results the same way as searchOsmPlaces on success', async () => {
    mockOverpassResponse([{ id: 1, lat: 0.0001, lon: 0, tags: { amenity: 'pharmacy', name: 'Corner Pharmacy' } }]);
    const result = await searchOsmPlacesStrict(ORIGIN.lat, ORIGIN.lng, ['pharmacy'], 5000);
    expect(result.pharmacy[0].name).toBe('Corner Pharmacy');
  });

  it('throws on a non-200 response instead of collapsing to an empty result', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(searchOsmPlacesStrict(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000)).rejects.toThrow();
  });

  // These use mockRejectedValue / mockImplementation (not ...Once): the
  // request is retried against every Overpass endpoint, so it only throws
  // once ALL of them have failed.
  it('throws on a network error instead of collapsing to an empty result', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    await expect(searchOsmPlacesStrict(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000)).rejects.toThrow('network down');
  });

  it('throws when the request exceeds the timeout instead of collapsing to an empty result', async () => {
    mockFetch.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
    }));

    // Short real timeout beats fake timers here — each endpoint gets its own
    // timeout window, so this stays correct however many are configured.
    await expect(
      searchOsmPlacesStrict(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000, 10),
    ).rejects.toThrow('AbortError');
  });
});

// ─── KAN-282: footprint area + endpoint fallback ──────────────────────────────

describe('searchOsmPlaces — building footprint area (KAN-282)', () => {
  /** A way/relation element as Overpass returns it under `out center bb;` — no
   *  lat/lon of its own, just a bounding box. */
  function mockWayResponse(bounds: { minlat: number; minlon: number; maxlat: number; maxlon: number }) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        elements: [{ type: 'way', id: 42645796, bounds, tags: { shop: 'mall', name: 'Centro Comercial Colombo' } }],
      }),
    });
  }

  it('derives a location from the bounding box midpoint for a way', async () => {
    mockWayResponse({ minlat: 0, minlon: 0, maxlat: 0.002, maxlon: 0.004 });

    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['shopping_mall'], 5000);

    expect(result.shopping_mall[0]).toMatchObject({ lat: 0.001, lng: 0.002 });
  });

  it('computes a footprint area from the bounding box', async () => {
    // ~0.002° lat x ~0.004° lon at the equator — a few hundred metres a side.
    mockWayResponse({ minlat: 0, minlon: 0, maxlat: 0.002, maxlon: 0.004 });

    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['shopping_mall'], 5000);

    const expected = (0.002 * 111_195) * (0.004 * 111_195); // ~98,800 m²
    expect(result.shopping_mall[0].footprintAreaM2).toBeCloseTo(expected, 0);
  });

  it('reports exactly 0 for a bare node — fetched with geometry, genuinely no footprint', async () => {
    // 0 is meaningful, not missing: it lets the habitat cache tell a node
    // apart from a row that was never fetched with geometry at all (NULL).
    mockOverpassResponse([{ id: 1, lat: 0.001, lon: 0.001, tags: { shop: 'mall', name: 'Galeria Uruguai' } }]);

    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['shopping_mall'], 5000);

    expect(result.shopping_mall[0].footprintAreaM2).toBe(0);
  });
});

describe('searchOsmPlaces — Overpass endpoint fallback (KAN-282)', () => {
  // KAN-342 — a transient failure now retries the SAME endpoint with
  // exponential backoff (bounded — MAX_RETRIES_PER_ENDPOINT) before moving on
  // to the next endpoint at all; only after every attempt on endpoint 1 is
  // exhausted does endpoint 2 get tried.
  it('exhausts retries on the first endpoint (with backoff) before falling back to the next', async () => {
    jest.useFakeTimers();
    mockFetch
      .mockRejectedValueOnce(new Error('504 Gateway Timeout'))
      .mockRejectedValueOnce(new Error('504 Gateway Timeout'))
      .mockRejectedValueOnce(new Error('504 Gateway Timeout'));
    mockOverpassResponse([{ id: 1, lat: 0.001, lon: 0, tags: { amenity: 'pharmacy', name: 'Farmácia' } }]);

    const promise = searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['pharmacy'], 5000);
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(500);  // backoff before retry 1
    await jest.advanceTimersByTimeAsync(1000); // backoff before retry 2
    const result = await promise;
    jest.useRealTimers();

    // 3 attempts on endpoint 1 (exhausted), then 1 on endpoint 2 (succeeds).
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch.mock.calls[0][0]).toBe(mockFetch.mock.calls[1][0]);
    expect(mockFetch.mock.calls[0][0]).toBe(mockFetch.mock.calls[2][0]);
    expect(mockFetch.mock.calls[3][0]).not.toBe(mockFetch.mock.calls[0][0]);
    expect(result.pharmacy).toHaveLength(1);
  });

  // KAN-282 review — timeoutMs is a shared deadline across endpoints, not a
  // per-endpoint budget: trip/mall downloads pass 20s, so a per-endpoint
  // timeout would leave a foreground spinner running for endpoints x 20s.
  it('applies timeoutMs as one shared deadline across endpoints, not per endpoint', async () => {
    mockFetch.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
    }));

    const startedAt = Date.now();
    await expect(
      searchOsmPlacesStrict(ORIGIN.lat, ORIGIN.lng, ['atm'], 5000, 120),
    ).rejects.toThrow('AbortError');

    // Comfortably under 2x the budget, which a per-endpoint timeout would hit.
    expect(Date.now() - startedAt).toBeLessThan(220);
  });

  it('falls back on a non-retryable non-200 response too, not just a thrown error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
    mockOverpassResponse([{ id: 1, lat: 0.001, lon: 0, tags: { amenity: 'pharmacy', name: 'Farmácia' } }]);

    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['pharmacy'], 5000);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.pharmacy).toHaveLength(1);
  });

  // KAN-342 — 429 is a stop signal, never a retry-or-fallback case: Overpass
  // blocks by User-Agent identity, so trying a second endpoint (or retrying
  // this one) can't fix it and risks compounding the block.
  it('a 429 stops immediately — no retry, no next-endpoint fallback', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });

    const result = await searchOsmPlaces(ORIGIN.lat, ORIGIN.lng, ['pharmacy'], 5000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.pharmacy).toEqual([]);
  });
});
