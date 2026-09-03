import type { Env } from './index';

export type OvertureCountryImportStatus = 'none' | 'mapping' | 'mapped' | 'failed';

function iso(now: number): string {
  return new Date(now).toISOString();
}

export function overtureCountrySourceKey(countryCode: string, runId: string): string {
  return `overture-country-sources/${countryCode}/${runId}.csv`;
}

export function overtureCountryReportKey(countryCode: string, runId: string): string {
  return `overture-country-reports/${countryCode}/${runId}.tsv`;
}

export async function queueOvertureCountryImport(env: Env, countryCode: string, now: number) {
  const runId = crypto.randomUUID();
  const result = await env.REGISTRY_DB.prepare(
    `INSERT INTO overture_country_import
       (country_code, status, active_run_id, started_at, completed_at, raw_extract_r2_key,
        backlog_report_r2_key, source_rows, staged_rows, dropped_rows, promoted_rows,
        rejected_rows, pending_rows, last_error)
     VALUES (?, 'mapping', ?, ?, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, NULL)
     ON CONFLICT(country_code) DO UPDATE SET
       status = 'mapping', active_run_id = excluded.active_run_id, started_at = excluded.started_at,
       completed_at = NULL,
       raw_extract_r2_key = CASE WHEN overture_country_import.status = 'failed'
         THEN overture_country_import.raw_extract_r2_key ELSE NULL END,
       backlog_report_r2_key = NULL,
       source_rows = 0, staged_rows = 0, dropped_rows = 0, promoted_rows = 0,
       rejected_rows = 0, pending_rows = 0, last_error = NULL
     WHERE overture_country_import.status IN ('none', 'failed', 'mapped')`,
  ).bind(countryCode, runId, iso(now)).run();
  const row = await env.REGISTRY_DB.prepare(
    'SELECT status, active_run_id, raw_extract_r2_key FROM overture_country_import WHERE country_code = ?',
  ).bind(countryCode).first<{ status: OvertureCountryImportStatus; active_run_id: string | null; raw_extract_r2_key: string | null }>();
  return { started: result.meta.changes === 1, runId: row?.active_run_id ?? null, rawExtractR2Key: row?.raw_extract_r2_key ?? null, status: row?.status ?? 'none' };
}

export async function checkpointOvertureCountrySource(env: Env, options: {
  countryCode: string; runId: string; rawExtractR2Key: string; sourceRows: number;
}): Promise<boolean> {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE overture_country_import SET raw_extract_r2_key = ?, source_rows = ?, last_error = NULL
     WHERE country_code = ? AND active_run_id = ? AND status = 'mapping'`,
  ).bind(options.rawExtractR2Key, options.sourceRows, options.countryCode, options.runId).run();
  return result.meta.changes === 1;
}

export async function completeOvertureCountryImport(env: Env, options: {
  countryCode: string; runId: string; backlogReportR2Key: string; sourceRows: number;
  stagedRows: number; droppedRows: number; promotedRows: number; rejectedRows: number; pendingRows: number; now: number;
}): Promise<boolean> {
  if (options.sourceRows !== options.stagedRows + options.droppedRows) return false;
  if (options.promotedRows + options.rejectedRows + options.pendingRows !== options.stagedRows) return false;
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE overture_country_import SET status = 'mapped', completed_at = ?, backlog_report_r2_key = ?,
       source_rows = ?, staged_rows = ?, dropped_rows = ?, promoted_rows = ?, rejected_rows = ?, pending_rows = ?, last_error = NULL
     WHERE country_code = ? AND active_run_id = ? AND status = 'mapping' AND raw_extract_r2_key IS NOT NULL`,
  ).bind(iso(options.now), options.backlogReportR2Key, options.sourceRows, options.stagedRows,
    options.droppedRows, options.promotedRows, options.rejectedRows, options.pendingRows,
    options.countryCode, options.runId).run();
  return result.meta.changes === 1;
}

export async function failOvertureCountryImport(env: Env, countryCode: string, runId: string, error: string, now: number): Promise<boolean> {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE overture_country_import SET status = 'failed', completed_at = ?, last_error = ?
     WHERE country_code = ? AND active_run_id = ? AND status = 'mapping'`,
  ).bind(iso(now), error.slice(0, 1_000), countryCode, runId).run();
  return result.meta.changes === 1;
}

export async function overtureCountryImportStatus(env: Env, countryCode: string) {
  return env.REGISTRY_DB.prepare('SELECT * FROM overture_country_import WHERE country_code = ?')
    .bind(countryCode).first<Record<string, unknown>>();
}
