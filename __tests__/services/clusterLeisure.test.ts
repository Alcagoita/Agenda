/**
 * KAN-293 — findClusterLeisure: the leisure companion line's detection.
 *
 * The rules under test are the ones that keep the line honest: it only ever
 * mentions a real, named place that is genuinely right there beside a stop
 * the user was already visiting, exactly once, and it stays silent otherwise.
 *
 * Also pinned here: detection issues NO network call of any kind. It reads
 * the habitat cache and nothing else — the leisure types ride along in the
 * proximity engine's existing Overpass request (see proximity.ts's
 * prefetchTypes), so this feature never costs a request of its own and
 * never touches Google.
 */

// maps.ts pulls in placesFunctions -> @react-native-firebase/functions, a
// native module unavailable under Jest. Flat-earth approximation is accurate
// enough for the radius assertions below.
jest.mock('../../src/services/maps', () => ({
  getDistanceMeters: (lat1: number, lng1: number, lat2: number, lng2: number) =>
    Math.round(Math.hypot(lat2 - lat1, lng2 - lng1) * 111_000),
  placeTypeLabel: (type: string) =>
    type.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
}));

const mockQueryHabitatCache = jest.fn();
jest.mock('../../src/services/habitatCache', () => ({
  queryHabitatCache: (...args: unknown[]) => mockQueryHabitatCache(...args),
}));

import {
  findClusterLeisure,
  LEISURE_NEAR_STOP_RADIUS_M,
} from '../../src/services/clusterLeisure';
import type { NearbyPlace } from '../../src/services/maps';
import type { ErrandBundle } from '../../src/services/errandBundles';
import type { Task } from '../../src/types';
import { CLUSTER_LEISURE_TYPES } from '../../src/types';

/** Degrees of latitude for a given metre offset, per the mocked haversine. */
function latOffset(meters: number): number {
  return meters / 111_000;
}

function makePlace(overrides: Partial<NearbyPlace> = {}): NearbyPlace {
  return { placeId: 'p1', name: 'Place', lat: 0, lng: 0, distanceMeters: 0, ...overrides };
}

function makeTask(id: string): Task {
  return {
    id, title: `Task ${id}`, category: 'errands', done: false, poi: 'atm',
    date: '2026-07-20', createdAt: {} as Task['createdAt'],
  };
}

/** A two-stop cluster: anchor + one stop 200 m north of it. */
function makeBundle(stops?: NearbyPlace[]): ErrandBundle {
  const anchor = makePlace({ placeId: 'anchor', name: 'The ATM', lat: 0, lng: 0 });
  const resolved = stops ?? [
    anchor,
    makePlace({ placeId: 'stop-2', name: 'The Pharmacy', lat: latOffset(200), lng: 0 }),
  ];
  return {
    anchor,
    entries: resolved.map((place, i) => ({
      task: makeTask(`t${i + 1}`),
      place,
      distanceToAnchorMeters: 0,
    })),
    totalWalkDistanceMeters: 0,
  };
}

