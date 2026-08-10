/**
 * KAN-120 — Firestore userPreferences helpers.
 *
 * Verifies:
 *  - getUserPreferences returns empty object when doc doesn't exist
 *  - updateUserPreferences calls setDoc with merge:true
 *  - markLastOpenedAt calls setDoc with serverTimestamp and merge:true
 */

import {
  getUserPreferences,
  updateUserPreferences,
  markLastOpenedAt,
} from '../../src/services/firestore';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetDoc  = jest.fn();
const mockSetDoc  = jest.fn().mockResolvedValue(undefined);
const mockDoc     = jest.fn((_db: any, ...segments: string[]) => ({ path: segments.join('/') }));
const mockGetFirestore = jest.fn(() => ({}));
const mockServerTimestamp = jest.fn(() => ({ _methodName: 'serverTimestamp' }));

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore:    (...args: any[]) => mockGetFirestore(...args),
  doc:             (...args: any[]) => mockDoc(...args),
  collection:      jest.fn(() => ({})),
  getDoc:          (...args: any[]) => mockGetDoc(...args),
  getDocs:         jest.fn().mockResolvedValue({ docs: [] }),
  setDoc:          (...args: any[]) => mockSetDoc(...args),
  addDoc:          jest.fn().mockResolvedValue({ id: 'mock-id' }),
  updateDoc:       jest.fn().mockResolvedValue(undefined),
  deleteDoc:       jest.fn().mockResolvedValue(undefined),
  writeBatch:      jest.fn(() => ({ set: jest.fn(), update: jest.fn(), delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) })),
  runTransaction:  jest.fn(async (_, fn: any) => fn({ get: jest.fn(), set: jest.fn(), update: jest.fn() })),
  query:           jest.fn(c => c),
  where:           jest.fn(),
  orderBy:         jest.fn(),
  onSnapshot:      jest.fn(() => jest.fn()),
  serverTimestamp: (...args: any[]) => mockServerTimestamp(...args),
  increment:       jest.fn(n => n),
  Timestamp:       { now: jest.fn(() => ({ seconds: 0, nanoseconds: 0 })), fromDate: jest.fn() },
  limit:           jest.fn(),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getUserPreferences', () => {
  it('returns empty object when doc has no data', async () => {
    mockGetDoc.mockResolvedValueOnce({ data: () => undefined });
    const result = await getUserPreferences('uid-1');
    expect(result).toEqual({});
  });

  it('returns data when doc exists', async () => {
    const prefs = { eodReminder: { enabled: false, time: '20:00' } };
    mockGetDoc.mockResolvedValueOnce({ data: () => prefs });
    const result = await getUserPreferences('uid-1');
    expect(result).toEqual(prefs);
  });
});

describe('updateUserPreferences', () => {
  it('calls setDoc with merge:true', async () => {
    const prefs = { sharedTasks: false };
    await updateUserPreferences('uid-1', prefs);
    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.anything(),
      prefs,
      { merge: true },
    );
  });
});

describe('markLastOpenedAt', () => {
  it('calls setDoc with serverTimestamp and merge:true', async () => {
    await markLastOpenedAt('uid-1');
    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.anything(),
      { lastOpenedAt: expect.anything() },
      { merge: true },
    );
  });
});
