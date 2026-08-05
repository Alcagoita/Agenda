/**
 * KAN-119 — handleGeofenceExit: outdoor exit-prompt logic.
 *
 * Verifies:
 *  - no-op when exitPromptEnabled is false
 *  - no-op when geofenceId has no recorded entry time
 *  - no-op when dwell time < 5 minutes
 *  - no-op when no undone task matches the POI type
 *  - no-op when exitPromptSeenDate matches today
 *  - fires exit prompt and marks seen when all conditions are met
 *  - stores the correct geofence ID key in entry times
 */

import {
  handleGeofenceExit,
  updateExitPromptPref,
  __setGeofenceEntryTime,
  __clearGeofenceEntryTimes,
} from '../../src/services/proximity';
import { todayISO } from '../../src/utils/date';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFireExitPrompt   = jest.fn().mockResolvedValue(undefined);
const mockMarkExitSeen     = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/services/notifications', () => ({
  ...jest.requireActual('../../src/services/notifications'),
  fireExitPrompt: (...args: any[]) => mockFireExitPrompt(...args),
}));

jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);

// KAN-228 — proximity.ts now fire-and-forgets into the habitat cache, which
// pulls in expo-sqlite (ESM, breaks Jest's transform). Not under test here.
jest.mock('../../src/services/habitatCache');
jest.mock('../../src/services/proximitySnapshot');

jest.mock('../../src/services/firestore', () => ({
  markExitPromptSeen: (...args: any[]) => mockMarkExitSeen(...args),
  // Stub other firestore helpers that proximity.ts imports
  getUserPreferences:             jest.fn().mockResolvedValue({}),
  subscribeToUserPreferences:     jest.fn(() => () => {}),
  getUser:                        jest.fn().mockResolvedValue(null),
  updateUserPreferences:          jest.fn().mockResolvedValue(undefined),
  markLastOpenedAt:               jest.fn().mockResolvedValue(undefined),
  subscribeToTasksForDate:        jest.fn(() => () => {}),
  subscribeToCurrentStreak:       jest.fn(() => () => {}),
  getWeeklyCompletedCount:        jest.fn().mockResolvedValue(0),
  markStoreAlertSeen:             jest.fn().mockResolvedValue(undefined),
  setTaskDone:                    jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/maps', () => ({
  searchNearbyPlaces:  jest.fn().mockResolvedValue([]),
  getDistanceMeters:   jest.fn().mockReturnValue(0),
}));

jest.mock('../../src/services/geolocation', () => ({
  startTracking:            jest.fn(),
  stopTracking:             jest.fn(),
  getCurrentPosition:       jest.fn().mockResolvedValue({ lat: 0, lng: 0, accuracy: 5 }),
  getPositionLowAccuracy:   jest.fn().mockResolvedValue({ lat: 0, lng: 0, accuracy: 10 }),
  requestLocationPermission: jest.fn().mockResolvedValue('granted'),
}));

jest.mock('react-native', () => ({
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  })),
  NativeModules: { BrushGeofenceModule: {} },
  Platform: { OS: 'ios' },
  InteractionManager: { runAfterInteractions: (cb: () => void) => cb() },
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel:              jest.fn().mockResolvedValue(undefined),
    displayNotification:        jest.fn().mockResolvedValue(undefined),
    cancelNotification:         jest.fn().mockResolvedValue(undefined),
    setNotificationCategories:  jest.fn().mockResolvedValue(undefined),
    createTriggerNotification:  jest.fn().mockResolvedValue(undefined),
  },
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  AndroidVisibility: { PUBLIC: 1 },
  TriggerType: { TIMESTAMP: 0 },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

// handleGeofenceExit compares against todayISO() (local date) — matching
// that here, not a UTC toISOString() date, avoids a real bug: near local
// midnight in timezones ahead of UTC, the UTC date is still "yesterday",
// so exitPromptSeenDate === TODAY would wrongly fail to match and this
// test would flake depending on wall-clock time when it ran.
const TODAY = todayISO();
const UID   = 'uid-test-user';
const DWELL_OVER_5_MIN = Date.now() - 6 * 60 * 1000; // 6 minutes ago

