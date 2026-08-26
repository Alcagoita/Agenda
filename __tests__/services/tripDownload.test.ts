/**
 * KAN-234 — tripDownload.ts: Trip Planner business logic.
 *
 * Covers:
 *   - estimateTripDownloadBytes: monotonic in radius and poiTypeCount, sane
 *     (non-zero, non-negative) for each of the 3 radius presets
 *   - computeTripExpiresAt: dateless → now + TRIP_DEFAULT_STALE_MS; dated →
 *     endDate + TRIP_END_GRACE_MS
 *   - shouldPreRefreshTrip: true/false matrix (online/offline, before/at/
 *     after the pre-departure window, already-refreshed, dateless, trip
 *     already ended)
 *   - downloadTripArea: requests the curated area-download allowlist, ignores
 *     unsupported custom types, and upserts every returned place tagged with
 *     cacheAreaId/expiresAt
 *   - refreshTripArea: re-downloads + bumps Firestore expiresAt/preRefreshedAt
 *   - checkAndRunTripPreRefresh: only refreshes due trips; one trip's
 *     failure doesn't block the others
 */

const mockSearchOsmPlaces = jest.fn();
jest.mock('../../src/services/osmPlaces', () => ({
  searchOsmPlacesStrict: (...args: unknown[]) => mockSearchOsmPlaces(...args),
}));

const mockWriteTripAreaPlaces = jest.fn((..._args: unknown[]) => {
  const places = _args[2] as unknown[];
  return places.length;
});
jest.mock('../../src/services/habitatCache', () => ({
  writeTripAreaPlaces: (...args: unknown[]) => mockWriteTripAreaPlaces(...args),
  HABITAT_BYTES_PER_ROW: 200,
}));

const mockUpdateTrip = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/firestore/trips', () => ({
  updateTrip: (...args: unknown[]) => mockUpdateTrip(...args),
}));

const mockCoverage = jest.fn();
jest.mock('../../src/services/cloudflarePoiFunctions', () => ({
  cloudflareCoverageProxy: (...args: unknown[]) => mockCoverage(...args),
}));

const mockImportExport = jest.fn();
jest.mock('../../src/services/cloudflareTripExport', () => ({
  importCloudflareTripExport: (...args: unknown[]) => mockImportExport(...args),
}));

const mockNetInfoFetch = jest.fn();
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { fetch: (...args: unknown[]) => mockNetInfoFetch(...args) },
}));

jest.mock('../../src/utils/date', () => ({
  todayISO: jest.fn(() => '2026-07-19'),
}));

import {
  TRIP_RADIUS_PRESETS,
  TRIP_DEFAULT_STALE_MS,
  TRIP_END_GRACE_MS,
  estimateTripDownloadBytes,
  computeTripExpiresAt,
  shouldPreRefreshTrip,
  downloadTripArea,
  downloadTripAreaWithCloudflare,
  downloadAreaSnapshot,
  refreshTripArea,
  checkAndRunTripPreRefresh,
  getAreaDownloadPoiTypes,
  getCloudflareTripExportSize,
  formatTripDownloadSize,
} from '../../src/services/tripDownload';
import { ALL_POI_TYPES } from '../../src/types';
import { SUPPORTED_GOOGLE_PLACE_TYPES } from '../../src/constants/googlePlaceTypes';
import type { Trip } from '../../src/types';

/** A non-empty OSM result — used everywhere a test isn't specifically about the empty-result guard, so downloadTripArea's "0 places found" check doesn't interfere. */
const SOME_PLACE = { atm: [{ osmId: 'node/1', name: 'ATM', isGenericName: false, lat: 1, lng: 2, distanceMeters: 10 }] };

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-1',
    destination: 'Faro, Portugal',
    placeRef: 'place-abc',
    centerLat: 37.0179,
    centerLng: -7.9304,
    areaRadius: 15_000,
    cacheAreaId: 'ta_123',
    expiresAt: 1_800_000_000_000,
    createdAt: { toDate: () => new Date() } as unknown as Trip['createdAt'],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNetInfoFetch.mockResolvedValue({ isConnected: true });
  mockCoverage.mockResolvedValue({ status: 'none', placeId: null });
});

