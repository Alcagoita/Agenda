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
  financial_service_kind?: string[];
  primary_poi_type?: string;
  brand?: string | null;
}

interface FakeCuratedPoi {
  poi_id: string;
  name: string;
  primary_poi_type: string;
  food_cuisine?: string[];
}

interface FakeOsmPoi {
  osm_element_id: string;
  name: string;
  primary_poi_type: string;
  food_cuisine?: string[];
}

const LAT = 38.72;
const LNG = -9.14;

function fakeDb(pois: FakePoi[], curatedPois: FakeCuratedPoi[] = [], osmPois: FakeOsmPoi[] = []): Env['REGISTRY_DB'] {
  const prepare = (sql: string) => {
    const trimmed = sql.trim();
    const stmt = {
      bind: (..._args: unknown[]) => stmt,
      async all() {
        if (trimmed.startsWith('SELECT search_type, include_type FROM type_relation')) {
          return { results: [] };
        }
        // KAN-377 — /poi/nearby resolves the settlement alongside the POI
        // query so the client can name the area offline. These fixtures are
        // about POI matching, so no place row: placeName comes back null.
        if (trimmed.startsWith('SELECT * FROM place WHERE min_lat IS NOT NULL')) {
          return { results: [] };
        }
        if (trimmed.startsWith('SELECT poi.fsq_place_id')) {
          const results: unknown[] = [];
          for (const p of pois) {
            const base = {
              fsq_place_id: p.fsq_place_id, dedupe_name: p.name.toLowerCase(), name: p.name, lat: LAT, lng: LNG,
              primary_poi_type: p.primary_poi_type ?? 'restaurant', brand: p.brand ?? null,
              category_label: p.category_label, raw_category_labels: p.raw_category_labels,
              address: null, matched_type: p.primary_poi_type ?? 'restaurant',
            };
            const attributes = [
              ...(p.food_cuisine ?? []).map(value => ({ dimension: 'food_cuisine', value })),
              ...(p.financial_service_kind ?? []).map(value => ({ dimension: 'financial_service_kind', value })),
            ];
            if (attributes.length === 0) {
              results.push({ ...base, attribute_dimension: null, attribute_value: null });
            } else {
              for (const attribute of attributes) {
                results.push({ ...base, attribute_dimension: attribute.dimension, attribute_value: attribute.value });
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
        if (trimmed.startsWith('SELECT osm_poi.osm_element_id')) {
          const results: unknown[] = [];
          for (const p of osmPois) {
            const base = {
              osm_element_id: p.osm_element_id, dedupe_name: p.name.toLowerCase(), name: p.name, lat: LAT, lng: LNG,
              primary_poi_type: p.primary_poi_type, brand: null, address: null,
              open_min: null, close_min: null, matched_type: p.primary_poi_type,
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

function env(pois: FakePoi[] = POIS, curatedPois: FakeCuratedPoi[] = [], osmPois: FakeOsmPoi[] = []): Env {
  return { API_KEY: 'test-key', REGISTRY_DB: fakeDb(pois, curatedPois, osmPois) } as unknown as Env;
}

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const names = (bucket: Array<{ name: string }> | undefined) => (bucket ?? []).map(p => p.name).sort();

describe('POST /poi/nearby — KAN-344 cuisine groups end-to-end', () => {
  it('returns an OSM-only POI through the same nearby response', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant', type: 'restaurant' },
    ]), env([], [], [{ osm_element_id: 'node/5335674113', name: 'Santo Amaro', primary_poi_type: 'restaurant' }]), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ poi_id: string; fsq_place_id: string | null; source: string }>> };
    expect(body.results.restaurant).toEqual([
      expect.objectContaining({ poi_id: 'node/5335674113', fsq_place_id: null, source: 'openstreetmap' }),
    ]);
  });

  it('keeps the Foursquare record when it duplicates an OSM supplement', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant', type: 'restaurant' },
    ]), env([
      { fsq_place_id: 'fsq-santo-amaro', name: 'Santo Amaro', raw_category_labels: '', category_label: '' },
    ], [], [
      { osm_element_id: 'node/5335674113', name: 'Santo Amaro', primary_poi_type: 'restaurant' },
    ]), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ poi_id: string; source: string }>> };
    expect(body.results.restaurant).toEqual([
      expect.objectContaining({ poi_id: 'fsq-santo-amaro', source: 'foursquare' }),
    ]);
  });

  it('returns only pizza matches for a pizza subtype request, all for the broad bucket', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant', type: 'restaurant' },
      { key: 'restaurant:food_cuisine:pizza', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['pizza'] } },
    ]), env(), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ name: string }>> };
    expect(names(body.results.restaurant)).toEqual(['Aron Sushi', 'Portugália', 'Tutto Pizza']);
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

  it('accepts only the requested canonical Gym brand', async () => {
    const gyms: FakePoi[] = [
      { fsq_place_id: 'solinca', name: 'Solinca Coimbra', raw_category_labels: '', category_label: '', primary_poi_type: 'gym', brand: 'Solinca' },
      { fsq_place_id: 'fitness-hut', name: 'Fitness Hut Coimbra', raw_category_labels: '', category_label: '', primary_poi_type: 'gym', brand: 'Fitness Hut' },
    ];
    const res = await worker.fetch(nearbyRequest([
      { key: 'gym:brand:Solinca', type: 'gym', brand: 'Solinca' },
    ]), env(gyms), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ name: string; brand: string | null }>> };
    expect(body.results['gym:brand:Solinca']).toEqual([
      expect.objectContaining({ name: 'Solinca Coimbra', brand: 'Solinca' }),
    ]);
  });

  it('accepts only the requested optional Store brand', async () => {
    const stores: FakePoi[] = [
      { fsq_place_id: 'worten', name: 'Worten Coimbra', raw_category_labels: '', category_label: '', primary_poi_type: 'store', brand: 'Worten' },
      { fsq_place_id: 'fnac', name: 'Fnac Coimbra', raw_category_labels: '', category_label: '', primary_poi_type: 'store', brand: 'Fnac' },
    ];
    const res = await worker.fetch(nearbyRequest([
      { key: 'store:brand:Worten', type: 'store', brand: 'Worten' },
    ]), env(stores), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ name: string; brand: string | null }>> };
    expect(body.results['store:brand:Worten']).toEqual([
      expect.objectContaining({ name: 'Worten Coimbra', brand: 'Worten' }),
    ]);
  });

  it('rejects an unknown brand and a brand on an unsupported POI type', async () => {
    const unknown = await worker.fetch(nearbyRequest([
      { key: 'gym:brand:nope', type: 'gym', brand: 'Nope Gym' },
    ]), env(), CTX);
    expect(unknown.status).toBe(400);
    const wrongType = await worker.fetch(nearbyRequest([
      { key: 'cafe:brand:Solinca', type: 'cafe', brand: 'Solinca' },
    ]), env(), CTX);
    expect(wrongType.status).toBe(400);
  });

  it('returns an approved community POI with its own identity, never a fabricated Foursquare id', async () => {
    const res = await worker.fetch(nearbyRequest([
      { key: 'restaurant:food_cuisine:sushi', type: 'restaurant', attribute: { dimension: 'food_cuisine', values: ['sushi'] } },
    ]), env([], [{ poi_id: 'community:123', name: 'The Sushi Soul', primary_poi_type: 'restaurant', food_cuisine: ['sushi'] }]), CTX);
    const body = await res.json() as { results: Record<string, Array<{ poi_id: string; fsq_place_id: string | null; source: string }>> };
    expect(body.results['restaurant:food_cuisine:sushi']).toEqual([expect.objectContaining({ poi_id: 'community:123', fsq_place_id: null, source: 'community' })]);
  });

  it('returns only the requested Financial service kind', async () => {
    const services: FakePoi[] = [
      { fsq_place_id: 'credit', name: 'Cofidis', raw_category_labels: '', category_label: '', primary_poi_type: 'financial_service', financial_service_kind: ['consumer_credit'] },
      { fsq_place_id: 'insurance', name: 'Fidelidade', raw_category_labels: '', category_label: '', primary_poi_type: 'financial_service', financial_service_kind: ['insurance'] },
    ];
    const res = await worker.fetch(nearbyRequest([
      { key: 'financial_service', type: 'financial_service' },
      { key: 'financial_service:financial_service_kind:consumer_credit', type: 'financial_service', attribute: { dimension: 'financial_service_kind', values: ['consumer_credit'] } },
    ]), env(services), CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Record<string, Array<{ name: string; attributes: Record<string, string[]> }>> };
    expect(names(body.results.financial_service)).toEqual(['Cofidis', 'Fidelidade']);
    expect(body.results['financial_service:financial_service_kind:consumer_credit']).toEqual([
      expect.objectContaining({ name: 'Cofidis', attributes: { financial_service_kind: ['consumer_credit'] } }),
    ]);
  });
});
