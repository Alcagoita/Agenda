import { describe, it, expect } from 'vitest';
import {
  encodeGeohash,
  neighborPrefixes,
  precisionForRadius,
  requiredGridCells,
  haversineMeters,
  MAX_GRID_CELLS_PER_AXIS,
  MAX_RADIUS_METERS,
} from '../geohash';

/** Mirrors index.ts's queryPoiDb range clause: [prefix, prefix + '~'). */
function inRange(value: string, prefix: string): boolean {
  return value >= prefix && value < `${prefix}~`;
}

const BASE32_ORDER = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * Ground-truth helper: given a set of random candidate points, which ones
 * are truly within radiusMeters of (lat, lng), by real haversine distance —
 * independent of geohash entirely. Tests assert neighborPrefixes' candidate
 * set (post prefix-filter, pre haversine-filter — same two-stage pipeline
 * index.ts's queryPoiDb actually runs) is a superset of this ground truth.
 */
function trueMatches(lat: number, lng: number, radiusMeters: number, points: { lat: number; lng: number }[]) {
  return points.filter(p => haversineMeters(lat, lng, p.lat, p.lng) <= radiusMeters);
}

/** Deterministic pseudo-random points scattered in a bounding box around a center — no external RNG dependency, reproducible across runs. */
function scatterPoints(centerLat: number, centerLng: number, spreadDeg: number, count: number) {
  const points: { lat: number; lng: number }[] = [];
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < count; i++) {
    points.push({
      lat: centerLat + (rand() - 0.5) * 2 * spreadDeg,
      lng: centerLng + (rand() - 0.5) * 2 * spreadDeg,
    });
  }
  return points;
}

/** True if every point's geohash (at `precision`) is present in `prefixes` — the coverage property neighborPrefixes must guarantee for every true match. Assertion is presence-only (a Set membership check), never dependent on array order. */
function allCovered(points: { lat: number; lng: number }[], prefixes: string[], precision: number) {
  const prefixSet = new Set(prefixes);
  return points.every(p => prefixSet.has(encodeGeohash(p.lat, p.lng, precision)));
}

describe('neighborPrefixes coverage against real haversine distance', () => {
  const cases: { name: string; lat: number; lng: number; radius: number }[] = [
    // Lisbon center — the exact point that exposed the original 64% miss rate live.
    { name: 'Lisbon center, radius 4500 (max, coarsest precision)', lat: 38.7223, lng: -9.1393, radius: 4500 },
    { name: 'Lisbon center, radius 150 (finest precision)', lat: 38.7223, lng: -9.1393, radius: 150 },
    { name: 'Lisbon center, radius 600 (mid precision)', lat: 38.7223, lng: -9.1393, radius: 600 },
    { name: 'Lisbon center, radius 75 (below finest tier)', lat: 38.7223, lng: -9.1393, radius: 75 },
    { name: 'Lisbon center, radius 1000 (crosses into coarsest tier)', lat: 38.7223, lng: -9.1393, radius: 1000 },
    // Points deliberately near a geohash cell edge (not just city centers) —
    // this is exactly the scenario the original bug mishandled.
    { name: 'near a precision-5 cell edge', lat: 38.759765, lng: -9.140625, radius: 4000 },
    { name: 'near a precision-6 cell edge', lat: 38.71997, lng: -9.14209, radius: 500 },
    { name: 'near a precision-7 cell edge', lat: 38.722, lng: -9.139, radius: 140 },
    // A different city (Odivelas) at a different latitude — not just Lisbon.
    { name: 'Odivelas center, radius 3000', lat: 38.7911, lng: -9.1857, radius: 3000 },
  ];

  for (const { name, lat, lng, radius } of cases) {
    it(`covers every true in-range point: ${name}`, () => {
      const precision = precisionForRadius(radius);
      const { cellsLat, cellsLng } = requiredGridCells(lat, precision, radius);
      // Sanity: real usage never needs more than the configured cap — if this
      // ever fails, the test cases above need to shrink their radius, not the cap.
      expect(cellsLat).toBeLessThanOrEqual(MAX_GRID_CELLS_PER_AXIS);
      expect(cellsLng).toBeLessThanOrEqual(MAX_GRID_CELLS_PER_AXIS);

      const points = scatterPoints(lat, lng, radius / 80000, 500);
      const truePositives = trueMatches(lat, lng, radius, points);
      const prefixes = neighborPrefixes(lat, lng, precision, radius);

      expect(truePositives.length).toBeGreaterThan(0); // sanity: the test scatter actually produced in-range points
      expect(allCovered(truePositives, prefixes, precision)).toBe(true);
    });
  }
});

describe('precisionForRadius boundary values', () => {
  it('picks the finest precision at and just under the first threshold', () => {
    expect(precisionForRadius(1)).toBe(7);
    expect(precisionForRadius(150)).toBe(7);
  });
  it('crosses to the next tier just above the threshold', () => {
    expect(precisionForRadius(151)).toBe(6);
    expect(precisionForRadius(600)).toBe(6);
  });
  it('falls back to the coarsest precision above the second threshold', () => {
    expect(precisionForRadius(601)).toBe(5);
    expect(precisionForRadius(MAX_RADIUS_METERS)).toBe(5);
  });
});

