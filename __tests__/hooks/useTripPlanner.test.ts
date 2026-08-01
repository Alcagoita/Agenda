/**
 * KAN-234 — useTripPlanner hook tests.
 *
 * Covers independently-testable hook behaviour (no JSX):
 *   - destination search: debounced autocomplete, selecting a suggestion
 *     uses its lat/lng (Nominatim, KAN-320) and advances to the dates step
 *   - dates step: skipDates / goToRadius both advance to the radius step
 *   - radius step: estimatedBytes and radiusMeters update when radiusKey changes
 *   - confirmDownload: calls downloadTripArea then addTrip with a fresh
 *     cacheAreaId/expiresAt, shows a toast, and calls onDone
 *   - confirmDownload failure: surfaces an error and returns to the radius step
 *   - goBack: destination ← dates ← radius
 */

jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => ({ currentUser: { uid: 'test-uid' } }),
}));
jest.mock('@react-native-firebase/auth', () => ({}));

// tripDownload.ts (requireActual'd below, for its real constants/pure
// functions) transitively imports NetInfo and habitatCache.ts (which pulls
// in expo-sqlite, ESM, breaks Jest's transform) — not under test here.
jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);
jest.mock('../../src/services/habitatCache');

const mockSearchDestinationAutocomplete = jest.fn();
jest.mock('../../src/services/maps', () => ({
  searchDestinationAutocomplete: (...args: unknown[]) => mockSearchDestinationAutocomplete(...args),
}));

const mockAddTrip = jest.fn();
const mockGetCategories = jest.fn().mockResolvedValue([]);
const mockGetTrip = jest.fn();
const mockUpdateTrip = jest.fn();
jest.mock('../../src/services/firestore', () => ({
  addTrip: (...args: unknown[]) => mockAddTrip(...args),
  getCategories: (...args: unknown[]) => mockGetCategories(...args),
  getTrip: (...args: unknown[]) => mockGetTrip(...args),
  updateTrip: (...args: unknown[]) => mockUpdateTrip(...args),
}));

// tripDownload.ts (requireActual'd below) imports updateTrip directly from
// this submodule, not the firestore/ barrel above — it transitively pulls
// in real @react-native-firebase/firestore otherwise. Not under test here.
jest.mock('../../src/services/firestore/trips', () => ({
  updateTrip: jest.fn().mockResolvedValue(undefined),
}));

const mockDownloadTripArea = jest.fn();
jest.mock('../../src/services/tripDownload', () => {
  const actual = jest.requireActual('../../src/services/tripDownload');
  return {
    ...actual,
    downloadTripArea: (...args: unknown[]) => mockDownloadTripArea(...args),
  };
});

const mockShowToast = jest.fn();
jest.mock('../../src/store/toastStore', () => ({
  useToastStore: { getState: () => ({ showToast: mockShowToast }) },
}));

import { act, renderHook, waitFor } from '@testing-library/react-native';
import NetInfo from '@react-native-community/netinfo';
import { useTripPlanner } from '../../src/hooks/useTripPlanner';
import { deleteTripAreaPlaces as mockDeleteTripAreaPlaces } from '../../src/services/habitatCache';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCategories.mockResolvedValue([]);
  mockGetTrip.mockResolvedValue(null);
  mockUpdateTrip.mockResolvedValue(undefined);
  (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true });
});

const EDIT_TRIP = {
  id: 'trip-1',
  destination: 'Faro',
  placeRef: 'place-1',
  centerLat: 37.0179,
  centerLng: -7.9304,
  startDate: '2026-07-24',
  endDate: '2026-07-28',
  areaRadius: 15_000,
  cacheAreaId: 'ta_existing',
  expiresAt: 1_800_000_000_000,
  createdAt: {} as unknown,
};

