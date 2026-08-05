/**
 * SharedTaskInboxScreen tests (KAN-87).
 *
 * Covers:
 *   - Empty state shown when inbox is empty
 *   - Inbox items rendered with sender name and task title
 *   - Accept calls acceptSharedTask and removes item from view
 *   - Decline calls declineSharedTask and removes item from view
 *   - Follow prompt shown when not following sender
 *   - Follow prompt hidden when already following sender
 *   - Subscription unsubscribes on unmount
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSubscribeToIncomingSharedTasks = jest.fn();
const mockAcceptSharedTask               = jest.fn();
const mockDeclineSharedTask              = jest.fn();

jest.mock('../../src/services/sharing', () => ({
  subscribeToIncomingSharedTasks: (...args: unknown[]) =>
    mockSubscribeToIncomingSharedTasks(...args),
  acceptSharedTask:  (...args: unknown[]) => mockAcceptSharedTask(...args),
  declineSharedTask: (...args: unknown[]) => mockDeclineSharedTask(...args),
}));

const mockGetUser      = jest.fn();
const mockIsFollowing  = jest.fn();
const mockFollowUser   = jest.fn();

const mockGetInboxEntries = jest.fn().mockResolvedValue([]);
jest.mock('../../src/services/firestore', () => ({
  getUser:         (...args: unknown[]) => mockGetUser(...args),
  isFollowing:     (...args: unknown[]) => mockIsFollowing(...args),
  followUser:      (...args: unknown[]) => mockFollowUser(...args),
  getInboxEntries: (...args: unknown[]) => mockGetInboxEntries(...args),
}));

jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => ({
    currentUser: {
      uid: 'current-uid',
      displayName: 'Me',
      photoURL: null,
    },
  }),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff', surface: '#eee', surface2: '#ddd', text: '#000',
      muted: '#999', faint: '#ccc', line: '#eee', accent: '#e8a86a',
    },
  }),
}));

jest.mock('../../src/components/AppIcon', () => ({
  ChevronLeftIcon: () => null,
}));

jest.mock('../../src/components/Avatar', () => {
  const React = require('react');
  const { View } = require('react-native');
  return (props: any) => React.createElement(View, props);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSharedTask(overrides = {}): object {
  return {
    id:              'task-1',
    taskId:          'original-task-1',
    title:           'Buy milk',
    category:        'errands',
    sentBy:          'sender-uid',
    sentByName:      'Alice',
    sentByUsername:  'alice',
    sentAt:          { toDate: () => new Date() },
    status:          'pending',
    ...overrides,
  };
}

function captureInboxCallback(): (items: object[]) => void {
  let captured: ((items: object[]) => void) | null = null;
  mockSubscribeToIncomingSharedTasks.mockImplementation(
    (_uid: string, onNext: (items: object[]) => void) => {
      captured = onNext;
      return jest.fn();
    },
  );
  return (items: object[]) => {
    if (captured) { act(() => { captured!(items); }); }
  };
}

import SharedTaskInboxScreen from '../../src/screens/SharedTaskInboxScreen';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SharedTaskInboxScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue({ username: 'me' });
    mockIsFollowing.mockResolvedValue(false);
    mockAcceptSharedTask.mockResolvedValue(undefined);
    mockDeclineSharedTask.mockResolvedValue(undefined);
    mockFollowUser.mockResolvedValue(undefined);
    mockSubscribeToIncomingSharedTasks.mockReturnValue(jest.fn());
  });

  it('shows empty state when inbox is empty', () => {
    const fireItems = captureInboxCallback();
    render(<SharedTaskInboxScreen />);
    fireItems([]);
    expect(screen.getByText('All caught up')).toBeTruthy();
  });

  it('renders inbox items with sender name and task title', () => {
    const fireItems = captureInboxCallback();
    render(<SharedTaskInboxScreen />);
    fireItems([makeSharedTask()]);
    // Row shows the sender's @handle only, not their display name.
    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.getByText('Buy milk')).toBeTruthy();
  });

  it('calls acceptSharedTask when Accept is pressed', async () => {
    const fireItems = captureInboxCallback();
    render(<SharedTaskInboxScreen />);
    fireItems([makeSharedTask()]);
    fireEvent.press(screen.getByLabelText('Accept task'));
    await waitFor(() =>
      expect(mockAcceptSharedTask).toHaveBeenCalledWith(
        'current-uid',
        expect.objectContaining({ id: 'task-1' }),
      ),
    );
  });

  it('calls declineSharedTask when Decline is pressed', async () => {
    const fireItems = captureInboxCallback();
    render(<SharedTaskInboxScreen />);
    fireItems([makeSharedTask()]);
    fireEvent.press(screen.getByLabelText('Decline task'));
    await waitFor(() =>
      expect(mockDeclineSharedTask).toHaveBeenCalledWith('current-uid', 'task-1'),
    );
  });

  it('shows Follow prompt when not following sender', async () => {
    mockIsFollowing.mockResolvedValue(false);
    const fireItems = captureInboxCallback();
    render(<SharedTaskInboxScreen />);
    fireItems([makeSharedTask()]);
    await waitFor(() =>
      expect(screen.getByText('+ Follow @alice')).toBeTruthy(),
    );
  });

  it('hides Follow prompt when already following sender', async () => {
    mockIsFollowing.mockResolvedValue(true);
    const fireItems = captureInboxCallback();
    render(<SharedTaskInboxScreen />);
    fireItems([makeSharedTask()]);
    await waitFor(() =>
      expect(screen.queryByText('+ Follow @alice')).toBeNull(),
    );
  });

  it('calls followUser when Follow prompt is tapped', async () => {
    mockIsFollowing.mockResolvedValue(false);
    const fireItems = captureInboxCallback();
    render(<SharedTaskInboxScreen />);
    fireItems([makeSharedTask()]);
    await waitFor(() => screen.getByText('+ Follow @alice'));
    fireEvent.press(screen.getByText('+ Follow @alice'));
    await waitFor(() =>
      expect(mockFollowUser).toHaveBeenCalledWith(
        'current-uid', 'me', 'Me',
        'sender-uid', 'alice', 'Alice',
      ),
    );
  });

  it('returns unsubscribe function and calls it on unmount', () => {
    const unsub = jest.fn();
    mockSubscribeToIncomingSharedTasks.mockReturnValue(unsub);
    const { unmount } = render(<SharedTaskInboxScreen />);
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
