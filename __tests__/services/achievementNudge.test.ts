/**
 * KAN-122 — Achievement nudge notification.
 *
 * Verifies:
 *  - buildAchievementNudgeBody: correct per-achievement copy
 *  - fireAchievementNudge: creates channel + calls displayNotification with
 *    correct body, screen, and achievementId payload
 *  - evaluateAchievements: returns nudgeCandidate for on_a_roll / explorer /
 *    centurion / day_complete / early_bird when "1 away"
 *  - evaluateAchievements: returns null when no achievement is "1 away"
 *  - evaluateAchievements: returns null when achievement already earned
 *  - evaluateAchievements: returns null when achievement is awarded in this tx
 *  - checkAndFireAchievementNudge: no-op when achievementNudges = false
 *  - checkAndFireAchievementNudge: no-op when lastAchievementNudgeDate = today
 *  - checkAndFireAchievementNudge: fires and stamps date when eligible
 */

import {
  buildAchievementNudgeBody,
  fireAchievementNudge,
} from '../../src/services/notifications';
import {
  evaluateAchievements,
  checkAndFireAchievementNudge,
  ACHIEVEMENT_DEFS,
} from '../../src/services/achievements';
import type { AchievementType } from '../../src/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockCreateChannel        = jest.fn().mockResolvedValue(undefined);
const mockDisplayNotification  = jest.fn().mockResolvedValue(undefined);

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel:             (...args: any[]) => mockCreateChannel(...args),
    displayNotification:       (...args: any[]) => mockDisplayNotification(...args),
    setNotificationCategories: jest.fn().mockResolvedValue(undefined),
    cancelNotification:        jest.fn().mockResolvedValue(undefined),
    createTriggerNotification: jest.fn().mockResolvedValue(undefined),
  },
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  AndroidVisibility: { PUBLIC: 1 },
  TriggerType: { TIMESTAMP: 0 },
}));

// ── Firestore ──────────────────────────────────────────────────────────────────

let _mockUserDoc: Record<string, any> = {};

const mockTxGet    = jest.fn();
const mockTxUpdate = jest.fn();
const mockRunTransaction = jest.fn(async (_db: any, fn: any) => {
  const tx = { get: mockTxGet, update: mockTxUpdate };
  return fn(tx);
});

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({ id: 'user-doc-ref' })),
    })),
  })),
  runTransaction:  (...args: any[]) => mockRunTransaction(...args),
  serverTimestamp: jest.fn(() => ({ _seconds: 0 })),
  increment:       jest.fn((v: number) => ({ _increment: v })),
}));

const mockGetUserPreferences    = jest.fn();
const mockUpdateUserPreferences = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/services/firestore', () => ({
  awardAchievement:             jest.fn().mockResolvedValue(undefined),
  hasAchievement:               jest.fn().mockResolvedValue(false),
  awardPointsAchievementBonus:  jest.fn().mockResolvedValue(undefined),
  getUserPreferences:           (...args: any[]) => mockGetUserPreferences(...args),
  updateUserPreferences:        (...args: any[]) => mockUpdateUserPreferences(...args),
}));

// copy.ts is a pure data module (no native deps) — achievements.ts reads its
// real COPY.achievements.catalogue for labels/conditions, so mocking it away
// (as `{}`) crashes at import time. Use the real thing.

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TODAY = new Date().toISOString().split('T')[0];
const UID   = 'uid-test';

function makeTask(overrides: Partial<{ poi: any; done: boolean }> = {}) {
  return {
    id:        'task-1',
    title:     'Test task',
    category:  'errands' as const,
    done:      false,
    date:      TODAY,
    createdAt: { toDate: () => new Date() } as any,
    ...overrides,
  };
}

function setupTxDoc(doc: Record<string, any>) {
  mockTxGet.mockResolvedValue({ data: () => doc });
}

// ─── buildAchievementNudgeBody ────────────────────────────────────────────────

describe('buildAchievementNudgeBody', () => {
  it('day_complete copy', () => {
    expect(buildAchievementNudgeBody('day_complete', 1)).toBe(
      '1 task from a clean day — brush it away.',
    );
  });

  it('early_bird copy', () => {
    expect(buildAchievementNudgeBody('early_bird', 1)).toBe(
      '1 task from unlocking Early Bird — brush one away before 9 AM.',
    );
  });

  it('on_a_roll copy', () => {
    expect(buildAchievementNudgeBody('on_a_roll', 1)).toBe(
      '1 more day of brushing to unlock On a Roll.',
    );
  });

  it('explorer singular copy', () => {
    expect(buildAchievementNudgeBody('explorer', 1)).toContain('1 location task');
    expect(buildAchievementNudgeBody('explorer', 1)).toContain('Explorer');
  });

  it('explorer plural copy', () => {
    expect(buildAchievementNudgeBody('explorer', 3)).toContain('3 location tasks');
  });

  it('centurion singular copy', () => {
    expect(buildAchievementNudgeBody('centurion', 1)).toContain('1 point');
    expect(buildAchievementNudgeBody('centurion', 1)).toContain('Centurion');
  });

  it('centurion plural copy', () => {
    expect(buildAchievementNudgeBody('centurion', 5)).toContain('5 points');
  });
});

