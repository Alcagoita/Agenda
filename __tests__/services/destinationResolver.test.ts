/**
 * KAN-281 — destinationResolver.ts
 *
 * Three branches, first match wins: learned brand > habitat cache >
 * pre-fetched live results. No live network call happens
 * inside this module — branch 4 only reads whatever liveResults it's given.
 * KAN-304: the learned branch matches a habitat candidate by BRAND NAME.
 */

jest.mock('../../src/services/maps', () => ({
}));

const mockQueryHabitatCache = jest.fn();
jest.mock('../../src/services/habitatCache', () => ({
  queryHabitatCache: (...args: unknown[]) => mockQueryHabitatCache(...args),
}));

import { resolveTaskDestination } from '../../src/services/destinationResolver';
import type { Task } from '../../src/types';
import type { LearnedBrand } from '../../src/services/learnedPlaces';

const COORDS = { lat: 38.7, lng: -9.1 };

const FAKE_TIMESTAMP = { seconds: 0, nanoseconds: 0 } as unknown as Task['createdAt'];

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1', title: 'Pick up aspirin', category: 'health', done: false,
    date: '2026-07-16', createdAt: FAKE_TIMESTAMP, poi: 'pharmacy',
    ...overrides,
  };
}

describe('resolveTaskDestination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryHabitatCache.mockReturnValue({});
  });

  it('prefers the learned brand over a closer same-type stranger (matched by name)', async () => {
    const learned: LearnedBrand[] = [{ name: 'Farmácia Silva', poiType: 'pharmacy', visitCount: 5 }];
    // Nearer stranger first, then a branch of the learned brand — the brand wins.
    mockQueryHabitatCache.mockReturnValue({
      pharmacy: [
        { placeId: 'cache-near', name: 'Nearer Pharmacy', lat: 38.701, lng: -9.101, distanceMeters: 50 },
        { placeId: 'branch-2',   name: 'Farmácia Silva',  lat: 38.71,  lng: -9.11,  distanceMeters: 300 },
      ],
    });

    const result = await resolveTaskDestination(makeTask(), COORDS, learned);

    expect(result?.source).toBe('learned');
    expect(result?.name).toBe('Farmácia Silva');
    expect(result?.internalId).toBe('branch-2'); // the in-range branch, not any stored id
  });

  it('falls through to cache when no branch of the learned brand is in range', async () => {
    const learned: LearnedBrand[] = [{ name: 'Farmácia Silva', poiType: 'pharmacy', visitCount: 5 }];
    mockQueryHabitatCache.mockReturnValue({
      pharmacy: [{ placeId: 'cache-1', name: 'Cached Pharmacy', lat: 38.72, lng: -9.12, distanceMeters: 900 }],
    });

    const result = await resolveTaskDestination(makeTask(), COORDS, learned);

    expect(result?.source).toBe('cache');
  });

  it('resolves the nearest cached place when nothing is learned', async () => {
    mockQueryHabitatCache.mockReturnValue({
      pharmacy: [{ placeId: 'cache-1', name: 'Cached Pharmacy', lat: 38.72, lng: -9.12, distanceMeters: 900 }],
    });

    const result = await resolveTaskDestination(makeTask(), COORDS, []);

    expect(result).toEqual({ internalId: 'cache-1', name: 'Cached Pharmacy', lat: 38.72, lng: -9.12, distanceMeters: 900, source: 'cache' });
  });

  it('resolves from pre-fetched liveResults when nothing else matched', async () => {
    const liveResults = {
      pharmacy: [{ placeId: 'live-1', name: 'Live Pharmacy', lat: 38.73, lng: -9.13, distanceMeters: 4000 }],
    };

    const result = await resolveTaskDestination(makeTask(), COORDS, [], liveResults);

    expect(result).toEqual({ internalId: 'live-1', name: 'Live Pharmacy', lat: 38.73, lng: -9.13, distanceMeters: 4000, source: 'live' });
  });

  it('ignores a live result beyond ROUTE_MAX_RADIUS_M', async () => {
    const liveResults = {
      pharmacy: [{ placeId: 'live-1', name: 'Far Pharmacy', lat: 39.5, lng: -9.9, distanceMeters: 50_000 }],
    };

    const result = await resolveTaskDestination(makeTask(), COORDS, [], liveResults);

    expect(result).toBeNull();
  });

  it('returns null for a task with no poi', async () => {
    const result = await resolveTaskDestination(makeTask({ poi: undefined }), COORDS, []);
    expect(result).toBeNull();
    expect(mockQueryHabitatCache).not.toHaveBeenCalled();
  });

  it('returns null when nothing resolves anywhere', async () => {
    const result = await resolveTaskDestination(makeTask(), COORDS, []);
    expect(result).toBeNull();
  });
});
