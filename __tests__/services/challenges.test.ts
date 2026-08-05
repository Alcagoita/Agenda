/**
 * Unit tests for challenges service (KAN-102).
 *
 * Covers:
 *   createChallenge
 *     - throws CHALLENGE_NO_PARTICIPANTS when participant list is empty
 *     - writes challenge document with correct shape (goal-based)
 *     - writes challenge document with correct shape (time-based)
 *     - creator participant has status 'accepted'
 *     - other participants have status 'pending'
 *     - does not write pendingNotifications directly (KAN-221 — moved
 *       server-side to the onChallengeNotifications Cloud Function)
 *     - includes message when provided, omits when not
 *   updateParticipantStatus
 *     - calls updateDoc with correct field path
 *   incrementCompletedCount
 *     - increments completedCount without marking won when goal not met
 *     - marks participant won and challenge completed when goal is met
 *     - does not write pendingNotifications directly (KAN-221)
 *     - does not award the achievement client-side (KAN-271 — moved
 *       server-side to functions/src/rewards.ts, triggered off `won`)
 *   resolveTimeBasedChallenge
 *     - marks the highest-completedCount participant as winner
 *     - does not write pendingNotifications directly (KAN-221)
 *     - does not award the achievement client-side (KAN-271)
 *     - no-ops when there are no participants
 */

// ─── External mocks ──────────────────────────────────────────────────────────

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: { createChannel: jest.fn(), displayNotification: jest.fn() },
  AndroidImportance: { HIGH: 4 },
}));

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

jest.mock('../../src/services/achievements', () => ({
  awardChallengeWinnerAchievement: jest.fn().mockResolvedValue(undefined),
}));
// KAN-271 — challenges.ts deliberately never calls
// awardChallengeWinnerAchievement anymore: the client-side call was removed
// when reward writes moved server-side (functions/src/rewards.ts, triggered
// off the `won` flag flip on the challenge doc). The mock above is still
// imported below purely to assert it's NOT called — a regression back to a
// client-side call would double-award the achievement.

// ─── Firestore mock ───────────────────────────────────────────────────────────

const mockAddDoc    = jest.fn();
const mockUpdateDoc = jest.fn();

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore:    jest.fn(),
  collection:      jest.fn((_db: unknown, ...segs: string[]) => ({ _path: segs.join('/') })),
  doc:             jest.fn((_db: unknown, ...segs: string[]) => ({ _path: segs.join('/') })),
  addDoc:          (...args: unknown[]) => mockAddDoc(...args),
  updateDoc:       (...args: unknown[]) => mockUpdateDoc(...args),
  onSnapshot:      jest.fn(() => jest.fn()),
  query:           jest.fn(coll => coll),
  where:           jest.fn(),
  orderBy:         jest.fn(),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
  Timestamp:       {
    fromDate: (d: Date) => ({ _seconds: Math.floor(d.getTime() / 1000) }),
  },
  increment:       jest.fn((n: number) => ({ _increment: n })),
}));

import {
  createChallenge,
  updateParticipantStatus,
  incrementCompletedCount,
  resolveTimeBasedChallenge,
} from '../../src/services/challenges';
import type { Challenge, FollowEntry } from '../../src/types';
import { awardChallengeWinnerAchievement } from '../../src/services/achievements';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ALICE: FollowEntry = {
  uid: 'uid-alice', username: 'alice', displayName: 'Alice',
  followedAt: { toDate: () => new Date() } as any,
};
const BOB: FollowEntry = {
  uid: 'uid-bob', username: 'bob', displayName: 'Bob',
  followedAt: { toDate: () => new Date() } as any,
};

const BASE_PARAMS = {
  creatorUid: 'uid-me', creatorUsername: 'me', creatorName: 'Me',
};

// ─── createChallenge ──────────────────────────────────────────────────────────

