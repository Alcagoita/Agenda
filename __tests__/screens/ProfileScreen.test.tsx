/**
 * ProfileScreen tests — KAN-112 / KAN-129 / KAN-137
 *
 * KAN-137 changes tested:
 *   - Points hero card: "TOTAL POINTS" label, 56px number, toGo caption
 *   - TierMedal renders with correct props
 *   - Streak chip: shows count when > 0, hidden when = 0
 *   - "POINTS & ACHIEVEMENTS" section label present
 *   - Old ring-based copy ("Bronze badge", "earned through achievements") removed
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Linking, Text as RNText } from 'react-native';
import type { AchievementsMap } from '../../src/types';
import { buildAchievementCatalogue } from '../../src/components/AchievementTile';
import { setCopyLanguage } from '../../src/constants/copy';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetUserPointsSummary = jest.fn();
const mockGetUser              = jest.fn();

jest.mock('../../src/services/firestore', () => ({
  getUserPointsSummary:   (...args: unknown[]) => mockGetUserPointsSummary(...args),
  getUser:                (...args: unknown[]) => mockGetUser(...args),
  updateDisplayName:      jest.fn().mockResolvedValue(undefined),
  updateUsername:         jest.fn().mockResolvedValue(undefined),
  checkUsernameAvailable: jest.fn().mockResolvedValue(true),
  validateUsername:       jest.fn(() => null),
  USERNAME_COOLDOWN_DAYS: 30,
}));

jest.mock('../../src/services/achievements', () => ({
  ACHIEVEMENT_DEFS: {
    first_brush:  { id: 'first_brush',  label: 'First brush',  points: 5,  target: 1   },
    early_bird:   { id: 'early_bird',   label: 'Early bird',   points: 10, target: 1   },
    day_complete: { id: 'day_complete', label: 'Day complete', points: 15, target: 1   },
    on_a_roll:    { id: 'on_a_roll',    label: 'On a roll',    points: 20, target: 3   },
    explorer:     { id: 'explorer',     label: 'Explorer',     points: 25, target: 10  },
    centurion:    { id: 'centurion',    label: 'Centurion',    points: 30, target: 100 },
  },
}));

jest.mock('../../src/constants/tiers', () => ({
  deriveTierStanding: (pts: number) => {
    if (pts < 50)  { return { nextTier: { name: 'Bronze',    at: 50,  color: '#b3793f' }, maxed: false, bandPct: pts / 50,       toGo: 50  - pts }; }
    if (pts < 200) { return { nextTier: { name: 'Silver',    at: 200, color: '#7d93a4' }, maxed: false, bandPct: (pts-50) / 150, toGo: 200 - pts }; }
    return           { nextTier: { name: 'Vibranium', at: 3000, color: '#7256a6' }, maxed: true,  bandPct: 1,                 toGo: 0          };
  },
}));

const mockTierMedal = jest.fn(() => null);
jest.mock('../../src/components/TierMedal', () => (props: object) => {
  mockTierMedal(props);
  return null;
});

jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => ({
    currentUser: {
      uid:         'test-uid',
      email:       'test@example.com',
      displayName: 'Jane Doe',
      photoURL:    null,
    },
  }),
  updateProfile: jest.fn().mockResolvedValue(undefined),
}));

const mockGoBack   = jest.fn();
const mockNavigate = jest.fn();
const mockPush     = jest.fn();
jest.mock('@react-navigation/native', () => {
  const actualReact = require('react');
  return {
    useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate, push: mockPush }),
    // Mirrors focus-on-mount for tests — no blur/refocus cycle exercised here.
    useFocusEffect: (cb: () => void | (() => void)) => actualReact.useEffect(cb, []),
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg:         '#fff',
      surface:    '#f6f5f1',
      surface2:   '#efeeea',
      text:       '#1a1a18',
      muted:      '#8a8a85',
      faint:      '#bdbdb7',
      line:       'rgba(20,20,18,0.08)',
      accent:     '#e8a86a',
      nearTint:   '#fdf7f0',
      nearTint2:  '#f9ede0',
      nearBorder: '#e8c9a0',
      nearText:   '#7a4a20',
      ringTrack:  'rgba(20,20,18,0.08)',
    },
    dark:    false,
    setDark: jest.fn(),
  }),
}));

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Stub = (props: object) => React.createElement(View, props);
  return { __esModule: true, default: Stub, Circle: Stub, Path: Stub, Rect: Stub, Line: Stub };
});

jest.mock('../../src/components/AppIcon', () => ({
  ChevronLeftIcon:  () => null,
  ChevronRightIcon: () => null,
  CameraIcon:       () => null,
  CheckIcon:        () => null,
  FlameIcon:        () => null,
  LockIcon:         () => null,
  MedalIcon:        () => null,
  PencilIcon:       () => null,
  PinIcon:          () => null,
  SettingsIcon:     () => null,
  ShareIcon:        () => null,
  StarIcon:         () => null,
  SuitcaseIcon:     () => null,
  BuildingIcon:     () => null,
  CloudOffIcon:     () => null,
}));

jest.mock('../../src/components/Avatar', () => {
  const React = require('react');
  const { View } = require('react-native');
  return (props: object) => React.createElement(View, { testID: 'avatar', ...props });
});

jest.mock('../../src/components/LoadingDots', () => {
  const React = require('react');
  const { View } = require('react-native');
  return (props: object) => React.createElement(View, { testID: 'loading-dots', ...props });
});

jest.mock('../../src/components/ShareProfileSheet', () => () => null);

// Mocked directly (KAN-237) — the hook pulls in getCurrentPosition, which
// transitively imports expo-location (ESM, unparseable by this suite's jest
// config). Screen tests only need to drive the toggle/loading/enabled surface.
const mockToggleMallSnapshot = jest.fn();
const mockUseMallSnapshotToggle = jest.fn(() => ({
  enabled: false,
  loading: false,
  toggle: mockToggleMallSnapshot,
}));
jest.mock('../../src/hooks/useMallSnapshotToggle', () => ({
  useMallSnapshotToggle: () => mockUseMallSnapshotToggle(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import ProfileScreen from '../../src/screens/ProfileScreen';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupDefaultMocks() {
  mockGetUserPointsSummary.mockResolvedValue({ totalPoints: 0, currentStreak: 0, achievements: {} });
  mockGetUser.mockResolvedValue(null);
}

/** Renders the screen and flushes the one-shot getUserPointsSummary fetch (KAN-218). */
async function renderScreen() {
  const utils = render(<ProfileScreen />);
  await act(async () => {});
  return utils;
}

