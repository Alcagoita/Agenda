/**
 * Unit tests for src/screens/TaskFormScreen.tsx — KAN-143
 *
 * Covers:
 *   - Render: create mode (heading, POI grid, category pills, helper text)
 *   - Render: edit mode (pre-populated title, "Save changes" label)
 *   - canSubmit: button disabled until title + POI both provided
 *   - POI quick-pick: selecting/deselecting tiles
 *   - Save (create): calls addTask with correct payload, navigates back
 *   - Save (edit): calls updateTask, navigates back
 *   - Delete: edit mode only, requires Alert confirmation
 *   - Go back: calls navigation.goBack
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Keyboard, ScrollView, StyleSheet } from 'react-native';
import type { Alert as AlertType } from 'react-native';
import TaskFormScreen from '../../src/screens/TaskFormScreen';
import { COPY } from '../../src/constants/copy';
import { todayISO } from '../../src/utils/date';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockAddTask               = jest.fn();
const mockUpdateTask            = jest.fn();
const mockDeleteTask            = jest.fn();
const mockAddCategory           = jest.fn();
const mockSubscribeToCategories = jest.fn(() => jest.fn());
const mockGoBack                = jest.fn();
const mockInferPoiForQuickAdd   = jest.fn();
const mockLearnFromUserEdit     = jest.fn();

const mockGetCategories = jest.fn().mockResolvedValue([]);

jest.mock('../../src/services/firestore', () => ({
  addTask:               jest.fn((...args: unknown[]) => mockAddTask(...args)),
  updateTask:            jest.fn((...args: unknown[]) => mockUpdateTask(...args)),
  deleteTask:            jest.fn((...args: unknown[]) => mockDeleteTask(...args)),
  addCategory:           jest.fn((...args: unknown[]) => mockAddCategory(...args)),
  subscribeToCategories: jest.fn((...args: unknown[]) => mockSubscribeToCategories(...args)),
  getCategories:         jest.fn((...args: unknown[]) => mockGetCategories(...args)),
}));

jest.mock('../../src/services/poiLlm', () => ({
  inferPoiForQuickAdd: (...args: unknown[]) => mockInferPoiForQuickAdd(...args),
  learnFromUserEdit: (...args: unknown[]) => mockLearnFromUserEdit(...args),
}));

jest.mock('../../src/services/placesFunctions', () => ({
  getPlaceDetailsProxy: jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  searchNearbyPlacesProxy: jest.fn(),
  searchPlaceTypesProxy: jest.fn(),
}));
jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflareCoverageProxy: jest.fn(),
  cloudflarePoiAllProxy:   jest.fn(),
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn(() => ({
    execSync: jest.fn(),
    getFirstSync: jest.fn(),
    getAllSync: jest.fn(() => []),
    runSync: jest.fn(),
  })),
}));

// KAN-280 — notifications.ts transitively imports @notifee/react-native
// (native module, unavailable under Jest) — mocked at the service boundary,
// matching this suite's existing mocking style (see achievements.ts above).
const mockScheduleTaskReminder = jest.fn().mockResolvedValue(undefined);
const mockCancelTaskReminder   = jest.fn().mockResolvedValue(undefined);
const mockRefreshDatedTaskHandoff = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/notifications', () => ({
  scheduleTaskReminder: (...args: unknown[]) => mockScheduleTaskReminder(...args),
  cancelTaskReminder:   (...args: unknown[]) => mockCancelTaskReminder(...args),
}));
jest.mock('../../src/services/datedTaskHandoff', () => ({
  refreshDatedTaskHandoff: (...args: unknown[]) => mockRefreshDatedTaskHandoff(...args),
}));

// KAN-279 — mocked at the service boundary (same style as notifications/
// achievements above) rather than mocking takeMeThere.ts's own transitive
// deps (proximity.ts pulls in notifee/NetInfo/expo-sqlite, unavailable
// under Jest). poiSuggestions.ts (via poiTypeCache.ts) still needs the
// real services/maps/geolocation exports, so those are left unmocked here.
const mockIsTaskPoiFarAway     = jest.fn().mockReturnValue(false);
const mockOpenTakeMeThereMaps  = jest.fn().mockResolvedValue(undefined);
const mockGetTakeMeThereA11yLabel = jest.fn().mockReturnValue('Take me to a Pharmacy');
jest.mock('../../src/services/takeMeThere', () => ({
  isTaskPoiFarAway:        (...args: unknown[]) => mockIsTaskPoiFarAway(...args),
  openTakeMeThereMaps:     (...args: unknown[]) => mockOpenTakeMeThereMaps(...args),
  getTakeMeThereA11yLabel: (...args: unknown[]) => mockGetTakeMeThereA11yLabel(...args),
}));

// KAN-248 — deleteField is imported directly (not via the src/services/firestore
// barrel) to clear poi/kind when the birthday toggle flips. Mocked as a
// recognizable sentinel so tests can assert it was used without pulling in
// the real @react-native-firebase/firestore native module.
const DELETE_FIELD_SENTINEL = { _deleteField: true };
jest.mock('@react-native-firebase/firestore', () => ({
  deleteField: jest.fn(() => DELETE_FIELD_SENTINEL),
}));

// achievements.ts transitively imports @notifee/react-native (native module,
// unavailable under Jest) — mocked at the service boundary rather than the
// native module, matching this suite's existing mocking style.
jest.mock('../../src/services/achievements', () => ({
  evaluateAddTaskAchievement:   jest.fn().mockResolvedValue(undefined),
  evaluateCustomCatAchievement: jest.fn().mockResolvedValue(undefined),
}));

// CategoriesScreen exports CATEGORY_COLORS — provide a stub so the import resolves
jest.mock('../../src/screens/CategoriesScreen', () => ({
  CATEGORY_COLORS: ['#d4855a', '#e8a86a', '#5ba87a', '#5b7fd4', '#8b6bc4'],
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
  useRoute:      () => ({ params: mockRouteParams }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    dark: false,
    palette: {
      bg:         '#fdfdfb',
      surface:    '#f6f5f1',
      surface2:   '#efeeea',
      line:       'rgba(20,20,18,0.08)',
      text:       '#1a1a18',
      muted:      '#8a8a85',
      faint:      '#bdbdb7',
      accent:     '#e8a86a',
      nearTint:   '#fdf7f0',
      nearTint2:  '#f9ede0',
      nearBorder: '#e8c9a0',
      nearText:   '#7a4a20',
    },
  }),
}));

jest.mock('../../src/components/AppIcon', () => {
  const React = require('react');
  const { View } = require('react-native');
  const stub = (props: any) => React.createElement(View, props);
  return {
    CakeIcon:     stub,
    CalendarIcon: stub,
    ChevronLeftIcon: stub,
    ChevronRightIcon: stub,
    ClockIcon:    stub,
    CloseIcon:    stub,
    NavigateIcon: stub,
    PoiIcon:      stub,
  };
});

// ─── Route params helper ──────────────────────────────────────────────────────

type RouteParams = {
  uid: string;
  task?: any;
  initialDate?: string;
  initialTitle?: string;
  initialCategory?: string;
  initialPoi?: string;
  initialRestaurantFoodType?: string;
  initialStoreSubtype?: string;
  initialPoiBrand?: string;
  initialPoiExplicitlySelected?: boolean;
};

let mockRouteParams: RouteParams = { uid: 'user-123' };

function setRouteParams(params: RouteParams) {
  mockRouteParams = params;
}

// ─── Task factory ─────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<any> = {}) {
  return {
    id:        'task-1',
    title:     'Buy milk',
    category:  'errands',
    done:      false,
    poi:       'supermarket',
    date:      '2026-06-03', // legacy date: intentionally not treated as scheduled
    scheduledDate: '2026-06-03',
    createdAt: { seconds: 0, nanoseconds: 0 },
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockSubscribeToCategories.mockReturnValue(jest.fn()); // unsubscribe no-op
  mockInferPoiForQuickAdd.mockResolvedValue(null);
  mockLearnFromUserEdit.mockResolvedValue(undefined);
  setRouteParams({ uid: 'user-123' });
});

// ── Create mode ───────────────────────────────────────────────────────────────

describe('TaskFormScreen — create mode', () => {
  it('renders "What do you need?" heading', () => {
    render(<TaskFormScreen />);
    expect(screen.getByText('What do you need?')).toBeTruthy();
  });

  it('renders the title input', () => {
    render(<TaskFormScreen />);
    expect(screen.getByLabelText('What do you need?')).toBeTruthy();
  });

  it('renders POI quick-pick tiles (spot-check 6 of the 16)', () => {
    render(<TaskFormScreen />);
    expect(screen.getByText('ATM')).toBeTruthy();
    expect(screen.getByText('Café')).toBeTruthy();
    expect(screen.getByText('Market')).toBeTruthy();
    expect(screen.getByText('Pharmacy')).toBeTruthy();
    expect(screen.getByText('Gym')).toBeTruthy();
    expect(screen.getByText('Restaurant')).toBeTruthy();
  });

  it('renders all 4 built-in category pills', () => {
    render(<TaskFormScreen />);
    expect(screen.getByText('Work')).toBeTruthy();
    expect(screen.getByText('Health')).toBeTruthy();
    expect(screen.getByText('Errands')).toBeTruthy();
    expect(screen.getByText('Personal')).toBeTruthy();
  });

  it('shows the disabled helper text when canSubmit is false', () => {
    render(<TaskFormScreen />);
    expect(screen.getByText('Just the what and the where')).toBeTruthy();
  });

  it('"Add task" button is disabled by default', () => {
    render(<TaskFormScreen />);
    const btn = screen.getByLabelText('Add it');
    expect(btn.props.accessibilityState?.disabled).toBe(true);
  });
});

// ── Edit mode ────────────────────────────────────────────────────────────────

describe('TaskFormScreen — edit mode', () => {
  beforeEach(() => {
    setRouteParams({ uid: 'user-123', task: makeTask() });
  });

  it('renders "Edit task" heading', () => {
    render(<TaskFormScreen />);
    expect(screen.getByText('Edit task')).toBeTruthy();
  });

  it('pre-populates the title field', () => {
    render(<TaskFormScreen />);
    expect(
      screen.getByLabelText('Task title').props.value,
    ).toBe('Buy milk');
  });

  it('"Save changes" button is labeled correctly', () => {
    render(<TaskFormScreen />);
    expect(screen.getByLabelText('Save changes')).toBeTruthy();
  });

  it('shows "Ready to save" helper when both title and POI are already set', () => {
    render(<TaskFormScreen />);
    expect(screen.getByText('Ready to save')).toBeTruthy();
  });

  it('renders a non-catalog recommended POI in edit mode', () => {
    setRouteParams({
      uid:  'user-123',
      task: makeTask({ title: 'Visit police', poi: 'police' }),
    });

    render(<TaskFormScreen />);

    expect(screen.getByLabelText(`Police ${COPY.newTaskSheet.poiSuggestionConfirmedSuffix}`)).toBeTruthy();
    expect(screen.getByText('Police')).toBeTruthy();
  });

  it('updates the recommended POI from the dictionary while preserving the saved POI', async () => {
    jest.useFakeTimers();
    mockInferPoiForQuickAdd.mockResolvedValue('police');
    render(<TaskFormScreen />);

    fireEvent.changeText(screen.getByLabelText('Task title'), 'Visit police');

    await act(async () => {
      jest.advanceTimersByTime(350);
      await Promise.resolve();
    });

    let suggestion: ReturnType<typeof screen.getByLabelText>;
    await waitFor(() => {
      suggestion = screen.getByLabelText(`Police, ${COPY.newTaskSheet.poiSuggestionHint}`);
      expect(suggestion).toBeTruthy();
    });
    const suggestionStyle = StyleSheet.flatten(suggestion!.props.style);

    expect(suggestionStyle.backgroundColor).toBe('#fdf7f0');
    expect(suggestionStyle.borderColor).toBe('#e8c9a0');
    expect(suggestionStyle.borderStyle).toBe('dashed');
    expect(screen.getByText(COPY.newTaskSheet.poiSuggestionHint)).toBeTruthy();
    expect(screen.getByText('Market').parent?.parent?.props.accessibilityState?.selected).toBe(true);

    jest.useRealTimers();
  });

  it('pre-populates the notes field from existing description', () => {
    setRouteParams({
      uid:  'user-123',
      task: makeTask({ description: 'Remember to check expiry dates' }),
    });
    render(<TaskFormScreen />);
    expect(
      screen.getByPlaceholderText('Add a note, link, or reminder…').props.value,
    ).toBe('Remember to check expiry dates');
  });
});

// ── canSubmit logic ──────────────────────────────────────────────────────────

describe('TaskFormScreen — canSubmit', () => {
  it('enables "Add task" when title and POI are both provided', () => {
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('What do you need?'),
      'Groceries',
    );
    fireEvent.press(screen.getByText('Market'));
    expect(
      screen.getByLabelText('Add it').props.accessibilityState?.disabled,
    ).toBe(false);
  });

  it('keeps "Add task" disabled when title is set but POI is not', () => {
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('What do you need?'),
      'Groceries',
    );
    expect(
      screen.getByLabelText('Add it').props.accessibilityState?.disabled,
    ).toBe(true);
  });

  it('keeps "Add task" disabled when POI is set but title is empty', () => {
    render(<TaskFormScreen />);
    fireEvent.press(screen.getByText('ATM'));
    expect(
      screen.getByLabelText('Add it').props.accessibilityState?.disabled,
    ).toBe(true);
  });

  it('shows "Ready to add" helper once canSubmit is true', () => {
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('What do you need?'),
      'Get cash',
    );
    fireEvent.press(screen.getByText('ATM'));
    expect(screen.getByText('Ready to add')).toBeTruthy();
  });
});

// ── POI free-text type ────────────────────────────────────────────────────────

describe('TaskFormScreen — POI free-text type', () => {
  it('renders the POI type input with the correct placeholder', () => {
    render(<TaskFormScreen />);
    expect(screen.getByPlaceholderText('A café, a pharmacy, a gym…')).toBeTruthy();
  });

  it('shows Police in the local dropdown suggestions', () => {
    render(<TaskFormScreen />);

    fireEvent.changeText(
      screen.getByPlaceholderText('A café, a pharmacy, a gym…'),
      'Police',
    );

    expect(screen.getByText('Police')).toBeTruthy();
  });

  it.each([
    ['Financial service', 'Financial service'],
    ['Credit', 'Financial service'],
    ['Currency exchange', 'Currency exchange'],
    ['Money transfer', 'Money transfer'],
  ])('shows %s from the bundled local dictionary', (query, expectedLabel) => {
    render(<TaskFormScreen />);

    fireEvent.changeText(
      screen.getByPlaceholderText('A café, a pharmacy, a gym…'),
      query,
    );

    expect(screen.getByText(expectedLabel)).toBeTruthy();
  });

  it('adjusts the form scroll view for the keyboard', () => {
    render(<TaskFormScreen />);

    expect(screen.getByTestId('task-form-scroll').props.automaticallyAdjustKeyboardInsets).toBe(true);
  });

  it('enables submit when title + typed POI type are both set', () => {
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('What do you need?'),
      'Get a croissant',
    );
    fireEvent.changeText(
      screen.getByPlaceholderText('A café, a pharmacy, a gym…'),
      'bakery',
    );
    expect(
      screen.getByLabelText('Add it').props.accessibilityState?.disabled,
    ).toBe(false);
  });

  it('uses the typed type string as the poi in the addTask payload', async () => {
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('What do you need?'),
      'Pick up sushi',
    );
    fireEvent.changeText(
      screen.getByPlaceholderText('A café, a pharmacy, a gym…'),
      'sushi restaurant',
    );
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add it'));
    });
    await waitFor(() => {
      expect(mockAddTask).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ poi: 'sushi restaurant' }),
      );
    });
  });

  it('prefills a custom POI passed from the sheet', () => {
    setRouteParams({
      uid: 'user-123',
      initialTitle: 'Visit police',
      initialPoi: 'police',
      initialPoiExplicitlySelected: true,
    });

    render(<TaskFormScreen />);

    expect(screen.getByPlaceholderText('A café, a pharmacy, a gym…').props.value).toBe('Police');
    expect(screen.getByLabelText('Add it').props.accessibilityState?.disabled).toBe(false);
  });

  it('keeps an inferred initial poi reinferable during title edits', () => {
    setRouteParams({
      uid: 'user-123',
      initialTitle: 'Visit police',
      initialPoi: 'police',
      initialPoiExplicitlySelected: false,
    });

    render(<TaskFormScreen />);

    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Call mum');

    expect(screen.getByLabelText('Add it').props.accessibilityState?.disabled).toBe(true);
  });

  it('preserves an explicitly selected initial poi during title edits', () => {
    setRouteParams({
      uid: 'user-123',
      initialTitle: 'Visit police',
      initialPoi: 'police',
      initialPoiExplicitlySelected: true,
    });

    render(<TaskFormScreen />);

    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Call mum');

    expect(screen.getByLabelText('Add it').props.accessibilityState?.disabled).toBe(false);
  });

  it('auto-suggests a built-in poi from the title', async () => {
    mockInferPoiForQuickAdd.mockResolvedValue('pharmacy');
    render(<TaskFormScreen />);

    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'buy aspirin');

    await waitFor(() => {
      expect(screen.getByLabelText('Add it').props.accessibilityState?.disabled).toBe(false);
    });
  });

  it('shows the suggestion tile hint for an inferred guess', async () => {
    mockInferPoiForQuickAdd.mockResolvedValue('pharmacy');
    render(<TaskFormScreen />);

    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'buy aspirin');

    await waitFor(() => {
      expect(screen.getByText('my guess?')).toBeTruthy();
    });
  });

  it('keeps the selected recommendation dashed after confirmation', async () => {
    mockInferPoiForQuickAdd.mockResolvedValue('pharmacy');
    render(<TaskFormScreen />);

    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'buy aspirin');

    await waitFor(() => {
      expect(screen.getByLabelText('Pharmacy, my guess?')).toBeTruthy();
    });

    fireEvent.press(screen.getByLabelText('Pharmacy, my guess?'));

    const suggestion = screen.getByLabelText('Pharmacy suggestion');
    const suggestionStyle = StyleSheet.flatten(suggestion.props.style);

    expect(suggestion.props.accessibilityState?.selected).toBe(true);
    expect(suggestionStyle.borderStyle).toBe('dashed');
    expect(screen.queryByText('my guess?')).toBeNull();
  });

  it('auto-suggests a custom poi from the title', async () => {
    mockInferPoiForQuickAdd.mockResolvedValue('police');
    render(<TaskFormScreen />);

    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'visit police');

    await waitFor(() => {
      expect(screen.getByPlaceholderText('A café, a pharmacy, a gym…').props.value).toBe('Police');
    });
  });

  it('clears a previous inferred poi immediately when the title changes', async () => {
    jest.useFakeTimers();
    mockInferPoiForQuickAdd.mockResolvedValue('pharmacy');
    render(<TaskFormScreen />);

    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'buy aspirin');

    await act(async () => {
      jest.advanceTimersByTime(350);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Add it').props.accessibilityState?.disabled).toBe(false);
    });

    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'call mum');

    expect(screen.getByLabelText('Add it').props.accessibilityState?.disabled).toBe(true);

    jest.useRealTimers();
  });

  it('keeps the inference cleared when title inference rejects', async () => {
    jest.useFakeTimers();
    mockInferPoiForQuickAdd.mockRejectedValueOnce(new Error('boom'));
    render(<TaskFormScreen />);

    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'buy aspirin');

    await act(async () => {
      jest.advanceTimersByTime(350);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Add it').props.accessibilityState?.disabled).toBe(true);
    });

    jest.useRealTimers();
  });

  it('selecting a quick-pick tile clears the typed text', () => {
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByPlaceholderText('A café, a pharmacy, a gym…'),
      'florist',
    );
    fireEvent.press(screen.getByText('ATM')); // pick a quick-pick
    expect(
      screen.getByPlaceholderText('A café, a pharmacy, a gym…').props.value,
    ).toBe('');
  });

  it('typing in the free-text field deselects any quick-pick tile', async () => {
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('What do you need?'),
      'Task',
    );
    fireEvent.press(screen.getByText('ATM')); // select quick-pick
    fireEvent.changeText(
      screen.getByPlaceholderText('A café, a pharmacy, a gym…'),
      'bakery',
    );
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add it'));
    });
    await waitFor(() => {
      // typed type wins — NOT 'atm'
      expect(mockAddTask).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ poi: 'bakery' }),
      );
    });
  });
});

// ── POI quick-pick ────────────────────────────────────────────────────────────

describe('TaskFormScreen — POI quick-pick', () => {
  it('selecting a tile includes its type in the addTask payload', async () => {
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('What do you need?'),
      'Groceries',
    );
    fireEvent.press(screen.getByText('Market')); // type: 'supermarket'
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add it'));
    });
    await waitFor(() => {
      expect(mockAddTask).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ poi: 'supermarket' }),
      );
    });
  });

  it('deselecting a tile clears the POI and disables submit', () => {
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('What do you need?'),
      'Get cash',
    );
    fireEvent.press(screen.getByText('ATM')); // select
    expect(
      screen.getByLabelText('Add it').props.accessibilityState?.disabled,
    ).toBe(false);
    fireEvent.press(screen.getByText('ATM')); // deselect
    expect(
      screen.getByLabelText('Add it').props.accessibilityState?.disabled,
    ).toBe(true);
  });

  it('selecting a second tile replaces the first', async () => {
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('What do you need?'),
      'Task',
    );
    fireEvent.press(screen.getByText('ATM'));       // poi: 'atm'
    fireEvent.press(screen.getByText('Pharmacy')); // switch to 'pharmacy'
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add it'));
    });
    await waitFor(() => {
      expect(mockAddTask).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ poi: 'pharmacy' }),
      );
    });
  });
});

// ── Save — create ─────────────────────────────────────────────────────────────

describe('TaskFormScreen — save (create)', () => {
  it('calls addTask with correct payload and navigates back', async () => {
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('What do you need?'),
      'Walk the dog',
    );
    fireEvent.press(screen.getByText('Park'));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add it'));
    });
    await waitFor(() => {
      expect(mockAddTask).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({
          title:    'Walk the dog',
          category: 'personal', // default when none selected
          done:     false,
          poi:      'park',
        }),
      );
      expect(mockGoBack).toHaveBeenCalled();
    });
  });

  it('trims the title before saving', async () => {
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('What do you need?'),
      '  Walk the dog  ',
    );
    fireEvent.press(screen.getByText('Park'));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add it'));
    });
    await waitFor(() => {
      expect(mockAddTask).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ title: 'Walk the dog' }),
      );
    });
  });

  it('includes notes as description when set', async () => {
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('What do you need?'),
      'Groceries',
    );
    fireEvent.press(screen.getByText('Market'));
    fireEvent.changeText(
      screen.getByPlaceholderText('Add a note, link, or reminder…'),
      'Milk, eggs, bread',
    );
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add it'));
    });
    await waitFor(() => {
      expect(mockAddTask).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ description: 'Milk, eggs, bread' }),
      );
    });
  });

  it('saves the selected store subtype in create mode', async () => {
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Buy a t-shirt');
    fireEvent.press(screen.getByText('Store'));
    fireEvent.press(screen.getByLabelText('Clothing'));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add it'));
    });
    await waitFor(() => {
      expect(mockAddTask).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({
          poi:          'store',
          storeSubtype: 'clothing',
        }),
      );
    });
  });

  it('infers and saves a Store brand without a Store subtype in create mode', async () => {
    setRouteParams({ uid: 'user-123', initialPoi: 'store', initialPoiExplicitlySelected: true });
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Buy headphones at Worten');
    await act(async () => { fireEvent.press(screen.getByLabelText('Add it')); });
    await waitFor(() => expect(mockAddTask).toHaveBeenCalledWith('user-123', expect.objectContaining({
      poi: 'store', poiBrand: 'Worten',
    })));
    expect(mockAddTask.mock.calls.at(-1)?.[1]).not.toHaveProperty('storeSubtype');
  });

  it('saves the Store brand received from quick create in More Details', async () => {
    setRouteParams({
      uid: 'user-123',
      initialTitle: 'Buy a charging cable',
      initialPoi: 'store',
      initialPoiBrand: 'Worten',
      initialPoiExplicitlySelected: true,
    });
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);

    expect(screen.getByLabelText('Add it').props.accessibilityState?.disabled).toBe(false);
    await act(async () => { fireEvent.press(screen.getByLabelText('Add it')); });

    await waitFor(() => expect(mockAddTask).toHaveBeenCalledWith('user-123', expect.objectContaining({
      poi: 'store', poiBrand: 'Worten',
    })));
    expect(mockAddTask.mock.calls.at(-1)?.[1]).not.toHaveProperty('storeSubtype');
  });

  it('switches a Store from type to brand in create mode without saving a subtype', async () => {
    setRouteParams({ uid: 'user-123', initialPoi: 'store', initialPoiExplicitlySelected: true });
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Buy a new shirt');
    fireEvent.press(screen.getByLabelText('Clothing'));
    fireEvent.press(screen.getByLabelText(COPY.newTaskSheet.storeDetailBrand));
    fireEvent.changeText(screen.getByLabelText(COPY.newTaskSheet.storeBrandPlaceholder), 'Wor');
    fireEvent.press(screen.getByLabelText('Worten'));
    await act(async () => { fireEvent.press(screen.getByLabelText('Add it')); });

    await waitFor(() => expect(mockAddTask).toHaveBeenCalledWith('user-123', expect.objectContaining({
      poi: 'store', poiBrand: 'Worten',
    })));
    expect(mockAddTask.mock.calls.at(-1)?.[1]).not.toHaveProperty('storeSubtype');
  });

  it('switches a Store from brand to type in create mode without saving a brand', async () => {
    setRouteParams({ uid: 'user-123', initialPoi: 'store', initialPoiExplicitlySelected: true });
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Buy a new shirt');
    fireEvent.press(screen.getByLabelText(COPY.newTaskSheet.storeDetailBrand));
    fireEvent.changeText(screen.getByLabelText(COPY.newTaskSheet.storeBrandPlaceholder), 'Wor');
    fireEvent.press(screen.getByLabelText('Worten'));
    fireEvent.press(screen.getByLabelText(COPY.newTaskSheet.storeDetailType));
    await waitFor(() => expect(screen.getByLabelText('Clothing').props.accessibilityState?.selected).toBe(true));
    fireEvent.press(screen.getByLabelText('Clothing'));
    await act(async () => { fireEvent.press(screen.getByLabelText('Add it')); });

    await waitFor(() => expect(mockAddTask).toHaveBeenCalledWith('user-123', expect.objectContaining({
      poi: 'store', storeSubtype: 'clothing',
    })));
    expect(mockAddTask.mock.calls.at(-1)?.[1]).not.toHaveProperty('poiBrand');
  });

  it('saves a Financial service kind selected in More Details', async () => {
    setRouteParams({ uid: 'user-123', initialPoi: 'financial_service', initialPoiExplicitlySelected: true });
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Sort my finances');
    fireEvent.press(screen.getByLabelText('Consumer credit'));
    await waitFor(() => expect(screen.getByLabelText('Consumer credit').props.accessibilityState?.selected).toBe(true));
    await act(async () => { fireEvent.press(screen.getByLabelText('Add it')); });
    await waitFor(() => expect(mockAddTask).toHaveBeenCalledWith('user-123', expect.objectContaining({
      poi: 'financial_service', financialServiceKind: 'consumer_credit',
    })));
  });

  it('keeps an explicitly cleared Financial service kind generic after a title edit', async () => {
    setRouteParams({
      uid: 'user-123', initialPoi: 'financial_service', initialPoiExplicitlySelected: true,
      initialFinancialServiceKind: 'consumer_credit', initialFinancialServiceKindExplicitlySelected: true,
    });
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    expect(screen.getByLabelText('Consumer credit').props.accessibilityState?.selected).toBe(true);
    fireEvent.press(screen.getByLabelText('Consumer credit'));
    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Pay Cofidis again');
    await act(async () => { fireEvent.press(screen.getByLabelText('Add it')); });
    await waitFor(() => expect(mockAddTask).toHaveBeenCalledWith('user-123', expect.objectContaining({
      poi: 'financial_service',
    })));
    expect(mockAddTask.mock.calls.at(-1)?.[1]).not.toHaveProperty('financialServiceKind');
  });

  it('hydrates and saves a restaurant food type passed from quick create', async () => {
    setRouteParams({ uid: 'user-123', initialPoi: 'restaurant', initialPoiExplicitlySelected: true, initialRestaurantFoodType: 'vegetarian' });
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    expect(screen.getByLabelText('Vegetarian').props.accessibilityState?.selected).toBe(true);
    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Have dinner');
    await act(async () => { fireEvent.press(screen.getByLabelText('Add it')); });
    await waitFor(() => expect(mockAddTask).toHaveBeenCalledWith('user-123', expect.objectContaining({
      poi: 'restaurant', restaurantFoodType: 'vegetarian',
    })));
  });

  it('requires and saves a canonical Gym brand in create mode', async () => {
    setRouteParams({ uid: 'user-123', initialPoi: 'gym', initialPoiExplicitlySelected: true });
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Training tonight');
    expect(screen.getByLabelText('Add it').props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(screen.getByLabelText('Solinca'));
    await act(async () => { fireEvent.press(screen.getByLabelText('Add it')); });
    await waitFor(() => expect(mockAddTask).toHaveBeenCalledWith('user-123', expect.objectContaining({
      poi: 'gym', poiBrand: 'Solinca',
    })));
  });

  it('requires and saves a canonical Bank brand in create mode', async () => {
    setRouteParams({ uid: 'user-123', initialPoi: 'bank', initialPoiExplicitlySelected: true });
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Visit my bank');
    expect(screen.getByLabelText('Add it').props.accessibilityState?.disabled).toBe(true);
    // BrandSelector is a virtualized FlatList. Select a canonical Bank from
    // its initial render window; a later row such as CGD is intentionally not
    // mounted until the user scrolls.
    fireEvent.press(screen.getByLabelText('Novo Banco'));
    await act(async () => { fireEvent.press(screen.getByLabelText('Add it')); });
    await waitFor(() => expect(mockAddTask).toHaveBeenCalledWith('user-123', expect.objectContaining({
      poi: 'bank', poiBrand: 'Novo Banco',
    })));
  });
});

// ── Save — edit ───────────────────────────────────────────────────────────────

describe('TaskFormScreen — save (edit)', () => {
  beforeEach(() => {
    setRouteParams({ uid: 'user-123', task: makeTask() });
  });

  it('calls updateTask (not addTask) and navigates back', async () => {
    mockUpdateTask.mockResolvedValueOnce(undefined);
    render(<TaskFormScreen />);
    fireEvent.changeText(
      screen.getByLabelText('Task title'),
      'Buy oat milk',
    );
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Save changes'));
    });
    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith(
        'user-123',
        'task-1',
        expect.objectContaining({ title: 'Buy oat milk' }),
      );
      expect(mockAddTask).not.toHaveBeenCalled();
      expect(mockGoBack).toHaveBeenCalled();
    });
  });

  it('hydrates and updates the store subtype in edit mode', async () => {
    setRouteParams({
      uid: 'user-123',
      task: makeTask({ poi: 'store', storeSubtype: 'clothing' }),
    });
    mockUpdateTask.mockResolvedValueOnce(undefined);
    render(<TaskFormScreen />);

    expect(screen.getByLabelText('Clothing').props.accessibilityState?.selected).toBe(true);
    fireEvent.press(screen.getByLabelText('Electronics'));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Save changes'));
    });

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith(
        'user-123',
        'task-1',
        expect.objectContaining({
          poi:          'store',
          storeSubtype: 'electronics',
        }),
      );
    });
  });

  it('switches a Store from type to brand in edit mode and deletes the old subtype', async () => {
    setRouteParams({
      uid: 'user-123',
      task: makeTask({ poi: 'store', storeSubtype: 'clothing' }),
    });
    mockUpdateTask.mockResolvedValueOnce(undefined);
    render(<TaskFormScreen />);
    fireEvent.press(screen.getByLabelText(COPY.newTaskSheet.storeDetailBrand));
    fireEvent.changeText(screen.getByLabelText(COPY.newTaskSheet.storeBrandPlaceholder), 'Wor');
    fireEvent.press(screen.getByLabelText('Worten'));
    await act(async () => { fireEvent.press(screen.getByLabelText('Save changes')); });

    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledWith('user-123', 'task-1', expect.objectContaining({
      poi: 'store', poiBrand: 'Worten', storeSubtype: DELETE_FIELD_SENTINEL,
    })));
  });

  it('switches a Store from brand to type in edit mode and deletes the old brand', async () => {
    setRouteParams({
      uid: 'user-123',
      task: makeTask({ poi: 'store', poiBrand: 'Worten' }),
    });
    mockUpdateTask.mockResolvedValueOnce(undefined);
    render(<TaskFormScreen />);
    fireEvent.press(screen.getByLabelText(COPY.newTaskSheet.storeDetailType));
    fireEvent.press(screen.getByLabelText('Clothing'));
    await act(async () => { fireEvent.press(screen.getByLabelText('Save changes')); });

    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledWith('user-123', 'task-1', expect.objectContaining({
      poi: 'store', storeSubtype: 'clothing', poiBrand: DELETE_FIELD_SENTINEL,
    })));
  });
});

// ── Task reminder scheduling (KAN-280) ──────────────────────────────────────

describe('TaskFormScreen — reminder scheduling', () => {
  it('create: does NOT schedule a reminder when no time was set', async () => {
    // Driving the MiniTimePicker to actually pick a time is covered by
    // MiniTimePicker.test.tsx; the edit-mode test below confirms the create/edit
    // wiring end-to-end via an existing time. This test only needs to confirm
    // the `if (time.trim())` guard around scheduleTaskReminder in the create path.
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Walk the dog');
    fireEvent.press(screen.getByText('Park'));

    fireEvent.press(screen.getAllByLabelText('Around when?')[0]);
    const today = new Date();
    fireEvent.press(screen.getByLabelText(
      `${COPY.calendar.monthNamesFull[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`,
    ));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add it'));
    });
    await waitFor(() => expect(mockAddTask).toHaveBeenCalled());
    expect(mockScheduleTaskReminder).not.toHaveBeenCalled();
  });

  it('create: schedules a reminder for the new task id when a time is picked', async () => {
    // Force 24h columns so the picker's testIDs are deterministic regardless
    // of the test environment's default ICU locale.
    const intlSpy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(((..._args: ConstructorParameters<typeof Intl.DateTimeFormat>) => ({
      resolvedOptions: () => ({ hour12: false }),
    })) as unknown as typeof Intl.DateTimeFormat);

    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Walk the dog');
    fireEvent.press(screen.getByText('Park'));

    // A time can only be set after the user explicitly chooses a date.
    fireEvent.press(screen.getAllByLabelText('Around when?')[0]);
    const today = new Date();
    fireEvent.press(screen.getByLabelText(
      `${COPY.calendar.monthNamesFull[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`,
    ));
    // Both the date and time fields share the "Around when?" label — the
    // time field is the second one.
    fireEvent.press(screen.getAllByLabelText('Around when?')[1]);
    fireEvent.press(screen.getByTestId('time-hour24-14'));
    fireEvent.press(screen.getByTestId('time-minute-30'));

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add it'));
    });

    await waitFor(() => {
      expect(mockScheduleTaskReminder).toHaveBeenCalledWith({
        taskId:    'new-id',
        taskTitle: 'Walk the dog',
        date:      todayISO(),
        time:      '14:30',
      });
    });

    intlSpy.mockRestore();
  });

  it('edit: reschedules the reminder with the task\'s id, title, date, and time', async () => {
    mockUpdateTask.mockResolvedValueOnce(undefined);
    setRouteParams({ uid: 'user-123', task: makeTask({ time: '14:00' }) });
    render(<TaskFormScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Save changes'));
    });
    await waitFor(() => {
      expect(mockScheduleTaskReminder).toHaveBeenCalledWith({
        taskId:    'task-1',
        taskTitle: 'Buy milk',
        date:      '2026-06-03',
        time:      '14:00',
      });
    });
  });

  it('edit: calling scheduleTaskReminder with an empty time is how a cleared time cancels the reminder (no-ops downstream)', async () => {
    mockUpdateTask.mockResolvedValueOnce(undefined);
    setRouteParams({ uid: 'user-123', task: makeTask() }); // no `time` field
    render(<TaskFormScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Save changes'));
    });
    await waitFor(() => {
      expect(mockCancelTaskReminder).toHaveBeenCalledWith('task-1');
    });
  });

  it('delete: cancels the task\'s reminder', async () => {
    mockDeleteTask.mockResolvedValueOnce(undefined);
    setRouteParams({ uid: 'user-123', task: makeTask({ time: '14:00' }) });
    const alertSpy = jest
      .spyOn(require('react-native').Alert, 'alert')
      .mockImplementation(((_title: string, _msg?: string, buttons?: Parameters<typeof AlertType.alert>[2]) => {
        const destructive = buttons?.find(b => b.style === 'destructive');
        destructive?.onPress?.();
      }) as typeof AlertType.alert);
    render(<TaskFormScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Delete task'));
    });
    await waitFor(() => {
      expect(mockDeleteTask).toHaveBeenCalledWith('user-123', 'task-1');
      expect(mockCancelTaskReminder).toHaveBeenCalledWith('task-1');
    });
    alertSpy.mockRestore();
  });
});

// ── Go back ───────────────────────────────────────────────────────────────────

describe('TaskFormScreen — go back', () => {
  it('calls navigation.goBack when the back button is pressed', () => {
    render(<TaskFormScreen />);
    fireEvent.press(screen.getByLabelText('Go back'));
    expect(mockGoBack).toHaveBeenCalled();
  });
});

// ── Delete (edit mode) ────────────────────────────────────────────────────────

describe('TaskFormScreen — delete (edit mode)', () => {
  beforeEach(() => {
    setRouteParams({ uid: 'user-123', task: makeTask() });
  });

  it('shows a "Delete task" button in edit mode', () => {
    render(<TaskFormScreen />);
    expect(screen.getByLabelText('Delete task')).toBeTruthy();
  });

  it('does NOT show a "Delete task" button in create mode', () => {
    setRouteParams({ uid: 'user-123' });
    render(<TaskFormScreen />);
    expect(screen.queryByLabelText('Delete task')).toBeNull();
  });

  it('calls deleteTask + goBack after user confirms', async () => {
    mockDeleteTask.mockResolvedValueOnce(undefined);

    const alertSpy = jest
      .spyOn(require('react-native').Alert, 'alert')
      .mockImplementation((_title: any, _msg: any, buttons: any[]) => {
        const destructive = buttons.find((b: any) => b.style === 'destructive');
        destructive?.onPress?.();
      });

    render(<TaskFormScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Delete task'));
    });
    await waitFor(() => {
      expect(mockDeleteTask).toHaveBeenCalledWith('user-123', 'task-1');
      expect(mockGoBack).toHaveBeenCalled();
    });

    alertSpy.mockRestore();
  });

  it('does NOT call deleteTask when user cancels the confirmation', async () => {
    const alertSpy = jest
      .spyOn(require('react-native').Alert, 'alert')
      .mockImplementation((_title: any, _msg: any, buttons: any[]) => {
        const cancelBtn = buttons.find((b: any) => b.style === 'cancel');
        cancelBtn?.onPress?.();
      });

    render(<TaskFormScreen />);
    fireEvent.press(screen.getByLabelText('Delete task'));
    expect(mockDeleteTask).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });
});

// ── KAN-149 copy pass ────────────────────────────────────────────────────────

describe('TaskFormScreen — KAN-149 copy', () => {
  it('POI question reads "Where does this happen?" with no "required" marker', () => {
    render(<TaskFormScreen />);
    expect(screen.getByText('Where does this happen?')).toBeTruthy();
    expect(screen.queryByText(/required/i)).toBeNull();
  });

  it('no "TASK" section label is rendered (header + placeholder already ask it)', () => {
    render(<TaskFormScreen />);
    expect(screen.queryByText('TASK')).toBeNull();
  });

  it('category question reads "Which part of your life?" with "(optional)"', () => {
    render(<TaskFormScreen />);
    expect(screen.getByText('Which part of your life?')).toBeTruthy();
  });

  it('time question starts without a date, so the task remains active until the user explicitly dates it', () => {
    render(<TaskFormScreen />);
    expect(screen.getByText('Around when?')).toBeTruthy();
    expect(screen.getAllByText('No date')).toHaveLength(2);
  });

  it('renders a rotating example as the title input\'s faux placeholder in create mode', () => {
    render(<TaskFormScreen />);
    expect(screen.getByText('Pick up toothpaste…')).toBeTruthy();
  });

  it('does not render a rotating placeholder in edit mode', () => {
    setRouteParams({ uid: 'user-123', task: makeTask() });
    render(<TaskFormScreen />);
    expect(screen.queryByText('Pick up toothpaste…')).toBeNull();
  });
});

// ── KAN-149 confirmation toast ───────────────────────────────────────────────

describe('TaskFormScreen — confirmation toast', () => {
  it('shows the toast after a successful create add', async () => {
    const { useToastStore } = require('../../src/store/toastStore');
    useToastStore.setState({ message: null });

    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);
    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Walk the dog');
    fireEvent.press(screen.getByText('Park'));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add it'));
    });

    expect(useToastStore.getState().message).toBe("Got it — I'll keep an eye out.");
  });

  it('does not show the toast after an edit/update', async () => {
    const { useToastStore } = require('../../src/store/toastStore');
    useToastStore.setState({ message: null });

    setRouteParams({ uid: 'user-123', task: makeTask() });
    mockUpdateTask.mockResolvedValueOnce(undefined);
    render(<TaskFormScreen />);
    fireEvent.changeText(screen.getByLabelText('Task title'), 'Buy oat milk');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Save changes'));
    });

    expect(useToastStore.getState().message).toBeNull();
  });
});

// ── Birthday toggle (KAN-248) ───────────────────────────────────────────────

/** Presses whichever Alert.alert button matches `label`, mimicking the user tapping it. */
function mockAlertPress(label: string) {
  return jest
    .spyOn(require('react-native').Alert, 'alert')
    .mockImplementation((_title: any, _msg: any, buttons: any[]) => {
      buttons.find((b: any) => b.text === label)?.onPress?.();
    });
}

