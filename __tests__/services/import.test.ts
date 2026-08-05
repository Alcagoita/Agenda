/**
 * KAN-83 / KAN-85 — import service unit tests.
 *
 * Covers:
 *   - isDuplicate (case-insensitive, whitespace)
 *   - fetchExistingTitles (Firestore path, lowercase, missing title field)
 *   - importFromReminders (happy path, duplicate skip, permission denied)
 *   - importFromCalendar  (happy path, duplicate skip, 30-day filter, permission denied)
 *
 * Note: Google connector tests (importFromGoogleTasks / importFromGoogleCalendar)
 * live in __tests__/services/googleImport.test.ts (KAN-84).
 */

import {
  isDuplicate,
  fetchExistingTitles,
  importFromReminders,
  importFromCalendar,
  runImportWithTimeout,
  importWithRetry,
  makeImportDocId,
  stripHtml,
  toDescription,
  inferImportedPoi,
  IMPORT_TIMEOUT_MS,
  IMPORT_TIMEOUT_ERROR,
  RETRY_DELAYS_MS,
} from '../../src/services/import';
import type { ImportPoiCache } from '../../src/services/import';
import type { ImportResult } from '../../src/types';

// ─── GoogleSignin mock ────────────────────────────────────────────────────────

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { getTokens: jest.fn(), configure: jest.fn() },
}));

// ─── react-native mocks ───────────────────────────────────────────────────────

const mockOpenSettings = jest.fn().mockResolvedValue(undefined);
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: { openSettings: (...args: unknown[]) => mockOpenSettings(...args) },
  NativeModules: {},
}));

// ─── expo-calendar mock ───────────────────────────────────────────────────────

const mockFetchReminders      = jest.fn();
const mockFetchCalendarEvents = jest.fn();

jest.mock('../../src/services/calendar', () => ({
  fetchReminders:     (...args: unknown[]) => mockFetchReminders(...args),
  fetchCalendarEvents: (...args: unknown[]) => mockFetchCalendarEvents(...args),
}));

// ─── Firestore mock ───────────────────────────────────────────────────────────

const mockGet   = jest.fn();
const mockBatchSet    = jest.fn();
const mockBatchCommit = jest.fn().mockResolvedValue(undefined);

jest.mock('@react-native-firebase/firestore', () => {
  let docIdCounter = 0;
  const docRef = () => ({
    id: `mock-doc-${++docIdCounter}`,
    set: mockBatchSet,
  });
  const batch = () => ({
    set:    mockBatchSet,
    commit: (...args: unknown[]) => mockBatchCommit(...args),
  });
  const firestoreFn = () => ({
    batch,
    collection: () => ({
      doc: () => ({
        collection: () => ({
          get:  (...args: unknown[]) => mockGet(...args),
          doc:  docRef,
        }),
      }),
    }),
  });
  (firestoreFn as unknown as { FieldValue: { serverTimestamp: () => string } }).FieldValue = {
    serverTimestamp: () => 'SERVER_TIMESTAMP',
  };
  return {
    __esModule: true,
    default: firestoreFn,
    FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
    // firebase.ts's own module-level init (getFirestore/initializeFirestore/
    // connectFirestoreEmulator/getDocs/query/limit/collection/
    // CACHE_SIZE_UNLIMITED) — reached transitively via
    // import.ts -> poiLlm.ts -> maps.ts -> placesFunctions.ts -> firebase.ts.
    // Not under test here; this file's own fixtures use the namespaced
    // `firestoreFn` above for the actual import-connector logic.
    getFirestore: jest.fn(() => ({})),
    initializeFirestore: jest.fn(),
    connectFirestoreEmulator: jest.fn(),
    getDocs: jest.fn().mockResolvedValue({ docs: [] }),
    query: jest.fn(),
    collection: jest.fn(),
    limit: jest.fn(),
    CACHE_SIZE_UNLIMITED: -1,
  };
});

// ─── runImportWithTimeout (KAN-92) ────────────────────────────────────────────