// ─── Identity card ────────────────────────────────────────────────────────────

describe('ProfileScreen — identity card', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('renders without crashing', async () => {
    await renderScreen();
    expect(screen.getByText('Profile')).toBeTruthy();
  });

  it('shows display name from currentUser', async () => {
    await renderScreen();
    expect(screen.getByText('Jane Doe')).toBeTruthy();
  });

  it('shows email from currentUser', async () => {
    await renderScreen();
    expect(screen.getByText('test@example.com')).toBeTruthy();
  });

  it('shows the edit button', async () => {
    await renderScreen();
    expect(screen.getByLabelText('Edit profile')).toBeTruthy();
  });

  it('opens inline edit panel when pencil button is pressed', async () => {
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Edit profile'));
    expect(screen.getByLabelText('Edit name')).toBeTruthy();
    expect(screen.getByLabelText('Edit username')).toBeTruthy();
  });

  it('shows Cancel and Save in edit mode', async () => {
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Edit profile'));
    expect(screen.getByText('Cancel')).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('closes edit panel when Cancel is pressed', async () => {
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Edit profile'));
    fireEvent.press(screen.getByText('Cancel'));
    expect(screen.queryByLabelText('Edit name')).toBeNull();
  });
});

// ─── One-shot fetch (KAN-218) ─────────────────────────────────────────────────

describe('ProfileScreen — one-shot fetch (KAN-218)', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('fetches the points summary with the correct uid', async () => {
    await renderScreen();
    expect(mockGetUserPointsSummary).toHaveBeenCalledWith('test-uid');
  });
});

// ─── Points hero card — KAN-137 ───────────────────────────────────────────────

