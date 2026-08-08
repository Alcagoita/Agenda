/**
 * tripSuggestions.ts — KAN-245 ("Going somewhere?" contextual suggestions).
 *
 * Shared rule engine backing three signals (calendar, far-pin, empty-state
 * rotation — the last needs no engine, it's already a rotating nudge slot).
 * A signal instance is offered at most once, ever — dismissal is permanent,
 * unlike errandBundles.ts's per-day table. Own tiny SQLite table (same
 * expo-sqlite dependency habitatCache.ts/errandBundles.ts already use), so
 * "don't show this again" survives an app restart with no new dependency.
 *
 * Signal id format is the caller's contract, not enforced here — e.g.
 * `calendar:{eventId}` or `farpin:{taskId}` — as long as it's stable for the
 * same underlying event/task and distinct for a new one (a rescheduled trip
 * or a new task is a new instance, per the ticket's "new trips/events are
 * new instances" rule).
 */

import * as SQLite from 'expo-sqlite';
import type { CalendarEventItem } from './calendar';

// ─── Signal detection (pure, unit-testable) ────────────────────────────────────

/** How far ahead the calendar signal scans for candidate events. */
export const CALENDAR_SIGNAL_LOOKAHEAD_DAYS = 7;

export interface CalendarSuggestion {
  signalId: string;
  eventId: string;
  /** Event's free-text location, as typed by whoever created the calendar event. */
  place: string;
  /** Event start date/time, ISO string. */
  dateISO: string;
}

/** Below this length a token is too generic to trust as a match on its own (e.g. "de", "of", "St"). */
const MIN_MATCH_TOKEN_LENGTH = 3;

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= MIN_MATCH_TOKEN_LENGTH);
}

/**
 * On-device text match — never geocodes (KAN-245 privacy note: "nothing
 * leaves the device"). Token-based, not raw substring: a location counts as
 * known if it shares at least one meaningful (≥3-char) word with a known
 * area (trip destination / mall name) — e.g. event location "Faro Airport"
 * matches a trip to "Faro, Portugal" on the shared token "faro". Plain
 * substring matching was tried first and dropped: short known names (e.g.
 * "NY") were matching as substrings inside unrelated words.
 */
function matchesKnownAreaName(location: string, knownAreaNames: readonly string[]): boolean {
  const locationTokens = new Set(tokenize(location));
  if (locationTokens.size === 0) { return false; }
  return knownAreaNames.some(name => tokenize(name).some(t => locationTokens.has(t)));
}

/**
 * The single best calendar-signal candidate, or null. An event qualifies
 * when: it has a location, it falls within CALENDAR_SIGNAL_LOOKAHEAD_DAYS,
 * its location doesn't text-match any known area, and its signal id
 * (`calendar:{eventId}`) hasn't already been dismissed. Ties broken by
 * earliest date — only ever surface one card at a time.
 */
export function detectCalendarSignal(
  events: readonly CalendarEventItem[],
  knownAreaNames: readonly string[],
  dismissedIds: ReadonlySet<string>,
  now: Date = new Date(),
): CalendarSuggestion | null {
  const maxDate = new Date(now);
  maxDate.setDate(maxDate.getDate() + CALENDAR_SIGNAL_LOOKAHEAD_DAYS);

  const candidates = events
    .filter((e): e is CalendarEventItem & { location: string } => !!e.location?.trim())
    .filter(e => {
      const start = new Date(e.startDateString);
      return start >= now && start <= maxDate;
    })
    .filter(e => !matchesKnownAreaName(e.location, knownAreaNames))
    .map((e): CalendarSuggestion => ({
      signalId: `calendar:${e.id}`,
      eventId:  e.id,
      place:    e.location.trim(),
      dateISO:  e.startDateString,
    }))
    .filter(c => !dismissedIds.has(c.signalId))
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO));

  return candidates[0] ?? null;
}

export interface FarPinSuggestion {
  signalId: string;
  taskId: string;
  placeName: string;
}

/**
 * Signal 2 — DORMANT (KAN-245 scope resolution, 2026-07-11). Reads only
 * It remains dormant until a source-independent pinned-place model exists.
 * KAN-353 removed the unused Google `poiPlaceId` field rather than preserving
 * a location reference that the app could no longer resolve.
 */
export function detectFarPinSignal(
  taskId: string,
  placeName: string,
  isKnown: boolean,
  dismissedIds: ReadonlySet<string>,
): FarPinSuggestion | null {
  if (isKnown) { return null; }
  const signalId = `farpin:${taskId}`;
  if (dismissedIds.has(signalId)) { return null; }
  return { signalId, taskId, placeName };
}

// ─── Permanent dismissal store ─────────────────────────────────────────────────

const DB_NAME = 'trip_suggestions.db';
let db: SQLite.SQLiteDatabase | null = null;

function getDismissalDb(): SQLite.SQLiteDatabase {
  if (!db) {
    const database = SQLite.openDatabaseSync(DB_NAME);
    database.execSync(`
      CREATE TABLE IF NOT EXISTS dismissed_signals (
        signal_id TEXT PRIMARY KEY NOT NULL
      );
    `);
    db = database;
  }
  return db;
}

/** True if this exact signal instance was already offered/dismissed. Never throws — a DB failure means "not dismissed" (fails open to showing the offer, the more visible/less surprising default). */
export function isSignalDismissed(signalId: string): boolean {
  try {
    const rows = getDismissalDb().getAllSync<{ one: number }>(
      'SELECT 1 as one FROM dismissed_signals WHERE signal_id = ?',
      [signalId],
    );
    return rows.length > 0;
  } catch (err) {
    console.warn('[tripSuggestions] isSignalDismissed failed', err);
    return false;
  }
}

/**
 * All dismissed signal ids, in one query — used to filter candidate signals
 * once per pass instead of a sync SQLite read per candidate.
 */
export function getDismissedSignalIds(): ReadonlySet<string> {
  try {
    const rows = getDismissalDb().getAllSync<{ signal_id: string }>(
      'SELECT signal_id FROM dismissed_signals',
    );
    return new Set(rows.map(r => r.signal_id));
  } catch (err) {
    console.warn('[tripSuggestions] getDismissedSignalIds failed', err);
    return new Set();
  }
}

/** Permanently hides this exact signal instance (offered-and-dismissed, or offered-and-acted-on — either way it never resurfaces). Survives app restart. */
export function dismissSignal(signalId: string): void {
  try {
    getDismissalDb().runSync(
      'INSERT OR REPLACE INTO dismissed_signals (signal_id) VALUES (?)',
      [signalId],
    );
  } catch (err) {
    console.warn('[tripSuggestions] dismissSignal failed', err);
  }
}

/** Test helper — clears the cached db handle so a fresh in-memory db is opened next call. */
export function __resetTripSuggestionsDb(): void {
  db = null;
}
