import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { d1Binding, schemaDb } from './d1TestDb';

const { mockStart } = vi.hoisted(() => ({ mockStart: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: mockStart }),
  Container: class {},
}));

import worker, { type Env } from '../index';

/**
 * The route layer for KAN-383's OSM supplement, as reshaped by KAN-387's
 * per-scope checkpointing. Backed by real SQLite over the project's own
 * schema files — the routes are thin wrappers over conditional UPDATEs, so a
 * fake that pattern-matches SQL strings would assert nothing about whether
 * the guards actually hold.
 */
function testDb(countryStatus = 'mapped', registryStatus = 'mapped', municipalities = 3) {
  const db = schemaDb();
  db.exec(`CREATE TABLE IF NOT EXISTS settlement_registry_import (
    country_code TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT, completed_at TEXT, last_error TEXT)`);
  db.prepare('INSERT INTO country (country_code, name, status) VALUES (?, ?, ?)').run('PT', 'Portugal', countryStatus);
  db.prepare('INSERT INTO settlement_registry_import (country_code, status) VALUES (?, ?)').run('PT', registryStatus);
  for (let i = 0; i < municipalities; i += 1) {
    db.prepare(
      `INSERT INTO place (place_id, country_code, name, place_kind, status, request_count, min_lat, max_lat, min_lng, max_lng)
       VALUES (?, 'PT', ?, 'municipality', 'mapped', 0, 38.0, 38.5, -9.5, -9.0)`,
    ).run(`osm-relation-${100 + i}`, `Town ${i}`);
  }
  return db;
}

function envFor(db: DatabaseSync): Env {
  return {
    BUILD_TRIGGER_SECRET: 'secret',
    REGISTRY_DB: d1Binding(db),
    EXTRACTION_CONTAINER: {},
  } as unknown as Env;
}

const CTX = { waitUntil(_promise: Promise<unknown>) {}, passThroughOnException() {} } as unknown as ExecutionContext;

