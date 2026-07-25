/**
 * Lantern.tsx — KAN-301 component tests.
 *
 * Covers AC1 (every state renders the right label + pill), AC6 (only the pill
 * is pressable), AC7 (collapsed layout renders icon+label+pill), and AC8 (pill
 * press fires its handler). State-resolution and hysteresis live in
 * utils/lantern.test.ts; the halo-tint palette in theme/contrast.test.ts.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import Lantern from '../../src/components/Lantern';
import type { LanternState } from '../../src/utils/lantern';
import { COPY } from '../../src/constants/copy';

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff', surface: '#f6f5f1', surface2: '#efeeea',
      text: '#000', muted: '#999', faint: '#ccc', line: '#ddd', accent: '#e8a86a',
      nearTint: '#fdf7f0', nearTint2: '#f9ede0', nearBorder: '#e8c9a0', nearText: '#7a4a20',
      ringFill: '#db9657', haloHome: '#db9657', haloPlace: '#e8a86a', haloUnset: '#8b857a',
    },
  }),
}));

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: { View } };
});

const PLACES = COPY.tripPlanner.placesIKnowTitle;

describe('Lantern — states (KAN-301 AC1)', () => {
  const cases: Array<{ name: string; state: LanternState; label: string; pill: string }> = [
    { name: 'home',    state: { kind: 'home' },                                   label: COPY.lantern.home,        pill: PLACES },
    { name: 'outside', state: { kind: 'outside', cityName: 'Porto' },             label: 'Porto',                  pill: PLACES },
    { name: 'outside offline', state: { kind: 'outside', cityName: null },        label: COPY.lantern.outside,     pill: PLACES },
    { name: 'mall',    state: { kind: 'mall', name: 'Colombo', offlineDot: false }, label: 'Colombo',              pill: PLACES },
    { name: 'trip',    state: { kind: 'trip', destination: 'Faro', offlineDot: false }, label: 'Faro',             pill: PLACES },
    { name: 'unset',   state: { kind: 'unset' },                                  label: COPY.lantern.whereIsHome, pill: COPY.lantern.tellMe },
  ];

  it.each(cases)('$name renders its label and pill', ({ state, label, pill }) => {
    render(<Lantern state={state} reduceMotionOverride />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText(pill)).toBeTruthy();
  });
});

describe('Lantern — locating held state (KAN-301)', () => {
  it('renders nothing while locating (no Outside flash before a fix)', () => {
    const { toJSON } = render(<Lantern state={{ kind: 'locating' }} reduceMotionOverride />);
    expect(toJSON()).toBeNull();
  });
});

describe('Lantern — interaction', () => {
  it('only the pill is pressable (AC6) — exactly one button in the tree', () => {
    render(<Lantern state={{ kind: 'home' }} reduceMotionOverride />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('pressing the pill fires onPillPress (AC8)', () => {
    const onPillPress = jest.fn();
    render(<Lantern state={{ kind: 'unset' }} onPillPress={onPillPress} reduceMotionOverride />);
    fireEvent.press(screen.getByRole('button'));
    expect(onPillPress).toHaveBeenCalledTimes(1);
  });
});

describe('Lantern — collapsed layout (AC7)', () => {
  it('renders both the rest and collapsed layers (icon + label + pill) when collapse styles are supplied', () => {
    render(
      <Lantern
        state={{ kind: 'home' }}
        restStyle={{ opacity: 1 }}
        collapsedStyle={{ opacity: 1 }}
        collapsed
        reduceMotionOverride
      />,
    );
    // Both layers render the label and pill — the collapsed row is present.
    expect(screen.getAllByText(COPY.lantern.home)).toHaveLength(2);
    expect(screen.getAllByText(PLACES)).toHaveLength(2);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});
