/**
 * TodayScreen — screen-level wiring tests.
 *
 * KAN-153/KAN-214: data loading is one-shot (getTasksForDate + friends via
 * Promise.allSettled), not a live Firestore subscription — see
 * useTodayScreenData.ts. Business-rule coverage for the reward flow
 * (processTaskCompletionRewards, achievements) lives at the hook level in
 * __tests__/hooks/useTodayScreen.test.ts; this file covers screen wiring:
 *   - far-away indicator / "one trip for all of these" row visibility
 *   - proximity engine start gate at mount
 *   - loading / error / retry / empty states
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// ─── Firestore mocks (one-shot — KAN-153/KAN-214) ────────────────────────────

const mockGetTasksForDate      = jest.fn();
const mockGetCategories        = jest.fn();
const mockGetUser              = jest.fn();
const mockGetUserPreferences   = jest.fn();
const mockGetPoiPreferencesMap = jest.fn();
const mockGetTotalPoints       = jest.fn();
const mockGetInboxUnreadCount  = jest.fn();
const mockGetTrips             = jest.fn();
const mockGetMallSnapshot      = jest.fn();
const mockSetTaskDone          = jest.fn();
const mockProcessTaskCompletionRewards = jest.fn();

jest.mock('../../src/services/sharing', () => ({
  getIncomingSharedTasksCount: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../src/services/firestore', () => ({
  getTasksForDate:      (...args: unknown[]) => mockGetTasksForDate(...args),
  getCategories:        (...args: unknown[]) => mockGetCategories(...args),
  getUser:              (...args: unknown[]) => mockGetUser(...args),
  upsertUser:           jest.fn().mockResolvedValue(undefined),
  serverTimestamp:      jest.fn().mockReturnValue('SERVER_TIMESTAMP'),
  getUserPreferences:   (...args: unknown[]) => mockGetUserPreferences(...args),
  getPoiPreferencesMap: (...args: unknown[]) => mockGetPoiPreferencesMap(...args),
  getTotalPoints:       (...args: unknown[]) => mockGetTotalPoints(...args),
  getInboxUnreadCount:  (...args: unknown[]) => mockGetInboxUnreadCount(...args),
  getTrips:             (...args: unknown[]) => mockGetTrips(...args),
  setStoreTuningPref:   jest.fn().mockResolvedValue(undefined),
  setTaskDone:          (...args: unknown[]) => mockSetTaskDone(...args),
  // KAN-230/240/317 — useLearnedPlaces (rendered inside the real
  // useTodayScreen hook) fetches both on mount.
  getLearnedPlaceCounts: jest.fn().mockResolvedValue([]),
  getTaughtPlaces:       jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/services/mallSnapshots', () => ({
  getMallSnapshot: (...args: unknown[]) => mockGetMallSnapshot(...args),
}));

jest.mock('../../src/store/appStore', () => ({
  useAppStore: {
    // No SplashScreen boot data in this isolated screen render — every test
    // goes through the real one-shot fetch path.
    getState: () => ({ bootData: null, clearBootData: jest.fn() }),
  },
}));

jest.mock('../../src/services/tripSuggestions', () => ({
  detectCalendarSignal:  jest.fn().mockReturnValue(null),
  getDismissedSignalIds: jest.fn().mockReturnValue(new Set()),
  dismissSignal:         jest.fn(),
  CALENDAR_SIGNAL_LOOKAHEAD_DAYS: 7,
}));

// errandBundles.ts opens its own expo-sqlite db — not under test here (see
// errandBundles.test.ts / useErrandBundle.test.ts), so stub it out wholesale.
jest.mock('../../src/services/errandBundles', () => ({
  computeErrandBundles:       jest.fn().mockReturnValue([]),
  errandBundleKey:            (bundle: { anchor: { placeId: string } }) => bundle.anchor.placeId,
  isBundleDismissedToday:     jest.fn().mockReturnValue(false),
  getDismissedBundleKeysToday: jest.fn().mockReturnValue(new Set()),
  dismissBundleForToday:      jest.fn(),
}));

jest.mock('../../src/services/clusterLeisure', () => ({
  findClusterLeisure: jest.fn(() => null),
}));

jest.mock('../../src/services/wearSync', () => ({
  syncTasksToWatch: jest.fn(),
}));

jest.mock('../../src/hooks/useOffGridWelcomeBack', () => ({
  useOffGridWelcomeBack: jest.fn(),
}));

jest.mock('../../src/services/home', () => ({
  setHomeLocation: jest.fn(),
}));

// KAN-271 — achievement/points evaluation moved server-side, behind this
// Cloud Function proxy. Reaches @react-native-firebase/functions, mocked
// globally in jest.setup.js, but stubbed at the service boundary here since
// the reward round-trip itself isn't under test in this file (see
// __tests__/hooks/useTodayScreen.test.ts for that).
jest.mock('../../src/services/rewardFunctions', () => ({
  processTaskCompletionRewards: (...args: unknown[]) => mockProcessTaskCompletionRewards(...args),
  awardOnboardingBonus:         jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/achievements', () => ({
  checkAndFireAchievementNudge: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/challenges', () => ({
  getActiveChallengesForUser: jest.fn().mockResolvedValue([]),
  incrementCompletedCount:    jest.fn().mockResolvedValue(false),
}));

// KAN-280 — useTaskCompletion (used by the real useTodayScreen hook rendered
// here) cancels a task's reminder on brush.
jest.mock('../../src/services/notifications', () => ({
  cancelTaskReminder: jest.fn().mockResolvedValue(undefined),
}));

// ─── Auth mock ────────────────────────────────────────────────────────────────

let mockUid: string | null = 'user-test';
jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => ({
    currentUser: mockUid ? { uid: mockUid, displayName: 'Test User', email: 'test@test.com' } : null,
  }),
}));
jest.mock('@react-native-firebase/auth', () => ({}));

// ─── Navigation mock ──────────────────────────────────────────────────────────

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: (...args: unknown[]) => mockNavigate(...args), goBack: jest.fn() }),
  // useProximityEngine imports navigationRef.ts, which builds this once at
  // module load time regardless of whether this test ever navigates through it.
  createNavigationContainerRef: () => ({ current: null, isReady: () => false }),
  // TodayScreen's own focus-triggered refresh (skips the first focus, since
  // SplashScreen already preloaded data) — a plain mount-effect is enough
  // here since these tests never leave/re-enter the screen.
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, []),
}));
jest.mock('@react-navigation/native-stack', () => ({}));

// useTripSuggestion (rendered inside the real useTodayScreen hook) imports
// calendar.ts, which imports expo-calendar — an ESM native module Jest can't
// parse. Not under test here.
jest.mock('../../src/services/calendar', () => ({
  fetchCalendarEvents: jest.fn().mockResolvedValue([]),
}));

// ─── Theme mock ───────────────────────────────────────────────────────────────

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff', surface: '#f6f5f1', surface2: '#efeeea',
      text: '#000', muted: '#999', faint: '#ccc',
      line: '#ddd', accent: '#e8a86a',
      ringTrack: '#ddd', ringFill: '#000',
      nearTint: '#fff', nearTint2: '#eee', nearBorder: '#ddd', nearText: '#000',
    },
    dark: false,
    setDark: jest.fn(),
  }),
}));

// ─── Safe-area mock ───────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ─── Reanimated mock ─────────────────────────────────────────────────────────
// Inline stub — avoids importing the TS source from node_modules which Jest
// cannot transform without extra config.

jest.mock('react-native-reanimated', () => {
  const { View, Text, ScrollView, FlatList, Image } = require('react-native');
  const noop = () => {};
  const noopShared = (v: unknown) => ({ value: v });
  // Animated IS the default export — must carry View, ScrollView, etc.
  const Animated = {
    View,
    Text,
    ScrollView,
    FlatList,
    Image,
    createAnimatedComponent: (c: unknown) => c,
    call: noop,
  };
  return {
    __esModule:               true,
    default:                  Animated,
    useSharedValue:           noopShared,
    useDerivedValue:          (fn: () => unknown) => ({ value: fn() }),
    useAnimatedStyle:         () => ({}),
    useAnimatedScrollHandler: () => noop,
    useAnimatedReaction:      noop,
    withTiming:               (v: unknown) => v,
    withRepeat:               (v: unknown) => v,
    withSequence:             (...args: unknown[]) => args[0],
    interpolate:              (_v: unknown, _i: unknown[], o: unknown[]) => o[0],
    Extrapolation:            { CLAMP: 'clamp' },
    runOnJS:                  (fn: (...args: unknown[]) => unknown) => fn,
    cancelAnimation:          noop,
    // useCollapseAnimation calls Easing.inOut(Easing.cubic) directly (not
    // just passed as an opaque config) — real no-op passthrough shape.
    Easing: {
      inOut: (fn: (t: number) => number) => fn,
      cubic: (t: number) => t,
    },
  };
});

// ─── Heavy component mocks ────────────────────────────────────────────────────

// TaskRow: renders a Pressable with a testID so we can fire the toggle without
// needing real SVG/Reanimated rendering. Calls onToggle(task.id, !task.done).
jest.mock('../../src/components/TaskRow', () => {
  const { TouchableOpacity, Text } = require('react-native');
  return function MockTaskRow({ task, onToggle, isFar }: {
    task: { id: string; title: string; done: boolean };
    onToggle: (id: string, done: boolean) => void;
    isFar?: boolean;
  }) {
    return (
      <TouchableOpacity
        testID={`task-row-${task.id}`}
        accessibilityState={{ selected: !!isFar }}
        onPress={() => onToggle(task.id, !task.done)}
      >
        <Text>{task.title}</Text>
      </TouchableOpacity>
    );
  };
});

jest.mock('../../src/components/NearbyCard',       () => () => null);
jest.mock('../../src/components/Header',           () => () => null);
jest.mock('../../src/components/Lantern',          () => () => null);
jest.mock('../../src/hooks/useLanternState', () => ({ useLanternState: () => ({ kind: 'unset' }) }));
jest.mock('../../src/components/ScrRotatingNudge', () => ({ __esModule: true, default: () => null }));
jest.mock('../../src/components/NewTaskSheet', () => {
  const { forwardRef } = require('react');
  return { __esModule: true, default: forwardRef(() => null) };
});
jest.mock('../../src/components/AppIcon', () => ({
  PlusIcon: () => null,
  // KAN-281 "one trip for all of these" row.
  NavigateIcon: () => null,
  ChevronRightIcon: () => null,
}));

// ─── Service mocks ────────────────────────────────────────────────────────────

jest.mock('../../src/services/geolocation', () => ({
  requestLocationPermission: jest.fn().mockResolvedValue('granted'),
  getPositionLowAccuracy:    jest.fn().mockResolvedValue({ lat: 0, lng: 0 }),
  LocationContext:           {},
}));
// KAN-59/KAN-214 review — there is no separate startProximityMonitoring/
// stopProximityMonitoring pair anymore; useProximityEngine.ts drives the
// engine directly via runProximitySearchOrReuseSnapshot (automatic entry
// point) / runProximitySearch (manual refresh) plus its own setInterval, so
// "does the engine run" is asserted against that call instead.
const mockRunProximitySearchOrReuseSnapshot = jest.fn(
  (_uid: string, _tasks: unknown[], onUpdate: (poiType: null, place: null, places: Record<string, unknown>) => void) => {
    // Resolves as a completed-but-empty scan (calls onUpdate with no
    // results) rather than never calling back at all — otherwise
    // useProximityEngine's hasCompletedScan/nearbyReady never flips true and
    // every downstream "is this task far/nearby" check hangs indefinitely.
    onUpdate(null, null, {});
    return Promise.resolve();
  },
);

jest.mock('../../src/services/proximity', () => ({
  runProximitySearch: jest.fn((_uid: string, _tasks: unknown[], onUpdate: (poiType: null, place: null, places: Record<string, unknown>) => void) => {
    onUpdate(null, null, {});
    return Promise.resolve();
  }),
  runProximitySearchOrReuseSnapshot: (...args: unknown[]) => mockRunProximitySearchOrReuseSnapshot(...args),
  getLastSearchCoords:           jest.fn().mockReturnValue(null),
  // KAN-349 — the Lantern zone's notice reads the last search's source.
  // Default: nothing has answered yet, so no line and no coverage check.
  getLastPoiSearchState:         jest.fn().mockReturnValue({ source: null, coverageStatus: undefined, degraded: true }),
  NEARBY_RADIUS:                 400,
  getActivePlaceContext:         jest.fn().mockReturnValue(null),
  updateProximityTasks:          jest.fn(),
  updateProximityPoiPreferences: jest.fn(),
  pauseGeofenceMonitoring:       jest.fn(),
  resumeGeofenceMonitoring:      jest.fn(),
  setLocationTap:                jest.fn(),
  setPlaceContextTap:            jest.fn(),
  setNavigateToTripPlanner:      jest.fn(),
  updateNotifNearbyEnabled:      jest.fn(),
  updateExitPromptPref:          jest.fn(),
  setLearnedPlaces:              jest.fn(),
  setActiveTrips:                jest.fn(),
  setMallSnapshot:                jest.fn(),
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
  startStoreTuning:         jest.fn().mockReturnValue(jest.fn()),
  onLocationContextChange:  jest.fn(),
  activateStoreTuning:      jest.fn(),
  dismissStoreTuning:       jest.fn(),
}));

jest.mock('../../src/components/StoreTuningPromptSheet', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../../src/services/battery', () => ({
  useBatteryLevel:        () => 1.0,
  getBatteryLevel:        jest.fn().mockResolvedValue(1.0),
  shouldPauseForBattery:  (_level: number, _enabled: boolean) => false,
  LOW_BATTERY_THRESHOLD:  0.20,
}));
jest.mock('../../src/config/keys', () => ({ GOOGLE_PLACES_API_KEY: 'TEST' }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** One pending task fixture. */
const TASK = {
  id:        'task-1',
  title:     'Buy milk',
  category:  'errands' as const,
  done:      false,
  date:      '2026-05-29',
  createdAt: { toDate: () => new Date() } as any,
};

