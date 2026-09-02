import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { d1Binding, schemaDb } from './d1TestDb';

const { mockStart } = vi.hoisted(() => ({ mockStart: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: mockStart }),
  Container: class {},
}));

import worker, { type Env } from '../index';

function testDb(municipalities = 3) {
  const db = schemaDb();
  db.prepare('INSERT INTO country (country_code, name, status) VALUES (?, ?, ?)').run('PT', 'Portugal', 'mapped');
  for (let index = 0; index < municipalities; index += 1) {
    db.prepare(
      `INSERT INTO place (place_id, country_code, name, place_kind, status, request_count, min_lat, max_lat, min_lng, max_lng)
       VALUES (?, 'PT', ?, 'municipality', 'mapped', 0, 38.0, 38.1, -9.2, -9.1)`,
    ).run(`relation/${5400891 + index}`, `Town ${index}`);
  }
  return db;
}

function envFor(db: DatabaseSync): Env {
  return { BUILD_TRIGGER_SECRET: 'secret', REGISTRY_DB: d1Binding(db), EXTRACTION_CONTAINER: {} } as unknown as Env;
}

const CTX = { waitUntil(_promise: Promise<unknown>) {}, passThroughOnException() {} } as unknown as ExecutionContext;
const post = (path: string, body: unknown) => new Request(`https://poi-api.test${path}`, {
  method: 'POST', headers: { 'X-Build-Secret': 'secret', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const get = (path: string) => new Request(`https://poi-api.test${path}`, { headers: { 'X-Build-Secret': 'secret' } });

beforeEach(() => mockStart.mockClear());

describe('KAN-440 MULTIBANCO import job', () => {
  it('claims and checkpoints bounded scopes, then finalizes without duplicate work', async () => {
    const db = testDb(2);
    const env = envFor(db);
    const queued = await worker.fetch(post('/internal/multibanco/queue', { countryCode: 'PT' }), env, CTX);
    expect(queued.status).toBe(200);
    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({
      envVars: expect.objectContaining({ MODE: 'multibanco-country', TARGET: 'PT', D1_INTERNAL: '1' }),
    }));
    const runId = (mockStart.mock.calls.at(-1)?.[0] as { envVars: { MULTIBANCO_RUN_ID: string } }).envVars.MULTIBANCO_RUN_ID;
    const claim = await (await worker.fetch(post('/internal/multibanco/claim', {
      countryCode: 'PT', runId, workerId: 'w1', batchSize: 8,
    }), env, CTX)).json<{ scopes: Array<{ placeId: string }> }>();
    expect(claim.scopes).toHaveLength(2);
    for (const scope of claim.scopes) {
      expect((await worker.fetch(post('/internal/multibanco/scope-result', {
        countryCode: 'PT', placeId: scope.placeId, workerId: 'w1', status: 'completed',
        published: 10, rejected: 1, duplicates: 2,
      }), env, CTX)).status).toBe(200);
    }
    const released = await (await worker.fetch(post('/internal/multibanco/batch-release', {
      countryCode: 'PT', runId, workerId: 'w1', outcome: 'done',
    }), env, CTX)).json<{ finalized: boolean; counts: { published: number } }>();
    expect(released.finalized).toBe(true);
    expect(released.counts.published).toBe(20);
    expect((db.prepare('SELECT status FROM multibanco_import WHERE country_code = ?').get('PT') as { status: string }).status).toBe('mapped');
    const status = await (await worker.fetch(get('/internal/multibanco/status?countryCode=PT'), env, CTX))
      .json<{ nationalCount: { minExpected: number; maxExpected: number; withinExpectedRange: boolean } }>();
    expect(status.nationalCount).toMatchObject({ minExpected: 11645, maxExpected: 15755, withinExpectedRange: false });
  });

  it('releases all claimed scopes without charging attempts after a locator rate limit', async () => {
    const db = testDb(1);
    const env = envFor(db);
    await worker.fetch(post('/internal/multibanco/queue', { countryCode: 'PT' }), env, CTX);
    const runId = (mockStart.mock.calls.at(-1)?.[0] as { envVars: { MULTIBANCO_RUN_ID: string } }).envVars.MULTIBANCO_RUN_ID;
    await worker.fetch(post('/internal/multibanco/claim', { countryCode: 'PT', runId, workerId: 'w1', batchSize: 1 }), env, CTX);
    const released = await worker.fetch(post('/internal/multibanco/batch-release', {
      countryCode: 'PT', runId, workerId: 'w1', outcome: 'rate_limited',
    }), env, CTX);
    expect(released.status).toBe(200);
    const scope = db.prepare('SELECT status, attempts FROM multibanco_import_scope').get() as { status: string; attempts: number };
    expect(scope).toEqual({ status: 'pending', attempts: 0 });
  });

  it('rejects non-Portugal queues and does not leave a zero-scope run mapping', async () => {
    const foreign = await worker.fetch(post('/internal/multibanco/queue', { countryCode: 'ES' }), envFor(testDb()));
    expect(foreign.status).toBe(400);

    const db = testDb(0);
    const empty = await worker.fetch(post('/internal/multibanco/queue', { countryCode: 'PT' }), envFor(db), CTX);
    expect(empty.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS count FROM multibanco_import').get()).toEqual({ count: 0 });

    db.prepare(`INSERT INTO multibanco_import (country_code, status, active_run_id, started_at, cancel_requested)
      VALUES ('PT', 'mapping', 'orphaned-run', '2026-09-02T00:00:00.000Z', 0)`).run();
    const recovered = await worker.fetch(post('/internal/multibanco/queue', { countryCode: 'PT' }), envFor(db), CTX);
    expect(recovered.status).toBe(409);
    expect(db.prepare('SELECT status, active_run_id FROM multibanco_import WHERE country_code = ?').get('PT'))
      .toEqual({ status: 'failed', active_run_id: null });
  });

  it('parks a scope after the configured number of reported failures', async () => {
    const db = testDb(1);
    const env = envFor(db);
    await worker.fetch(post('/internal/multibanco/queue', { countryCode: 'PT' }), env, CTX);
    const runId = (mockStart.mock.calls.at(-1)?.[0] as { envVars: { MULTIBANCO_RUN_ID: string } }).envVars.MULTIBANCO_RUN_ID;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claim = await (await worker.fetch(post('/internal/multibanco/claim', {
        countryCode: 'PT', runId, workerId: 'w1', batchSize: 1,
      }), env, CTX)).json<{ scopes: Array<{ placeId: string }> }>();
      expect(claim.scopes).toHaveLength(1);
      expect((await worker.fetch(post('/internal/multibanco/scope-result', {
        countryCode: 'PT', placeId: claim.scopes[0].placeId, workerId: 'w1', status: 'failed', error: 'temporary error',
      }), env, CTX)).status).toBe(200);
    }

    expect(db.prepare('SELECT status, attempts FROM multibanco_import_scope').get())
      .toEqual({ status: 'failed', attempts: 3 });
  });
});