function makeTask(overrides: Partial<{
  id: string;
  title: string;
  poi: string;
  done: boolean;
  exitPromptSeenDate: string;
}> = {}) {
  return {
    id:         'task-1',
    title:      'Buy groceries',
    category:   'errands' as const,
    done:       false,
    poi:        'supermarket' as const,
    date:       TODAY,
    createdAt:  { toDate: () => new Date() } as any,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  __clearGeofenceEntryTimes();
  // Re-enable exit prompt before each test
  updateExitPromptPref(true);
});

describe('handleGeofenceExit', () => {
  it('does nothing when exitPrompt preference is disabled', async () => {
    updateExitPromptPref(false);
    __setGeofenceEntryTime('brush_geo_supermarket_task-1', DWELL_OVER_5_MIN);

    await handleGeofenceExit('brush_geo_supermarket_task-1', UID, [makeTask()]);

    expect(mockFireExitPrompt).not.toHaveBeenCalled();
  });

  it('does nothing when there is no entry time for the geofence', async () => {
    // No entry time seeded
    await handleGeofenceExit('brush_geo_supermarket_task-1', UID, [makeTask()]);

    expect(mockFireExitPrompt).not.toHaveBeenCalled();
  });

  it('does nothing when dwell time is less than 5 minutes', async () => {
    // Only 2 minutes of dwell
    __setGeofenceEntryTime('brush_geo_supermarket_task-1', Date.now() - 2 * 60 * 1000);

    await handleGeofenceExit('brush_geo_supermarket_task-1', UID, [makeTask()]);

    expect(mockFireExitPrompt).not.toHaveBeenCalled();
  });

  it('does nothing when task is already done', async () => {
    __setGeofenceEntryTime('brush_geo_supermarket_task-1', DWELL_OVER_5_MIN);

    await handleGeofenceExit('brush_geo_supermarket_task-1', UID, [makeTask({ done: true })]);

    expect(mockFireExitPrompt).not.toHaveBeenCalled();
  });

  it('does nothing when exitPromptSeenDate matches today', async () => {
    __setGeofenceEntryTime('brush_geo_supermarket_task-1', DWELL_OVER_5_MIN);

    await handleGeofenceExit(
      'brush_geo_supermarket_task-1',
      UID,
      [makeTask({ exitPromptSeenDate: TODAY })],
    );

    expect(mockFireExitPrompt).not.toHaveBeenCalled();
  });

  it('does nothing when no task matches the POI type', async () => {
    __setGeofenceEntryTime('brush_geo_atm_task-2', DWELL_OVER_5_MIN);

    // Task is supermarket but geofence is atm
    await handleGeofenceExit('brush_geo_atm_task-2', UID, [makeTask({ poi: 'supermarket' as const })]);

    expect(mockFireExitPrompt).not.toHaveBeenCalled();
  });

  it('fires exit prompt when all conditions are met', async () => {
    __setGeofenceEntryTime('brush_geo_supermarket_task-1', DWELL_OVER_5_MIN);

    await handleGeofenceExit('brush_geo_supermarket_task-1', UID, [makeTask()]);

    expect(mockFireExitPrompt).toHaveBeenCalledTimes(1);
    const [opts] = mockFireExitPrompt.mock.calls[0];
    expect(opts.taskId).toBe('task-1');
    expect(opts.taskTitle).toBe('Buy groceries');
  });

  it('calls markExitPromptSeen after firing the prompt', async () => {
    __setGeofenceEntryTime('brush_geo_supermarket_task-1', DWELL_OVER_5_MIN);

    await handleGeofenceExit('brush_geo_supermarket_task-1', UID, [makeTask()]);

    expect(mockMarkExitSeen).toHaveBeenCalledTimes(1);
    expect(mockMarkExitSeen).toHaveBeenCalledWith(UID, 'task-1', TODAY);
  });

  it('clears entry time from map after processing exit', async () => {
    __setGeofenceEntryTime('brush_geo_supermarket_task-1', DWELL_OVER_5_MIN);

    await handleGeofenceExit('brush_geo_supermarket_task-1', UID, [makeTask()]);

    // Second call with same geofenceId: no entry time → no prompt
    mockFireExitPrompt.mockClear();
    await handleGeofenceExit('brush_geo_supermarket_task-1', UID, [makeTask()]);
    expect(mockFireExitPrompt).not.toHaveBeenCalled();
  });
});