describe('destination step', () => {
  it('debounces autocomplete search as the user types', async () => {
    jest.useFakeTimers();
    mockSearchDestinationAutocomplete.mockResolvedValue([{ placeId: 'p1', name: 'Faro', address: 'Portugal' }]);

    const onDone = jest.fn();
    const { result } = renderHook(() => useTripPlanner(onDone));

    act(() => { result.current.setQuery('Far'); });
    expect(mockSearchDestinationAutocomplete).not.toHaveBeenCalled();

    await act(async () => { jest.advanceTimersByTime(300); });
    expect(mockSearchDestinationAutocomplete).toHaveBeenCalledWith('Far');

    jest.useRealTimers();
  });

  it('sets searching true while the debounced request is in flight, false once it resolves', async () => {
    jest.useFakeTimers();
    let resolveSearch: (v: unknown[]) => void = () => {};
    mockSearchDestinationAutocomplete.mockReturnValue(new Promise(resolve => { resolveSearch = resolve; }));

    const { result } = renderHook(() => useTripPlanner(jest.fn()));

    act(() => { result.current.setQuery('Far'); });
    expect(result.current.searching).toBe(false);

    await act(async () => { jest.advanceTimersByTime(300); });
    expect(result.current.searching).toBe(true);

    await act(async () => { resolveSearch([]); });
    expect(result.current.searching).toBe(false);

    jest.useRealTimers();
  });

  it('clears searching when the query is emptied mid-debounce', async () => {
    jest.useFakeTimers();
    mockSearchDestinationAutocomplete.mockReturnValue(new Promise(() => {})); // never resolves

    const { result } = renderHook(() => useTripPlanner(jest.fn()));

    act(() => { result.current.setQuery('Far'); });
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(result.current.searching).toBe(true);

    act(() => { result.current.setQuery(''); });
    expect(result.current.searching).toBe(false);

    jest.useRealTimers();
  });

  it('selecting a suggestion uses its lat/lng and advances to the dates step', async () => {
    const { result } = renderHook(() => useTripPlanner(jest.fn()));

    await act(async () => {
      await result.current.selectDestination({ placeId: 'p1', name: 'Faro', address: 'Portugal', lat: 37.0179, lng: -7.9304 });
    });

    expect(result.current.step).toBe('dates');
    expect(result.current.destination).toEqual({ placeId: 'p1', name: 'Faro', lat: 37.0179, lng: -7.9304 });
  });

  it('surfaces an error and stays on the destination step when the suggestion has no coordinates', async () => {
    const { result } = renderHook(() => useTripPlanner(jest.fn()));

    await act(async () => {
      await result.current.selectDestination({ placeId: 'p1', name: 'Faro', address: 'Portugal' });
    });

    expect(result.current.step).toBe('destination');
    expect(result.current.error).not.toBeNull();
  });

  it('does not re-fire the debounced search once a destination has been selected (KAN-234 review fix)', async () => {
    jest.useFakeTimers();

    const { result } = renderHook(() => useTripPlanner(jest.fn()));

    await act(async () => {
      await result.current.selectDestination({ placeId: 'p1', name: 'Faro', address: 'Portugal', lat: 37.0179, lng: -7.9304 });
    });
    mockSearchDestinationAutocomplete.mockClear();

    // selectDestination internally calls setQuery(suggestion.name), which
    // re-triggers the debounced-search effect exactly like real typing would
    // — the "just selected" guard must suppress this one re-fire.
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(mockSearchDestinationAutocomplete).not.toHaveBeenCalled();

    jest.useRealTimers();
  });
});

describe('dates step', () => {
  async function goToDatesStep() {
    const { result } = renderHook(() => useTripPlanner(jest.fn()));
    await act(async () => {
      await result.current.selectDestination({ placeId: 'p1', name: 'Faro', address: '', lat: 1, lng: 2 });
    });
    return result;
  }

  it('skipDates clears dates and advances to radius', async () => {
    const result = await goToDatesStep();
    act(() => { result.current.setStartDate('2026-07-20'); });
    act(() => { result.current.skipDates(); });

    expect(result.current.step).toBe('radius');
    expect(result.current.startDate).toBeUndefined();
    expect(result.current.endDate).toBeUndefined();
  });

  it('goToRadius keeps whatever dates were set', async () => {
    const result = await goToDatesStep();
    act(() => { result.current.setStartDate('2026-07-20'); result.current.setEndDate('2026-07-27'); });
    act(() => { result.current.goToRadius(); });

    expect(result.current.step).toBe('radius');
    expect(result.current.startDate).toBe('2026-07-20');
    expect(result.current.endDate).toBe('2026-07-27');
  });
});

