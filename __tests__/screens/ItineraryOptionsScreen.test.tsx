/**
 * KAN-281 — ItineraryOptionsScreen.
 *
 * Covers:
 *  - loading state while resolving
 *  - empty state when nothing resolves
 *  - renders the single suggestion card from the computed plan
 *  - tapping the card opens Maps with the correct origin/stops (no travelmode
 *    — the user picks that inside Maps itself)
 *  - back button navigates back
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ItineraryOptionsScreen from '../../src/screens/ItineraryOptionsScreen';

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fdfdfb', surface: '#f6f5f1', surface2: '#efeeea',
      line: 'rgba(20,20,18,0.08)', text: '#1a1a18', muted: '#8a8a85',
      faint: '#bdbdb7', accent: '#e8a86a',
    },
  }),
}));

jest.mock('../../src/components/AppIcon', () => {
  const React = require('react');
  const { View } = require('react-native');
  const stub = (props: React.ComponentProps<typeof View>) => React.createElement(View, props);
  return { ChevronLeftIcon: stub, PoiIcon: stub, ShoppingBagIcon: stub };
});

const mockGetAuth = jest.fn(() => ({ currentUser: { uid: 'user-123' } }));
jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => mockGetAuth(),
}));

const mockEnsureCurrentDay = jest.fn().mockResolvedValue({ tasks: [] });
jest.mock('../../src/services/firestore', () => ({
  ensureCurrentDay: (...args: unknown[]) => mockEnsureCurrentDay(...args),
}));

const mockGetPositionLowAccuracy = jest.fn().mockResolvedValue({ lat: 38.7, lng: -9.1, accuracy: 10, timestamp: 0 });
jest.mock('../../src/services/geolocation', () => ({
  getPositionLowAccuracy: (...args: unknown[]) => mockGetPositionLowAccuracy(...args),
}));

const mockGetLastSearchCoords = jest.fn().mockReturnValue({ lat: 38.7, lng: -9.1 });
jest.mock('../../src/services/proximity', () => ({
  getLastSearchCoords: (...args: unknown[]) => mockGetLastSearchCoords(...args),
}));

const mockOpenMultiStopDirections = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/maps', () => ({
  openMultiStopDirections: (...args: unknown[]) => mockOpenMultiStopDirections(...args),
  formatDistance: (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`),
}));

const mockResolveTripDestinations = jest.fn();
const mockPlanTrip = jest.fn();
jest.mock('../../src/services/oneTripForAll', () => ({
  resolveTripDestinations: (...args: unknown[]) => mockResolveTripDestinations(...args),
  planTrip: (...args: unknown[]) => mockPlanTrip(...args),
}));

// KAN-282 — mall card. Detection logic itself is covered by mallRoute.test.ts;
// mocked wholesale here so this file only tests the screen's own wiring.
const mockGetMallSnapshot = jest.fn().mockResolvedValue(null);
jest.mock('../../src/services/mallSnapshots', () => ({
  getMallSnapshot: (...args: unknown[]) => mockGetMallSnapshot(...args),
}));

const mockFindMallOption = jest.fn().mockReturnValue(null);
jest.mock('../../src/services/mallRoute', () => ({
  findMallOption: (...args: unknown[]) => mockFindMallOption(...args),
}));

// KAN-282 — the screen kicks off a fire-and-forget mall sweep when no mall
// qualifies. habitatCache pulls in expo-sqlite (native, unavailable under
// Jest), so mock at the service boundary.
const mockRefreshMallsIfDue = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/habitatCache', () => ({
  refreshMallsIfDue: (...args: unknown[]) => mockRefreshMallsIfDue(...args),
}));

function makeStop(id: string, name: string, source: 'learned' | 'cache' = 'cache', distanceMeters = 400) {
  return {
    task: { id, title: name, category: 'errands', done: false, date: '2026-07-16', createdAt: {}, poi: 'pharmacy' },
    place: { internalId: id, name, lat: 38.71, lng: -9.11, distanceMeters, source },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuth.mockReturnValue({ currentUser: { uid: 'user-123' } });
  mockEnsureCurrentDay.mockResolvedValue({ tasks: [] });
  mockGetPositionLowAccuracy.mockResolvedValue({ lat: 38.7, lng: -9.1, accuracy: 10, timestamp: 0 });
  mockGetLastSearchCoords.mockReturnValue({ lat: 38.7, lng: -9.1 });
  mockResolveTripDestinations.mockResolvedValue({ resolved: [], excludedCount: 0 });
  mockPlanTrip.mockReturnValue({ stops: [], excludedCount: 0, totalDistanceMeters: 0 });
  mockGetMallSnapshot.mockResolvedValue(null);
  mockFindMallOption.mockReturnValue(null);
});

describe('ItineraryOptionsScreen — loading', () => {
  it('shows a loading state before resolution settles', () => {
    render(<ItineraryOptionsScreen />);
    expect(screen.getByText('Finding the way…')).toBeTruthy();
  });

  it('calls navigation.goBack when the back button is pressed', () => {
    render(<ItineraryOptionsScreen />);
    fireEvent.press(screen.getByLabelText('Back'));
    expect(mockGoBack).toHaveBeenCalled();
  });
});

describe('ItineraryOptionsScreen — empty', () => {
  it('shows the empty state when nothing resolves', async () => {
    render(<ItineraryOptionsScreen />);
    await waitFor(() => expect(screen.getByText("Couldn't find places for any of these right now.")).toBeTruthy());
  });
});

describe('ItineraryOptionsScreen — resolved trip', () => {
  const stops = [makeStop('t1', 'Farmácia Silva', 'learned'), makeStop('t2', 'Mercado da Vila', 'cache', 400)];

  beforeEach(() => {
    mockPlanTrip.mockReturnValue({ stops, excludedCount: 1, totalDistanceMeters: 1500 });
  });

  it('renders the suggestion card with every stop from the plan', async () => {
    render(<ItineraryOptionsScreen />);
    await waitFor(() => expect(screen.getByText(/Farmácia Silva/)).toBeTruthy());
    expect(screen.getByText(/Mercado da Vila/)).toBeTruthy();
  });

  it('shows the learned-place and distance labels correctly', async () => {
    render(<ItineraryOptionsScreen />);
    await waitFor(() => expect(screen.getByText(/Farmácia Silva · your usual/)).toBeTruthy());
    expect(screen.getByText(/Mercado da Vila · 400 m/)).toBeTruthy();
  });

  it('shows the exclusion line when tasks were excluded', async () => {
    render(<ItineraryOptionsScreen />);
    await waitFor(() => expect(screen.getByText("Couldn't find a place for 1 of them")).toBeTruthy());
  });

  it('shows the approximate total distance line', async () => {
    render(<ItineraryOptionsScreen />);
    await waitFor(() => expect(screen.getByText('About 1.5 km all together')).toBeTruthy());
  });

  it('tapping the card opens Maps with the origin and stops, no travelmode', async () => {
    render(<ItineraryOptionsScreen />);
    await waitFor(() => expect(screen.getByTestId('itinerary-card')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('itinerary-card'));
    });

    expect(mockOpenMultiStopDirections).toHaveBeenCalledWith(
      { lat: 38.7, lng: -9.1, accuracy: 10, timestamp: 0 },
      [stops[0].place, stops[1].place],
    );
  });

  it('does NOT render a mall card when findMallOption returns null (the normal outcome)', async () => {
    render(<ItineraryOptionsScreen />);
    await waitFor(() => expect(screen.getByTestId('itinerary-card')).toBeTruthy());
    expect(screen.queryByTestId('mall-card')).toBeNull();
  });

  // KAN-282 — "no qualifying mall" can mean we simply have no OSM mall data
  // cached here yet, so the screen kicks off a background refresh for that
  // one type rather than waiting on proximity's 200m-movement gate. Free
  // (Overpass), fire-and-forget, and must never block or fail the render.
  it('kicks off a background mall cache refresh when no mall qualifies', async () => {
    render(<ItineraryOptionsScreen />);
    await waitFor(() => expect(screen.getByTestId('itinerary-card')).toBeTruthy());
    await waitFor(() => expect(mockRefreshMallsIfDue).toHaveBeenCalledWith(38.7, -9.1));
  });

  it('still renders normally when that background refresh rejects', async () => {
    mockRefreshMallsIfDue.mockRejectedValueOnce(new Error('Overpass unreachable'));
    render(<ItineraryOptionsScreen />);
    await waitFor(() => expect(screen.getByTestId('itinerary-card')).toBeTruthy());
    expect(screen.queryByTestId('mall-card')).toBeNull();
  });
});

describe('ItineraryOptionsScreen — mall card (KAN-282)', () => {
  const stops = [makeStop('t1', 'Farmácia Silva'), makeStop('t2', 'Mercado da Vila')];
  const mallOption = { placeId: 'mall-1', name: 'Centro Colombo', lat: 38.72, lng: -9.12, distanceMeters: 900 };

  beforeEach(() => {
    mockPlanTrip.mockReturnValue({ stops, excludedCount: 0, totalDistanceMeters: 1500 });
    mockFindMallOption.mockReturnValue(mallOption);
  });

  // The subtitle is the mall name alone — no task count. Coverage evidence
  // was retired (mallRoute.ts), so the copy must not claim any.
  it('renders below the stop-by-stop card, with the mall name and distance', async () => {
    render(<ItineraryOptionsScreen />);
    await waitFor(() => expect(screen.getByTestId('mall-card')).toBeTruthy());
    expect(screen.getByText('All in one place')).toBeTruthy();
    expect(screen.getByText('Centro Colombo')).toBeTruthy();
    expect(screen.getByText('900 m away')).toBeTruthy();
  });

  it('does NOT kick off a mall cache refresh when a mall already qualifies', async () => {
    render(<ItineraryOptionsScreen />);
    await waitFor(() => expect(screen.getByTestId('mall-card')).toBeTruthy());
    expect(mockRefreshMallsIfDue).not.toHaveBeenCalled();
  });

  it('tapping the mall card opens Maps with the mall as the single destination', async () => {
    render(<ItineraryOptionsScreen />);
    await waitFor(() => expect(screen.getByTestId('mall-card')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('mall-card'));
    });

    expect(mockOpenMultiStopDirections).toHaveBeenCalledWith(
      { lat: 38.7, lng: -9.1, accuracy: 10, timestamp: 0 },
      [mallOption],
    );
  });
});
