/**
 * KAN-59 / KAN-154 — useTodayScreen hook tests.
 *
 * Covers:
 *   - isLoading: true initially, false after one-shot fetch resolves
 *   - isRefreshing: true during pull-to-refresh, false after
 *   - error: null on success, string on fetch failure
 *   - refresh(): re-runs the full fetch (used by onTaskAdded after task creation)
 *   - Proximity engine: starts when undone POI tasks are present
 *   - Proximity engine: does NOT start without POI tasks
 *   - Optimistic toggle: calls setTaskDone and processTaskCompletionRewards
 *   - Progress derived values: totalTasks, doneTasks, progress, nearbyCount
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetTasksForDate        = jest.fn();
const mockEnsureCurrentDay       = jest.fn();
const mockGetCategories          = jest.fn();
const mockGetUser                = jest.fn();
const mockGetUserPreferences     = jest.fn();
const mockGetPoiPreferencesMap   = jest.fn();
const mockGetTotalPoints         = jest.fn();
const mockSetTaskDone            = jest.fn();
const mockRunProximitySearch     = jest.fn();
const mockGetInboxUnreadCount    = jest.fn();
const mockGetLearnedPlaceCounts = jest.fn().mockResolvedValue([]);
const mockGetTrips = jest.fn().mockResolvedValue([]);
const mockGetMallSnapshot = jest.fn().mockResolvedValue(null);
const mockSetLearnedPlaces           = jest.fn();
const mockSetActiveTrips             = jest.fn();
const mockSetMallSnapshot            = jest.fn();
const mockSetHomeLocation            = jest.fn();
const mockClearBootData = jest.fn();
let mockBootData: any = null;

jest.mock('../../src/services/firestore', () => ({
  getTasksForDate:      (...args: unknown[]) => mockGetTasksForDate(...args),
  ensureCurrentDay:     (...args: unknown[]) => mockEnsureCurrentDay(...args),
  filterActiveTasksForDate: (tasks: any[], today: string) => tasks.filter(task =>
    !task.done && (!task.scheduledDate || task.scheduledDate >= today),
  ),
  getCategories:        (...args: unknown[]) => mockGetCategories(...args),
  getUser:              (...args: unknown[]) => mockGetUser(...args),
  upsertUser:           jest.fn().mockResolvedValue(undefined),
  serverTimestamp:      jest.fn().mockReturnValue('SERVER_TIMESTAMP'),
  getUserPreferences:   (...args: unknown[]) => mockGetUserPreferences(...args),
  getPoiPreferencesMap: (...args: unknown[]) => mockGetPoiPreferencesMap(...args),
  getTotalPoints:       (...args: unknown[]) => mockGetTotalPoints(...args),
  getInboxUnreadCount:  (...args: unknown[]) => mockGetInboxUnreadCount(...args),
  setStoreTuningPref:   jest.fn().mockResolvedValue(undefined),
  setTaskDone:          (...args: unknown[]) => mockSetTaskDone(...args),
  awardPoint:           jest.fn().mockResolvedValue(undefined),
  getLearnedPlaceCounts: (...args: unknown[]) => mockGetLearnedPlaceCounts(...args),
  getTaughtPlaces:       jest.fn().mockResolvedValue([]),
  getTrips:              (...args: unknown[]) => mockGetTrips(...args),
}));

jest.mock('../../src/services/calendar', () => ({
  fetchCalendarEvents: jest.fn().mockResolvedValue([]),
}));

// useOffGridWelcomeBack's own behavior (toast + cleanup) is covered by its
// dedicated test file — stub it here so this file only tests useTodayScreen's
// composition, without also needing habitatCache/deleteTrip mocks.
jest.mock('../../src/hooks/useOffGridWelcomeBack', () => ({
  useOffGridWelcomeBack: jest.fn(),
}));

jest.mock('../../src/services/tripSuggestions', () => ({
  detectCalendarSignal:    jest.fn().mockReturnValue(null),
  getDismissedSignalIds:   jest.fn().mockReturnValue(new Set()),
  dismissSignal:           jest.fn(),
  CALENDAR_SIGNAL_LOOKAHEAD_DAYS: 7,
}));

jest.mock('../../src/services/mallSnapshots', () => ({
  getMallSnapshot: (...args: unknown[]) => mockGetMallSnapshot(...args),
}));

// errandBundles.ts opens its own expo-sqlite db — not under test here (see
// errandBundles.test.ts / useErrandBundle.test.ts), so stub it out wholesale.
jest.mock('../../src/services/errandBundles', () => ({
  computeErrandBundles: jest.fn().mockReturnValue([]),
  errandBundleKey: (bundle: { anchor: { placeId: string } }) => bundle.anchor.placeId,
  isBundleDismissedToday: jest.fn().mockReturnValue(false),
  getDismissedBundleKeysToday: jest.fn().mockReturnValue(new Set()),
  dismissBundleForToday: jest.fn(),
}));

jest.mock('../../src/services/sharing', () => ({
  getIncomingSharedTasksCount: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../src/services/wearSync', () => ({
  syncTasksToWatch: jest.fn(),
}));

jest.mock('../../src/utils/date', () => ({
  todayISO: () => '2026-06-15',
}));

jest.mock('../../src/store/appStore', () => ({
  useAppStore: {
    getState: () => ({ bootData: mockBootData, clearBootData: mockClearBootData }),
  },
}));

// useTaskCompletion imports rewardFunctions, which reaches
// @react-native-firebase/functions — a native module unavailable under Jest,
// and the reason this whole suite failed to load. Stub at the service
// boundary; these tests are about the hook's derived state, not the reward
// round-trip (that lives server-side since KAN-271).
// useErrandBundle -> clusterLeisure -> habitatCache -> expo-sqlite (ESM,
// untransformed under this config). Stub the leisure lookup itself; the
// bundle service above is already mocked, and neither is what these tests
// assert on. See __tests__/services/clusterLeisure.test.ts for its own suite.
jest.mock('../../src/services/clusterLeisure', () => ({
  findClusterLeisure: jest.fn(() => null),
}));

jest.mock('../../src/services/rewardFunctions', () => ({
  processTaskCompletionRewards: jest.fn().mockResolvedValue({ totalPoints: 0, nudgeCandidate: null }),
  awardOnboardingBonus:         jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/achievements', () => ({
  evaluateAchievements:         jest.fn().mockResolvedValue({ nudgeCandidate: null }),
  checkAndFireAchievementNudge: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/challenges', () => ({
  getActiveChallengesForUser: jest.fn().mockResolvedValue([]),
  incrementCompletedCount:    jest.fn().mockResolvedValue(false),
}));

// KAN-280 — useTaskCompletion cancels a task's reminder on brush.
const mockCancelTaskReminder = jest.fn().mockResolvedValue(undefined);
const mockRefreshDatedTaskHandoff = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/notifications', () => ({
  cancelTaskReminder: (...args: unknown[]) => mockCancelTaskReminder(...args),
}));
jest.mock('../../src/services/datedTaskHandoff', () => ({
  refreshDatedTaskHandoff: (...args: unknown[]) => mockRefreshDatedTaskHandoff(...args),
}));

jest.mock('../../src/services/geolocation', () => ({
  requestLocationPermission: jest.fn().mockResolvedValue('granted'),
  // KAN-301 — useProximityEngine seeds the Lantern's position with one
  // low-accuracy fix on permission grant. Mocked so it resolves cleanly.
  getPositionLowAccuracy:    jest.fn().mockResolvedValue({ lat: 0, lng: 0 }),
  LocationContext:           {},
}));

jest.mock('../../src/services/proximity', () => ({
  runProximitySearch:            (...args: unknown[]) => mockRunProximitySearch(...args),
  // The automatic paths (mount, foreground) go through the snapshot-reusing
  // wrapper since the KAN-285 follow-up; the mock predated it and omitting it
  // threw "is not a function" out of the hook's mount effect.
  runProximitySearchOrReuseSnapshot: (...args: unknown[]) => mockRunProximitySearch(...args),
  getLastSearchCoords:           jest.fn().mockReturnValue(null),
  // useTaskCompletion reads this to stamp completedTripId — omitting it threw
  // "is not a function" inside handleToggle's try block, silently swallowing
  // every optimistic-toggle test (caught by the same block's catch/revert).
  getActivePlaceContext:         jest.fn().mockReturnValue(null),
  updateProximityPoiPreferences: jest.fn(),
  setLocationTap:                jest.fn(),
  setPlaceContextTap:            jest.fn(),
  setNavigateToTripPlanner:      jest.fn(),
  updateNotifNearbyEnabled:      jest.fn(),
  updateExitPromptPref:          jest.fn(),
  setLearnedPlaces:              (...args: unknown[]) => mockSetLearnedPlaces(...args),
  setActiveTrips:                (...args: unknown[]) => mockSetActiveTrips(...args),
  setMallSnapshot:               (...args: unknown[]) => mockSetMallSnapshot(...args),
}));

jest.mock('../../src/services/home', () => ({
  setHomeLocation: (...args: unknown[]) => mockSetHomeLocation(...args),
}));

jest.mock('../../src/services/maps', () => ({
  getDistanceMeters: jest.fn().mockReturnValue(0),
}));

jest.mock('../../src/services/indoorProximity', () => ({
  startIndoorProximityMonitoring: jest.fn().mockReturnValue(jest.fn()),
  stopIndoorProximityMonitoring:  jest.fn(),
  updateIndoorTasks:              jest.fn(),
  updateIndoorExitPromptPref:     jest.fn(),
}));

jest.mock('../../src/services/indoorDetection', () => ({
  startIndoorDetection: jest.fn().mockReturnValue(jest.fn()),
  feedLocation:         jest.fn(),
  stopIndoorDetection:  jest.fn(),
}));

jest.mock('../../src/services/storeTuning', () => ({
  startStoreTuning:        jest.fn().mockReturnValue(jest.fn()),
  onLocationContextChange: jest.fn(),
  activateStoreTuning:     jest.fn(),
  dismissStoreTuning:      jest.fn(),
}));

jest.mock('../../src/services/battery', () => ({
  useBatteryLevel:       () => 1.0,
  getBatteryLevel:       jest.fn().mockResolvedValue(1.0),
  shouldPauseForBattery: () => false,
  LOW_BATTERY_THRESHOLD: 0.20,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { act, renderHook } from '@testing-library/react-native';
import { useTodayScreen } from '../../src/hooks/useTodayScreen';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const UID = 'test-uid';

const TASK = {
  id:        'task-1',
  title:     'Buy milk',
  category:  'errands',
  done:      false,
  date:      '2026-06-15',
  createdAt: { toDate: () => new Date() } as any,
};

const POI_TASK = {
  ...TASK,
  id:  'poi-task-1',
  poi: 'pharmacy',
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function setupDefaults() {
  mockGetTasksForDate.mockResolvedValue([]);
  mockEnsureCurrentDay.mockImplementation(async (uid: string) => ({
    tasks: await mockGetTasksForDate(uid, '2026-06-15'),
    persistence: Promise.resolve(),
  }));
  mockGetCategories.mockResolvedValue([]);
  mockGetUser.mockResolvedValue(null);
  mockGetUserPreferences.mockResolvedValue({});
  mockGetPoiPreferencesMap.mockResolvedValue({});
  mockGetTotalPoints.mockResolvedValue(0);
  mockGetInboxUnreadCount.mockResolvedValue(0);
  mockSetTaskDone.mockResolvedValue(undefined);
  mockRunProximitySearch.mockResolvedValue(undefined);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockBootData = null;
  setupDefaults();
});

describe('useTodayScreen — one-shot fetch', () => {
  it('starts in loading state before the fetch resolves', () => {
    // Never resolves — stays in loading
    mockGetTasksForDate.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useTodayScreen(UID));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('transitions to loaded after the fetch resolves', async () => {
    mockGetTasksForDate.mockResolvedValue([TASK]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].id).toBe('task-1');
  });

  it('sets error when the fetch fails', async () => {
    mockGetTasksForDate.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe('Could not load tasks. Check your connection.');
  });

  it('keeps cached task data when an auxiliary offline read fails', async () => {
    mockGetTasksForDate.mockResolvedValue([TASK]);
    mockGetCategories.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.tasks).toEqual([TASK]);
  });

  it('keeps cached task data when a refresh tasks read fails offline', async () => {
    mockGetTasksForDate
      .mockResolvedValueOnce([TASK])
      .mockRejectedValueOnce(new Error('offline'));

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    await act(async () => { result.current.refresh(); });
    await act(async () => {});

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.tasks).toEqual([TASK]);
  });

  it('times out a hung auxiliary read instead of staying in loading forever', async () => {
    jest.useFakeTimers();
    try {
      mockGetTasksForDate.mockResolvedValue([TASK]);
      mockEnsureCurrentDay.mockResolvedValue({ tasks: [TASK], persistence: Promise.resolve() });
      mockGetCategories.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useTodayScreen(UID));
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await act(async () => {});

      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.tasks).toEqual([TASK]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns empty tasks and no error when uid is undefined', async () => {
    const { result } = renderHook(() => useTodayScreen(undefined));
    await act(async () => {});

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.tasks).toHaveLength(0);
  });

  it('revalidates splash boot tasks against a fresh local day before rendering', async () => {
    mockBootData = {
      ownerUid: UID,
      tasks: [
        { ...TASK, id: 'undated' },
        { ...TASK, id: 'past', scheduledDate: '2026-06-14' },
        { ...TASK, id: 'today', scheduledDate: '2026-06-15' },
      ],
      customCategories: [], totalPoints: 0, inboxCount: 0, socialUnreadCount: 0,
      trips: [], mallSnapshot: null, userData: null, userPrefs: {}, poiPrefsMap: {},
    };

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(result.current.tasks.map(task => task.id)).toEqual(['undated', 'today']);
  });
});

describe('useTodayScreen — refresh', () => {
  it('re-runs the full fetch when refresh() is called (onTaskAdded path)', async () => {
    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    const callsBefore = mockGetTasksForDate.mock.calls.length;

    await act(async () => { result.current.refresh(); });
    await act(async () => {});

    expect(mockGetTasksForDate.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('sets isRefreshing=true during a pull-to-refresh fetch', async () => {
    // First fetch resolves, second hangs so we can observe isRefreshing
    mockGetTasksForDate
      .mockResolvedValueOnce([])
      .mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});
    expect(result.current.isLoading).toBe(false);

    act(() => { result.current.refresh(); });
    expect(result.current.isRefreshing).toBe(true);
  });
});

describe('useTodayScreen — proximity engine', () => {
  it('runs proximity search when an undone POI task is present and permission is granted', async () => {
    mockGetTasksForDate.mockResolvedValue([POI_TASK]);

    renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(mockRunProximitySearch).toHaveBeenCalledWith(
      UID,
      expect.arrayContaining([expect.objectContaining({ id: 'poi-task-1' })]),
      expect.any(Function),
    );
  });

  it('does NOT run proximity search when there are no POI tasks', async () => {
    renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(mockRunProximitySearch).not.toHaveBeenCalled();
  });
});

describe('useTodayScreen — nearbyReady (KAN-281 follow-up)', () => {
  it('is false while a first proximity search is in flight, true once it resolves', async () => {
    mockGetTasksForDate.mockResolvedValue([POI_TASK]);
    let resolveSearch: (() => void) | undefined;
    mockRunProximitySearch.mockReturnValue(new Promise<void>(resolve => { resolveSearch = resolve; }));

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(result.current.nearbyReady).toBe(false);

    const onUpdate = mockRunProximitySearch.mock.calls[0][2];
    await act(async () => { onUpdate(null, null, {}); resolveSearch?.(); });

    expect(result.current.nearbyReady).toBe(true);
  });

  it('is true immediately when there are no POI tasks (nothing to wait for)', async () => {
    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(result.current.nearbyReady).toBe(true);
  });
});

describe('useTodayScreen — cache-first proximity boot wiring (KAN-237)', () => {
  it('feeds active trips and the mall snapshot into the proximity engine', async () => {
    renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(mockSetActiveTrips).toHaveBeenCalledWith([]);
    expect(mockSetMallSnapshot).toHaveBeenCalledWith(null);
  });
});

describe('useTodayScreen — home anchor wiring (KAN-247)', () => {
  it('feeds home.ts with null when the user has no home anchor set', async () => {
    mockGetUser.mockResolvedValue(null);

    renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(mockSetHomeLocation).toHaveBeenCalledWith(null);
  });

  it('feeds home.ts with the user\'s home anchor when one is set', async () => {
    const home = { address: '221B Baker Street', lat: 51.5, lng: -0.1 };
    mockGetUser.mockResolvedValue({ home });

    renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(mockSetHomeLocation).toHaveBeenCalledWith(home);
  });

  it('clears home.ts when uid is undefined', async () => {
    renderHook(() => useTodayScreen(undefined));
    await act(async () => {});

    expect(mockSetHomeLocation).toHaveBeenCalledWith(null);
  });
});

describe('useTodayScreen — progress derived values', () => {
  it('computes totalTasks, doneTasks, progress, and nearbyCount correctly', async () => {
    const done = { ...TASK, id: 'task-done', done: true };
    const poi  = { ...POI_TASK, id: 'poi-1' };

    mockGetTasksForDate.mockResolvedValue([TASK, done, poi]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(result.current.totalTasks).toBe(3);
    expect(result.current.doneTasks).toBe(1);
    expect(result.current.progress).toBeCloseTo(1 / 3);
    // KAN-287 — nothing resolved yet, so nothing is "nearby" regardless of
    // how many tasks carry a POI type.
    expect(result.current.nearbyCount).toBe(0);

    const onUpdate = mockRunProximitySearch.mock.calls[0][2];
    const place = { placeId: 'p-1', name: 'Corner Pharmacy', lat: 1, lng: 2, distanceMeters: 30 };
    await act(async () => { onUpdate('pharmacy', place, { pharmacy: [place] }); });

    expect(result.current.nearbyCount).toBe(1);
  });

  describe('nearbyCount (KAN-287)', () => {
    const placeFor = (name: string) => ({ placeId: `p-${name}`, name, lat: 1, lng: 2, distanceMeters: 30 });

    /** Renders, then drives the proximity engine's onUpdate with `poiPlaces`. */
    async function renderWithPlaces(tasks: unknown[], poiPlaces: Record<string, unknown[]>) {
      mockGetTasksForDate.mockResolvedValue(tasks);
      const { result } = renderHook(() => useTodayScreen(UID));
      await act(async () => {});
      const onUpdate = mockRunProximitySearch.mock.calls[0]?.[2];
      if (onUpdate) { await act(async () => { onUpdate(null, null, poiPlaces); }); }
      return result;
    }

    it('does not count a task whose POI type resolved no place', async () => {
      const result = await renderWithPlaces([{ ...POI_TASK, poi: 'pharmacy' }], { pharmacy: [] });
      expect(result.current.nearbyCount).toBe(0);
    });

    it('does not count a done task even when its place is right there', async () => {
      const result = await renderWithPlaces(
        [{ ...POI_TASK, poi: 'pharmacy', done: true }],
        { pharmacy: [placeFor('Corner Pharmacy')] },
      );
      expect(result.current.nearbyCount).toBe(0);
    });

    it('does not count a task with no POI type at all', async () => {
      const result = await renderWithPlaces([TASK], { pharmacy: [placeFor('Corner Pharmacy')] });
      expect(result.current.nearbyCount).toBe(0);
    });

    it('counts each open task whose own POI type resolved a place', async () => {
      const result = await renderWithPlaces(
        [
          { ...POI_TASK, id: 'a', poi: 'pharmacy' },
          { ...POI_TASK, id: 'b', poi: 'cafe' },
          { ...POI_TASK, id: 'c', poi: 'atm' },      // no places for atm
          { ...POI_TASK, id: 'd', poi: 'cafe', done: true },
          TASK,                                       // no poi
        ],
        { pharmacy: [placeFor('Pharmacy')], cafe: [placeFor('Cafe')], atm: [] },
      );
      // a + b only.
      expect(result.current.nearbyCount).toBe(2);
    });

    it('counts two open tasks sharing one resolved POI type as two, not one', async () => {
      const result = await renderWithPlaces(
        [
          { ...POI_TASK, id: 'a', poi: 'pharmacy' },
          { ...POI_TASK, id: 'b', poi: 'pharmacy' },
        ],
        { pharmacy: [placeFor('Corner Pharmacy')] },
      );
      expect(result.current.nearbyCount).toBe(2);
    });
  });

  it('excludes birthday tasks (KAN-248) from totalTasks/doneTasks/progress but not the task list', async () => {
    const birthday = { ...TASK, id: 'bday-1', kind: 'birthday' as const, done: false };
    const done     = { ...TASK, id: 'task-done', done: true };

    mockGetTasksForDate.mockResolvedValue([TASK, done, birthday]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    expect(result.current.tasks).toHaveLength(3); // still rendered on Today
    expect(result.current.totalTasks).toBe(2);    // birthday excluded from the ring
    expect(result.current.doneTasks).toBe(1);
    expect(result.current.progress).toBeCloseTo(1 / 2);
  });
});

