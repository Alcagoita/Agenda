/**
 * PlacesScreen — KAN-304 UI contract.
 *
 * Mocks usePlaces so we test rendering, not data fetching. Covers the all-empty
 * fixture (AC9), the cap + overflow row (AC5), the taught marker (AC6) and the
 * "Teach it a new place" action (AC7).
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { COPY } from '../../src/constants/copy';

let mockReturn: ReturnType<typeof makeState>;
function makeState(over: Partial<ReturnType<typeof base>> = {}) { return { ...base(), ...over }; }
function base() {
  return {
    loading: false,
    places: [] as Array<{ poiType: string; name: string; taught: boolean; id?: string }>,
    activeTrips: [] as unknown[],
    pastTripGroups: [] as unknown[],
    addPlace: jest.fn(), removePlace: jest.fn(), forgetTrip: jest.fn(), refresh: jest.fn(),
  };
}

jest.mock('../../src/hooks/usePlaces', () => ({ usePlaces: () => mockReturn }));

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff', surface: '#f6f5f1', surface2: '#efeeea', text: '#000', muted: '#999',
      faint: '#ccc', line: '#ddd', accent: '#e8a86a', onAccent: '#fff', scrim: 'rgba(0,0,0,0.2)',
      nearTint: '#fff', nearText: '#7a4a20',
    },
  }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock('@react-navigation/native-stack', () => ({}));
jest.mock('../../src/components/AppIcon', () => ({
  ChevronLeftIcon: () => null, ChevronRightIcon: () => null, PlusIcon: () => null,
  CloseIcon: () => null, SuitcaseIcon: () => null, FilledStarIcon: () => null, PoiIcon: () => null,
}));

import PlacesScreen from '../../src/screens/PlacesScreen';

describe('PlacesScreen', () => {
  it('renders all three empty states, with an action only on Trips (AC9)', () => {
    mockReturn = makeState();
    render(<PlacesScreen />);
    expect(screen.getByText(COPY.places.emptyPlaces)).toBeTruthy();
    expect(screen.getByText(COPY.places.emptyTrips)).toBeTruthy();
    expect(screen.getByText(COPY.places.emptyPastTrips)).toBeTruthy();
    expect(screen.getByText(COPY.places.emptyTripsAction)).toBeTruthy();
    // Teach action is always available.
    expect(screen.getByText(COPY.places.teachAction)).toBeTruthy();
  });

  it('caps at 5 rows and shows the overflow row with the true total (AC5)', () => {
    const places = Array.from({ length: 7 }, (_, i) => ({ poiType: 'cafe', name: `Brand ${i}`, taught: false }));
    mockReturn = makeState({ places });
    render(<PlacesScreen />);
    // Only the first 5 render; #5/#6 are behind the overflow row.
    expect(screen.getByText('Brand 4')).toBeTruthy();
    expect(screen.queryByText('Brand 5')).toBeNull();
    expect(screen.getByText(COPY.places.allPlaces(7))).toBeTruthy();
  });

  it('shows no overflow row when everything fits', () => {
    const places = Array.from({ length: 3 }, (_, i) => ({ poiType: 'cafe', name: `Brand ${i}`, taught: false }));
    mockReturn = makeState({ places });
    render(<PlacesScreen />);
    expect(screen.queryByText(COPY.places.allPlaces(3))).toBeNull();
  });

  it('marks a taught brand (AC6)', () => {
    mockReturn = makeState({ places: [{ poiType: 'cafe', name: 'Sightglass', taught: true, id: 't1' }] });
    render(<PlacesScreen />);
    expect(screen.getByLabelText(COPY.places.taughtMarkerA11y)).toBeTruthy();
  });
});
