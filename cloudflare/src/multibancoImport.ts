import type { Env } from './index';

/**
 * KAN-440 — durable orchestration for the official MULTIBANCO locator.
 *
 * The locator is a viewport API, not a bulk download.  We therefore process
 * one bounded municipality viewport at a time in a Container, checkpoint it
 * in D1, then let cron begin the next small batch.  Source IDs make writes
 * idempotent, so a lease expiry after a partial write is safe to retry.
 */
export const MULTIBANCO_SCOPE_BATCH_SIZE = 8;
export const MULTIBANCO_SCOPE_LEASE_MS = 20 * 60 * 1_000;
export const MULTIBANCO_BATCH_LOCK_MS = 25 * 60 * 1_000;
export const MULTIBANCO_REFRESH_DAYS = 30;
export const MULTIBANCO_MAX_ATTEMPTS = 3;
export const MULTIBANCO_RATE_LIMIT_BACKOFF_SECONDS = 5 * 60;
export const MULTIBANCO_EXPECTED_NATIONAL_COUNT = 13_700;
export const MULTIBANCO_COUNT_TOLERANCE = 0.15;

export type MultibancoScope = {
  placeId: string;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

type ScopeCounts = {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  claimable: number;
  published: number;
  rejected: number;
  duplicates: number;
};

function iso(at: number): string { return new Date(at).toISOString(); }
function staleBefore(now: number): string { return iso(now - MULTIBANCO_REFRESH_DAYS * 24 * 60 * 60 * 1_000); }

const CLAIMABLE = `
  country_code = ? AND attempts < ${MULTIBANCO_MAX_ATTEMPTS}
  AND (status = 'pending'
       OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
       OR (status = 'completed' AND (completed_at IS NULL OR completed_at <= ?)))`;

export async function seedMultibancoScopes(env: Env, countryCode: string): Promise<number> {
  const result = await env.REGISTRY_DB.prepare(
    `INSERT INTO multibanco_import_scope (country_code, place_id, status)
     SELECT country_code, place_id, 'pending' FROM place
     WHERE country_code = ? AND place_kind = 'municipality'
       AND min_lat IS NOT NULL AND max_lat IS NOT NULL
       AND min_lng IS NOT NULL AND max_lng IS NOT NULL
     ON CONFLICT(country_code, place_id) DO NOTHING`,
  ).bind(countryCode).run();
  return result.meta.changes ?? 0;
}

export async function multibancoScopeCounts(env: Env, countryCode: string, now: number): Promise<ScopeCounts> {
  const row = await env.REGISTRY_DB.prepare(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(status = 'completed'), 0) AS completed,
       COALESCE(SUM(status = 'failed'), 0) AS failed,
       COALESCE(SUM(status = 'running'), 0) AS running,
       COALESCE(SUM(status = 'pending'), 0) AS pending,
       COALESCE(SUM(published), 0) AS published,
       COALESCE(SUM(rejected), 0) AS rejected,
       COALESCE(SUM(duplicates), 0) AS duplicates
     FROM multibanco_import_scope WHERE country_code = ?`,
  ).bind(countryCode).first<Record<string, number>>();
  const claimable = await env.REGISTRY_DB.prepare(
    `SELECT COUNT(*) AS claimable FROM multibanco_import_scope WHERE ${CLAIMABLE}`,
  ).bind(countryCode, iso(now), staleBefore(now)).first<{ claimable: number }>();
  return {
    total: row?.total ?? 0, completed: row?.completed ?? 0, failed: row?.failed ?? 0,
    running: row?.running ?? 0, pending: row?.pending ?? 0, claimable: claimable?.claimable ?? 0,
    published: row?.published ?? 0, rejected: row?.rejected ?? 0, duplicates: row?.duplicates ?? 0,
  };
}

export async function queueMultibancoImport(env: Env, countryCode: string, now: number) {
  const country = await env.REGISTRY_DB.prepare('SELECT status FROM country WHERE country_code = ?')
    .bind(countryCode).first<{ status: string }>();
  if (!country || country.status !== 'mapped') return { started: false, seeded: 0, error: 'country must be mapped first' as const };
  const seeded = await seedMultibancoScopes(env, countryCode);
  const counts = await multibancoScopeCounts(env, countryCode, now);
  if (counts.total === 0) {
    // No new run is created here. Clean up an impossible legacy mapping row
    // too, so a release callback can never later finalize it as a run.
    await env.REGISTRY_DB.prepare(
      `UPDATE multibanco_import SET status = 'failed', active_run_id = NULL,
         completed_at = ?, batch_worker_id = NULL, batch_lease_expires_at = NULL,
         backoff_until = NULL, last_error = 'no bounded municipality scopes'
       WHERE country_code = ? AND status = 'mapping'`,
    ).bind(iso(now), countryCode).run();
    return { started: false, seeded, error: 'no bounded municipality scopes; import settlement metadata first' as const };
  }
  const runId = crypto.randomUUID();
  await env.REGISTRY_DB.prepare(
    `INSERT INTO multibanco_import (country_code, status, active_run_id, started_at, completed_at, cancel_requested)
     VALUES (?, 'mapping', ?, ?, NULL, 0)
     ON CONFLICT(country_code) DO UPDATE SET
       status = CASE WHEN multibanco_import.status = 'mapping' THEN 'mapping' ELSE 'mapping' END,
       active_run_id = CASE WHEN multibanco_import.status = 'mapping' THEN multibanco_import.active_run_id ELSE excluded.active_run_id END,
       started_at = CASE WHEN multibanco_import.status = 'mapping' THEN multibanco_import.started_at ELSE excluded.started_at END,
       completed_at = CASE WHEN multibanco_import.status = 'mapping' THEN multibanco_import.completed_at ELSE NULL END,
       cancel_requested = CASE WHEN multibanco_import.status = 'mapping' THEN multibanco_import.cancel_requested ELSE 0 END,
       last_error = NULL`,
  ).bind(countryCode, runId, iso(now)).run();
  const run = await env.REGISTRY_DB.prepare(
    'SELECT status, active_run_id, cancel_requested FROM multibanco_import WHERE country_code = ?',
  ).bind(countryCode).first<{ status: string; active_run_id: string | null; cancel_requested: number }>();
  return { started: run?.active_run_id === runId && counts.claimable > 0, seeded, runId: run?.active_run_id ?? null, counts };
}

export async function claimMultibancoBatch(
  env: Env,
  options: { countryCode: string; runId: string; workerId: string; now: number; batchSize: number },
): Promise<{ locked: boolean; scopes: MultibancoScope[] }> {
  const { countryCode, runId, workerId, now } = options;
  const lockUntil = iso(now + MULTIBANCO_BATCH_LOCK_MS);
  const leaseUntil = iso(now + MULTIBANCO_SCOPE_LEASE_MS);
  const batchSize = Math.min(Math.max(options.batchSize, 1), MULTIBANCO_SCOPE_BATCH_SIZE);
  const lock = await env.REGISTRY_DB.prepare(
    `UPDATE multibanco_import SET batch_worker_id = ?, batch_lease_expires_at = ?
     WHERE country_code = ? AND active_run_id = ? AND status = 'mapping' AND cancel_requested = 0
       AND (backoff_until IS NULL OR backoff_until <= ?)
       AND (batch_lease_expires_at IS NULL OR batch_lease_expires_at <= ? OR batch_worker_id = ?)`,
  ).bind(workerId, lockUntil, countryCode, runId, iso(now), iso(now), workerId).run();
  if (lock.meta.changes !== 1) return { locked: false, scopes: [] };

  await env.REGISTRY_DB.prepare(
    `UPDATE multibanco_import_scope SET status = 'running', worker_id = ?, lease_expires_at = ?,
       attempts = attempts + CASE WHEN status = 'running' THEN 1 ELSE 0 END
     WHERE country_code = ? AND place_id IN (
       SELECT place_id FROM multibanco_import_scope WHERE ${CLAIMABLE}
       ORDER BY (status = 'completed'), place_id LIMIT ?
     )`,
  ).bind(workerId, leaseUntil, countryCode, countryCode, iso(now), staleBefore(now), batchSize).run();
  const claimed = await env.REGISTRY_DB.prepare(
    `SELECT s.place_id, p.min_lat, p.max_lat, p.min_lng, p.max_lng
     FROM multibanco_import_scope s JOIN place p ON p.place_id = s.place_id
     WHERE s.country_code = ? AND s.worker_id = ? AND s.status = 'running' AND s.lease_expires_at = ?
     ORDER BY s.place_id`,
  ).bind(countryCode, workerId, leaseUntil).all<{ place_id: string; min_lat: number; max_lat: number; min_lng: number; max_lng: number }>();
  return { locked: true, scopes: (claimed.results ?? []).map(scope => ({
    placeId: scope.place_id, minLat: scope.min_lat, maxLat: scope.max_lat, minLng: scope.min_lng, maxLng: scope.max_lng,
  })) };
}

export async function completeMultibancoScope(env: Env, options: {
  countryCode: string; placeId: string; workerId: string; now: number;
  published: number; rejected: number; duplicates: number;
}): Promise<boolean> {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE multibanco_import_scope SET status = 'completed', completed_at = ?, worker_id = NULL,
       lease_expires_at = NULL, attempts = 0, published = ?, rejected = ?, duplicates = ?, last_error = NULL
     WHERE country_code = ? AND place_id = ? AND worker_id = ? AND status = 'running'`,
  ).bind(iso(options.now), options.published, options.rejected, options.duplicates,
    options.countryCode, options.placeId, options.workerId).run();
  return result.meta.changes === 1;
}

