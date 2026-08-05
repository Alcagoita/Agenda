/**
 * KAN-84 — Google Tasks and Google Calendar import connector tests.
 *
 * Covers:
 *   formatDateString
 *     - formats a Date as YYYY-MM-DD
 *   parseGoogleDate
 *     - parses RFC 3339 strings
 *     - parses YYYY-MM-DD strings
 *     - returns null for undefined
 *     - returns null for an unparseable string
 *   shouldSkipCalendarEvent
 *     - keeps timed events regardless of how far out they are
 *     - keeps all-day events within 30 days
 *     - skips all-day events more than 30 days out
 *     - keeps all-day events exactly 30 days out (boundary)
 *   importFromGoogleTasks
 *     - imports tasks and writes them to Firestore
 *     - sets source to "google_tasks" on each task
 *     - skips items with no title
 *     - skips duplicate titles (case-insensitive)
 *     - prevents intra-batch duplicates from the same import
 *     - counts failed items when a batch write throws
 *   importFromGoogleCalendar
 *     - imports events and writes them to Firestore
 *     - sets source to "google_calendar" on each task
 *     - skips events with no summary
 *     - skips events with no parseable start date
 *     - skips all-day events more than 30 days out
 *     - keeps timed events regardless of distance
 *     - skips duplicate titles
 *   auth.ts scopes
 *     - GoogleSignin.configure is called with tasks and calendar readonly scopes
 */

import {
  formatDateString,
  parseGoogleDate,
  shouldSkipCalendarEvent,
  importFromGoogleTasks,
  importFromGoogleCalendar,
  fetchExistingTitles,
} from '../../src/services/import';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetTokens   = jest.fn();
const mockSignIn      = jest.fn();
const mockHasPlay     = jest.fn();
const mockBatchSet    = jest.fn();
const mockBatchCommit = jest.fn();
const mockGet         = jest.fn();
const mockDoc         = jest.fn();

jest.mock('../../src/services/calendar', () => ({
  fetchReminders:     jest.fn(),
  fetchCalendarEvents: jest.fn(),
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    getTokens:       (...args: unknown[]) => mockGetTokens(...args),
    signIn:          (...args: unknown[]) => mockSignIn(...args),
    hasPlayServices: (...args: unknown[]) => mockHasPlay(...args),
    configure:       jest.fn(),
  },
  statusCodes: { SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED' },
}));

// Auto-incrementing doc id stub
let docIdCounter = 0;
mockDoc.mockImplementation(() => {
  docIdCounter++;
  const id = `doc-${docIdCounter}`;
  return { id, set: jest.fn() };
});

