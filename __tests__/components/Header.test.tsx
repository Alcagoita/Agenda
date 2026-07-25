/**
 * Header — KAN-301 removed the achievement points chip (was KAN-134) and the
 * ContextChip slot. The chip contradicted KAN-262 (achievements are discovered,
 * never displayed) and the Lantern now owns place context, so a second indicator
 * here would break surface ownership.
 *
 * These tests pin that the chip is gone and the core header still renders.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import Header from '../../src/components/Header';

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

jest.mock('../../src/components/AppIcon', () => ({
  BellIcon:  () => null,
  UsersIcon: () => null,
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Header — KAN-301 (points chip removed)', () => {
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