// ─── fireAchievementNudge ─────────────────────────────────────────────────────

describe('fireAchievementNudge', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls displayNotification with the correct body', async () => {
    await fireAchievementNudge({ achievementId: 'on_a_roll', remaining: 1 });
    expect(mockDisplayNotification).toHaveBeenCalledTimes(1);
    const [notif] = mockDisplayNotification.mock.calls[0];
    expect(notif.body).toBe('1 more day of brushing to unlock On a Roll.');
  });

  it('includes achievementId in notification data', async () => {
    await fireAchievementNudge({ achievementId: 'explorer', remaining: 1 });
    const [notif] = mockDisplayNotification.mock.calls[0];
    expect(notif.data?.achievementId).toBe('explorer');
  });

  it('routes to Achievements screen', async () => {
    await fireAchievementNudge({ achievementId: 'centurion', remaining: 1 });
    const [notif] = mockDisplayNotification.mock.calls[0];
    expect(notif.data?.screen).toBe('Achievements');
  });

  it('creates the achievement-nudge channel with DEFAULT importance and PUBLIC visibility', async () => {
    await fireAchievementNudge({ achievementId: 'day_complete', remaining: 1 });
    expect(mockCreateChannel).toHaveBeenCalledTimes(1);
    const [ch] = mockCreateChannel.mock.calls[0];
    expect(ch.id).toBe('achievement-nudge');
    expect(ch.importance).toBe(3);  // AndroidImportance.DEFAULT
    expect(ch.visibility).toBe(1);  // AndroidVisibility.PUBLIC
  });
});

// ─── evaluateAchievements — nudge candidate detection ─────────────────────────

describe('evaluateAchievements — nudgeCandidate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTxUpdate.mockReturnValue(undefined);
    // Pin baseline to 10 AM so early_bird (< 9 AM) never fires unexpectedly.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-06-09T10:00:00'));
  });
  afterEach(() => jest.useRealTimers());

  it('returns nudgeCandidate on_a_roll when streak === 2', async () => {
    setupTxDoc({
      totalPoints: 0,
      currentStreak: 2,  // 1 away from 3
      achievements: {},
    });
    const { nudgeCandidate } = await evaluateAchievements(
      UID,
      makeTask(),
      { allTasksDone: false, remainingTaskCount: 3 },
    );
    expect(nudgeCandidate?.achievementId).toBe('on_a_roll');
  });

  it('does not return on_a_roll nudge when streak is not 1-away (streak=1)', async () => {
    setupTxDoc({ totalPoints: 0, currentStreak: 1, achievements: {} });
    const { nudgeCandidate } = await evaluateAchievements(
      UID, makeTask(), { allTasksDone: false, remainingTaskCount: 3 },
    );
    expect(nudgeCandidate?.achievementId ?? null).toBeNull();
  });

  it('returns nudgeCandidate explorer when new progress === 9', async () => {
    setupTxDoc({
      totalPoints: 0,
      currentStreak: 0,
      achievements: {
        explorer: { progress: 8, target: 10, earnCount: 0, earnedAt: null },
      },
    });
    const { nudgeCandidate } = await evaluateAchievements(
      UID,
      makeTask({ poi: 'supermarket' as any }),  // poi task → increments explorer
      { allTasksDone: false, remainingTaskCount: 3 },
    );
    expect(nudgeCandidate?.achievementId).toBe('explorer');
  });

  it('does not return explorer nudge when task has no POI', async () => {
    setupTxDoc({
      totalPoints: 0,
      currentStreak: 0,
      achievements: {
        explorer: { progress: 8, target: 10, earnCount: 0, earnedAt: null },
      },
    });
    const { nudgeCandidate } = await evaluateAchievements(
      UID,
      makeTask(),   // no poi
      { allTasksDone: false, remainingTaskCount: 3 },
    );
    expect(nudgeCandidate?.achievementId ?? null).toBeNull();
  });

  it('does not return explorer nudge when explorer is awarded in the same tx (progress 9→10)', async () => {
    // progress=9 + poi task → progress reaches 10 → awarded in tx → NOT a nudge candidate
    setupTxDoc({
      totalPoints: 0,
      currentStreak: 0,
      achievements: {
        explorer: { progress: 9, target: 10, earnCount: 0, earnedAt: null },
      },
    });
    const { nudgeCandidate } = await evaluateAchievements(
      UID,
      makeTask({ poi: 'supermarket' as any }),
      { allTasksDone: false, remainingTaskCount: 3 },
    );
    expect(nudgeCandidate?.achievementId ?? null).toBeNull();
  });

  it('returns nudgeCandidate centurion when projectedPoints === 99', async () => {
    setupTxDoc({
      totalPoints: 89,   // + 10 (first_brush award) = 99
      currentStreak: 0,
      achievements: {
        // first_brush: not yet earned
        // worth_wait already earned — this fixture's createdAt has no
        // toMillis/seconds, so the real age check falls back to epoch 0 and
        // would otherwise spuriously re-fire worth_wait too, throwing off
        // the exact totalPoints arithmetic this test depends on.
        worth_wait: { progress: 1, target: 1, earnCount: 1, earnedAt: null },
        centurion: { progress: 89, target: 100, earnCount: 0, earnedAt: null },
      },
    });
    const { nudgeCandidate } = await evaluateAchievements(
      UID,
      makeTask(),
      { allTasksDone: false, remainingTaskCount: 3 },
    );
    expect(nudgeCandidate?.achievementId).toBe('centurion');
  });

  it('returns nudgeCandidate day_complete when 1 task remains', async () => {
    setupTxDoc({ totalPoints: 0, currentStreak: 0, achievements: {} });
    const { nudgeCandidate } = await evaluateAchievements(
      UID,
      makeTask(),
      { allTasksDone: false, remainingTaskCount: 1 },
    );
    expect(nudgeCandidate?.achievementId).toBe('day_complete');
  });

  it('returns null when no achievement is 1 away', async () => {
    setupTxDoc({ totalPoints: 0, currentStreak: 0, achievements: {} });
    const { nudgeCandidate } = await evaluateAchievements(
      UID,
      makeTask(),
      { allTasksDone: false, remainingTaskCount: 5 },
    );
    expect(nudgeCandidate).toBeNull();
  });

  describe('early_bird (time-gated)', () => {
    it('returns early_bird nudge when completed before 9 AM', async () => {
      jest.setSystemTime(new Date('2024-06-09T08:00:00'));  // 8 AM
      setupTxDoc({ totalPoints: 0, currentStreak: 0, achievements: {} });
      const { nudgeCandidate } = await evaluateAchievements(
        UID, makeTask(), { allTasksDone: false, remainingTaskCount: 3 },
      );
      expect(nudgeCandidate?.achievementId).toBe('early_bird');
    });

    it('does not return early_bird nudge when completed at or after 9 AM', async () => {
      jest.setSystemTime(new Date('2024-06-09T10:00:00'));  // 10 AM
      setupTxDoc({ totalPoints: 0, currentStreak: 0, achievements: {} });
      const { nudgeCandidate } = await evaluateAchievements(
        UID, makeTask(), { allTasksDone: false, remainingTaskCount: 3 },
      );
      expect(nudgeCandidate?.achievementId ?? null).toBeNull();
    });
  });

  it('does not return on_a_roll nudge when already earned', async () => {
    setupTxDoc({
      totalPoints: 20,
      currentStreak: 2,
      achievements: {
        on_a_roll: { progress: 3, target: 3, earnCount: 1, earnedAt: {} },
      },
    });
    const { nudgeCandidate } = await evaluateAchievements(
      UID, makeTask(), { allTasksDone: false, remainingTaskCount: 5 },
    );
    expect(nudgeCandidate?.achievementId ?? null).toBeNull();
  });
});

