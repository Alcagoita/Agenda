/**
 * KAN-226 / KAN-240 — setTaskDone persists completedPlaceId/completedPlaceName/
 * completedPoiType as a snapshot of the *current* completion (not sticky
 * history): they're written on a `done: true` call with a matching place,
 * and deleted from the doc in every other case (done: false, or done: true
 * with no matching place) so a later re-completion without a place can
 * never resurrect stale metadata from a previous brush.
 *
 * KAN-240: this now runs inside a transaction that also keeps
 * `/users/{uid}/learnedPlaceCounts/{placeId}` in lockstep — decrementing the
 * venue the task previously counted toward (if any) and incrementing the one
 * it counts toward now. A fake Firestore transaction below tracks a small
 * path -> data store so sequential calls (e.g. brush -> undo -> re-brush)
 * observe each other's writes, the way real Firestore transactions would.
 */

const NOW_TIMESTAMP = { _isNow: true };
const DELETE_FIELD_SENTINEL = { _delete: true };

let mockStore: Record<string, Record<string, unknown> | undefined>;
const mockTxGet    = jest.fn();
const mockTxUpdate = jest.fn();
const mockTxSet    = jest.fn();
const mockTxDelete = jest.fn();
const mockUpdateDoc = jest.fn();
const mockBatchUpdate = jest.fn();
const mockBatchSet = jest.fn();
const mockBatchDelete = jest.fn();
const mockBatchCommit = jest.fn();

function mockApplyFieldUpdate(path: string, data: Record<string, unknown>) {
  const current = { ...(mockStore[path] ?? {}) };
  for (const [key, value] of Object.entries(data)) {
    if (value === DELETE_FIELD_SENTINEL) { delete current[key]; } else { current[key] = value; }
  }
  mockStore[path] = current;
}

const mockRunTransaction = jest.fn(async (_db: unknown, cb: (tx: unknown) => Promise<void>) => {
  const tx = {
    get: (ref: { path: string }) => {
      mockTxGet(ref.path);
      const data = mockStore[ref.path];
      return Promise.resolve({ exists: () => data !== undefined, data: () => data });
    },
    update: (ref: { path: string }, data: Record<string, unknown>) => {
      mockTxUpdate(ref.path, data);
      mockApplyFieldUpdate(ref.path, data);
    },
    set: (ref: { path: string }, data: Record<string, unknown>) => {
      mockTxSet(ref.path, data);
      mockStore[ref.path] = data;
    },
    delete: (ref: { path: string }) => {
      mockTxDelete(ref.path);
      delete mockStore[ref.path];
    },
  };
  return cb(tx);
});

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore:    jest.fn(() => ({ _type: 'db' })),
  collection:      jest.fn(),
  doc:             jest.fn((...args: unknown[]) => ({ _type: 'doc', path: args.slice(1).join('/') })),
  addDoc:          jest.fn(),
  getDoc:          jest.fn((ref: { path: string }) => {
    const data = mockStore[ref.path];
    return Promise.resolve({ exists: () => data !== undefined, data: () => data });
  }),
  getDocs:         jest.fn(),
  updateDoc:       (...args: unknown[]) => mockUpdateDoc(...args),
  deleteDoc:       jest.fn(),
  deleteField:     jest.fn(() => DELETE_FIELD_SENTINEL),
  setDoc:          jest.fn(),
  writeBatch:      jest.fn(() => {
    const ops: Array<() => void> = [];
    return {
      update: (ref: { path: string }, data: Record<string, unknown>) => {
        mockBatchUpdate(ref.path, data);
        ops.push(() => mockApplyFieldUpdate(ref.path, data));
      },
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        mockBatchSet(ref.path, data);
        ops.push(() => { mockStore[ref.path] = data; });
      },
      delete: (ref: { path: string }) => {
        mockBatchDelete(ref.path);
        ops.push(() => { delete mockStore[ref.path]; });
      },
      commit: () => {
        ops.forEach(op => op());
        mockBatchCommit();
        return Promise.resolve();
      },
    };
  }),
  query:           jest.fn(),
  where:           jest.fn(),
  orderBy:         jest.fn(),
  onSnapshot:      jest.fn(),
  serverTimestamp: jest.fn(),
  increment:       jest.fn(),
  Timestamp:       { now: jest.fn(() => NOW_TIMESTAMP) },
  runTransaction:  (...args: [unknown, (tx: unknown) => Promise<void>]) => mockRunTransaction(...args),
}));

import { setTaskDone } from '../../../src/services/firestore';

