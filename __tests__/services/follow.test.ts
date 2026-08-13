/**
 * Unit tests for the follow system (KAN-98 / KAN-212).
 *
 * Covers:
 *   followUser
 *     - throws cannot_follow_self when follower === followed
 *     - writes following entry with correct shape
 *     - writes followers entry with correct shape
 *     - increments followingCount on follower doc (set-merge)
 *     - increments followersCount on followed doc (set-merge)
 *     - writes inbox entry to followed user's inbox (KAN-212)
 *     - does NOT write to pendingNotifications directly (KAN-221 — moved
 *       server-side to the onFollowRequest Cloud Function)
 *     - commits one atomic batch
 *   unfollowUser
 *     - deletes both subcollection entries
 *     - decrements followingCount and followersCount
 *     - commits one atomic batch
 *   isFollowing
 *     - returns true when the following document exists
 *     - returns false when the document does not exist
 *   getFollowing (KAN-218 — one-shot, not a live subscription)
 *     - maps snapshot docs to FollowEntry objects (uid from doc id)
 *     - returns an empty array when following is empty
 *   getInboxEntries (KAN-212)
 *     - queries /users/{uid}/inbox ordered by createdAt desc
 *     - returns entries mapped from Firestore docs
 *     - returns empty array when inbox is empty
 *   markInboxEntryRead (KAN-212)
 *     - calls updateDoc on /users/{uid}/inbox/{entryId} with read: true
 *   getInboxUnreadCount (KAN-212)
 *     - queries /users/{uid}/inbox where read == false
 *     - returns the count of unread entries
 *     - returns 0 when inbox is empty
 */

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('@react-native-firebase/analytics', () => () => ({ logEvent: jest.fn() }));
// Pulled in transitively via the firestore/ barrel (users.ts) — KAN-214.
jest.mock('@react-native-firebase/auth', () => ({}));
jest.mock('../../src/services/analytics', () => ({ logTap: jest.fn() }));
jest.mock('../../src/services/poiInference', () => ({
  registerLearnedKeyword:   jest.fn(),
  normalize:                jest.fn(),
}));

// ─── Firestore mock ───────────────────────────────────────────────────────────

const mockBatchSet    = jest.fn();
const mockBatchDelete = jest.fn();
const mockBatchCommit = jest.fn();
const mockCollection  = jest.fn(() => ({ _type: 'collection' }));
const mockWriteBatch  = jest.fn(() => ({
  set:    mockBatchSet,
  delete: mockBatchDelete,
  commit: mockBatchCommit,
}));

const mockGetDoc     = jest.fn();
const mockOnSnapshot = jest.fn();

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore:    jest.fn(),
  collection:      (...args: unknown[]) => mockCollection(...args),
  doc:             jest.fn((_db: unknown, ...segments: string[]) => ({ _path: segments.join('/') })),
  addDoc:          jest.fn(),
  getDoc:          (...args: unknown[]) => mockGetDoc(...args),
  updateDoc:       (...args: unknown[]) => mockUpdateDoc(...args),
  setDoc:          jest.fn(),
  writeBatch:      () => mockWriteBatch(),
  getDocs:         (...args: unknown[]) => mockGetDocs(...args),
  query:           jest.fn(coll => coll),
  where:           jest.fn(),
  orderBy:         jest.fn(),
  onSnapshot:      (...args: unknown[]) => mockOnSnapshot(...args),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
  increment:       jest.fn((n: number) => ({ _increment: n })),
  Timestamp:       { now: jest.fn() },
  deleteDoc:       jest.fn(),
}));

import {
  followUser,
  unfollowUser,
  isFollowing,
  getFollowing,
  getInboxEntries,
  markInboxEntryRead,
  getInboxUnreadCount,
} from '../../src/services/firestore';

const mockGetDocs  = jest.fn();
const mockUpdateDoc = jest.fn();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSnap(exists: boolean, data?: object) {
  return { exists: () => exists, data: () => data };
}

function makeCollSnap(docs: Array<{ id: string; data: object }>) {
  return { docs: docs.map(d => ({ id: d.id, data: () => d.data })) };
}

// ─── followUser ───────────────────────────────────────────────────────────────

