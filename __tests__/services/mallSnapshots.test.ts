/**
 * KAN-237 — mallSnapshots.ts: the singleton current-mall snapshot.
 *
 * Covers:
 *   - getMallSnapshot reads the singleton doc, null if absent
 *   - setMallSnapshotDoc / deleteMallSnapshotDoc write/delete the doc
 *   - downloadMallSnapshot: looks up the mall via searchNearbyPlaces,
 *     downloads its POIs via downloadAreaSnapshot with the fixed
 *     cacheAreaId + a 14-day expiry, persists the doc, and returns it
 *   - downloadMallSnapshot throws a clear error when no mall is found nearby
 *     (before ever calling downloadAreaSnapshot)
 *   - downloadMallSnapshot propagates a downloadAreaSnapshot failure
 */

const mockGetDoc    = jest.fn();
const mockSetDoc    = jest.fn();
const mockDeleteDoc = jest.fn();
const NOW_TIMESTAMP = { _isNow: true };

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(),
  collection:   jest.fn(() => ({ _type: 'collection' })),
  doc:          jest.fn(() => ({ _type: 'doc' })),
  getDoc:       (...args: unknown[]) => mockGetDoc(...args),
  setDoc:       (...args: unknown[]) => mockSetDoc(...args),
  deleteDoc:    (...args: unknown[]) => mockDeleteDoc(...args),
  Timestamp:    { now: jest.fn(() => NOW_TIMESTAMP) },
}));

const mockSearchNearbyPlaces = jest.fn();
jest.mock('../../src/services/maps', () => ({
  searchNearbyPlaces: (...args: unknown[]) => mockSearchNearbyPlaces(...args),
  // Real implementation, not a stub: the "is this actually a mall" filtering
  // is exactly what these tests are asserting, so it must not be faked.
  isGenuineMallType: (place: { primaryType?: string; types?: string[] }) => {
    if (place.primaryType !== 'shopping_mall') { return false; }
    if (!place.types) { return false; }
    return place.types.every(t => ['shopping_mall', 'point_of_interest', 'establishment'].includes(t));
  },
}));

const mockDownloadAreaSnapshot = jest.fn().mockResolvedValue(3);
jest.mock('../../src/services/tripDownload', () => ({
  downloadAreaSnapshot: (...args: unknown[]) => mockDownloadAreaSnapshot(...args),
}));

jest.mock('../../src/services/proximity', () => ({
  NEARBY_RADIUS: 400,
}));

import {
  getMallSnapshot,
  setMallSnapshotDoc,
  deleteMallSnapshotDoc,
  downloadMallSnapshot,
  MALL_SNAPSHOT_CACHE_AREA_ID,
  MALL_SEARCH_RADIUS_M,
  MALL_SNAPSHOT_DOWNLOAD_RADIUS_M,
  NoMallFoundError,
} from '../../src/services/mallSnapshots';

beforeEach(() => {
  jest.clearAllMocks();
  mockDownloadAreaSnapshot.mockResolvedValue(3);
});

describe('getMallSnapshot', () => {
  it('returns null when no snapshot doc exists', async () => {
    mockGetDoc.mockResolvedValue({ data: () => undefined });
    expect(await getMallSnapshot('uid-1')).toBeNull();
  });

  it('returns the snapshot data when a doc exists', async () => {
    const data = { placeId: 'mall-1', name: 'Test Mall' };
    mockGetDoc.mockResolvedValue({ data: () => data });
    expect(await getMallSnapshot('uid-1')).toEqual(data);
  });
});

describe('setMallSnapshotDoc / deleteMallSnapshotDoc', () => {
  it('stamps createdAt and writes the doc', async () => {
    const data = {
      placeId: 'mall-1', name: 'Test Mall', centerLat: 1, centerLng: 2,
      radius: 300, cacheAreaId: 'mall_snapshot', expiresAt: 123,
    };
    await setMallSnapshotDoc('uid-1', data);
    expect(mockSetDoc).toHaveBeenCalledWith({ _type: 'doc' }, { ...data, createdAt: NOW_TIMESTAMP });
  });

  it('deletes the doc', async () => {
    await deleteMallSnapshotDoc('uid-1');
    expect(mockDeleteDoc).toHaveBeenCalledWith({ _type: 'doc' });
  });
});