function post(path: string, body: unknown) {
  return new Request(`https://poi-api.test${path}`, {
    method: 'POST', headers: { 'X-Build-Secret': 'secret', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

function get(path: string) {
  return new Request(`https://poi-api.test${path}`, { headers: { 'X-Build-Secret': 'secret' } });
}

function runIdFromTrigger(): string {
  const call = mockStart.mock.calls.at(-1)?.[0] as { envVars: { OSM_SUPPLEMENT_RUN_ID: string } };
  return call.envVars.OSM_SUPPLEMENT_RUN_ID;
}

beforeEach(() => {
  mockStart.mockClear();
});

describe('KAN-383 OSM supplement queue', () => {
  it('starts only one country job while the run is mapping', async () => {
    const env = envFor(testDb());
    const first = await worker.fetch(post('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(expect.objectContaining({ status: 'mapping', started: true, seeded: 3 }));
    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({
      envVars: expect.objectContaining({ MODE: 'osm-country', TARGET: 'PT', D1_INTERNAL: '1' }),
    }));

    const second = await worker.fetch(post('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    expect(await second.json()).toEqual(expect.objectContaining({ status: 'mapping', started: false }));
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('requires mapped country and settlement registry state before queueing', async () => {
    const blockedCountry = await worker.fetch(
      post('/internal/osm-supplement/queue', { countryCode: 'PT' }), envFor(testDb('mapping')), CTX);
    expect(blockedCountry.status).toBe(409);

    const blockedRegistry = await worker.fetch(
      post('/internal/osm-supplement/queue', { countryCode: 'PT' }), envFor(testDb('mapped', 'mapping')), CTX);
    expect(blockedRegistry.status).toBe(409);
  });

  it('refuses a country with no bounded municipality scopes instead of mapping nothing', async () => {
    const env = envFor(testDb('mapped', 'mapped', 0));
    const response = await worker.fetch(post('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    expect(response.status).toBe(409);
    expect(mockStart).not.toHaveBeenCalled();
  });
});

describe('KAN-387 OSM supplement batch routes', () => {
  it('claims, checkpoints and finalizes a whole country across batches', async () => {
    const db = testDb();
    const env = envFor(db);
    await worker.fetch(post('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    const runId = runIdFromTrigger();

    const claimed = await (await worker.fetch(post('/internal/osm-supplement/claim', {
      countryCode: 'PT', runId, workerId: 'w1', batchSize: 2,
    }), env, CTX)).json<{ locked: boolean; scopes: { placeId: string }[] }>();
    expect(claimed.locked).toBe(true);
    expect(claimed.scopes).toHaveLength(2);

    for (const scope of claimed.scopes) {
      const started = await worker.fetch(post('/internal/osm-supplement/scope-start', {
        countryCode: 'PT', placeId: scope.placeId, workerId: 'w1',
      }), env, CTX);
      expect(started.status).toBe(200);
      const done = await worker.fetch(post('/internal/osm-supplement/scope-result', {
        countryCode: 'PT', placeId: scope.placeId, workerId: 'w1', status: 'completed',
        inserted: 3, matchedSkipped: 1, ambiguousSkipped: 0, overpassElements: 20,
        renameReportR2Key: `osm-rename-reports/PT/${runId}/${scope.placeId}.json`,
      }), env, CTX);
      expect(done.status).toBe(200);
    }

    // Two of three scopes done: the run must NOT finalize yet.
    const partial = await (await worker.fetch(post('/internal/osm-supplement/batch-release', {
      countryCode: 'PT', runId, workerId: 'w1', outcome: 'done',
    }), env, CTX)).json<{ finalized: boolean }>();
    expect(partial.finalized).toBe(false);

    const rest = await (await worker.fetch(post('/internal/osm-supplement/claim', {
      countryCode: 'PT', runId, workerId: 'w2', batchSize: 8,
    }), env, CTX)).json<{ scopes: { placeId: string }[] }>();
    expect(rest.scopes).toHaveLength(1);
    await worker.fetch(post('/internal/osm-supplement/scope-result', {
      countryCode: 'PT', placeId: rest.scopes[0].placeId, workerId: 'w2', status: 'completed',
      inserted: 4, matchedSkipped: 0, ambiguousSkipped: 2, overpassElements: 11,
    }), env, CTX);
    const final = await (await worker.fetch(post('/internal/osm-supplement/batch-release', {
      countryCode: 'PT', runId, workerId: 'w2', outcome: 'done',
    }), env, CTX)).json<{ finalized: boolean }>();
    expect(final.finalized).toBe(true);

    const run = db.prepare('SELECT * FROM osm_supplement_import').get() as Record<string, unknown>;
    expect(run.status).toBe('mapped');
    expect(run.inserted_rows).toBe(10);
    expect(run.failed_scopes).toBe(0);
  });

  it('rejects a claim for a stale run id', async () => {
    const env = envFor(testDb());
    await worker.fetch(post('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    const response = await worker.fetch(post('/internal/osm-supplement/claim', {
      countryCode: 'PT', runId: 'stale', workerId: 'w1', batchSize: 2,
    }), env, CTX);
    expect(await response.json()).toEqual(expect.objectContaining({ locked: false, scopes: [] }));
  });

  it('rejects a scope result from a worker that does not hold the lease', async () => {
    const env = envFor(testDb());
    await worker.fetch(post('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    const runId = runIdFromTrigger();
    await worker.fetch(post('/internal/osm-supplement/claim', {
      countryCode: 'PT', runId, workerId: 'w1', batchSize: 1,
    }), env, CTX);

    const stale = await worker.fetch(post('/internal/osm-supplement/scope-result', {
      countryCode: 'PT', placeId: 'osm-relation-100', workerId: 'someone-else', status: 'completed',
      inserted: 1, matchedSkipped: 0, ambiguousSkipped: 0, overpassElements: 1,
    }), env, CTX);
    expect(stale.status).toBe(409);
  });

  it('reports progress and failures through the status route', async () => {
    const env = envFor(testDb());
    await worker.fetch(post('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    const runId = runIdFromTrigger();
    await worker.fetch(post('/internal/osm-supplement/claim', {
      countryCode: 'PT', runId, workerId: 'w1', batchSize: 1,
    }), env, CTX);
    await worker.fetch(post('/internal/osm-supplement/scope-result', {
      countryCode: 'PT', placeId: 'osm-relation-100', workerId: 'w1', status: 'completed',
      inserted: 2, matchedSkipped: 0, ambiguousSkipped: 0, overpassElements: 5,
    }), env, CTX);

    const status = await (await worker.fetch(get('/internal/osm-supplement/status?countryCode=PT'), env, CTX))
      .json<{ progress: string; counts: { claimable: number } }>();
    expect(status.progress).toBe('1/3');
    expect(status.counts.claimable).toBe(2);

    const missing = await worker.fetch(get('/internal/osm-supplement/status?countryCode=ES'), env, CTX);
    expect(missing.status).toBe(404);
  });

  it('cancels a mapping run', async () => {
    const env = envFor(testDb());
    await worker.fetch(post('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    expect((await worker.fetch(post('/internal/osm-supplement/cancel', { countryCode: 'PT' }), env, CTX)).status).toBe(200);
    expect((await worker.fetch(post('/internal/osm-supplement/cancel', { countryCode: 'PT' }), env, CTX)).status).toBe(409);
  });
});

describe('KAN-387 retrying failures', () => {
  it('un-parks failed scopes even while a run is already mapping', async () => {
    const db = testDb();
    const env = envFor(db);
    await worker.fetch(post('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    db.prepare("UPDATE osm_supplement_scope SET status = 'failed', consecutive_attempts = 3").run();

    // The most likely moment to notice failures is mid-run, so the retry
    // must not be silently ignored just because no new run was started.
    const response = await worker.fetch(
      post('/internal/osm-supplement/queue', { countryCode: 'PT', retryFailed: true }), env, CTX);
    expect(await response.json()).toEqual(expect.objectContaining({ started: false, retried: 3 }));
    const pending = db.prepare("SELECT COUNT(*) AS n FROM osm_supplement_scope WHERE status = 'pending'")
      .get() as { n: number };
    expect(pending.n).toBe(3);
  });
});

describe('KAN-387 cron driver', () => {
  it('finalizes a run whose last scopes are stuck running with no budget left', async () => {
    const db = testDb();
    const env = envFor(db);
    await worker.fetch(post('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    mockStart.mockClear();
    // Claimable by nobody (no attempts left) and finished by nobody: without
    // the cron parking these, the run sits at running > 0 forever.
    db.prepare(
      `UPDATE osm_supplement_scope
       SET status = 'running', lease_expires_at = ?, consecutive_attempts = 3, work_started_at = ?`,
    ).run(new Date(Date.now() - 60 * 60_000).toISOString(), new Date(Date.now() - 90 * 60_000).toISOString());
    db.prepare('UPDATE osm_supplement_import SET batch_lease_expires_at = NULL').run();

    await worker.scheduled({} as ScheduledController, env, CTX);

    expect(mockStart).not.toHaveBeenCalled();
    const run = db.prepare('SELECT status, failed_scopes FROM osm_supplement_import').get() as Record<string, unknown>;
    expect(run.status).toBe('mapped');
    expect(run.failed_scopes).toBe(3);
  });


  it('starts the next batch only while claimable scopes remain', async () => {
    const db = testDb();
    const env = envFor(db);
    await worker.fetch(post('/internal/osm-supplement/queue', { countryCode: 'PT' }), env, CTX);
    const runId = runIdFromTrigger();
    mockStart.mockClear();

    await worker.scheduled({} as ScheduledController, env, CTX);
    expect(mockStart).toHaveBeenCalledTimes(1);

    // Everything done: the tick finalizes instead of starting a container.
    db.prepare("UPDATE osm_supplement_scope SET status = 'completed', last_completed_at = ?")
      .run(new Date().toISOString());
    db.prepare('UPDATE osm_supplement_import SET batch_lease_expires_at = NULL').run();
    mockStart.mockClear();

    await worker.scheduled({} as ScheduledController, env, CTX);
    expect(mockStart).not.toHaveBeenCalled();
    const run = db.prepare('SELECT status, active_run_id FROM osm_supplement_import').get() as Record<string, unknown>;
    expect(run.status).toBe('mapped');
    expect(run.active_run_id).toBe(runId);
  });
});
