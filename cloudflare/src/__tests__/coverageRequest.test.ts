import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker, { type Env } from '../index';

/**
 * Hand-rolled fake D1 — no @cloudflare/vitest-pool-workers/miniflare D1
 * wiring exists in this project yet, so this stands in for exactly the
 * `city` queries POST /coverage/request issues (see index.ts), not a
 * general SQL engine. Brittle to a query-text change in index.ts by
 * design — that's the tradeoff for testing the real handler logic (dedupe,
 * budget cap, demand bump) without a full SQLite dependency.
 */
interface FakeCityRow {
  city_id: string;
  name: string;
  country: string | null;
  center_lat: number;
  center_lng: number;
  radius_km: number;
  min_lat: number | null;
  max_lat: number | null;
  min_lng: number | null;
  max_lng: number | null;
  status: 'none' | 'building' | 'ready';
  current_build_id: string | null;
  last_built_at: string | null;
  request_count: number;
  first_requested_at: string | null;
  last_requested_at: string | null;
}

function createFakeCityDb(seed: FakeCityRow[] = []) {
  const rows = new Map(seed.map(r => [r.city_id, { ...r }]));

  function prepare(sql: string) {
    const trimmed = sql.trim();

    function statement(args: unknown[]) {
      return {
        bind(...nextArgs: unknown[]) {
          return statement(nextArgs);
        },
        async first<T>(): Promise<T | null> {
          if (trimmed.startsWith('SELECT * FROM city WHERE city_id = ?')) {
            return (rows.get(args[0] as string) ?? null) as T | null;
          }
          throw new Error(`fake D1: unhandled first() query: ${trimmed}`);
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (trimmed === 'SELECT * FROM city') {
            return { results: [...rows.values()] as unknown as T[] };
          }
          if (trimmed.startsWith("SELECT COUNT(*) as n FROM city WHERE status = 'none'")) {
            const n = [...rows.values()].filter(r => r.status === 'none').length;
            return { results: [{ n }] as unknown as T[] };
          }
          throw new Error(`fake D1: unhandled all() query: ${trimmed}`);
        },
        async run(): Promise<{ meta: { changes: number } }> {
          if (trimmed.startsWith('UPDATE city SET request_count = request_count + 1')) {
            const [lastRequestedAt, cityId] = args as [string, string];
            const row = rows.get(cityId);
            if (!row) return { meta: { changes: 0 } };
            row.request_count += 1;
            row.last_requested_at = lastRequestedAt;
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith('INSERT INTO city')) {
            const [
              cityId, name, country, centerLat, centerLng, radiusKm,
              minLat, maxLat, minLng, maxLng, firstRequestedAt, lastRequestedAt,
            ] = args as [
              string, string, string | null, number, number, number,
              number, number, number, number, string, string,
            ];
            const existing = rows.get(cityId);
            if (existing) {
              // ON CONFLICT DO UPDATE ... WHERE status = 'none'
              if (existing.status === 'none') {
                existing.request_count += 1;
                existing.last_requested_at = lastRequestedAt;
              }
              return { meta: { changes: 1 } };
            }
            rows.set(cityId, {
              city_id: cityId, name, country, center_lat: centerLat, center_lng: centerLng,
              radius_km: radiusKm, min_lat: minLat, max_lat: maxLat, min_lng: minLng, max_lng: maxLng,
              status: 'none', current_build_id: null, last_built_at: null,
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

  return { prepare, rows } as unknown as D1Database & { rows: Map<string, FakeCityRow> };
}

const API_KEY = 'test-key';

function makeEnv(seed: FakeCityRow[] = []): Env {
  return {
    REGISTRY_DB: createFakeCityDb(seed),
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

const NOMINATIM_RESPONSE = {
  osm_type: 'relation',
  osm_id: 1294136,
  boundingbox: ['38.70', '38.80', '-9.25', '-9.05'],
  address: { city: 'Sintra', country: 'Portugal' },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('POST /coverage/request', () => {
  it('returns ready without a new geocode call for an already-known ready city', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = makeEnv([{
      city_id: 'lisboa', name: 'Lisboa', country: 'Portugal',
      center_lat: 38.7223, center_lng: -9.1393, radius_km: 10,
      min_lat: null, max_lat: null, min_lng: null, max_lng: null,
      status: 'ready', current_build_id: 'b1', last_built_at: '2026-01-01T00:00:00.000Z',
      request_count: 0, first_requested_at: null, last_requested_at: null,
    }]);

    const res = await worker.fetch(coverageRequest(38.7223, -9.1393), env);
    const body = await res.json() as { coverageStatus: string; cityId: string };

    expect(body).toEqual({ coverageStatus: 'ready', cityId: 'lisboa' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records demand and returns none for a brand new municipality', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify(NOMINATIM_RESPONSE), { status: 200 }),
    );
    const env = makeEnv();

    const res = await worker.fetch(coverageRequest(38.79, -9.38), env);
    const body = await res.json() as { coverageStatus: string; cityId: string };

    expect(body).toEqual({ coverageStatus: 'none', cityId: 'osm-relation-1294136' });
    const stored = (env.REGISTRY_DB as unknown as { rows: Map<string, FakeCityRow> }).rows.get('osm-relation-1294136');
    expect(stored?.status).toBe('none');
    expect(stored?.request_count).toBe(1);
  });

  it('dedupes: a second request for the same municipality does not create a second row', async () => {
    // mockImplementation, not mockResolvedValue with a shared Response — a
    // Response body can only be read once, and this test's whole point is
    // to exercise two real fetches.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify(NOMINATIM_RESPONSE), { status: 200 }),
    );
    const env = makeEnv();

    await worker.fetch(coverageRequest(38.79, -9.38), env);
    await worker.fetch(coverageRequest(38.795, -9.385), env);

    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakeCityRow> };
    expect(fakeDb.rows.size).toBe(1);
    expect(fakeDb.rows.get('osm-relation-1294136')?.request_count).toBe(2);
  });

  it('never returns building — a legacy row cannot exist in that state without KAN-354, but the contract is asserted anyway', async () => {
    const env = makeEnv([{
      city_id: 'porto', name: 'Porto', country: 'Portugal',
      center_lat: 41.15, center_lng: -8.61, radius_km: 8,
      min_lat: null, max_lat: null, min_lng: null, max_lng: null,
      status: 'building', current_build_id: null, last_built_at: null,
      request_count: 3, first_requested_at: '2026-08-01T00:00:00.000Z', last_requested_at: '2026-08-01T00:00:00.000Z',
    }]);

    const res = await worker.fetch(coverageRequest(41.15, -8.61), env);
    const body = await res.json() as { coverageStatus: string; retryAfterSeconds?: number };

    expect(body.coverageStatus).toBe('building');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('returns none without recording demand when reverse geocoding fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const env = makeEnv();

    const res = await worker.fetch(coverageRequest(38.79, -9.38), env);
    const body = await res.json() as { coverageStatus: string; cityId: string | null };

    expect(body).toEqual({ coverageStatus: 'none', cityId: null });
    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakeCityRow> };
    expect(fakeDb.rows.size).toBe(0);
  });

  it('rejects a brand new municipality once the pending-demand budget is exhausted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(NOMINATIM_RESPONSE), { status: 200 }),
    );
    const pending: FakeCityRow[] = Array.from({ length: 50 }, (_, i) => ({
      city_id: `pending-${i}`, name: `Pending ${i}`, country: 'Portugal',
      center_lat: 0, center_lng: 0, radius_km: 1,
      min_lat: null, max_lat: null, min_lng: null, max_lng: null,
      status: 'none', current_build_id: null, last_built_at: null,
      request_count: 1, first_requested_at: null, last_requested_at: null,
    }));
    const env = makeEnv(pending);

    const res = await worker.fetch(coverageRequest(38.79, -9.38), env);

    expect(res.status).toBe(429);
    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakeCityRow> };
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
