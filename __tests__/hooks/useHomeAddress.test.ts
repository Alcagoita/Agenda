/**
 * KAN-247 — useHomeAddress hook tests.
 *
 * Covers:
 *   - initial load: reads home from getUser, loading flips false either way
 *   - debounced address search, suppressed right after a selection (mirrors
 *     useTripPlanner's "just selected" guard)
 *   - selectSuggestion: uses the suggestion's lat/lng (Nominatim, KAN-320),
 *     saves via setHome, updates local state and the home.ts module state
 *   - selectSuggestion failure: surfaces an error, does not touch saved state
 *   - clear: clears via clearHome, resets local state and home.ts module state
 *   - clear failure: surfaces an error
 */

jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => ({ currentUser: { uid: 'test-uid' } }),
}));
jest.mock('@react-native-firebase/auth', () => ({}));

const mockSearchAddressAutocomplete = jest.fn();
jest.mock('../../src/services/maps', () => ({
  searchAddressAutocomplete: (...args: unknown[]) => mockSearchAddressAutocomplete(...args),
}));

const mockGetUser = jest.fn();
const mockSetHome = jest.fn();
const mockClearHome = jest.fn();
jest.mock('../../src/services/firestore', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  setHome: (...args: unknown[]) => mockSetHome(...args),
  clearHome: (...args: unknown[]) => mockClearHome(...args),
}));

const mockSetHomeLocation = jest.fn();
jest.mock('../../src/services/home', () => ({
  setHomeLocation: (...args: unknown[]) => mockSetHomeLocation(...args),
}));

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useHomeAddress } from '../../src/hooks/useHomeAddress';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockResolvedValue(null);
});

describe('initial load', () => {
  it('loads an existing home from getUser and flips loading false', async () => {
    mockGetUser.mockResolvedValue({ home: { address: '221B Baker Street', lat: 51.5, lng: -0.1 } });

    const { result } = renderHook(() => useHomeAddress());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.home).toEqual({ address: '221B Baker Street', lat: 51.5, lng: -0.1 });
  });

  it('flips loading false with home null when the user has none set', async () => {
    mockGetUser.mockResolvedValue({});

    const { result } = renderHook(() => useHomeAddress());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.home).toBeNull();
  });
});

describe('address search', () => {
  it('debounces autocomplete search as the user types', async () => {
    jest.useFakeTimers();
    mockSearchAddressAutocomplete.mockResolvedValue([{ placeId: 'p1', name: 'Baker Street', address: 'London' }]);

    const { result } = renderHook(() => useHomeAddress());

    act(() => { result.current.setQuery('Baker'); });
    expect(mockSearchAddressAutocomplete).not.toHaveBeenCalled();

    await act(async () => { jest.advanceTimersByTime(300); });
    expect(mockSearchAddressAutocomplete).toHaveBeenCalledWith('Baker');

    jest.useRealTimers();
  });

  it('sets searching true while the debounced request is in flight, false once it resolves', async () => {
    jest.useFakeTimers();
    let resolveSearch: (v: unknown[]) => void = () => {};
    mockSearchAddressAutocomplete.mockReturnValue(new Promise(resolve => { resolveSearch = resolve; }));

    const { result } = renderHook(() => useHomeAddress());

    act(() => { result.current.setQuery('Baker'); });
    expect(result.current.searching).toBe(false);

    await act(async () => { jest.advanceTimersByTime(300); });
    expect(result.current.searching).toBe(true);

    await act(async () => { resolveSearch([]); });
    expect(result.current.searching).toBe(false);

    jest.useRealTimers();
  });

  it('does not re-fire the debounced search right after a selection', async () => {
    jest.useFakeTimers();

    const { result } = renderHook(() => useHomeAddress());

    await act(async () => {
      await result.current.selectSuggestion({ placeId: 'p1', name: 'Baker Street', address: 'London', lat: 51.5, lng: -0.1 });
    });
    mockSearchAddressAutocomplete.mockClear();

    await act(async () => { jest.advanceTimersByTime(300); });
    expect(mockSearchAddressAutocomplete).not.toHaveBeenCalled();

    jest.useRealTimers();
  });
});

describe('selectSuggestion', () => {
  it('uses the suggestion lat/lng, saves, and updates local + module state', async () => {
    mockSetHome.mockResolvedValue(undefined);

    const { result } = renderHook(() => useHomeAddress());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.selectSuggestion({ placeId: 'p1', name: 'Baker Street', address: 'London, UK', lat: 51.5, lng: -0.1 });
    });

    const expected = { address: 'Baker Street, London, UK', lat: 51.5, lng: -0.1 };
    expect(success).toBe(true);
    expect(mockSetHome).toHaveBeenCalledWith('test-uid', expected);
    expect(mockSetHomeLocation).toHaveBeenCalledWith(expected);
    expect(result.current.home).toEqual(expected);
    expect(result.current.error).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  it('surfaces an error, leaves home untouched, and resolves false when the suggestion has no coordinates', async () => {
    const { result } = renderHook(() => useHomeAddress());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.selectSuggestion({ placeId: 'p1', name: 'Baker Street', address: 'London' });
    });

    expect(success).toBe(false);
    expect(mockSetHome).not.toHaveBeenCalled();
    expect(result.current.home).toBeNull();
    expect(result.current.error).not.toBeNull();
  });

  it('surfaces an error and resolves false when setHome (the Firestore write) fails', async () => {
    mockSetHome.mockRejectedValue(new Error('firestore unavailable'));

    const { result } = renderHook(() => useHomeAddress());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.selectSuggestion({ placeId: 'p1', name: 'Baker Street', address: 'London', lat: 51.5, lng: -0.1 });
    });

    expect(success).toBe(false);
    expect(result.current.home).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(mockSetHomeLocation).not.toHaveBeenCalled();
  });
});

describe('clear', () => {
  it('clears via clearHome and resets local + module state', async () => {
    mockGetUser.mockResolvedValue({ home: { address: '221B Baker Street', lat: 51.5, lng: -0.1 } });
    mockClearHome.mockResolvedValue(undefined);

    const { result } = renderHook(() => useHomeAddress());
    await waitFor(() => expect(result.current.home).not.toBeNull());

    await act(async () => { await result.current.clear(); });

    expect(mockClearHome).toHaveBeenCalledWith('test-uid');
    expect(mockSetHomeLocation).toHaveBeenCalledWith(null);
    expect(result.current.home).toBeNull();
    expect(result.current.query).toBe('');
    expect(result.current.saving).toBe(false);
  });

  it('surfaces an error when clearHome fails', async () => {
    mockGetUser.mockResolvedValue({ home: { address: '221B Baker Street', lat: 51.5, lng: -0.1 } });
    mockClearHome.mockRejectedValue(new Error('firestore unavailable'));

    const { result } = renderHook(() => useHomeAddress());
    await waitFor(() => expect(result.current.home).not.toBeNull());

    await act(async () => { await result.current.clear(); });

    expect(result.current.home).not.toBeNull();
    expect(result.current.error).not.toBeNull();
  });
});
