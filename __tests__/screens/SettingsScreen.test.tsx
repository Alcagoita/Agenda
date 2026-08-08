/**
 * SettingsScreen tests — KAN-113
 *
 * Covers:
 *   - All 5 sections render (TASKS, APPEARANCE, LOCATION & BATTERY, IMPORT TASKS, ACCOUNT)
 *   - Settings rows: Manage Categories, Notification Preferences, Dark mode,
 *     Pause nearby alerts, Home (KAN-247), import rows, Sign out
 *   - Dark mode toggle calls setDark
 *   - Low battery pref: fetched once on mount + optimistic update on toggle
 *   - Sign out triggers confirmation Alert
 *   - Back navigation
 *   - Footer renders app version
 */

import React from 'react';
import { Alert, Linking, ScrollView, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetLowBatteryPausePref = jest.fn();
const mockSetLowBatteryPausePref = jest.fn();
const mockLogout                 = jest.fn();
const mockGetUser                = jest.fn();

jest.mock('../../src/services/firestore', () => ({
  getLowBatteryPausePref: (...args: unknown[]) => mockGetLowBatteryPausePref(...args),
  setLowBatteryPausePref: (...args: unknown[]) => mockSetLowBatteryPausePref(...args),
  getUser:                (...args: unknown[]) => mockGetUser(...args),
}));

jest.mock('../../src/services/auth', () => ({
  logout: (...args: unknown[]) => mockLogout(...args),
}));

jest.mock('../../src/services/import', () => ({
  importFromGoogleTasks:    jest.fn(),
  importFromGoogleCalendar: jest.fn(),
  importFromReminders:      jest.fn(),
  importFromCalendar:       jest.fn(),
}), { virtual: true });

jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => ({
    currentUser: { uid: 'test-uid', email: 'test@example.com', displayName: 'Jane Doe' },
  }),
}));

const mockGoBack   = jest.fn();
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
  // Real useFocusEffect re-runs on every focus; a plain mount-effect is
  // enough here since these tests never leave/re-enter the screen.
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, []),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockSetDark = jest.fn();
const mockSetLanguage = jest.fn();
let mockDark = false;
let mockLanguage: 'en' | 'pt-PT' = 'en';
jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg:       '#fff',
      surface:  '#f6f5f1',
      surface2: '#efeeea',
      text:     '#1a1a18',
      muted:    '#8a8a85',
      faint:    '#bdbdb7',
      line:     'rgba(20,20,18,0.08)',
      accent:   '#e8a86a',
    },
    dark:        mockDark,
    setDark:     mockSetDark,
    language:    mockLanguage,
    setLanguage: mockSetLanguage,
  }),
}));

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Stub = (props: any) => React.createElement(View, props);
  return {
    __esModule: true,
    default: Stub,
    Circle: Stub, Path: Stub, Rect: Stub, Line: Stub, Polygon: Stub,
  };
});

