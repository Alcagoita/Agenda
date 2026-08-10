/** KAN-363 — active tasks are filtered, never rolled or deleted by time. */

const mockGetDocs = jest.fn();
const mockUpdateDoc = jest.fn().mockResolvedValue(undefined);
const mockWhere = jest.fn((...args: unknown[]) => args);
const mockQuery = jest.fn((...args: unknown[]) => args);

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(),
  collection: jest.fn(() => ({ _type: 'collection' })),
  doc: jest.fn(() => ({ _type: 'doc' })),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  getDoc: jest.fn(),
  addDoc: jest.fn(),
  updateDoc: (...args: unknown[]) => mockUpdateDoc(...args),
  deleteDoc: jest.fn(),
  deleteField: jest.fn(),
  setDoc: jest.fn(),
  writeBatch: jest.fn(),
  query: (...args: unknown[]) => mockQuery(...args),
  where: (...args: unknown[]) => mockWhere(...args),
  orderBy: jest.fn(),
  Timestamp: { now: jest.fn(() => ({ _isNow: true })) },
  runTransaction: jest.fn(),
}));

import { ensureCurrentDay, resolveDatedTaskHandoff, rolloverIncompleteTasks } from '../../src/services/firestore';

function doc(id: string, data: Record<string, unknown>) {
  return { id, data: () => data };
}

describe('KAN-363 active-list date behavior', () => {
  const TODAY = '2026-06-16';

  beforeEach(() => jest.clearAllMocks());

  it('keeps a legacy task active even when its old required date has passed', async () => {
    mockGetDocs.mockResolvedValue({ docs: [doc('legacy', {
      title: 'Buy milk', category: 'errands', done: false,
      date: '2026-06-01', createdAt: { toMillis: () => 1 },
    })] });

    const result = await ensureCurrentDay('uid-1', TODAY);

    expect(result.tasks.map(task => task.id)).toEqual(['legacy']);
    await expect(result.persistence).resolves.toBeUndefined();
  });

  it('shows a task on its selected day and hides it only after that day passes', async () => {
    mockGetDocs.mockResolvedValue({ docs: [
      doc('today', { title: 'Today', category: 'errands', done: false, scheduledDate: TODAY, createdAt: { toMillis: () => 1 } }),
      doc('future', { title: 'Future', category: 'errands', done: false, scheduledDate: '2026-06-17', createdAt: { toMillis: () => 2 } }),
      doc('past', { title: 'Past', category: 'errands', done: false, scheduledDate: '2026-06-15', createdAt: { toMillis: () => 3 } }),
    ] });

    const result = await ensureCurrentDay('uid-1', TODAY);

    expect(result.tasks.map(task => task.id)).toEqual(['today', 'future']);
    expect(mockWhere).toHaveBeenCalledWith('done', '==', false);
  });

  it('does not delete a task merely because time passed, including birthdays', async () => {
    mockGetDocs.mockResolvedValue({ docs: [doc('birthday', {
      title: 'Happy birthday', category: 'personal', done: false,
      kind: 'birthday', scheduledDate: '2026-06-15', createdAt: { toMillis: () => 1 },
    })] });

    const result = await ensureCurrentDay('uid-1', TODAY);

    expect(result.tasks).toEqual([]);
    await expect(result.persistence).resolves.toBeUndefined();
  });

  it('keeps the retired rollover export as a no-op for legacy callers', async () => {
    await rolloverIncompleteTasks('uid-1', TODAY);
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('uses a normal queued write for an end-of-day action instead of a transaction', async () => {
    await resolveDatedTaskHandoff('uid-1', 'task-1', TODAY, 'tomorrow', '2026-06-17', TODAY);

    expect(mockUpdateDoc).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scheduledDate: '2026-06-17',
        originalScheduledDate: TODAY,
        dateHandoff: expect.objectContaining({ date: TODAY, outcome: 'tomorrow' }),
      }),
    );
  });
});