describe('TaskFormScreen — birthday toggle (KAN-248)', () => {
  afterEach(() => {
    (require('react-native').Alert.alert as jest.Mock).mockRestore?.();
  });

  it('does not render the birthday toggle in create mode', () => {
    setRouteParams({ uid: 'user-123' });
    render(<TaskFormScreen />);
    expect(screen.queryByLabelText('Mark as a birthday')).toBeNull();
  });

  it('renders the birthday toggle in edit mode, unchecked for a normal task', () => {
    setRouteParams({ uid: 'user-123', task: makeTask() });
    render(<TaskFormScreen />);
    const toggle = screen.getByLabelText('Mark as a birthday');
    expect(toggle.props.accessibilityState?.checked).toBe(false);
  });

  it('renders the toggle pre-checked when editing an existing birthday task', () => {
    setRouteParams({ uid: 'user-123', task: makeTask({ kind: 'birthday', poi: undefined }) });
    render(<TaskFormScreen />);
    const toggle = screen.getByLabelText('Mark as a birthday');
    expect(toggle.props.accessibilityState?.checked).toBe(true);
  });

  it('shows a warning before turning the toggle on, and does nothing if cancelled', () => {
    setRouteParams({ uid: 'user-123', task: makeTask() });
    const alertSpy = mockAlertPress('Cancel');
    render(<TaskFormScreen />);

    fireEvent.press(screen.getByLabelText('Mark as a birthday'));

    expect(alertSpy).toHaveBeenCalledWith(
      'Mark this as a birthday?',
      expect.any(String),
      expect.any(Array),
    );
    expect(screen.getByLabelText('Mark as a birthday').props.accessibilityState?.checked).toBe(false);
    // Still in the normal flow — POI section untouched.
    expect(screen.getByText('Where does this happen?')).toBeTruthy();
  });

  it('turning the toggle on (confirmed) hides the POI and category sections', () => {
    setRouteParams({ uid: 'user-123', task: makeTask() });
    mockAlertPress('Mark as birthday');
    render(<TaskFormScreen />);

    fireEvent.press(screen.getByLabelText('Mark as a birthday'));

    expect(screen.queryByText('Where does this happen?')).toBeNull();
    expect(screen.queryByText('Which part of your life?')).toBeNull();
    expect(screen.getByLabelText('Mark as a birthday').props.accessibilityState?.checked).toBe(true);
  });

  it('saves with kind:birthday, category:personal, and poi cleared once confirmed on', async () => {
    setRouteParams({ uid: 'user-123', task: makeTask() });
    mockAlertPress('Mark as birthday');
    mockUpdateTask.mockResolvedValueOnce(undefined);
    render(<TaskFormScreen />);

    fireEvent.press(screen.getByLabelText('Mark as a birthday'));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Save changes'));
    });

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith(
        'user-123',
        'task-1',
        expect.objectContaining({
          kind:     'birthday',
          category: 'personal',
          poi:      DELETE_FIELD_SENTINEL,
        }),
      );
    });
  });

  it('does not require a POI to save once the toggle is on', async () => {
    setRouteParams({ uid: 'user-123', task: makeTask() });
    mockAlertPress('Mark as birthday');
    render(<TaskFormScreen />);

    fireEvent.press(screen.getByLabelText('Mark as a birthday'));

    expect(screen.getByLabelText('Save changes').props.accessibilityState?.disabled).toBe(false);
  });

  it('shows an unmark warning when turning an existing birthday task off, and clears kind once confirmed', async () => {
    setRouteParams({ uid: 'user-123', task: makeTask({ kind: 'birthday', poi: undefined }) });
    mockAlertPress('Unmark');
    mockUpdateTask.mockResolvedValueOnce(undefined);
    render(<TaskFormScreen />);

    fireEvent.press(screen.getByLabelText('Mark as a birthday'));
    // POI section is back — pick one so the now-required field is satisfied.
    fireEvent.press(screen.getByText('Market'));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Save changes'));
    });

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith(
        'user-123',
        'task-1',
        expect.objectContaining({ kind: DELETE_FIELD_SENTINEL, poi: 'supermarket' }),
      );
    });
  });

  it('never includes kind in the addTask payload from the create-mode flow (kind is import/edit-toggle only)', async () => {
    setRouteParams({ uid: 'user-123' });
    mockAddTask.mockResolvedValueOnce('new-id');
    render(<TaskFormScreen />);

    fireEvent.changeText(screen.getByLabelText('What do you need?'), 'Walk the dog');
    fireEvent.press(screen.getByText('Park'));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add it'));
    });

    await waitFor(() => expect(mockAddTask).toHaveBeenCalled());
    const payload = mockAddTask.mock.calls[0][1];
    expect('kind' in payload).toBe(false);
  });
});

