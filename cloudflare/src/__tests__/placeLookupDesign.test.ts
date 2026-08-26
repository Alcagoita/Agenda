import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

type Place = { place_id: string; place_kind: string | null; min_lat: number; max_lat: number; min_lng: number; max_lng: number };
const CELL_DEGREES = 0.25;
const latBucket = (lat: number) => Math.floor((lat + 90) / CELL_DEGREES);
const lngBucket = (lng: number) => Math.floor((lng + 180) / CELL_DEGREES);

function best(rows: Place[]): string | null {
  return rows.sort((a, b) => {
    const rank = (row: Place) => row.place_kind === 'country' || row.place_kind === 'generic' ? 2 : row.place_kind === null ? 1 : 0;
    const area = (row: Place) => (row.max_lat - row.min_lat) * (row.max_lng - row.min_lng);
    return rank(a) - rank(b) || area(a) - area(b);
  })[0]?.place_id ?? null;
}

describe('KAN-425 bucketed place-lookup design', () => {
  it('uses the bucket index and preserves linear lookup parity for nested and boundary extents', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE place (place_id TEXT PRIMARY KEY, place_kind TEXT, min_lat REAL, max_lat REAL, min_lng REAL, max_lng REAL); CREATE TABLE place_bucket (lat_bucket INTEGER NOT NULL, lng_bucket INTEGER NOT NULL, place_id TEXT NOT NULL, PRIMARY KEY (lat_bucket, lng_bucket, place_id));');
    const places: Place[] = [
      { place_id: 'country', place_kind: 'country', min_lat: 38, max_lat: 40, min_lng: -10, max_lng: -8 },
      { place_id: 'city', place_kind: 'city', min_lat: 38.5, max_lat: 39, min_lng: -9.5, max_lng: -9 },
      { place_id: 'district', place_kind: 'administrative', min_lat: 38.7, max_lat: 38.8, min_lng: -9.2, max_lng: -9.1 },
    ];
    const insertPlace = db.prepare('INSERT INTO place VALUES (?, ?, ?, ?, ?, ?)');
    const insertBucket = db.prepare('INSERT INTO place_bucket VALUES (?, ?, ?)');
    for (const place of places) {
      insertPlace.run(place.place_id, place.place_kind, place.min_lat, place.max_lat, place.min_lng, place.max_lng);
      for (let lat = latBucket(place.min_lat); lat <= latBucket(place.max_lat); lat++) for (let lng = lngBucket(place.min_lng); lng <= lngBucket(place.max_lng); lng++) insertBucket.run(lat, lng, place.place_id);
    }
    const linear = db.prepare('SELECT * FROM place WHERE ? BETWEEN min_lat AND max_lat AND ? BETWEEN min_lng AND max_lng');
    const bucketed = db.prepare('SELECT p.* FROM place_bucket b JOIN place p ON p.place_id = b.place_id WHERE b.lat_bucket = ? AND b.lng_bucket = ? AND ? BETWEEN p.min_lat AND p.max_lat AND ? BETWEEN p.min_lng AND p.max_lng');
    for (const [lat, lng] of [[38.75, -9.15], [38.5, -9.5], [39.5, -9.5]]) {
      expect(best(bucketed.all(latBucket(lat), lngBucket(lng), lat, lng) as Place[])).toBe(best(linear.all(lat, lng) as Place[]));
    }
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT p.* FROM place_bucket b JOIN place p ON p.place_id = b.place_id WHERE b.lat_bucket = ? AND b.lng_bucket = ?').all(latBucket(38.75), lngBucket(-9.15)) as Array<{ detail: string }>;
    expect(plan.some(step => step.detail.includes('SEARCH b USING COVERING INDEX'))).toBe(true);
  });
});