describe('TRIP_RADIUS_PRESETS', () => {
  it('exposes exactly 3 presets with distinct, ascending radii', () => {
    expect(TRIP_RADIUS_PRESETS).toHaveLength(3);
    const radii = TRIP_RADIUS_PRESETS.map(p => p.radiusMeters);
    expect(radii).toEqual([...radii].sort((a, b) => a - b));
    expect(new Set(radii).size).toBe(3);
  });
});

describe('estimateTripDownloadBytes', () => {
  it('is monotonically increasing in radius', () => {
    const small = estimateTripDownloadBytes(5_000, 16);
    const large = estimateTripDownloadBytes(40_000, 16);
    expect(large).toBeGreaterThan(small);
  });

  it('is monotonically increasing in poiTypeCount', () => {
    const fewer = estimateTripDownloadBytes(15_000, 16);
    const more  = estimateTripDownloadBytes(15_000, 20);
    expect(more).toBeGreaterThan(fewer);
  });

  it('returns a sane (positive) estimate for each radius preset', () => {
    for (const preset of TRIP_RADIUS_PRESETS) {
      expect(estimateTripDownloadBytes(preset.radiusMeters, 16)).toBeGreaterThan(0);
    }
  });
});

describe('computeTripExpiresAt', () => {
  const NOW = 1_700_000_000_000;

  it('dateless — now + TRIP_DEFAULT_STALE_MS', () => {
    expect(computeTripExpiresAt(undefined, NOW)).toBe(NOW + TRIP_DEFAULT_STALE_MS);
  });

  it('dated — endDate + TRIP_END_GRACE_MS', () => {
    const endDateMs = new Date('2026-07-27T00:00:00').getTime();
    expect(computeTripExpiresAt('2026-07-27', NOW)).toBe(endDateMs + TRIP_END_GRACE_MS);
  });
});

describe('shouldPreRefreshTrip', () => {
  const TODAY = '2026-07-19';

  it('true the day before departure, online, not yet refreshed', () => {
    expect(shouldPreRefreshTrip(makeTrip({ startDate: '2026-07-20' }), TODAY, true)).toBe(true);
  });

  it('true on or after the start date too (tolerates a skipped day)', () => {
    expect(shouldPreRefreshTrip(makeTrip({ startDate: '2026-07-19', endDate: '2026-07-26' }), TODAY, true)).toBe(true);
    expect(shouldPreRefreshTrip(makeTrip({ startDate: '2026-07-15', endDate: '2026-07-26' }), TODAY, true)).toBe(true);
  });

  it('false when offline', () => {
    expect(shouldPreRefreshTrip(makeTrip({ startDate: '2026-07-20' }), TODAY, false)).toBe(false);
  });

  it('false for a dateless trip', () => {
    expect(shouldPreRefreshTrip(makeTrip({ startDate: undefined }), TODAY, true)).toBe(false);
  });

  it('false when already pre-refreshed', () => {
    expect(shouldPreRefreshTrip(makeTrip({ startDate: '2026-07-20', preRefreshedAt: Date.now() }), TODAY, true)).toBe(false);
  });

  it('false well before the window (more than a day out)', () => {
    expect(shouldPreRefreshTrip(makeTrip({ startDate: '2026-07-25' }), TODAY, true)).toBe(false);
  });

  it('false once the trip\'s endDate has passed', () => {
    expect(shouldPreRefreshTrip(makeTrip({ startDate: '2026-07-01', endDate: '2026-07-10' }), TODAY, true)).toBe(false);
  });

  it('false for a dateless-end trip more than a week past its start', () => {
    expect(shouldPreRefreshTrip(makeTrip({ startDate: '2026-07-01', endDate: undefined }), TODAY, true)).toBe(false);
  });
});

