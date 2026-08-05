/**
 * Unit tests for PublicProfileScreen — KAN-105 additions.
 *
 * Covers:
 *   - Achievements grid renders after load
 *   - "Compare achievements" button is shown for other users
 *   - "Compare achievements" button is hidden on own profile
 *   - Stats row shows points, achievement count, streak
 *   - Not-found state renders when user doesn't exist
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetUserByUsername    = jest.fn();
const mockGetUser              = jest.fn();
const mockIsFollowing          = jest.fn();
const mockFollowUser           = jest.fn();
const mockUnfollowUser         = jest.fn();
const mockGetAchievementsForUser = jest.fn();

jest.mock('../../src/services/firestore', () => ({
  getUserByUsername:       (...a: unknown[]) => mockGetUserByUsername(...a),
  getUser:                 (...a: unknown[]) => mockGetUser(...a),
  isFollowing:             (...a: unknown[]) => mockIsFollowing(...a),
  followUser:              (...a: unknown[]) => mockFollowUser(...a),
  unfollowUser:            (...a: unknown[]) => mockUnfollowUser(...a),
  getAchievementsForUser: (...a: unknown[]) => mockGetAchievementsForUser(...a),
}));

jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => ({ currentUser: { uid: 'me-uid', displayName: 'Me' } }),
}));

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: mockNavigate }),
  useRoute: () => ({ params: { username: 'alice' } }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff', surface: '#f6f5f1', surface2: '#efeeea', text: '#1a1a18',
      muted: '#8a8a85', faint: '#bdbdb7', accent: '#e8a86a',
      line: 'rgba(20,20,18,0.08)', nearTint2: '#f9ede0',
      nearBorder: '#e8c9a0', nearText: '#7a4a20',
    },
  }),
}));

jest.mock('../../src/components/AppIcon', () => ({
  ChevronLeftIcon: () => null,
  // KAN-105 — AchievementTile (rendered by this screen's achievements grid)
  // renders one of these per tile via AchievementIcon's icon-key switch.
  CheckIcon: () => null,
  SunIcon:   () => null,
  FlameIcon: () => null,
  PinIcon:   () => null,
  StarIcon:  () => null,
  MedalIcon: () => null,
}));

jest.mock('../../src/components/Avatar', () => () => null);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(overrides = {}) {
  return {
    uid: 'alice-uid', email: 'alice@test.com', displayName: 'Alice',
    darkMode: false, createdAt: { seconds: 0, nanoseconds: 0 },
    username: 'alice', followersCount: 3, followingCount: 1,
    totalPoints: 50, currentStreak: 4,
    ...overrides,
  };
}

import PublicProfileScreen from '../../src/screens/PublicProfileScreen';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PublicProfileScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFollowing.mockResolvedValue(false);
  });

  it('renders profile card and stats once loaded', async () => {
    mockGetUserByUsername.mockResolvedValue(makeUser());
    mockGetAchievementsForUser.mockResolvedValue([]);

    const { getByText, getAllByText } = render(<PublicProfileScreen />);

    await waitFor(() => {
      expect(getByText('Alice')).toBeTruthy();
      // @alice appears in both the top bar title and the profile card handle
      expect(getAllByText('@alice').length).toBeGreaterThanOrEqual(1);
      // Stats row
      expect(getByText('50')).toBeTruthy();  // totalPoints
      expect(getByText('4')).toBeTruthy();   // currentStreak
    });
  });

  it('shows achievements grid with earned and locked tiles', async () => {
    mockGetUserByUsername.mockResolvedValue(makeUser());
    mockGetAchievementsForUser.mockResolvedValue([
      { id: 'first_task', type: 'first_task', earnedAt: { seconds: 1_700_000_000, nanoseconds: 0 } },
    ]);

    const { getAllByLabelText } = render(<PublicProfileScreen />);

    await waitFor(() => {
      const earned = getAllByLabelText(/achievement, earned/i);
      const locked = getAllByLabelText(/achievement, locked/i);
      expect(earned.length).toBe(1);  // first_task
      // KAN-150 — the Tin-tier catalogue (buildAchievementCatalogue) has 7
      // entries total; 1 earned above leaves the rest locked.
      expect(locked.length).toBe(6);
    });
  });

  it('shows "Compare achievements" button for another user', async () => {
    mockGetUserByUsername.mockResolvedValue(makeUser());
    mockGetAchievementsForUser.mockResolvedValue([]);

    const { getByText } = render(<PublicProfileScreen />);

    await waitFor(() => {
      expect(getByText('Compare achievements')).toBeTruthy();
    });
  });

  it('hides "Compare achievements" button on own profile', async () => {
    mockGetUserByUsername.mockResolvedValue(makeUser({ uid: 'me-uid' }));
    mockGetAchievementsForUser.mockResolvedValue([]);

    const { queryByText } = render(<PublicProfileScreen />);

    await waitFor(() => {
      expect(queryByText('Compare achievements')).toBeNull();
    });
  });

  it('shows not-found text when user does not exist', async () => {
    mockGetUserByUsername.mockResolvedValue(null);

    const { getByText } = render(<PublicProfileScreen />);

    await waitFor(() => {
      expect(getByText(/not found/i)).toBeTruthy();
    });
  });
});
