/**
 * src/services/import.ts — KAN-83 / KAN-84 / KAN-85
 *
 * Task import service.
 *
 * This file is the single entry point for all import connectors. Each connector
 * is responsible for fetching tasks from an external source and writing them to
 * Firestore, returning an ImportResult with imported / skipped / failed counts.
 *
 * Connectors implemented here:
 *   - importFromGoogleTasks      (KAN-84 — Android, Google Tasks API)
 *   - importFromGoogleCalendar   (KAN-84 — Android, Google Calendar API)
 *   - importFromReminders        (KAN-85 — iOS, EventKit)
 *   - importFromCalendar         (KAN-85 — iOS, EventKit)
 *
 * Duplicate detection (shared across all connectors):
 *   A task is a duplicate if a task with the same title (case-insensitive) already
 *   exists in the user's task list. Duplicates are silently skipped — their count
 *   is incremented in ImportResult.skipped.
 */

import firestore from '@react-native-firebase/firestore';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import { Linking, Platform } from 'react-native';
import { fetchReminders, fetchCalendarEvents } from './calendar';
import { ImportResult } from '../types';
import { inferPoiFromRules } from './poiInference';
import { classifyPoi } from './poiLlm';
import { isBirthdayEvent } from './birthday';
import { markTasksDirty } from './taskMutationSignal';

// ─── POI inference for imported tasks (KAN-197) ──────────────────────────────

/** Per-import-batch memoization cache — see inferImportedPoi. */
export type ImportPoiCache = Map<string, Promise<string | null>>;

/**
 * Infer a POI type for an imported task title.
 *   1. Rule map (KAN-195) — instant, offline. Tried in both EN and pt-PT since
 *      the import language is unknown.
 *   2. On-device classifier (KAN-196) — only for titles the rule map misses.
 *   3. Neither → null (a valid, expected result — many tasks have no POI).
 *
 * Never throws: inference must never break or block an import. Returns a POI
 * type string (or a custom Places type from a learned category) or null.
 *
 * Pass a `cache` (create one `new Map()` per import connector call, see
 * `_importFromGoogleTasks` etc.) to memoize repeated titles within that batch
 * (e.g. recurring calendar events) — skips redundant rule-map lookups and,
 * more importantly, redundant on-device classifier calls. The cache is scoped
 * to a single import run rather than kept module-level: the rule-map
 * dictionary's learned layer is mutated at runtime by the on-device
 * classifier and by user POI edits, so a longer-lived cache could keep
 * returning a classification the user has since corrected. A failed lookup is
 * never cached, so a transient classifier failure doesn't permanently poison a
 * title for the rest of the batch.
 */
export async function inferImportedPoi(
  title: string,
  cache?: ImportPoiCache,
): Promise<string | null> {
  const key = title.trim().toLowerCase();
  if (cache) {
    const cached = cache.get(key);
    if (cached) { return cached; }
  }

  const result = (async () => {
    try {
      const rule = inferPoiFromRules(title, 'en') ?? inferPoiFromRules(title, 'pt-PT');
      if (rule) { return rule; }
      return await classifyPoi(title, 'en');
    } catch {
      cache?.delete(key);
      return null;
    }
  })();

  cache?.set(key, result);
  return result;
}

// ─── Timeout wrapper (KAN-92) ─────────────────────────────────────────────────

export const IMPORT_TIMEOUT_MS = 30_000;

/**
 * Sentinel error message used to distinguish a timeout from a general failure.
 * Check with `err.message === IMPORT_TIMEOUT_ERROR` in catch blocks.
 */
export const IMPORT_TIMEOUT_ERROR = 'IMPORT_TIMEOUT';

/**
 * Races `importFn` against a 30-second hard timeout.
 * Returns { promise, clearTimer } so callers can cancel the timer on unmount
 * and avoid the setState-after-unmount warning.
 */
export function runImportWithTimeout(importFn: () => Promise<ImportResult>): {
  promise:   Promise<ImportResult>;
  clearTimer: () => void;
} {
  let timerId: ReturnType<typeof setTimeout>;
  const clearTimer = () => clearTimeout(timerId);

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(IMPORT_TIMEOUT_ERROR)),
      IMPORT_TIMEOUT_MS,
    );
  });

  // Wrap in Promise.resolve().then() so a synchronous throw inside importFn
  // still triggers .finally(clearTimer) instead of leaking the timer.
  const importPromise = Promise.resolve().then(importFn);
  const promise = Promise.race([importPromise, timeoutPromise]).finally(clearTimer);
  return { promise, clearTimer };
}

