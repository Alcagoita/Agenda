import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import EndOfDayHandoffScreen from '../../src/screens/EndOfDayHandoffScreen';

const mockGetTask = jest.fn();
const mockForgetDatedTask = jest.fn();
const mockMoveDatedTaskToTomorrow = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
  useRoute: () => ({ params: { uid: 'uid-1', date: '2026-08-10', taskIds: ['t1', 't2'] } }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff', surface: '#f6f5f1', line: '#ddd', text: '#1a1a18', muted: '#888', accent: '#e8a86a',
    },
  }),
}));

jest.mock('../../src/services/firestore', () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
}));

jest.mock('../../src/services/datedTaskHandoff', () => ({
  forgetDatedTask: (...args: unknown[]) => mockForgetDatedTask(...args),
  moveDatedTaskToTomorrow: (...args: unknown[]) => mockMoveDatedTaskToTomorrow(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTask.mockImplementation((_: string, id: string) => Promise.resolve(
    id === 't1'
      ? { id, title: 'Buy milk', done: false, scheduledDate: '2026-08-10' }
      : { id, title: 'Already brushed', done: true, scheduledDate: '2026-08-10' },
  ));
  mockForgetDatedTask.mockResolvedValue(undefined);
  mockMoveDatedTaskToTomorrow.mockResolvedValue(undefined);
});

describe('EndOfDayHandoffScreen', () => {
  it('shows only unresolved tasks and records the selected action', async () => {
    render(<EndOfDayHandoffScreen />);

    await waitFor(() => expect(screen.getByText('Buy milk')).toBeTruthy());
    expect(screen.queryByText('Already brushed')).toBeNull();

    fireEvent.press(screen.getByLabelText('Tomorrow instead'));

    await waitFor(() => expect(mockMoveDatedTaskToTomorrow).toHaveBeenCalledWith('uid-1', 't1', '2026-08-10'));
  });
});
