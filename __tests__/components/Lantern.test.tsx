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
    { name: 'home',    state: { kind: 'home' },                label: COPY.lantern.home,          pill: PLACES },
    { name: 'outside', state: { kind: 'outside', cityName: 'Porto' }, label: 'Porto',             pill: PLACES },
    { name: 'outside offline', state: { kind: 'outside', cityName: null }, label: COPY.lantern.outside, pill: PLACES },
    { name: 'mall',    state: { kind: 'mall', name: 'Colombo' }, label: 'Colombo',                pill: PLACES },
    { name: 'trip',    state: { kind: 'trip', destination: 'Faro' }, label: 'Faro',               pill: PLACES },
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

describe('Lantern — no offline mark, in any state (KAN-349 removal)', () => {
  // The dot is gone as a product decision, not a bug: its gate meant it could
  // only ever appear when everything was already fine, so it never showed
  // against a contrast and never acquired meaning. Offline is named by the
  // app-bar cloud-off glyph; the cases that need words get the notice lines.
  // Nothing replaces it — do not reintroduce a mark here.
  const allStates: LanternState[] = [
    { kind: 'home' },
    { kind: 'outside', cityName: 'Porto' },
    { kind: 'outside', cityName: null },
    { kind: 'mall', name: 'Colombo' },
    { kind: 'trip', destination: 'Faro' },
    { kind: 'unset' },
    { kind: 'locating' },
  ];

  /** Every View in the tree that has no children — the shape a dot would take. */
  const markLikeViews = (node: ReturnType<typeof screen.toJSON>): number => {
    let count = 0;
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') { return; }
      const el = n as { type?: string; children?: unknown[]; props?: { style?: unknown } };
      if (Array.isArray(el.children)) { el.children.forEach(walk); }
      else if (el.type === 'View') {
        const flat = StyleSheet.flatten(el.props?.style as never) as { width?: number; height?: number } | undefined;
        // A childless View carrying explicit small square dimensions.
        if (flat?.width != null && flat.width <= 12 && flat.height === flat.width) { count++; }
      }
    };
    walk(node);
    return count;
  };

  it.each(allStates.map(s => [s.kind, s] as const))(
    '%s renders no offline mark and no offline label, at rest', (_kind, state) => {
      render(<Lantern state={state} reduceMotionOverride />);
      expect(markLikeViews(screen.toJSON())).toBe(0);
      expect(screen.queryByLabelText(/offline/i)).toBeNull();
      expect(screen.queryByLabelText(/conheço esta zona/i)).toBeNull();
    },
  );

  it.each(allStates.map(s => [s.kind, s] as const))(
    '%s renders no offline mark in the collapsed layout either', (_kind, state) => {
      render(
        <Lantern
          state={state}
          restStyle={{ opacity: 1 }}
          collapsedStyle={{ opacity: 1 }}
          collapsed
          reduceMotionOverride
        />,
      );
      expect(markLikeViews(screen.toJSON())).toBe(0);
      expect(screen.queryByLabelText(/offline/i)).toBeNull();
    },
  );

  it('leaves the icon, label and pill layout untouched', () => {
    render(<Lantern state={{ kind: 'mall', name: 'Colombo' }} reduceMotionOverride />);
    expect(screen.getByText('Colombo')).toBeTruthy();
    expect(screen.getByText(PLACES)).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('keeps the zone height it always had — the removal moves nothing', () => {
    expect(SECTION_H_REST).toBe(240);
    expect(SECTION_H_COLLAPSED).toBe(150);
  });

  it('no offline copy key survives for a mark to use', () => {
    const chip = COPY.contextChip as Record<string, unknown>;
    expect(chip.offlineDotA11y).toBeUndefined();
    expect(chip.offlineGlyphA11y).toBeUndefined();
  });
});

describe('Lantern — the area notice (KAN-349)', () => {
  const HOME: LanternState = { kind: 'home' };

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
    render(<Lantern state={{ kind: 'outside', cityName: 'Porto' }} notice="building" reduceMotionOverride />);
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
