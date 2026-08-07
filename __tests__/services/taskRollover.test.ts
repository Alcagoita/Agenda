/**
 * KAN-146 — client-side rolloverIncompleteTasks tests.
 *
 * Tasks persist until brushed away — there is no end-of-day cleanup. Any
 * task still undone when a new day starts is rolled forward: `date` and
 * `createdAt` bump to today, so it's treated as a brand-new task for the
 * new day (matches today's Today list and scores against today's ring).
 */

const mockGetDocs     = jest.fn();
const mockBatchUpdate = jest.fn();
const mockBatchDelete = jest.fn();
const mockBatchCommit = jest.fn().mockResolvedValue(undefined);
const mockWhere       = jest.fn((...a: unknown[]) => a);
const mockQuery       = jest.fn((...a: unknown[]) => a);

const NOW_TIMESTAMP = { _isNow: true };

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore:    jest.fn(),
  collection:      jest.fn(() => ({ _type: 'collection' })),
  doc:             jest.fn(() => ({ _type: 'doc' })),
  addDoc:          jest.fn(),
  getDoc:          jest.fn(),
  getDocs:         (...args: unknown[]) => mockGetDocs(...args),
  updateDoc:       jest.fn(),
  deleteDoc:       jest.fn(),
  setDoc:          jest.fn(),
  writeBatch:      jest.fn(() => ({ update: mockBatchUpdate, delete: mockBatchDelete, commit: mockBatchCommit })),
  query:           (...args: unknown[]) => mockQuery(...args),
  where:           (...args: unknown[]) => mockWhere(...args),
  orderBy:         jest.fn(),
  onSnapshot:      jest.fn(),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
  increment:       jest.fn(),
  Timestamp:       { now: jest.fn(() => NOW_TIMESTAMP) },
  runTransaction:  jest.fn(),
}));

/** Non-birthday doc fixture — data() must exist since rolloverIncompleteTasks reads d.data().kind (KAN-248). */
function makeDoc(id: string, data: Record<string, unknown> = {}) {
  return { id, ref: { id }, data: () => data };
}

import { ensureCurrentDay, rolloverIncompleteTasks } from '../../src/services/firestore';