jest.mock('@react-native-firebase/firestore', () => {
  const batch = () => ({
    set:    (...args: unknown[]) => mockBatchSet(...args),
    commit: (...args: unknown[]) => mockBatchCommit(...args),
  });
  const FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP' };

  const collectionChain = () => ({
    doc:        (...args: unknown[]) => mockDoc(...args),
    get:        (...args: unknown[]) => mockGet(...args),
    collection: collectionChain,
  });

  const firestoreFn = () => ({
    batch,
    collection: () => ({
      doc: () => ({
        collection: collectionChain,
      }),
    }),
  });
  firestoreFn.FieldValue = FieldValue;
  return {
    __esModule: true,
    default: firestoreFn,
    FieldValue,
    // firebase.ts's own module-level init, reached transitively via this
    // file's import chain — not under test here; the namespaced
    // `firestoreFn` above covers the actual import-connector logic.
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

// global fetch mock
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockAccessToken(token = 'test-access-token') {
  mockGetTokens.mockResolvedValue({ accessToken: token });
}

function mockTasksResponse(items: object[]) {
  // First call: lists endpoint; second call: tasks for that list
  mockFetch.mockResolvedValueOnce({
    ok:   true,
    json: async () => ({ items: [{ id: 'list-default', title: 'My Tasks' }] }),
  });
  mockFetch.mockResolvedValueOnce({
    ok:   true,
    json: async () => ({ items }),
  });
}

function mockCalendarResponse(items: object[]) {
  mockFetch.mockResolvedValueOnce({
    ok:   true,
    json: async () => ({ items }),
  });
}

function mockExistingTitles(titles: string[]) {
  const lower = titles.map(t => t.toLowerCase().trim());
  mockGet.mockResolvedValue({
    docs: lower.map(t => ({ data: () => ({ title: t }) })),
  });
}

// ─── formatDateString ─────────────────────────────────────────────────────────

describe('formatDateString', () => {
  it('formats a date as YYYY-MM-DD', () => {
    expect(formatDateString(new Date('2026-06-15T12:00:00Z'))).toBe('2026-06-15');
  });
});

// ─── parseGoogleDate ──────────────────────────────────────────────────────────

describe('parseGoogleDate', () => {
  it('parses an RFC 3339 string', () => {
    const d = parseGoogleDate('2026-06-01T00:00:00.000Z');
    expect(d).toBeInstanceOf(Date);
    expect(d!.getFullYear()).toBe(2026);
  });

  it('parses a YYYY-MM-DD string', () => {
    const d = parseGoogleDate('2026-07-20');
    expect(d).toBeInstanceOf(Date);
  });

  it('returns null for undefined', () => {
    expect(parseGoogleDate(undefined)).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(parseGoogleDate('not-a-date')).toBeNull();
  });
});

// ─── shouldSkipCalendarEvent ──────────────────────────────────────────────────

describe('shouldSkipCalendarEvent', () => {
  const now = new Date('2026-06-04T12:00:00Z');

  it('does not skip timed events regardless of how far out they are', () => {
    const far = new Date('2026-12-31T09:00:00Z');
    expect(shouldSkipCalendarEvent(far, false, now)).toBe(false);
  });

  it('does not skip all-day events within 30 days', () => {
    const soon = new Date('2026-06-20T00:00:00Z');
    expect(shouldSkipCalendarEvent(soon, true, now)).toBe(false);
  });

  it('skips all-day events more than 30 days out', () => {
    const far = new Date('2026-07-20T00:00:00Z');
    expect(shouldSkipCalendarEvent(far, true, now)).toBe(true);
  });

  it('does not skip an all-day event exactly 30 days out', () => {
    const boundary = new Date('2026-07-04T00:00:00Z');
    expect(shouldSkipCalendarEvent(boundary, true, now)).toBe(false);
  });
});

// ─── importFromGoogleTasks ────────────────────────────────────────────────────

describe('importFromGoogleTasks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    docIdCounter = 0;
    mockBatchCommit.mockResolvedValue(undefined);
  });

  it('imports tasks and returns the correct counts', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockTasksResponse([
      { id: '1', title: 'Buy groceries', status: 'needsAction' },
      { id: '2', title: 'Call dentist',  status: 'needsAction' },
    ]);

    const result = await importFromGoogleTasks('uid-1');
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('sets source to "google_tasks" on each written task', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockTasksResponse([{ id: '1', title: 'Buy groceries', status: 'needsAction' }]);

    await importFromGoogleTasks('uid-1');

    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.source).toBe('google_tasks');
    expect(setCall.category).toBe('work');
    expect(setCall.done).toBe(false);
  });

  it('skips items with no title', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockTasksResponse([
      { id: '1', title: '',    status: 'needsAction' },
      { id: '2', title: '   ', status: 'needsAction' },
    ]);

    const result = await importFromGoogleTasks('uid-1');
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it('skips tasks that are duplicates of existing Firestore tasks', async () => {
    mockAccessToken();
    mockExistingTitles(['Buy groceries']);
    mockTasksResponse([
      { id: '1', title: 'Buy Groceries', status: 'needsAction' }, // case-insensitive match
      { id: '2', title: 'Call dentist',  status: 'needsAction' },
    ]);

    const result = await importFromGoogleTasks('uid-1');
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('prevents intra-batch duplicates within the same import', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockTasksResponse([
      { id: '1', title: 'Buy groceries', status: 'needsAction' },
      { id: '2', title: 'BUY GROCERIES', status: 'needsAction' }, // same title, different case
    ]);

    const result = await importFromGoogleTasks('uid-1');
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('uses today as the date when no due date is present', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockTasksResponse([{ id: '1', title: 'No due date task', status: 'needsAction' }]);

    await importFromGoogleTasks('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    // date should be a YYYY-MM-DD string
    expect(setCall.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses the due date when present', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockTasksResponse([{
      id: '1', title: 'Task with due date', status: 'needsAction',
      due: '2026-08-01T00:00:00.000Z',
    }]);

    await importFromGoogleTasks('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.date).toBe('2026-08-01');
  });

  it('maps the task notes field to Task.description (KAN-95)', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockTasksResponse([{
      id: '1', title: 'Buy groceries', status: 'needsAction',
      notes: '  milk, eggs, bread  ',
    }]);

    await importFromGoogleTasks('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.description).toBe('milk, eggs, bread');
  });

  it('omits description when the task has no notes (KAN-95)', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockTasksResponse([{ id: '1', title: 'Buy groceries', status: 'needsAction' }]);

    await importFromGoogleTasks('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect('description' in setCall).toBe(false);
  });

  it('omits description when notes is only whitespace (KAN-95)', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockTasksResponse([{
      id: '1', title: 'Buy groceries', status: 'needsAction', notes: '   ',
    }]);

    await importFromGoogleTasks('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect('description' in setCall).toBe(false);
  });

  it('auto-applies a POI inferred by the rule map (KAN-197)', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockTasksResponse([{ id: '1', title: 'Buy bread', status: 'needsAction' }]);

    await importFromGoogleTasks('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.poi).toBe('supermarket');
  });

  it('omits poi when neither rule map nor classifier matches (KAN-197)', async () => {
    // "Team standup" has no POI keyword; the classifier is mocked unavailable
    // (react-native-fast-tflite manual mock rejects) → poi stays unset.
    mockAccessToken();
    mockExistingTitles([]);
    mockTasksResponse([{ id: '1', title: 'Team standup', status: 'needsAction' }]);

    await importFromGoogleTasks('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect('poi' in setCall).toBe(false);
  });

  it('throws when the Google API returns an error response', async () => {
    mockAccessToken();
    mockGet.mockResolvedValue({ docs: [] });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' });

    await expect(importFromGoogleTasks('uid-1')).rejects.toThrow('401');
  });

  it('signs in then imports when no Google session exists yet (KAN-201)', async () => {
    // First getTokens fails (no session, e.g. email/password login); signIn
    // establishes one, then the retried getTokens succeeds.
    mockGetTokens
      .mockRejectedValueOnce(new Error('no current user'))
      .mockResolvedValueOnce({ accessToken: 'fresh-token' });
    mockHasPlay.mockResolvedValue(true);
    mockSignIn.mockResolvedValue({ data: { idToken: 'id' } });
    mockExistingTitles([]);
    mockTasksResponse([{ id: '1', title: 'Buy groceries', status: 'needsAction' }]);

    const result = await importFromGoogleTasks('uid-1');
    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(result.imported).toBe(1);
  });

  it('does not call signIn when a Google session already exists (KAN-201)', async () => {
    mockAccessToken(); // getTokens resolves on the first call
    mockExistingTitles([]);
    mockTasksResponse([{ id: '1', title: 'Buy groceries', status: 'needsAction' }]);

    await importFromGoogleTasks('uid-1');
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('rethrows a non-cancellation sign-in error (KAN-201)', async () => {
    mockGetTokens.mockRejectedValue(new Error('no session'));
    mockHasPlay.mockResolvedValue(true);
    mockSignIn.mockRejectedValueOnce(new Error('PLAY_SERVICES_NOT_AVAILABLE'));
    mockGet.mockResolvedValue({ docs: [] });

    await expect(importFromGoogleTasks('uid-1')).rejects.toThrow('PLAY_SERVICES_NOT_AVAILABLE');
  });

  it('returns cancelled:1 when user cancels the Google sign-in prompt (KAN-94/201)', async () => {
    const cancelErr = Object.assign(new Error('cancelled'), { code: 'SIGN_IN_CANCELLED' });
    mockGetTokens.mockRejectedValue(new Error('no session'));
    mockHasPlay.mockResolvedValue(true);
    mockSignIn.mockRejectedValueOnce(cancelErr);
    mockGet.mockResolvedValue({ docs: [] });

    const result = await importFromGoogleTasks('uid-1');
    expect(result).toEqual({ imported: 0, skipped: 0, failed: 0, cancelled: 1 });
  });
});

// ─── importFromGoogleCalendar ─────────────────────────────────────────────────

describe('importFromGoogleCalendar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    docIdCounter = 0;
    mockBatchCommit.mockResolvedValue(undefined);
  });

  it('imports events and returns correct counts', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([
      { id: '1', summary: 'Team standup', start: { dateTime: '2026-06-05T09:00:00Z' } },
      { id: '2', summary: 'Dentist',      start: { dateTime: '2026-06-10T14:00:00Z' } },
    ]);

    const result = await importFromGoogleCalendar('uid-1');
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it('sets source to "google_calendar" on each written task', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([
      { id: '1', summary: 'Team standup', start: { dateTime: '2026-06-05T09:00:00Z' } },
    ]);

    await importFromGoogleCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.source).toBe('google_calendar');
    expect(setCall.category).toBe('work');
    expect(setCall.done).toBe(false);
  });

  it('skips events with no summary', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([
      { id: '1', start: { dateTime: '2026-06-05T09:00:00Z' } }, // no summary
    ]);

    const result = await importFromGoogleCalendar('uid-1');
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('skips events with no parseable start date', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([
      { id: '1', summary: 'Broken event', start: { dateTime: 'not-a-date' } },
    ]);

    const result = await importFromGoogleCalendar('uid-1');
    expect(result.skipped).toBe(1);
  });

  it('skips all-day events more than 30 days out', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    // far future all-day event (date only, no dateTime)
    mockCalendarResponse([
      { id: '1', summary: 'Far future event', start: { date: '2027-01-01' } },
    ]);

    const result = await importFromGoogleCalendar('uid-1');
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('imports timed events regardless of how far out they are', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([
      { id: '1', summary: 'Far future timed', start: { dateTime: '2027-01-01T09:00:00Z' } },
    ]);

    const result = await importFromGoogleCalendar('uid-1');
    expect(result.imported).toBe(1);
  });

  it('skips duplicate events', async () => {
    mockAccessToken();
    mockExistingTitles(['team standup']);
    mockCalendarResponse([
      { id: '1', summary: 'Team Standup', start: { dateTime: '2026-06-05T09:00:00Z' } },
    ]);

    const result = await importFromGoogleCalendar('uid-1');
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('uses start.date for all-day events within 30 days', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([
      { id: '1', summary: 'All-day soon', start: { date: '2026-06-20' } },
    ]);

    const result = await importFromGoogleCalendar('uid-1');
    expect(result.imported).toBe(1);
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.date).toBe('2026-06-20');
  });

  it('strips HTML from the event description and maps it to Task.description (KAN-95)', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([{
      id: '1', summary: 'Team standup',
      description: '<p>Agenda:<br>Discuss <b>roadmap</b> &amp; sprint</p>',
      start: { dateTime: '2026-06-05T09:00:00Z' },
    }]);

    await importFromGoogleCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.description).toBe('Agenda:\nDiscuss roadmap & sprint');
  });

  it('omits description when the event has none (KAN-95)', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([
      { id: '1', summary: 'Team standup', start: { dateTime: '2026-06-05T09:00:00Z' } },
    ]);

    await importFromGoogleCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect('description' in setCall).toBe(false);
  });

  it('omits description when the event description is empty markup (KAN-95)', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([{
      id: '1', summary: 'Team standup',
      description: '<br>   <p></p>',
      start: { dateTime: '2026-06-05T09:00:00Z' },
    }]);

    await importFromGoogleCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect('description' in setCall).toBe(false);
  });

  it('returns cancelled:1 when user cancels the Google sign-in prompt (KAN-94/201)', async () => {
    const cancelErr = Object.assign(new Error('cancelled'), { code: 'SIGN_IN_CANCELLED' });
    mockGetTokens.mockRejectedValue(new Error('no session'));
    mockHasPlay.mockResolvedValue(true);
    mockSignIn.mockRejectedValueOnce(cancelErr);
    mockGet.mockResolvedValue({ docs: [] });

    const result = await importFromGoogleCalendar('uid-1');
    expect(result).toEqual({ imported: 0, skipped: 0, failed: 0, cancelled: 1 });
  });

  // ─── Birthday detection (KAN-248) ─────────────────────────────────────────

  it('imports an eventType:"birthday" event as kind:birthday, category:personal, no poi', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([
      { id: '1', summary: 'Team standup', eventType: 'birthday', start: { date: '2026-06-20' } },
    ]);

    await importFromGoogleCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.kind).toBe('birthday');
    expect(setCall.category).toBe('personal');
    expect('poi' in setCall).toBe(false);
  });

  it('imports a title-matched birthday event as kind:birthday even when eventType is "default"', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([
      { id: '1', summary: 'Aniversário do João', eventType: 'default', start: { date: '2026-06-20' } },
    ]);

    await importFromGoogleCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.kind).toBe('birthday');
    expect(setCall.category).toBe('personal');
  });

  it('imports a description-matched birthday event as kind:birthday when the title has no match', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([{
      id: '1', summary: 'Dinner', description: 'Happy Birthday Maria!',
      start: { date: '2026-06-20' },
    }]);

    await importFromGoogleCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect(setCall.kind).toBe('birthday');
    expect(setCall.category).toBe('personal');
  });

  it('imports a non-birthday event as a normal task (no kind, category:work)', async () => {
    mockAccessToken();
    mockExistingTitles([]);
    mockCalendarResponse([
      { id: '1', summary: 'Team standup', start: { dateTime: '2026-06-05T09:00:00Z' } },
    ]);

    await importFromGoogleCalendar('uid-1');
    const setCall = mockBatchSet.mock.calls[0][1];
    expect('kind' in setCall).toBe(false);
    expect(setCall.category).toBe('work');
  });
});

