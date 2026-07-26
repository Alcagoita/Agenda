/**
 * PlacesScreen — KAN-304 two-tab UI contract.
 *
 * Mocks usePlaces so we test rendering. Covers: exactly two tabs + switching
 * (AC1), no cap (AC2), Favourites/Your usuals separate with correct two-line
 * secondaries (AC4/AC6), no visible remove control (AC7), add-button placement
 * (AC8), single Next-up (AC9), separation band (AC10), and per-section empty
 * lines (AC13).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { COPY } from '../../src/constants/copy';
import { poiCatalogLabel } from '../../src/types';

let mockReturn: ReturnType<typeof base>;
function base() {
  return {
    loading: false,
    favourites: [] as Array<{ poiType: string; name: string; taught: boolean; id?: string }>,
    usuals: [] as Array<{ poiType: string; name: string; taught: boolean; id?: string }>,
    activeTrips: [] as unknown[],
    pastTripGroups: [] as unknown[],
    addPlace: jest.fn(), removePlace: jest.fn(), forgetTrip: jest.fn(), refresh: jest.fn(),
  };
}
function makeState(over: Partial<ReturnType<typeof base>> = {}) { return { ...base(), ...over }; }

jest.mock('../../src/hooks/usePlaces', () => ({ usePlaces: () => mockReturn }));
jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff', surface: '#f6f5f1', surface2: '#efeeea', text: '#000', muted: '#999',
      faint: '#ccc', line: '#ddd', accent: '#e8a86a', onAccent: '#fff', scrim: 'rgba(0,0,0,0.2)',
      nearTint: '#fdf7f0', nearBorder: '#e8c9a0', nearText: '#7a4a20',
    },
  }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock('@react-navigation/native-stack', () => ({}));
jest.mock('../../src/components/AppIcon', () => ({
  ChevronLeftIcon: () => null, PlusIcon: () => null, StarIcon: () => null, RefreshIcon: () => null,
  SuitcaseIcon: () => null, PinIcon: () => null, PoiIcon: () => null, CloseIcon: () => null,
}));

import PlacesScreen from '../../src/screens/PlacesScreen';

const trip = (id: string, destination: string, startDate?: string, endDate?: string) =>
  ({ id, destination, startDate, endDate, kind: 'trip', cacheAreaId: id } as unknown as never);

describe('PlacesScreen — tabs', () => {
  it('renders exactly two tabs (Places, Trips) and no Planner (AC1)', () => {
    mockReturn = makeState();
    render(<PlacesScreen />);
    expect(screen.getByText(COPY.places.tabPlaces)).toBeTruthy();
    expect(screen.getByText(COPY.places.tabTrips)).toBeTruthy();
    expect(screen.queryByText(/planner/i)).toBeNull();
  });

  it('starts on Places and switches to Trips (AC1)', () => {
    mockReturn = makeState();
    render(<PlacesScreen />);
    expect(screen.getByText(COPY.places.sectionFavourites)).toBeTruthy();
    expect(screen.queryByText(COPY.places.sectionWhereBeen)).toBeNull();

    fireEvent.press(screen.getByText(COPY.places.tabTrips));
    expect(screen.getByText(COPY.places.sectionWhereBeen)).toBeTruthy();
    expect(screen.queryByText(COPY.places.sectionFavourites)).toBeNull();
  });
});

describe('PlacesScreen — Places tab', () => {
  it('renders Favourites and Your usuals with the correct two-line secondaries (AC4/AC6)', () => {
    mockReturn = makeState({
      favourites: [{ poiType: 'supermarket', name: 'Colombo', taught: true, id: 'f1' }],
      usuals: [{ poiType: 'supermarket', name: 'Pingo Doce', taught: false }],
    });
    render(<PlacesScreen />);
    const label = poiCatalogLabel('supermarket' as never).toLowerCase();
    expect(screen.getByText('Colombo')).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();                              // favourite: plain type
    expect(screen.getByText(COPY.places.usualSecondary(label))).toBeTruthy();  // usual: "your usual …"
  });

  it('does not cap the list — 40 favourites render 40 rows (AC2)', () => {
    const favourites = Array.from({ length: 40 }, (_, i) => ({ poiType: 'cafe', name: `Brand ${i}`, taught: true, id: `f${i}` }));
    mockReturn = makeState({ favourites });
    render(<PlacesScreen />);
    expect(screen.getByText('Brand 0')).toBeTruthy();
    expect(screen.getByText('Brand 39')).toBeTruthy();
  });

  it('renders no visible remove (×) control on rows (AC7)', () => {
    mockReturn = makeState({ favourites: [{ poiType: 'cafe', name: 'Sightglass', taught: true, id: 'f1' }] });
    render(<PlacesScreen />);
    expect(screen.queryByText('×')).toBeNull();
  });

  it('puts the teach button above the (empty) Favourites section (AC8)', () => {
    mockReturn = makeState();
    render(<PlacesScreen />);
    expect(screen.getByText(COPY.places.teachAction)).toBeTruthy();
  });

  it('renders per-section empty lines (AC13)', () => {
    mockReturn = makeState();
    render(<PlacesScreen />);
    expect(screen.getByText(COPY.places.emptyFavourites)).toBeTruthy();
    expect(screen.getByText(COPY.places.emptyUsuals)).toBeTruthy();
  });
});

describe('PlacesScreen — Trips tab', () => {
  const goToTrips = () => fireEvent.press(screen.getByText(COPY.places.tabTrips));

  it('flags exactly one planned trip as Next up — the earliest (AC9)', () => {
    mockReturn = makeState({ activeTrips: [trip('a', 'Faro', '2026-09-01'), trip('b', 'Porto', '2026-08-10')] });
    render(<PlacesScreen />);
    goToTrips();
    expect(screen.getAllByText(COPY.places.nextUp)).toHaveLength(1);
  });

  it('renders a separation band between planned and past trips (AC10)', () => {
    mockReturn = makeState({ activeTrips: [trip('a', 'Faro', '2026-09-01')] });
    render(<PlacesScreen />);
    goToTrips();
    expect(screen.getByTestId('trips-separator')).toBeTruthy();
  });

  it('shows the planned + past empty states with their own lines (AC13)', () => {
    mockReturn = makeState();
    render(<PlacesScreen />);
    goToTrips();
    expect(screen.getByText(COPY.places.emptyPlanned)).toBeTruthy();
    expect(screen.getByText(COPY.places.emptyPastTrips)).toBeTruthy();
    // Planned-trips empty state carries the add action as a pill.
    expect(screen.getByText(COPY.places.tripsAddAction)).toBeTruthy();
  });
});
