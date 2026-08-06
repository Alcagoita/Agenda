/**
 * ContextChip — KAN-241
 *
 * Covers the 4 offline/coverage situations (only #2/#4 render the glyph;
 * #1/#3 remain quiet) plus the tap
 * sheet: last-learned date line, and the manual refresh action.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import ContextChip from '../../src/components/ContextChip';
import { COPY } from '../../src/constants/copy';
import { useToastStore } from '../../src/store/toastStore';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff', surface: '#f6f5f1', surface2: '#efeeea',
      text: '#000', muted: '#999', faint: '#ccc', line: 'rgba(20,20,18,0.08)',
    },
  }),
}));

jest.mock('../../src/theme/tokens', () => ({
  radius:  { chip: 9999, ctaBtn: 12 },
  spacing: { page: 22 },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../src/components/AppIcon', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const mock = (name: string) => () => React.createElement(Text, null, name);
  return {
    CloudOffIcon: mock('CloudOffIcon'),
    CloseIcon:    mock('CloseIcon'),
    RefreshIcon:  mock('RefreshIcon'),
  };
});

const mockUseOfflineCoverage = jest.fn();
jest.mock('../../src/hooks/useOfflineCoverage', () => ({
  useOfflineCoverage: () => mockUseOfflineCoverage(),
}));

const mockGetMostRecentHabitatUpdateAt = jest.fn();
const mockRefreshHabitatCacheIfStale = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/habitatCache', () => ({
  getMostRecentHabitatUpdateAt: (...args: unknown[]) => mockGetMostRecentHabitatUpdateAt(...args),
  refreshHabitatCacheIfStale: (...args: unknown[]) => mockRefreshHabitatCacheIfStale(...args),
}));

const mockGetLastSearchCoords = jest.fn();
const mockGetActiveOffGridWindow = jest.fn().mockReturnValue(null);
jest.mock('../../src/services/proximity', () => ({
  getLastSearchCoords: () => mockGetLastSearchCoords(),
  getActiveOffGridWindow: () => mockGetActiveOffGridWindow(),
}));

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const mockGetCategories = jest.fn().mockResolvedValue([]);
jest.mock('../../src/services/firestore', () => ({
  getCategories: (...args: unknown[]) => mockGetCategories(...args),
}));

const mockRefreshTripArea = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/tripDownload', () => ({
  refreshTripArea: (...args: unknown[]) => mockRefreshTripArea(...args),
  getAreaDownloadPoiTypes: () => ['atm', 'library', 'shopping_mall'],
}));

jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => ({ currentUser: { uid: 'test-uid' } }),
}));
jest.mock('@react-native-firebase/auth', () => ({}));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMostRecentHabitatUpdateAt.mockReturnValue(null);
  mockGetCategories.mockResolvedValue([]);
  mockGetLastSearchCoords.mockReturnValue({ lat: 1, lng: 2 });
  mockGetActiveOffGridWindow.mockReturnValue(null);
  mockRefreshTripArea.mockResolvedValue(undefined);
  mockUseOfflineCoverage.mockReturnValue({ offline: false, hasCache: false });
});

// ─── Fixtures (KAN-242) ────────────────────────────────────────────────────────

/** Local-timezone YYYY-MM-DD, offset by `offset` days — mirrors todayISO() so date-gating assertions never drift a day against UTC around midnight (review fix; toISOString() is UTC and todayISO() is local). */
function isoDaysFromNow(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeMallContext(overrides: Partial<{ name: string }> = {}) {
  return {
    kind: 'mall' as const,
    snapshot: {
      placeId: 'mall-1',
      name: overrides.name ?? 'Colombo',
      centerLat: 0, centerLng: 0, radius: 300,
      cacheAreaId: 'mall_snapshot',
      expiresAt: Date.now() + 1_000_000,
      createdAt: { toMillis: () => Date.now() } as never,
    },
  };
}

function makeTripContext(overrides: Partial<{ destination: string; startDate?: string; endDate?: string }> = {}) {
  return {
    kind: 'trip' as const,
    trip: {
      id: 'trip-1',
      destination: overrides.destination ?? 'Faro',
      placeRef: 'place-1',
      centerLat: 0, centerLng: 0,
      startDate: overrides.startDate ?? isoDaysFromNow(-1),
      endDate: overrides.endDate ?? isoDaysFromNow(10),
      areaRadius: 5_000,
      cacheAreaId: 'ta_1',
      expiresAt: Date.now() + 1_000_000,
      createdAt: {} as never,
    },
  };
}

describe('ContextChip — the 4 situations', () => {
  it('renders nothing when online (situation #1)', () => {
    mockUseOfflineCoverage.mockReturnValue({ offline: false, hasCache: false });
    render(<ContextChip />);
    expect(screen.queryByLabelText(COPY.contextChip.offlineGlyphA11y)).toBeNull();
  });

  it('renders the glyph when offline + cache covers here (situation #2)', () => {
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
    render(<ContextChip />);
    expect(screen.getByLabelText(COPY.contextChip.offlineGlyphA11y)).toBeTruthy();
  });

  it('renders nothing when offline + no cache at all (situation #3)', () => {
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: false });
    render(<ContextChip />);
    expect(screen.queryByLabelText(COPY.contextChip.offlineGlyphA11y)).toBeNull();
  });

  it('renders the glyph when offline + cache exists but not here (situation #4 — same glyph as #2)', () => {
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
    render(<ContextChip />);
    expect(screen.getByLabelText(COPY.contextChip.offlineGlyphA11y)).toBeTruthy();
  });

  it('renders nothing while hasCache is still unknown (null) — must not flash before the real state resolves (review fix)', () => {
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: null });
    render(<ContextChip />);
    expect(screen.queryByLabelText(COPY.contextChip.offlineGlyphA11y)).toBeNull();
  });
});