// ─── OAuth scopes ─────────────────────────────────────────────────────────────

describe('auth.ts — Google OAuth scopes (KAN-84)', () => {
  it('configures GoogleSignin with tasks and calendar readonly scopes', () => {
    // Re-require auth.ts so GoogleSignin.configure runs with fresh mocks
    jest.resetModules();
    const mockConfigure = jest.fn();
    jest.doMock('@react-native-google-signin/google-signin', () => ({
      GoogleSignin: { configure: mockConfigure },
    }));
    jest.doMock('@react-native-firebase/auth', () => ({}));
    jest.doMock('@react-native-firebase/auth/lib/modular', () => ({
      getAuth: jest.fn(),
      signInWithEmailAndPassword: jest.fn(),
      createUserWithEmailAndPassword: jest.fn(),
      signOut: jest.fn(),
      GoogleAuthProvider: { credential: jest.fn() },
      OAuthProvider: jest.fn(),
      signInWithCredential: jest.fn(),
    }));
    jest.doMock('@invertase/react-native-apple-authentication', () => ({
      appleAuth: { performRequest: jest.fn(), Operation: {}, Scope: {} },
    }));

    require('../../src/services/auth');

    expect(mockConfigure).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: expect.arrayContaining([
          'https://www.googleapis.com/auth/tasks.readonly',
          'https://www.googleapis.com/auth/calendar.readonly',
        ]),
      }),
    );
  });
});