describe('ProfileScreen — KAN-137: points hero card', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('shows TOTAL POINTS label', async () => {
    await renderScreen();
    expect(screen.getByText('TOTAL POINTS')).toBeTruthy();
  });

  it('shows POINTS & ACHIEVEMENTS section label', async () => {
    await renderScreen();
    expect(screen.getByText('POINTS & ACHIEVEMENTS')).toBeTruthy();
  });

  it('shows 0 points before the fetch resolves', () => {
    mockGetUserPointsSummary.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ProfileScreen />);
    expect(screen.getByLabelText('0 points')).toBeTruthy();
  });

  it('shows the point total once the fetch resolves', async () => {
    mockGetUserPointsSummary.mockResolvedValue({ totalPoints: 42, currentStreak: 0, achievements: {} });
    await renderScreen();
    expect(screen.getByLabelText('42 points')).toBeTruthy();
  });

  it('shows "{toGo} pts to {name}" when not maxed', async () => {
    mockGetUserPointsSummary.mockResolvedValue({ totalPoints: 10, currentStreak: 0, achievements: {} });
    await renderScreen();
    // 10 pts → toGo = 40, nextTier = Bronze
    expect(screen.getByText(/40 pts/)).toBeTruthy();
    expect(screen.getByText(/Bronze/)).toBeTruthy();
  });

  it('shows "Top tier · {name}" when maxed', async () => {
    mockGetUserPointsSummary.mockResolvedValue({ totalPoints: 3000, currentStreak: 0, achievements: {} });
    await renderScreen();
    expect(screen.getByText(/Top tier/)).toBeTruthy();
    expect(screen.getByText(/Vibranium/)).toBeTruthy();
  });

  it('renders TierMedal with size 92', async () => {
    await renderScreen();
    expect(mockTierMedal).toHaveBeenCalledWith(
      expect.objectContaining({ size: 92 }),
    );
  });

  it('passes earned=true and pct=null to TierMedal when maxed', async () => {
    mockGetUserPointsSummary.mockResolvedValue({ totalPoints: 3000, currentStreak: 0, achievements: {} });
    await renderScreen();
    const lastCall = mockTierMedal.mock.calls[mockTierMedal.mock.calls.length - 1][0] as Record<string, unknown>;
    expect(lastCall.earned).toBe(true);
    expect(lastCall.pct).toBeNull();
  });

  it('passes earned=false and numeric bandPct when not maxed', async () => {
    mockGetUserPointsSummary.mockResolvedValue({ totalPoints: 25, currentStreak: 0, achievements: {} });
    await renderScreen();
    // 25 pts → bandPct = 25/50 = 0.5
    const lastCall = mockTierMedal.mock.calls[mockTierMedal.mock.calls.length - 1][0] as Record<string, unknown>;
    expect(lastCall.earned).toBe(false);
    expect(typeof lastCall.pct).toBe('number');
  });

  it('does not render old ring-based copy', async () => {
    await renderScreen();
    expect(screen.queryByText(/earned through achievements/)).toBeNull();
    expect(screen.queryByText(/NEXT REWARD/)).toBeNull();
    expect(screen.queryByText(/badge$/)).toBeNull();
  });
});

describe('ProfileScreen — pt-PT tier copy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
    setCopyLanguage('pt-PT');
  });

  afterEach(() => {
    setCopyLanguage('en');
  });

  it('localizes the next tier name in the points caption', async () => {
    mockGetUserPointsSummary.mockResolvedValue({ totalPoints: 100, currentStreak: 0, achievements: {} });
    await renderScreen();
    expect(screen.getByText('100 pts para Prata')).toBeTruthy();
    expect(screen.queryByText(/Gold/)).toBeNull();
  });

  it('localizes the maxed tier name in the points caption', async () => {
    mockGetUserPointsSummary.mockResolvedValue({ totalPoints: 3000, currentStreak: 0, achievements: {} });
    await renderScreen();
    expect(screen.getByText('Nível máximo · Vibrânio')).toBeTruthy();
    expect(screen.queryByText(/Vibranium/)).toBeNull();
  });
});

// ─── Streak chip ─────────────────────────────────────────────────────────────

describe('ProfileScreen — KAN-137: streak chip', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('shows streak chip when streak > 0', async () => {
    mockGetUserPointsSummary.mockResolvedValue({ totalPoints: 0, currentStreak: 5, achievements: {} });
    await renderScreen();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText(/-day streak/)).toBeTruthy();
  });

  it('hides streak chip when streak is 0', async () => {
    mockGetUserPointsSummary.mockResolvedValue({ totalPoints: 0, currentStreak: 0, achievements: {} });
    await renderScreen();
    expect(screen.queryByText(/-day streak/)).toBeNull();
  });
});

// ─── Achievement medal strip ──────────────────────────────────────────────────

describe('ProfileScreen — achievement medal strip', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('shows the Achievements header', async () => {
    await renderScreen();
    expect(screen.getByText(/Achievements/)).toBeTruthy();
  });

  it('shows "See all" button', async () => {
    await renderScreen();
    expect(screen.getByLabelText('See all achievements')).toBeTruthy();
  });

  it('"See all" navigates to Achievements screen', async () => {
    await renderScreen();
    fireEvent.press(screen.getByLabelText('See all achievements'));
    expect(mockNavigate).toHaveBeenCalledWith('Achievements');
  });

  it('shows 0/7 count when no achievements earned', async () => {
    mockGetUserPointsSummary.mockResolvedValue({ totalPoints: 0, currentStreak: 0, achievements: {} });
    await renderScreen();
    expect(screen.getByText(/ · 0\/7/)).toBeTruthy();
  });

  it('shows correct earned count when some achievements are earned', async () => {
    mockGetUserPointsSummary.mockResolvedValue({
      totalPoints: 0,
      currentStreak: 0,
      achievements: {
        first_task:  { earnCount: 1, progress: 1, target: 1, earnedAt: null },
        first_brush: { earnCount: 1, progress: 1, target: 1, earnedAt: null },
      } as AchievementsMap,
    });
    await renderScreen();
    expect(screen.getByText(/ · 2\/7/)).toBeTruthy();
  });

  it('shows all 7 V1 catalogue labels in the medal strip', async () => {
    await renderScreen();
    for (const def of buildAchievementCatalogue()) {
      expect(screen.getByText(def.label)).toBeTruthy();
    }
  });
});

