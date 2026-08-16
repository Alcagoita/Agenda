import { describe, expect, it, vi } from 'vitest';

const { mockStart } = vi.hoisted(() => ({ mockStart: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: mockStart }),
  Container: class {},
}));

import worker, { type Env } from '../index';

type ImportRow = { status: 'none' | 'mapping' | 'mapped' | 'failed'; active_run_id: string | null };

function fakeDb(countryStatus: string = 'mapped', registryStatus: string = 'mapped') {
  let row: ImportRow | null = null;
  const prepare = (sql: string) => {
    const trimmed = sql.trim();
    const statement = (args: unknown[] = []) => ({
      bind: (...next: unknown[]) => statement(next),
      async first<T>() {
        if (trimmed.startsWith('SELECT status FROM country')) return { status: countryStatus } as T;
        if (trimmed.startsWith('SELECT status FROM settlement_registry_import')) return { status: registryStatus } as T;
        if (trimmed.startsWith('SELECT status, active_run_id FROM osm_supplement_import')) return row as T | null;
        throw new Error(`unhandled first: ${trimmed}`);
      },
      async run() {
        if (trimmed.startsWith('INSERT INTO osm_supplement_import')) {
          if (row?.status === 'mapping') return { meta: { changes: 0 } };
          row = { status: 'mapping', active_run_id: args[1] as string };
          return { meta: { changes: 1 } };
        }
        if (trimmed.startsWith('UPDATE osm_supplement_import\n         SET status = \'mapped\'')) {
          if (!row || row.status !== 'mapping' || row.active_run_id !== args[6]) return { meta: { changes: 0 } };
          row.status = 'mapped';
          return { meta: { changes: 1 } };
        }
        if (trimmed.startsWith('UPDATE osm_supplement_import\n         SET status = \'failed\'')) {
          if (!row || row.status !== 'mapping' || row.active_run_id !== args[3]) return { meta: { changes: 0 } };
          row.status = 'failed';
          return { meta: { changes: 1 } };
        }
        throw new Error(`unhandled run: ${trimmed}`);
      },
    });
    return statement();
  };
  return { prepare } as unknown as Env['REGISTRY_DB'];
}

const CTX = { waitUntil(_promise: Promise<unknown>) {}, passThroughOnException() {} } as unknown as ExecutionContext;

function request(path: string, body: unknown) {
  return new Request(`https://poi-api.test${path}`, {
    method: 'POST', headers: { 'X-Build-Secret': 'secret', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('KAN-383 OSM supplement queue', () => {
  it('starts only one country job while the run is mapping', async () => {
    mockStart.mockClear();
    const env = { BUILD_TRIGGER_SECRET: 'secret', REGISTRY_DB: fakeDb(), EXTRACTION_CONTAINER: {} } as unknown as Env;
    const first = await worker.fetch(request('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(expect.objectContaining({ status: 'mapping', started: true }));
    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ envVars: expect.objectContaining({ MODE: 'osm-country', TARGET: 'PT', D1_INTERNAL: '1' }) }));

    const second = await worker.fetch(request('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(expect.objectContaining({ status: 'mapping', started: false }));
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale completion callback', async () => {
    const env = { BUILD_TRIGGER_SECRET: 'secret', REGISTRY_DB: fakeDb(), EXTRACTION_CONTAINER: {} } as unknown as Env;
    await worker.fetch(request('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    const response = await worker.fetch(request('/internal/osm-supplement/complete', {
      countryCode: 'PT', runId: 'stale', sourceElements: 1, insertedRows: 1, matchedSkipped: 0, ambiguousSkipped: 0,
    }), env, CTX);
    expect(response.status).toBe(409);
  });

  it('accepts failure only from the active run', async () => {
    mockStart.mockClear();
    const env = { BUILD_TRIGGER_SECRET: 'secret', REGISTRY_DB: fakeDb(), EXTRACTION_CONTAINER: {} } as unknown as Env;
    await worker.fetch(request('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    const runId = (mockStart.mock.calls[0][0] as { envVars: { OSM_SUPPLEMENT_RUN_ID: string } }).envVars.OSM_SUPPLEMENT_RUN_ID;

    const failed = await worker.fetch(request('/internal/osm-supplement/failed', {
      countryCode: 'PT', runId, error: 'scope osm-relation-1 timed out',
    }), env, CTX);
    expect(failed.status).toBe(200);

    const stale = await worker.fetch(request('/internal/osm-supplement/failed', {
      countryCode: 'PT', runId: 'stale', error: 'old failure',
    }), env, CTX);
    expect(stale.status).toBe(409);
  });

  it('requires mapped country and settlement registry state before queueing', async () => {
    const countryNotMapped = { BUILD_TRIGGER_SECRET: 'secret', REGISTRY_DB: fakeDb('mapping'), EXTRACTION_CONTAINER: {} } as unknown as Env;
    const blockedCountry = await worker.fetch(request('/internal/osm-supplement/queue', { countryCode: 'PT' }), countryNotMapped, CTX);
    expect(blockedCountry.status).toBe(409);

    const registryNotMapped = { BUILD_TRIGGER_SECRET: 'secret', REGISTRY_DB: fakeDb('mapped', 'mapping'), EXTRACTION_CONTAINER: {} } as unknown as Env;
    const blockedRegistry = await worker.fetch(request('/internal/osm-supplement/queue', { countryCode: 'PT' }), registryNotMapped, CTX);
    expect(blockedRegistry.status).toBe(409);
  });
});
