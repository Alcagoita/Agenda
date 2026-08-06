import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * KAN-354: the extraction pipeline runs as a Cloudflare Container, started
 * via getContainer(env.EXTRACTION_CONTAINER, key).start(...) — mocked here
 * so these tests assert "a build was triggered" without needing a real
 * Container runtime. `Container` (the base class extractionContainer.ts
 * extends) only needs to exist and be extendable — its actual behavior
 * isn't exercised by these Worker-level tests.
 */
const { mockContainerStart, mockGetContainer } = vi.hoisted(() => {
  const mockContainerStart = vi.fn().mockResolvedValue(undefined);
  const mockGetContainer = vi.fn((_namespace: unknown, _key: unknown) => ({ start: mockContainerStart }));
  return { mockContainerStart, mockGetContainer };
});
vi.mock('@cloudflare/containers', () => ({
  getContainer: (namespace: unknown, key: unknown) => mockGetContainer(namespace, key),
  Container: class {},
}));

import worker, { type Env } from '../index';

/**
 * Hand-rolled fake D1 — no @cloudflare/vitest-pool-workers/miniflare D1
 * wiring exists in this project yet, so this stands in for exactly the
 * `place`/`country`/`build_log` queries index.ts issues, not a general SQL
 * engine. Brittle to a query-text change in index.ts by design — that's the
 * tradeoff for testing the real handler logic (dedupe, budget cap, demand
 * bump, build triggering) without a full SQLite dependency.
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

interface FakeCountryRow {
  country_code: string;
  name: string;
  status: 'none' | 'mapping' | 'mapped';
  build_id: string | null;
  mapped_at: string | null;
  place_count: number;
}

interface FakeBuildLogRow {
  build_id: string;
  place_id: string;
  status: 'building' | 'ready' | 'failed';
  finished_at: string | null;
}

interface FakeCountryAuditRow {
  build_id: string; country_code: string; source_rows: number;
  rows_with_locality: number; rows_without_locality: number;
  rows_loaded: number; rows_skipped: number;
  resolved_localities: number; unresolved_localities: number; failed_places: number;
}

function createFakeDb(seed: FakePlaceRow[] = [], countrySeed: FakeCountryRow[] = [], buildLogSeed: FakeBuildLogRow[] = []) {
  const rows = new Map(seed.map(r => [r.place_id, { ...r }]));
  const countryRows = new Map(countrySeed.map(r => [r.country_code, { ...r }]));
  const buildLogRows = new Map(buildLogSeed.map(r => [r.build_id, { ...r }]));
  const countryAuditRows = new Map<string, FakeCountryAuditRow>();

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
          if (trimmed.startsWith('SELECT * FROM country WHERE country_code = ?')) {
            return (countryRows.get(args[0] as string) ?? null) as T | null;
          }
          if (trimmed.startsWith('SELECT country_code FROM country WHERE country_code = ?')) {
            const row = countryRows.get(args[0] as string);
            return (row ? { country_code: row.country_code } : null) as T | null;
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
            if (!row || row.status !== 'none') return { meta: { changes: 0 } };
            row.request_count += 1;
            row.last_requested_at = lastRequestedAt;
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith("UPDATE place SET status = 'mapping' WHERE place_id = ? AND status = 'none'")) {
            const [placeId] = args as [string];
            const row = rows.get(placeId);
            if (!row || row.status !== 'none') return { meta: { changes: 0 } };
            row.status = 'mapping';
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith("UPDATE place SET status = 'none' WHERE place_id = ? AND status = 'mapping'")) {
            const [placeId] = args as [string];
            const row = rows.get(placeId);
            if (!row || row.status !== 'mapping') return { meta: { changes: 0 } };
            row.status = 'none';
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith("UPDATE build_log SET status = 'failed'")) {
            const [finishedAt, buildId, placeId] = args as [string, string, string];
            const row = buildLogRows.get(buildId);
            if (!row || row.place_id !== placeId) return { meta: { changes: 0 } };
            row.status = 'failed';
            row.finished_at = finishedAt;
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith("UPDATE place SET status = 'mapped'")) {
            const [buildId, mappedAt, minLat, maxLat, minLng, maxLng, placeId] = args as [
              string, string, number | null, number | null, number | null, number | null, string,
            ];
            const row = rows.get(placeId);
            if (!row) return { meta: { changes: 0 } };
            row.status = 'mapped';
            row.build_id = buildId;
            row.mapped_at = mappedAt;
            row.min_lat = minLat ?? row.min_lat;
            row.max_lat = maxLat ?? row.max_lat;
            row.min_lng = minLng ?? row.min_lng;
            row.max_lng = maxLng ?? row.max_lng;
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith("UPDATE build_log SET status = 'ready'")) {
            const [finishedAt, rowsLoaded, rowsSkipped, , buildId, placeId] = args as [
              string, number | null, number | null, string | null, string, string,
            ];
            const row = buildLogRows.get(buildId);
            if (!row || row.place_id !== placeId) return { meta: { changes: 0 } };
            row.status = 'ready';
            row.finished_at = finishedAt;
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith('INSERT OR IGNORE INTO country')) {
            const [countryCode, name] = args as [string, string];
            if (!countryRows.has(countryCode)) {
              countryRows.set(countryCode, { country_code: countryCode, name, status: 'none', build_id: null, mapped_at: null, place_count: 0 });
            }
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith("UPDATE country SET status = 'mapping', place_count = 0 WHERE country_code = ? AND status = 'none'")) {
            const [countryCode] = args as [string];
            const row = countryRows.get(countryCode);
            if (!row || row.status !== 'none') return { meta: { changes: 0 } };
            row.status = 'mapping';
            row.place_count = 0;
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith("UPDATE country SET status = 'mapping' WHERE country_code = ? AND status = 'none'")) {
            const [countryCode] = args as [string];
            const row = countryRows.get(countryCode);
            if (!row || row.status !== 'none') return { meta: { changes: 0 } };
            row.status = 'mapping';
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith("UPDATE country SET status = 'none' WHERE country_code = ? AND status = 'mapping'")) {
            const [countryCode] = args as [string];
            const row = countryRows.get(countryCode);
            if (!row || row.status !== 'mapping') return { meta: { changes: 0 } };
            row.status = 'none';
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith('UPDATE country SET place_count = place_count + 1')) {
            const [countryCode] = args as [string];
            const row = countryRows.get(countryCode);
            if (!row) return { meta: { changes: 0 } };
            row.place_count += 1;
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith("UPDATE country SET status = 'mapped'")) {
            const [buildId, mappedAt, countryCode] = args as [string, string, string];
            const row = countryRows.get(countryCode);
            const audit = countryAuditRows.get(buildId);
            if (!row || row.status !== 'mapping' || !audit || audit.country_code !== countryCode || audit.failed_places !== 0) return { meta: { changes: 0 } };
            row.status = 'mapped';
            row.build_id = buildId;
            row.mapped_at = mappedAt;
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith('INSERT INTO country_import_audit')) {
            const [buildId, countryCode, sourceRows, withLocality, withoutLocality, rowsLoaded, rowsSkipped, resolved, unresolved, failed] = args as [string, string, number, number, number, number, number, number, number, number];
            countryAuditRows.set(buildId, { build_id: buildId, country_code: countryCode, source_rows: sourceRows, rows_with_locality: withLocality, rows_without_locality: withoutLocality, rows_loaded: rowsLoaded, rows_skipped: rowsSkipped, resolved_localities: resolved, unresolved_localities: unresolved, failed_places: failed });
            return { meta: { changes: 1 } };
          }
          if (trimmed.startsWith('INSERT INTO place (place_id, country_code, name, place_kind, status, request_count)')) {
            const [placeId, countryCode, name, placeKind] = args as [string, string, string, string | null];
            const existing = rows.get(placeId);
            if (existing) {
              if (existing.status === 'none') existing.status = 'mapping';
              return { meta: { changes: 1 } };
            }
            rows.set(placeId, {
              place_id: placeId, country_code: countryCode, name, place_kind: placeKind,
              status: 'mapping', min_lat: null, max_lat: null, min_lng: null, max_lng: null,
              build_id: null, mapped_at: null,
              request_count: 0, first_requested_at: null, last_requested_at: null,
            });
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

  // Sequential, not a real atomic batch — sufficient for testing the
  // handler logic each statement drives; index.ts's own comments already
  // note batch atomicity only covers real execution failures, not the
  // "0 rows matched" cases these tests actually exercise.
  async function batch(statements: { run(): Promise<{ meta: { changes: number } }> }[]) {
    const results = [];
    for (const s of statements) results.push(await s.run());
    return results;
  }

  return { prepare, batch, rows, countryRows, buildLogRows, countryAuditRows } as unknown as D1Database & {
    rows: Map<string, FakePlaceRow>; countryRows: Map<string, FakeCountryRow>; buildLogRows: Map<string, FakeBuildLogRow>; countryAuditRows: Map<string, FakeCountryAuditRow>;
  };
}

const API_KEY = 'test-key';
const BUILD_SECRET = 'build-secret';

function makeEnv(seed: FakePlaceRow[] = [], opts: { countrySeed?: FakeCountryRow[]; buildLogSeed?: FakeBuildLogRow[] } = {}): Env {
  return {
    REGISTRY_DB: createFakeDb(seed, opts.countrySeed, opts.buildLogSeed),
    POI_EXPORTS: {} as R2Bucket,
    API_KEY,
    EXTRACTION_CONTAINER: {} as Env['EXTRACTION_CONTAINER'], // getContainer() itself is mocked — never really touches this
    BUILD_TRIGGER_SECRET: BUILD_SECRET,
    FOURSQUARE_JWT: 'test-jwt',
  };
}

function coverageRequest(lat: number, lng: number) {
  return new Request('https://poi-api.brushaway.app/coverage/request', {
    method: 'POST',
    headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng }),
  });
}

function internalRequest(path: string, body: unknown, secret: string | null = BUILD_SECRET) {
  return new Request(`https://poi-api.brushaway.app${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret !== null ? { 'X-Build-Secret': secret } : {}) },
    body: JSON.stringify(body),
  });
}

/** Resolves cleanly on the first (finest) zoom candidate — no address.city/town/etc key at all means the resolved feature already IS the settlement (Sertã/Odivelas-shaped response, not Lisboa/Porto's freguesia case — that retry path has its own dedicated test). */
const NOMINATIM_RESPONSE = {
  osm_type: 'relation',
  osm_id: 1294136,
  name: 'Sintra',
  addresstype: 'town',
  address: { country_code: 'pt' },
};