describe('downloadTripArea', () => {
  it('requests exactly the curated POI allowlist', async () => {
    mockSearchOsmPlaces.mockResolvedValue(SOME_PLACE);

    await downloadTripArea({ lat: 1, lng: 2 }, 15_000, 'ta_1', 1_800_000_000_000);

    expect(mockSearchOsmPlaces).toHaveBeenCalledTimes(1);
    const [lat, lng, poiTypes, radius] = mockSearchOsmPlaces.mock.calls[0];
    expect(lat).toBe(1);
    expect(lng).toBe(2);
    expect(radius).toBe(15_000);
    expect(new Set(poiTypes)).toEqual(new Set([
      ...ALL_POI_TYPES,
      ...SUPPORTED_GOOGLE_PLACE_TYPES,
    ]));
    expect(poiTypes.every((type: string) => (
      (ALL_POI_TYPES as readonly string[]).includes(type)
      || (SUPPORTED_GOOGLE_PLACE_TYPES as readonly string[]).includes(type)
    ))).toBe(true);
    expect(poiTypes).not.toContain('climbing_gym');
  });

  it('dedupes overlap between built-in and curated POI types', () => {
    const poiTypes = getAreaDownloadPoiTypes();

    expect(poiTypes.filter((t: string) => t === 'gym')).toHaveLength(1);
  });

  it('passes every returned place tagged with cacheAreaId/expiresAt to writeTripAreaPlaces, and returns the written count', async () => {
    mockSearchOsmPlaces.mockResolvedValue({
      atm: [{ osmId: 'node/1', name: 'ATM', isGenericName: false, lat: 1, lng: 2, distanceMeters: 10 }],
      cafe: [{ osmId: 'node/2', name: 'Cafe', isGenericName: false, lat: 1, lng: 2, distanceMeters: 20 }],
    });

    const count = await downloadTripArea({ lat: 1, lng: 2 }, 15_000, 'ta_1', 1_800_000_000_000);

    expect(count).toBe(2);
    expect(mockWriteTripAreaPlaces).toHaveBeenCalledWith(
      'ta_1', 1_800_000_000_000,
      expect.arrayContaining([
        expect.objectContaining({ poiType: 'atm' }),
        expect.objectContaining({ poiType: 'cafe' }),
      ]),
    );
  });

  it('throws when searchOsmPlacesStrict fails — a user-initiated action must surface the error, not swallow it', async () => {
    mockSearchOsmPlaces.mockRejectedValue(new Error('network down'));
    await expect(downloadTripArea({ lat: 1, lng: 2 }, 15_000, 'ta_1', 1_800_000_000_000)).rejects.toThrow('network down');
  });

  it('throws instead of persisting a "successful" empty result — indistinguishable from a soft failure otherwise', async () => {
    mockSearchOsmPlaces.mockResolvedValue({});
    await expect(downloadTripArea({ lat: 1, lng: 2 }, 15_000, 'ta_1', 1_800_000_000_000))
      .rejects.toThrow('Area download returned no places');
    // Must not touch any existing rows for this cacheAreaId before knowing the new fetch actually found something.
    expect(mockWriteTripAreaPlaces).not.toHaveBeenCalled();
  });

  it('propagates a write failure (e.g. a rolled-back transaction) instead of swallowing it', async () => {
    mockSearchOsmPlaces.mockResolvedValue(SOME_PLACE);
    mockWriteTripAreaPlaces.mockImplementationOnce(() => { throw new Error('disk full'); });

    await expect(downloadTripArea({ lat: 1, lng: 2 }, 15_000, 'ta_1', 1_800_000_000_000))
      .rejects.toThrow('disk full');
  });
});