export async function failMultibancoScope(env: Env, options: {
  countryCode: string; placeId: string; workerId: string; error: string;
}): Promise<boolean> {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE multibanco_import_scope SET attempts = attempts + 1,
       status = CASE WHEN attempts + 1 >= ${MULTIBANCO_MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
       worker_id = NULL, lease_expires_at = NULL, last_error = ?
     WHERE country_code = ? AND place_id = ? AND worker_id = ? AND status = 'running'`,
  ).bind(options.error.slice(0, 1_000), options.countryCode, options.placeId, options.workerId).run();
  return result.meta.changes === 1;
}

async function releaseHeldMultibancoScopes(env: Env, countryCode: string, workerId: string): Promise<void> {
  await env.REGISTRY_DB.prepare(
    `UPDATE multibanco_import_scope SET status = 'pending', worker_id = NULL, lease_expires_at = NULL
     WHERE country_code = ? AND worker_id = ? AND status = 'running'`,
  ).bind(countryCode, workerId).run();
}

export async function releaseMultibancoBatch(env: Env, options: {
  countryCode: string; runId: string; workerId: string; now: number; outcome: 'done' | 'rate_limited';
}) {
  if (options.outcome === 'rate_limited') {
    await releaseHeldMultibancoScopes(env, options.countryCode, options.workerId);
    await env.REGISTRY_DB.prepare(
      `UPDATE multibanco_import SET batch_worker_id = NULL, batch_lease_expires_at = NULL,
         backoff_until = ?, last_error = 'locator rate limited'
       WHERE country_code = ? AND active_run_id = ? AND batch_worker_id = ?`,
    ).bind(iso(options.now + MULTIBANCO_RATE_LIMIT_BACKOFF_SECONDS * 1_000), options.countryCode, options.runId, options.workerId).run();
  } else {
    await env.REGISTRY_DB.prepare(
      `UPDATE multibanco_import SET batch_worker_id = NULL, batch_lease_expires_at = NULL, backoff_until = NULL
       WHERE country_code = ? AND active_run_id = ? AND batch_worker_id = ?`,
    ).bind(options.countryCode, options.runId, options.workerId).run();
  }
  const counts = await multibancoScopeCounts(env, options.countryCode, options.now);
  if (options.outcome === 'rate_limited' || counts.claimable > 0 || counts.running > 0) return { finalized: false, counts };
  const done = await env.REGISTRY_DB.prepare(
    `UPDATE multibanco_import SET status = 'mapped', completed_at = ?, batch_worker_id = NULL,
       batch_lease_expires_at = NULL, last_error = CASE WHEN ? > 0 THEN ? ELSE NULL END
     WHERE country_code = ? AND active_run_id = ? AND status = 'mapping'`,
  ).bind(iso(options.now), counts.failed, counts.failed ? `${counts.failed} scope(s) failed` : null,
    options.countryCode, options.runId).run();
  return { finalized: done.meta.changes === 1, counts };
}

export async function multibancoImportsAwaitingBatch(env: Env, now: number) {
  const rows = await env.REGISTRY_DB.prepare(
    `SELECT country_code, active_run_id FROM multibanco_import
     WHERE status = 'mapping' AND cancel_requested = 0
       AND (backoff_until IS NULL OR backoff_until <= ?)
       AND (batch_lease_expires_at IS NULL OR batch_lease_expires_at <= ?)`,
  ).bind(iso(now), iso(now)).all<{ country_code: string; active_run_id: string | null }>();
  return rows.results ?? [];
}

export async function multibancoImportStatus(env: Env, countryCode: string, now: number) {
  const run = await env.REGISTRY_DB.prepare('SELECT * FROM multibanco_import WHERE country_code = ?')
    .bind(countryCode).first<Record<string, unknown>>();
  if (!run) return null;
  const actual = await env.REGISTRY_DB.prepare('SELECT COUNT(*) AS count FROM multibanco_poi').first<{ count: number }>();
  const minExpected = Math.round(MULTIBANCO_EXPECTED_NATIONAL_COUNT * (1 - MULTIBANCO_COUNT_TOLERANCE));
  const maxExpected = Math.round(MULTIBANCO_EXPECTED_NATIONAL_COUNT * (1 + MULTIBANCO_COUNT_TOLERANCE));
  return {
    countryCode, ...run, counts: await multibancoScopeCounts(env, countryCode, now),
    nationalCount: {
      actual: actual?.count ?? 0, minExpected, maxExpected,
      withinExpectedRange: (actual?.count ?? 0) >= minExpected && (actual?.count ?? 0) <= maxExpected,
    },
  };
}

export async function cancelMultibancoImport(env: Env, countryCode: string, now: number): Promise<boolean> {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE multibanco_import SET status = 'failed', cancel_requested = 1, completed_at = ?,
       batch_worker_id = NULL, batch_lease_expires_at = NULL, last_error = 'cancelled by operator'
     WHERE country_code = ? AND status = 'mapping'`,
  ).bind(iso(now), countryCode).run();
  if (result.meta.changes !== 1) return false;
  await env.REGISTRY_DB.prepare(
    `UPDATE multibanco_import_scope SET status = 'pending', worker_id = NULL, lease_expires_at = NULL
     WHERE country_code = ? AND status = 'running'`,
  ).bind(countryCode).run();
  return true;
}