describe('rolloverIncompleteTasks', () => {
  const TODAY = '2026-06-16';

  beforeEach(() => {
    jest.clearAllMocks();
    mockBatchCommit.mockResolvedValue(undefined);
  });

  it('queries done == false and date < today', async () => {
    mockGetDocs.mockResolvedValue({ empty: true, docs: [] });

    await rolloverIncompleteTasks('uid-1', TODAY);

    expect(mockWhere).toHaveBeenCalledWith('done', '==', false);
    expect(mockWhere).toHaveBeenCalledWith('date', '<', TODAY);
  });

  it('does nothing when there are no stale undone tasks', async () => {
    mockGetDocs.mockResolvedValue({ empty: true, docs: [] });

    await rolloverIncompleteTasks('uid-1', TODAY);

    expect(mockBatchUpdate).not.toHaveBeenCalled();
    expect(mockBatchCommit).not.toHaveBeenCalled();
  });

  it('bumps date and createdAt to today for every stale task, then commits once', async () => {
    const docs = [makeDoc('t1'), makeDoc('t2')];
    mockGetDocs.mockResolvedValue({ empty: false, docs });

    await rolloverIncompleteTasks('uid-1', TODAY);

    expect(mockBatchUpdate).toHaveBeenCalledTimes(2);
    expect(mockBatchUpdate).toHaveBeenCalledWith(
      docs[0].ref,
      { date: TODAY, createdAt: NOW_TIMESTAMP },
    );
    expect(mockBatchUpdate).toHaveBeenCalledWith(
      docs[1].ref,
      { date: TODAY, createdAt: NOW_TIMESTAMP },
    );
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);
  });

  it('splits writes into multiple batches when over the 500 limit', async () => {
    const docs = Array.from({ length: 501 }, (_, i) => makeDoc(`t${i}`));
    mockGetDocs.mockResolvedValue({ empty: false, docs });

    await rolloverIncompleteTasks('uid-1', TODAY);

    expect(mockBatchUpdate).toHaveBeenCalledTimes(501);
    expect(mockBatchCommit).toHaveBeenCalledTimes(2); // 500 + 1
  });

  // ─── Birthday auto-expiry (KAN-248) ───────────────────────────────────────

  it('deletes an unbrushed birthday task instead of rolling it forward', async () => {
    const docs = [makeDoc('t1', { kind: 'birthday' })];
    mockGetDocs.mockResolvedValue({ empty: false, docs });

    await rolloverIncompleteTasks('uid-1', TODAY);

    expect(mockBatchDelete).toHaveBeenCalledWith(docs[0].ref);
    expect(mockBatchUpdate).not.toHaveBeenCalled();
  });

  it('rolls forward a non-birthday task while deleting a birthday task in the same batch', async () => {
    const docs = [makeDoc('t1'), makeDoc('t2', { kind: 'birthday' })];
    mockGetDocs.mockResolvedValue({ empty: false, docs });

    await rolloverIncompleteTasks('uid-1', TODAY);

    expect(mockBatchUpdate).toHaveBeenCalledWith(docs[0].ref, { date: TODAY, createdAt: NOW_TIMESTAMP });
    expect(mockBatchDelete).toHaveBeenCalledWith(docs[1].ref);
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);
  });

  // ─── originDate stamping (KAN-264) ────────────────────────────────────────

  it('stamps originDate with the task\'s current date the first time it rolls', async () => {
    const docs = [makeDoc('t1', { date: '2026-06-10' })];
    mockGetDocs.mockResolvedValue({ empty: false, docs });

    await rolloverIncompleteTasks('uid-1', TODAY);

    expect(mockBatchUpdate).toHaveBeenCalledWith(
      docs[0].ref,
      { date: TODAY, createdAt: NOW_TIMESTAMP, originDate: '2026-06-10' },
    );
  });

  it('never overwrites an existing originDate on a second (or later) roll', async () => {
    const docs = [makeDoc('t1', { date: '2026-06-12', originDate: '2026-06-10' })];
    mockGetDocs.mockResolvedValue({ empty: false, docs });

    await rolloverIncompleteTasks('uid-1', TODAY);

    expect(mockBatchUpdate).toHaveBeenCalledWith(
      docs[0].ref,
      { date: TODAY, createdAt: NOW_TIMESTAMP, originDate: '2026-06-10' },
    );
  });

  it('defaults `today` to the device-local date when not passed', async () => {
    mockGetDocs.mockResolvedValue({ empty: true, docs: [] });

    await rolloverIncompleteTasks('uid-1');

    // Whatever todayISO() resolves to right now must appear in the where clause.
    const dateArgs = mockWhere.mock.calls.find(call => call[0] === 'date');
    expect(dateArgs).toBeDefined();
    expect(typeof dateArgs?.[2]).toBe('string');
    expect(dateArgs?.[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('ensureCurrentDay', () => {
  const TODAY = '2026-06-16';

  beforeEach(() => {
    jest.clearAllMocks();
    mockBatchCommit.mockResolvedValue(undefined);
  });

  it('returns stale unfinished tasks as today before their write is confirmed', async () => {
    const stale = makeDoc('stale-1', {
      title: 'Buy milk', category: 'errands', done: false,
      date: '2026-06-14', createdAt: { toMillis: () => 1 },
    });
    mockGetDocs
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ empty: false, docs: [stale] });
    let finishCommit: (() => void) | undefined;
    mockBatchCommit.mockImplementation(() => new Promise<void>(resolve => { finishCommit = resolve; }));

    const result = await ensureCurrentDay('uid-1', TODAY);

    expect(result.tasks).toEqual([expect.objectContaining({
      id: 'stale-1', date: TODAY, originDate: '2026-06-14',
    })]);
    expect(mockBatchUpdate).toHaveBeenCalledWith(stale.ref, expect.objectContaining({ date: TODAY }));

    finishCommit?.();
    await expect(result.persistence).resolves.toBeUndefined();
  });

  it('excludes expired birthday tasks from the immediate Today list', async () => {
    const birthday = makeDoc('birthday-1', {
      title: 'Happy birthday', category: 'personal', done: false,
      kind: 'birthday', date: '2026-06-14', createdAt: { toMillis: () => 1 },
    });
    mockGetDocs
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ empty: false, docs: [birthday] });

    const result = await ensureCurrentDay('uid-1', TODAY);

    expect(result.tasks).toEqual([]);
    expect(mockBatchDelete).toHaveBeenCalledWith(birthday.ref);
    await expect(result.persistence).resolves.toBeUndefined();
  });
});