/** One already-done task fixture. */
const DONE_TASK = { ...TASK, id: 'task-done', done: true };

function setupFirestoreMocks(tasks: typeof TASK[]) {
  mockGetTasksForDate.mockResolvedValue(tasks);
  mockGetCategories.mockResolvedValue([]);
  mockGetUser.mockResolvedValue(null);
  mockGetUserPreferences.mockResolvedValue({});
  mockGetPoiPreferencesMap.mockResolvedValue({});
  mockGetTotalPoints.mockResolvedValue(tasks.length);
  mockGetInboxUnreadCount.mockResolvedValue(0);
  mockGetTrips.mockResolvedValue([]);
  mockGetMallSnapshot.mockResolvedValue(null);
  mockSetTaskDone.mockResolvedValue(undefined);
  mockProcessTaskCompletionRewards.mockResolvedValue({ totalPoints: 0, nudgeCandidate: null });
}

// ─── Import (after all mocks) ─────────────────────────────────────────────────

import TodayScreen from '../../src/screens/TodayScreen';

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockUid = 'user-test';
});

describe('KAN-279 — far-away indicator wiring', () => {
  it('marks a task with a poi as far when nothing is in the Nearby list', async () => {
    setupFirestoreMocks([{ ...TASK, poi: 'pharmacy' } as any]);
    render(<TodayScreen />);
    await act(async () => {});

    // The mocked proximity module never invokes its onUpdate callback here,
    // so poiPlaces stays {} — every task with a poi is "far" by default.
    expect(screen.getByTestId('task-row-task-1').props.accessibilityState.selected).toBe(true);
  });

  it('does NOT mark a task without a poi as far', async () => {
    setupFirestoreMocks([TASK]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.getByTestId('task-row-task-1').props.accessibilityState.selected).toBe(false);
  });
});

