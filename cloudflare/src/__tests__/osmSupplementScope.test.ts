import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { d1Binding, schemaDb } from './d1TestDb';

import {
  OSM_BACKOFF_BASE_S, OSM_BACKOFF_MAX_S, OSM_SCOPE_MAX_ATTEMPTS,
  OSM_SCOPE_MAX_LEASE_EXPIRIES, OSM_SCOPE_REFRESH_DAYS,
  claimBatch, completeScope, countriesAwaitingBatch, failScope, nextBackoffSeconds,
  releaseBatch, requestCancel, retryFailedScopes, scopeCounts, seedScopes, startScope,
  supplementStatus,
} from '../osmSupplement';
import type { Env } from '../index';

const COUNTRY = 'PT';
const RUN = 'run-1';
const NOW = Date.parse('2026-08-17T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let db: DatabaseSync;
let env: Env;

function seedCountry(municipalities: number) {
  db.prepare("INSERT INTO country (country_code, name, status) VALUES (?, 'Portugal', 'mapped')").run(COUNTRY);
  for (let i = 0; i < municipalities; i += 1) {
    db.prepare(
      `INSERT INTO place (place_id, country_code, name, place_kind, status, request_count, min_lat, max_lat, min_lng, max_lng)
       VALUES (?, ?, ?, 'municipality', 'mapped', 0, 38.0, 38.5, -9.5, -9.0)`,
    ).run(`osm-relation-${100 + i}`, COUNTRY, `Town ${i}`);
  }
  db.prepare(
    `INSERT INTO osm_supplement_import (country_code, status, active_run_id, started_at)
     VALUES (?, 'mapping', ?, ?)`,
  ).run(COUNTRY, RUN, new Date(NOW).toISOString());
}

function scopeRow(placeId: string) {
  return db.prepare('SELECT * FROM osm_supplement_scope WHERE place_id = ?').get(placeId) as Record<string, unknown>;
}

function claim(workerId: string, now = NOW, batchSize = 8) {
  return claimBatch(env, { countryCode: COUNTRY, runId: RUN, workerId, batchSize, now });
}

beforeEach(() => {
  db = schemaDb();
  env = { REGISTRY_DB: d1Binding(db) } as unknown as Env;
});

describe('KAN-387 scope seeding', () => {
  it('seeds only bounded municipalities and never resets an existing scope', async () => {
    seedCountry(3);
    // A settlement with no bbox cannot be queried against Overpass, so it is
    // not work — it must not appear as a permanently pending scope.
    db.prepare(
      `INSERT INTO place (place_id, country_code, name, place_kind, status, request_count)
       VALUES ('osm-relation-999', ?, 'Unbounded', 'municipality', 'mapped', 0)`,
    ).run(COUNTRY);

    expect(await seedScopes(env, COUNTRY)).toBe(3);

    await claim('worker-a', NOW, 1);
    await completeScope(env, {
      countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: 'worker-a', now: NOW,
      inserted: 5, matchedSkipped: 1, ambiguousSkipped: 0, overpassElements: 9, renameReportR2Key: null,
    });

    // Re-queuing must not redo the country: the completed scope keeps its
    // timestamp, which is the whole point of keying on (country, place).
    expect(await seedScopes(env, COUNTRY)).toBe(0);
    expect(scopeRow('osm-relation-100').status).toBe('completed');
  });
});

describe('KAN-387 claim', () => {
  it('gives a scope to exactly one worker and returns its bbox', async () => {
    seedCountry(4);
    await seedScopes(env, COUNTRY);

    const first = await claim('worker-a', NOW, 2);
    expect(first.locked).toBe(true);
    expect(first.scopes.map(s => s.placeId)).toEqual(['osm-relation-100', 'osm-relation-101']);
    expect(first.scopes[0]).toMatchObject({ minLat: 38, maxLat: 38.5, minLng: -9.5, maxLng: -9 });

    // The country batch lock is what stops the cron and an expired-lease
    // reclaim from putting two containers on Overpass at once.
    const second = await claim('worker-b', NOW + 1000, 2);
    expect(second.locked).toBe(false);
    expect(second.scopes).toEqual([]);
  });

  it('does not claim while the country is backing off from a 429', async () => {
    seedCountry(2);
    await seedScopes(env, COUNTRY);
    db.prepare('UPDATE osm_supplement_import SET backoff_until = ?').run(new Date(NOW + 10 * 60_000).toISOString());

    expect((await claim('worker-a')).locked).toBe(false);
    expect((await claim('worker-a', NOW + 11 * 60_000)).locked).toBe(true);
  });

  it('re-claims an expired lease and charges an attempt only if work started', async () => {
    seedCountry(2);
    await seedScopes(env, COUNTRY);
    await claim('worker-a', NOW, 2);
    // One scope actually reached Overpass; the other's container died before
    // doing anything. Only the first spent a useful attempt.
    await startScope(env, { countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: 'worker-a', now: NOW });

    const later = NOW + 60 * 60_000;
    const reclaim = await claim('worker-b', later, 2);
    expect(reclaim.scopes.map(s => s.placeId)).toEqual(['osm-relation-100', 'osm-relation-101']);

    expect(scopeRow('osm-relation-100').consecutive_attempts).toBe(1);
    expect(scopeRow('osm-relation-100').total_attempts).toBe(1);
    expect(scopeRow('osm-relation-101').consecutive_attempts).toBe(0);
    // Both count as a reclaim, which is the guard that keeps a container
    // that never starts from being retried forever.
    expect(scopeRow('osm-relation-100').lease_expiries).toBe(1);
    expect(scopeRow('osm-relation-101').lease_expiries).toBe(1);
    // work_started_at is cleared on re-claim, or the next expiry would
    // charge an attempt for work the new container may never have begun.
    expect(scopeRow('osm-relation-100').work_started_at).toBe(null);
  });

  it('parks a scope whose container never starts, instead of looping forever', async () => {
    seedCountry(1);
    await seedScopes(env, COUNTRY);
    let now = NOW;
    for (let i = 0; i < OSM_SCOPE_MAX_LEASE_EXPIRIES + 1; i += 1) {
      await claim(`worker-${i}`, now, 1);
      await releaseBatch(env, { countryCode: COUNTRY, runId: RUN, workerId: `worker-${i}`, outcome: 'done', now });
      now += 60 * 60_000;
    }
    const row = scopeRow('osm-relation-100');
    expect(row.status).toBe('failed');
    expect(row.last_error_class).toBe('container_never_started');
    // Never charged a useful attempt — the failure is ours, not the town's.
    expect(row.consecutive_attempts).toBe(0);
  });
});

describe('KAN-387 scope results', () => {
  it('replaces counts on completion rather than accumulating them', async () => {
    seedCountry(1);
    await seedScopes(env, COUNTRY);
    await claim('worker-a', NOW, 1);
    await completeScope(env, {
      countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: 'worker-a', now: NOW,
      inserted: 10, matchedSkipped: 2, ambiguousSkipped: 1, overpassElements: 40, renameReportR2Key: 'k1',
    });

    // A refresh re-runs the same municipality. Its rows are upserted on the
    // OSM element id, so its counts must replace, not add.
    const later = NOW + (OSM_SCOPE_REFRESH_DAYS + 1) * DAY;
    await claim('worker-b', later, 1);
    await completeScope(env, {
      countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: 'worker-b', now: later,
      inserted: 12, matchedSkipped: 3, ambiguousSkipped: 0, overpassElements: 44, renameReportR2Key: 'k2',
    });

    const counts = await scopeCounts(env, COUNTRY, later);
    expect(counts.inserted).toBe(12);
    expect(counts.matchedSkipped).toBe(3);
    expect(scopeRow('osm-relation-100').rename_report_r2_key).toBe('k2');
  });

  it('resets the retry budget on completion so a later refresh starts clean', async () => {
    seedCountry(1);
    await seedScopes(env, COUNTRY);
    await claim('worker-a', NOW, 1);
    await failScope(env, {
      countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: 'worker-a',
      error: 'boom', errorClass: 'overpass_failed',
    });
    expect(scopeRow('osm-relation-100').status).toBe('pending');
    expect(scopeRow('osm-relation-100').consecutive_attempts).toBe(1);

    await releaseBatch(env, { countryCode: COUNTRY, runId: RUN, workerId: 'worker-a', outcome: 'done', now: NOW });
    await claim('worker-b', NOW + 1000, 1);
    await completeScope(env, {
      countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: 'worker-b', now: NOW + 1000,
      inserted: 1, matchedSkipped: 0, ambiguousSkipped: 0, overpassElements: 1, renameReportR2Key: null,
    });
    const row = scopeRow('osm-relation-100');
    expect(row.consecutive_attempts).toBe(0);
    // total_attempts never resets — it is the only way to notice a
    // municipality that quietly fails every single month.
    expect(row.total_attempts).toBe(1);
  });

  it('parks a scope after its attempts are spent, and un-parks only on explicit retry', async () => {
    seedCountry(1);
    await seedScopes(env, COUNTRY);
    for (let i = 0; i < OSM_SCOPE_MAX_ATTEMPTS; i += 1) {
      await claim(`worker-${i}`, NOW + i * 1000, 1);
      await failScope(env, {
        countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: `worker-${i}`,
        error: 'overpass down', errorClass: 'overpass_failed',
      });
      await releaseBatch(env, { countryCode: COUNTRY, runId: RUN, workerId: `worker-${i}`, outcome: 'done', now: NOW + i * 1000 });
    }
    expect(scopeRow('osm-relation-100').status).toBe('failed');
    expect((await scopeCounts(env, COUNTRY, NOW)).claimable).toBe(0);

    expect(await retryFailedScopes(env, COUNTRY)).toBe(1);
    expect(scopeRow('osm-relation-100').consecutive_attempts).toBe(0);
    expect((await scopeCounts(env, COUNTRY, NOW)).claimable).toBe(1);
  });

  it('rejects a result from a worker that no longer holds the lease', async () => {
    seedCountry(1);
    await seedScopes(env, COUNTRY);
    await claim('worker-a', NOW, 1);
    const stale = await completeScope(env, {
      countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: 'worker-b', now: NOW,
      inserted: 99, matchedSkipped: 0, ambiguousSkipped: 0, overpassElements: 0, renameReportR2Key: null,
    });
    expect(stale).toBe(false);
    expect(scopeRow('osm-relation-100').inserted).toBe(0);
  });
});

describe('KAN-387 rate limiting', () => {
  it('returns every held scope free of charge and backs the country off', async () => {
    seedCountry(3);
    await seedScopes(env, COUNTRY);
    await claim('worker-a', NOW, 3);
    await startScope(env, { countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: 'worker-a', now: NOW });

    const released = await releaseBatch(env, {
      countryCode: COUNTRY, runId: RUN, workerId: 'worker-a', outcome: 'rate_limited', now: NOW,
    });
    expect(released.finalized).toBe(false);
    expect(released.backoffUntil).not.toBe(null);

    for (const id of ['osm-relation-100', 'osm-relation-101', 'osm-relation-102']) {
      const row = scopeRow(id);
      expect(row.status).toBe('pending');
      // A 429 is about us, not the municipality — charging it would
      // eventually park perfectly good scopes as permanently failed.
      expect(row.consecutive_attempts).toBe(0);
      expect(row.lease_expiries).toBe(0);
    }
  });

  it('does not drop a lock it no longer holds', async () => {
    seedCountry(2);
    await seedScopes(env, COUNTRY);
    await claim('worker-a', NOW, 1);

    // worker-a's own lease lapsed and worker-b took the country. A late 429
    // report from worker-a must set the backoff without freeing worker-b's
    // lock — doing so would put a second container on an Overpass that just
    // rate-limited us.
    const later = NOW + 60 * 60_000;
    await claim('worker-b', later, 1);
    await releaseBatch(env, { countryCode: COUNTRY, runId: RUN, workerId: 'worker-a', outcome: 'rate_limited', now: later });

    const run = db.prepare('SELECT * FROM osm_supplement_import').get() as Record<string, unknown>;
    expect(run.batch_worker_id).toBe('worker-b');
    expect(run.backoff_until).not.toBe(null);
  });

  it('escalates only while batches achieve nothing, and clears after a clean one', async () => {
    seedCountry(2);
    await seedScopes(env, COUNTRY);
    const seconds = () => (db.prepare('SELECT backoff_seconds AS s FROM osm_supplement_import').get() as { s: number }).s;

    await claim('worker-a', NOW, 1);
    await releaseBatch(env, {
      countryCode: COUNTRY, runId: RUN, workerId: 'worker-a', outcome: 'rate_limited', completedScopes: 0, now: NOW,
    });
    const first = seconds();
    expect(first).toBeGreaterThan(0);

    // Still blocked: nothing finished, so back further off.
    const later = NOW + 2 * 60 * 60_000;
    await claim('worker-b', later, 1);
    await releaseBatch(env, {
      countryCode: COUNTRY, runId: RUN, workerId: 'worker-b', outcome: 'rate_limited', completedScopes: 0, now: later,
    });
    expect(seconds()).toBe(first * 2);

    const evenLater = later + 4 * 60 * 60_000;
    await claim('worker-c', evenLater, 1);
    await releaseBatch(env, { countryCode: COUNTRY, runId: RUN, workerId: 'worker-c', outcome: 'done', now: evenLater });
    expect(seconds()).toBe(0);
  });

  it('recovers the delay when a throttled batch still finished municipalities', async () => {
    seedCountry(2);
    await seedScopes(env, COUNTRY);
    const seconds = () => (db.prepare('SELECT backoff_seconds AS s FROM osm_supplement_import').get() as { s: number }).s;

    // Drive the ladder to the ceiling the way the first PT run did.
    db.prepare('UPDATE osm_supplement_import SET backoff_seconds = ?').run(OSM_BACKOFF_MAX_S);

    await claim('worker-a', NOW, 1);
    await releaseBatch(env, {
      countryCode: COUNTRY, runId: RUN, workerId: 'worker-a', outcome: 'rate_limited', completedScopes: 7, now: NOW,
    });
    // Throttled but still working is not the same as blocked: the delay must
    // come back down, or a job that is succeeding starves at the cap.
    expect(seconds()).toBe(OSM_BACKOFF_MAX_S / 2);
  });

  it('never recovers below the base delay, however much progress is made', () => {
    // Pure function: the decay must not walk the delay down to nothing and
    // turn a 429 into no backoff at all.
    let delay = OSM_BACKOFF_MAX_S;
    for (let i = 0; i < 20; i += 1) delay = nextBackoffSeconds(delay, 8);
    expect(delay).toBe(OSM_BACKOFF_BASE_S);

    expect(nextBackoffSeconds(0, 8)).toBe(OSM_BACKOFF_BASE_S);
    expect(nextBackoffSeconds(OSM_BACKOFF_MAX_S, 0)).toBe(OSM_BACKOFF_MAX_S);
  });
});

describe('KAN-387 run lifecycle', () => {
  it('finalizes as mapped with a failure count rather than blocking the country', async () => {
    seedCountry(2);
    await seedScopes(env, COUNTRY);
    await claim('worker-a', NOW, 2);
    await completeScope(env, {
      countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: 'worker-a', now: NOW,
      inserted: 7, matchedSkipped: 1, ambiguousSkipped: 2, overpassElements: 30, renameReportR2Key: null,
    });
    db.prepare(
      `UPDATE osm_supplement_scope SET status = 'failed', consecutive_attempts = ?
       WHERE place_id = 'osm-relation-101'`,
    ).run(OSM_SCOPE_MAX_ATTEMPTS);

    const released = await releaseBatch(env, {
      countryCode: COUNTRY, runId: RUN, workerId: 'worker-a', outcome: 'done', now: NOW,
    });
    expect(released.finalized).toBe(true);
    const run = db.prepare('SELECT * FROM osm_supplement_import').get() as Record<string, unknown>;
    expect(run.status).toBe('mapped');
    expect(run.failed_scopes).toBe(1);
    expect(run.inserted_rows).toBe(7);
    expect(run.ambiguous_skipped).toBe(2);
  });

  it('does not finalize while scopes are still claimable', async () => {
    seedCountry(3);
    await seedScopes(env, COUNTRY);
    await claim('worker-a', NOW, 1);
    await completeScope(env, {
      countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: 'worker-a', now: NOW,
      inserted: 1, matchedSkipped: 0, ambiguousSkipped: 0, overpassElements: 1, renameReportR2Key: null,
    });
    const released = await releaseBatch(env, {
      countryCode: COUNTRY, runId: RUN, workerId: 'worker-a', outcome: 'done', now: NOW,
    });
    expect(released.finalized).toBe(false);
    expect(released.counts.claimable).toBe(2);
  });

  it('makes a completed scope claimable again only once it is stale', async () => {
    seedCountry(1);
    await seedScopes(env, COUNTRY);
    await claim('worker-a', NOW, 1);
    await completeScope(env, {
      countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: 'worker-a', now: NOW,
      inserted: 1, matchedSkipped: 0, ambiguousSkipped: 0, overpassElements: 1, renameReportR2Key: null,
    });

    expect((await scopeCounts(env, COUNTRY, NOW + 5 * DAY)).claimable).toBe(0);
    expect((await scopeCounts(env, COUNTRY, NOW + (OSM_SCOPE_REFRESH_DAYS + 1) * DAY)).claimable).toBe(1);
  });

  it('offers the country to the cron only when no batch is live', async () => {
    seedCountry(2);
    await seedScopes(env, COUNTRY);
    expect((await countriesAwaitingBatch(env, NOW)).map(c => c.country_code)).toEqual([COUNTRY]);

    await claim('worker-a', NOW, 1);
    expect(await countriesAwaitingBatch(env, NOW + 60_000)).toEqual([]);
    // Once the batch lock's own lease lapses the cron takes over again —
    // that is what makes a dead container cost at most one batch.
    expect((await countriesAwaitingBatch(env, NOW + 60 * 60_000)).map(c => c.country_code)).toEqual([COUNTRY]);
  });

  it('cancels cooperatively and frees the running scopes', async () => {
    seedCountry(2);
    await seedScopes(env, COUNTRY);
    await claim('worker-a', NOW, 2);

    expect(await requestCancel(env, COUNTRY, NOW)).toBe(true);
    expect(scopeRow('osm-relation-100').status).toBe('pending');
    // A cancelled country stops handing out work even to the container that
    // is already running — it checks between scopes and exits.
    expect((await claim('worker-a', NOW + 1000, 2)).locked).toBe(false);
    expect(await requestCancel(env, COUNTRY, NOW)).toBe(false);
  });

  it('reports progress, elapsed time and the failures', async () => {
    seedCountry(3);
    await seedScopes(env, COUNTRY);
    await claim('worker-a', NOW, 2);
    await completeScope(env, {
      countryCode: COUNTRY, placeId: 'osm-relation-100', workerId: 'worker-a', now: NOW,
      inserted: 4, matchedSkipped: 0, ambiguousSkipped: 0, overpassElements: 12, renameReportR2Key: null,
    });
    db.prepare(
      `UPDATE osm_supplement_scope SET status = 'failed', last_error = 'overpass down',
       last_error_class = 'overpass_failed' WHERE place_id = 'osm-relation-102'`,
    ).run();

    const status = await supplementStatus(env, COUNTRY, NOW + 90_000);
    expect(status?.progress).toBe('1/3');
    expect(status?.elapsedSeconds).toBe(90);
    expect(status?.batchActive).toBe(true);
    expect(status?.currentScopes).toHaveLength(1);
    expect(status?.failures).toHaveLength(1);
    expect(status?.counts.inserted).toBe(4);
  });
});
