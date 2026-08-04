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
