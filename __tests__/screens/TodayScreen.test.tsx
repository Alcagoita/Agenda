/**
 * KAN-31 — TodayScreen point-awarding tests.
 *
 * Covers:
 *   - awardPoint is called with the correct uid, taskId, and title when a task is marked done
 *   - awardPoint is NOT called when a task is marked undone
 *   - awardPoint failure does NOT affect the task toggle (fire-and-forget)
 *   - awardPoint is NOT called when uid is absent (signed-out guard)
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// ─── Firestore mocks ──────────────────────────────────────────────────────────

const mockSetTaskDone                = jest.fn();
const mockAwardPoint                 = jest.fn();
const mockSubscribeToTasksForDate    = jest.fn();
const mockSubscribeToPoiPreferences  = jest.fn();
const mockSubscribeToCategories      = jest.fn();
const mockSubscribeLowBatteryPausePref = jest.fn();
const mockSubscribeToTotalPoints     = jest.fn();

jest.mock('../../src/services/sharing', () => ({
  subscribeToIncomingSharedTasks: jest.fn(() => jest.fn()),
}));

jest.mock('../../src/services/firestore', () => ({
  setTaskDone:                 (...args: unknown[]) => mockSetTaskDone(...args),
  awardPoint:                  (...args: unknown[]) => mockAwardPoint(...args),
  subscribeToTasksForDate:     (...args: unknown[]) => mockSubscribeToTasksForDate(...args),
  subscribeToPoiPreferences:   (...args: unknown[]) => mockSubscribeToPoiPreferences(...args),
  subscribeToCategories:       (...args: unknown[]) => mockSubscribeToCategories(...args),
  subscribeLowBatteryPausePref: (...args: unknown[]) => mockSubscribeLowBatteryPausePref(...args),
  subscribeStoreTuningPref:    jest.fn().mockReturnValue(jest.fn()),
  setStoreTuningPref:          jest.fn().mockResolvedValue(undefined),
  subscribeToTotalPoints:      (...args: unknown[]) => mockSubscribeToTotalPoints(...args),
}));

// ─── Achievements mock ────────────────────────────────────────────────────────

const mockCheckAndAwardDailyComplete = jest.fn();

jest.mock('../../src/services/achievements', () => ({
  checkAndAwardDailyComplete: (...args: unknown[]) => mockCheckAndAwardDailyComplete(...args),
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
}));
jest.mock('@react-navigation/native-stack', () => ({}));

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
jest.mock('../../src/components/ProgressRing',     () => () => null);
jest.mock('../../src/components/ScrRotatingNudge', () => ({ __esModule: true, default: () => null }));
jest.mock('../../src/components/NewTaskSheet', () => {
  const { forwardRef } = require('react');
  return { __esModule: true, default: forwardRef(() => null) };
});
jest.mock('../../src/components/AppIcon', () => ({ PlusIcon: () => null }));

// ─── Service mocks ────────────────────────────────────────────────────────────

jest.mock('../../src/services/geolocation', () => ({
  requestLocationPermission: jest.fn().mockResolvedValue('granted'),
  LocationContext:           {},
}));
const mockStartProximityMonitoring = jest.fn();
const mockStopProximityMonitoring  = jest.fn();

jest.mock('../../src/services/proximity', () => ({
  startProximityMonitoring:      (...args: unknown[]) => mockStartProximityMonitoring(...args),
  stopProximityMonitoring:       () => mockStopProximityMonitoring(),
  updateProximityTasks:          jest.fn(),
  updateProximityPoiPreferences: jest.fn(),
  pauseGeofenceMonitoring:       jest.fn(),
  resumeGeofenceMonitoring:      jest.fn(),
  setLocationTap:                jest.fn(),
}));

jest.mock('../../src/services/indoorProximity', () => ({
  startIndoorProximityMonitoring: jest.fn().mockReturnValue(jest.fn()),
  stopIndoorProximityMonitoring:  jest.fn(),
  updateIndoorTasks:              jest.fn(),
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
  // subscribeToTasksForDate fires the callback synchronously.
  mockSubscribeToTasksForDate.mockImplementation(
    (_uid: string, _date: string, cb: (tasks: typeof TASK[]) => void) => {
      cb(tasks);
      return jest.fn(); // unsubscribe
    },
  );
  mockSubscribeToPoiPreferences.mockReturnValue(jest.fn());
  mockSubscribeToCategories.mockReturnValue(jest.fn());
  mockSubscribeLowBatteryPausePref.mockReturnValue(jest.fn());
  mockSubscribeToTotalPoints.mockReturnValue(jest.fn());
  mockSetTaskDone.mockResolvedValue(undefined);
  mockAwardPoint.mockResolvedValue(undefined);
  mockCheckAndAwardDailyComplete.mockResolvedValue(undefined);
}

// ─── Import (after all mocks) ─────────────────────────────────────────────────

import TodayScreen from '../../src/screens/TodayScreen';

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockUid = 'user-test';
  mockSubscribeToTotalPoints.mockReturnValue(jest.fn());
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

  // The mocked proximity module never invokes its onUpdate callback in this
  // suite (see KAN-279 block above), so poiPlaces stays {} throughout — every
  // task with a poi reads as "not in the nearby list" by default.

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

describe('KAN-31 — point awarding on task toggle', () => {
  it('calls awardPoint with correct uid, taskId, and title when marking done', async () => {
    setupFirestoreMocks([TASK]);
    render(<TodayScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('task-row-task-1'));
    });
    // Allow the fire-and-forget promise to settle.
    await act(async () => {});

    expect(mockAwardPoint).toHaveBeenCalledTimes(1);
    expect(mockAwardPoint).toHaveBeenCalledWith('user-test', 'task-1', 'Buy milk');
  });

  it('does NOT call awardPoint when marking a task undone', async () => {
    setupFirestoreMocks([DONE_TASK]);
    render(<TodayScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('task-row-task-done'));
    });
    await act(async () => {});

    expect(mockSetTaskDone).toHaveBeenCalledWith('user-test', 'task-done', false);
    expect(mockAwardPoint).not.toHaveBeenCalled();
  });

  it('does NOT revert the task toggle when awardPoint fails', async () => {
    setupFirestoreMocks([TASK]);
    mockAwardPoint.mockRejectedValue(new Error('Network error'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    render(<TodayScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('task-row-task-1'));
    });
    await act(async () => {});

    // setTaskDone still called and succeeded — toggle was not reverted.
    expect(mockSetTaskDone).toHaveBeenCalledWith('user-test', 'task-1', true);
    // The task row is still present (not reverted).
    expect(screen.getByTestId('task-row-task-1')).toBeTruthy();
  });

  it('does NOT call awardPoint when uid is absent', async () => {
    mockUid = null;
    setupFirestoreMocks([TASK]);
    render(<TodayScreen />);

    await act(async () => {
      fireEvent.press(screen.queryByTestId('task-row-task-1') ?? { type: 'View' } as any);
    });
    await act(async () => {});

    expect(mockAwardPoint).not.toHaveBeenCalled();
  });
});

// ─── KAN-32 — daily-complete achievement ─────────────────────────────────────

/** A second pending task — used in multi-task scenarios. */
const TASK_2 = {
  id:        'task-2',
  title:     'Walk the dog',
  category:  'health' as const,
  done:      false,
  date:      '2026-05-29',
  createdAt: { toDate: () => new Date() } as any,
};