describe('runImportWithTimeout', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('resolves with the import result when the connector finishes in time', async () => {
    const result = { imported: 2, skipped: 0, failed: 0 };
    const { promise } = runImportWithTimeout(() => Promise.resolve(result));
    await expect(promise).resolves.toEqual(result);
  });

  it('rejects with IMPORT_TIMEOUT when the connector exceeds IMPORT_TIMEOUT_MS', async () => {
    const never = new Promise<never>(() => {/* never resolves */});
    const { promise } = runImportWithTimeout(() => never);
    jest.advanceTimersByTime(IMPORT_TIMEOUT_MS);
    await expect(promise).rejects.toThrow(IMPORT_TIMEOUT_ERROR);
  });

  it('does not fire the timeout if the connector resolves first', async () => {
    const result = { imported: 1, skipped: 0, failed: 0 };
    const { promise } = runImportWithTimeout(() => Promise.resolve(result));
    await promise;
    // Advance past timeout window — no unhandled rejection should occur
    jest.advanceTimersByTime(IMPORT_TIMEOUT_MS + 1000);
    // test passes if no unhandled rejection is thrown
  });

  it('handles a synchronous throw inside importFn without leaking the timer', async () => {
    const syncThrow: () => Promise<ImportResult> = () => { throw new Error('sync-boom'); };
    const { promise } = runImportWithTimeout(syncThrow);
    await expect(promise).rejects.toThrow('sync-boom');
    // Timer must have been cleared — advancing past IMPORT_TIMEOUT_MS should not throw
    jest.advanceTimersByTime(IMPORT_TIMEOUT_MS + 1000);
  });

  it('clearTimer cancels the timeout so it does not fire after unmount', async () => {
    const never = new Promise<never>(() => {/* never resolves */});
    const { promise, clearTimer } = runImportWithTimeout(() => never);
    clearTimer();
    jest.advanceTimersByTime(IMPORT_TIMEOUT_MS + 1000);
    // Promise stays pending (never resolves or rejects) — attach a no-op to avoid leak warning
    promise.catch(() => {});
  });
});

// ─── importWithRetry (KAN-93) ─────────────────────────────────────────────────

describe('importWithRetry', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  const OK: ImportResult = { imported: 1, skipped: 0, failed: 0, cancelled: 0 };

  it('resolves immediately when the first attempt succeeds', async () => {
    const fn = jest.fn().mockResolvedValue(OK);
    await expect(importWithRetry(fn)).resolves.toEqual(OK);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to 3 times and resolves on the final attempt', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(OK);

    const promise = importWithRetry(fn);
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toEqual(OK);
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('throws after all retries are exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));

    const promise = importWithRetry(fn);
    void promise.catch(() => {}); // prevent unhandled rejection before assertion
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('does not retry on 401 auth errors', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('Google API error 401: Unauthorized'));
    await expect(importWithRetry(fn)).rejects.toThrow('401');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 403 auth errors', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('Google API error 403: Forbidden'));
    await expect(importWithRetry(fn)).rejects.toThrow('403');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on EventKit PERMISSION_DENIED errors', async () => {
    const permissionError = Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
    const fn = jest.fn().mockRejectedValue(permissionError);
    await expect(importWithRetry(fn)).rejects.toThrow('denied');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns cancelled result without retrying when result.cancelled > 0', async () => {
    const cancelled: ImportResult = { imported: 0, skipped: 0, failed: 0, cancelled: 1 };
    const fn = jest.fn().mockResolvedValue(cancelled);
    const result = await importWithRetry(fn);
    expect(result.cancelled).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onRetrying with correct attempt and total during backoff', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue(OK);
    const onRetrying = jest.fn();

    const promise = importWithRetry(fn, onRetrying);
    await jest.runAllTimersAsync();
    await promise;

    expect(onRetrying).toHaveBeenCalledWith(1, RETRY_DELAYS_MS.length);
  });
});

// ─── makeImportDocId (KAN-92) ─────────────────────────────────────────────────

describe('makeImportDocId', () => {
  it('returns the same ID for identical source and title', () => {
    expect(makeImportDocId('google_tasks', 'Buy milk')).toBe(
      makeImportDocId('google_tasks', 'Buy milk'),
    );
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(makeImportDocId('google_tasks', 'Buy Milk')).toBe(
      makeImportDocId('google_tasks', '  buy milk  '),
    );
  });

  it('returns different IDs for different sources with the same title', () => {
    expect(makeImportDocId('google_tasks', 'Buy milk')).not.toBe(
      makeImportDocId('google_calendar', 'Buy milk'),
    );
  });

  it('returns different IDs for different titles with the same source', () => {
    expect(makeImportDocId('google_tasks', 'Buy milk')).not.toBe(
      makeImportDocId('google_tasks', 'Call dentist'),
    );
  });

  it('returns an ID that starts with "imp_"', () => {
    expect(makeImportDocId('google_tasks', 'any title')).toMatch(/^imp_/);
  });
});

