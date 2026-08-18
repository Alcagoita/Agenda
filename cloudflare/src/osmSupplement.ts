import type { Env } from './index';

/**
 * KAN-387 — durable orchestration for the country-scale OSM supplement.
 *
 * KAN-383 ran all of a country's municipality bboxes inside one container,
 * held every candidate in memory, and wrote D1 only after the last scope
 * succeeded. PT's 307 scopes could not finish inside any container lifetime,
 * and a run that died left no checkpoint, no progress and no error.
 *
 * Here the container claims a small batch, persists after each municipality,
 * and exits; the cron starts the next batch while claimable scopes remain.
 * The matching rule itself (supplement_osm_pois.py's confident_match) is
 * unchanged — this file only decides *what work is outstanding*.
 *
 * D1 has no multi-statement transaction available through the container's
 * `d1.internal` binding, so every state transition below is a single
 * conditional UPDATE whose `meta.changes` is the atomicity primitive — the
 * same pattern startPlaceMapping and queueSettlementRegistry already use.
 */

/** How long a claimed scope stays claimed. Tracks ExtractionContainer.sleepAfter. */
export const OSM_SCOPE_LEASE_MS = 20 * 60 * 1000;
/** The batch lock outlives the scope leases it covers, so a live batch is never raced. */
export const OSM_BATCH_LOCK_MS = 25 * 60 * 1000;
/** Municipalities per container invocation. Serial within the batch — Overpass politeness. */
export const OSM_SCOPE_BATCH_SIZE = 8;
/** Failures that actually ran. Beyond this the scope is parked for an operator. */
export const OSM_SCOPE_MAX_ATTEMPTS = 3;
/**
 * Reclaims regardless of whether work ever started. A never-starting
 * container charges no attempt (by design), so without this a broken image
 * would be retried forever.
 */
export const OSM_SCOPE_MAX_LEASE_EXPIRIES = 5;
/** A completed scope becomes claimable again after this, for the monthly refresh. */
export const OSM_SCOPE_REFRESH_DAYS = 30;
/** Country-wide Overpass backoff, doubling per consecutive 429 batch. */
export const OSM_BACKOFF_BASE_S = 300;
export const OSM_BACKOFF_MAX_S = 3600;

export type OsmScopeErrorClass =
  | 'overpass_failed'
  | 'rate_limited'
  | 'container_never_started'
  | 'data'
  | 'd1';