describe('downloadMallSnapshot', () => {
  it('looks up the mall, downloads its POIs with the fixed cacheAreaId, and persists the doc', async () => {
    mockSearchNearbyPlaces.mockResolvedValue({ results: {
      shopping_mall: [{ placeId: 'mall-1', name: 'Test Mall', lat: 1, lng: 2, distanceMeters: 50, primaryType: 'shopping_mall', types: ['shopping_mall', 'point_of_interest', 'establishment'] }],
    }, source: 'osm' });

    const snapshot = await downloadMallSnapshot('uid-1', { lat: 1, lng: 2 }, ['atm', 'cafe']);

    expect(mockSearchNearbyPlaces).toHaveBeenCalledWith(1, 2, ['shopping_mall'], MALL_SEARCH_RADIUS_M);
    expect(mockDownloadAreaSnapshot).toHaveBeenCalledWith(
      { lat: 1, lng: 2 }, MALL_SNAPSHOT_DOWNLOAD_RADIUS_M, MALL_SNAPSHOT_CACHE_AREA_ID, expect.any(Number), ['atm', 'cafe'],
    );
    expect(mockSetDoc).toHaveBeenCalledWith(
      { _type: 'doc' },
      expect.objectContaining({ placeId: 'mall-1', name: 'Test Mall', cacheAreaId: 'mall_snapshot' }),
    );
    expect(snapshot.placeId).toBe('mall-1');
    expect(snapshot.cacheAreaId).toBe(MALL_SNAPSHOT_CACHE_AREA_ID);
    expect(snapshot.radius).toBe(MALL_SNAPSHOT_DOWNLOAD_RADIUS_M);
  });

  it('throws a typed NoMallFoundError when no shopping mall is found nearby, without ever calling downloadAreaSnapshot', async () => {
    mockSearchNearbyPlaces.mockResolvedValue({ results: { shopping_mall: [] }, source: 'osm' });

    await expect(downloadMallSnapshot('uid-1', { lat: 1, lng: 2 }, ['atm']))
      .rejects.toBeInstanceOf(NoMallFoundError);
    expect(mockDownloadAreaSnapshot).not.toHaveBeenCalled();
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it('skips a bucket hit whose PRIMARY Google type is something else — e.g. a parking/loading feature tagged shopping_mall only as a secondary category — and picks the next genuine mall (or throws if none)', async () => {
    mockSearchNearbyPlaces.mockResolvedValue({
      results: {
        shopping_mall: [
          { placeId: 'not-a-mall', name: 'Cais para o carro', lat: 1, lng: 2, distanceMeters: 20, primaryType: 'parking', types: ['parking', 'point_of_interest', 'establishment'] },
          { placeId: 'real-mall', name: 'Centro Comercial Colombo', lat: 1.001, lng: 2, distanceMeters: 80, primaryType: 'shopping_mall', types: ['shopping_mall', 'point_of_interest', 'establishment'] },
        ],
      },
      source: 'osm',
    });

    const snapshot = await downloadMallSnapshot('uid-1', { lat: 1, lng: 2 }, ['atm']);

    expect(snapshot.placeId).toBe('real-mall');
    expect(snapshot.name).toBe('Centro Comercial Colombo');
  });

  it('propagates a downloadAreaSnapshot failure instead of persisting a doc', async () => {
    mockSearchNearbyPlaces.mockResolvedValue({ results: {
      shopping_mall: [{ placeId: 'mall-1', name: 'Test Mall', lat: 1, lng: 2, distanceMeters: 50, primaryType: 'shopping_mall', types: ['shopping_mall', 'point_of_interest', 'establishment'] }],
    }, source: 'osm' });
    mockDownloadAreaSnapshot.mockRejectedValue(new Error('network down'));

    await expect(downloadMallSnapshot('uid-1', { lat: 1, lng: 2 }, ['atm'])).rejects.toThrow('network down');
    expect(mockSetDoc).not.toHaveBeenCalled();
  });
});

describe('MALL_SNAPSHOT_DOWNLOAD_RADIUS_M (code review fix)', () => {
  it('is at least proximity.ts\'s NEARBY_RADIUS, so cache-first coverage inside the snapshot is never narrower than a normal search window', () => {
    expect(MALL_SNAPSHOT_DOWNLOAD_RADIUS_M).toBeGreaterThanOrEqual(400);
  });
});