describe('createChallenge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAddDoc.mockResolvedValue({ id: 'challenge-1' });
  });

  it('throws when participant list is empty', async () => {
    await expect(createChallenge({
      ...BASE_PARAMS, type: 'goal', goalCount: 10, participants: [],
    })).rejects.toThrow('CHALLENGE_NO_PARTICIPANTS');
  });

  it('writes a goal-based challenge document', async () => {
    await createChallenge({ ...BASE_PARAMS, type: 'goal', goalCount: 10, participants: [ALICE] });
    const [, data] = mockAddDoc.mock.calls[0];
    expect(data.type).toBe('goal');
    expect(data.goalCount).toBe(10);
    expect(data.status).toBe('pending');
    expect(data.createdBy).toBe('uid-me');
  });

  it('writes a time-based challenge document with deadline Timestamp', async () => {
    const deadline = new Date('2026-07-01T12:00:00Z');
    await createChallenge({ ...BASE_PARAMS, type: 'time', deadline, participants: [ALICE] });
    const [, data] = mockAddDoc.mock.calls[0];
    expect(data.type).toBe('time');
    expect(data.deadline).toBeDefined();
    expect(data.goalCount).toBeUndefined();
  });

  it('sets creator participant status to accepted', async () => {
    await createChallenge({ ...BASE_PARAMS, type: 'goal', goalCount: 5, participants: [ALICE] });
    const [, data] = mockAddDoc.mock.calls[0];
    expect(data.participants['uid-me'].status).toBe('accepted');
  });

  it('sets other participants status to pending', async () => {
    await createChallenge({ ...BASE_PARAMS, type: 'goal', goalCount: 5, participants: [ALICE, BOB] });
    const [, data] = mockAddDoc.mock.calls[0];
    expect(data.participants['uid-alice'].status).toBe('pending');
    expect(data.participants['uid-bob'].status).toBe('pending');
  });

  it('writes exactly one document — the challenge itself (no direct notifications)', async () => {
    await createChallenge({ ...BASE_PARAMS, type: 'goal', goalCount: 5, participants: [ALICE, BOB] });
    // The invite notification for each non-creator participant is now written
    // server-side by the onChallengeNotifications Cloud Function (KAN-221),
    // triggered off this document's creation — the client only writes the
    // challenge doc itself.
    expect(mockAddDoc).toHaveBeenCalledTimes(1);
  });

  it('does not write directly to pendingNotifications (KAN-221)', async () => {
    await createChallenge({ ...BASE_PARAMS, type: 'goal', goalCount: 5, participants: [ALICE, BOB] });
    const { collection: mockCollectionFn } = jest.requireMock('@react-native-firebase/firestore');
    expect(mockCollectionFn).not.toHaveBeenCalledWith(
      expect.anything(), 'pendingNotifications', expect.anything(), 'items',
    );
  });

  it('includes message in challenge doc when provided', async () => {
    await createChallenge({ ...BASE_PARAMS, type: 'goal', goalCount: 5, participants: [ALICE], message: 'gl hf' });
    const [, data] = mockAddDoc.mock.calls[0];
    expect(data.message).toBe('gl hf');
  });

  it('omits message field when not provided', async () => {
    await createChallenge({ ...BASE_PARAMS, type: 'goal', goalCount: 5, participants: [ALICE] });
    const [, data] = mockAddDoc.mock.calls[0];
    expect(data).not.toHaveProperty('message');
  });
});

// ─── updateParticipantStatus ──────────────────────────────────────────────────

describe('updateParticipantStatus', () => {
  beforeEach(() => { jest.clearAllMocks(); mockUpdateDoc.mockResolvedValue(undefined); });

  it('updates the correct field path for accepted status', async () => {
    await updateParticipantStatus('challenge-1', 'uid-alice', 'accepted');
    expect(mockUpdateDoc).toHaveBeenCalledWith(
      expect.anything(),
      { 'participants.uid-alice.status': 'accepted' },
    );
  });

  it('updates the correct field path for declined status', async () => {
    await updateParticipantStatus('challenge-1', 'uid-alice', 'declined');
    expect(mockUpdateDoc).toHaveBeenCalledWith(
      expect.anything(),
      { 'participants.uid-alice.status': 'declined' },
    );
  });
});