describe('ContextChip — tap sheet', () => {
  beforeEach(() => {
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
  });

  it('opens the sheet on tap, showing the title and area-agnostic body when no date is known', async () => {
    mockGetMostRecentHabitatUpdateAt.mockReturnValue(null);
    render(<ContextChip />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.offlineGlyphA11y));
    });

    expect(screen.getByText(COPY.contextChip.sheetTitle)).toBeTruthy();
    expect(screen.getByText(COPY.contextChip.sheetBody(undefined))).toBeTruthy();
  });

  it('shows the last-learned date when the cache has a timestamp', async () => {
    const learnedAt = new Date('2026-06-28T12:00:00').getTime();
    mockGetMostRecentHabitatUpdateAt.mockReturnValue(learnedAt);
    render(<ContextChip />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.offlineGlyphA11y));
    });

    const expectedDate = new Date(learnedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(screen.getByText(COPY.contextChip.sheetBody(expectedDate))).toBeTruthy();
  });

  it('does not show the Refresh button while offline', async () => {
    render(<ContextChip />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.offlineGlyphA11y));
    });
    expect(screen.queryByLabelText(COPY.contextChip.refreshButton)).toBeNull();
  });

  it('closes the sheet when the close button is pressed', async () => {
    jest.useFakeTimers();
    render(<ContextChip />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.offlineGlyphA11y));
    });
    expect(screen.getByText(COPY.contextChip.sheetTitle)).toBeTruthy();

    act(() => {
      fireEvent.press(screen.getByLabelText('Close'));
    });
    act(() => { jest.advanceTimersByTime(200); }); // close animation duration
    expect(screen.queryByText(COPY.contextChip.sheetTitle)).toBeNull();
    jest.useRealTimers();
  });

  it('closes the sheet when the scrim is pressed', async () => {
    jest.useFakeTimers();
    render(<ContextChip />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.offlineGlyphA11y));
    });

    act(() => {
      fireEvent.press(screen.getByLabelText('Close sheet'));
    });
    act(() => { jest.advanceTimersByTime(200); });
    expect(screen.queryByText(COPY.contextChip.sheetTitle)).toBeNull();
    jest.useRealTimers();
  });
});

