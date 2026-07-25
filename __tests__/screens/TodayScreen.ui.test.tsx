/**
 * KAN-60 — TodayScreen UI-layer tests.
 *
 * Mocks useTodayScreen so we test the screen's rendering contract, not the
 * hook's data-fetching internals (those are covered in useTodayScreen.test.ts).
 *
 * Covers:
 *   - Task titles shown in success state
 *   - "No tasks for today" shown when success + empty list
 *   - Error message shown in error state
 *   - "Try again" button present in error state
 *   - Pressing "Try again" calls refresh
 *   - Pressing a task row calls handleToggle
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// ─── Mock useTodayScreen ──────────────────────────────────────────────────────

const mockHandleToggle = jest.fn();
const mockRefresh = jest.fn().mockResolvedValue(undefined);
const mockRefreshProximity = jest.fn().mockResolvedValue(true);

const DEFAULT_HOOK_RETURN = {
  tasks:                   [],
  isLoading:               true,
  isRefreshing:            false,
  error:                   null,
  refresh:                 mockRefresh,
  nearbyPoiType:           null,
  nearbyReady:             false,
  nearbyPlace:             null,
  poiPlaces:               {},
  placeContext:            null,
  storeTuningActive:       false,
  showStoreTuningPrompt:   false,
  onStoreTuningTurnOn:     jest.fn(),
  onStoreTuningNotNow:     jest.fn(),
  refreshProximity:        mockRefreshProximity,
  locationUnavailable:     false,
  sheetVisible:            false,
  setSheetVisible:         jest.fn(),
  customCategories:        [],
  totalTasks:              0,
  doneTasks:               0,
  progress:                0,
  nearbyCount:             0,
  totalPoints:             0,
  inboxCount:              0,
  socialUnreadCount:       0,
  handleToggle:            mockHandleToggle,
  permissionGranted:       false,
  errandBundle:            null,
  errandBundleLeisure:     null,
  dismissErrandBundle:     jest.fn(),
  tripSuggestion:          null,
  dismissTripSuggestion:   jest.fn(),
};

jest.mock('../../src/hooks/useTodayScreen', () => ({
  useTodayScreen: () => mockHookReturn,
}));

jest.mock('../../src/services/sharing', () => ({
  subscribeToIncomingSharedTasks: jest.fn(() => jest.fn()),
}));

let mockHookReturn: any = { ...DEFAULT_HOOK_RETURN };

// ─── Auth ─────────────────────────────────────────────────────────────────────

jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => ({ currentUser: { uid: 'u1', displayName: 'Test', email: 'test@test.com' } }),
}));
jest.mock('@react-native-firebase/auth', () => ({}));

// ─── Navigation ───────────────────────────────────────────────────────────────

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (fn: () => void) => fn(),
  useNavigation: () => ({ navigate: jest.fn(), push: jest.fn() }),
}));
jest.mock('@react-navigation/native-stack', () => ({}));

// ─── Theme ────────────────────────────────────────────────────────────────────

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff', surface: '#f6f5f1', surface2: '#efeeea',
      text: '#000', muted: '#999', faint: '#ccc',
      line: '#ddd', accent: '#e8a86a', onAccent: '#000', scrim: 'rgba(0,0,0,0.2)',
      ringTrack: '#ddd', ringFill: '#000',
      nearTint: '#fff', nearTint2: '#eee', nearBorder: '#ddd', nearText: '#000',
    },
    language: 'en',
  }),
}));

// ─── Safe area ────────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));

// ─── Reanimated ───────────────────────────────────────────────────────────────

jest.mock('react-native-reanimated', () => {
  const { View, ScrollView, FlatList } = require('react-native');
  const noop = () => {};
  const Animated = { View, ScrollView, FlatList, createAnimatedComponent: (c: unknown) => c };
  return {
    __esModule: true,
    default:                  Animated,
    useSharedValue:           (v: unknown) => ({ value: v }),
    useDerivedValue:          (fn: () => unknown) => ({ value: fn() }),
    useAnimatedStyle:         () => ({}),
    useAnimatedScrollHandler: () => noop,
    useAnimatedReaction:      noop,
    withTiming:               (v: unknown) => v,
    withRepeat:               (v: unknown) => v,
    withSequence:             (...args: unknown[]) => args[0],
    interpolate:              (_v: unknown, _i: unknown[], o: unknown[]) => o[0],
    Easing:                   { inOut: () => noop, cubic: noop },
    Extrapolation:            { CLAMP: 'clamp' },
    runOnJS:                  (fn: (...args: unknown[]) => unknown) => fn,
  };
});

// ─── Heavy component stubs ────────────────────────────────────────────────────

jest.mock('../../src/components/Header',                () => () => null);
jest.mock('../../src/components/ProgressRing',          () => () => null);
jest.mock('../../src/components/NearbyCard',            () => () => null);
jest.mock('../../src/components/NetworkBanner',         () => () => null);
jest.mock('../../src/components/ContextChip',           () => () => null);
jest.mock('../../src/components/ErrandBundleCard',      () => () => null);
jest.mock('../../src/components/TripSuggestionCard',    () => () => null);
jest.mock('../../src/components/StoreTuningPromptSheet',() => ({ __esModule: true, default: () => null }));
jest.mock('../../src/components/NewTaskSheet', () => {
  const { forwardRef } = require('react');
  return { __esModule: true, default: forwardRef(() => null) };
});

// TaskRow stub — renders task title as a pressable so interaction tests work
jest.mock('../../src/components/TaskRow', () => {
  const { TouchableOpacity, Text } = require('react-native');
  return function MockTaskRow({ task, onToggle }: any) {
    return (
      <TouchableOpacity testID={`task-row-${task.id}`} onPress={() => onToggle(task.id, !task.done)}>
        <Text>{task.title}</Text>
      </TouchableOpacity>
    );
  };
});

jest.mock('../../src/components/AppIcon', () => ({
  ChevronRightIcon: () => null,
  NavigateIcon:     () => null,
  PlusIcon:         () => null,
}));

// ─── Import (after mocks) ─────────────────────────────────────────────────────

import TodayScreen from '../../src/screens/TodayScreen';

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockRefresh.mockResolvedValue(undefined);
  mockRefreshProximity.mockResolvedValue(true);
  mockHookReturn = { ...DEFAULT_HOOK_RETURN };
});

describe('TodayScreen UI — KAN-60 success state', () => {
  const TASK = {
    id: 'task-1', title: 'Buy milk', category: 'errands',
    done: false, date: '2026-06-01', createdAt: { toDate: () => new Date() } as any,
  };

  beforeEach(() => {
    mockHookReturn = {
      ...DEFAULT_HOOK_RETURN,
      isLoading:     false,
      tasks:         [TASK],
      totalTasks:    1,
    };
  });

  it('renders the task title in success state', () => {
    render(<TodayScreen />);
    expect(screen.getByText('Buy milk')).toBeTruthy();
  });

  it('does NOT render the error message in success state', () => {
    render(<TodayScreen />);
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
});

describe('TodayScreen UI — KAN-60 empty success state', () => {
  beforeEach(() => {
    mockHookReturn = { ...DEFAULT_HOOK_RETURN, isLoading: false, tasks: [] };
  });

  it('shows an empty-state prompt when success state has no tasks', () => {
    render(<TodayScreen />);
    expect(screen.getByText('Nothing on today. That doesn’t mean nothing matters.')).toBeTruthy();
  });
});

describe('TodayScreen UI — KAN-60 error state', () => {
  beforeEach(() => {
    mockHookReturn = {
      ...DEFAULT_HOOK_RETURN,
      isLoading: false,
      error: 'Could not load tasks. Check your connection.',
    };
  });

  it('renders the error message', () => {
    render(<TodayScreen />);
    expect(screen.getByText('Could not load tasks. Check your connection.')).toBeTruthy();
  });

  it('renders the "Try again" button', () => {
    render(<TodayScreen />);
    expect(screen.getByLabelText('Try again')).toBeTruthy();
  });

  it('does NOT render task rows in error state', () => {
    render(<TodayScreen />);
    expect(screen.queryByTestId('task-row-task-1')).toBeNull();
  });

  it('calls refresh when "Try again" is pressed', async () => {
    render(<TodayScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Try again'));
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('TodayScreen UI — KAN-300 list header', () => {
  const TASK = {
    id: 'task-1', title: 'Buy milk', category: 'errands',
    done: false, date: '2026-06-01', createdAt: { toDate: () => new Date() } as any,
  };

  beforeEach(() => {
    mockHookReturn = {
      ...DEFAULT_HOOK_RETURN,
      isLoading:  false,
      tasks:      [TASK],
      totalTasks: 1,
    };
  });

  it('renames the list and removes the inline done/total count', () => {
    render(<TodayScreen />);
    expect(screen.getByText('WHAT I NEED')).toBeTruthy();
    expect(screen.queryByText('0/1')).toBeNull();
  });

});

describe('TodayScreen UI — KAN-60 interaction', () => {
  const TASK = {
    id: 'task-1', title: 'Buy milk', category: 'errands',
    done: false, date: '2026-06-01', createdAt: { toDate: () => new Date() } as any,
  };

  beforeEach(() => {
    mockHookReturn = {
      ...DEFAULT_HOOK_RETURN,
      isLoading:     false,
      tasks:         [TASK],
      totalTasks:    1,
    };
  });

  it('calls handleToggle when a task row is pressed', async () => {
    render(<TodayScreen />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('task-row-task-1'));
    });
    expect(mockHandleToggle).toHaveBeenCalledWith('task-1', true);
  });
});