// ─── incrementCompletedCount ──────────────────────────────────────────────────

function makeGoalChallenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id:        'challenge-1',
    type:      'goal',
    goalCount: 5,
    createdBy: 'uid-me',
    status:    'active',
    createdAt: { seconds: 0, nanoseconds: 0 } as unknown as Challenge['createdAt'],
    participants: {
      'uid-me':    { username: 'me',    displayName: 'Me',    status: 'accepted', completedCount: 4, won: false },
      'uid-alice': { username: 'alice', displayName: 'Alice', status: 'accepted', completedCount: 2, won: false },
    },
    ...overrides,
  } as Challenge;
}

describe('incrementCompletedCount', () => {
  beforeEach(() => { jest.clearAllMocks(); mockUpdateDoc.mockResolvedValue(undefined); });

  it('increments completedCount without marking won when goal not met', async () => {
    const challenge = makeGoalChallenge({ goalCount: 10 });
    const result = await incrementCompletedCount('challenge-1', 'uid-me', challenge);

    expect(result).toBe(false);
    const [, data] = mockUpdateDoc.mock.calls[0];
    expect(data).toEqual({ 'participants.uid-me.completedCount': { _increment: 1 } });
    expect(awardChallengeWinnerAchievement).not.toHaveBeenCalled();
  });

  it('marks participant won and challenge completed when goal is met', async () => {
    const challenge = makeGoalChallenge({ goalCount: 5 }); // uid-me at 4 -> 5 meets goal
    const result = await incrementCompletedCount('challenge-1', 'uid-me', challenge);

    expect(result).toBe(true);
    const [, data] = mockUpdateDoc.mock.calls[0];
    expect(data).toEqual({
      'participants.uid-me.completedCount': { _increment: 1 },
      'participants.uid-me.won':            true,
      status:                               'completed',
    });
  });

  it('does not write directly to pendingNotifications (KAN-221)', async () => {
    const challenge = makeGoalChallenge({ goalCount: 5 });
    await incrementCompletedCount('challenge-1', 'uid-me', challenge);
    expect(mockAddDoc).not.toHaveBeenCalled();
  });

  it('does not award the achievement client-side (KAN-271 — server-side now)', async () => {
    const challenge = makeGoalChallenge({ goalCount: 5 });
    await incrementCompletedCount('challenge-1', 'uid-me', challenge);
    expect(awardChallengeWinnerAchievement).not.toHaveBeenCalled();
  });
});

// ─── resolveTimeBasedChallenge ────────────────────────────────────────────────

describe('resolveTimeBasedChallenge', () => {
  beforeEach(() => { jest.clearAllMocks(); mockUpdateDoc.mockResolvedValue(undefined); });

  it('marks the highest-completedCount participant as winner', async () => {
    const challenge = makeGoalChallenge({ type: 'time', goalCount: undefined });
    await resolveTimeBasedChallenge('challenge-1', challenge);

    const [, data] = mockUpdateDoc.mock.calls[0];
    expect(data.status).toBe('completed');
    expect(data['participants.uid-me.won']).toBe(true);
  });

  it('does not write directly to pendingNotifications (KAN-221)', async () => {
    const challenge = makeGoalChallenge({ type: 'time', goalCount: undefined });
    await resolveTimeBasedChallenge('challenge-1', challenge);
    expect(mockAddDoc).not.toHaveBeenCalled();
  });

  it('does not award the achievement client-side (KAN-271 — server-side now)', async () => {
    const challenge = makeGoalChallenge({ type: 'time', goalCount: undefined });
    await resolveTimeBasedChallenge('challenge-1', challenge);
    expect(awardChallengeWinnerAchievement).not.toHaveBeenCalled();
  });

  it('no-ops when there are no participants', async () => {
    const challenge = makeGoalChallenge({ type: 'time', goalCount: undefined, participants: {} });
    await resolveTimeBasedChallenge('challenge-1', challenge);
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });
});
