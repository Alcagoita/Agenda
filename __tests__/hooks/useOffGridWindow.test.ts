/**
 * KAN-246 — useOffGridWindow hook tests.
 *
 * Covers:
 *   - confirm() requires a duration first
 *   - confirm() with no destination override uses the current position and
 *     the "this area" label
 *   - confirm() with a destination override uses its resolved center/name
 *   - confirm() downloads the area then writes a kind:'offgrid' Trip, shows
 *     the confirmation toast, and calls onDone
 *   - confirm() failure surfaces an error, rolls back the cache write, and
 *     does not call onDone
 *   - destination override: debounced autocomplete, selecting a suggestion
 *     uses its lat/lng (Nominatim, KAN-320), clearing it resets the query
 */

jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => ({ currentUser: { uid: 'test-uid' } }),
}));
jest.mock('@react-native-firebase/auth', () => ({}));

const mockSearchDestinationAutocomplete = jest.fn();
jest.mock('../../src/services/maps', () => ({
  searchDestinationAutocomplete: (...args: unknown[]) => mockSearchDestinationAutocomplete(...args),
}));

const mockAddTrip = jest.fn();
const mockGetCategories = jest.fn().mockResolvedValue([]);
jest.mock('../../src/services/firestore', () => ({
  addTrip: (...args: unknown[]) => mockAddTrip(...args),
  getCategories: (...args: unknown[]) => mockGetCategories(...args),
}));

const mockDownloadTripArea = jest.fn();
jest.mock('../../src/services/tripDownload', () => ({
  downloadTripArea: (...args: unknown[]) => mockDownloadTripArea(...args),
  TRIP_RADIUS_PRESETS: [
    { key: 'town', radiusMeters: 5_000 },
    { key: 'town_and_around', radiusMeters: 15_000 },
    { key: 'region', radiusMeters: 40_000 },
  ],
}));

const mockDeleteTripAreaPlaces = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/habitatCache', () => ({
  deleteTripAreaPlaces: (...args: unknown[]) => mockDeleteTripAreaPlaces(...args),
}));

const mockGetCurrentPosition = jest.fn();
jest.mock('../../src/services/geolocation', () => ({
  getCurrentPosition: (...args: unknown[]) => mockGetCurrentPosition(...args),
}));

const mockShowToast = jest.fn();
jest.mock('../../src/store/toastStore', () => ({
  useToastStore: { getState: () => ({ showToast: mockShowToast }) },
}));

import { act, renderHook } from '@testing-library/react-native';
import { useOffGridWindow } from '../../src/hooks/useOffGridWindow';
import { COPY } from '../../src/constants/copy';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCategories.mockResolvedValue([]);
  mockGetCurrentPosition.mockResolvedValue({ lat: 10, lng: 20, accuracy: 10, timestamp: Date.now() });
  mockDownloadTripArea.mockResolvedValue(5);
  mockAddTrip.mockResolvedValue('trip-1');
});