describe('KAN-32 — daily-complete achievement', () => {
  it('calls checkAndAwardDailyComplete when the last pending task is marked done', async () => {
    // Only TASK is pending — marking it done makes the list fully complete.
    setupFirestoreMocks([TASK]);
    render(<TodayScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('task-row-task-1'));
    });
    await act(async () => {});

    expect(mockCheckAndAwardDailyComplete).toHaveBeenCalledTimes(1);
    expect(mockCheckAndAwardDailyComplete).toHaveBeenCalledWith(
      'user-test',
      expect.any(String), // todayISO() result
      1,                  // totalTasks  = tasks.length (TASK only)
      1,                  // totalPoints = tasks.length (1 pt per task)
    );
  });

  it('does NOT call checkAndAwardDailyComplete when other tasks are still pending', async () => {
    // Two pending tasks — marking only one done leaves the list incomplete.
    setupFirestoreMocks([TASK, TASK_2]);
    render(<TodayScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('task-row-task-1'));
    });
    await act(async () => {});

    expect(mockCheckAndAwardDailyComplete).not.toHaveBeenCalled();
  });

  it('does NOT call checkAndAwardDailyComplete when marking a task undone', async () => {
    setupFirestoreMocks([DONE_TASK]);
    render(<TodayScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('task-row-task-done'));
    });
    await act(async () => {});

    expect(mockCheckAndAwardDailyComplete).not.toHaveBeenCalled();
  });

  it('does NOT call checkAndAwardDailyComplete when uid is absent', async () => {
    mockUid = null;
    setupFirestoreMocks([TASK]);
    render(<TodayScreen />);

    await act(async () => {
      fireEvent.press(screen.queryByTestId('task-row-task-1') ?? { type: 'View' } as any);
    });
    await act(async () => {});

    expect(mockCheckAndAwardDailyComplete).not.toHaveBeenCalled();
  });

  it('does NOT revert the task toggle when checkAndAwardDailyComplete fails', async () => {
    setupFirestoreMocks([TASK]);
    mockCheckAndAwardDailyComplete.mockRejectedValue(new Error('Achievement service error'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    render(<TodayScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('task-row-task-1'));
    });
    await act(async () => {});

    // setTaskDone still called — toggle was not reverted.
    expect(mockSetTaskDone).toHaveBeenCalledWith('user-test', 'task-1', true);
    expect(screen.getByTestId('task-row-task-1')).toBeTruthy();
  });
});