function mockNominatim(body: unknown = NOMINATIM_RESPONSE) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockGetContainer.mockClear();
  mockContainerStart.mockClear();
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

  it('KAN-354: records demand, promotes a brand new Place to mapping, and starts the extraction Container', async () => {
    mockNominatim();
    const env = makeEnv();

    const res = await worker.fetch(coverageRequest(38.79, -9.38), env);
    const body = await res.json() as { coverageStatus: string; cityId: string; retryAfterSeconds?: number };

    expect(body.coverageStatus).toBe('building');
    expect(body.cityId).toBe('osm-relation-1294136');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);

    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow>; countryRows: Map<string, FakeCountryRow> };
    const stored = fakeDb.rows.get('osm-relation-1294136');
    expect(stored?.status).toBe('mapping');
    expect(stored?.country_code).toBe('PT');
    expect(fakeDb.countryRows.get('PT')).toMatchObject({ country_code: 'PT', status: 'none' });

    expect(mockGetContainer).toHaveBeenCalledWith(env.EXTRACTION_CONTAINER, expect.stringContaining('place:osm-relation-1294136:'));
    expect(mockContainerStart).toHaveBeenCalledWith({
      envVars: { MODE: 'place', TARGET: 'osm-relation-1294136', BUILD_TRIGGER_SECRET: BUILD_SECRET, FOURSQUARE_JWT: 'test-jwt' },
    });
  });

  it('dedupes: a second request for the same Place does not queue a second build — the row is already mapping', async () => {
    mockNominatim();
    const env = makeEnv();

    await worker.fetch(coverageRequest(38.79, -9.38), env);
    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> };
    expect(fakeDb.rows.get('osm-relation-1294136')?.status).toBe('mapping');
    expect(mockContainerStart).toHaveBeenCalledTimes(1);

    await worker.fetch(coverageRequest(38.795, -9.385), env);

    expect(fakeDb.rows.size).toBe(1);
    // Still 'mapping' — bumpCoverageDemand and startPlaceMapping are both
    // no-ops once status has left 'none', so a second real trigger never fires.
    expect(mockContainerStart).toHaveBeenCalledTimes(1);
  });

  it('KAN-354: concurrent requests for the same brand new Place trigger the build exactly once', async () => {
    mockNominatim();
    const env = makeEnv();

    // Both requests resolve to the same place_id before either one's INSERT
    // lands — simulates the race startPlaceMapping's WHERE status='none'
    // guard is meant to resolve.
    const [res1, res2] = await Promise.all([
      worker.fetch(coverageRequest(38.79, -9.38), env),
      worker.fetch(coverageRequest(38.795, -9.385), env),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(mockContainerStart).toHaveBeenCalledTimes(1);
  });

  it('a Place already mapping is found by stable id (no bbox yet) and does not re-trigger', async () => {
    mockNominatim({
      osm_type: 'relation', osm_id: 3382149, name: 'Porto', addresstype: 'city', address: { country_code: 'pt' },
    });
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
    expect(mockContainerStart).not.toHaveBeenCalled();
  });

  // Regression test for the real bug found while building this ticket: a
  // fixed zoom does not reliably resolve "the settlement" — a point in
  // central Lisboa resolves to "Arroios" (one of its freguesia
  // subdivisions) at zoom=10, not "Lisboa" itself. resolvePlaceIdentity
  // must retry at a coarser zoom until the resolved feature's own name
  // matches the settlement address.city names, rather than recording a
  // freguesia as if it were the municipality.
  it('retries at a coarser zoom when the finest zoom resolves to a sub-unit of a named settlement (the Lisboa freguesia bug)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('zoom=10')) {
        return new Response(JSON.stringify({
          osm_type: 'relation', osm_id: 6384187, name: 'Arroios', addresstype: 'suburb',
          address: { city: 'Lisboa', country_code: 'pt' },
        }), { status: 200 });
      }
      if (url.includes('zoom=9')) {
        return new Response(JSON.stringify({
          osm_type: 'relation', osm_id: 2897141, name: 'Lisboa', addresstype: 'administrative',
          address: { country_code: 'pt' },
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
    const env = makeEnv();

    const res = await worker.fetch(coverageRequest(38.7223, -9.1393), env);
    const body = await res.json() as { coverageStatus: string; cityId: string };

    const nominatimCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('nominatim'));
    expect(nominatimCalls).toHaveLength(2);
    expect(String(nominatimCalls[0][0])).toContain('zoom=10');
    expect(String(nominatimCalls[1][0])).toContain('zoom=9');
    // Records the municipality's own stable id, not the freguesia's.
    expect(body.cityId).toBe('osm-relation-2897141');
    const stored = (env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> }).rows.get('osm-relation-2897141');
    expect(stored?.name).toBe('Lisboa');
  });

  // The settlement-name match must tolerate case/diacritic differences
  // between address.city and the resolved feature's own name — both come
  // from the same OSM source, but aren't always byte-identical.
  it('resolves on the first zoom when the settlement name matches only after diacritic/case normalization', async () => {
    mockNominatim({
      osm_type: 'relation', osm_id: 7654321, name: 'sao paulo', addresstype: 'city',
      address: { city: 'São Paulo', country_code: 'br' },
    });
    const env = makeEnv();

    const res = await worker.fetch(coverageRequest(-23.55, -46.63), env);
    const body = await res.json() as { coverageStatus: string; cityId: string };

    expect(body.cityId).toBe('osm-relation-7654321');
    const stored = (env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> }).rows.get('osm-relation-7654321');
    expect(stored?.name).toBe('São Paulo');
  });

  it('gives up after exhausting all zoom candidates without a clean resolution', async () => {
    mockNominatim({
      osm_type: 'relation', osm_id: 1, name: 'Never Matches', addresstype: 'suburb',
      address: { city: 'Something Else', country_code: 'pt' },
    });
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
    mockNominatim();
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

describe('POST /internal/build-complete — failure path (KAN-354)', () => {
  it('reverts place to none on a failed FIRST build (never previously mapped)', async () => {
    const env = makeEnv([{
      place_id: 'osm-relation-1', name: 'New Place', country_code: 'PT', place_kind: null,
      min_lat: null, max_lat: null, min_lng: null, max_lng: null,
      status: 'mapping', build_id: null, mapped_at: null,
      request_count: 1, first_requested_at: null, last_requested_at: null,
    }], { buildLogSeed: [{ build_id: 'b1', place_id: 'osm-relation-1', status: 'building', finished_at: null }] });

    const res = await worker.fetch(
      internalRequest('/internal/build-complete', { cityId: 'osm-relation-1', buildId: 'b1', status: 'failed' }),
      env,
    );

    expect(res.status).toBe(200);
    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow>; buildLogRows: Map<string, FakeBuildLogRow> };
    expect(fakeDb.rows.get('osm-relation-1')?.status).toBe('none');
    expect(fakeDb.buildLogRows.get('b1')?.status).toBe('failed');
  });

  it('does not un-map an already-mapped Place on a failed RE-map', async () => {
    const env = makeEnv([{
      place_id: 'osm-relation-2', name: 'Already Mapped', country_code: 'PT', place_kind: null,
      min_lat: 1, max_lat: 2, min_lng: 1, max_lng: 2,
      status: 'mapped', build_id: 'old-build', mapped_at: '2026-01-01T00:00:00.000Z',
      request_count: 1, first_requested_at: null, last_requested_at: null,
    }], { buildLogSeed: [{ build_id: 'b2', place_id: 'osm-relation-2', status: 'building', finished_at: null }] });

    await worker.fetch(
      internalRequest('/internal/build-complete', { cityId: 'osm-relation-2', buildId: 'b2', status: 'failed' }),
      env,
    );

    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> };
    expect(fakeDb.rows.get('osm-relation-2')?.status).toBe('mapped');
    expect(fakeDb.rows.get('osm-relation-2')?.build_id).toBe('old-build');
  });

  it('rejects a missing/wrong X-Build-Secret', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      internalRequest('/internal/build-complete', { cityId: 'x', buildId: 'y' }, 'wrong-secret'),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('KAN-354 AC3: writes the ingested extent on success', async () => {
    const env = makeEnv([{
      place_id: 'osm-relation-3', name: 'Sertã', country_code: 'PT', place_kind: 'town',
      min_lat: null, max_lat: null, min_lng: null, max_lng: null,
      status: 'mapping', build_id: null, mapped_at: null,
      request_count: 1, first_requested_at: null, last_requested_at: null,
    }], { buildLogSeed: [{ build_id: 'b3', place_id: 'osm-relation-3', status: 'building', finished_at: null }] });

    const res = await worker.fetch(
      internalRequest('/internal/build-complete', {
        cityId: 'osm-relation-3', buildId: 'b3', rowsLoaded: 120, rowsSkipped: 4,
        minLat: 39.7, maxLat: 39.9, minLng: -8.2, maxLng: -8.0,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow>; buildLogRows: Map<string, FakeBuildLogRow> };
    expect(fakeDb.rows.get('osm-relation-3')).toMatchObject({
      status: 'mapped', build_id: 'b3', min_lat: 39.7, max_lat: 39.9, min_lng: -8.2, max_lng: -8.0,
    });
    expect(fakeDb.buildLogRows.get('b3')?.status).toBe('ready');
  });
});

describe('POST /internal/place-failed', () => {
  it('reverts a never-mapped Place to none', async () => {
    const env = makeEnv([{
      place_id: 'osm-relation-4', name: 'Failed Early', country_code: 'PT', place_kind: null,
      min_lat: null, max_lat: null, min_lng: null, max_lng: null,
      status: 'mapping', build_id: null, mapped_at: null,
      request_count: 1, first_requested_at: null, last_requested_at: null,
    }]);

    const res = await worker.fetch(internalRequest('/internal/place-failed', { cityId: 'osm-relation-4' }), env);

    expect(res.status).toBe(200);
    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> };
    expect(fakeDb.rows.get('osm-relation-4')?.status).toBe('none');
  });

  it('logs bounded diagnostic metadata from the trusted Container callback', async () => {
    const env = makeEnv([{
      place_id: 'osm-relation-6', name: 'Failed Early', country_code: 'PT', place_kind: null,
      min_lat: null, max_lat: null, min_lng: null, max_lng: null,
      status: 'mapping', build_id: null, mapped_at: null,
      request_count: 1, first_requested_at: null, last_requested_at: null,
    }]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await worker.fetch(internalRequest('/internal/place-failed', {
      cityId: 'osm-relation-6', stage: 'foursquare_extract', error: 'CatalogException',
    }), env);

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith('[extraction] Place job failed', {
      cityId: 'osm-relation-6', stage: 'foursquare_extract', error: 'CatalogException',
    });
  });

  it('does not un-map an already-mapped Place', async () => {
    const env = makeEnv([{
      place_id: 'osm-relation-5', name: 'Already Mapped', country_code: 'PT', place_kind: null,
      min_lat: 1, max_lat: 2, min_lng: 1, max_lng: 2,
      status: 'mapped', build_id: 'old-build', mapped_at: '2026-01-01T00:00:00.000Z',
      request_count: 1, first_requested_at: null, last_requested_at: null,
    }]);

    await worker.fetch(internalRequest('/internal/place-failed', { cityId: 'osm-relation-5' }), env);

    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> };
    expect(fakeDb.rows.get('osm-relation-5')?.status).toBe('mapped');
  });

  it('rejects a missing X-Build-Secret', async () => {
    const env = makeEnv();
    const res = await worker.fetch(internalRequest('/internal/place-failed', { cityId: 'x' }, null), env);
    expect(res.status).toBe(401);
  });
});

describe('POST /internal/country/queue', () => {
  it('starts an authenticated country job and resets visible progress', async () => {
    const env = makeEnv([], { countrySeed: [{ country_code: 'PT', name: 'Portugal', status: 'none', build_id: null, mapped_at: null, place_count: 0 }] });

    const res = await worker.fetch(internalRequest('/internal/country/queue', { countryCode: 'PT' }), env);

    expect(res.status).toBe(200);
    expect(mockContainerStart).toHaveBeenCalledTimes(1);
    const fakeDb = env.REGISTRY_DB as unknown as { countryRows: Map<string, FakeCountryRow> };
    expect(fakeDb.countryRows.get('PT')).toMatchObject({ status: 'mapping', place_count: 0 });
  });

  it('rejects a missing X-Build-Secret', async () => {
    const env = makeEnv();
    const res = await worker.fetch(internalRequest('/internal/country/queue', { countryCode: 'PT' }, null), env);
    expect(res.status).toBe(401);
  });
});

describe('POST /internal/place/ensure', () => {
  it('creates a newly discovered country Place in mapping state without touching its identity', async () => {
    const env = makeEnv([], { countrySeed: [{ country_code: 'PT', name: 'Portugal', status: 'mapping', build_id: null, mapped_at: null, place_count: 0 }] });

    const res = await worker.fetch(internalRequest('/internal/place/ensure', {
      placeId: 'osm-relation-99', countryCode: 'pt', name: 'Example Town', placeKind: 'town',
    }), env);

    expect(res.status).toBe(200);
    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> };
    expect(fakeDb.rows.get('osm-relation-99')).toMatchObject({
      country_code: 'PT', name: 'Example Town', place_kind: 'town', status: 'mapping',
    });
  });

  it('promotes an existing demand-only Place to mapping without changing its identity', async () => {
    const env = makeEnv([{
      place_id: 'osm-relation-100', name: 'Demand Town', country_code: 'PT', place_kind: 'town',
      status: 'none', min_lat: null, max_lat: null, min_lng: null, max_lng: null,
      build_id: null, mapped_at: null, request_count: 4,
      first_requested_at: '2026-08-01T00:00:00.000Z', last_requested_at: '2026-08-02T00:00:00.000Z',
    }], { countrySeed: [{ country_code: 'PT', name: 'Portugal', status: 'mapping', build_id: null, mapped_at: null, place_count: 0 }] });

    await worker.fetch(internalRequest('/internal/place/ensure', {
      placeId: 'osm-relation-100', countryCode: 'PT', name: 'Ignored Rename', placeKind: 'city',
    }), env);

    const fakeDb = env.REGISTRY_DB as unknown as { rows: Map<string, FakePlaceRow> };
    expect(fakeDb.rows.get('osm-relation-100')).toMatchObject({
      name: 'Demand Town', place_kind: 'town', request_count: 4, status: 'mapping',
    });
  });
});

describe('POST /internal/country-audit', () => {
  it('persists reconciled full-country accounting', async () => {
    const env = makeEnv([], { countrySeed: [{ country_code: 'PT', name: 'Portugal', status: 'mapping', build_id: null, mapped_at: null, place_count: 0 }] });
    const res = await worker.fetch(internalRequest('/internal/country-audit', {
      countryCode: 'PT', buildId: 'country-audit-1', sourceRows: 10, rowsWithLocality: 8, rowsWithoutLocality: 2,
      rowsLoaded: 7, rowsSkipped: 3, resolvedLocalities: 5, unresolvedLocalities: 1, failedPlaces: 0,
    }), env);
    expect(res.status).toBe(200);
    const db = env.REGISTRY_DB as unknown as { countryAuditRows: Map<string, FakeCountryAuditRow> };
    expect(db.countryAuditRows.get('country-audit-1')).toEqual({
      build_id: 'country-audit-1', country_code: 'PT', source_rows: 10,
      rows_with_locality: 8, rows_without_locality: 2, rows_loaded: 7, rows_skipped: 3,
      resolved_localities: 5, unresolved_localities: 1, failed_places: 0,
    });
  });

  it('rejects unreconciled counts before a country can be marked ready', async () => {
    const env = makeEnv([], { countrySeed: [{ country_code: 'PT', name: 'Portugal', status: 'mapping', build_id: null, mapped_at: null, place_count: 0 }] });
    const res = await worker.fetch(internalRequest('/internal/country-audit', {
      countryCode: 'PT', buildId: 'bad-audit', sourceRows: 10, rowsWithLocality: 8, rowsWithoutLocality: 2,
      rowsLoaded: 6, rowsSkipped: 3, resolvedLocalities: 5, unresolvedLocalities: 1, failedPlaces: 0,
    }), env);
    expect(res.status).toBe(409);
  });

  it('rejects non-integer counts, failed Places, and an unknown country', async () => {
    const env = makeEnv([], { countrySeed: [{ country_code: 'PT', name: 'Portugal', status: 'mapping', build_id: null, mapped_at: null, place_count: 0 }] });
    const base = { countryCode: 'PT', buildId: 'audit', sourceRows: 10, rowsWithLocality: 8, rowsWithoutLocality: 2, rowsLoaded: 7, rowsSkipped: 3, resolvedLocalities: 5, unresolvedLocalities: 1, failedPlaces: 0 };
    expect((await worker.fetch(internalRequest('/internal/country-audit', { ...base, sourceRows: 10.5 }), env)).status).toBe(400);
    expect((await worker.fetch(internalRequest('/internal/country-audit', { ...base, failedPlaces: 1 }), env)).status).toBe(409);
    expect((await worker.fetch(internalRequest('/internal/country-audit', { ...base, countryCode: 'ES' }), env)).status).toBe(404);
  });
});

describe('POST /internal/country-progress / country-complete / country-failed', () => {
  it('increments place_count on each progress call', async () => {
    const env = makeEnv([], { countrySeed: [{ country_code: 'PT', name: 'Portugal', status: 'mapping', build_id: null, mapped_at: null, place_count: 3 }] });

    await worker.fetch(internalRequest('/internal/country-progress', { countryCode: 'PT' }), env);

    const fakeDb = env.REGISTRY_DB as unknown as { countryRows: Map<string, FakeCountryRow> };
    expect(fakeDb.countryRows.get('PT')?.place_count).toBe(4);
  });

  it('marks a country mapped with its build id', async () => {
    const env = makeEnv([], { countrySeed: [{ country_code: 'PT', name: 'Portugal', status: 'mapping', build_id: null, mapped_at: null, place_count: 300 }] });

    await worker.fetch(internalRequest('/internal/country-audit', {
      countryCode: 'PT', buildId: 'country-build-1', sourceRows: 10, rowsWithLocality: 8, rowsWithoutLocality: 2,
      rowsLoaded: 7, rowsSkipped: 3, resolvedLocalities: 5, unresolvedLocalities: 1, failedPlaces: 0,
    }), env);

    const res = await worker.fetch(internalRequest('/internal/country-complete', { countryCode: 'PT', buildId: 'country-build-1' }), env);

    expect(res.status).toBe(200);
    const fakeDb = env.REGISTRY_DB as unknown as { countryRows: Map<string, FakeCountryRow> };
    expect(fakeDb.countryRows.get('PT')).toMatchObject({ status: 'mapped', build_id: 'country-build-1' });
  });

  it('blocks completion without a matching valid audit', async () => {
    const env = makeEnv([], { countrySeed: [{ country_code: 'PT', name: 'Portugal', status: 'mapping', build_id: null, mapped_at: null, place_count: 0 }] });
    const res = await worker.fetch(internalRequest('/internal/country-complete', { countryCode: 'PT', buildId: 'missing-audit' }), env);
    expect(res.status).toBe(409);
    const fakeDb = env.REGISTRY_DB as unknown as { countryRows: Map<string, FakeCountryRow> };
    expect(fakeDb.countryRows.get('PT')?.status).toBe('mapping');
  });

  it('reverts a mapping country to none on failure, so it can be re-queued', async () => {
    const env = makeEnv([], { countrySeed: [{ country_code: 'PT', name: 'Portugal', status: 'mapping', build_id: null, mapped_at: null, place_count: 12 }] });

    const res = await worker.fetch(internalRequest('/internal/country-failed', { countryCode: 'PT' }), env);

    expect(res.status).toBe(200);
    const fakeDb = env.REGISTRY_DB as unknown as { countryRows: Map<string, FakeCountryRow> };
    expect(fakeDb.countryRows.get('PT')?.status).toBe('none');
  });

  it('does not clobber an already-mapped country on a stale failure callback', async () => {
    const env = makeEnv([], { countrySeed: [{ country_code: 'PT', name: 'Portugal', status: 'mapped', build_id: 'b1', mapped_at: '2026-01-01T00:00:00.000Z', place_count: 300 }] });

    await worker.fetch(internalRequest('/internal/country-failed', { countryCode: 'PT' }), env);

    const fakeDb = env.REGISTRY_DB as unknown as { countryRows: Map<string, FakeCountryRow> };
    expect(fakeDb.countryRows.get('PT')?.status).toBe('mapped');
  });
});