describe('downloadTripAreaWithCloudflare', () => {
  it('imports a ready Cloudflare export instead of starting an OSM download', async () => {
    mockCoverage.mockResolvedValue({ status: 'ready', placeId: 'place-1', buildId: 'build-1' });
    mockImportExport.mockResolvedValue(4);

    await expect(downloadTripAreaWithCloudflare({ lat: 1, lng: 2 }, 15_000, 'ta_1', 100))
      .resolves.toMatchObject({ placesWritten: 4, cloudflareExport: { placeId: 'place-1', buildId: 'build-1' } });
    expect(mockSearchOsmPlaces).not.toHaveBeenCalled();
    expect(mockImportExport).toHaveBeenCalledWith('place-1', { lat: 1, lng: 2 }, 15_000, 'ta_1', 100, expect.any(Array));
  });

  it('falls back to OSM when coverage is not ready or the export fails', async () => {
    mockCoverage.mockResolvedValueOnce({ status: 'building', placeId: 'place-1' });
    mockSearchOsmPlaces.mockResolvedValue(SOME_PLACE);
    await expect(downloadTripAreaWithCloudflare({ lat: 1, lng: 2 }, 15_000, 'ta_1', 100)).resolves.toMatchObject({ placesWritten: 1 });

    mockCoverage.mockResolvedValueOnce({ status: 'ready', placeId: 'place-1', buildId: 'build-1' });
    mockImportExport.mockRejectedValueOnce(new Error('export unavailable'));
    await expect(downloadTripAreaWithCloudflare({ lat: 1, lng: 2 }, 15_000, 'ta_1', 100)).resolves.toMatchObject({ placesWritten: 1 });
  });

  it('does not re-download an unchanged place build', async () => {
    mockCoverage.mockResolvedValue({ status: 'ready', placeId: 'place-1', buildId: 'build-1' });
    const cached = { placeId: 'place-1', buildId: 'build-1', radiusMeters: 15_000, downloadedAt: 10 };
    await expect(downloadTripAreaWithCloudflare({ lat: 1, lng: 2 }, 15_000, 'ta_1', 100, cached))
      .resolves.toEqual({ placesWritten: 0, cloudflareExport: cached });
    expect(mockImportExport).not.toHaveBeenCalled();
    expect(mockSearchOsmPlaces).not.toHaveBeenCalled();
  });

  it('reimports an unchanged build when the requested radius expands', async () => {
    mockCoverage.mockResolvedValue({ status: 'ready', placeId: 'place-1', buildId: 'build-1' });
    mockImportExport.mockResolvedValue(8);
    const cached = { placeId: 'place-1', buildId: 'build-1', radiusMeters: 15_000, downloadedAt: 10 };

    await expect(downloadTripAreaWithCloudflare({ lat: 1, lng: 2 }, 40_000, 'ta_1', 100, cached))
      .resolves.toMatchObject({ cloudflareExport: { placeId: 'place-1', buildId: 'build-1', radiusMeters: 40_000 } });

    expect(mockImportExport).toHaveBeenCalledWith('place-1', { lat: 1, lng: 2 }, 40_000, 'ta_1', 100, expect.any(Array));
  });
});

describe('getCloudflareTripExportSize', () => {
  it('returns the exact ready R2 export size and leaves unavailable coverage undefined', async () => {
    mockCoverage.mockResolvedValueOnce({ status: 'ready', placeId: 'place-1', buildId: 'build-1', exportBytes: 123_456 });
    await expect(getCloudflareTripExportSize({ lat: 1, lng: 2 })).resolves.toBe(123_456);

    mockCoverage.mockResolvedValueOnce({ status: 'building', placeId: 'place-1' });
    await expect(getCloudflareTripExportSize({ lat: 1, lng: 2 })).resolves.toBeUndefined();
  });

  it('formats exact export sizes for the confirmation UI', () => {
    expect(formatTripDownloadSize(123_456)).toBe('123 KB');
    expect(formatTripDownloadSize(1_250_000)).toBe('1.3 MB');
  });
});