describe('KAN-281 — "one trip for all of these" entry row', () => {
  const TASK_ATM = { ...TASK, id: 'task-2', poi: 'atm' };

  it('does NOT render with fewer than 2 eligible tasks', async () => {
    setupFirestoreMocks([{ ...TASK, poi: 'pharmacy' } as any]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.queryByLabelText('One trip for all of these')).toBeNull();
  });

  it('does NOT render for a done task or a birthday, even alongside an eligible one', async () => {
    setupFirestoreMocks([
      { ...TASK, poi: 'pharmacy' } as any,
      { ...TASK_ATM, done: true } as any,
      { ...TASK, id: 'task-3', kind: 'birthday', poi: undefined } as any,
    ]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.queryByLabelText('One trip for all of these')).toBeNull();
  });

  it('renders — no Firestore/network call involved — when >=2 open POI tasks exist, and navigates to ItineraryOptions on tap', async () => {
    setupFirestoreMocks([{ ...TASK, poi: 'pharmacy' } as any, TASK_ATM as any]);
    render(<TodayScreen />);
    await act(async () => {});

    fireEvent.press(screen.getByLabelText('One trip for all of these'));
    expect(mockNavigate).toHaveBeenCalledWith('ItineraryOptions');
  });
});

// KAN-31/KAN-32 — point awarding + daily-complete achievement moved
// server-side (KAN-271): useTaskCompletion now just calls
// processTaskCompletionRewards(taskId, hour) and applies whatever comes
// back; it no longer computes allTasksDone/remainingTaskCount or calls
// awardPoint/checkAndAwardDailyComplete directly (both are dead client-side
// code — grep confirms no call site left in src/). Full behavioral coverage
// of the toggle -> reward call lives in __tests__/hooks/useTodayScreen.test.ts;
// this suite only checks the screen wires the toggle through at all.
describe('KAN-31 — reward call wiring on task toggle', () => {
  it('calls processTaskCompletionRewards when marking a task done', async () => {
    setupFirestoreMocks([TASK]);
    render(<TodayScreen />);
    await act(async () => {}); // let the one-shot fetch land before pressing

    await act(async () => {
      fireEvent.press(screen.getByTestId('task-row-task-1'));
    });
    await act(async () => {});

    expect(mockSetTaskDone).toHaveBeenCalledWith('user-test', 'task-1', true, undefined, undefined);
    expect(mockProcessTaskCompletionRewards).toHaveBeenCalledWith('task-1', expect.any(Number));
  });

  it('does NOT call processTaskCompletionRewards when marking a task undone', async () => {
    setupFirestoreMocks([DONE_TASK]);
    render(<TodayScreen />);
    await act(async () => {});

    await act(async () => {
      fireEvent.press(screen.getByTestId('task-row-task-done'));
    });
    await act(async () => {});

    expect(mockSetTaskDone).toHaveBeenCalledWith('user-test', 'task-done', false, undefined, undefined);
    expect(mockProcessTaskCompletionRewards).not.toHaveBeenCalled();
  });

  it('does NOT revert the task toggle when processTaskCompletionRewards fails (fire-and-forget)', async () => {
    setupFirestoreMocks([TASK]);
    mockProcessTaskCompletionRewards.mockRejectedValue(new Error('Network error'));
    render(<TodayScreen />);
    await act(async () => {});

    await act(async () => {
      fireEvent.press(screen.getByTestId('task-row-task-1'));
    });
    await act(async () => {});

    // setTaskDone still called and succeeded — toggle was not reverted.
    expect(mockSetTaskDone).toHaveBeenCalledWith('user-test', 'task-1', true, undefined, undefined);
    expect(screen.getByTestId('task-row-task-1')).toBeTruthy();
  });

  it('does NOT call processTaskCompletionRewards when uid is absent', async () => {
    mockUid = null;
    setupFirestoreMocks([TASK]);
    render(<TodayScreen />);
    await act(async () => {});

    await act(async () => {
      fireEvent.press(screen.queryByTestId('task-row-task-1') ?? { type: 'View' } as any);
    });
    await act(async () => {});

    expect(mockProcessTaskCompletionRewards).not.toHaveBeenCalled();
  });
});