jest.mock('../../src/components/AppIcon', () => ({
  BatteryIcon:      () => null,
  BellIcon:         () => null,
  CalendarIcon:     () => null,
  CheckIcon:        () => null,
  ChevronLeftIcon:  () => null,
  ChevronRightIcon: () => null,
  GlobeIcon:        () => null,
  GridIcon:         () => null,
  HomeIcon:         () => null,
  ListCheckIcon:    () => null,
  LogOutIcon:       () => null,
  MoonIcon:         () => null,
  PinIcon:          () => null,
  SunIcon:          () => null,
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import SettingsScreen from '../../src/screens/SettingsScreen';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupDefaultMocks() {
  mockGetLowBatteryPausePref.mockResolvedValue(false);
  mockSetLowBatteryPausePref.mockResolvedValue(undefined);
  mockLogout.mockResolvedValue(undefined);
  mockGetUser.mockResolvedValue(null);
}

async function renderScreen() {
  const result = render(<SettingsScreen />);
  await act(async () => {}); // flush the getLowBatteryPausePref/getUser promises
  return result;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

describe('SettingsScreen — KAN-113: rendering', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('renders without crashing', async () => {
    await renderScreen();
    expect(screen.getByText('Settings')).toBeTruthy();
  });

  it('renders TASKS section label', async () => {
    await renderScreen();
    expect(screen.getByText('TASKS')).toBeTruthy();
  });

  it('renders APPEARANCE section label', async () => {
    await renderScreen();
    expect(screen.getByText('APPEARANCE')).toBeTruthy();
  });

  it('renders LOCATION & BATTERY section label', async () => {
    await renderScreen();
    expect(screen.getByText('LOCATION & BATTERY')).toBeTruthy();
  });

  it('renders IMPORT TASKS section label', async () => {
    await renderScreen();
    expect(screen.getByText('IMPORT TASKS')).toBeTruthy();
  });

  it('renders ACCOUNT section label', async () => {
    await renderScreen();
    expect(screen.getByText('ACCOUNT')).toBeTruthy();
  });

  it('renders the footer with app version', async () => {
    await renderScreen();
    expect(screen.getByText(/Brush Away · v/)).toBeTruthy();
  });

  // KAN-351 — every place-data source currently reachable from the app must
  // stay credited (OpenStreetMap ODbL, Foursquare OS Places Apache 2.0, and
  // Google while the autocomplete path still calls it) — a licence
  // obligation, not a feature, so it must never be silently dropped by a
  // future copy edit.
  it('renders attribution for every reachable place-data source', async () => {
    await renderScreen();
    // Import rows ("Google Tasks", "Google Calendar") also contain "Google",
    // so match the whole attribution line rather than each source in
    // isolation — this is the one node the licence obligation actually lives on.
    const attribution = screen.getByText(/OpenStreetMap contributors \(ODbL\)/);
    expect(attribution.props.children).toContain('Foursquare Open Source Places (Apache 2.0)');
    expect(attribution.props.children).toContain('Google');
  });

  it('keeps the scroll view keyboard-safe and full-height', async () => {
    const rendered = await renderScreen();
    const scrollView = rendered.UNSAFE_getByType(ScrollView);
    const contentStyle = StyleSheet.flatten(scrollView.props.contentContainerStyle);

    expect(scrollView.props.keyboardShouldPersistTaps).toBe('handled');
    expect(contentStyle.flexGrow).toBe(1);
  });
});

// ─── TASKS section ────────────────────────────────────────────────────────────

describe('SettingsScreen — KAN-113: TASKS section', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('renders Manage Categories row', async () => {
    await renderScreen();
    expect(screen.getByLabelText('Manage Categories')).toBeTruthy();
  });

  it('renders row labels without extra font padding', async () => {
    await renderScreen();
    const style = StyleSheet.flatten(screen.getByText('Manage Categories').props.style);

    expect(style.includeFontPadding).toBe(false);
    expect(style.textAlignVertical).toBe('center');
  });

  it('navigates to Categories when Manage Categories is pressed', async () => {
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Manage Categories'));
    expect(mockNavigate).toHaveBeenCalledWith('Categories');
  });

  it('renders Notification Preferences row', async () => {
    await renderScreen();
    expect(screen.getByLabelText('Notification Preferences')).toBeTruthy();
  });

  it('navigates to NotificationPreferences when pressed', async () => {
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Notification Preferences'));
    expect(mockNavigate).toHaveBeenCalledWith('NotificationPreferences');
  });
});

// ─── APPEARANCE section ───────────────────────────────────────────────────────

describe('SettingsScreen — KAN-113: APPEARANCE section', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); mockDark = false; });

  it('renders Dark mode row', async () => {
    await renderScreen();
    expect(screen.getByText('Dark mode')).toBeTruthy();
  });

  it('calls setDark when dark mode switch is toggled', async () => {
    await renderScreen();
    const toggle = screen.getByLabelText('Dark mode toggle');
    fireEvent(toggle, 'valueChange', true);
    expect(mockSetDark).toHaveBeenCalledWith(true);
  });
});

// ─── LANGUAGE sheet ───────────────────────────────────────────────────────────

describe('SettingsScreen — KAN-252: language picker sheet', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('wraps language options in a radiogroup', async () => {
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Language'));
    expect(screen.UNSAFE_getByProps({ accessibilityRole: 'radiogroup' })).toBeTruthy();
  });
});

// ─── LOCATION & BATTERY section ───────────────────────────────────────────────