// ─── Idempotency key (KAN-92) ─────────────────────────────────────────────────

/**
 * Deterministic Firestore doc ID for an imported task.
 * Two concurrent imports writing the same source+title will resolve to the
 * same doc ID, making the second write a no-op overwrite instead of a duplicate.
 *
 * djb2-variant hash keeps the key short and collision-resistant without a
 * crypto dependency.
 */
export function makeImportDocId(source: string, title: string): string {
  const normalized = `${source}:${title.toLowerCase().trim()}`;
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = (((hash << 5) + hash) ^ normalized.charCodeAt(i)) >>> 0;
  }
  return `imp_${hash.toString(36)}`;
}

// ─── Retry with exponential backoff (KAN-93) ─────────────────────────────────

export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

/**
 * Returns true for errors that should NOT be retried automatically:
 *   - Google API 401/403 (auth/permission — retrying won't help)
 *   - EventKit PERMISSION_DENIED (re-triggering Linking.openSettings() on retry would be wrong)
 *   - Cancellation is handled separately (result.cancelled, not a throw)
 */
function isNonRetryable(err: unknown): boolean {
  if (err instanceof Error && /Google API error (401|403)/.test(err.message)) {
    return true;
  }
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'PERMISSION_DENIED'
  );
}

/**
 * Wraps `importFn` with up to 3 automatic retries using exponential backoff
 * + ±300ms jitter. Each attempt gets its own 30-second timeout window.
 *
 * `onRetrying(attempt, total)` is called during each backoff delay so the UI
 * can show "Retrying… (attempt N of 3)".
 *
 * Non-retryable errors (401/403) and cancellations are surfaced immediately.
 */
export async function importWithRetry(
  importFn: () => Promise<ImportResult>,
  onRetrying?: (attempt: number, total: number) => void,
): Promise<ImportResult> {
  const maxRetries = RETRY_DELAYS_MS.length;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { promise } = runImportWithTimeout(importFn);
    try {
      return await promise;
    } catch (err) {
      if (attempt >= maxRetries || isNonRetryable(err)) { throw err; }
      const jitter = Math.random() * 600 - 300;
      const delay  = RETRY_DELAYS_MS[attempt] + jitter;
      onRetrying?.(attempt + 1, maxRetries);
      await new Promise<void>(res => setTimeout(res, delay));
    }
  }
  throw new Error('importWithRetry: unreachable');
}

// ─── Cancellation helper (KAN-94) ────────────────────────────────────────────

const CANCELLED_RESULT: ImportResult = { imported: 0, skipped: 0, failed: 0, cancelled: 1 };

function isGoogleSignInCancelled(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === statusCodes.SIGN_IN_CANCELLED
  );
}

// ─── Google API helpers ───────────────────────────────────────────────────────

const GOOGLE_TASK_LISTS_URL = 'https://tasks.googleapis.com/tasks/v1/users/@me/lists';
const googleTasksUrl = (listId: string) =>
  `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks?showCompleted=false`;

interface GoogleTaskList { id: string; title: string; }