/** Shapes the cache mock's return: every requested type, only `hits` filled. */
function cacheReturns(hits: Record<string, NearbyPlace[]>) {
  mockQueryHabitatCache.mockImplementation((_lat, _lng, types: string[]) => {
    const out: Record<string, NearbyPlace[]> = {};
    for (const t of types) { out[t] = hits[t] ?? []; }
    return out;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  cacheReturns({});
});

describe('findClusterLeisure — when it speaks', () => {
  it('mentions a named park sitting right beside a stop', () => {
    cacheReturns({
      park: [makePlace({ placeId: 'park-1', name: 'Central Park', lat: latOffset(250), lng: 0 })],
    });

    const found = findClusterLeisure(makeBundle());
    expect(found).not.toBeNull();
    expect(found!.place.name).toBe('Central Park');
    expect(found!.type).toBe('park');
    expect(found!.distanceToStopMeters).toBeLessThanOrEqual(LEISURE_NEAR_STOP_RADIUS_M);
  });

  it('qualifies against ANY stop, not just the anchor', () => {
    // 250 m from the anchor is far outside the radius, but only 50 m from the
    // second stop — the walk passes that stop too, so it counts.
    cacheReturns({
      museum: [makePlace({ placeId: 'm-1', name: 'The History Museum', lat: latOffset(250), lng: 0 })],
    });

    const found = findClusterLeisure(makeBundle());
    expect(found?.place.name).toBe('The History Museum');
    expect(found?.distanceToStopMeters).toBe(50);
  });

  it('carries the cached website through, so the ticket link can render', () => {
    cacheReturns({
      aquarium: [makePlace({
        placeId: 'aq-1', name: 'City Aquarium', lat: latOffset(200), lng: 0,
        website: 'https://aquarium.example',
      })],
    });

    expect(findClusterLeisure(makeBundle())?.place.website).toBe('https://aquarium.example');
  });

  it('mentions a historical landmark right beside a stop (heritage sites were a blind spot)', () => {
    cacheReturns({
      historical_landmark: [makePlace({ placeId: 'hl-1', name: 'Mosteiro de Alcobaça', lat: latOffset(250), lng: 0 })],
    });

    const found = findClusterLeisure(makeBundle());
    expect(found?.place.name).toBe('Mosteiro de Alcobaça');
    expect(found?.type).toBe('historical_landmark');
  });
});

describe('findClusterLeisure — when it stays quiet', () => {
  it('says nothing when the cache has no leisure place at all', () => {
    expect(findClusterLeisure(makeBundle())).toBeNull();
  });

  it('says nothing about a place beyond the near-stop radius', () => {
    // 150 m past the furthest stop — outside LEISURE_NEAR_STOP_RADIUS_M of both.
    cacheReturns({
      park: [makePlace({ placeId: 'far', name: 'Distant Park', lat: latOffset(350), lng: 0 })],
    });
    expect(findClusterLeisure(makeBundle())).toBeNull();
  });

  it('says nothing about an unnamed place — a bare "Park" is not worth interrupting for', () => {
    cacheReturns({
      park: [makePlace({ placeId: 'unnamed', name: 'Park', lat: latOffset(200), lng: 0 })],
    });
    expect(findClusterLeisure(makeBundle())).toBeNull();
  });

  it('says nothing about a place that IS one of the cluster stops — an errand is not a discovery', () => {
    const parkStop = makePlace({ placeId: 'park-stop', name: 'Central Park', lat: latOffset(200), lng: 0 });
    const bundle = makeBundle([
      makePlace({ placeId: 'anchor', name: 'The ATM', lat: 0, lng: 0 }),
      parkStop,
    ]);
    cacheReturns({ park: [parkStop] });

    expect(findClusterLeisure(bundle)).toBeNull();
  });

  it('returns null rather than throwing when the cache read fails', () => {
    mockQueryHabitatCache.mockImplementation(() => { throw new Error('db boom'); });
    expect(() => findClusterLeisure(makeBundle())).not.toThrow();
    expect(findClusterLeisure(makeBundle())).toBeNull();
  });
});

describe('findClusterLeisure — exactly one, ranked offline-first', () => {
  it('picks the candidate nearest a stop when several qualify in the same footprint tier', () => {
    cacheReturns({
      park:   [makePlace({ placeId: 'park-1', name: 'Far Park', lat: latOffset(140), lng: 0 })],
      museum: [makePlace({ placeId: 'm-1', name: 'Near Museum', lat: latOffset(210), lng: 0 })],
    });

    const found = findClusterLeisure(makeBundle());
    expect(found?.place.name).toBe('Near Museum');
    expect(found?.distanceToStopMeters).toBe(10);
  });

  it('ranks every leisure type against the others, never by which type it is', () => {
    // Product requirement: a tourist_attraction is recommended alongside the
    // historic landmarks, not behind them. The labels are classifier leaves —
    // the same castle can arrive under either depending on the source — so
    // preferring one would rank places by an accident of tagging.
    //
    // Derived from the constant, not a hand-picked sample: every ordered pair
    // of distinct types, so a type added later is covered without anyone
    // remembering to extend this, and both directions of each pair are
    // asserted so it cannot pass by coincidence of iteration order.
    const pairs = CLUSTER_LEISURE_TYPES.flatMap(
      winner => CLUSTER_LEISURE_TYPES
        .filter(loser => loser !== winner)
        .map(loser => [winner, loser] as const),
    );
    expect(pairs).toHaveLength(CLUSTER_LEISURE_TYPES.length * (CLUSTER_LEISURE_TYPES.length - 1));

    for (const [winner, loser] of pairs) {
      cacheReturns({
        [winner]: [makePlace({
          placeId: 'big', name: 'O Grande', lat: latOffset(260), lng: 0, footprintAreaM2: 3_500,
        })],
        [loser]: [makePlace({
          placeId: 'small', name: 'O Pequeno', lat: latOffset(205), lng: 0, footprintAreaM2: 120,
        })],
      });

      const found = findClusterLeisure(makeBundle());
      // The bigger one wins on footprint regardless of which type holds it.
      expect(found?.place.name).toBe('O Grande');
      expect(found?.type).toBe(winner);
    }
  });

  it('lets a mapped landmark outrank a closer small fixture by footprint magnitude', () => {
    cacheReturns({
      tourist_attraction: [
        makePlace({
          placeId: 'fountain',
          name: 'Chafariz da Princesa',
          lat: latOffset(205),
          lng: 0,
          footprintAreaM2: 120,
        }),
        makePlace({
          placeId: 'tower',
          name: 'Torre de Belém',
          lat: latOffset(260),
          lng: 0,
          footprintAreaM2: 3_500,
        }),
      ],
    });

    const found = findClusterLeisure(makeBundle());
    expect(found?.place.name).toBe('Torre de Belém');
    expect(found?.distanceToStopMeters).toBe(60);
  });

  it('falls back to nearest-first when footprint data is absent for every candidate', () => {
    cacheReturns({
      tourist_attraction: [
        makePlace({ placeId: 'tower', name: 'Torre de Belém', lat: latOffset(260), lng: 0 }),
        makePlace({ placeId: 'fountain', name: 'Chafariz da Princesa', lat: latOffset(205), lng: 0 }),
      ],
    });

    const found = findClusterLeisure(makeBundle());
    expect(found?.place.name).toBe('Chafariz da Princesa');
  });

  it('returns a single suggestion, never a list', () => {
    cacheReturns({
      park: [
        makePlace({ placeId: 'p-a', name: 'Park A', lat: latOffset(190), lng: 0 }),
        makePlace({ placeId: 'p-b', name: 'Park B', lat: latOffset(210), lng: 0 }),
      ],
    });

    const found = findClusterLeisure(makeBundle());
    expect(found).not.toBeNull();
    expect(Array.isArray(found)).toBe(false);
  });
});

describe('findClusterLeisure — cost', () => {
  it('reads the cache once and makes no network call', () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as never).mockImplementation(() => {
      throw new Error('detection must never fetch');
    });
    cacheReturns({
      park: [makePlace({ placeId: 'park-1', name: 'Central Park', lat: latOffset(200), lng: 0 })],
    });

    findClusterLeisure(makeBundle());

    expect(mockQueryHabitatCache).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('asks the cache only for the fixed leisure type set', () => {
    findClusterLeisure(makeBundle());
    const requestedTypes = mockQueryHabitatCache.mock.calls[0][2];
    // `attraction` was retired by KAN-406 — it duplicated tourist_attraction
    // under the OSM vocabulary and matched zero rows in our own database.
    expect([...requestedTypes].sort()).toEqual(['aquarium', 'historical_landmark', 'museum', 'park', 'tourist_attraction']);
  });

  it('asks the cache not to cap leisure candidates before ranking sees them', () => {
    findClusterLeisure(makeBundle());
    expect(mockQueryHabitatCache.mock.calls[0][4]).toEqual({ maxResultsPerType: null });
  });
});
