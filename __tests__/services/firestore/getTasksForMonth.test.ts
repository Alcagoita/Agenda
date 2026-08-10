/**
 * KAN-363 — Calendar compatibility includes the new scheduledDate plus the
 * two retained legacy date fields without rewriting existing documents.
 */

const mockGetDocs = jest.fn();
const mockWhere   = jest.fn((...a: unknown[]) => a);
const mockQuery   = jest.fn((...a: unknown[]) => a);

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(),
  collection:   jest.fn(() => ({ _type: 'collection' })),
  doc:          jest.fn(() => ({ _type: 'doc' })),
  getDocs:      (...args: unknown[]) => mockGetDocs(...args),
  query:        (...args: unknown[]) => mockQuery(...args),
  where:        (...args: unknown[]) => mockWhere(...args),
  orderBy:      jest.fn(),
  Timestamp:    { now: jest.fn() },
}));

function makeSnap(docs: { id: string; data: Record<string, unknown> }[]) {
  return { docs: docs.map(d => ({ id: d.id, data: () => d.data })) };
}

import { getTasksForMonth } from '../../../src/services/firestore';

describe('getTasksForMonth', () => {
  const YM = '2026-06';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queries scheduledDate plus the two legacy date ranges for the month', async () => {
    mockGetDocs.mockResolvedValue(makeSnap([]));

    await getTasksForMonth('uid-1', YM);

    expect(mockWhere).toHaveBeenCalledWith('scheduledDate', '>=', '2026-06-01');
    expect(mockWhere).toHaveBeenCalledWith('scheduledDate', '<', '2026-07-01');
    expect(mockWhere).toHaveBeenCalledWith('date', '>=', '2026-06-01');
    expect(mockWhere).toHaveBeenCalledWith('date', '<', '2026-07-01');
    expect(mockWhere).toHaveBeenCalledWith('originDate', '>=', '2026-06-01');
    expect(mockWhere).toHaveBeenCalledWith('originDate', '<', '2026-07-01');
  });

  it('includes a task whose date fell in the month but originDate did not (never rolled)', async () => {
    mockGetDocs
      .mockResolvedValueOnce(makeSnap([]))
      .mockResolvedValueOnce(makeSnap([{ id: 't1', data: { title: 'June task', date: '2026-06-10' } }]))
      .mockResolvedValueOnce(makeSnap([]));

    const tasks = await getTasksForMonth('uid-1', YM);
    expect(tasks.map(t => t.id)).toEqual(['t1']);
  });

  it('includes a task that rolled out of the month — date now in July, originDate still in June', async () => {
    mockGetDocs
      .mockResolvedValueOnce(makeSnap([])) // scheduled date range
      .mockResolvedValueOnce(makeSnap([])) // legacy date range: nothing in June anymore
      .mockResolvedValueOnce(makeSnap([{ id: 't2', data: { title: 'Rolled out', date: '2026-07-02', originDate: '2026-06-30' } }]));

    const tasks = await getTasksForMonth('uid-1', YM);
    expect(tasks.map(t => t.id)).toEqual(['t2']);
  });

  it('deduplicates a task matched by both queries (rolled within the same month)', async () => {
    const doc = { id: 't3', data: { title: 'Rolled within June', date: '2026-06-15', originDate: '2026-06-10' } };
    mockGetDocs
      .mockResolvedValueOnce(makeSnap([]))
      .mockResolvedValueOnce(makeSnap([doc]))
      .mockResolvedValueOnce(makeSnap([doc]));

    const tasks = await getTasksForMonth('uid-1', YM);
    expect(tasks.map(t => t.id)).toEqual(['t3']);
  });

  it('includes a newly scheduled task even though it has no legacy date', async () => {
    mockGetDocs
      .mockResolvedValueOnce(makeSnap([{ id: 't4', data: { title: 'Scheduled', scheduledDate: '2026-06-12' } }]))
      .mockResolvedValueOnce(makeSnap([]))
      .mockResolvedValueOnce(makeSnap([]));

    const tasks = await getTasksForMonth('uid-1', YM);
    expect(tasks.map(t => t.id)).toEqual(['t4']);
  });
});