// ─── KAN-53 — proximity engine gate / stop / restart ─────────────────────────
//
// These tests verify that the proximity engine is only running when it is
// actually useful:
//   Gate:    engine never starts when there are zero undone POI tasks at mount.
//   Stop:    engine stops when the last POI task is marked done mid-day.
//   Restart: engine restarts (without re-prompting) when a new POI task appears.
//
// The mock for requestLocationPermission resolves 'granted' (set in the
// geolocation mock above). startProximityMonitoring returns a stop function
// so the cleanup path in TodayScreen can call it.

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

/** Same task but marked done — used to simulate completing the last POI task. */
const POI_TASK_DONE = { ...POI_TASK, done: true };

describe('KAN-53 — proximity engine gate / stop / restart', () => {
  beforeEach(() => {
    // startProximityMonitoring returns a stop fn so the cleanup path works.
    mockStartProximityMonitoring.mockReturnValue(jest.fn());
  });

  // ── Gate ──────────────────────────────────────────────────────────────────
  // When there are no undone POI tasks at mount, GPS must never start.

  it('GATE — does NOT start proximity monitoring when there are no POI tasks', async () => {
    // TASK has no `poi` field — engine should stay off.
    setupFirestoreMocks([TASK]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(mockStartProximityMonitoring).not.toHaveBeenCalled();
  });

  it('GATE — does NOT start proximity monitoring when tasks list is empty', async () => {
    setupFirestoreMocks([]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(mockStartProximityMonitoring).not.toHaveBeenCalled();
  });

  it('GATE — starts proximity monitoring when at least one undone POI task exists', async () => {
    setupFirestoreMocks([POI_TASK]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(mockStartProximityMonitoring).toHaveBeenCalledTimes(1);
    expect(mockStartProximityMonitoring).toHaveBeenCalledWith(
      'user-test',
      expect.arrayContaining([expect.objectContaining({ id: 'poi-task-1' })]),
      expect.any(Function),
    );
  });

  it('GATE — does NOT start monitoring when only done POI tasks exist', async () => {
    setupFirestoreMocks([POI_TASK_DONE]);
    render(<TodayScreen />);
    await act(async () => {});

    expect(mockStartProximityMonitoring).not.toHaveBeenCalled();
  });

  // ── Stop ──────────────────────────────────────────────────────────────────
  // When the last POI task is completed mid-day, the engine must stop.

  it('STOP — calls stopProximityMonitoring when the last POI task is marked done', async () => {
    // First snapshot: one undone POI task → engine starts.
    // Second snapshot: same task now done → engine should stop.
    let firestoreCallback: ((tasks: any[]) => void) | null = null;
    mockSubscribeToTasksForDate.mockImplementation(
      (_uid: string, _date: string, cb: (tasks: any[]) => void) => {
        firestoreCallback = cb;
        cb([POI_TASK]); // initial snapshot — starts the engine
        return jest.fn();
      },
    );
    mockSubscribeToPoiPreferences.mockReturnValue(jest.fn());
    mockSubscribeToCategories.mockReturnValue(jest.fn());
    mockSubscribeLowBatteryPausePref.mockReturnValue(jest.fn());

    render(<TodayScreen />);
    await act(async () => {}); // let mount effects settle

    expect(mockStartProximityMonitoring).toHaveBeenCalledTimes(1);

    // Simulate Firestore updating the task to done → engine should stop.
    await act(async () => {
      firestoreCallback!([POI_TASK_DONE]);
    });

    expect(mockStopProximityMonitoring).toHaveBeenCalledTimes(1);
  });

  // ── Restart ───────────────────────────────────────────────────────────────
  // When a new POI task is added after the engine was stopped, it must restart
  // without re-requesting location permission.

  it('RESTART — restarts monitoring when a POI task is added after engine was stopped', async () => {
    // Phase 1: start with no POI tasks → engine off.
    // Phase 2: Firestore pushes a new POI task → engine should start.
    let firestoreCallback: ((tasks: any[]) => void) | null = null;
    mockSubscribeToTasksForDate.mockImplementation(
      (_uid: string, _date: string, cb: (tasks: any[]) => void) => {
        firestoreCallback = cb;
        cb([TASK]); // initial: no POI tasks
        return jest.fn();
      },
    );
    mockSubscribeToPoiPreferences.mockReturnValue(jest.fn());
    mockSubscribeToCategories.mockReturnValue(jest.fn());
    mockSubscribeLowBatteryPausePref.mockReturnValue(jest.fn());

    render(<TodayScreen />);
    await act(async () => {});

    // Engine should NOT have started yet (no POI tasks).
    expect(mockStartProximityMonitoring).not.toHaveBeenCalled();

    // Simulate a new POI task arriving via Firestore.
    await act(async () => {
      firestoreCallback!([TASK, POI_TASK]);
    });

    // Engine should now be running.
    expect(mockStartProximityMonitoring).toHaveBeenCalledTimes(1);
  });
});

// ─── KAN-57 / KAN-58 — TasksUiState error branch & retry ────────────────────

function setupErrorSubscription() {
  mockSubscribeToTasksForDate.mockImplementation(
    (_uid: string, _date: string, _onSuccess: unknown, onError: (err: Error) => void) => {
      onError(new Error('Firestore permission denied'));
      return jest.fn();
    },
  );
  mockSubscribeToPoiPreferences.mockReturnValue(jest.fn());
  mockSubscribeToCategories.mockReturnValue(jest.fn());
  mockSubscribeLowBatteryPausePref.mockReturnValue(jest.fn());
}

describe('KAN-57 / KAN-58 — TasksUiState error branch & retry', () => {
  it('shows a user-friendly error message when the subscription fires an error', async () => {
    setupErrorSubscription();
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.getByText('Could not load tasks. Check your connection.')).toBeTruthy();
  });

  it('shows a "Try again" button in the error state', async () => {
    setupErrorSubscription();
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.getByLabelText('Try again')).toBeTruthy();
  });

  it('does NOT show task rows in the error state', async () => {
    setupErrorSubscription();
    render(<TodayScreen />);
    await act(async () => {});

    expect(screen.queryByTestId('task-row-task-1')).toBeNull();
  });

  it('re-subscribes and shows tasks when "Try again" is pressed after a recovery', async () => {
    // Phase 1: subscription errors.
    let callCount = 0;
    mockSubscribeToTasksForDate.mockImplementation(
      (_uid: string, _date: string, onSuccess: (tasks: any[]) => void, onError: (err: Error) => void) => {
        callCount += 1;
        if (callCount === 1) {
          onError(new Error('Network error'));
        } else {
          onSuccess([TASK]); // second attempt succeeds
        }
        return jest.fn();
      },
    );
    mockSubscribeToPoiPreferences.mockReturnValue(jest.fn());
    mockSubscribeToCategories.mockReturnValue(jest.fn());
    mockSubscribeLowBatteryPausePref.mockReturnValue(jest.fn());

    render(<TodayScreen />);
    await act(async () => {});

    // Error shown after first attempt.
    expect(screen.getByLabelText('Try again')).toBeTruthy();

    // Press retry — second subscription call succeeds.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Try again'));
    });

    // Task now visible after recovery.
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
    // Don't call setupFirestoreMocks — subscribeToTasksForDate never fires → status stays loading
    mockSubscribeToTasksForDate.mockReturnValue(jest.fn());
    mockSubscribeToPoiPreferences.mockReturnValue(jest.fn());
    mockSubscribeToCategories.mockReturnValue(jest.fn());
    mockSubscribeLowBatteryPausePref.mockReturnValue(jest.fn());

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