describe('initialStartDate prefill (KAN-243)', () => {
  it('pre-fills startDate when provided, still requiring a destination first', async () => {
    const { result } = renderHook(() => useTripPlanner(jest.fn(), '2026-07-24'));
    expect(result.current.step).toBe('destination');
    expect(result.current.startDate).toBe('2026-07-24');
  });

  it('is still editable/clearable like any other trip date', async () => {
    const { result } = renderHook(() => useTripPlanner(jest.fn(), '2026-07-24'));
    await act(async () => {
      await result.current.selectDestination({ placeId: 'p1', name: 'Faro', address: '', lat: 1, lng: 2 });
    });
    expect(result.current.startDate).toBe('2026-07-24');

    act(() => { result.current.skipDates(); });
    expect(result.current.startDate).toBeUndefined();
  });

  it('defaults to undefined when omitted (manual "Going somewhere?" entry)', () => {
    const { result } = renderHook(() => useTripPlanner(jest.fn()));
    expect(result.current.startDate).toBeUndefined();
  });

  it('ignores a malformed prefill instead of passing it through to the dates step', () => {
    const { result } = renderHook(() => useTripPlanner(jest.fn(), 'not-a-date'));
    expect(result.current.startDate).toBeUndefined();
  });

  it('ignores a prefill with an impossible calendar date (e.g. Feb 30)', () => {
    const { result } = renderHook(() => useTripPlanner(jest.fn(), '2026-02-30'));
    expect(result.current.startDate).toBeUndefined();
  });
});

describe('initialDestinationQuery prefill (KAN-245)', () => {
  it('seeds the query field, still requiring the user to pick a suggestion', () => {
    const { result } = renderHook(() => useTripPlanner(jest.fn(), undefined, 'Berlin, Germany'));
    expect(result.current.query).toBe('Berlin, Germany');
    expect(result.current.destination).toBeNull();
  });

  it('trims the prefill', () => {
    const { result } = renderHook(() => useTripPlanner(jest.fn(), undefined, '  Berlin, Germany  '));
    expect(result.current.query).toBe('Berlin, Germany');
  });

  it('defaults to an empty query when omitted', () => {
    const { result } = renderHook(() => useTripPlanner(jest.fn()));
    expect(result.current.query).toBe('');
  });
});

describe('radius step', () => {
  async function goToRadiusStep() {
    const { result } = renderHook(() => useTripPlanner(jest.fn()));
    await act(async () => {
      await result.current.selectDestination({ placeId: 'p1', name: 'Faro', address: '', lat: 1, lng: 2 });
    });
    act(() => { result.current.skipDates(); });
    return result;
  }

  it('estimatedBytes and radiusMeters change when radiusKey changes', async () => {
    const result = await goToRadiusStep();
    const initialEstimate = result.current.estimatedBytes;

    act(() => { result.current.setRadiusKey('region'); });

    expect(result.current.estimatedBytes).toBeGreaterThan(initialEstimate);
    expect(result.current.radiusMeters).toBe(40_000);
  });
});

