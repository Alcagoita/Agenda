/**
 * Lantern.tsx — KAN-301 component tests.
 *
 * Covers AC1 (every state renders the right label + pill), AC6 (only the pill
 * is pressable), AC7 (collapsed layout renders icon+label+pill), and AC8 (pill
 * press fires its handler). State-resolution and hysteresis live in
 * utils/lantern.test.ts; the halo-tint palette in theme/contrast.test.ts.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import Lantern from '../../src/components/Lantern';
import type { LanternState } from '../../src/utils/lantern';
import { COPY } from '../../src/constants/copy';
import { SECTION_H_COLLAPSED, SECTION_H_REST } from '../../src/screens/TodayScreen/constants';

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
    { name: 'home',    state: { kind: 'home', offlineDot: false },                label: COPY.lantern.home,          pill: PLACES },
    { name: 'outside', state: { kind: 'outside', cityName: 'Porto', offlineDot: false }, label: 'Porto',             pill: PLACES },
    { name: 'outside offline', state: { kind: 'outside', cityName: null, offlineDot: false }, label: COPY.lantern.outside, pill: PLACES },
    { name: 'mall',    state: { kind: 'mall', name: 'Colombo', offlineDot: false }, label: 'Colombo',                pill: PLACES },
    { name: 'trip',    state: { kind: 'trip', destination: 'Faro', offlineDot: false }, label: 'Faro',               pill: PLACES },
    { name: 'unset',   state: { kind: 'unset' },                                  label: COPY.lantern.whereIsHome,   pill: COPY.lantern.tellMe },
    { name: 'locating',    state: { kind: 'locating' },                           label: COPY.lantern.lookingAround, pill: PLACES },
    { name: 'unavailable', state: { kind: 'unavailable' },                        label: COPY.lantern.cantFindYou,   pill: PLACES },
  ];

  it.each(cases)('$name renders its label and pill', ({ state, label, pill }) => {
    render(<Lantern state={state} reduceMotionOverride />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText(pill)).toBeTruthy();
  });

  it('every state renders a non-empty, structurally identical block (never empty; AC height parity)', () => {
    // The Lantern sits in a fixed-height section and every state renders the
    // same halo + label + single pill structure, so nothing on Today shifts as
    // the state settles. Assert each state is non-empty with exactly one pill.
    for (const { state } of cases) {
      const { toJSON, getAllByRole, unmount } = render(<Lantern state={state} reduceMotionOverride />);
      expect(toJSON()).not.toBeNull();
      expect(getAllByRole('button')).toHaveLength(1);
      unmount();
    }
  });
});

describe('Lantern — interaction', () => {
  it('only the pill is pressable (AC6) — exactly one button in the tree', () => {
    render(<Lantern state={{ kind: 'home', offlineDot: false }} reduceMotionOverride />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('pressing the pill fires onPillPress (AC8)', () => {
    const onPillPress = jest.fn();
    render(<Lantern state={{ kind: 'unset' }} onPillPress={onPillPress} reduceMotionOverride />);
    fireEvent.press(screen.getByRole('button'));
    expect(onPillPress).toHaveBeenCalledTimes(1);
  });
});

describe('Lantern — offline dot (KAN-316)', () => {
  const DOT = COPY.contextChip.offlineGlyphA11y;

  const dotStates: Array<{ name: string; on: LanternState; off: LanternState; label: string }> = [
    { name: 'home',    on: { kind: 'home', offlineDot: true },                        off: { kind: 'home', offlineDot: false },                        label: COPY.lantern.home },
    { name: 'outside', on: { kind: 'outside', cityName: null, offlineDot: true },     off: { kind: 'outside', cityName: null, offlineDot: false },     label: COPY.lantern.outside },
    { name: 'mall',    on: { kind: 'mall', name: 'Colombo', offlineDot: true },       off: { kind: 'mall', name: 'Colombo', offlineDot: false },       label: 'Colombo' },
    { name: 'trip',    on: { kind: 'trip', destination: 'Faro', offlineDot: true },   off: { kind: 'trip', destination: 'Faro', offlineDot: false },   label: 'Faro' },
  ];

  it.each(dotStates)('$name renders the dot when the state carries it, and nothing when it does not (AC4)', ({ on, off }) => {
    const { unmount } = render(<Lantern state={on} reduceMotionOverride />);
    expect(screen.getByLabelText(DOT)).toBeTruthy();
    unmount();

    render(<Lantern state={off} reduceMotionOverride />);
    expect(screen.queryByLabelText(DOT)).toBeNull();
  });

  it('labels the dot with what it asserts, not the bare "Offline" (AC5)', () => {
    render(<Lantern state={{ kind: 'home', offlineDot: true }} reduceMotionOverride />);
    expect(screen.getByLabelText(COPY.contextChip.offlineGlyphA11y)).toBeTruthy();
    expect(screen.queryByLabelText(COPY.contextChip.offlineDotA11y)).toBeNull();
  });

  it.each(dotStates)('$name keeps its icon, place name and single pill with the dot showing (AC7)', ({ on, label }) => {
    render(<Lantern state={on} reduceMotionOverride />);
    expect(screen.getByText(label)).toBeTruthy();       // never replaced or truncated
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('the dot is a fixed 6×6 mark inside the label row — it cannot grow the block (AC7)', () => {
    render(<Lantern state={{ kind: 'home', offlineDot: true }} reduceMotionOverride />);
    const flat = StyleSheet.flatten(screen.getByLabelText(DOT).props.style);
    expect(flat).toMatchObject({ width: 6, height: 6 });
    // Smaller than the label's 20px line height, so the row height is the label's.
    expect(flat.height).toBeLessThan(20);
  });

  it('renders in the collapsed layer too (AC7)', () => {
    render(
      <Lantern
        state={{ kind: 'mall', name: 'Colombo', offlineDot: true }}
        restStyle={{ opacity: 1 }}
        collapsedStyle={{ opacity: 1 }}
        collapsed
        reduceMotionOverride
      />,
    );
    // One per layer, and the name survives in both.
    expect(screen.getAllByLabelText(DOT)).toHaveLength(2);
    expect(screen.getAllByText('Colombo')).toHaveLength(2);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});

describe('Lantern — the area notice (KAN-349)', () => {
  const HOME: LanternState = { kind: 'home', offlineDot: false };

  it('renders distinct lines for building and degraded, neither naming a source (AC1)', () => {
    const { unmount } = render(<Lantern state={HOME} notice="building" reduceMotionOverride />);
    expect(screen.getByText(COPY.lantern.buildingArea)).toBeTruthy();
    unmount();

    render(<Lantern state={HOME} notice="degraded" reduceMotionOverride />);
    expect(screen.getByText(COPY.lantern.degradedArea)).toBeTruthy();
    expect(COPY.lantern.buildingArea).not.toBe(COPY.lantern.degradedArea);

    for (const line of [COPY.lantern.buildingArea, COPY.lantern.degradedArea]) {
      expect(line.toLowerCase()).not.toMatch(/api|server|servidor|osm|cloudflare|foursquare|cache|list[ai]?\b/);
    }
  });

  it('renders no line, and no empty placeholder, when there is nothing to say (AC4)', () => {
    render(<Lantern state={HOME} reduceMotionOverride />);
    expect(screen.queryByText(COPY.lantern.buildingArea)).toBeNull();
    expect(screen.queryByText(COPY.lantern.degradedArea)).toBeNull();
    // The zone's own structure is unchanged: same label, same single pill.
    expect(screen.getByText(COPY.lantern.home)).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('keeps the Lantern intact — the line never replaces the place name or the pill (AC3)', () => {
    render(<Lantern state={{ kind: 'outside', cityName: 'Porto', offlineDot: false }} notice="building" reduceMotionOverride />);
    expect(screen.getByText('Porto')).toBeTruthy();
    expect(screen.getByText(PLACES)).toBeTruthy();
    expect(screen.getByText(COPY.lantern.buildingArea)).toBeTruthy();
  });

  it('is a quiet aside — muted text, no warning colour, no icon (AC10)', () => {
    render(<Lantern state={HOME} notice="degraded" reduceMotionOverride />);
    const flat = StyleSheet.flatten(screen.getByText(COPY.lantern.degradedArea).props.style);
    expect(flat.color).toBe('#999');            // palette.muted from the mock above
    expect(flat.backgroundColor).toBeUndefined(); // no surface of its own
    expect(flat.borderWidth).toBeUndefined();
  });

  it('stays out of the collapsed layer, and the zone height is untouched (AC5)', () => {
    render(
      <Lantern
        state={HOME}
        notice="building"
        restStyle={{ opacity: 1 }}
        collapsedStyle={{ opacity: 1 }}
        collapsed
        reduceMotionOverride
      />,
    );
    // Both layers render, but the line belongs to the rest layer only — once.
    expect(screen.getAllByText(COPY.lantern.home)).toHaveLength(2);
    expect(screen.getAllByText(COPY.lantern.buildingArea)).toHaveLength(1);
  });

  it('the Lantern zone keeps its existing height, so Nearby cannot be pushed down (AC5)', () => {
    // The line lives inside the zone's existing slack. If a future change needs
    // more room than this, KAN-349 says Nearby wins and the ticket needs a
    // design pass — so these constants moving should fail loudly here.
    expect(SECTION_H_REST).toBe(240);
    expect(SECTION_H_COLLAPSED).toBe(150);
  });
});

describe('Lantern — collapsed layout (AC7)', () => {
  it('renders both the rest and collapsed layers (icon + label + pill) when collapse styles are supplied', () => {
    render(
      <Lantern
        state={{ kind: 'home', offlineDot: false }}
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