export type ClaimedScope = {
  placeId: string;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

export type ScopeCounts = {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  claimable: number;
  inserted: number;
  matchedSkipped: number;
  ambiguousSkipped: number;
  overpassElements: number;
};

function iso(at: number): string {
  return new Date(at).toISOString();
}

function staleBefore(now: number): string {
  return iso(now - OSM_SCOPE_REFRESH_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The one definition of "this scope is worth claiming", used by the claim
 * itself, by the cron's "is there anything left to do", and by the run
 * finalizer. Written once as a fragment so those three can never drift.
 *
 * Bind order: countryCode, now, staleBefore.
 *
 * 'failed' is deliberately absent — a parked scope is terminal until an
 * operator re-queues with retryFailed, which is what makes "retry only the
 * failed scopes" an explicit act rather than an accidental loop.
 */
const CLAIMABLE_PREDICATE = `
  country_code = ?
  AND consecutive_attempts < ${OSM_SCOPE_MAX_ATTEMPTS}
  AND lease_expiries < ${OSM_SCOPE_MAX_LEASE_EXPIRIES}
  AND (
    status = 'pending'
    OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
    OR (status = 'completed' AND (last_completed_at IS NULL OR last_completed_at <= ?))
  )`;

/**
 * Create a pending scope per bounded municipality. ON CONFLICT DO NOTHING so
 * a re-queue never resets progress: a municipality added to the settlement
 * registry later simply joins as pending, and already-completed ones keep
 * their `last_completed_at` and are picked up only once stale.
 */
export async function seedScopes(env: Env, countryCode: string): Promise<number> {
  const result = await env.REGISTRY_DB.prepare(
    `INSERT INTO osm_supplement_scope (country_code, place_id, status)
     SELECT country_code, place_id, 'pending' FROM place
     WHERE country_code = ? AND place_kind = 'municipality'
       AND min_lat IS NOT NULL AND max_lat IS NOT NULL
       AND min_lng IS NOT NULL AND max_lng IS NOT NULL
     ON CONFLICT (country_code, place_id) DO NOTHING`,
  ).bind(countryCode).run();
  return result.meta.changes ?? 0;
}

/** Return permanently-failed scopes to pending with a clean budget. */
export async function retryFailedScopes(env: Env, countryCode: string): Promise<number> {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE osm_supplement_scope
     SET status = 'pending', consecutive_attempts = 0, lease_expiries = 0,
         lease_expires_at = NULL, work_started_at = NULL, worker_id = NULL
     WHERE country_code = ? AND status = 'failed'`,
  ).bind(countryCode).run();
  return result.meta.changes ?? 0;
}

export async function scopeCounts(env: Env, countryCode: string, now: number): Promise<ScopeCounts> {
  const row = await env.REGISTRY_DB.prepare(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(status = 'completed'), 0) AS completed,
       COALESCE(SUM(status = 'failed'), 0) AS failed,
       COALESCE(SUM(status = 'running'), 0) AS running,
       COALESCE(SUM(status = 'pending'), 0) AS pending,
       COALESCE(SUM(inserted), 0) AS inserted,
       COALESCE(SUM(matched_skipped), 0) AS matched_skipped,
       COALESCE(SUM(ambiguous_skipped), 0) AS ambiguous_skipped,
       COALESCE(SUM(overpass_elements), 0) AS overpass_elements
     FROM osm_supplement_scope WHERE country_code = ?`,
  ).bind(countryCode).first<Record<string, number>>();
  const claimable = await env.REGISTRY_DB.prepare(
    `SELECT COUNT(*) AS claimable FROM osm_supplement_scope WHERE ${CLAIMABLE_PREDICATE}`,
  ).bind(countryCode, iso(now), staleBefore(now)).first<{ claimable: number }>();
  return {
    total: row?.total ?? 0,
    completed: row?.completed ?? 0,
    failed: row?.failed ?? 0,
    running: row?.running ?? 0,
    pending: row?.pending ?? 0,
    claimable: claimable?.claimable ?? 0,
    inserted: row?.inserted ?? 0,
    matchedSkipped: row?.matched_skipped ?? 0,
    ambiguousSkipped: row?.ambiguous_skipped ?? 0,
    overpassElements: row?.overpass_elements ?? 0,
  };
}

/**
 * Park scopes whose lease expired once too often, or that already spent
 * their attempts while running. Without this they stay 'running' forever:
 * the claim predicate excludes them, so nothing else would ever move them.
 */
export async function parkExhaustedScopes(env: Env, countryCode: string, now: number): Promise<void> {
  await env.REGISTRY_DB.prepare(
    `UPDATE osm_supplement_scope
     SET status = 'failed', lease_expires_at = NULL, worker_id = NULL, work_started_at = NULL,
         last_error = CASE WHEN work_started_at IS NULL
           THEN 'lease expired before the container started any work'
           ELSE 'attempts exhausted while running' END,
         last_error_class = CASE WHEN work_started_at IS NULL
           THEN 'container_never_started' ELSE 'overpass_failed' END
     WHERE country_code = ? AND status = 'running'
       AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
       AND (lease_expiries + 1 >= ${OSM_SCOPE_MAX_LEASE_EXPIRIES}
            OR consecutive_attempts + 1 >= ${OSM_SCOPE_MAX_ATTEMPTS})`,
  ).bind(countryCode, iso(now)).run();
}

/**
 * Take the country batch lock, then claim up to `batchSize` eligible scopes.
 *
 * Returns an empty array (and holds no lock) when another batch is live, the
 * country is backing off from a 429, a cancel is pending, or there is simply
 * nothing claimable — the container treats all of those the same way: exit.
 */
export async function claimBatch(
  env: Env,
  options: { countryCode: string; runId: string; workerId: string; batchSize: number; now: number },
): Promise<{ locked: boolean; scopes: ClaimedScope[]; leaseExpiresAt: string }> {
  const { countryCode, runId, workerId, now } = options;
  const batchSize = Math.min(Math.max(options.batchSize, 1), OSM_SCOPE_BATCH_SIZE);
  const lockExpiry = iso(now + OSM_BATCH_LOCK_MS);
  const leaseExpiresAt = iso(now + OSM_SCOPE_LEASE_MS);

  // One live batch per country. Cron firing while a batch runs, or two
  // containers racing after an expired lease, would otherwise put parallel
  // load on Overpass — which is exactly what gets a client blocked.
  const lock = await env.REGISTRY_DB.prepare(
    `UPDATE osm_supplement_import
     SET batch_worker_id = ?, batch_lease_expires_at = ?
     WHERE country_code = ? AND active_run_id = ? AND status = 'mapping' AND cancel_requested = 0
       AND (backoff_until IS NULL OR backoff_until <= ?)
       AND (batch_lease_expires_at IS NULL OR batch_lease_expires_at <= ? OR batch_worker_id = ?)`,
  ).bind(workerId, lockExpiry, countryCode, runId, iso(now), iso(now), workerId).run();
  if (lock.meta.changes !== 1) return { locked: false, scopes: [], leaseExpiresAt };

  await parkExhaustedScopes(env, countryCode, now);

  // SQLite evaluates every SET expression against the row's pre-update
  // values, so the CASEs below still see the old status/work_started_at
  // while `status` is being set to 'running' in the same statement.
  //
  // A reclaimed lease charges an attempt only when work_started_at proves
  // the scope really ran: a container that was allocated and died before
  // touching Overpass must not burn one of the three useful attempts.
  // lease_expiries counts every reclaim regardless — that is the guard that
  // makes the exemption safe.
  await env.REGISTRY_DB.prepare(
    `UPDATE osm_supplement_scope
     SET status = 'running',
         last_run_id = ?,
         worker_id = ?,
         lease_expires_at = ?,
         lease_expiries = lease_expiries + CASE WHEN status = 'running' THEN 1 ELSE 0 END,
         consecutive_attempts = consecutive_attempts
           + CASE WHEN status = 'running' AND work_started_at IS NOT NULL THEN 1 ELSE 0 END,
         total_attempts = total_attempts
           + CASE WHEN status = 'running' AND work_started_at IS NOT NULL THEN 1 ELSE 0 END,
         work_started_at = NULL
     WHERE country_code = ? AND place_id IN (
       SELECT place_id FROM osm_supplement_scope
       WHERE ${CLAIMABLE_PREDICATE}
       ORDER BY (status = 'completed'), place_id
       LIMIT ?
     )`,
  ).bind(runId, workerId, leaseExpiresAt, countryCode, countryCode, iso(now), staleBefore(now), batchSize).run();

  // worker_id + the exact lease stamp identify this batch precisely, so a
  // slow previous holder's rows can never be handed out twice.
  const claimed = await env.REGISTRY_DB.prepare(
    `SELECT s.place_id, p.min_lat, p.max_lat, p.min_lng, p.max_lng
     FROM osm_supplement_scope s JOIN place p ON p.place_id = s.place_id
     WHERE s.country_code = ? AND s.worker_id = ? AND s.status = 'running' AND s.lease_expires_at = ?
     ORDER BY s.place_id`,
  ).bind(countryCode, workerId, leaseExpiresAt).all<{
    place_id: string; min_lat: number; max_lat: number; min_lng: number; max_lng: number;
  }>();

  return {
    locked: true,
    leaseExpiresAt,
    scopes: (claimed.results ?? []).map(row => ({
      placeId: row.place_id,
      minLat: row.min_lat,
      maxLat: row.max_lat,
      minLng: row.min_lng,
      maxLng: row.max_lng,
    })),
  };
}

/**
 * Mark that this scope's Overpass work actually began. The sole purpose is
 * to distinguish "the container died doing the work" from "the container
 * never ran" when the lease later expires.
 */
export async function startScope(
  env: Env,
  options: { countryCode: string; placeId: string; workerId: string; now: number },
): Promise<boolean> {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE osm_supplement_scope SET work_started_at = ?
     WHERE country_code = ? AND place_id = ? AND worker_id = ? AND status = 'running'`,
  ).bind(iso(options.now), options.countryCode, options.placeId, options.workerId).run();
  return result.meta.changes === 1;
}

/**
 * Counts are REPLACED here, never added to a running total. The OSM element
 * id makes the POI write idempotent, but a retry of a partly-written scope
 * would double-count any accumulated counter — so the scope row holds its
 * own final numbers and the run totals are SUM()ed on read.
 */
export async function completeScope(
  env: Env,
  options: {
    countryCode: string; placeId: string; workerId: string; now: number;
    inserted: number; matchedSkipped: number; ambiguousSkipped: number; overpassElements: number;
    renameReportR2Key: string | null;
  },
): Promise<boolean> {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE osm_supplement_scope
     SET status = 'completed', last_completed_at = ?,
         consecutive_attempts = 0, lease_expiries = 0,
         lease_expires_at = NULL, work_started_at = NULL, worker_id = NULL,
         inserted = ?, matched_skipped = ?, ambiguous_skipped = ?, overpass_elements = ?,
         rename_report_r2_key = ?, last_error = NULL, last_error_class = NULL
     WHERE country_code = ? AND place_id = ? AND worker_id = ? AND status = 'running'`,
  ).bind(
    iso(options.now), options.inserted, options.matchedSkipped, options.ambiguousSkipped,
    options.overpassElements, options.renameReportR2Key,
    options.countryCode, options.placeId, options.workerId,
  ).run();
  return result.meta.changes === 1;
}

/** Charge one attempt; park the scope once the budget is spent. */
export async function failScope(
  env: Env,
  options: {
    countryCode: string; placeId: string; workerId: string;
    error: string; errorClass: OsmScopeErrorClass;
  },
): Promise<boolean> {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE osm_supplement_scope
     SET consecutive_attempts = consecutive_attempts + 1,
         total_attempts = total_attempts + 1,
         status = CASE WHEN consecutive_attempts + 1 >= ${OSM_SCOPE_MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
         lease_expires_at = NULL, work_started_at = NULL, worker_id = NULL,
         last_error = ?, last_error_class = ?
     WHERE country_code = ? AND place_id = ? AND worker_id = ? AND status = 'running'`,
  ).bind(options.error.slice(0, 1_000), options.errorClass, options.countryCode, options.placeId, options.workerId).run();
  return result.meta.changes === 1;
}

/**
 * Hand back every scope this worker still holds without charging anything.
 * Used for a 429: rate limiting says nothing about the municipality, so
 * spending its retry budget on Overpass's mood would eventually park
 * perfectly good scopes as permanently failed.
 */
async function releaseHeldScopes(env: Env, countryCode: string, workerId: string): Promise<number> {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE osm_supplement_scope
     SET status = 'pending', lease_expires_at = NULL, work_started_at = NULL, worker_id = NULL
     WHERE country_code = ? AND worker_id = ? AND status = 'running'`,
  ).bind(countryCode, workerId).run();
  return result.meta.changes ?? 0;
}

/**
 * The country-wide Overpass delay after a throttled batch (KAN-389).
 *
 * The signal that matters is whether we are *making progress*, not whether
 * a 429 happened at all. A batch that finished seven municipalities and was
 * throttled on the eighth is being rate-limited while still working; one
 * throttled on its first request is blocked. The first PT run escalated
 * identically for both, so the delay ratcheted to the hour cap and stayed
 * there, starving a job that was otherwise succeeding.
 *
 * Never gets more aggressive than the base delay: this decides how fast we
 * recover, never whether we respect the 429.
 */
export function nextBackoffSeconds(previous: number, completedScopes: number): number {
  if (previous <= 0) return OSM_BACKOFF_BASE_S;
  if (completedScopes > 0) return Math.max(Math.round(previous / 2), OSM_BACKOFF_BASE_S);
  return Math.min(previous * 2, OSM_BACKOFF_MAX_S);
}

/**
 * Close out a batch: drop the country lock, and either finalize the run (no
 * claimable work and nothing still running) or leave it for the next cron.
 *
 * `outcome: 'rate_limited'` additionally sets a country-wide backoff with
 * jitter — CLAUDE.md's rule is that 429 means stop, and 307 municipalities
 * each retrying independently is the opposite.
 */
export async function releaseBatch(
  env: Env,
  options: {
    countryCode: string; runId: string; workerId: string; now: number;
    outcome: 'done' | 'rate_limited';
    /** Scopes this batch finished before it was throttled. */
    completedScopes?: number;
  },
): Promise<{ finalized: boolean; backoffUntil: string | null; counts: ScopeCounts }> {
  const { countryCode, runId, workerId, now } = options;
  let backoffUntil: string | null = null;

  if (options.outcome === 'rate_limited') {
    await releaseHeldScopes(env, countryCode, workerId);
    const current = await env.REGISTRY_DB.prepare(
      'SELECT backoff_seconds FROM osm_supplement_import WHERE country_code = ?',
    ).bind(countryCode).first<{ backoff_seconds: number }>();
    const previous = current?.backoff_seconds ?? 0;
    const base = nextBackoffSeconds(previous, options.completedScopes ?? 0);
    // Jitter so several countries backing off together do not resume in
    // lockstep and reproduce the burst that caused the 429.
    const seconds = Math.round(base * (0.75 + Math.random() * 0.5));
    backoffUntil = iso(now + seconds * 1000);
    // The backoff itself is country-wide, but the lock is only ours to drop
    // if we still hold it: our lease may have lapsed and another batch taken
    // it, and clearing that would put a second container on an Overpass that
    // just rate-limited us. Same guard as the 'done' branch.
    await env.REGISTRY_DB.prepare(
      `UPDATE osm_supplement_import
       SET backoff_until = ?, backoff_seconds = ?,
           batch_worker_id = CASE WHEN batch_worker_id = ? THEN NULL ELSE batch_worker_id END,
           batch_lease_expires_at = CASE WHEN batch_worker_id = ? THEN NULL ELSE batch_lease_expires_at END
       WHERE country_code = ? AND active_run_id = ?`,
    ).bind(backoffUntil, base, workerId, workerId, countryCode, runId).run();
  } else {
    // A clean batch clears the backoff ladder — the next 429, if any, starts
    // from the base delay rather than inheriting an hour-long penalty.
    await env.REGISTRY_DB.prepare(
      `UPDATE osm_supplement_import
       SET batch_worker_id = NULL, batch_lease_expires_at = NULL, backoff_seconds = 0, backoff_until = NULL
       WHERE country_code = ? AND active_run_id = ? AND batch_worker_id = ?`,
    ).bind(countryCode, runId, workerId).run();
  }

  const counts = await scopeCounts(env, countryCode, now);
  if (options.outcome === 'rate_limited' || counts.claimable > 0 || counts.running > 0) {
    return { finalized: false, backoffUntil, counts };
  }

  // Terminal policy: permanently-failed scopes do not block the country.
  // A handful of unreachable municipalities is a visible, individually
  // re-runnable gap, not a reason to withhold national coverage.
  const finalize = await env.REGISTRY_DB.prepare(
    `UPDATE osm_supplement_import
     SET status = 'mapped', completed_at = ?, source_elements = ?, inserted_rows = ?,
         matched_skipped = ?, ambiguous_skipped = ?, failed_scopes = ?,
         batch_worker_id = NULL, batch_lease_expires_at = NULL,
         last_error = CASE WHEN ? > 0 THEN ? ELSE NULL END
     WHERE country_code = ? AND active_run_id = ? AND status = 'mapping'`,
  ).bind(
    iso(now), counts.overpassElements, counts.inserted, counts.matchedSkipped, counts.ambiguousSkipped,
    counts.failed, counts.failed, `${counts.failed} scope(s) permanently failed`,
    countryCode, runId,
  ).run();
  return { finalized: finalize.meta.changes === 1, backoffUntil, counts };
}

/** Cooperative stop — the container checks between scopes and exits. */
export async function requestCancel(env: Env, countryCode: string, now: number): Promise<boolean> {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE osm_supplement_import
     SET cancel_requested = 1, status = 'failed', completed_at = ?,
         last_error = 'cancelled by operator', batch_worker_id = NULL, batch_lease_expires_at = NULL
     WHERE country_code = ? AND status = 'mapping'`,
  ).bind(iso(now), countryCode).run();
  if (result.meta.changes !== 1) return false;
  await env.REGISTRY_DB.prepare(
    `UPDATE osm_supplement_scope
     SET status = 'pending', lease_expires_at = NULL, work_started_at = NULL, worker_id = NULL
     WHERE country_code = ? AND status = 'running'`,
  ).bind(countryCode).run();
  return true;
}

/** completed / total, what is running right now, elapsed, and the failures. */
export async function supplementStatus(env: Env, countryCode: string, now: number) {
  const run = await env.REGISTRY_DB.prepare(
    `SELECT status, active_run_id, started_at, completed_at, failed_scopes, backoff_until, backoff_seconds,
            batch_worker_id, batch_lease_expires_at, cancel_requested, last_error
     FROM osm_supplement_import WHERE country_code = ?`,
  ).bind(countryCode).first<Record<string, unknown>>();
  if (!run) return null;
  const counts = await scopeCounts(env, countryCode, now);
  const running = await env.REGISTRY_DB.prepare(
    `SELECT place_id, worker_id, work_started_at, lease_expires_at
     FROM osm_supplement_scope WHERE country_code = ? AND status = 'running' ORDER BY place_id`,
  ).bind(countryCode).all<Record<string, unknown>>();
  const failures = await env.REGISTRY_DB.prepare(
    `SELECT place_id, consecutive_attempts, total_attempts, lease_expiries, last_error, last_error_class
     FROM osm_supplement_scope WHERE country_code = ? AND status = 'failed' ORDER BY place_id LIMIT 50`,
  ).bind(countryCode).all<Record<string, unknown>>();
  const startedAt = typeof run.started_at === 'string' ? Date.parse(run.started_at) : NaN;
  return {
    countryCode,
    status: run.status,
    runId: run.active_run_id,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    elapsedSeconds: Number.isNaN(startedAt) ? null : Math.round((now - startedAt) / 1000),
    progress: `${counts.completed}/${counts.total}`,
    counts,
    backoffUntil: run.backoff_until,
    batchActive: typeof run.batch_lease_expires_at === 'string' && Date.parse(run.batch_lease_expires_at) > now,
    cancelRequested: run.cancel_requested === 1,
    lastError: run.last_error,
    currentScopes: running.results ?? [],
    failures: failures.results ?? [],
  };
}

/**
 * Countries the cron should start a batch for: mapping, not cancelled, not
 * backing off, no live batch lock. The claimable check is per country and
 * done by the caller so this stays one cheap query.
 */
export async function countriesAwaitingBatch(env: Env, now: number) {
  const rows = await env.REGISTRY_DB.prepare(
    `SELECT country_code, active_run_id FROM osm_supplement_import
     WHERE status = 'mapping' AND cancel_requested = 0
       AND (backoff_until IS NULL OR backoff_until <= ?)
       AND (batch_lease_expires_at IS NULL OR batch_lease_expires_at <= ?)`,
  ).bind(iso(now), iso(now)).all<{ country_code: string; active_run_id: string | null }>();
  return rows.results ?? [];
}