// ── Take me there (KAN-279) ─────────────────────────────────────────────────

describe('TaskFormScreen — take me there', () => {
  it('does NOT render in create mode', () => {
    mockIsTaskPoiFarAway.mockReturnValue(true);
    setRouteParams({ uid: 'user-123' });
    render(<TaskFormScreen />);
    expect(mockIsTaskPoiFarAway).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Take me to a Pharmacy')).toBeNull();
  });

  it('does NOT render when the POI is in the Nearby list (not far)', () => {
    mockIsTaskPoiFarAway.mockReturnValue(false);
    setRouteParams({ uid: 'user-123', task: makeTask() });
    render(<TaskFormScreen />);
    expect(screen.queryByLabelText('Take me to a Pharmacy')).toBeNull();
  });

  it('renders the top-bar icon when the POI is far (not in the Nearby list)', () => {
    mockIsTaskPoiFarAway.mockReturnValue(true);
    setRouteParams({ uid: 'user-123', task: makeTask() });
    render(<TaskFormScreen />);
    expect(screen.getByLabelText('Take me to a Pharmacy')).toBeTruthy();
  });

  it('checks farness against the task\'s saved poi', () => {
    mockIsTaskPoiFarAway.mockReturnValue(true);
    setRouteParams({ uid: 'user-123', task: makeTask({ poi: 'pharmacy' }) });
    render(<TaskFormScreen />);
    expect(mockIsTaskPoiFarAway).toHaveBeenCalledWith('pharmacy');
    expect(mockGetTakeMeThereA11yLabel).toHaveBeenCalledWith('pharmacy');
  });

  it('does NOT render for a birthday task', () => {
    mockIsTaskPoiFarAway.mockReturnValue(true);
    setRouteParams({ uid: 'user-123', task: makeTask({ kind: 'birthday' }) });
    render(<TaskFormScreen />);
    expect(mockIsTaskPoiFarAway).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Take me to a Pharmacy')).toBeNull();
  });

  it('tapping the top-bar icon opens a Maps search for the task\'s poi', async () => {
    mockIsTaskPoiFarAway.mockReturnValue(true);
    setRouteParams({ uid: 'user-123', task: makeTask({ poi: 'pharmacy' }) });
    render(<TaskFormScreen />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Take me to a Pharmacy'));
    });

    expect(mockOpenTakeMeThereMaps).toHaveBeenCalledWith('pharmacy');
  });
});

