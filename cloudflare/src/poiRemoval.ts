/**
 * KAN-428 — validation for community POI removal proposals.
 *
 * Data-only, like manualPoi.ts, so it can be tested without a Worker runtime.
 *
 * A removal never describes a place. It names one record we already hold,
 * which the contributor picked from `GET /manual-poi/search` — so the only
 * identity this module accepts is a source-tagged id, never a coordinate.
 */

export const POI_REMOVAL_SOURCES = Object.freeze(['foursquare', 'openstreetmap', 'community'] as const);
export type PoiRemovalSource = typeof POI_REMOVAL_SOURCES[number];

/**
 * Why a record should go. Deliberately narrow: a wrong *type* or a wrong
 * name is a correction, and correcting a record is not the same operation as
 * taking it out of the registry. Adding those here would let a reviewer
 * approve a "removal" that the contributor meant as an edit.
 */
export const POI_REMOVAL_REASONS = Object.freeze(['closed', 'never_existed', 'duplicate'] as const);
export type PoiRemovalReason = typeof POI_REMOVAL_REASONS[number];

export interface PoiRemovalInput {
  targetSource: PoiRemovalSource;
  targetId: string;
  reason: PoiRemovalReason;
  contributorNote: string | null;
  idempotencyKey: string;
  turnstileToken: string;
}

const MAX_TARGET_ID_LENGTH = 200;
const MAX_NOTE_LENGTH = 600;
const MAX_TURNSTILE_TOKEN_LENGTH = 2_048;

export function parsePoiRemovalInput(value: unknown): PoiRemovalInput | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'body must be an object' };
  const body = value as Record<string, unknown>;

  if (typeof body.targetSource !== 'string' || !POI_REMOVAL_SOURCES.includes(body.targetSource as PoiRemovalSource)) {
    return { error: 'targetSource must be foursquare, openstreetmap, or community' };
  }
  if (typeof body.targetId !== 'string') return { error: 'targetId is required' };
  const targetId = body.targetId.trim();
  if (!targetId || targetId.length > MAX_TARGET_ID_LENGTH) {
    return { error: `targetId must contain text and be at most ${MAX_TARGET_ID_LENGTH} characters` };
  }
  if (typeof body.reason !== 'string' || !POI_REMOVAL_REASONS.includes(body.reason as PoiRemovalReason)) {
    return { error: 'reason must be closed, never_existed, or duplicate' };
  }
  if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.idempotencyKey)) {
    return { error: 'idempotencyKey is invalid' };
  }
  if (typeof body.turnstileToken !== 'string' || body.turnstileToken.length === 0 || body.turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH) {
    return { error: 'turnstileToken is invalid' };
  }

  let contributorNote: string | null = null;
  if (body.contributorNote !== undefined && body.contributorNote !== null && body.contributorNote !== '') {
    if (typeof body.contributorNote !== 'string') return { error: `contributorNote must be at most ${MAX_NOTE_LENGTH} characters` };
    const trimmed = body.contributorNote.trim();
    if (trimmed.length > MAX_NOTE_LENGTH) return { error: `contributorNote must be at most ${MAX_NOTE_LENGTH} characters` };
    contributorNote = trimmed;
  }

  return {
    targetSource: body.targetSource as PoiRemovalSource,
    targetId,
    reason: body.reason as PoiRemovalReason,
    contributorNote,
    idempotencyKey: body.idempotencyKey,
    turnstileToken: body.turnstileToken,
  };
}

export function isPoiRemovalInput(value: PoiRemovalInput | { error: string }): value is PoiRemovalInput {
  return !('error' in value);
}