// ─── Navigation entries ───────────────────────────────────────────────────────

describe('ProfileScreen — navigation entries', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('renders "Share my profile" row', async () => {
    await renderScreen();
    expect(screen.getByLabelText('Share my profile')).toBeTruthy();
  });

  it('does not render a "Going somewhere?" row — Trip Planner entry moved to Calendar (KAN-243)', async () => {
    await renderScreen();
    expect(screen.queryByText('Going somewhere?')).toBeNull();
  });

  it('renders Settings entry row', async () => {
    await renderScreen();
    expect(screen.getByLabelText('Settings')).toBeTruthy();
  });

  it('renders "App & account" subtitle on Settings row', async () => {
    await renderScreen();
    expect(screen.getByText('App & account')).toBeTruthy();
  });

  it('navigates to Settings when Settings row is pressed', async () => {
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Settings'));
    expect(mockNavigate).toHaveBeenCalledWith('Settings');
  });
});

// ─── Off-grid entry row (KAN-246) ─────────────────────────────────────────────

describe('ProfileScreen — off-grid entry row (KAN-246)', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDefaultMocks(); });

  it('renders the off-grid row label and sublabel', async () => {
    await renderScreen();
    expect(screen.getByText('Going off-grid?')).toBeTruthy();
    expect(screen.getByText('Heading somewhere with no signal for a while? I can get ready.')).toBeTruthy();
  });

  it('navigates to OffGrid when the row is pressed', async () => {
    await renderScreen();
    fireEvent.press(screen.getByLabelText('Set up an off-grid window'));
    expect(mockNavigate).toHaveBeenCalledWith('OffGrid');
  });
});

// ─── Mall snapshot toggle row (KAN-237) ───────────────────────────────────────

describe('ProfileScreen — mall snapshot toggle row (KAN-237)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
    mockUseMallSnapshotToggle.mockReturnValue({
      enabled: false,
      loading: false,
      toggle: mockToggleMallSnapshot,
    });
  });

  it('renders the "Activate Mall mode" row', async () => {
    await renderScreen();
    expect(screen.getByText('Activate Mall mode')).toBeTruthy();
  });

  it('flips the toggle on when the switch is pressed', async () => {
    await renderScreen();
    fireEvent(screen.getByLabelText('Activate Mall mode'), 'valueChange', true);
    expect(mockToggleMallSnapshot).toHaveBeenCalledWith(true);
  });

  it('reflects enabled: true with the switch on', async () => {
    mockUseMallSnapshotToggle.mockReturnValue({
      enabled: true,
      loading: false,
      toggle: mockToggleMallSnapshot,
    });
    await renderScreen();
    expect(screen.getByLabelText('Activate Mall mode').props.value).toBe(true);
  });

  it('shows the downloading label and hides the switch while loading', async () => {
    mockUseMallSnapshotToggle.mockReturnValue({
      enabled: false,
      loading: true,
      toggle: mockToggleMallSnapshot,
    });
    await renderScreen();
    expect(screen.getByText('Downloading Shopping mall data…')).toBeTruthy();
    expect(screen.queryByLabelText('Activate Mall mode')).toBeNull();
  });
});

// ── Community section (KAN-374) ──────────────────────────────────────────────

describe('ProfileScreen — community section (KAN-374)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('renders the Community section with the suggest-a-place row', async () => {
    await renderScreen();

    expect(screen.getByText('COMMUNITY')).toBeTruthy();
    expect(screen.getByText('Suggest a missing place')).toBeTruthy();
    expect(screen.getByText('Help improve nearby results')).toBeTruthy();
  });

  it('sits above the Points & Achievements section', async () => {
    await renderScreen();

    const rendered = screen.UNSAFE_getAllByType(RNText)
      .map(node => node.props.children)
      .flat()
      .filter((child): child is string => typeof child === 'string');

    expect(rendered.indexOf('COMMUNITY')).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf('COMMUNITY')).toBeLessThan(rendered.indexOf('POINTS & ACHIEVEMENTS'));
  });

  it('opens the suggestion page when the row is pressed', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await renderScreen();

    fireEvent.press(screen.getByLabelText('Suggest a missing place'));

    expect(openURL).toHaveBeenCalledWith('https://brushaway.app/manual-poi');
  });

  it('warns instead of failing silently when the page cannot be opened', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));
    const alert = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
    await renderScreen();

    await act(async () => { fireEvent.press(screen.getByLabelText('Suggest a missing place')); });

    expect(alert).toHaveBeenCalledWith('Error', 'Could not open the suggestion page. Please try again.');
  });
});