// ─── stripHtml / toDescription (KAN-95) ──────────────────────────────────────

describe('stripHtml', () => {
  it('removes tags and keeps text content', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('converts <br> to a newline', () => {
    expect(stripHtml('line one<br>line two')).toBe('line one\nline two');
    expect(stripHtml('line one<br/>line two')).toBe('line one\nline two');
  });

  it('decodes common HTML entities', () => {
    expect(stripHtml('Tom &amp; Jerry &lt;tag&gt; &quot;q&quot; &#39;a&#39;')).toBe(
      'Tom & Jerry <tag> "q" \'a\'',
    );
  });

  it('collapses whitespace but preserves newlines', () => {
    expect(stripHtml('a   b<br>  c  ')).toBe('a b\nc');
  });
});

describe('toDescription', () => {
  it('returns undefined for undefined input', () => {
    expect(toDescription(undefined)).toBeUndefined();
  });

  it('returns undefined for whitespace-only input', () => {
    expect(toDescription('   ')).toBeUndefined();
  });

  it('trims plain-text input', () => {
    expect(toDescription('  pick up milk  ')).toBe('pick up milk');
  });

  it('strips HTML when { html: true }', () => {
    expect(toDescription('<p>Agenda</p>', { html: true })).toBe('Agenda');
  });

  it('returns undefined when HTML strips down to nothing', () => {
    expect(toDescription('<br> <p></p>', { html: true })).toBeUndefined();
  });
});

// ─── inferImportedPoi (KAN-197) ──────────────────────────────────────────────

describe('inferImportedPoi', () => {
  it('infers a POI via the EN rule map', async () => {
    expect(await inferImportedPoi('Buy bread')).toBe('supermarket');
    expect(await inferImportedPoi('withdraw cash')).toBe('atm');
  });

  it('infers a POI via the pt-PT rule map', async () => {
    expect(await inferImportedPoi('comprar pão')).toBe('supermarket');
    expect(await inferImportedPoi('ir à farmácia')).toBe('pharmacy');
  });

  it('returns null when neither rule map nor classifier matches', async () => {
    // The classifier is unavailable in tests (fast-tflite manual mock rejects),
    // so a no-keyword title falls through to null.
    expect(await inferImportedPoi('call mom')).toBeNull();
    expect(await inferImportedPoi('finish the quarterly report')).toBeNull();
  });
});

// ─── inferImportedPoi memoization (KAN-215) ──────────────────────────────────

describe('inferImportedPoi memoization', () => {
  it('calls the on-device classifier only once for a repeated title when a cache is passed', async () => {
    const classifyPoi = jest.spyOn(require('../../src/services/poiLlm'), 'classifyPoi')
      .mockResolvedValue('cafe');

    // No rule-map entry matches this title, so it must reach the classifier.
    const title = 'Zzyzx unique nonmatching title 42';
    const cache: ImportPoiCache = new Map();
    const first  = await inferImportedPoi(title, cache);
    const second = await inferImportedPoi(title, cache);

    expect(first).toBe('cafe');
    expect(second).toBe('cafe');
    expect(classifyPoi).toHaveBeenCalledTimes(1);

    classifyPoi.mockRestore();
  });

  it('treats titles differing only by case/whitespace as the same cache key', async () => {
    const classifyPoi = jest.spyOn(require('../../src/services/poiLlm'), 'classifyPoi')
      .mockResolvedValue('bank');

    const cache: ImportPoiCache = new Map();
    await inferImportedPoi('  Another Unique Nonmatching Title 99  ', cache);
    await inferImportedPoi('another unique nonmatching title 99', cache);

    expect(classifyPoi).toHaveBeenCalledTimes(1);

    classifyPoi.mockRestore();
  });

  it('without a cache, does not memoize — the classifier runs again for a repeated title', async () => {
    const classifyPoi = jest.spyOn(require('../../src/services/poiLlm'), 'classifyPoi')
      .mockResolvedValue('gym');

    const title = 'Yzzyx another unique nonmatching title 7';
    await inferImportedPoi(title);
    await inferImportedPoi(title);

    expect(classifyPoi).toHaveBeenCalledTimes(2);

    classifyPoi.mockRestore();
  });

  it('does not cache a failed lookup — a later call with the same cache retries', async () => {
    const classifyPoi = jest.spyOn(require('../../src/services/poiLlm'), 'classifyPoi')
      .mockRejectedValueOnce(new Error('classifier unavailable'))
      .mockResolvedValueOnce('supermarket');

    const title = 'Qwxyz yet another unique nonmatching title 8';
    const cache: ImportPoiCache = new Map();
    const first  = await inferImportedPoi(title, cache);
    const second = await inferImportedPoi(title, cache);

    expect(first).toBeNull();
    expect(second).toBe('supermarket');
    expect(classifyPoi).toHaveBeenCalledTimes(2);

    classifyPoi.mockRestore();
  });
});

// ─── isDuplicate ─────────────────────────────────────────────────────────────

describe('isDuplicate', () => {
  it('returns true for an exact match', () => {
    const titles = new Set(['pick up milk', 'call mom']);
    expect(isDuplicate('pick up milk', titles)).toBe(true);
  });

  it('returns true when title differs only in case', () => {
    const titles = new Set(['pick up milk']);
    expect(isDuplicate('Pick Up Milk', titles)).toBe(true);
  });

  it('returns true when the existing title has mixed case and the input is lowercase', () => {
    // Titles in the set are already lowercased by fetchExistingTitles; check
    // that isDuplicate lowercases the incoming title.
    const titles = new Set(['buy bread']);
    expect(isDuplicate('BUY BREAD', titles)).toBe(true);
  });

  it('returns true when input has leading/trailing whitespace', () => {
    const titles = new Set(['buy bread']);
    expect(isDuplicate('  buy bread  ', titles)).toBe(true);
  });

  it('returns false when the title is not present in the set', () => {
    const titles = new Set(['pick up milk']);
    expect(isDuplicate('grab coffee', titles)).toBe(false);
  });

  it('returns false for an empty set', () => {
    expect(isDuplicate('any task', new Set())).toBe(false);
  });

  it('returns false for an empty title string against a non-empty set', () => {
    const titles = new Set(['something']);
    expect(isDuplicate('', titles)).toBe(false);
  });
});

// ─── fetchExistingTitles ──────────────────────────────────────────────────────

describe('fetchExistingTitles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns lowercase titles from the Firestore snapshot', async () => {
    mockGet.mockResolvedValueOnce({
      docs: [
        { data: () => ({ title: 'Pick up milk' }) },
        { data: () => ({ title: 'Call Mom' }) },
      ],
    });

    const result = await fetchExistingTitles('uid-123');
    expect(result).toEqual(new Set(['pick up milk', 'call mom']));
  });

  it('trims whitespace when building the title set', async () => {
    mockGet.mockResolvedValueOnce({
      docs: [
        { data: () => ({ title: '  buy bread  ' }) },
      ],
    });

    const result = await fetchExistingTitles('uid-123');
    expect(result.has('buy bread')).toBe(true);
  });

  it('skips docs that have no title field', async () => {
    mockGet.mockResolvedValueOnce({
      docs: [
        { data: () => ({ done: false }) },          // no title
        { data: () => ({ title: 'valid task' }) },
      ],
    });

    const result = await fetchExistingTitles('uid-123');
    expect(result.size).toBe(1);
    expect(result.has('valid task')).toBe(true);
  });

  it('returns an empty set when there are no tasks', async () => {
    mockGet.mockResolvedValueOnce({ docs: [] });
    const result = await fetchExistingTitles('uid-123');
    expect(result.size).toBe(0);
  });
});

