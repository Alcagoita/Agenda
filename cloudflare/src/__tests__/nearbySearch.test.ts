import { describe, it, expect, vi } from 'vitest';

// index.ts imports getContainer/Container at module load (KAN-354) — mock so
// importing the handler doesn't need a Container runtime.
vi.mock('@cloudflare/containers', () => ({
  getContainer: () => ({ start: vi.fn() }),
  Container: class {},
}));

import worker, { type Env } from '../index';

/**
 * KAN-344 end-to-end (Worker layer): a structured POST /poi/nearby request
 * with a group cuisine (pizza/asian) must return only the raw_category_labels
 * matches for that group, while a generic restaurant request returns the broad
 * bucket. Hand-rolled fake D1 answers exactly the two queries queryNearbyPoiDb
 * issues (type_relation + the nearby SELECT) — brittle to a query-text change
 * by design, the tradeoff for exercising the real handler without SQLite.
 */
interface FakePoi {
  fsq_place_id: string;
  name: string;
  raw_category_labels: string;
  category_label: string;
  food_cuisine?: string[];
}

interface FakeCuratedPoi {
  poi_id: string;
  name: string;
  primary_poi_type: string;
  food_cuisine?: string[];
}

const LAT = 38.72;
const LNG = -9.14;

function fakeDb(pois: FakePoi[], curatedPois: FakeCuratedPoi[] = []): Env['REGISTRY_DB'] {
  const prepare = (sql: string) => {
    const trimmed = sql.trim();
    const stmt = {
      bind: (..._args: unknown[]) => stmt,
      async all() {
        if (trimmed.startsWith('SELECT search_type, include_type FROM type_relation')) {
          return { results: [] };
        }
        if (trimmed.startsWith('SELECT poi.fsq_place_id')) {
          const results: unknown[] = [];
          for (const p of pois) {
            const base = {
              fsq_place_id: p.fsq_place_id, name: p.name, lat: LAT, lng: LNG,
              primary_poi_type: 'restaurant', brand: null,
              category_label: p.category_label, raw_category_labels: p.raw_category_labels,
              address: null, matched_type: 'restaurant',
            };
            const cuisines = p.food_cuisine ?? [];
            if (cuisines.length === 0) {
              results.push({ ...base, attribute_dimension: null, attribute_value: null });
            } else {
              for (const value of cuisines) {
                results.push({ ...base, attribute_dimension: 'food_cuisine', attribute_value: value });
              }
            }
          }
          return { results };
        }
        if (trimmed.startsWith('SELECT curated_poi.poi_id')) {
          const results: unknown[] = [];
          for (const p of curatedPois) {
            const base = {
              poi_id: p.poi_id, dedupe_name: p.name.toLowerCase(), name: p.name, lat: LAT, lng: LNG,
              primary_poi_type: p.primary_poi_type, address: null,
            };
            const cuisines = p.food_cuisine ?? [];
            if (cuisines.length === 0) {
              results.push({ ...base, attribute_dimension: null, attribute_value: null });
            } else {
              for (const value of cuisines) {
                results.push({ ...base, attribute_dimension: 'food_cuisine', attribute_value: value });
              }
            }
          }
          return { results };
        }
        throw new Error(`fake D1 unhandled all(): ${trimmed}`);
      },
    };
    return stmt;
  };
  return { prepare } as unknown as Env['REGISTRY_DB'];
}

const POIS: FakePoi[] = [
  // A Pizzeria with NO classified food_cuisine — proves the group match works
  // off raw_category_labels alone, not a poi_attribute row.
  { fsq_place_id: 'pz', name: 'Tutto Pizza', category_label: 'Dining and Drinking > Restaurant > Pizzeria', raw_category_labels: 'Dining and Drinking > Restaurant > Pizzeria' },
  // A sushi place — under the Asian Restaurant hierarchy, classified 'sushi'.
  { fsq_place_id: 'su', name: 'Aron Sushi', category_label: 'Dining and Drinking > Restaurant > Asian Restaurant > Japanese Restaurant > Sushi Restaurant', raw_category_labels: 'Dining and Drinking > Restaurant > Asian Restaurant > Japanese Restaurant > Sushi Restaurant', food_cuisine: ['sushi'] },
  { fsq_place_id: 'pt', name: 'Portugália', category_label: 'Dining and Drinking > Restaurant > Portuguese Restaurant', raw_category_labels: 'Dining and Drinking > Restaurant > Portuguese Restaurant', food_cuisine: ['portuguese'] },
];

function nearbyRequest(requests: unknown[]) {
  return new Request('https://poi-api.test/poi/nearby', {
    method: 'POST',
    headers: { 'X-Api-Key': 'test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: LAT, lng: LNG, radius: 1000, requests, limitPerRequest: 20 }),
  });
}

function env(pois: FakePoi[] = POIS, curatedPois: FakeCuratedPoi[] = []): Env {
  return { API_KEY: 'test-key', REGISTRY_DB: fakeDb(pois, curatedPois) } as unknown as Env;
}

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const names = (bucket: Array<{ name: string }> | undefined) => (bucket ?? []).map(p => p.name).sort();

describe('POST /poi/nearby — KAN-344 cuisine groups end-to-end', () => {
  it('returns only pizza matches for a pizza subtype request, all for the broad bucket', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant', type: 'restaurant' },
      { key: 'restaurant:food_cuisine:pizza', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['pizza'] } },
    ]), env(), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ name: string }>> };
    expect(names(body.results['restaurant'])).toEqual(['Aron Sushi', 'Portugália', 'Tutto Pizza']);
    // Pizzeria matched via raw_category_labels despite having no classified cuisine.
    expect(names(body.results['restaurant:food_cuisine:pizza'])).toEqual(['Tutto Pizza']);
  });

  it('returns the whole Asian hierarchy for an asian request (umbrella)', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant:food_cuisine:asian', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['asian'] } },
    ]), env(), CTX);
    const body = await res.json() as { results: Record<string, Array<{ name: string }>> };
    // Sushi sits under '… > Asian Restaurant > …'; the Pizzeria and Portuguese do not.
    expect(names(body.results['restaurant:food_cuisine:asian'])).toEqual(['Aron Sushi']);
  });

  it('rejects an unsupported cuisine value before it reaches the grouping', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant:food_cuisine:ramen', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['ramen'] } },
    ]), env(), CTX);
    expect(res.status).toBe(400);
  });

  it('returns an approved community POI with its own identity, never a fabricated Foursquare id', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant:food_cuisine:sushi', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['sushi'] } },
    ]), env([], [{ poi_id: 'community:123', name: 'The Sushi Soul', primary_poi_type: 'restaurant', food_cuisine: ['sushi'] }]), CTX);
    const body = await res.json() as { results: Record<string, Array<{ poi_id: string; fsq_place_id: string | null; source: string }>> };
    expect(body.results['restaurant:food_cuisine:sushi']).toEqual([expect.objectContaining({ poi_id: 'community:123', fsq_place_id: null, source: 'community' })]);
  });
});