describe('ContextChip — Refresh (shown once back online, mid-sheet)', () => {
  it('shows the Refresh button once connectivity returns while the sheet is still open', async () => {
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
    const { rerender } = render(<ContextChip />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.offlineGlyphA11y));
    });
    expect(screen.queryByLabelText(COPY.contextChip.refreshButton)).toBeNull();

    // Connectivity resumes while the sheet is still open — the sheet must
    // not vanish (it's gated on its own open/close state, not on `offline`).
    mockUseOfflineCoverage.mockReturnValue({ offline: false, hasCache: true });
    await act(async () => { rerender(<ContextChip />); });

    expect(screen.getByText(COPY.contextChip.sheetTitle)).toBeTruthy();
    expect(screen.getByLabelText(COPY.contextChip.refreshButton)).toBeTruthy();
  });

  it('calls refreshHabitatCacheIfStale with force=true, the last search coords, and the curated POI allowlist', async () => {
    mockGetCategories.mockResolvedValue([
      { id: 'c1', name: 'Custom', poi: 'library' },
      { id: 'c2', name: 'Unsupported', poi: 'climbing_gym' },
    ]);
    mockGetLastSearchCoords.mockReturnValue({ lat: 10, lng: 20 });

    // Force the sheet open directly isn't possible without the glyph (chip
    // is absent while online) — simulate "was offline, tapped, came back
    // online" via a rerender, matching the real user path.
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
    const { rerender } = render(<ContextChip />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.offlineGlyphA11y));
    });
    mockUseOfflineCoverage.mockReturnValue({ offline: false, hasCache: true });
    await act(async () => { rerender(<ContextChip />); });

    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.refreshButton));
    });

    const [lat, lng, poiTypes, force] = mockRefreshHabitatCacheIfStale.mock.calls[0];
    expect(lat).toBe(10);
    expect(lng).toBe(20);
    expect(force).toBe(true);
    expect(poiTypes).toContain('library');
    expect(poiTypes).not.toContain('climbing_gym');
  });

  it('does nothing when there are no last-search coords yet', async () => {
    mockGetLastSearchCoords.mockReturnValue(null);
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
    const { rerender } = render(<ContextChip />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.offlineGlyphA11y));
    });
    mockUseOfflineCoverage.mockReturnValue({ offline: false, hasCache: true });
    await act(async () => { rerender(<ContextChip />); });

    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.refreshButton));
    });

    expect(mockRefreshHabitatCacheIfStale).not.toHaveBeenCalled();
  });
});

describe('ContextChip — mall context (KAN-242)', () => {
  it('shows the mall chip with the mall name instead of the offline glyph', () => {
    render(<ContextChip placeContext={makeMallContext({ name: 'Colombo' })} />);
    expect(screen.getByLabelText(COPY.contextChip.mallChipA11y('Colombo'))).toBeTruthy();
    expect(screen.getByText('· Colombo')).toBeTruthy();
    expect(screen.queryByLabelText(COPY.contextChip.offlineGlyphA11y)).toBeNull();
  });

  it('opens a sheet with the mall title and no refresh action', async () => {
    render(<ContextChip placeContext={makeMallContext({ name: 'Colombo' })} />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.mallChipA11y('Colombo')));
    });
    expect(screen.getByText(COPY.contextChip.mallSheetTitle('Colombo'))).toBeTruthy();
    expect(screen.getByText(COPY.contextChip.placeSheetCoverageLine, { exact: false })).toBeTruthy();
    expect(screen.queryByLabelText(COPY.contextChip.refreshButton)).toBeNull();
  });

  it('shows the offline dot modifier on the mall chip when offline (not the standalone glyph)', () => {
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
    render(<ContextChip placeContext={makeMallContext()} />);
    expect(screen.getByLabelText(COPY.contextChip.offlineDotA11y)).toBeTruthy();
    expect(screen.queryByLabelText(COPY.contextChip.offlineGlyphA11y)).toBeNull();
  });
});

