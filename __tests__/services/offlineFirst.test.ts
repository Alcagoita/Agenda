/**
 * KAN-198 — Offline-first architecture tests.
 *
 * Verifies:
 *   1. addTask uses Timestamp.now() (not serverTimestamp) for createdAt
 *   2. setTaskDone uses Timestamp.now() (not serverTimestamp) for completedAt
 *   3. rolloverIncompleteTasks uses Timestamp.now() for createdAt
 */

// ─── Firestore mocks ─────────────────────────────────────────────────────────

const mockAddDoc      = jest.fn();
const mockGetDocs     = jest.fn();
const mockBatchUpdate = jest.fn();
const mockBatchCommit = jest.fn().mockResolvedValue(undefined);
const mockWhere       = jest.fn((...a: unknown[]) => a);
const mockQuery       = jest.fn((...a: unknown[]) => a);

// setTaskDone (KAN-240) reads/writes through a transaction rather than a bare
// updateDoc — this stub has tx.get() report "no prior place" (task doc has no
// completedPlaceId) so the tests below only need to inspect the task doc write.
const mockTxUpdate = jest.fn();
const mockRunTransaction = jest.fn(async (_db: unknown, cb: (tx: unknown) => Promise<void>) => {
  const tx = {
    get: jest.fn().mockResolvedValue({ exists: () => false, data: () => undefined }),
    update: (...args: unknown[]) => mockTxUpdate(...args),
    set: jest.fn(),
    delete: jest.fn(),
  };
  return cb(tx);
});

const NOW_TIMESTAMP = { seconds: 1_700_000_000, nanoseconds: 0, _isNow: true };

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore:    jest.fn(),
  collection:      jest.fn(() => ({ _type: 'collection' })),
  doc:             jest.fn(() => ({ _type: 'doc' })),
  addDoc:          (...args: unknown[]) => mockAddDoc(...args),
  getDoc:          jest.fn(),
  getDocs:         (...args: unknown[]) => mockGetDocs(...args),
  updateDoc:       jest.fn(),
  deleteDoc:       jest.fn(),
  deleteField:     jest.fn(() => ({ _delete: true })),
  setDoc:          jest.fn(),
  writeBatch:      jest.fn(() => ({ update: mockBatchUpdate, commit: mockBatchCommit })),
  query:           (...args: unknown[]) => mockQuery(...args),
  where:           (...args: unknown[]) => mockWhere(...args),
  orderBy:         jest.fn(),
  onSnapshot:      jest.fn(),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
  increment:       jest.fn(),
  Timestamp:       { now: jest.fn(() => NOW_TIMESTAMP) },
  runTransaction:  (...args: [unknown, (tx: unknown) => Promise<void>]) => mockRunTransaction(...args),
}));

jest.mock('../../src/services/poiInference', () => ({
  registerLearnedKeyword:   jest.fn(),
  normalize:                jest.fn((s: string) => s),
}));

jest.mock('../../src/utils/date', () => ({
  getCurrentWeekBoundaries: jest.fn(),
  todayISO: jest.fn(() => '2026-06-26'),
}));

import { addTask, setTaskDone, rolloverIncompleteTasks } from '../../src/services/firestore';

const TODAY = '2026-06-26';

// ─── addTask ─────────────────────────────────────────────────────────────────

describe('addTask — offline-first timestamps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAddDoc.mockResolvedValue({ id: 'new-task-id' });
  });

  it('uses Timestamp.now() for createdAt, not serverTimestamp()', async () => {
    await addTask('uid-1', {
      title: 'Buy milk',
      category: 'errands',
      done: false,
      date: TODAY,
    });

    expect(mockAddDoc).toHaveBeenCalledTimes(1);
    const payload = mockAddDoc.mock.calls[0][1];
    expect(payload.createdAt).toBe(NOW_TIMESTAMP);
    expect(payload.createdAt).not.toEqual({ _serverTimestamp: true });
  });

  it('returns the new document ID', async () => {
    mockAddDoc.mockResolvedValue({ id: 'abc123' });
    const id = await addTask('uid-1', {
      title: 'Test task',
      category: 'work',
      done: false,
      date: TODAY,
    });
    expect(id).toBe('abc123');
  });
});

// ─── setTaskDone ─────────────────────────────────────────────────────────────

describe('setTaskDone — offline-first timestamps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses Timestamp.now() for completedAt when marking done', async () => {
    await setTaskDone('uid-1', 'task-1', true);

    expect(mockTxUpdate).toHaveBeenCalledTimes(1);
    const payload = mockTxUpdate.mock.calls[0][1];
    expect(payload.done).toBe(true);
    expect(payload.completedAt).toBe(NOW_TIMESTAMP);
    expect(payload.completedAt).not.toEqual({ _serverTimestamp: true });
  });

  it('sets completedAt to null when marking undone', async () => {
    await setTaskDone('uid-1', 'task-1', false);

    const payload = mockTxUpdate.mock.calls[0][1];
    expect(payload.done).toBe(false);
    expect(payload.completedAt).toBeNull();
  });
});

// ─── rolloverIncompleteTasks ─────────────────────────────────────────────────

describe('rolloverIncompleteTasks — offline-first timestamps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBatchCommit.mockResolvedValue(undefined);
  });

  it('uses Timestamp.now() for createdAt in batch updates', async () => {
    const docs = [{ ref: { id: 't1' }, data: () => ({}) }, { ref: { id: 't2' }, data: () => ({}) }];
    mockGetDocs.mockResolvedValue({ empty: false, docs });

    await rolloverIncompleteTasks('uid-1', TODAY);

    expect(mockBatchUpdate).toHaveBeenCalledTimes(2);
    const payload = mockBatchUpdate.mock.calls[0][1];
    expect(payload.createdAt).toBe(NOW_TIMESTAMP);
    expect(payload.createdAt).not.toEqual({ _serverTimestamp: true });
    expect(payload.date).toBe(TODAY);
  });

  it('does nothing when no stale tasks', async () => {
    mockGetDocs.mockResolvedValue({ empty: true, docs: [] });

    await rolloverIncompleteTasks('uid-1', TODAY);

    expect(mockBatchUpdate).not.toHaveBeenCalled();
    expect(mockBatchCommit).not.toHaveBeenCalled();
  });
});
