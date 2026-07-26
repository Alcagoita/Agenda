/**
 * AllPlacesScreen — KAN-304 full directory.
 *
 * Mocks usePlaces to test the search filter (the filtered useMemo), the taught
 * marker + removal, the loading state, and the no-match empty state.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { COPY } from '../../src/constants/copy';

let mockReturn: ReturnType<typeof base>;
function base() {
  return {
    loading: false,
    places: [] as Array<{ poiType: string; name: string; taught: boolean; id?: string }>,
    activeTrips: [], pastTripGroups: [],
    addPlace: jest.fn(), removePlace: jest.fn(), forgetTrip: jest.fn(), refresh: jest.fn(),
  };
}
function makeState(over: Partial<ReturnType<typeof base>> = {}) { return { ...base(), ...over }; }

jest.mock('../../src/hooks/usePlaces', () => ({ usePlaces: () => mockReturn }));
jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff', surface: '#f6f5f1', surface2: '#efeeea', text: '#000', muted: '#999',
      faint: '#ccc', line: '#ddd', accent: '#e8a86a', nearText: '#7a4a20',
    },
  }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
jest.mock('@react-navigation/native-stack', () => ({}));
jest.mock('../../src/components/AppIcon', () => ({
  ChevronLeftIcon: () => null, FilledStarIcon: () => null, PoiIcon: () => null,
}));

import AllPlacesScreen from '../../src/screens/AllPlacesScreen';

const PLACES = [
  { poiType: 'cafe', name: 'Sightglass', taught: true, id: 't1' },
  { poiType: 'supermarket', name: 'Whole Foods', taught: false },
];

describe('AllPlacesScreen', () => {
  it('lists every brand and filters by the search query (AC10)', () => {
    mockReturn = makeState({ places: PLACES });
    render(<AllPlacesScreen />);
    expect(screen.getByText('Sightglass')).toBeTruthy();
    expect(screen.getByText('Whole Foods')).toBeTruthy();

    fireEvent.changeText(screen.getByPlaceholderText(COPY.places.searchPlaceholder), 'whole');
    expect(screen.getByText('Whole Foods')).toBeTruthy();
    expect(screen.queryByText('Sightglass')).toBeNull();
  });

  it('shows the no-match empty state when nothing matches', () => {
    mockReturn = makeState({ places: PLACES });
    render(<AllPlacesScreen />);
    fireEvent.changeText(screen.getByPlaceholderText(COPY.places.searchPlaceholder), 'zzz');
    expect(screen.getByText(COPY.places.directoryEmpty)).toBeTruthy();
  });

  it('marks taught brands and removes them (AC6)', () => {
    const removePlace = jest.fn();
    mockReturn = makeState({ places: PLACES, removePlace });
    render(<AllPlacesScreen />);
    expect(screen.getByLabelText(COPY.places.taughtMarkerA11y)).toBeTruthy();

    fireEvent.press(screen.getByLabelText(COPY.places.removeA11y('Sightglass')));
    expect(removePlace).toHaveBeenCalledWith('t1');
  });

  it('does not render rows while loading', () => {
    mockReturn = makeState({ loading: true, places: PLACES });
    render(<AllPlacesScreen />);
    expect(screen.queryByText('Sightglass')).toBeNull();
  });
});