describe('ContextChip — trip context (KAN-242)', () => {
  it('shows the trip chip with the destination instead of the offline glyph', () => {
    render(<ContextChip placeContext={makeTripContext({ destination: 'Faro' })} />);
    expect(screen.getByLabelText(COPY.contextChip.tripChipA11y('Faro'))).toBeTruthy();
    expect(screen.getByText('· Faro')).toBeTruthy();
  });

  it('opens a sheet with the trip title, dates, and a working refresh action', async () => {
    render(<ContextChip placeContext={makeTripContext({ destination: 'Faro' })} />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.tripChipA11y('Faro')));
    });
    expect(screen.getByText(COPY.contextChip.tripSheetTitle('Faro'))).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.refreshButton));
    });
    expect(mockRefreshTripArea).toHaveBeenCalledTimes(1);
  });

  it('does not show the trip chip once today is outside the trip dates', () => {
    render(<ContextChip placeContext={makeTripContext({ startDate: isoDaysFromNow(-10), endDate: isoDaysFromNow(-2) })} />);
    expect(screen.queryByLabelText(COPY.contextChip.tripChipA11y('Faro'))).toBeNull();
  });

  it('shows the trip chip for a dateless trip', () => {
    render(<ContextChip placeContext={makeTripContext({ startDate: undefined, endDate: undefined })} />);
    expect(screen.getByLabelText(COPY.contextChip.tripChipA11y('Faro'))).toBeTruthy();
  });

  it('disables the refresh button while offline', async () => {
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
    render(<ContextChip placeContext={makeTripContext({ destination: 'Faro' })} />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.tripChipA11y('Faro')));
    });
    const refreshBtn = screen.getByLabelText(COPY.contextChip.refreshButton);
    expect(refreshBtn.props.accessibilityState?.disabled ?? refreshBtn.props.disabled).toBeTruthy();
  });

  it('shows an error toast and re-enables the button when the trip refresh fails', async () => {
    mockRefreshTripArea.mockRejectedValueOnce(new Error('network down'));
    useToastStore.setState({ message: null });
    render(<ContextChip placeContext={makeTripContext({ destination: 'Faro' })} />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.tripChipA11y('Faro')));
    });

    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.refreshButton));
    });

    expect(useToastStore.getState().message).toBe(COPY.contextChip.placeRefreshErrorToast);
    const refreshBtn = screen.getByLabelText(COPY.contextChip.refreshButton);
    expect(refreshBtn.props.accessibilityState?.disabled ?? refreshBtn.props.disabled).toBeFalsy();
  });
});

describe('ContextChip — off-grid window (KAN-246)', () => {
  const window = { destination: 'this area', expiresAt: new Date(2026, 6, 15, 18, 0).getTime() };

  it('shows the off-grid glyph + "until HH:mm" instead of the offline glyph', () => {
    mockGetActiveOffGridWindow.mockReturnValue(window);
    render(<ContextChip />);
    expect(screen.getByLabelText(COPY.offGrid.chipA11y('18:00'))).toBeTruthy();
  });

  it('off-grid wins over the plain offline glyph when both would otherwise apply', () => {
    mockGetActiveOffGridWindow.mockReturnValue(window);
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
    render(<ContextChip />);
    expect(screen.getByLabelText(COPY.offGrid.chipA11y('18:00'))).toBeTruthy();
    expect(screen.queryByLabelText(COPY.contextChip.offlineGlyphA11y)).toBeNull();
  });

  it('a real trip context still wins over an active off-grid window', () => {
    mockGetActiveOffGridWindow.mockReturnValue(window);
    render(<ContextChip placeContext={makeTripContext({ destination: 'Faro' })} />);
    expect(screen.getByLabelText(COPY.contextChip.tripChipA11y('Faro'))).toBeTruthy();
  });

  it('opens a sheet with the off-grid title and "know until" body, no entry-point action', async () => {
    mockGetActiveOffGridWindow.mockReturnValue(window);
    render(<ContextChip />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.offGrid.chipA11y('18:00')));
    });

    expect(screen.getByText(COPY.offGrid.sheetTitle)).toBeTruthy();
    expect(screen.getByText(COPY.offGrid.sheetBody('18:00'))).toBeTruthy();
    expect(screen.queryByLabelText(COPY.offGrid.profileRowA11y)).toBeNull();
  });

  it('shows the "Going off-grid?" entry action in the offline sheet and navigates to OffGrid on tap', async () => {
    mockUseOfflineCoverage.mockReturnValue({ offline: true, hasCache: true });
    render(<ContextChip />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.offlineGlyphA11y));
    });

    expect(screen.getByLabelText(COPY.offGrid.profileRowA11y)).toBeTruthy();
    fireEvent.press(screen.getByLabelText(COPY.offGrid.profileRowA11y));
    expect(mockNavigate).toHaveBeenCalledWith('OffGrid');
  });

  it('shows the "Going off-grid?" entry action in a mall/trip sheet too', async () => {
    render(<ContextChip placeContext={makeTripContext({ destination: 'Faro' })} />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(COPY.contextChip.tripChipA11y('Faro')));
    });
    expect(screen.getByLabelText(COPY.offGrid.profileRowA11y)).toBeTruthy();
  });

  it('renders nothing extra when there is no off-grid window and everything else is quiet', () => {
    render(<ContextChip />);
    expect(screen.queryByLabelText(COPY.offGrid.chipA11y('18:00'))).toBeNull();
  });
});