describe('SettingsScreen — KAN-113: LOCATION & BATTERY section', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('renders Pause nearby alerts row', async () => {
    await renderScreen();
    expect(screen.getByText('Pause nearby alerts on low battery')).toBeTruthy();
  });

  it('fetches low battery pref on mount', async () => {
    await renderScreen();
    expect(mockGetLowBatteryPausePref).toHaveBeenCalledWith('test-uid');
  });

  it('reflects the stored pref value', async () => {
    mockGetLowBatteryPausePref.mockResolvedValue(true);
    await renderScreen();
    const toggle = screen.getByLabelText('Pause nearby alerts on low battery toggle');
    expect(toggle.props.value).toBe(true);
  });

  it('calls setLowBatteryPausePref when toggle is pressed', async () => {
    await renderScreen();
    const toggle = screen.getByLabelText('Pause nearby alerts on low battery toggle');
    await act(async () => {
      fireEvent(toggle, 'valueChange', true);
    });
    expect(mockSetLowBatteryPausePref).toHaveBeenCalledWith('test-uid', true);
  });

  it('renders without crashing when getLowBatteryPausePref rejects on mount', async () => {
    mockGetLowBatteryPausePref.mockRejectedValue(new Error('fetch failed'));
    await renderScreen();
    expect(screen.getByText('Pause nearby alerts on low battery')).toBeTruthy();
  });

  it('reverts the low battery toggle when setLowBatteryPausePref rejects', async () => {
    mockSetLowBatteryPausePref.mockRejectedValue(new Error('write failed'));
    await renderScreen();
    const toggle = screen.getByLabelText('Pause nearby alerts on low battery toggle');
    await act(async () => {
      fireEvent(toggle, 'valueChange', true);
    });
    expect(toggle.props.value).toBe(false);
  });
});

// ─── LOCATION & BATTERY: Home row (KAN-247) ───────────────────────────────────

describe('SettingsScreen — KAN-247: Home row', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('renders the Home row with an empty sublabel when unset', async () => {
    mockGetUser.mockResolvedValue(null);
    await renderScreen();
    expect(screen.getByLabelText('Home')).toBeTruthy();
    expect(screen.getByText('Not set')).toBeTruthy();
  });

  it('shows the stored address as the sublabel once getUser resolves', async () => {
    mockGetUser.mockResolvedValue({ home: { address: '221B Baker Street, London', lat: 51.5, lng: -0.1 } });
    await renderScreen();
    expect(screen.getByText('221B Baker Street, London')).toBeTruthy();
  });

  it('navigates to HomeAddress when the Home row is pressed', async () => {
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Home'));
    expect(mockNavigate).toHaveBeenCalledWith('HomeAddress');
  });
});

// ─── IMPORT TASKS section ─────────────────────────────────────────────────────

describe('SettingsScreen — KAN-113: IMPORT TASKS section', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('renders at least one import row', async () => {
    await renderScreen();
    // Platform.OS is 'ios' in Jest — Reminders and Calendar
    const rows = screen.queryAllByRole('button');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('renders Google Tasks row on android', async () => {
    const original = require('react-native').Platform.OS;
    Object.defineProperty(require('react-native').Platform, 'OS', { value: 'android', writable: true });
    try {
      await renderScreen();
      expect(screen.getByLabelText('Google Tasks')).toBeTruthy();
    } finally {
      Object.defineProperty(require('react-native').Platform, 'OS', { value: original, writable: true });
    }
  });
});

// ─── COMMUNITY section (KAN-362) ─────────────────────────────────────────────

describe('SettingsScreen — KAN-362: community place suggestion', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('opens the public suggestion page', async () => {
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Suggest a missing place'));
    expect(openUrl).toHaveBeenCalledWith('https://brushaway.app/manual-poi');
  });

  it('shows the localized error when the suggestion page cannot open', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('unavailable'));
    const alert = jest.spyOn(Alert, 'alert');
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Suggest a missing place'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(
      'Error',
      'Could not open the suggestion page. Please try again.',
    ));
  });
});

// ─── ACCOUNT section ──────────────────────────────────────────────────────────

describe('SettingsScreen — KAN-113: ACCOUNT section', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('renders Sign out row', async () => {
    await renderScreen();
    expect(screen.getByLabelText('Sign out')).toBeTruthy();
  });

  it('shows a confirmation Alert when Sign out is pressed', async () => {
    const spy = jest.spyOn(Alert, 'alert');
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Sign out'));
    expect(spy).toHaveBeenCalledWith(
      'Sign out',
      expect.any(String),
      expect.any(Array),
    );
  });

  it('calls logout when the destructive Alert button is confirmed', async () => {
    let confirmCb: (() => void) | undefined;
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      const destructive = (buttons as any[])?.find(b => b.style === 'destructive');
      confirmCb = destructive?.onPress;
    });
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Sign out'));
    await act(async () => { confirmCb?.(); });
    expect(mockLogout).toHaveBeenCalled();
  });
});

// ─── Navigation ───────────────────────────────────────────────────────────────

describe('SettingsScreen — KAN-113: navigation', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('calls goBack when Back button is pressed', async () => {
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Back'));
    expect(mockGoBack).toHaveBeenCalled();
  });
});