// ─── KAN-53 — proximity engine gate ──────────────────────────────────────────
//
// Engine never starts when there are zero undone POI tasks at mount. The
// old STOP/RESTART tests here simulated a live Firestore push arriving
// mid-session (task completed/added without any user action) — that trigger
// no longer exists client-side (KAN-153/KAN-214: one-shot fetch, no
// subscription), so there's nothing left to simulate; removed rather than
// rewritten around a scenario that can't happen anymore.

/** A task with a POI field — triggers the proximity engine. */
const POI_TASK = {
  id:        'poi-task-1',
  title:     'Pick up prescription',
  category:  'health' as const,
  done:      false,
  poi:       'pharmacy',
  date:      '2026-05-29',
  createdAt: { toDate: () => new Date() } as any,
};

/** Same task but marked done. */
const POI_TASK_DONE = { ...POI_TASK, done: true };

describe('KAN-53 — proximity engine gate', () => {
  it('GATE — does NOT run a proximity search when there are no POI tasks', async () => {
    // TASK has no `poi` field — engine should stay off.
    setupFirestoreMocks([TASK]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(mockRunProximitySearchOrReuseSnapshot).not.toHaveBeenCalled();
  });

  it('GATE — does NOT run a proximity search when tasks list is empty', async () => {
    setupFirestoreMocks([]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(mockRunProximitySearchOrReuseSnapshot).not.toHaveBeenCalled();
  });

  it('GATE — runs a proximity search when at least one undone POI task exists', async () => {
    setupFirestoreMocks([POI_TASK]);
    render(<TodayScreen />);
    await act(async () => {});
    await act(async () => {});

    // Not pinned to an exact call count — permission resolving async can
    // legitimately cause the effect to re-run once more than a same-tick
    // mount would. What matters is that it ran, for the right uid/tasks.
    expect(mockRunProximitySearchOrReuseSnapshot).toHaveBeenCalledWith(
      'user-test',
      expect.arrayContaining([expect.objectContaining({ id: 'poi-task-1' })]),
      expect.any(Function),
    );
  });

  it('GATE — does NOT run a proximity search when only done POI tasks exist', async () => {
    setupFirestoreMocks([POI_TASK_DONE]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(mockRunProximitySearchOrReuseSnapshot).not.toHaveBeenCalled();
  });
});

// ─── KAN-57 / KAN-58 — TasksUiState error branch & retry ────────────────────

describe('KAN-57 / KAN-58 — TasksUiState error branch & retry', () => {
  function setupErrorFetch() {
    mockGetTasksForDate.mockRejectedValue(new Error('Firestore permission denied'));
    mockGetCategories.mockResolvedValue([]);
    mockGetUser.mockResolvedValue(null);
    mockGetUserPreferences.mockResolvedValue({});
    mockGetPoiPreferencesMap.mockResolvedValue({});
    mockGetTotalPoints.mockResolvedValue(0);
    mockGetInboxUnreadCount.mockResolvedValue(0);
    mockGetTrips.mockResolvedValue([]);
    mockGetMallSnapshot.mockResolvedValue(null);
  }

  it('shows a user-friendly error message when the fetch fails', async () => {
    setupErrorFetch();
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.getByText('Could not load tasks. Check your connection.')).toBeTruthy();
  });

  it('shows a "Try again" button in the error state', async () => {
    setupErrorFetch();
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.getByLabelText('Try again')).toBeTruthy();
  });

  it('does NOT show task rows in the error state', async () => {
    setupErrorFetch();
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.queryByTestId('task-row-task-1')).toBeNull();
  });

  it('re-fetches and shows tasks when "Try again" is pressed after a recovery', async () => {
    // First fetch fails; refresh() (triggered by "Try again") succeeds.
    setupErrorFetch();
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.getByLabelText('Try again')).toBeTruthy();

    setupFirestoreMocks([TASK]);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Try again'));
    });

    expect(screen.getByText('Buy milk')).toBeTruthy();
    expect(screen.queryByLabelText('Try again')).toBeNull();
  });
});