describe('useTodayScreen — optimistic toggle', () => {
  it('calls setTaskDone with the correct arguments', async () => {
    mockGetTasksForDate.mockResolvedValue([TASK]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    await act(async () => {
      await result.current.handleToggle('task-1', true);
    });

    expect(mockSetTaskDone).toHaveBeenCalledWith(UID, 'task-1', true, undefined, undefined);
  });

  it('cancels the task\'s pending reminder when brushed (KAN-280)', async () => {
    mockGetTasksForDate.mockResolvedValue([TASK]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    await act(async () => {
      await result.current.handleToggle('task-1', true);
    });

    expect(mockCancelTaskReminder).toHaveBeenCalledWith('task-1');
  });

  it('does NOT cancel a reminder when un-brushing (done:false)', async () => {
    mockGetTasksForDate.mockResolvedValue([TASK]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    await act(async () => {
      await result.current.handleToggle('task-1', false);
    });

    expect(mockCancelTaskReminder).not.toHaveBeenCalled();
  });

  it('rebuilds a dated handoff after both brushing and reopening its task', async () => {
    const datedTask = { ...TASK, scheduledDate: '2026-06-15' };
    mockGetTasksForDate.mockResolvedValue([datedTask]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    await act(async () => { await result.current.handleToggle('task-1', true); });
    await act(async () => { await result.current.handleToggle('task-1', false); });

    expect(mockRefreshDatedTaskHandoff).toHaveBeenCalledTimes(2);
    expect(mockRefreshDatedTaskHandoff).toHaveBeenLastCalledWith(UID, '2026-06-15');
  });

  it('refreshes the learned-place ranking after both a done:true and a done:false toggle (KAN-230)', async () => {
    // setTaskDone deletes completedPlace* fields on done:false too — the
    // ranking must refresh either way, not just on completion.
    mockGetTasksForDate.mockResolvedValue([TASK]);
    mockGetLearnedPlaceCounts.mockResolvedValue([]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});
    expect(mockGetLearnedPlaceCounts).toHaveBeenCalledTimes(1); // initial mount fetch

    await act(async () => { await result.current.handleToggle('task-1', true); });
    expect(mockGetLearnedPlaceCounts).toHaveBeenCalledTimes(2);

    await act(async () => { await result.current.handleToggle('task-1', false); });
    expect(mockGetLearnedPlaceCounts).toHaveBeenCalledTimes(3);
  });

  it('suppresses learned-place refresh failures after the toggle succeeds', async () => {
    mockGetTasksForDate.mockResolvedValue([TASK]);
    mockGetLearnedPlaceCounts.mockResolvedValue([]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});
    expect(mockGetLearnedPlaceCounts).toHaveBeenCalledTimes(1); // initial mount fetch

    mockGetLearnedPlaceCounts.mockRejectedValueOnce(new Error('Learned places unavailable'));

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.handleToggle('task-1', true);
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeUndefined();
    expect(mockSetTaskDone).toHaveBeenCalledWith(UID, 'task-1', true, undefined, undefined);
    expect(mockGetLearnedPlaceCounts).toHaveBeenCalledTimes(2);
  });

  it('passes completedPlace to setTaskDone when brushing a task near its own POI type (KAN-226)', async () => {
    mockGetTasksForDate.mockResolvedValue([POI_TASK]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    // Drive the proximity engine's onUpdate callback to set a hero place
    // matching POI_TASK's poi type ('pharmacy').
    const onUpdate = mockRunProximitySearch.mock.calls[0][2];
    const place = { placeId: 'place-abc', name: 'Corner Pharmacy', lat: 1, lng: 2, distanceMeters: 30 };
    await act(async () => { onUpdate('pharmacy', place, { pharmacy: [place] }); });

    await act(async () => {
      await result.current.handleToggle('poi-task-1', true);
    });

    expect(mockSetTaskDone).toHaveBeenCalledWith(UID, 'poi-task-1', true, {
      placeId: 'place-abc',
      name: 'Corner Pharmacy',
      poiType: 'pharmacy',
    }, undefined);
  });

  it('does NOT pass completedPlace when the nearby place does not match the task POI type', async () => {
    mockGetTasksForDate.mockResolvedValue([POI_TASK]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    const onUpdate = mockRunProximitySearch.mock.calls[0][2];
    const place = { placeId: 'place-abc', name: 'Corner Cafe', lat: 1, lng: 2, distanceMeters: 30 };
    await act(async () => { onUpdate('cafe', place, { cafe: [place] }); });

    await act(async () => {
      await result.current.handleToggle('poi-task-1', true);
    });

    expect(mockSetTaskDone).toHaveBeenCalledWith(UID, 'poi-task-1', true, undefined, undefined);
  });

  // KAN-271 — reward evaluation (achievements + points) moved server-side,
  // behind processTaskCompletionRewards (a Cloud Function proxy). The client
  // no longer computes or sends allTasksDone/remainingTaskCount at all; it
  // just calls the function with (taskId, hour) and applies whatever comes
  // back.
  it('calls processTaskCompletionRewards when marking done', async () => {
    const { processTaskCompletionRewards } = jest.requireMock('../../src/services/rewardFunctions');
    mockGetTasksForDate.mockResolvedValue([TASK]);
    jest.spyOn(Date.prototype, 'getHours').mockReturnValue(14);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    await act(async () => {
      await result.current.handleToggle('task-1', true);
    });
    await act(async () => {});

    expect(processTaskCompletionRewards).toHaveBeenCalledWith('task-1', 14);
    jest.restoreAllMocks();
  });

  it('never calls processTaskCompletionRewards when marking a birthday task done (KAN-248 — unscored)', async () => {
    const { processTaskCompletionRewards } = jest.requireMock('../../src/services/rewardFunctions');
    const birthday = { ...TASK, id: 'bday-1', kind: 'birthday' as const };
    mockGetTasksForDate.mockResolvedValue([birthday]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    await act(async () => {
      await result.current.handleToggle('bday-1', true);
    });
    await act(async () => {});

    expect(processTaskCompletionRewards).not.toHaveBeenCalled();
  });

  it('refreshes only the points total after completing a task, not the full data (KAN-157)', async () => {
    const { processTaskCompletionRewards } = jest.requireMock('../../src/services/rewardFunctions');
    processTaskCompletionRewards.mockResolvedValueOnce({ totalPoints: 7, nudgeCandidate: null });
    mockGetTasksForDate.mockResolvedValue([TASK]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    // Ignore the calls made during the initial one-shot load.
    mockGetTasksForDate.mockClear();

    await act(async () => {
      await result.current.handleToggle('task-1', true);
    });
    // Flush the deferred (InteractionManager) achievement + points work.
    await act(async () => {});

    // Completion applies ONLY the points total the reward call returned…
    expect(result.current.totalPoints).toBe(7);
    // …and does NOT trigger a full task refetch.
    expect(mockGetTasksForDate).not.toHaveBeenCalled();
  });

  it('reverts the local task state when setTaskDone fails', async () => {
    mockSetTaskDone.mockRejectedValue(new Error('Network error'));
    mockGetTasksForDate.mockResolvedValue([TASK]);

    const { result } = renderHook(() => useTodayScreen(UID));
    await act(async () => {});

    await act(async () => {
      await result.current.handleToggle('task-1', true).catch(() => {});
    });

    expect(result.current.tasks[0].done).toBe(false);
  });
});