describe('edit mode (KAN-266)', () => {
  it('loads an existing trip and opens on the requested dates step', async () => {
    mockGetTrip.mockResolvedValue(EDIT_TRIP);

    const { result } = renderHook(() =>
      useTripPlanner(jest.fn(), undefined, undefined, { editTripId: 'trip-1', initialStep: 'dates' }),
    );

    await waitFor(() => expect(result.current.destination?.name).toBe('Faro'));

    expect(result.current.isEditing).toBe(true);
    expect(result.current.step).toBe('dates');
    expect(result.current.startDate).toBe('2026-07-24');
    expect(result.current.endDate).toBe('2026-07-28');
  });

  it('exits edit mode with a toast when the trip cannot be found', async () => {
    mockGetTrip.mockResolvedValue(null);
    const onDone = jest.fn();

    renderHook(() =>
      useTripPlanner(onDone, undefined, undefined, { editTripId: 'missing-trip', initialStep: 'dates' }),
    );

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(expect.any(String)));
    expect(onDone).toHaveBeenCalled();
  });

  it('exits edit mode with a toast when loading the trip fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetTrip.mockRejectedValue(new Error('network'));
    const onDone = jest.fn();

    renderHook(() =>
      useTripPlanner(onDone, undefined, undefined, { editTripId: 'trip-1', initialStep: 'radius' }),
    );

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(expect.any(String)));
    expect(onDone).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[useTripPlanner] getTrip failed', expect.any(Error));
    warnSpy.mockRestore();
  });

  it('saves changed dates to the existing trip without creating a duplicate', async () => {
    mockGetTrip.mockResolvedValue(EDIT_TRIP);
    const onDone = jest.fn();
    const { result } = renderHook(() =>
      useTripPlanner(onDone, undefined, undefined, { editTripId: 'trip-1', initialStep: 'dates' }),
    );
    await waitFor(() => expect(result.current.destination?.name).toBe('Faro'));

    act(() => {
      result.current.setStartDate('2026-07-25');
      result.current.setEndDate('2026-07-30');
    });
    await act(async () => { await result.current.confirmDownload(); });

    expect(mockUpdateTrip).toHaveBeenCalledWith('test-uid', 'trip-1', expect.objectContaining({
      startDate: '2026-07-25',
      endDate:   '2026-07-30',
    }));
    expect(mockAddTrip).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('downloads into the existing cache area when the radius grows online', async () => {
    mockGetTrip.mockResolvedValue(EDIT_TRIP);
    mockDownloadTripArea.mockResolvedValue(5);
    const { result } = renderHook(() =>
      useTripPlanner(jest.fn(), undefined, undefined, { editTripId: 'trip-1', initialStep: 'radius' }),
    );
    await waitFor(() => expect(result.current.destination?.name).toBe('Faro'));

    act(() => { result.current.setRadiusKey('region'); });
    await act(async () => { await result.current.confirmDownload(); });

    expect(mockUpdateTrip).toHaveBeenCalledWith('test-uid', 'trip-1', expect.objectContaining({ areaRadius: 40_000 }));
    expect(mockDownloadTripArea).toHaveBeenCalledWith(
      { lat: 37.0179, lng: -7.9304 },
      40_000,
      'ta_existing',
      expect.any(Number),
      [],
    );
    expect(mockAddTrip).not.toHaveBeenCalled();
  });

  it('does not redownload when the radius shrinks or the phone is offline', async () => {
    mockGetTrip.mockResolvedValue({ ...EDIT_TRIP, areaRadius: 40_000 });
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: false });
    const { result } = renderHook(() =>
      useTripPlanner(jest.fn(), undefined, undefined, { editTripId: 'trip-1', initialStep: 'radius' }),
    );
    await waitFor(() => expect(result.current.destination?.name).toBe('Faro'));

    act(() => { result.current.setRadiusKey('town'); });
    await act(async () => { await result.current.confirmDownload(); });

    expect(mockUpdateTrip).toHaveBeenCalledWith('test-uid', 'trip-1', expect.objectContaining({ areaRadius: 5_000 }));
    expect(mockDownloadTripArea).not.toHaveBeenCalled();
  });

  it('keeps the previous radius for offline growth so a later online edit still downloads the larger area', async () => {
    mockGetTrip.mockResolvedValue(EDIT_TRIP);
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: false });
    const firstDone = jest.fn();
    const first = renderHook(() =>
      useTripPlanner(firstDone, undefined, undefined, { editTripId: 'trip-1', initialStep: 'radius' }),
    );
    await waitFor(() => expect(first.result.current.destination?.name).toBe('Faro'));

    act(() => { first.result.current.setRadiusKey('region'); });
    await act(async () => { await first.result.current.confirmDownload(); });

    expect(mockDownloadTripArea).not.toHaveBeenCalled();
    expect(mockUpdateTrip).toHaveBeenCalledWith('test-uid', 'trip-1', expect.not.objectContaining({ areaRadius: 40_000 }));
    expect(firstDone).toHaveBeenCalled();

    mockGetTrip.mockResolvedValue(EDIT_TRIP);
    mockUpdateTrip.mockClear();
    mockDownloadTripArea.mockClear();
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true });
    mockDownloadTripArea.mockResolvedValue(5);

    const second = renderHook(() =>
      useTripPlanner(jest.fn(), undefined, undefined, { editTripId: 'trip-1', initialStep: 'radius' }),
    );
    await waitFor(() => expect(second.result.current.destination?.name).toBe('Faro'));

    act(() => { second.result.current.setRadiusKey('region'); });
    await act(async () => { await second.result.current.confirmDownload(); });

    expect(mockDownloadTripArea).toHaveBeenCalledWith(
      { lat: 37.0179, lng: -7.9304 },
      40_000,
      'ta_existing',
      expect.any(Number),
      [],
    );
    expect(mockUpdateTrip).toHaveBeenCalledWith('test-uid', 'trip-1', expect.objectContaining({ areaRadius: 40_000 }));
  });
});