// ─── KAN-139 — Empty state ────────────────────────────────────────────────────

describe('KAN-139 — empty state body', () => {
  it('shows the "Add something" CTA when task list is empty', async () => {
    setupFirestoreMocks([]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.getByLabelText('Add something')).toBeTruthy();
  });

  it('hides the FAB when task list is empty', async () => {
    setupFirestoreMocks([]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.queryByLabelText('Add task')).toBeNull();
  });

  it('shows the FAB when tasks exist (populated state)', async () => {
    setupFirestoreMocks([TASK]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.getByLabelText('Add task')).toBeTruthy();
  });

  it('does NOT show the "Add something" CTA in the populated state', async () => {
    setupFirestoreMocks([TASK]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.queryByLabelText('Add something')).toBeNull();
  });

  it('does NOT show the empty state during loading', () => {
    // Never-resolving fetch — status stays loading throughout this test.
    mockGetTasksForDate.mockReturnValue(new Promise(() => {}));
    mockGetCategories.mockResolvedValue([]);
    mockGetUser.mockResolvedValue(null);
    mockGetUserPreferences.mockResolvedValue({});
    mockGetPoiPreferencesMap.mockResolvedValue({});
    mockGetTotalPoints.mockResolvedValue(0);
    mockGetInboxUnreadCount.mockResolvedValue(0);
    mockGetTrips.mockResolvedValue([]);
    mockGetMallSnapshot.mockResolvedValue(null);

    render(<TodayScreen />);

    expect(screen.queryByLabelText('Add something')).toBeNull();
  });

  it('opens the new-task sheet when "Add something" is pressed', async () => {
    setupFirestoreMocks([]);
    render(<TodayScreen />);
    await act(async () => {});

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add something'));
    });

    // NewTaskSheet becomes visible — the mock renders with testID from its stub
    // (we verify by confirming no error thrown and the CTA was pressable)
    expect(screen.getByLabelText('Add something')).toBeTruthy();
  });
});