describe('downloadAreaSnapshot (KAN-237 — shared by trip and mall snapshot downloads)', () => {
  it('requests exactly the given poiTypes (no union/derivation — caller decides the set)', async () => {
    mockSearchOsmPlaces.mockResolvedValue(SOME_PLACE);

    await downloadAreaSnapshot({ lat: 5, lng: 6 }, 300, 'mall_snapshot', 1_800_000_000_000, ['atm', 'cafe']);

    expect(mockSearchOsmPlaces).toHaveBeenCalledWith(5, 6, ['atm', 'cafe'], 300, expect.any(Number));
  });

  it('writes results tagged with the given cacheAreaId/expiresAt and returns the written count', async () => {
    mockSearchOsmPlaces.mockResolvedValue({
      atm: [{ osmId: 'node/1', name: 'ATM', isGenericName: false, lat: 5, lng: 6, distanceMeters: 5 }],
    });

    const count = await downloadAreaSnapshot({ lat: 5, lng: 6 }, 300, 'mall_snapshot', 1_800_000_000_000, ['atm']);

    expect(count).toBe(1);
    expect(mockWriteTripAreaPlaces).toHaveBeenCalledWith(
      'mall_snapshot', 1_800_000_000_000,
      [expect.objectContaining({ poiType: 'atm' })],
    );
  });

  it('throws instead of persisting a "successful" empty result', async () => {
    mockSearchOsmPlaces.mockResolvedValue({});
    await expect(downloadAreaSnapshot({ lat: 5, lng: 6 }, 300, 'mall_snapshot', 1_800_000_000_000, ['atm']))
      .rejects.toThrow('Area download returned no places');
  });
});

describe('refreshTripArea', () => {
  it('re-downloads and bumps Firestore expiresAt/preRefreshedAt', async () => {
    mockSearchOsmPlaces.mockResolvedValue(SOME_PLACE);
    const trip = makeTrip({ endDate: '2026-07-27' });

    await refreshTripArea('uid-1', trip);

    expect(mockSearchOsmPlaces).toHaveBeenCalledWith(trip.centerLat, trip.centerLng, expect.anything(), trip.areaRadius, expect.anything());
    expect(mockUpdateTrip).toHaveBeenCalledWith('uid-1', 'trip-1', {
      expiresAt: computeTripExpiresAt('2026-07-27'),
      preRefreshedAt: expect.any(Number),
      cloudflareExport: undefined,
    });
  });
});

describe('checkAndRunTripPreRefresh', () => {
  it('only refreshes trips that are due', async () => {
    mockSearchOsmPlaces.mockResolvedValue(SOME_PLACE);
    const due = makeTrip({ id: 'due', startDate: '2026-07-20' });
    const notDue = makeTrip({ id: 'not-due', startDate: '2026-08-20' });

    await checkAndRunTripPreRefresh('uid-1', [due, notDue]);

    expect(mockUpdateTrip).toHaveBeenCalledTimes(1);
    expect(mockUpdateTrip).toHaveBeenCalledWith('uid-1', 'due', expect.anything());
  });

  it('isolates a failing trip\'s refresh — other trips still get refreshed', async () => {
    mockSearchOsmPlaces
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(SOME_PLACE);
    const failing = makeTrip({ id: 'failing', startDate: '2026-07-20' });
    const ok      = makeTrip({ id: 'ok', startDate: '2026-07-19' });

    await expect(checkAndRunTripPreRefresh('uid-1', [failing, ok])).resolves.toBeUndefined();

    expect(mockUpdateTrip).toHaveBeenCalledTimes(1);
    expect(mockUpdateTrip).toHaveBeenCalledWith('uid-1', 'ok', expect.anything());
  });

  it('does nothing when offline', async () => {
    mockNetInfoFetch.mockResolvedValue({ isConnected: false });
    const due = makeTrip({ id: 'due', startDate: '2026-07-20' });

    await checkAndRunTripPreRefresh('uid-1', [due]);

    expect(mockSearchOsmPlaces).not.toHaveBeenCalled();
    expect(mockUpdateTrip).not.toHaveBeenCalled();
  });
});