// ── Notes above the keyboard (KAN-369) ────────────────────────────────────────

describe('TaskFormScreen — Notes stays above the keyboard (KAN-369)', () => {
  const NOTES_Y = 900;

  // Height of the screen's own box, as a layout pass would report it.
  const SCREEN_HEIGHT = 800;

  // Captures the screen's keyboard subscriptions so a test can fire them.
  type KeyboardEvent = { endCoordinates: { screenY: number } };
  const keyboardShowHandlers: Array<(e: KeyboardEvent) => void> = [];
  const keyboardHideHandlers: Array<() => void> = [];

  beforeEach(() => {
    keyboardShowHandlers.length = 0;
    keyboardHideHandlers.length = 0;
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, cb: (e: KeyboardEvent) => void) => {
      if (event === 'keyboardDidShow') { keyboardShowHandlers.push(cb); }
      if (event === 'keyboardDidHide') { keyboardHideHandlers.push(cb as () => void); }
      return { remove: jest.fn() };
    }) as unknown as typeof Keyboard.addListener);
  });

  // Renders the screen and reports its box height, the way a layout pass would.
  function renderScreen(height = SCREEN_HEIGHT) {
    const result = render(<TaskFormScreen />);
    layoutScreen(height);
    return result;
  }

  function layoutScreen(height: number) {
    fireEvent(
      screen.getByTestId('task-form-lift'),
      'layout',
      { nativeEvent: { layout: { x: 0, y: 0, width: 400, height } } },
    );
  }

  /** @param keyboardTop screen Y of the keyboard's top edge. */
  function emitKeyboardDidShow(keyboardTop = 500) {
    keyboardShowHandlers.forEach(handler => handler({ endCoordinates: { screenY: keyboardTop } }));
  }

  function emitKeyboardDidHide() {
    keyboardHideHandlers.forEach(handler => handler());
  }

  function liftPaddingBottom() {
    return StyleSheet.flatten(screen.getByTestId('task-form-lift').props.style).paddingBottom;
  }

  // Reports the Notes section's position inside the scroll content, the way a
  // real layout pass would.
  function layoutNotesSection() {
    const notes = screen.getByTestId('task-form-notes');
    fireEvent(notes.parent!, 'layout', { nativeEvent: { layout: { x: 0, y: NOTES_Y, width: 300, height: 120 } } });
  }

  function spyOnScroll() {
    return jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
  }

  afterEach(() => { jest.restoreAllMocks(); });

  it('scrolls the Notes section into view when it takes focus in create mode', () => {
    const scrollTo = spyOnScroll();
    renderScreen();
    layoutNotesSection();

    fireEvent(screen.getByTestId('task-form-notes'), 'focus');

    expect(scrollTo).toHaveBeenCalledWith({ y: NOTES_Y - 24, animated: true });
  });

  it('scrolls the Notes section into view when it takes focus in edit mode', () => {
    const scrollTo = spyOnScroll();
    setRouteParams({ uid: 'user-123', task: makeTask() });
    renderScreen();
    layoutNotesSection();

    fireEvent(screen.getByTestId('task-form-notes'), 'focus');

    expect(scrollTo).toHaveBeenCalledWith({ y: NOTES_Y - 24, animated: true });
  });

  it('scrolls again once the keyboard has opened, since the resize lands after focus', () => {
    const scrollTo = spyOnScroll();
    renderScreen();
    layoutNotesSection();
    fireEvent(screen.getByTestId('task-form-notes'), 'focus');
    scrollTo.mockClear();

    act(() => { emitKeyboardDidShow(); });

    expect(scrollTo).toHaveBeenCalledWith({ y: NOTES_Y - 24, animated: true });
  });

  it('does not scroll on keyboardDidShow when Notes does not hold focus', () => {
    const scrollTo = spyOnScroll();
    renderScreen();
    layoutNotesSection();

    act(() => { emitKeyboardDidShow(); });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('stops scrolling on keyboardDidShow after Notes loses focus', () => {
    const scrollTo = spyOnScroll();
    renderScreen();
    layoutNotesSection();
    fireEvent(screen.getByTestId('task-form-notes'), 'focus');
    fireEvent(screen.getByTestId('task-form-notes'), 'blur');
    scrollTo.mockClear();

    act(() => { emitKeyboardDidShow(); });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('never scrolls to a negative offset when Notes sits near the top', () => {
    const scrollTo = spyOnScroll();
    renderScreen();
    fireEvent(
      screen.getByTestId('task-form-notes').parent!,
      'layout',
      { nativeEvent: { layout: { x: 0, y: 10, width: 300, height: 120 } } },
    );

    fireEvent(screen.getByTestId('task-form-notes'), 'focus');

    expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
  });

  // ── Lifting the screen off the keyboard ──────────────────────────────────
  //
  // The window does not always shrink when the keyboard opens (edge-to-edge
  // Android keeps its full height), so the screen pads itself by however much
  // the keyboard actually covers.

  it('lifts the screen by the height the keyboard covers when the window does not resize', () => {
    spyOnScroll();
    renderScreen();

    // The screen's box runs to 800; the keyboard's top edge is at 500.
    act(() => { emitKeyboardDidShow(500); });

    expect(liftPaddingBottom()).toBe(SCREEN_HEIGHT - 500);
  });

  it('stays inert when the window already resized above the keyboard', () => {
    spyOnScroll();
    renderScreen();

    // Keyboard top below the screen's own box — the OS already made the room.
    act(() => { emitKeyboardDidShow(SCREEN_HEIGHT + 40); });

    expect(liftPaddingBottom()).toBe(0);
  });

  it('drops the screen back down when the keyboard hides', () => {
    spyOnScroll();
    renderScreen();
    act(() => { emitKeyboardDidShow(500); });
    expect(liftPaddingBottom()).toBeGreaterThan(0);

    act(() => { emitKeyboardDidHide(); });

    expect(liftPaddingBottom()).toBe(0);
  });

  it('lifts by the same amount when the keyboard reopens after a lifted re-layout', () => {
    spyOnScroll();
    renderScreen();
    act(() => { emitKeyboardDidShow(500); });

    // The lift shrinks the box, so the re-layout reports the reduced height —
    // it must not be mistaken for a smaller window.
    act(() => { layoutScreen(SCREEN_HEIGHT - (SCREEN_HEIGHT - 500)); });
    act(() => { emitKeyboardDidShow(500); });

    expect(liftPaddingBottom()).toBe(SCREEN_HEIGHT - 500);
  });

  it('scrolls Notes into view on top of lifting the screen', () => {
    const scrollTo = spyOnScroll();
    renderScreen();
    layoutNotesSection();
    fireEvent(screen.getByTestId('task-form-notes'), 'focus');
    scrollTo.mockClear();

    act(() => { emitKeyboardDidShow(500); });

    expect(liftPaddingBottom()).toBe(SCREEN_HEIGHT - 500);
    expect(scrollTo).toHaveBeenCalledWith({ y: NOTES_Y - 24, animated: true });
  });
});

// ── Category handed over from the quick sheet (KAN-372) ───────────────────────

describe('TaskFormScreen — initialCategory (KAN-372)', () => {
  it('saves the category chosen in the quick sheet', async () => {
    setRouteParams({
      uid:             'user-123',
      initialTitle:    'Call the clinic',
      initialCategory: 'health',
      initialPoi:      'pharmacy',
      initialPoiExplicitlySelected: true,
    });
    mockAddTask.mockResolvedValueOnce('new-id');

    render(<TaskFormScreen />);
    await act(async () => { fireEvent.press(screen.getByLabelText('Add it')); });

    await waitFor(() =>
      expect(mockAddTask).toHaveBeenCalledWith('user-123', expect.objectContaining({
        title:    'Call the clinic',
        category: 'health',
      })),
    );
  });

  it('still falls back to personal when the quick sheet passes no category', async () => {
    setRouteParams({
      uid:          'user-123',
      initialTitle: 'Call the clinic',
      initialPoi:   'pharmacy',
      initialPoiExplicitlySelected: true,
    });
    mockAddTask.mockResolvedValueOnce('new-id');

    render(<TaskFormScreen />);
    await act(async () => { fireEvent.press(screen.getByLabelText('Add it')); });

    await waitFor(() =>
      expect(mockAddTask).toHaveBeenCalledWith('user-123', expect.objectContaining({
        category: 'personal',
      })),
    );
  });

  it('prefers the edited task own category over any passed-in one', async () => {
    setRouteParams({
      uid:             'user-123',
      task:            makeTask({ category: 'errands' }),
      initialCategory: 'health',
    });
    mockUpdateTask.mockResolvedValueOnce(undefined);

    render(<TaskFormScreen />);
    await act(async () => { fireEvent.press(screen.getByLabelText('Save changes')); });

    await waitFor(() =>
      expect(mockUpdateTask).toHaveBeenCalledWith('user-123', 'task-1', expect.objectContaining({
        category: 'errands',
      })),
    );
  });
});