describe('requiredGridCells and the MAX_GRID_CELLS_PER_AXIS budget', () => {
  it('stays within the cap for real Portugal-latitude usage at the max allowed radius', () => {
    const { cellsLat, cellsLng } = requiredGridCells(38.7223, precisionForRadius(MAX_RADIUS_METERS), MAX_RADIUS_METERS);
    expect(cellsLat).toBeLessThanOrEqual(MAX_GRID_CELLS_PER_AXIS);
    expect(cellsLng).toBeLessThanOrEqual(MAX_GRID_CELLS_PER_AXIS);
  });

  it('exceeds the cap at an extreme (near-polar) latitude — this is exactly what index.ts must reject rather than silently under-cover', () => {
    const precision = precisionForRadius(MAX_RADIUS_METERS);
    const { cellsLng } = requiredGridCells(85, precision, MAX_RADIUS_METERS);
    expect(cellsLng).toBeGreaterThan(MAX_GRID_CELLS_PER_AXIS);
  });

  it('grid width matches requiredGridCells exactly: (2*cellsLat+1) * (2*cellsLng+1) unique cells', () => {
    const lat = 38.7223, lng = -9.1393, radius = 4500;
    const precision = precisionForRadius(radius);
    const { cellsLat, cellsLng } = requiredGridCells(lat, precision, radius);
    const prefixes = neighborPrefixes(lat, lng, precision, radius);
    // Some cells can collide at low precision when the grid wraps back onto
    // itself in degenerate cases, so this is an upper bound, not exact equality —
    // but for these real, non-degenerate coordinates it should hold exactly.
    expect(prefixes.length).toBe((2 * cellsLat + 1) * (2 * cellsLng + 1));
  });
});

/**
 * index.ts's queryPoiDb expresses each geohash prefix as a lexical range
 * `geohash >= prefix AND geohash < prefix + '~'` rather than
 * `substr(geohash, 1, n) IN (...)`, so D1 can serve the filter from
 * idx_poi_city_geo (a function over the indexed column isn't sargable; a
 * plain range comparison is). This only matches the intended subtree of
 * descendants under SQLite's default BINARY collation (byte/codepoint
 * comparison) — schema.sql declares `geohash TEXT NOT NULL` with no
 * COLLATE clause, so BINARY is what's actually in effect. That, in turn,
 * only produces a correct range because BASE32 ('0123456789bcdefghjkmnpqrstuvwxyz')
 * is itself already in strictly ascending codepoint order, and every write
 * path (encodeGeohash) emits exclusively those lowercase characters — a
 * stray uppercase geohash would sort BEFORE its lowercase siblings (e.g.
 * 'B' = 0x42 < 'b' = 0x62) and silently fall outside every range query, not
 * error. These tests pin that contract down directly rather than relying on
 * neighborPrefixes' own coverage tests to imply it.
 */
describe('geohash range query contract ([prefix, prefix + "~"))', () => {
  it('BASE32 alphabet is itself in strictly ascending codepoint order (precondition for the range trick)', () => {
    const sorted = [...BASE32_ORDER].sort();
    expect(BASE32_ORDER.split('')).toEqual(sorted);
  });

  it('encodeGeohash never emits anything outside the lowercase BASE32 alphabet', () => {
    const points = [
      { lat: 38.7223, lng: -9.1393 }, { lat: -33.9, lng: 151.2 }, { lat: 0, lng: 0 }, { lat: 89.9, lng: -179.9 },
    ];
    for (const p of points) {
      const hash = encodeGeohash(p.lat, p.lng, 7);
      expect(hash).toMatch(new RegExp(`^[${BASE32_ORDER}]+$`));
    }
  });

  it('every full-length descendant of a prefix falls inside its range', () => {
    const prefix = 'ez';
    for (const c of BASE32_ORDER) {
      expect(inRange(`${prefix}s${c}`, prefix)).toBe(true);
    }
  });

  it('an adjacent sibling prefix falls outside the range', () => {
    // 's' -> 't' is the next BASE32 character, so 'ezt...' must not match 'ezs'.
    expect(inRange('ezt0000', 'ezs')).toBe(false);
    expect(inRange('ezr9999', 'ezs')).toBe(false); // the sibling below, too
  });

  it('excludes the exclusive upper bound prefix + "~" itself', () => {
    const prefix = 'ezs';
    expect(inRange(`${prefix}~`, prefix)).toBe(false);
    // '~' sorts after every real BASE32 character, so this is the tightest
    // possible upper bound short of enumerating every descendant string.
    expect('~'.charCodeAt(0)).toBeGreaterThan(Math.max(...[...BASE32_ORDER].map(c => c.charCodeAt(0))));
  });

  it('rejects the contract silently mismatching on case: an uppercase prefix sorts before its lowercase data', () => {
    // Demonstrates why encodeGeohash must never emit uppercase (previous
    // test) — this is not a query bug, it's a "the data must already be
    // right" invariant, unenforceable from the query side alone.
    expect(inRange('ez00000', 'EZ')).toBe(false);
  });

  it('the real neighborPrefixes output only ever produces ranges that self-consistently bound their own precision-7 descendants', () => {
    const lat = 38.7223, lng = -9.1393, precision = 7, radius = 150;
    const prefixes = neighborPrefixes(lat, lng, precision, radius);
    const ownHash = encodeGeohash(lat, lng, precision);
    const matchingPrefix = prefixes.find(p => ownHash.startsWith(p));
    expect(matchingPrefix).toBeDefined();
    expect(inRange(ownHash, matchingPrefix!)).toBe(true);
  });
});