// ─── importFromReminders ──────────────────────────────────────────────────────

describe('importFromReminders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ docs: [] });
    mockBatchCommit.mockResolvedValue(undefined);
  });

  it('imports reminders and returns correct counts', async () => {
    mockFetchReminders.mockResolvedValueOnce([
      { title: 'Pick up milk', dueDateString: '2026-06-10T00:00:00.000Z' },
      { title: 'Call dentist' },
    ]);

    const result = await importFromReminders('uid-1');
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);
  });

  it('skips reminder whose title already exists (case-insensitive)', async () => {
    mockGet.mockResolvedValueOnce({
      docs: [{ data: () => ({ title: 'pick up milk' }) }],
    });
    mockFetchReminders.mockResolvedValueOnce([
      { title: 'Pick Up Milk' },
      { title: 'New task' },
    ]);

    const result = await importFromReminders('uid-1');
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('skips reminder with no title', async () => {
    mockFetchReminders.mockResolvedValueOnce([
      { title: '' },
      { title: '   ' },
    ]);

    const result = await importFromReminders('uid-1');
    expect(result.skipped).toBe(2);
    expect(result.imported).toBe(0);
  });

  it('maps reminder notes to Task.description (KAN-95)', async () => {
    mockFetchReminders.mockResolvedValueOnce([
      { title: 'Pick up milk', notes: '  2% organic  ' },
    ]);

    await importFromReminders('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.description).toBe('2% organic');
  });

  it('omits description when the reminder has no notes (KAN-95)', async () => {
    mockFetchReminders.mockResolvedValueOnce([{ title: 'Pick up milk' }]);

    await importFromReminders('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect('description' in setCall).toBe(false);
  });

  it('opens Settings and rethrows when permission is denied', async () => {
    const permissionError = Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
    mockFetchReminders.mockRejectedValueOnce(permissionError);

    await expect(importFromReminders('uid-1')).rejects.toThrow('denied');
    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-permission errors without opening Settings', async () => {
    mockFetchReminders.mockRejectedValueOnce(new Error('FETCH_ERROR'));

    await expect(importFromReminders('uid-1')).rejects.toThrow('FETCH_ERROR');
    expect(mockOpenSettings).not.toHaveBeenCalled();
  });
});

// ─── importFromCalendar ───────────────────────────────────────────────────────

describe('importFromCalendar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ docs: [] });
    mockBatchCommit.mockResolvedValue(undefined);
  });

  it('imports calendar events and returns correct counts', async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([
      { title: 'Team standup', startDateString: '2026-06-05T09:00:00.000Z', isAllDay: false },
      { title: 'Doctor appt',  startDateString: '2026-06-07T14:00:00.000Z', isAllDay: false },
    ]);

    const result = await importFromCalendar('uid-1');
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);
  });

  it('skips event with an unparseable date', async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([
      { title: 'Bad event', startDateString: 'not-a-date', isAllDay: false },
    ]);

    const result = await importFromCalendar('uid-1');
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('skips all-day event more than 30 days out', async () => {
    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 45);
    mockFetchCalendarEvents.mockResolvedValueOnce([
      { title: 'Far event', startDateString: farFuture.toISOString(), isAllDay: true },
    ]);

    const result = await importFromCalendar('uid-1');
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('does not skip timed event more than 30 days out', async () => {
    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 45);
    mockFetchCalendarEvents.mockResolvedValueOnce([
      { title: 'Far timed event', startDateString: farFuture.toISOString(), isAllDay: false },
    ]);

    const result = await importFromCalendar('uid-1');
    expect(result.imported).toBe(1);
  });

  it('maps calendar event notes to Task.description (KAN-95)', async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([
      { title: 'Team standup', startDateString: '2026-06-05T09:00:00.000Z', isAllDay: false, notes: '  bring laptop  ' },
    ]);

    await importFromCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.description).toBe('bring laptop');
  });

  it('omits description when the event has no notes (KAN-95)', async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([
      { title: 'Team standup', startDateString: '2026-06-05T09:00:00.000Z', isAllDay: false },
    ]);

    await importFromCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect('description' in setCall).toBe(false);
  });

  it('opens Settings and rethrows on PERMISSION_DENIED', async () => {
    const permissionError = Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
    mockFetchCalendarEvents.mockRejectedValueOnce(permissionError);

    await expect(importFromCalendar('uid-1')).rejects.toThrow('denied');
    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('passes daysAhead=30 to the native module', async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([]);
    await importFromCalendar('uid-1');
    expect(mockFetchCalendarEvents).toHaveBeenCalledWith(30);
  });

  // ─── Birthday detection (KAN-248) ─────────────────────────────────────────

  it('imports a title-matched birthday event as kind:birthday, category:personal, no poi', async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([
      { title: 'Maria\'s Birthday', startDateString: '2026-06-05T09:00:00.000Z', isAllDay: true },
    ]);

    await importFromCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.kind).toBe('birthday');
    expect(setCall.category).toBe('personal');
    expect('poi' in setCall).toBe(false);
  });

  it('imports a description-matched birthday event as kind:birthday when the title has no match', async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([
      { title: 'Dinner', startDateString: '2026-06-05T09:00:00.000Z', isAllDay: true, notes: 'Happy Birthday Maria!' },
    ]);

    await importFromCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.kind).toBe('birthday');
    expect(setCall.category).toBe('personal');
  });

  it('imports a non-birthday event as a normal task (no kind, category:work)', async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([
      { title: 'Team standup', startDateString: '2026-06-05T09:00:00.000Z', isAllDay: false },
    ]);

    await importFromCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect('kind' in setCall).toBe(false);
    expect(setCall.category).toBe('work');
  });
});