describe('confirm()', () => {
  it('cannot confirm before a duration is chosen', () => {
    const { result } = renderHook(() => useOffGridWindow(jest.fn()));
    expect(result.current.canConfirm).toBe(false);
  });

  it('with no destination override, downloads around the current position and labels it "this area"', async () => {
    const onDone = jest.fn();
    const { result } = renderHook(() => useOffGridWindow(onDone));
    act(() => { result.current.setDuration('few_hours'); });

    await act(async () => { await result.current.confirm(); });

    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1);
    expect(mockDownloadTripArea).toHaveBeenCalledWith(
      { lat: 10, lng: 20 },
      expect.any(Number),
      expect.stringMatching(/^og_/),
      expect.any(Number),
    );
    expect(mockAddTrip).toHaveBeenCalledWith('test-uid', expect.objectContaining({
      destination: COPY.offGrid.currentAreaLabel,
      centerLat: 10,
      centerLng: 20,
      kind: 'offgrid',
    }));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('with a destination override, downloads around its resolved center and uses its name', async () => {
    const { result } = renderHook(() => useOffGridWindow(jest.fn()));

    await act(async () => {
      await result.current.selectDestinationOverride({ placeId: 'p1', name: 'Faro', address: 'Portugal', lat: 37.0179, lng: -7.9304 });
    });
    act(() => { result.current.setDuration('few_hours'); });

    await act(async () => { await result.current.confirm(); });

    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
    expect(mockDownloadTripArea).toHaveBeenCalledWith(
      { lat: 37.0179, lng: -7.9304 },
      expect.any(Number),
      expect.any(String),
      expect.any(Number),
    );
    expect(mockAddTrip).toHaveBeenCalledWith('test-uid', expect.objectContaining({
      destination: 'Faro',
      placeRef: 'p1',
      kind: 'offgrid',
    }));
  });

  it('on download failure, surfaces an error, rolls back the cache write, and does not call onDone', async () => {
    mockDownloadTripArea.mockRejectedValue(new Error('network down'));
    const onDone = jest.fn();
    const { result } = renderHook(() => useOffGridWindow(onDone));
    act(() => { result.current.setDuration('few_hours'); });

    await act(async () => { await result.current.confirm(); });

    expect(result.current.error).toBe(COPY.offGrid.errorToast);
    expect(mockDeleteTripAreaPlaces).toHaveBeenCalledWith(expect.stringMatching(/^og_/));
    expect(mockAddTrip).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('on Firestore write failure after a successful download, still rolls back the cache write', async () => {
    mockAddTrip.mockRejectedValue(new Error('firestore down'));
    const { result } = renderHook(() => useOffGridWindow(jest.fn()));
    act(() => { result.current.setDuration('few_hours'); });

    await act(async () => { await result.current.confirm(); });

    expect(result.current.error).toBe(COPY.offGrid.errorToast);
    expect(mockDeleteTripAreaPlaces).toHaveBeenCalledWith(expect.stringMatching(/^og_/));
  });
});

describe('destination override', () => {
  it('debounces autocomplete search as the user types', async () => {
    jest.useFakeTimers();
    mockSearchDestinationAutocomplete.mockResolvedValue([{ placeId: 'p1', name: 'Faro', address: 'Portugal' }]);

    const { result } = renderHook(() => useOffGridWindow(jest.fn()));

    act(() => { result.current.setDestinationQuery('Far'); });
    expect(mockSearchDestinationAutocomplete).not.toHaveBeenCalled();

    await act(async () => { jest.advanceTimersByTime(300); });
    expect(mockSearchDestinationAutocomplete).toHaveBeenCalledWith('Far');

    jest.useRealTimers();
  });

  it('sets destinationSearching true while the debounced request is in flight, false once it resolves', async () => {
    jest.useFakeTimers();
    let resolveSearch: (v: unknown[]) => void = () => {};
    mockSearchDestinationAutocomplete.mockReturnValue(new Promise(resolve => { resolveSearch = resolve; }));

    const { result } = renderHook(() => useOffGridWindow(jest.fn()));

    act(() => { result.current.setDestinationQuery('Far'); });
    expect(result.current.destinationSearching).toBe(false);

    await act(async () => { jest.advanceTimersByTime(300); });
    expect(result.current.destinationSearching).toBe(true);

    await act(async () => { resolveSearch([]); });
    expect(result.current.destinationSearching).toBe(false);

    jest.useRealTimers();
  });

  it('selecting a suggestion uses its lat/lng', async () => {
    const { result } = renderHook(() => useOffGridWindow(jest.fn()));

    await act(async () => {
      await result.current.selectDestinationOverride({ placeId: 'p1', name: 'Faro', address: 'Portugal', lat: 37.0179, lng: -7.9304 });
    });

    expect(result.current.destinationOverride).toEqual({
      placeId: 'p1', name: 'Faro', lat: 37.0179, lng: -7.9304,
    });
  });

  it('ignores a suggestion with no coordinates', async () => {
    const { result } = renderHook(() => useOffGridWindow(jest.fn()));

    await act(async () => {
      await result.current.selectDestinationOverride({ placeId: 'p1', name: 'Faro', address: 'Portugal' });
    });

    expect(result.current.destinationOverride).toBeNull();
  });

  it('clearDestinationOverride resets the override and query', async () => {
    const { result } = renderHook(() => useOffGridWindow(jest.fn()));

    await act(async () => {
      await result.current.selectDestinationOverride({ placeId: 'p1', name: 'Faro', address: 'Portugal', lat: 37.0179, lng: -7.9304 });
    });
    act(() => { result.current.clearDestinationOverride(); });

    expect(result.current.destinationOverride).toBeNull();
    expect(result.current.destinationQuery).toBe('');
  });
});