// ─── checkAndFireAchievementNudge ─────────────────────────────────────────────

describe('checkAndFireAchievementNudge', () => {
  const candidate = { achievementId: 'on_a_roll' as AchievementType, remaining: 1 };

  beforeEach(() => jest.clearAllMocks());

  it('does not fire when achievementNudges is false', async () => {
    mockGetUserPreferences.mockResolvedValue({ achievementNudges: false });
    await checkAndFireAchievementNudge(UID, candidate);
    expect(mockDisplayNotification).not.toHaveBeenCalled();
  });

  it('does not fire when lastAchievementNudgeDate is today', async () => {
    mockGetUserPreferences.mockResolvedValue({
      achievementNudges: true,
      lastAchievementNudgeDate: TODAY,
    });
    await checkAndFireAchievementNudge(UID, candidate);
    expect(mockDisplayNotification).not.toHaveBeenCalled();
  });

  it('fires notification when eligible', async () => {
    mockGetUserPreferences.mockResolvedValue({
      achievementNudges: true,
      lastAchievementNudgeDate: '2000-01-01',
    });
    await checkAndFireAchievementNudge(UID, candidate);
    expect(mockDisplayNotification).toHaveBeenCalledTimes(1);
  });

  it('stamps lastAchievementNudgeDate before firing (atomicity)', async () => {
    const callOrder: string[] = [];
    mockUpdateUserPreferences.mockImplementation(async () => { callOrder.push('stamp'); });
    mockDisplayNotification.mockImplementation(async () => { callOrder.push('fire'); });
    mockGetUserPreferences.mockResolvedValue({
      achievementNudges: true,
      lastAchievementNudgeDate: '2000-01-01',
    });
    await checkAndFireAchievementNudge(UID, candidate);
    expect(mockUpdateUserPreferences).toHaveBeenCalledWith(UID, {
      lastAchievementNudgeDate: TODAY,
    });
    expect(callOrder).toEqual(['stamp', 'fire']);
  });

  it('fires when achievementNudges is absent (defaults to true)', async () => {
    mockGetUserPreferences.mockResolvedValue({
      lastAchievementNudgeDate: '2000-01-01',
    });
    await checkAndFireAchievementNudge(UID, candidate);
    expect(mockDisplayNotification).toHaveBeenCalledTimes(1);
  });
});