describe('followUser', () => {
  beforeEach(() => { jest.clearAllMocks(); mockCollection.mockReturnValue({ _type: 'collection' }); });

  it('throws cannot_follow_self when follower equals followed', async () => {
    await expect(
      followUser('uid1', 'alice', 'Alice', 'uid1', 'alice', 'Alice'),
    ).rejects.toThrow('cannot_follow_self');
  });

  it('writes the following entry under the follower doc', async () => {
    await followUser('uid_a', 'alice', 'Alice', 'uid_b', 'bob', 'Bob');

    const followingCall = mockBatchSet.mock.calls.find(
      ([ref]) => ref._path.includes('uid_a/following/uid_b'),
    );
    expect(followingCall).toBeDefined();
    expect(followingCall[1]).toMatchObject({ username: 'bob', displayName: 'Bob' });
  });

  it('writes the followers entry under the followed doc', async () => {
    await followUser('uid_a', 'alice', 'Alice', 'uid_b', 'bob', 'Bob');

    const followersCall = mockBatchSet.mock.calls.find(
      ([ref]) => ref._path.includes('uid_b/followers/uid_a'),
    );
    expect(followersCall).toBeDefined();
    expect(followersCall[1]).toMatchObject({ username: 'alice', displayName: 'Alice' });
  });

  it('increments followingCount on the follower user doc', async () => {
    await followUser('uid_a', 'alice', 'Alice', 'uid_b', 'bob', 'Bob');

    const countCall = mockBatchSet.mock.calls.find(
      ([ref, data]) => ref._path === 'users/uid_a' && data.followingCount,
    );
    expect(countCall).toBeDefined();
    expect(countCall[1].followingCount).toEqual({ _increment: 1 });
    expect(countCall[2]).toEqual({ merge: true });
  });

  it('increments followersCount on the followed user doc', async () => {
    await followUser('uid_a', 'alice', 'Alice', 'uid_b', 'bob', 'Bob');

    const countCall = mockBatchSet.mock.calls.find(
      ([ref, data]) => ref._path === 'users/uid_b' && data.followersCount,
    );
    expect(countCall).toBeDefined();
    expect(countCall[1].followersCount).toEqual({ _increment: 1 });
  });

  it('writes inbox entry to followed user inbox with deterministic ID (KAN-212)', async () => {
    await followUser('uid_a', 'alice', 'Alice', 'uid_b', 'bob', 'Bob');

    const inboxCall = mockBatchSet.mock.calls.find(
      ([, data]) => data?.type === 'follow_request',
    );
    expect(inboxCall).toBeDefined();
    // Deterministic doc ID = followerUid so repeated calls don't duplicate entries.
    expect(inboxCall[0]._path).toBe('uid_a');
    expect(inboxCall[1]).toMatchObject({
      type:            'follow_request',
      fromUid:         'uid_a',
      fromUsername:    'alice',
      fromDisplayName: 'Alice',
      read:            false,
    });
    // collection() must have been called with the inbox path for followed user
    expect(mockCollection).toHaveBeenCalledWith(
      undefined, 'users', 'uid_b', 'inbox',
    );
  });

  it('does not write directly to pendingNotifications (KAN-221)', async () => {
    await followUser('uid_a', 'alice', 'Alice', 'uid_b', 'bob', 'Bob');

    // The follow pendingNotification is now written server-side by the
    // onFollowRequest Cloud Function, triggered off the inbox entry —
    // the client must not write to another user's mailbox directly.
    const notifCall = mockBatchSet.mock.calls.find(
      ([, data]) => data?.type === 'follow',
    );
    expect(notifCall).toBeUndefined();
    expect(mockCollection).not.toHaveBeenCalledWith(
      undefined, 'pendingNotifications', 'uid_b', 'items',
    );
  });

  it('commits exactly one batch', async () => {
    await followUser('uid_a', 'alice', 'Alice', 'uid_b', 'bob', 'Bob');
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);
  });
});

// ─── unfollowUser ─────────────────────────────────────────────────────────────

describe('unfollowUser', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('deletes the following entry', async () => {
    await unfollowUser('uid_a', 'uid_b');
    const deleted = mockBatchDelete.mock.calls.map(([ref]) => ref._path);
    expect(deleted.some(p => p.includes('uid_a/following/uid_b'))).toBe(true);
  });

  it('deletes the followers entry', async () => {
    await unfollowUser('uid_a', 'uid_b');
    const deleted = mockBatchDelete.mock.calls.map(([ref]) => ref._path);
    expect(deleted.some(p => p.includes('uid_b/followers/uid_a'))).toBe(true);
  });

  it('decrements followingCount and followersCount', async () => {
    await unfollowUser('uid_a', 'uid_b');
    const setCalls = mockBatchSet.mock.calls;
    const followerCountCall = setCalls.find(([ref, data]) => ref._path === 'users/uid_a' && data.followingCount);
    const followedCountCall = setCalls.find(([ref, data]) => ref._path === 'users/uid_b' && data.followersCount);
    expect(followerCountCall[1].followingCount).toEqual({ _increment: -1 });
    expect(followedCountCall[1].followersCount).toEqual({ _increment: -1 });
  });

  it('commits exactly one batch', async () => {
    await unfollowUser('uid_a', 'uid_b');
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);
  });
});

// ─── isFollowing ─────────────────────────────────────────────────────────────

