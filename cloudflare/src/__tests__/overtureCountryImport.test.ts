import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { d1Binding, schemaDb } from './d1TestDb';

const { mockStart } = vi.hoisted(() => ({ mockStart: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@cloudflare/containers', () => ({ getContainer: () => ({ start: mockStart }), Container: class {} }));

import worker, { type Env } from '../index';

function envFor(db: DatabaseSync): Env {
  return { BUILD_TRIGGER_SECRET: 'secret', REGISTRY_DB: d1Binding(db), EXTRACTION_CONTAINER: {} } as unknown as Env;
}

const CTX = { waitUntil(_promise: Promise<unknown>) {}, passThroughOnException() {} } as unknown as ExecutionContext;
const post = (path: string, body: unknown) => new Request(`https://poi-api.test${path}`, {
  method: 'POST', headers: { 'X-Build-Secret': 'secret', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => mockStart.mockClear());

describe('KAN-443 Overture country import', () => {
  it('archives/checkpoints an active PT run and records only balanced source accounting', async () => {
    const db = schemaDb();
    const env = envFor(db);
    const queued = await worker.fetch(post('/internal/overture-country/queue', { countryCode: 'PT' }), env, CTX);
    expect(queued.status).toBe(200);
    const envVars = (mockStart.mock.calls.at(-1)?.[0] as { envVars: Record<string, string> }).envVars;
    expect(envVars).toMatchObject({ MODE: 'overture-country', TARGET: 'PT', D1_INTERNAL: '1' });
    const runId = envVars.OVERTURE_COUNTRY_RUN_ID;
    const rawKey = `overture-country-sources/PT/${runId}.csv`;
    expect((await worker.fetch(post('/internal/overture-country/source', {
      countryCode: 'PT', runId, rawExtractR2Key: rawKey, sourceRows: 3,
    }), env, CTX)).status).toBe(200);
    expect((await worker.fetch(post('/internal/overture-country/complete', {
      countryCode: 'PT', runId, backlogReportR2Key: `overture-country-reports/PT/${runId}.tsv`,
      sourceRows: 3, stagedRows: 2, droppedRows: 1, promotedRows: 1, rejectedRows: 0, pendingRows: 1,
    }), env, CTX)).status).toBe(200);
    expect(db.prepare('SELECT status, source_rows, staged_rows, dropped_rows FROM overture_country_import').get())
      .toEqual({ status: 'mapped', source_rows: 3, staged_rows: 2, dropped_rows: 1 });
  });

  it('rejects bad accounting and retries a failed run from its existing R2 source', async () => {
    const db = schemaDb();
    const env = envFor(db);
    await worker.fetch(post('/internal/overture-country/queue', { countryCode: 'PT' }), env, CTX);
    const first = (mockStart.mock.calls.at(-1)?.[0] as { envVars: Record<string, string> }).envVars;
    const rawKey = `overture-country-sources/PT/${first.OVERTURE_COUNTRY_RUN_ID}.csv`;
    await worker.fetch(post('/internal/overture-country/source', {
      countryCode: 'PT', runId: first.OVERTURE_COUNTRY_RUN_ID, rawExtractR2Key: rawKey, sourceRows: 2,
    }), env, CTX);
    const invalid = await worker.fetch(post('/internal/overture-country/complete', {
      countryCode: 'PT', runId: first.OVERTURE_COUNTRY_RUN_ID,
      backlogReportR2Key: 'overture-country-reports/PT/first.tsv', sourceRows: 2, stagedRows: 1, droppedRows: 1,
      promotedRows: 0, rejectedRows: 0, pendingRows: 0,
    }), env, CTX);
    expect(invalid.status).toBe(409);
    await worker.fetch(post('/internal/overture-country/failed', {
      countryCode: 'PT', runId: first.OVERTURE_COUNTRY_RUN_ID, error: 'temporary D1 failure',
    }), env, CTX);
    const retry = await worker.fetch(post('/internal/overture-country/queue', { countryCode: 'PT' }), env, CTX);
    expect(retry.status).toBe(200);
    const second = (mockStart.mock.calls.at(-1)?.[0] as { envVars: Record<string, string> }).envVars;
    expect(second.COUNTRY_SOURCE_R2_KEY).toBe(rawKey);
    expect(second.OVERTURE_COUNTRY_RUN_ID).not.toBe(first.OVERTURE_COUNTRY_RUN_ID);
  });

  it('starts only a named reviewed batch from the immutable mapped source', async () => {
    const db = schemaDb();
    const env = envFor(db);
    const rawKey = 'overture-country-sources/PT/reviewed.csv';
    db.prepare(`INSERT INTO overture_country_import
      (country_code, status, active_run_id, raw_extract_r2_key, started_at, completed_at)
      VALUES ('PT', 'mapped', 'completed', ?, 1, 2)`).run(rawKey);

    const response = await worker.fetch(post('/internal/overture-country/overrides', {
      countryCode: 'PT', batch: 'books',
    }), env, CTX);
    expect(response.status).toBe(200);
    const envVars = (mockStart.mock.calls.at(-1)?.[0] as { envVars: Record<string, string> }).envVars;
    expect(envVars).toMatchObject({
      MODE: 'overture-overrides', TARGET: 'PT', D1_INTERNAL: '1',
      COUNTRY_SOURCE_R2_KEY: rawKey, OVERTURE_OVERRIDE_BATCH: 'books',
    });
  });
});
