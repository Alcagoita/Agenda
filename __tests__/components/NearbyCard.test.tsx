/**
 * KAN-60 — NearbyCard component tests.
 *
 * Covers:
 *   - Returns null when nearbyPoiType is null (service decides when to show)
 *   - Returns null when no matching hero task is found
 *   - Hero state: renders "NEARBY · NOW", place name, task title, CTA
 *   - "Also close" subsection shows remaining POI tasks
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import NearbyCard from '../../src/components/NearbyCard';
import type { Task } from '../../src/types';
import { Timestamp } from '@react-native-firebase/firestore';
import { COPY, setCopyLanguage } from '../../src/constants/copy';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff', surface: '#f6f5f1', surface2: '#efeeea',
      text: '#000', muted: '#999', faint: '#ccc',
      line: '#ddd', accent: '#e8a86a',
      nearTint: '#fdf7f0', nearTint2: '#f9ede0',
      nearBorder: '#e8c9a0', nearText: '#7a4a20',
    },
  }),
}));

jest.mock('react-native-reanimated', () => {
  const { View, Text: RNText } = require('react-native');
  const noop = () => {};
  return {
    __esModule: true,
    default:          { View, Text: RNText, createAnimatedComponent: (c: unknown) => c },
    useSharedValue:   (v: unknown) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    cancelAnimation:  noop,
    withRepeat:       (v: unknown) => v,
    withSequence:     (...args: unknown[]) => args[0],
    withTiming:       (v: unknown) => v,
    Easing:           { inOut: () => noop, out: () => noop, ease: noop },
  };
});

jest.mock('../../src/services/maps', () => ({
  formatDistance: (m: number) => `${m} m`,
  placeTypeLabel: (t: string) => t === 'pharmacy' ? 'Pharmacy' : t,
  openInMaps:     jest.fn(),
}));

jest.mock('../../src/components/AppIcon', () => ({
  ChevronRightIcon: () => null,
  PoiIcon:          () => null,
  RefreshIcon:      () => null,
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id:        'task-1',
  title:     'Pick up prescription',
  category:  'health',
  done:      false,
  poi:       'pharmacy',
  date:      '2026-06-01',
  createdAt: { toDate: () => new Date() } as unknown as Timestamp,
  ...overrides,
});

const NEARBY_PLACE = {
  placeId:        'place-1',
  name:           'Whole Foods',
  lat:            37.7749,
  lng:            -122.4194,
  distanceMeters: 60,   // hero zone (< 100 m)
};

// Approaching but not yet in hero zone (100 m < d < 400 m).
const GREY_PLACE = {
  placeId:        'place-grey',
  name:           'Target',
  lat:            37.7749,
  lng:            -122.4194,
  distanceMeters: 200,
};

const EMPTY_PLACES = {};
const PLACES_MAP   = { pharmacy: [NEARBY_PLACE] };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NearbyCard — hidden when service has not triggered', () => {
  beforeEach(() => { setCopyLanguage('en'); });
  afterEach(() => { setCopyLanguage('en'); });

  it('renders nothing when nearbyPoiType is null', () => {
    const { toJSON } = render(
      <NearbyCard
        tasks={[makeTask()]}
        nearbyPoiType={null}
        poiPlaces={EMPTY_PLACES}
      />,
    );
    expect(toJSON()).toBeNull();
  });

  it('renders nothing when all POI tasks are done (no hero task match)', () => {
    const { toJSON } = render(
      <NearbyCard
        tasks={[makeTask({ done: true })]}
        nearbyPoiType="pharmacy"
        poiPlaces={EMPTY_PLACES}
      />,
    );
    expect(toJSON()).toBeNull();
  });

  it('renders nothing when the active POI type has no matching task', () => {
    const { toJSON } = render(
      <NearbyCard
        tasks={[makeTask({ poi: 'supermarket' })]}
        nearbyPoiType="pharmacy"
        poiPlaces={EMPTY_PLACES}
      />,
    );
    expect(toJSON()).toBeNull();
  });
});

describe('NearbyCard — hero state', () => {
  beforeEach(() => { setCopyLanguage('en'); });
  afterEach(() => { setCopyLanguage('en'); });

  it('renders the localized nearby header and count', () => {
    render(
      <NearbyCard
        tasks={[makeTask()]}
        nearbyPoiType="pharmacy"
        poiPlaces={PLACES_MAP}
      />,
    );
    expect(screen.getByText(COPY.nearbyCard.headerNowLabel.toUpperCase())).toBeTruthy();
    expect(screen.getByText(COPY.nearbyCard.placesCount(1))).toBeTruthy();
  });

  it('renders the nearby place name in the hero block', () => {
    render(
      <NearbyCard
        tasks={[makeTask()]}
        nearbyPoiType="pharmacy"
        poiPlaces={PLACES_MAP}
      />,
    );
    expect(screen.getByText(/WHOLE FOODS/i)).toBeTruthy();
  });

  it('renders the task title in the hero block', () => {
    render(
      <NearbyCard
        tasks={[makeTask()]}
        nearbyPoiType="pharmacy"
        poiPlaces={PLACES_MAP}
      />,
    );
    expect(screen.getByText('Pick up prescription')).toBeTruthy();
  });

  it('renders the localized Maps CTA button when place is known', () => {
    render(
      <NearbyCard
        tasks={[makeTask()]}
        nearbyPoiType="pharmacy"
        poiPlaces={PLACES_MAP}
      />,
    );
    expect(screen.getByText(COPY.nearbyCard.openInMaps)).toBeTruthy();
    expect(screen.getByLabelText(COPY.nearbyCard.openInMapsA11y('Whole Foods'))).toBeTruthy();
  });

  it('omits the Maps CTA when no place is available', () => {
    render(
      <NearbyCard
        tasks={[makeTask()]}
        nearbyPoiType="pharmacy"
        poiPlaces={EMPTY_PLACES}
      />,
    );
    expect(screen.queryByText(COPY.nearbyCard.openInMaps)).toBeNull();
  });
});

describe('NearbyCard — also close section', () => {
  beforeEach(() => { setCopyLanguage('en'); });
  afterEach(() => { setCopyLanguage('en'); });

  it('renders the localized also-close label and the secondary task title', () => {
    const heroTask  = makeTask({ id: 'hero', poi: 'pharmacy' });
    const alsoClose = makeTask({ id: 'also', poi: 'supermarket', title: 'Buy groceries' });

    // pharmacy in hero zone (60 m), supermarket approaching but not hero (200 m).
    render(
      <NearbyCard
        tasks={[heroTask, alsoClose]}
        nearbyPoiType="pharmacy"
        poiPlaces={{ pharmacy: [NEARBY_PLACE], supermarket: [GREY_PLACE] }}
      />,
    );

    expect(screen.getByText(COPY.nearbyCard.alsoClose.toUpperCase())).toBeTruthy();
    expect(screen.getByText('Buy groceries')).toBeTruthy();
  });

  it('orders also-close rows by proximity instead of task order', () => {
    const farther = makeTask({ id: 'farther', poi: 'supermarket', title: 'Buy groceries' });
    const nearer = makeTask({ id: 'nearer', poi: 'atm', title: 'Get cash' });

    render(
      <NearbyCard
        tasks={[farther, nearer]}
        nearbyPoiType={null}
        poiPlaces={{
          supermarket: [{ ...GREY_PLACE, name: 'Far market', distanceMeters: 240 }],
          atm: [{ ...GREY_PLACE, placeId: 'atm-place', name: 'Near ATM', distanceMeters: 140 }],
        }}
      />,
    );

    const renderedText = screen.UNSAFE_getAllByType(Text).map(node => node.props.children).flat().join(' ');
    expect(renderedText.indexOf('Get cash')).toBeLessThan(renderedText.indexOf('Buy groceries'));
  });

  it('does not render the also-close label when only one POI task exists', () => {
    render(
      <NearbyCard
        tasks={[makeTask()]}
        nearbyPoiType="pharmacy"
        poiPlaces={PLACES_MAP}
      />,
    );
    expect(screen.queryByText(COPY.nearbyCard.alsoClose.toUpperCase())).toBeNull();
  });
});

describe('NearbyCard — hero carousel page indicator', () => {
  beforeEach(() => { setCopyLanguage('en'); });
  afterEach(() => { setCopyLanguage('en'); });

  const SUPERMARKET_PLACE = { ...NEARBY_PLACE, placeId: 'place-2', name: 'Target', distanceMeters: 80 };

  it('shows page dots (one per hero slide) when multiple POI types are in the hero zone', () => {
    // Two distinct POI types, both with a place < 100 m → two hero slides.
    const pharmacyTask    = makeTask({ id: 'a', poi: 'pharmacy' });
    const supermarketTask = makeTask({ id: 'b', poi: 'supermarket', title: 'Buy groceries' });

    render(
      <NearbyCard
        tasks={[pharmacyTask, supermarketTask]}
        nearbyPoiType="pharmacy"
        poiPlaces={{ pharmacy: [NEARBY_PLACE], supermarket: [SUPERMARKET_PLACE] }}
      />,
    );

    // Two slides → two dots total: one active (widened) pill + one inactive.
    expect(screen.getByTestId('nearby-page-dots')).toBeTruthy();
    expect(screen.getAllByTestId('nearby-page-dot-active')).toHaveLength(1);
    expect(screen.getAllByTestId('nearby-page-dot')).toHaveLength(1);
  });

  it('orders hero slides by proximity instead of task order', () => {
    const fartherHero = makeTask({ id: 'farther', poi: 'pharmacy', title: 'Pick up prescription' });
    const nearerHero = makeTask({ id: 'nearer', poi: 'supermarket', title: 'Buy groceries' });

    render(
      <NearbyCard
        tasks={[fartherHero, nearerHero]}
        nearbyPoiType="pharmacy"
        poiPlaces={{
          pharmacy: [{ ...NEARBY_PLACE, name: 'Far pharmacy', distanceMeters: 90 }],
          supermarket: [{ ...NEARBY_PLACE, placeId: 'market-place', name: 'Near market', distanceMeters: 40 }],
        }}
      />,
    );

    const renderedText = screen.UNSAFE_getAllByType(Text).map(node => node.props.children).flat().join(' ');
    expect(renderedText.indexOf('Buy groceries')).toBeLessThan(renderedText.indexOf('Pick up prescription'));
  });

  it('renders no page dots when there is only a single hero slide', () => {
    render(
      <NearbyCard
        tasks={[makeTask()]}
        nearbyPoiType="pharmacy"
        poiPlaces={PLACES_MAP}
      />,
    );
    expect(screen.queryByTestId('nearby-page-dots')).toBeNull();
  });
});

describe('NearbyCard — pt-PT localization', () => {
  beforeEach(() => { setCopyLanguage('pt-PT'); });
  afterEach(() => { setCopyLanguage('en'); });

  it('localizes the nearby header and place count', () => {
    render(
      <NearbyCard
        tasks={[makeTask()]}
        nearbyPoiType="pharmacy"
        poiPlaces={PLACES_MAP}
      />,
    );

    expect(screen.getByText(COPY.nearbyCard.headerNowLabel.toUpperCase())).toBeTruthy();
    expect(screen.getByText(COPY.nearbyCard.placesCount(1))).toBeTruthy();
  });

  it('uses the plural form for multiple places', () => {
    render(
      <NearbyCard
        tasks={[makeTask(), makeTask({ id: 'task-2', title: 'Buy bread', poi: 'supermarket', category: 'errands' })]}
        nearbyPoiType="pharmacy"
        poiPlaces={{
          pharmacy: [NEARBY_PLACE],
          supermarket: [GREY_PLACE, { ...GREY_PLACE, placeId: 'place-2', distanceMeters: 210 }],
        }}
      />,
    );

    expect(screen.getByText(COPY.nearbyCard.placesCount(2))).toBeTruthy();
  });

  it('localizes the hero actions and also-close label', () => {
    const heroTask = makeTask({ id: 'hero', poi: 'pharmacy' });
    const alsoClose = makeTask({ id: 'also', poi: 'supermarket', title: 'Comprar pão' });
    const secondPharmacy = { ...NEARBY_PLACE, placeId: 'place-2', name: 'Farmácia Central', distanceMeters: 70 };

    render(
      <NearbyCard
        tasks={[heroTask, alsoClose]}
        nearbyPoiType="pharmacy"
        poiPlaces={{
          pharmacy: [NEARBY_PLACE, secondPharmacy],
          supermarket: [GREY_PLACE],
        }}
      />,
    );

    expect(screen.getByText(COPY.nearbyCard.openInMaps)).toBeTruthy();
    expect(screen.getByLabelText(COPY.nearbyCard.openInMapsA11y('Whole Foods'))).toBeTruthy();
    expect(screen.getByText(COPY.nearbyCard.tryAnotherPlace)).toBeTruthy();
    expect(screen.getByText(COPY.nearbyCard.alsoClose.toUpperCase())).toBeTruthy();
  });
});