const GOOGLE_CALENDAR_URL = (timeMin: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}`;

/**
 * Returns a Google OAuth access token with the import scopes (KAN-201).
 *
 * `getTokens()` alone only works when a Google session already exists. Brush's
 * default login is email/password, which creates no Google session, so we first
 * try `getTokens()` and, if that fails, establish a session via `signIn()`
 * (account picker + scope consent) and retry. A user-cancelled prompt throws
 * `SIGN_IN_CANCELLED`, which the connector wrappers translate into a cancelled
 * result rather than an error.
 */
async function getGoogleAccessToken(): Promise<string> {
  try {
    const tokens = await GoogleSignin.getTokens();
    return tokens.accessToken;
  } catch {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    await GoogleSignin.signIn();
    const tokens = await GoogleSignin.getTokens();
    return tokens.accessToken;
  }
}

/**
 * Fetch a Google API endpoint with the user's OAuth access token.
 * Throws on HTTP errors with a message including the status code.
 */
async function googleFetch(url: string): Promise<unknown> {
  const accessToken = await getGoogleAccessToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google API error ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** Format a JS Date as "YYYY-MM-DD" for Brush task.date field. */
export function formatDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Parse a date from Google APIs.
 * Google Tasks uses RFC 3339 ("2026-06-01T00:00:00.000Z").
 * Google Calendar uses either "YYYY-MM-DD" (all-day) or RFC 3339 (timed).
 * Returns null if the value is absent or unparseable.
 */
export function parseGoogleDate(value: string | undefined): Date | null {
  if (!value) { return null; }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Returns true if the event should be filtered out:
 *   - All-day events more than 30 days in the future.
 *
 * TODO: make the cutoff configurable (e.g. user-facing "import range" setting)
 * rather than hardcoding 30 days. Timed events are always imported regardless
 * of how far out they are.
 */
export function shouldSkipCalendarEvent(
  startDate: Date,
  isAllDay: boolean,
  now: Date,
): boolean {
  if (!isAllDay) { return false; }
  const thirtyDaysOut = new Date(now);
  thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);
  return startDate > thirtyDaysOut;
}

// ─── Description mapping (KAN-95) ─────────────────────────────────────────────

/**
 * Strip HTML to plain text. Google Calendar event descriptions may contain
 * markup (`<a>`, `<br>`, entities). A regex pass is sufficient for v1 — we are
 * not rendering rich text, just storing a readable note.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')  // <br> → newline before dropping tags
    .replace(/<[^>]*>/g, ' ')             // remaining tags → space
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[^\S\n]+/g, ' ')            // collapse spaces/tabs, keep newlines
    .replace(/\s*\n\s*/g, '\n')           // trim around newlines
    .trim();
}

/**
 * Normalize an external note/description into a `Task.description` value.
 * Returns `undefined` (not an empty string) when there is nothing to store, so
 * callers can omit the field entirely and avoid writing empty descriptions.
 *
 * Pass `{ html: true }` for sources whose notes may contain markup
 * (Google Calendar). Plain-text sources (Google Tasks, EventKit) omit it.
 */
export function toDescription(
  raw: string | undefined,
  opts: { html?: boolean } = {},
): string | undefined {
  if (!raw) { return undefined; }
  const text = (opts.html ? stripHtml(raw) : raw).trim();
  return text || undefined;
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

/**
 * Fetch the set of lowercase titles for all tasks belonging to `uid`.
 * Used by every connector to check for duplicates before writing.
 */
export async function fetchExistingTitles(uid: string): Promise<Set<string>> {
  const snapshot = await firestore()
    .collection('users')
    .doc(uid)
    .collection('tasks')
    .get();

  const titles = new Set<string>();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (typeof data.title === 'string') {
      titles.add(data.title.toLowerCase().trim());
    }
  }
  return titles;
}

/**
 * Returns true if `title` already exists in `existingTitles` (case-insensitive).
 */
export function isDuplicate(title: string, existingTitles: Set<string>): boolean {
  return existingTitles.has(title.toLowerCase().trim());
}

// ─── Connectors ───────────────────────────────────────────────────────────────

/**
 * Import tasks from Google Tasks (KAN-84).
 *
 * Fetches all incomplete tasks from the user's default Google Tasks list,
 * maps them to Brush tasks, skips duplicates, and writes to Firestore.
 */
export async function importFromGoogleTasks(uid: string): Promise<ImportResult> {
  try { return await _importFromGoogleTasks(uid); }
  catch (err) {
    if (isGoogleSignInCancelled(err)) { return CANCELLED_RESULT; }
    throw err;
  }
}

async function _importFromGoogleTasks(uid: string): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, failed: 0, cancelled: 0 };
  const poiCache: ImportPoiCache = new Map();

  const existingTitles = await fetchExistingTitles(uid);
  const listsData = await googleFetch(GOOGLE_TASK_LISTS_URL) as { items?: GoogleTaskList[] };
  const lists: GoogleTaskList[] = listsData.items ?? [];
  const allItems: GoogleTaskItem[] = [];
  for (const list of lists) {
    const data = await googleFetch(googleTasksUrl(list.id)) as { items?: GoogleTaskItem[] };
    allItems.push(...(data.items ?? []));
  }
  const items: GoogleTaskItem[] = allItems;

  // NOTE: Firestore batches are capped at 500 writes. For MVP this is acceptable
  // since users typically have <100 tasks. If imports grow large, chunk into
  // multiple batches of ≤500 writes each. (Future optimisation.)
  const batch = firestore().batch();
  const tasksRef = firestore().collection('users').doc(uid).collection('tasks');

  for (const item of items) {
    const title = item.title?.trim();
    if (!title) { result.skipped++; continue; }

    if (isDuplicate(title, existingTitles)) { result.skipped++; continue; }

    try {
      const dueDate = parseGoogleDate(item.due);
      const description = toDescription(item.notes);
      const poi = await inferImportedPoi(title, poiCache);
      const docRef = tasksRef.doc(makeImportDocId('google_tasks', title));
      batch.set(docRef, {
        id:        docRef.id,
        title,
        category:  'work',
        done:      false,
        ...(dueDate ? {
          scheduledDate: formatDateString(dueDate),
          originalScheduledDate: formatDateString(dueDate),
        } : {}),
        source:    'google_tasks',
        ...(description ? { description } : {}),
        ...(poi ? { poi } : {}),
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
      // Track the title in the local Set to prevent intra-batch duplicates.
      // Safe because batch.commit() is atomic — either all writes land or none
      // do, so the Set never diverges from Firestore on a partial failure.
      existingTitles.add(title.toLowerCase());
      result.imported++;
    } catch {
      result.failed++;
    }
  }

  await batch.commit();
  markTasksDirty();
  return result;
}

/**
 * Import events from Google Calendar (KAN-84).
 *
 * Fetches future primary calendar events, maps them to Brush tasks,
 * skips all-day events more than 30 days out and duplicates, writes to Firestore.
 */
export async function importFromGoogleCalendar(uid: string): Promise<ImportResult> {
  try { return await _importFromGoogleCalendar(uid); }
  catch (err) {
    if (isGoogleSignInCancelled(err)) { return CANCELLED_RESULT; }
    throw err;
  }
}

async function _importFromGoogleCalendar(uid: string): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, failed: 0, cancelled: 0 };
  const poiCache: ImportPoiCache = new Map();
  const now = new Date();

  const existingTitles = await fetchExistingTitles(uid);
  const data = await googleFetch(GOOGLE_CALENDAR_URL(now.toISOString())) as { items?: GoogleCalendarEvent[] };
  const items: GoogleCalendarEvent[] = data.items ?? [];

  // NOTE: Firestore batches are capped at 500 writes. For MVP this is acceptable
  // since users typically have <100 events. If imports grow large, chunk into
  // multiple batches of ≤500 writes each. (Future optimisation.)
  const batch = firestore().batch();
  const tasksRef = firestore().collection('users').doc(uid).collection('tasks');

  for (const item of items) {
    const title = item.summary?.trim();
    if (!title) { result.skipped++; continue; }

    if (isDuplicate(title, existingTitles)) { result.skipped++; continue; }

    try {
      // Google Calendar start: all-day events have start.date; timed events have start.dateTime.
      const isAllDay = Boolean(item.start?.date && !item.start?.dateTime);
      const rawDate  = item.start?.dateTime ?? item.start?.date;
      const startDate = parseGoogleDate(rawDate);

      if (!startDate) { result.skipped++; continue; }
      if (shouldSkipCalendarEvent(startDate, isAllDay, now)) { result.skipped++; continue; }

      const description = toDescription(item.description, { html: true });
      const isBirthday = isBirthdayEvent(title, item.eventType, description);
      // Birthday tasks are date-shaped, not place-shaped (KAN-248) — never
      // worth a POI lookup, and POI/place fields must stay empty for them.
      const poi = isBirthday ? null : await inferImportedPoi(title, poiCache);
      const docRef = tasksRef.doc(makeImportDocId('google_calendar', title));
      batch.set(docRef, {
        id:        docRef.id,
        title,
        category:  isBirthday ? 'personal' : 'work',
        done:      false,
        scheduledDate: formatDateString(startDate),
        originalScheduledDate: formatDateString(startDate),
        source:    'google_calendar',
        ...(description ? { description } : {}),
        ...(poi ? { poi } : {}),
        ...(isBirthday ? { kind: 'birthday' as const } : {}),
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
      existingTitles.add(title.toLowerCase());
      result.imported++;
    } catch {
      result.failed++;
    }
  }

  await batch.commit();
  markTasksDirty();
  return result;
}

// ─── Google API response types ────────────────────────────────────────────────

interface GoogleTaskItem {
  id:     string;
  title?: string;
  notes?: string;  // plain-text note → Task.description (KAN-95)
  due?:   string;  // RFC 3339
  status: 'needsAction' | 'completed';
}

interface GoogleCalendarEvent {
  id:          string;
  summary?:    string;
  description?: string;  // may contain HTML → stripped to Task.description (KAN-95)
  start?: {
    date?:     string;  // "YYYY-MM-DD" for all-day
    dateTime?: string;  // RFC 3339 for timed
  };
  /** Google's own event classification, e.g. "default" | "birthday" | "outOfOffice" | "workingLocation" (KAN-248). */
  eventType?: string;
}

/**
 * Import reminders from iOS EventKit (Reminders app) (KAN-85).
 *
 * Requests Reminders access at call time. If the user previously denied it,
 * opens the Settings app so they can grant it, then throws so the UI can
 * show an appropriate message.
 */
export async function importFromReminders(uid: string): Promise<ImportResult> {
  if (Platform.OS !== 'ios') {
    throw new Error('importFromReminders is only available on iOS.');
  }

  let items: Awaited<ReturnType<typeof fetchReminders>>;
  try {
    items = await fetchReminders();
  } catch (err: unknown) {
    if (isPermissionDenied(err)) {
      await openSettings();
    }
    throw err;
  }

  const result: ImportResult = { imported: 0, skipped: 0, failed: 0, cancelled: 0 };
  const poiCache: ImportPoiCache = new Map();
  const existingTitles = await fetchExistingTitles(uid);
  const batch = firestore().batch();
  const tasksRef = firestore().collection('users').doc(uid).collection('tasks');

  for (const item of items) {
    const title = item.title?.trim();
    if (!title) { result.skipped++; continue; }
    if (isDuplicate(title, existingTitles)) { result.skipped++; continue; }

    try {
      const dueDate = item.dueDateString ? new Date(item.dueDateString) : null;
      const description = toDescription(item.notes);
      const poi = await inferImportedPoi(title, poiCache);
      const docRef = tasksRef.doc(makeImportDocId('eventkit_reminders', title));
      batch.set(docRef, {
        id:        docRef.id,
        title,
        category:  'personal',
        done:      false,
        ...(dueDate && !isNaN(dueDate.getTime())
          ? {
            scheduledDate: formatDateString(dueDate),
            originalScheduledDate: formatDateString(dueDate),
          }
          : {}),
        source:    'eventkit_reminders',
        ...(description ? { description } : {}),
        ...(poi ? { poi } : {}),
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
      existingTitles.add(title.toLowerCase());
      result.imported++;
    } catch {
      result.failed++;
    }
  }

  await batch.commit();
  markTasksDirty();
  return result;
}

/**
 * Import events from iOS EventKit (Calendar app) (KAN-85).
 *
 * Fetches events from today up to 30 days ahead. All-day events beyond 30 days
 * are filtered by the native module. Requests Calendar access at call time.
 */
export async function importFromCalendar(uid: string): Promise<ImportResult> {
  if (Platform.OS !== 'ios') {
    throw new Error('importFromCalendar is only available on iOS.');
  }

  const DAYS_AHEAD = 30;
  let items: Awaited<ReturnType<typeof fetchCalendarEvents>>;
  try {
    items = await fetchCalendarEvents(DAYS_AHEAD);
  } catch (err: unknown) {
    if (isPermissionDenied(err)) {
      await openSettings();
    }
    throw err;
  }

  const result: ImportResult = { imported: 0, skipped: 0, failed: 0, cancelled: 0 };
  const poiCache: ImportPoiCache = new Map();
  const now = new Date();
  const existingTitles = await fetchExistingTitles(uid);
  const batch = firestore().batch();
  const tasksRef = firestore().collection('users').doc(uid).collection('tasks');

  for (const item of items) {
    const title = item.title?.trim();
    if (!title) { result.skipped++; continue; }
    if (isDuplicate(title, existingTitles)) { result.skipped++; continue; }

    try {
      const startDate = new Date(item.startDateString);
      if (isNaN(startDate.getTime())) { result.skipped++; continue; }
      if (shouldSkipCalendarEvent(startDate, item.isAllDay, now)) { result.skipped++; continue; }

      const description = toDescription(item.notes);
      // EventKit exposes no event-type field equivalent to Google's — title/description heuristic only.
      const isBirthday = isBirthdayEvent(title, undefined, description);
      const poi = isBirthday ? null : await inferImportedPoi(title, poiCache);
      const docRef = tasksRef.doc(makeImportDocId('eventkit_calendar', title));
      batch.set(docRef, {
        id:        docRef.id,
        title,
        category:  isBirthday ? 'personal' : 'work',
        done:      false,
        scheduledDate: formatDateString(startDate),
        originalScheduledDate: formatDateString(startDate),
        source:    'eventkit_calendar',
        ...(description ? { description } : {}),
        ...(poi ? { poi } : {}),
        ...(isBirthday ? { kind: 'birthday' as const } : {}),
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
      existingTitles.add(title.toLowerCase());
      result.imported++;
    } catch {
      result.failed++;
    }
  }

  await batch.commit();
  markTasksDirty();
  return result;
}

// ─── EventKit helpers ─────────────────────────────────────────────────────────

function isPermissionDenied(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'PERMISSION_DENIED'
  );
}

async function openSettings(): Promise<void> {
  await Linking.openSettings();
}