describe('confirmDownload', () => {
  async function goToRadiusStep() {
    const { result } = renderHook(() => useTripPlanner(onDoneMock));
    await act(async () => {
      await result.current.selectDestination({ placeId: 'p1', name: 'Faro', address: '', lat: 1, lng: 2 });
    });
    act(() => { result.current.skipDates(); });
    return result;
  }

  let onDoneMock: jest.Mock;
  beforeEach(() => { onDoneMock = jest.fn(); });

  it('downloads the area, creates the trip, shows a toast, and calls onDone', async () => {
    mockDownloadTripArea.mockResolvedValue(5);
    mockAddTrip.mockResolvedValue('trip-1');
    const result = await goToRadiusStep();

    await act(async () => { await result.current.confirmDownload(); });

    expect(mockDownloadTripArea).toHaveBeenCalledWith(
      { lat: 1, lng: 2 }, expect.any(Number), expect.any(String), expect.any(Number), [],
    );
    expect(mockAddTrip).toHaveBeenCalledWith('test-uid', expect.objectContaining({
      destination: 'Faro', placeRef: 'p1', centerLat: 1, centerLng: 2,
    }));
    expect(mockShowToast).toHaveBeenCalled();
    expect(onDoneMock).toHaveBeenCalled();
  });

  it('surfaces an error and returns to the radius step on failure', async () => {
    mockDownloadTripArea.mockRejectedValue(new Error('network down'));
    const result = await goToRadiusStep();

    await act(async () => { await result.current.confirmDownload(); });

    expect(result.current.step).toBe('radius');
    expect(result.current.error).not.toBeNull();
    expect(onDoneMock).not.toHaveBeenCalled();
  });

  it('rolls back the downloaded cache rows when addTrip fails after a successful download (KAN-234 review fix)', async () => {
    mockDownloadTripArea.mockResolvedValue(5);
    mockAddTrip.mockRejectedValue(new Error('firestore unavailable'));
    const result = await goToRadiusStep();

    await act(async () => { await result.current.confirmDownload(); });

    expect(mockDownloadTripArea).toHaveBeenCalled();
    const [, , cacheAreaId] = mockDownloadTripArea.mock.calls[0];
    expect(mockDeleteTripAreaPlaces).toHaveBeenCalledWith(cacheAreaId);
    expect(result.current.step).toBe('radius');
    expect(result.current.error).not.toBeNull();
    expect(onDoneMock).not.toHaveBeenCalled();
  });
});

describe('goBack', () => {
  it('steps back radius -> dates -> destination', async () => {
    const { result } = renderHook(() => useTripPlanner(jest.fn()));

    await act(async () => {
      await result.current.selectDestination({ placeId: 'p1', name: 'Faro', address: '', lat: 1, lng: 2 });
    });
    act(() => { result.current.goToRadius(); });
    expect(result.current.step).toBe('radius');

    act(() => { result.current.goBack(); });
    expect(result.current.step).toBe('dates');

    act(() => { result.current.goBack(); });
    expect(result.current.step).toBe('destination');
  });
});
