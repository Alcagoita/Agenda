import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker, { type Env } from '../index';

/**
 * Hand-rolled fake D1 — no @cloudflare/vitest-pool-workers/miniflare D1
 * wiring exists in this project yet, so this stands in for exactly the
 * `place` queries POST /coverage/request issues (see index.ts), not a
 * general SQL engine. Brittle to a query-text change in index.ts by
 * design — that's the tradeoff for testing the real handler logic (dedupe,
 * budget cap, demand bump) without a full SQLite dependency.
 */
interface FakePlaceRow {
  place_id: string;
  country_code: string | null;
  name: string;
  place_kind: string | null;
  status: 'none' | 'mapping' | 'mapped';
  min_lat: number | null;
  max_lat: number | null;
  min_lng: number | null;
  max_lng: number | null;
  build_id: string | null;
  mapped_at: string | null;
  request_count: number;
  first_requested_at: string | null;
  last_requested_at: string | null;
}

function createFakePlaceDb(seed: FakePlaceRow[] = []) {
  const rows = new Map(seed.map(r => [r.place_id, { ...r }]));

  function prepare(sql: string) {
    const trimmed = sql.trim();

    function statement(args: unknown[]) {
      return {
        bind(...nextArgs: unknown[]) {
          return statement(nextArgs);
        },
        async first<T>(): Promise<T | null> {
          if (trimmed.startsWith('SELECT * FROM place WHERE place_id = ?')) {
            return (rows.get(args[0] as string) ?? null) as T | null;
          }
          throw new Error(`fake D1: unhandled first() query: ${trimmed}`);
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (trimmed.startsWith('SELECT * FROM place WHERE min_lat IS NOT NULL')) {
            const [lat, lng] = args as [number, number];
            const matches = [...rows.values()].filter(r =>
              r.min_lat !== null && r.max_lat !== null && r.min_lng !== null && r.max_lng !== null &&
              lat >= r.min_lat && lat <= r.max_lat && lng >= r.min_lng && lng <= r.max_lng,
            );
            return { results: matches as unknown as T[] };
          }
          if (trimmed.startsWith("SELECT COUNT(*) as n FROM place WHERE status = 'none'")) {
            const n = [...rows.values()].filter(r => r.status === 'none').length;
            return { results: [{ n }] as unknown as T[] };
          }
          throw new Error(`fake D1: unhandled all() query: ${trimmed}`);
        },
        async run(): Promise<{ meta: { changes: number } }> {
          if (trimmed.startsWith('UPDATE place SET request_count = request_count + 1')) {
            const [lastRequestedAt, placeId] = args as [string, string];
            const row = rows.get(placeId);
            if (!row) return { meta: { changes: 0 } };
            row.request_count += 1;
            row.last_requested_at = lastRequestedAt;
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith('INSERT INTO place')) {
            const [placeId, countryCode, name, placeKind, firstRequestedAt, lastRequestedAt] = args as [
              string, string | null, string, string | null, string, string,
            ];
            const existing = rows.get(placeId);
            if (existing) {
              // ON CONFLICT DO UPDATE ... WHERE status = 'none'
              if (existing.status === 'none') {
                existing.request_count += 1;
                existing.last_requested_at = lastRequestedAt;
              }
              return { meta: { changes: 1 } };
            }
            rows.set(placeId, {
              place_id: placeId, country_code: countryCode, name, place_kind: placeKind,
              status: 'none', min_lat: null, max_lat: null, min_lng: null, max_lng: null,
              build_id: null, mapped_at: null,
              request_count: 1, first_requested_at: firstRequestedAt, last_requested_at: lastRequestedAt,
            });
            return { meta: { changes: 1 } };
          }
          throw new Error(`fake D1: unhandled run() query: ${trimmed}`);
        },
      };
    }

    return statement([]);
  }

  return { prepare, rows } as unknown as D1Database & { rows: Map<string, FakePlaceRow> };
}