const TASK_PATH    = 'users/uid-1/tasks/task-1';
const COUNTER_PATH = (placeId: string) => `users/uid-1/learnedPlaceCounts/${placeId}`;

describe('setTaskDone', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStore = {};
  });

  it('marks done and deletes completedPlace* fields when completedPlace is omitted', async () => {
    mockStore[TASK_PATH] = {};

    await setTaskDone('uid-1', 'task-1', true);

    expect(mockTxUpdate).toHaveBeenCalledWith(TASK_PATH, {
      done: true,
      completedAt: NOW_TIMESTAMP,
      completedPlaceId: DELETE_FIELD_SENTINEL,
      completedPlaceName: DELETE_FIELD_SENTINEL,
      completedPoiType: DELETE_FIELD_SENTINEL,
      completedTripId: DELETE_FIELD_SENTINEL,
    });
    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockTxDelete).not.toHaveBeenCalled();
  });

  it('persists completedPlaceId/Name/PoiType and creates a new counter doc at visitCount 1', async () => {
    mockStore[TASK_PATH] = {};

    await setTaskDone('uid-1', 'task-1', true, {
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
    });

    expect(mockTxUpdate).toHaveBeenCalledWith(TASK_PATH, {
      done: true,
      completedAt: NOW_TIMESTAMP,
      completedPlaceId: 'place-abc',
      completedPlaceName: 'Whole Foods',
      completedPoiType: 'supermarket',
      completedTripId: DELETE_FIELD_SENTINEL,
    });
    expect(mockTxSet).toHaveBeenCalledWith(COUNTER_PATH('place-abc'), {
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
      visitCount: 1,
    });
  });

  it('increments an existing counter doc rather than overwriting the visit history', async () => {
    mockStore[TASK_PATH] = {};
    mockStore[COUNTER_PATH('place-abc')] = { placeId: 'place-abc', name: 'Whole Foods', poiType: 'supermarket', visitCount: 2 };

    await setTaskDone('uid-1', 'task-1', true, {
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
    });

    expect(mockTxSet).toHaveBeenCalledWith(COUNTER_PATH('place-abc'), {
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
      visitCount: 3,
    });
  });

  it('deletes completedPlace* fields when marking a task undone, even if a place is passed', async () => {
    mockStore[TASK_PATH] = {};

    await setTaskDone('uid-1', 'task-1', false, {
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
    });

    expect(mockTxUpdate).toHaveBeenCalledWith(TASK_PATH, {
      done: false,
      completedAt: null,
      completedPlaceId: DELETE_FIELD_SENTINEL,
      completedPlaceName: DELETE_FIELD_SENTINEL,
      completedPoiType: DELETE_FIELD_SENTINEL,
      completedTripId: DELETE_FIELD_SENTINEL,
    });
    // No prior completedPlaceId on the task doc — nothing to decrement.
    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockTxDelete).not.toHaveBeenCalled();
  });

  it('decrements and deletes the counter when undoing the only visit to a place', async () => {
    mockStore[TASK_PATH] = { completedPlaceId: 'place-abc', completedPlaceName: 'Whole Foods', completedPoiType: 'supermarket' };
    mockStore[COUNTER_PATH('place-abc')] = { placeId: 'place-abc', name: 'Whole Foods', poiType: 'supermarket', visitCount: 1 };

    await setTaskDone('uid-1', 'task-1', false);

    expect(mockTxDelete).toHaveBeenCalledWith(COUNTER_PATH('place-abc'));
  });

  it('decrements without deleting the counter when other visits remain', async () => {
    mockStore[TASK_PATH] = { completedPlaceId: 'place-abc', completedPlaceName: 'Whole Foods', completedPoiType: 'supermarket' };
    mockStore[COUNTER_PATH('place-abc')] = { placeId: 'place-abc', name: 'Whole Foods', poiType: 'supermarket', visitCount: 3 };

    await setTaskDone('uid-1', 'task-1', false);

    expect(mockTxUpdate).toHaveBeenCalledWith(COUNTER_PATH('place-abc'), { visitCount: 2 });
    expect(mockTxDelete).not.toHaveBeenCalled();
  });

  it('undoing at a place whose counter doc is missing (corrupted/partial data) still updates the task and touches no counter', async () => {
    // The task doc claims a prior completedPlaceId, but no counter doc exists
    // for it — e.g. partial migration, manual deletion, or corruption.
    mockStore[TASK_PATH] = { completedPlaceId: 'place-abc', completedPlaceName: 'Whole Foods', completedPoiType: 'supermarket' };

    await setTaskDone('uid-1', 'task-1', false);

    expect(mockTxUpdate).toHaveBeenCalledWith(TASK_PATH, {
      done: false,
      completedAt: null,
      completedPlaceId: DELETE_FIELD_SENTINEL,
      completedPlaceName: DELETE_FIELD_SENTINEL,
      completedPoiType: DELETE_FIELD_SENTINEL,
      completedTripId: DELETE_FIELD_SENTINEL,
    });
    expect(mockTxUpdate).toHaveBeenCalledTimes(1); // task doc only — no counter update
    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockTxDelete).not.toHaveBeenCalled();
  });

  it('treats a corrupted (non-numeric) stored visitCount as 0 rather than propagating NaN', async () => {
    mockStore[TASK_PATH] = { completedPlaceId: 'place-abc', completedPlaceName: 'Whole Foods', completedPoiType: 'supermarket' };
    mockStore[COUNTER_PATH('place-abc')] = { placeId: 'place-abc', name: 'Whole Foods', poiType: 'supermarket', visitCount: 'not-a-number' };

    await setTaskDone('uid-1', 'task-1', false);

    // 0 - 1 <= 0, so the corrupted counter is deleted rather than written as NaN.
    expect(mockTxDelete).toHaveBeenCalledWith(COUNTER_PATH('place-abc'));
    expect(mockTxUpdate.mock.calls.every(([path]) => path !== COUNTER_PATH('place-abc'))).toBe(true);
  });

  it('treats a missing visitCount on increment as 0 rather than propagating NaN', async () => {
    mockStore[TASK_PATH] = {};
    mockStore[COUNTER_PATH('place-abc')] = { placeId: 'place-abc', name: 'Whole Foods', poiType: 'supermarket' };

    await setTaskDone('uid-1', 'task-1', true, {
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
    });

    expect(mockTxSet).toHaveBeenCalledWith(COUNTER_PATH('place-abc'), {
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
      visitCount: 1,
    });
  });

  it('does not touch any counter when re-brushing at the same place (net-zero change)', async () => {
    mockStore[TASK_PATH] = { completedPlaceId: 'place-abc', completedPlaceName: 'Whole Foods', completedPoiType: 'supermarket' };
    mockStore[COUNTER_PATH('place-abc')] = { placeId: 'place-abc', name: 'Whole Foods', poiType: 'supermarket', visitCount: 2 };

    await setTaskDone('uid-1', 'task-1', true, {
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
    });

    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockTxUpdate).toHaveBeenCalledTimes(1); // task doc only
    expect(mockTxDelete).not.toHaveBeenCalled();
  });

  it('done(with place) -> undone -> done(without place) leaves no completedPlace* and no dangling counter', async () => {
    mockStore[TASK_PATH] = {};

    await setTaskDone('uid-1', 'task-1', true, {
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
    });
    await setTaskDone('uid-1', 'task-1', false);
    await setTaskDone('uid-1', 'task-1', true);

    expect(mockStore[TASK_PATH]).toEqual({ done: true, completedAt: NOW_TIMESTAMP });
    expect(mockStore[COUNTER_PATH('place-abc')]).toBeUndefined();
  });

  it('falls back to an offline batch update when the transaction cannot run offline', async () => {
    mockRunTransaction.mockRejectedValueOnce({ code: 'firestore/unavailable' });
    mockStore[TASK_PATH] = {};

    await setTaskDone('uid-1', 'task-1', true, {
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
    });

    expect(mockBatchUpdate).toHaveBeenCalledWith(TASK_PATH, {
      done: true,
      completedAt: NOW_TIMESTAMP,
      completedPlaceId: 'place-abc',
      completedPlaceName: 'Whole Foods',
      completedPoiType: 'supermarket',
      completedTripId: DELETE_FIELD_SENTINEL,
    });
    expect(mockBatchSet).toHaveBeenCalledWith(COUNTER_PATH('place-abc'), {
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
      visitCount: 1,
    });
    expect(mockBatchCommit).toHaveBeenCalled();
    expect(mockStore[COUNTER_PATH('place-abc')]).toEqual({
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
      visitCount: 1,
    });
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it('rethrows non-offline transaction failures instead of silently drifting counters', async () => {
    const error = new Error('permission denied');
    mockRunTransaction.mockRejectedValueOnce(error);

    await expect(setTaskDone('uid-1', 'task-1', true, {
      placeId: 'place-abc',
      name: 'Whole Foods',
      poiType: 'supermarket',
    })).rejects.toBe(error);

    expect(mockBatchCommit).not.toHaveBeenCalled();
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });
});
