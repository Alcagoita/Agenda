/**
 * Header — KAN-301 removed the achievement points chip (was KAN-134) and the
 * ContextChip slot. The chip contradicted KAN-262 (achievements are discovered,
 * never displayed) and the Lantern now owns place context, so a second indicator
 * here would break surface ownership.
 *
 * KAN-313 restored offline and off-grid status indicators in the greeting row.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import Header from '../../src/components/Header';
import { setCopyLanguage } from '../../src/constants/copy';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fdfcfa', text: '#1f1c16', muted: '#8b857a',
      accent: '#e8a86a', nearTint: '#fdf7f0', nearText: '#7a4a20',
      line: 'rgba(40,33,20,0.08)', surface2: '#ece9e2',
    },
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('../../src/components/Avatar', () => () => null);

jest.mock('../../src/components/AppIcon', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const mock = (name: string) => () => React.createElement(Text, null, name);
  return {
    BellIcon:     mock('BellIcon'),
    UsersIcon:    mock('UsersIcon'),
    CloudOffIcon: mock('CloudOffIcon'),
  };
});

const mockUseOfflineCoverage = jest.fn();
jest.mock('../../src/hooks/useOfflineCoverage', () => ({
  useOfflineCoverage: () => mockUseOfflineCoverage(),
}));

const mockGetActiveOffGridWindow = jest.fn();
jest.mock('../../src/services/proximity', () => ({
  getActiveOffGridWindow: () => mockGetActiveOffGridWindow(),
}));

jest.mock('../../src/utils/date', () => ({
  formatLocalTime: () => '18:00',
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Header — KAN-301 (points chip removed)', () => {
  beforeEach(() => {
    mockUseOfflineCoverage.mockReturnValue({ offline: false, hasCache: null });
    mockGetActiveOffGridWindow.mockReturnValue(null);
  });

  it('renders the display name', () => {
    render(<Header displayName="Manel" />);
    expect(screen.getByText('Manel')).toBeTruthy();
  });

  it('does not render any "N pts" achievement chip', () => {
    render(<Header displayName="Manel" />);
    expect(screen.queryByText(/pts$/)).toBeNull();
  });

  it('does not render an achievements-points accessibility label', () => {
    render(<Header displayName="Manel" />);
    expect(screen.queryByLabelText(/achievement points/)).toBeNull();
  });
});

describe('Header — KAN-313 (offline and off-grid status indicators)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setCopyLanguage('en');
    mockUseOfflineCoverage.mockReturnValue({ offline: false, hasCache: null });
    mockGetActiveOffGridWindow.mockReturnValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
    setCopyLanguage('en');
  });

  it('shows no status indicator when online and no off-grid window', () => {
    render(<Header displayName="Manel" />);
    expect(screen.queryByText('CloudOffIcon')).toBeNull();
  });

  it('shows offline indicator when device has no connection', () => {
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
    render(<Header displayName="Manel" />);
    expect(screen.getByLabelText('No internet connection')).toBeTruthy();
    expect(screen.getByText('CloudOffIcon')).toBeTruthy();
  });

  it('shows off-grid indicator with expiry time when window is active', () => {
    mockGetActiveOffGridWindow.mockReturnValue({ destination: 'Porto', expiresAt: 9999999 });
    render(<Header displayName="Manel" />);
    expect(screen.getByLabelText('Off-grid until 18:00')).toBeTruthy();
    expect(screen.getByText('· 18:00')).toBeTruthy();
  });

  it('off-grid takes priority over offline', () => {
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
    mockGetActiveOffGridWindow.mockReturnValue({ destination: 'Porto', expiresAt: 9999999 });
    render(<Header displayName="Manel" />);
    expect(screen.getByLabelText('Off-grid until 18:00')).toBeTruthy();
    expect(screen.queryByLabelText('No internet connection')).toBeNull();
  });

  it('refreshes off-grid window state after 60 s', async () => {
    render(<Header displayName="Manel" />);
    expect(screen.queryByText('CloudOffIcon')).toBeNull();

    mockGetActiveOffGridWindow.mockReturnValue({ destination: 'Porto', expiresAt: 9999999 });
    await act(async () => { jest.advanceTimersByTime(60_000); });

    expect(screen.getByText('· 18:00')).toBeTruthy();
  });

  it('clears off-grid indicator when window expires after 60 s', async () => {
    mockGetActiveOffGridWindow.mockReturnValue({ destination: 'Porto', expiresAt: 9999999 });
    render(<Header displayName="Manel" />);
    expect(screen.getByText('· 18:00')).toBeTruthy();

    mockGetActiveOffGridWindow.mockReturnValue(null);
    await act(async () => { jest.advanceTimersByTime(60_000); });

    expect(screen.queryByText('· 18:00')).toBeNull();
  });

  describe('PT accessibility labels', () => {
    beforeEach(() => setCopyLanguage('pt-PT'));

    it('offline label in Portuguese', () => {
      mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
      render(<Header displayName="Manel" />);
      expect(screen.getByLabelText('Sem ligação à internet')).toBeTruthy();
    });

    it('off-grid label in Portuguese', () => {
      mockGetActiveOffGridWindow.mockReturnValue({ destination: 'Porto', expiresAt: 9999999 });
      render(<Header displayName="Manel" />);
      expect(screen.getByLabelText('Sem rede até às 18:00')).toBeTruthy();
    });
  });
});