describe('isFollowing', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns true when the following document exists', async () => {
    mockGetDoc.mockResolvedValueOnce(makeSnap(true));
    await expect(isFollowing('uid_a', 'uid_b')).resolves.toBe(true);
  });

  it('returns false when the document does not exist', async () => {
    mockGetDoc.mockResolvedValueOnce(makeSnap(false));
    await expect(isFollowing('uid_a', 'uid_b')).resolves.toBe(false);
  });
});

// ─── subscribeToFollowing ─────────────────────────────────────────────────────

describe('getFollowing', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('maps snapshot docs to FollowEntry objects with uid from doc id (KAN-218 — one-shot, not a live subscription)', async () => {
    mockGetDocs.mockResolvedValueOnce(makeCollSnap([
      { id: 'uid_b', data: { username: 'bob', displayName: 'Bob', followedAt: {} } },
    ]));

    const result = await getFollowing('uid_a');
    expect(result).toEqual([
      expect.objectContaining({ uid: 'uid_b', username: 'bob', displayName: 'Bob' }),
    ]);
  });

  it('returns an empty array when following is empty', async () => {
    mockGetDocs.mockResolvedValueOnce(makeCollSnap([]));
    expect(await getFollowing('uid_a')).toEqual([]);
  });
});

// ─── getInboxEntries (KAN-212) ────────────────────────────────────────────────

const { orderBy: mockOrderByFn, where: mockWhereFn } = jest.requireMock('@react-native-firebase/firestore');

describe('getInboxEntries', () => {
  beforeEach(() => { jest.clearAllMocks(); mockCollection.mockReturnValue({ _type: 'collection' }); });

  it('queries /users/{uid}/inbox ordered by createdAt desc', async () => {
    mockGetDocs.mockResolvedValueOnce({ docs: [] });
    await getInboxEntries('uid_b');
    expect(mockCollection).toHaveBeenCalledWith(
      undefined, 'users', 'uid_b', 'inbox',
    );
    expect(mockOrderByFn).toHaveBeenCalledWith('createdAt', 'desc');
  });

  it('returns inbox entries mapped from Firestore docs', async () => {
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        {
          id: 'entry1',
          data: () => ({
            type:            'follow_request',
            fromUid:         'uid_a',
            fromUsername:    'alice',
            fromDisplayName: 'Alice',
            read:            false,
            createdAt:       {},
          }),
        },
      ],
    });

    const entries = await getInboxEntries('uid_b');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id:           'entry1',
      type:         'follow_request',
      fromUid:      'uid_a',
      fromUsername: 'alice',
      read:         false,
    });
  });

  it('returns empty array when inbox is empty', async () => {
    mockGetDocs.mockResolvedValueOnce({ docs: [] });
    const entries = await getInboxEntries('uid_b');
    expect(entries).toEqual([]);
  });
});

// ─── markInboxEntryRead (KAN-212) ────────────────────────────────────────────

describe('markInboxEntryRead', () => {
  beforeEach(() => { jest.clearAllMocks(); mockCollection.mockReturnValue({ _type: 'collection' }); });

  it('calls updateDoc on /users/{uid}/inbox/{entryId} with read: true', async () => {
    mockUpdateDoc.mockResolvedValueOnce(undefined);
    await markInboxEntryRead('uid_b', 'entry1');
    // doc() is called as doc(inboxRef(uid), entryId) — segments = ['entry1']
    const { doc: mockDoc } = jest.requireMock('@react-native-firebase/firestore');
    expect(mockDoc).toHaveBeenCalledWith(expect.anything(), 'entry1');
    expect(mockUpdateDoc).toHaveBeenCalledWith(
      expect.objectContaining({ _path: 'entry1' }),
      { read: true },
    );
    expect(mockCollection).toHaveBeenCalledWith(
      undefined, 'users', 'uid_b', 'inbox',
    );
  });
});

// ─── getInboxUnreadCount (KAN-212) ───────────────────────────────────────────

describe('getInboxUnreadCount', () => {
  beforeEach(() => { jest.clearAllMocks(); mockCollection.mockReturnValue({ _type: 'collection' }); });

  it('queries /users/{uid}/inbox where read == false', async () => {
    mockGetDocs.mockResolvedValueOnce({ size: 0, docs: [] });
    await getInboxUnreadCount('uid_b');
    expect(mockCollection).toHaveBeenCalledWith(
      undefined, 'users', 'uid_b', 'inbox',
    );
    expect(mockWhereFn).toHaveBeenCalledWith('read', '==', false);
  });

  it('returns count of unread entries', async () => {
    mockGetDocs.mockResolvedValueOnce({ size: 2, docs: [{}, {}] });
    const count = await getInboxUnreadCount('uid_b');
    expect(count).toBe(2);
  });

  it('returns 0 when no unread entries', async () => {
    mockGetDocs.mockResolvedValueOnce({ size: 0, docs: [] });
    const count = await getInboxUnreadCount('uid_b');
    expect(count).toBe(0);
  });
});