const API_KEY = 'test-key';

function makeEnv(seed: FakePlaceRow[] = []): Env {
  return {
    REGISTRY_DB: createFakePlaceDb(seed),
    POI_EXPORTS: {} as R2Bucket,
    API_KEY,
  };
}

function coverageRequest(lat: number, lng: number) {
  return new Request('https://poi-api.brushaway.app/coverage/request', {
    method: 'POST',
    headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng }),
  });
}

/** Resolves cleanly on the first (finest) zoom candidate — no address.city/town/etc key at all means the resolved feature already IS the settlement (Sertã/Odivelas-shaped response, not Lisboa/Porto's freguesia case — that retry path has its own dedicated test in resolvePlaceIdentity's own test file). */
const NOMINATIM_RESPONSE = {
  osm_type: 'relation',
  osm_id: 1294136,
  name: 'Sintra',
  addresstype: 'town',
  address: { country_code: 'pt' },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('POST /coverage/request', () => {
  it('returns ready without a new geocode call for an already-known mapped Place', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = makeEnv([{
      place_id: 'osm-relation-2897141', name: 'Lisboa', country_code: 'PT', place_kind: 'city',
      min_lat: 38.0, max_lat: 39.0, min_lng: -10, max_lng: -8,
      status: 'mapped', build_id: 'b1', mapped_at: '2026-01-01T00:00:00.000Z',
      request_count: 0, first_requested_at: null, last_requested_at: null,
    }]);

    const res = await worker.fetch(coverageRequest(38.7223, -9.1393), env);
    const body = await res.json() as { coverageStatus: string; cityId: string };

    expect(body).toEqual({ coverageStatus: 'ready', cityId: 'osm-relation-2897141' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records demand and returns none for a brand new Place', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify(NOMINATIM_RESPONSE), { status: 200 }),
    );
    const env = makeEnv();

    const res = await worker.fetch(coverageRequest(38.79, -9.38), env);
    const body = await res.json() as { coverageStatus: string; cityId: string };

    expect(body).toEqual({ coverageStatus: 'none', cityId: 'osm-relation-1294136' });
    const stored = (env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> }).rows.get('osm-relation-1294136');
    expect(stored?.status).toBe('none');
    expect(stored?.country_code).toBe('PT');
    expect(stored?.request_count).toBe(1);
  });

  it('dedupes: a second request for the same Place does not create a second row', async () => {
    // mockImplementation, not mockResolvedValue with a shared Response — a
    // Response body can only be read once, and this test's whole point is
    // to exercise two real fetches.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify(NOMINATIM_RESPONSE), { status: 200 }),
    );
    const env = makeEnv();

    await worker.fetch(coverageRequest(38.79, -9.38), env);
    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> };
    const firstRequestedAt = fakeDb.rows.get('osm-relation-1294136')?.first_requested_at;
    expect(firstRequestedAt).toBeTruthy();

    await worker.fetch(coverageRequest(38.795, -9.385), env);

    expect(fakeDb.rows.size).toBe(1);
    expect(fakeDb.rows.get('osm-relation-1294136')?.request_count).toBe(2);
    // first_requested_at is set once on creation and never touched again —
    // only last_requested_at/request_count move on a repeat request.
    expect(fakeDb.rows.get('osm-relation-1294136')?.first_requested_at).toBe(firstRequestedAt);
  });

  it('never returns building — a Place recorded but not yet mapped has no bbox, so a repeat request is found by stable id, not the bbox fast-path', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({
        osm_type: 'relation', osm_id: 3382149, name: 'Porto', addresstype: 'city', address: { country_code: 'pt' },
      }), { status: 200 }),
    );
    const env = makeEnv([{
      place_id: 'osm-relation-3382149', name: 'Porto', country_code: 'PT', place_kind: 'city',
      min_lat: null, max_lat: null, min_lng: null, max_lng: null,
      status: 'mapping', build_id: null, mapped_at: null,
      request_count: 3, first_requested_at: '2026-08-01T00:00:00.000Z', last_requested_at: '2026-08-01T00:00:00.000Z',
    }]);

    const res = await worker.fetch(coverageRequest(41.15, -8.61), env);
    const body = await res.json() as { coverageStatus: string; retryAfterSeconds?: number };

    expect(body.coverageStatus).toBe('building');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  // Regression test for the real bug found while building this ticket: a
  // fixed zoom does not reliably resolve "the settlement" — a point in
  // central Lisboa resolves to "Arroios" (one of its freguesia
  // subdivisions) at zoom=10, not "Lisboa" itself. resolvePlaceIdentity
  // must retry at a coarser zoom until the resolved feature's own name
  // matches the settlement address.city names, rather than recording a
  // freguesia as if it were the municipality.
  it('retries at a coarser zoom when the finest zoom resolves to a sub-unit of a named settlement (the Lisboa freguesia bug)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        osm_type: 'relation', osm_id: 6384187, name: 'Arroios', addresstype: 'suburb',
        address: { city: 'Lisboa', country_code: 'pt' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        osm_type: 'relation', osm_id: 2897141, name: 'Lisboa', addresstype: 'administrative',
        address: { country_code: 'pt' },
      }), { status: 200 }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
    const env = makeEnv();

    const res = await worker.fetch(coverageRequest(38.7223, -9.1393), env);
    const body = await res.json() as { coverageStatus: string; cityId: string };

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('zoom=10');
    expect(fetchMock.mock.calls[1][0]).toContain('zoom=9');
    // Records the municipality's own stable id, not the freguesia's.
    expect(body.cityId).toBe('osm-relation-2897141');
    const stored = (env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> }).rows.get('osm-relation-2897141');
    expect(stored?.name).toBe('Lisboa');
  });

  it('gives up after exhausting all zoom candidates without a clean resolution', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      osm_type: 'relation', osm_id: 1, name: 'Never Matches', addresstype: 'suburb',
      address: { city: 'Something Else', country_code: 'pt' },
    }), { status: 200 }));
    const env = makeEnv();

    const res = await worker.fetch(coverageRequest(38.7223, -9.1393), env);
    const body = await res.json() as { coverageStatus: string; cityId: string | null };

    expect(body).toEqual({ coverageStatus: 'none', cityId: null });
    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> };
    expect(fakeDb.rows.size).toBe(0);
  });

  it('returns none without recording demand when reverse geocoding fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const env = makeEnv();

    const res = await worker.fetch(coverageRequest(38.79, -9.38), env);
    const body = await res.json() as { coverageStatus: string; cityId: string | null };

    expect(body).toEqual({ coverageStatus: 'none', cityId: null });
    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> };
    expect(fakeDb.rows.size).toBe(0);
  });

  it('rejects a brand new Place once the pending-demand budget is exhausted', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify(NOMINATIM_RESPONSE), { status: 200 }),
    );
    const pending: FakePlaceRow[] = Array.from({ length: 50 }, (_, i) => ({
      place_id: `pending-${i}`, name: `Pending ${i}`, country_code: 'PT', place_kind: null,
      min_lat: null, max_lat: null, min_lng: null, max_lng: null,
      status: 'none', build_id: null, mapped_at: null,
      request_count: 1, first_requested_at: null, last_requested_at: null,
    }));
    const env = makeEnv(pending);

    const res = await worker.fetch(coverageRequest(38.79, -9.38), env);

    expect(res.status).toBe(429);
    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> };
    expect(fakeDb.rows.has('osm-relation-1294136')).toBe(false);
  });

  it('rejects invalid coordinates', async () => {
    const env = makeEnv();
    const res = await worker.fetch(coverageRequest(999, -9.38), env);
    expect(res.status).toBe(400);
  });

  it('rejects a missing X-Api-Key', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://poi-api.brushaway.app/coverage/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: 38.79, lng: -9.38 }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
